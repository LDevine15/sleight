import { randomUUID } from 'node:crypto';
import { trustedRead, trustedHandle } from './trusted-dom.mjs';
import { canonical } from './authority.mjs';
import { check, inspectElement, intent, expirePaymentDialog, deferRefund, endDeferredRefund } from './rules.mjs';
import { createUserFileProvider, stageUserUploads } from './files.mjs';
import { createConsentUi } from './consent-ui.mjs';

const bindings = new WeakMap(), contexts = new WeakSet();
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const refused = () => ({ verdict: 'refuse', message: 'Trusted turn or target evidence is unavailable. Use the engine browser path.' });
const equal = (a, b) => canonical(a) === canonical(b);
export const isV3Context = ctx => !!ctx && contexts.has(ctx);

// Called only by the inherited worker's begin handler. No model-facing endpoint
// accepts a binding, parsed permission or payment method. Copy the exact message.
export function createV3TurnBinding(message, current) {
  if (message?.source !== 'user' || !['session', 'turn', 'id'].every(key => text(message[key])) ||
      typeof message.text !== 'string' || Buffer.byteLength(message.text) > 65536 || typeof current !== 'function')
    throw Error('TRUSTED_TURN_REQUIRED');
  const binding = Object.freeze({});
  bindings.set(binding, { message: Object.freeze({ source: 'user', session: message.session, turn: message.turn, id: message.id, text: message.text }), current });
  return binding;
}

// A closed request grammar: ambiguous prose, negations and mentions ask the
// native UI. JSON here is text from the authenticated user message, not tool JSON.
// The quoted prose form has the same exact terms. Never infer omitted terms.
export function requestedPayment(message) {
  const source = message.trim(); let value;
  const json = /^(?:Please\s+)?(?:Pay|Buy|Purchase)\s+(\{[^\n]*\})\.?$/i.exec(source);
  const prose = /^(?:Please\s+)?Pay\s+"([^"\n]+)"\s+for\s+"([^"\n]+)"\s+to\s+"([^"\n]+)"\s+with\s+"([^"\n]+)"(?:\s+in\s+"([A-Z]{3})")?\.?$/.exec(source);
  try {
    if (json) value = JSON.parse(json[1]);
    else if (prose) value = { amount: prose[1], item: prose[2], payee: prose[3], method: prose[4], ...(prose[5] ? { currency: prose[5] } : {}) };
    else return;
    if (!value || Array.isArray(value) || Object.keys(value).some(key => !['item', 'amount', 'payee', 'method', 'currency'].includes(key)) ||
        !['item', 'amount', 'payee', 'method'].every(key => text(value[key])) || value.currency !== undefined && !/^[A-Z]{3}$/.test(value.currency)) return;
    return Object.freeze({ ...value });
  } catch { return; }
}

// Focus and its synchronous page handlers run in the same evaluation. Never
// let a failed focus silently send a key to the previously active control.
export function focusCheckedNode(el, focus, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  if (!read(el, 'isConnected')) return false;
  if (focus) HTMLElement.prototype.focus.call(el, { preventScroll: true });
  try {
    // A closed root hides its real receiver behind activeElement's host. DOM
    // evidence cannot distinguish that host from an ordinary focusable div.
    // Refuse opaque potential hosts; an open root exposes the receiver below.
    const opaqueHost = !read(el, 'shadowRoot') && (read(el, 'localName').includes('-') ||
      ['article','aside','blockquote','body','div','footer','h1','h2','h3','h4','h5','h6','header','main','nav','p','section','span'].includes(read(el, 'localName')));
    if (opaqueHost) return false;
    let node = el;
    for (;;) {
      const doc = read(node, 'ownerDocument'), view = read(doc, 'defaultView');
      let active = read(doc, 'activeElement');
      while (read(read(active, 'shadowRoot'), 'activeElement')) active = read(read(active, 'shadowRoot'), 'activeElement');
      if (active !== node) return false;
      const frame = read(view, 'frameElement');
      if (!frame) return view === read(view, 'top');
      if (!read(frame, 'isConnected')) return false;
      node = frame;
    }
  } catch { return false; }
}

export function ownDocument(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) { return read(el, 'ownerDocument'); }
export function samePageDocument(el, doc, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) { return read(el, 'isConnected') && read(el, 'ownerDocument') === doc; }

// All names are local so Playwright can serialize this read into the target's
// frame. Page metadata is an observation only; it can never supply the method.
// Require one visible exact labeled value per term in the target form/dialog.
// Two predicates: `visible` (STRICT, a person could read it) lets a term supply
// authority; `looseLines` (LOOSE, anything rendered) can only force an ask when
// it shows a different payable number. Whatever can't be established fails closed.
export function readPaymentPage(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  const doc = read(el, 'ownerDocument'), view = read(doc, 'defaultView');
  const associated = read(el, 'form');
  const root = (associated === undefined ? read(el, 'closest')('form') : associated) ?? read(el, 'closest')('dialog,[role="dialog"]');
  const gs = (node, pseudo) => read(view, 'getComputedStyle')(node, pseudo);
  const up = node => read(node, 'parentElement') ?? read(read(node, 'getRootNode')?.(), 'host');
  const shown = node => read(node, 'checkVisibility')({ checkOpacity: true, checkVisibilityCSS: true });
  // rgba(...) -> [r,g,b,a]; anything else (color(), lab(), ...) is unknown and fails closed.
  const rgba = value => { const m = /^rgba?\(([^)]*)\)$/.exec(String(value).trim()); const n = m && m[1].match(/-?\d*\.?\d+/g)?.map(Number);
    return n && n.length >= 3 && n.every(Number.isFinite) ? [n[0], n[1], n[2], n.length > 3 ? n[3] : 1] : undefined; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const effective = node => { let o = 1; for (let n = node; n; n = up(n)) { const s = gs(n); o *= s.opacity === '' ? 1 : Number(s.opacity ?? 1); } return o; };
  // Every element and open shadow root, once. Past the cap, nothing counts as visible. ext is the box plus whatever the element
  // paints outside it (outline, outer shadow, drop-shadow), so a 1px element with a huge outline still counts as a cover.
  let everyone, pseudoBoxes, tooMany = false, layers;
  const px = value => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };
  const colorSeen = value => (rgba(value)?.[3] ?? 1) >= 0.1;
  const outside = s => {
    let reach = 0;
    if (s.outlineStyle && s.outlineStyle !== 'none' && px(s.outlineWidth) > 0 && colorSeen(s.outlineColor)) reach = Math.max(reach, px(s.outlineWidth) + Math.max(0, px(s.outlineOffset)));
    for (const one of String(s.boxShadow ?? 'none').split(/,(?![^(]*\))/)) {
      if (!one.trim() || one.trim() === 'none' || /inset/.test(one)) continue;
      const color = /rgba?\([^)]*\)/.exec(one)?.[0]; if (color && !colorSeen(color)) continue;
      const n = (one.replace(/rgba?\([^)]*\)/, '').match(/-?\d*\.?\d+/g) ?? []).map(Number);
      reach = Math.max(reach, Math.max(Math.abs(n[0] ?? 0), Math.abs(n[1] ?? 0)) + (n[2] ?? 0) + Math.max(0, n[3] ?? 0));
    }
    for (const one of String(s.filter ?? '').matchAll(/drop-shadow\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g))
      reach = Math.max(reach, (one[1].replace(/rgba?\([^)]*\)/, '').match(/-?\d*\.?\d+/g) ?? []).reduce((sum, v) => sum + Math.abs(Number(v)), 0));
    return reach;
  };
  const gather = () => {
    if (everyone) return;
    everyone = [];
    const add = scope => { for (const n of Array.from(read(scope, 'querySelectorAll')?.('*') ?? [])) {
      if (everyone.length > 20000) { tooMany = true; return; }
      const box = read(n, 'getBoundingClientRect')(), reach = outside(gs(n));
      everyone.push({ n, box, reach, ext: reach ? { left: box.left - reach, top: box.top - reach, right: box.right + reach, bottom: box.bottom + reach } : box });
      const shadow = read(n, 'shadowRoot'); if (shadow) add(shadow); } };
    add(doc);
    // Top-layer elements (modal dialog, open popover) paint a ::backdrop over everything outside them.
    layers = [];
    for (const selector of [':modal', ':popover-open', ':fullscreen']) {
      let found = []; try { found = Array.from(read(doc, 'querySelectorAll')(selector)); } catch { /* selector unsupported */ }
      for (const n of found) { const b = gs(n, '::backdrop'); if (!b) continue;
        if (!rgba(b.backgroundColor) || colorSeen(b.backgroundColor) || (b.backgroundImage && b.backgroundImage !== 'none') || [b.backdropFilter, b.webkitBackdropFilter].some(v => v && v !== 'none')) layers.push(n); }
    }
  };
  // What a node paints, whatever the point. Cached: it only depends on style.
  const infoCache = new Map();
  const info = n => {
    if (infoCache.has(n)) return infoCache.get(n);
    const s = gs(n), tag = read(n, 'localName'), bg = rgba(s.backgroundColor), found = {};
    found.replaced = ['img', 'canvas', 'svg', 'video', 'picture', 'iframe', 'object', 'embed', 'input', 'textarea', 'select', 'button'].includes(tag);
    found.fill = !bg || bg[3] >= 0.1 || (s.backgroundImage && s.backgroundImage !== 'none') || [s.backdropFilter, s.webkitBackdropFilter].some(v => v && v !== 'none') || /inset/.test(s.boxShadow ?? '');
    // In-flow generated content: any text or paint counts. Placed ::before/::after boxes are measured in pseudos().
    found.generated = ['::before', '::after'].some(which => { const g = gs(n, which); if (!g || !g.content || g.content === 'none' || g.content === 'normal') return false;
      if (['absolute', 'fixed'].includes(g.position)) return false; // placed boxes are measured in pseudos()
      const gb = rgba(g.backgroundColor); return g.content.replace(/["'\s]/g, '') !== '' || !gb || gb[3] >= 0.1 || (g.backgroundImage && g.backgroundImage !== 'none') || px(g.borderTopWidth) > 0 || px(g.borderLeftWidth) > 0; });
    found.placed = ['absolute', 'fixed'].includes(s.position);
    found.outside = !!(px(s.outlineWidth) > 0 && s.outlineStyle !== 'none' && colorSeen(s.outlineColor)) || outside(s) > 0;
    found.ownText = (rgba(s.webkitTextFillColor || s.color)?.[3] ?? 1) >= 0.1;
    infoCache.set(n, found); return found;
  };
  // Does something painted (background, image, replaced content, control, generated content, inset shadow, border, outline,
  // outer shadow, another element's text) sit at x,y?
  const painted = (n, box, ext, x, y, inside) => {
    if (!shown(n) || effective(n) < 0.1) return false;
    const f = info(n), s = gs(n);
    if (f.outside) return true;
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false;
    if (f.replaced || f.fill || (!inside || f.placed) && f.generated) return true;
    for (const [w, st, c, near] of [['borderTopWidth', 'borderTopStyle', 'borderTopColor', y - box.top], ['borderBottomWidth', 'borderBottomStyle', 'borderBottomColor', box.bottom - y],
        ['borderLeftWidth', 'borderLeftStyle', 'borderLeftColor', x - box.left], ['borderRightWidth', 'borderRightStyle', 'borderRightColor', box.right - x]])
      if (s[st] !== 'none' && s[st] !== 'hidden' && parseFloat(s[w]) > 0 && near <= parseFloat(s[w]) && (rgba(s[c])?.[3] ?? 1) >= 0.1) return true;
    // Another element's own text under the point could hide or replace the digits.
    return !inside && f.ownText && Array.from(read(n, 'childNodes')).some(c => read(c, 'nodeType') === 3 && read(c, 'textContent').trim());
  };
  // Absolutely placed ::before/::after boxes that paint anything. Geometry comes from used values; auto or transforms fail closed.
  const pseudos = () => {
    if (pseudoBoxes) return pseudoBoxes;
    pseudoBoxes = []; gather();
    for (const { n } of everyone) for (const which of ['::before', '::after']) {
      const s = gs(n, which); if (!s || !s.content || s.content === 'none' || s.content === 'normal') continue;
      if (!['absolute', 'fixed'].includes(s.position)) continue;
      const bg = rgba(s.backgroundColor), paints = !bg || bg[3] >= 0.1 || (s.backgroundImage && s.backgroundImage !== 'none') || /inset/.test(s.boxShadow ?? '') ||
        parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0 || s.content.replace(/["'\s]/g, '') !== '';
      if (!paints || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.1) continue;
      let cb = { left: 0, top: 0 };
      if (s.position === 'absolute') for (let a = n; a; a = up(a)) if (gs(a).position !== 'static') { const ab = read(a, 'getBoundingClientRect')(); cb = { left: ab.left + read(a, 'clientLeft'), top: ab.top + read(a, 'clientTop') }; break; }
      const L = parseFloat(s.left), T = parseFloat(s.top), W = parseFloat(s.width), H = parseFloat(s.height);
      if (![L, T, W, H].every(Number.isFinite) || (s.transform && s.transform !== 'none')) { pseudoBoxes.push({ box: { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 } }); continue; }
      const left = cb.left + L + (parseFloat(s.marginLeft) || 0), top = cb.top + T + (parseFloat(s.marginTop) || 0);
      pseudoBoxes.push({ box: { left, top, right: left + W, bottom: top + H } });
    }
    return pseudoBoxes;
  };
  // Every colour the text could sit on: ancestors' colours, gradient stops, then the canvas. Images we can't read fail closed.
  const backdrops = node => {
    const layers = [];
    for (let n = node; n; n = up(n)) {
      const s = gs(n), color = rgba(s.backgroundColor), image = s.backgroundImage;
      if (!color) return;
      let stops;
      if (image && image !== 'none') {
        if (/url\(|image-set|element\(|paint\(|cross-fade/.test(image)) return;
        stops = (image.match(/rgba?\([^)]*\)/g) ?? []).map(rgba); if (!stops.length || stops.some(c => !c)) return;
      }
      layers.push({ color, stops }); if (color[3] >= 0.99 && !stops) break;
    }
    const scheme = gs(read(doc, 'documentElement')).colorScheme ?? '';
    const dark = /dark/.test(scheme) && (!/light/.test(scheme) || read(view, 'matchMedia')?.('(prefers-color-scheme: dark)')?.matches === true);
    let backs = [dark ? [18, 18, 18, 1] : [255, 255, 255, 1]];
    for (const { color, stops } of layers.reverse()) backs = backs.flatMap(b => { const base = over(color, b); return stops ? stops.map(s => over(s, base)) : [base]; }).slice(0, 64);
    return backs;
  };
  // A person sees text only if it is rendered, uncovered at sample points of its own rects (whatever the pointer-events
  // or paint order), has non-zero effective opacity (opacity, filter, mask), a visible fill, a readable size and
  // contrast with everything it could sit on. Anything that cannot be established counts as not visible.
  const visible = (node, rects) => {
    if (!shown(node)) return false;
    if (!rects) {
      const range = ['input', 'select', 'textarea'].includes(read(node, 'localName')) ? undefined : read(doc, 'createRange')();
      if (range) range.selectNodeContents(node);
      const own = range && [...range.getClientRects()];
      rects = own?.length ? own : read(node, 'getClientRects')();
    }
    // Reachable area: the viewport, plus the page below it by scrolling (not left, above or far to the right). Fixed boxes stay in the viewport.
    const innerW = read(view, 'innerWidth'), innerH = read(view, 'innerHeight'), root = read(doc, 'documentElement');
    let fixed = false; for (let parent = node; parent; parent = up(parent)) if (gs(parent).position === 'fixed') fixed = true;
    const scrollX = read(view, 'scrollX') ?? 0, scrollY = read(view, 'scrollY') ?? 0;
    let left = fixed ? 0 : -scrollX, top = fixed ? 0 : -scrollY, right = innerW, opacity = 1;
    let bottom = fixed ? innerH : Math.min(Math.max(innerH, read(root, 'scrollHeight') || 0), innerH * 10) - scrollY;
    for (let parent = node; parent; parent = up(parent)) {
      const style = gs(parent);
      opacity *= style.opacity === '' ? 1 : Number(style.opacity ?? 1);
      for (const f of String(style.filter ?? '').matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) opacity *= Number(f[1]) / (f[2] ? 100 : 1);
      if (!(opacity >= 0.1) || style.visibility === 'hidden' || style.display === 'none' ||
          style.clipPath && style.clipPath !== 'none' || style.clip && style.clip !== 'auto') return false;
      // Blur, brightness, invert and the like change what is seen; only opacity() is understood.
      const rest = String(style.filter ?? 'none').replace(/opacity\([^)]*\)/g, '').trim();
      if (rest !== 'none' && rest !== '') return false;
      if ([style.maskImage, style.webkitMaskImage, style.maskBorderSource].some(v => v && v !== 'none') ||
          style.mixBlendMode && style.mixBlendMode !== 'normal') return false;
      // Text a person could not read as written: mirrored, rotated, bidi-reordered, struck through or outlined heavily.
      if (style.transform && style.transform !== 'none') {
        const m = /^matrix(3d)?\(([^)]*)\)$/.exec(style.transform), n = m && m[2].split(',').map(Number);
        const flat = m && n.every(Number.isFinite) && (m[1] ? n.length === 16 && [2, 3, 6, 7, 8, 9, 11].every(i => Math.abs(n[i]) < 1e-6) && Math.abs(n[10] - 1) < 1e-6 : n.length === 6);
        const [a, b, c, d] = m && flat ? (m[1] ? [n[0], n[1], n[4], n[5]] : n) : [];
        if (!flat || !(a * d - b * c > 0.1) || Math.abs(Math.atan2(b, a)) > 0.5) return false;
      }
      if (/override/.test(style.unicodeBidi ?? '') || style.writingMode && !/^horizontal/.test(style.writingMode)) return false;
      const size = parseFloat(style.fontSize) || 16;
      if (style.textDecorationLine && style.textDecorationLine !== 'none' && colorSeen(style.textDecorationColor)) {
        const t = String(style.textDecorationThickness ?? 'auto'), thick = t.endsWith('%') ? size * parseFloat(t) / 100 : /^[\d.]/.test(t) ? parseFloat(t) : 0;
        if (thick >= size * 0.2) return false;
      }
      if (px(style.webkitTextStrokeWidth) >= size * 0.1 && colorSeen(style.webkitTextStrokeColor)) return false;
      const box = read(parent, 'getBoundingClientRect')();
      const clips = axis => /^(?:auto|scroll|hidden|clip)$/.test(style['overflow' + axis]) || /(?:paint|strict|content)/.test(style.contain ?? '');
      if (clips('X')) { left = Math.max(left, box.left + read(parent, 'clientLeft')); right = Math.min(right, box.left + read(parent, 'clientLeft') + read(parent, 'clientWidth')); }
      if (clips('Y')) { top = Math.max(top, box.top + read(parent, 'clientTop')); bottom = Math.min(bottom, box.top + read(parent, 'clientTop') + read(parent, 'clientHeight')); }
    }
    // A painted fixed layer the size of the viewport (loading overlay, open fixed dialog) covers every spot the page can scroll to.
    gather(); if (tooMany) return false;
    if (!fixed) {
      const mine = new Set(); for (let a = node; a; a = up(a)) mine.add(a);
      const veil = everyone.some(({ n, box }) => !mine.has(n) && box.left <= 2 && box.top <= 2 && box.right >= innerW - 2 && box.bottom >= innerH - 2 &&
        gs(n).position === 'fixed' && shown(n) && effective(n) >= 0.1 && (info(n).fill || info(n).replaced));
      if (veil) { top = Math.max(top, 0); bottom = Math.min(bottom, innerH); }
    }
    const seen = [...rects].filter(r => Math.min(right, r.right) - Math.max(left, r.left) >= 4 && Math.min(bottom, r.bottom) - Math.max(top, r.top) >= 4);
    if (!seen.length) return false;
    const own = gs(node), ink = rgba(own.webkitTextFillColor || own.color);
    if (!ink || ink[3] * opacity < 0.1 || !(parseFloat(own.fontSize) >= 7)) return false;
    const backs = backdrops(node); if (!backs) return false;
    const paint = [ink[0], ink[1], ink[2], ink[3] * opacity];
    for (const b of backs) { const a = lum(over(paint, b)) + 0.05, c = lum(b) + 0.05; if (Math.max(a, c) / Math.min(a, c) < 1.5) return false; }
    gather(); if (tooMany) return false;
    // A modal or popover with a painted ::backdrop hides everything that is not inside it.
    for (const layer of layers) { let inside = false; for (let a = node; a; a = up(a)) if (a === layer) inside = true; if (!inside) return false; }
    const spots = [];
    for (const r of seen.slice(0, 8)) {
      const l = Math.max(left, r.left), t = Math.max(top, r.top), rr = Math.min(right, r.right), b = Math.min(bottom, r.bottom);
      const nx = Math.min(40, Math.max(3, Math.ceil((rr - l) / 6)));
      for (let i = 0; i < nx; i++) for (let j = 0; j < 3; j++) spots.push([l + (rr - l) * (i + 0.5) / nx, t + (b - t) * (j + 0.5) / 3]);
    }
    const ancestors = new Set(); for (let n = node; n; n = up(n)) ancestors.add(n);
    const xs = spots.map(p => p[0]), ys = spots.map(p => p[1]), lo = [Math.min(...xs), Math.min(...ys)], hi = [Math.max(...xs), Math.max(...ys)];
    const near = everyone.filter(({ n, box, reach, ext }) => !ancestors.has(n) && (reach || box.width > 0 && box.height > 0) && ext.right >= lo[0] && ext.left <= hi[0] && ext.bottom >= lo[1] && ext.top <= hi[1]);
    for (const [x, y] of spots) {
      for (const { n, box, ext } of near) {
        if (x < ext.left || x > ext.right || y < ext.top || y > ext.bottom) continue;
        let inside = false; for (let a = n; a; a = up(a)) if (a === node) { inside = true; break; }
        if (painted(n, box, ext, x, y, inside)) return false;
      }
      for (const { box } of pseudos()) if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return false;
    }
    return true;
  };
  // The order summary: the section, aside, fieldset, form or dialog that holds the amount (a table or list inside it is not enough: the
  // item table and the totals table are one summary). Text under a header, nav, footer, aside or banner role inside it is not summary.
  // outsideSummary marks that text with U+E002 in the strict lines (only when asked), so a savings figure in a banner or sidebar closes no gap.
  let summaryRoot;
  const summaryOf = node => { let g = up(node); while (g && g !== root && !(['section', 'article', 'fieldset', 'aside', 'form', 'dialog', 'main', 'details'].includes(read(g, 'localName')) || /^(?:region|group|complementary|form)$/.test(read(g, 'getAttribute')('role') ?? ''))) g = up(g); return g ?? root; };
  const inSummary = owner => {
    if (!summaryRoot) return true;
    let side = false;
    for (let a = owner; a; a = up(a)) {
      if (a === summaryRoot) return !side;
      const tag = read(a, 'localName'), role = read(a, 'getAttribute')('role') ?? '';
      if (['aside', 'header', 'nav', 'footer'].includes(tag) || /^(?:banner|complementary|navigation|contentinfo|alert|status)$/.test(role)) side = true;
    }
    return false;
  };
  const visibleText = (node, markOutside = false) => {
    const walker = read(doc, 'createTreeWalker')(node, 5), parts = []; let part, previous;
    while ((part = walker.nextNode())) if (read(part, 'nodeType') === 1) {
      if (read(part, 'localName') === 'br') { parts.push('\n'); previous = undefined; }
    } else if (read(part, 'parentElement')) {
      const range = read(doc, 'createRange')(); range.selectNodeContents(part);
      if (!read(part, 'textContent').trim() || !visible(read(part, 'parentElement'), range.getClientRects())) continue;
      let block = read(part, 'parentElement');
      while (block !== node && /^(?:inline(?:-.*)?|contents)$/.test(gs(block).display)) block = read(block, 'parentElement');
      if (parts.length) parts.push(previous === block ? ' ' : '\n');
      parts.push((markOutside && !inSummary(read(part, 'parentElement')) ? '\uE002' : '') + read(part, 'textContent').trim()); previous = block;
    }
    return parts.join('');
  };
  // LOOSE: every rendered string under the form (offscreen, faint, ::before/::after, input values, open shadow roots, same-origin frames)
  // plus the activating control's own label. An image or canvas outside a control is a mark (￼) where a figure we cannot read may sit.
  // Known limits: a figure drawn as a CSS background image, or held in a closed shadow root with no text, is not seen.
  const looseLines = () => {
    const parts = []; let previous, count = 0;
    // The text of a control the user has picked (checked box or radio, aria-checked, selected option, the label linked to one, or the
    // row of a bare checked box) is wrapped in two private marks: whatever its label says, a chosen figure is an add-on the user will pay.
    const chosenCache = new Map();
    const chosenAria = a => ['aria-checked', 'aria-pressed', 'aria-selected', 'aria-current'].some(k => read(a, 'getAttribute')(k) === 'true') ||
      /^(?:checked|on|selected)$/.test(read(a, 'getAttribute')('data-state') ?? '') || /(?:^|\s)(?:selected|is-selected|checked|is-checked)(?:\s|$)/.test(read(a, 'getAttribute')('class') ?? '');
    const isBoxNode = c => read(c, 'localName') === 'input' && /^(?:radio|checkbox)$/.test(read(c, 'type'));
    // F-B: chosen state is marked per control and per row. A checked box or radio, or an element that is aria-checked, aria-pressed, aria-selected,
    // aria-current, data-state checked/on/selected or has the class selected/checked, marks every money figure in its row: the nearest ancestor that holds a figure (a table row, list item, label, fieldset, a
    // block that holds both the control and a figure), through span wrappers, hidden inputs, a price in its own column, or a label slotted into
    // a shadow tree that holds the box. Never the form itself or a block that holds the activating control. A flat run (control, then text
    // and inline elements up to the next line break or block) is marked too. A selected option is read through its select.
    const MONEY = /[$€£¥₹₩₽₺₪฿₫₱₦]\s*\d|\d\s*[$€£¥₹₩₽₺₪฿₫₱₦]|\b(?:USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|MXN|BRL|HKD|SGD|KRW)\s*\d|\d\s*(?:USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|MXN|BRL|HKD|SGD|KRW)\b|\d[,.]\d{2}(?!\d)|\b(?:dollars?|euros?|pounds?|bucks)\b/i;
    const chosenControls = new Set(), chosenRows = new Set();
    {
      // Every element under the form, open shadow roots included (Node members only: a shadow root has no querySelectorAll in this reader).
      const stack = [root], seen = [];
      while (stack.length && seen.length <= 20000) {
        const n = stack.pop(); seen.push(n);
        const shadow = read(n, 'shadowRoot'); if (shadow) for (const c of Array.from(read(shadow, 'childNodes') ?? [])) if (read(c, 'nodeType') === 1) stack.push(c);
        for (const c of Array.from(read(n, 'childNodes') ?? [])) if (read(c, 'nodeType') === 1) stack.push(c);
      }
      // A host's textContent leaves out its shadow tree: a block holds a figure if its own text or the text of a shadow root under it does.
      const shadowed = seen.filter(n => read(n, 'shadowRoot')).map(n => [n, MONEY.test(read(read(n, 'shadowRoot'), 'textContent') ?? '')]).filter(x => x[1]).map(x => x[0]);
      const holdsMoney = a => MONEY.test(read(a, 'textContent') ?? '') || shadowed.some(h => h === a || read(a, 'contains')(h));
      if (seen.length <= 20000) for (const n of seen) {
        if (n === root || !(isBoxNode(n) ? read(n, 'checked') : chosenAria(n) || /^["']?[✔✓☑✅]/.test(gs(n, '::before')?.content ?? ''))) continue;
        chosenControls.add(n);
        for (let a = isBoxNode(n) ? up(n) : n; a && a !== root; a = up(a)) {
          if (read(a, 'contains')(el)) break;
          if (holdsMoney(a)) { chosenRows.add(a); break; }
        }
      }
    }
    const chosenNode = a => {
      if (chosenRows.has(a)) return true;
      if (chosenCache.has(a)) return chosenCache.get(a);
      const tag = read(a, 'localName'), role = read(a, 'getAttribute')('role'), isBox = c => read(c, 'localName') === 'input' && /^(?:radio|checkbox)$/.test(read(c, 'type'));
      let yes = false;
      if (tag === 'label') { const ctl = read(a, 'control'); yes = !!ctl && isBox(ctl) && !!read(ctl, 'checked'); }
      else if (chosenAria(a)) yes = true;
      else if (tag !== 'form' && a !== root) {
        // A bare checked box (no label) takes the text of its own row when it is the only control in it.
        const kids = Array.from(read(a, 'children') ?? []), controls = kids.filter(c => ['input', 'select', 'textarea'].includes(read(c, 'localName')));
        yes = controls.length === 1 && isBox(controls[0]) && !!read(controls[0], 'checked') && !(read(controls[0], 'labels')?.length);
      }
      chosenCache.set(a, yes); return yes;
    };
    const push = (text, owner, picked = false) => {
      let t = String(text ?? '').normalize('NFKC').replace(/[­​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim(); if (!t) return;
      // A struck-out price is the old price (marked "struckthrough", which clears a figure like the other savings nouns).
      for (let a = owner; a; a = up(a)) if (['del', 's', 'strike'].includes(read(a, 'localName')) || /line-through/.test(gs(a).textDecorationLine ?? '')) { t = 'struckthrough ' + t; break; }
      if (!picked) for (let a = owner; a; a = up(a)) { if (chosenNode(a)) { picked = true; break; } if (a === root) break; }
      if (picked) t = '\uE000' + t + '\uE001';
      let block = owner; while (block && /^(?:inline(?:-.*)?|contents)$/.test(gs(block).display)) block = up(block);
      if (parts.length) parts.push(previous === block ? ' ' : '\n');
      parts.push(t); previous = block;
    };
    const pseudo = (n, which, forced = false) => { const c = gs(n, which)?.content; if (/counters?\(/.test(c ?? '')) throw Error('counter content'); if (c && c !== 'none' && c !== 'normal') push(c.replace(/^["']|["']$/g, ''), n, forced); };
    const media = ['img', 'canvas', 'svg', 'video', 'picture', 'object', 'embed'];
    const controlled = n => { const tag = read(n, 'localName'), role = read(n, 'getAttribute')('role'); return ['button', 'a', 'summary', 'select'].includes(tag) || ['button', 'link', 'tab', 'menuitem'].includes(role); };
    // Alternatives and neighbours are not this charge: the label of a radio, checkbox or ARIA option the user has not picked, and a
    // block under a "You may also like" style heading that holds no total, amount due or pay word (and not the activating control).
    const NOT_PAY = /\b(?:total|amount|due|pay|paying|payable|payment|charged?|charges|billed|billing|owe|owed|invoice)\b/i;
    const recommended = new Set();
    for (const h of Array.from(read(root, 'querySelectorAll')('h1,h2,h3,h4,h5,h6,legend,summary,caption,[role="heading"]'))) {
      const title = String(read(h, 'textContent') ?? '').replace(/\s+/g, ' ').trim();
      if (!title || title.length > 60 || !/^(?:you (?:may|might) (?:also )?like|recommended(?: for you)?|customers (?:also )?(?:bought|viewed|like)|people also (?:bought|viewed)|related (?:items|products)|similar (?:items|products)|frequently bought together|more from|trending(?: now)?|complete the look)\b/i.test(title)) continue;
      let box = read(h, 'parentElement');
      while (box && box !== root && String(read(box, 'textContent') ?? '').replace(/\s+/g, ' ').trim() === title) box = read(box, 'parentElement');
      if (box && box !== root && !read(box, 'contains')(el) && !NOT_PAY.test(read(box, 'innerText') ?? read(box, 'textContent') ?? '')) recommended.add(box);
    }
    const alternative = n => {
      if (recommended.has(n)) return true;
      const role = read(n, 'getAttribute')('role');
      let unpicked = false;
      if (read(n, 'localName') === 'label') {
        const control = read(n, 'control');
        unpicked = !!control && read(control, 'localName') === 'input' && /^(?:radio|checkbox)$/.test(read(control, 'type')) && !read(control, 'checked');
      } else if (/^(?:radio|checkbox|option|menuitemradio|menuitemcheckbox|switch)$/.test(role ?? '')) {
        const state = read(n, 'getAttribute')(role === 'option' ? 'aria-selected' : 'aria-checked');
        unpicked = state !== null && state !== 'true' && state !== 'mixed';
      }
      return unpicked && !NOT_PAY.test(read(n, 'innerText') ?? read(n, 'textContent') ?? '') && !read(n, 'contains')(el);
    };
    const walk = (n, inControl = false, forced = false) => {
      if (++count > 20000) throw Error('too many nodes');
      if (alternative(n)) return;
      const on = shown(n), tag = read(n, 'localName');
      inControl ||= controlled(n);
      if (on && media.includes(tag)) {
        const b = read(n, 'getBoundingClientRect')();
        // A banner-sized image or canvas can show a total we can't read; a smaller one outside a control is a mark: it may hold a figure.
        if (b.width >= 100 && b.height >= 16) throw Error('unreadable content');
        const alt = read(n, 'getAttribute')('alt');
        if (alt) push(alt, n, forced); else if (!inControl && b.width >= (tag === 'svg' ? 50 : 24) && b.height >= (tag === 'svg' ? 12 : 8) && !(tag === 'svg' && (read(n, 'textContent') ?? '').trim())) push('￼', n, forced);
      }
      if (on) {
        pseudo(n, '::before', forced);
        if (tag === 'input') { if (!/^(?:hidden|password|checkbox|radio|file)$/.test(read(n, 'type'))) push(read(n, 'value'), n, forced); }
        else if (tag === 'textarea') push(read(n, 'value'), n, forced);
        else if (tag === 'select') for (const o of Array.from(read(n, 'selectedOptions') ?? [])) push(read(o, 'textContent'), n, true);
      }
      if (['select', 'textarea', 'input'].includes(tag)) { if (on) pseudo(n, '::after', forced); return; }
      const shadow = read(n, 'shadowRoot'); if (shadow) for (const c of Array.from(read(shadow, 'childNodes') ?? [])) if (read(c, 'nodeType') === 1) walk(c, inControl, forced);
      if (tag === 'iframe') { try { const body = read(read(n, 'contentDocument'), 'body'); if (body) walk(body, inControl, forced); } catch { /* cross-origin */ } }
      // After a chosen control, the text and inline elements that follow it on the same line are its row too.
      let run = forced;
      for (const c of Array.from(read(n, 'childNodes') ?? [])) {
        if (read(c, 'nodeType') === 1) {
          if (chosenControls.has(c)) run = true;
          else if (read(c, 'localName') === 'br' || !/^(?:inline(?:-.*)?|contents|none)$/.test(gs(c).display)) run = forced;
          walk(c, inControl, run);
        } else if (read(c, 'nodeType') === 3 && on) push(read(c, 'textContent'), n, run);
      }
      if (on) pseudo(n, '::after', forced);
    };
    try { walk(root); } catch { return; }
    const tag = read(el, 'localName'), isField = ['input', 'select', 'textarea'].includes(tag);
    const own = [read(el, 'getAttribute')('aria-label'), isField ? undefined : read(el, 'textContent'), isField ? undefined : read(el, 'getAttribute')('value'),
      tag === 'input' && /^(?:submit|button|image|reset)$/.test(read(el, 'type')) ? read(el, 'value') : undefined].filter(Boolean);
    return parts.join('').split('\n').concat(own.map(t => String(t).normalize('NFKC').replace(/\s+/g, ' ').trim()));
  };
  // Does any rendered figure show a payable amount that differs from `amount`? Default-deny: every money figure gets a role from
  // its own label, and a figure that differs from the amount asks unless its role clears it.
  //   pay     total/amount/due/price/charge/billing...: must equal the amount.
  //   part    a part of the total (subtotal, tax, fee, shipping, "incl.") or any other label, such as an item name: at most the
  //           amount, unless a visible discount line on another line closes the gap.
  //   unit    per/each/payments/monthly: at most the amount.
  //   exempt  not a charge (discount, savings, was, balance, available, limit, over, away, points): any size, but only next to it.
  //   none    no label at all: asks.
  // The label is the words just before the figure on its line. Filler ("now", "only", "A$"), parenthetical notes and ":" "|" "...."
  // do not hide it. A figure that stands alone on its line takes the label above it (the label cell of a table, flex, grid, dl or
  // float row), looking up to four lines back. A figure first on its line and unlabelled reads the words after it ("$9.00 each").
  // A symbol or code that differs from the page's currency asks. A mark (image or canvas that may hold a figure) asks unless its
  // row has an ordinary word and no pay or part word.
  const conflicts = (lines, strictLines, amount, pageCurrency) => {
    const CODES = 'USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|MXN|BRL|HKD|SGD|KRW|RUB|PLN|CZK|TRY|ZAR|AED|SAR|THB|ILS|PHP|IDR|VND|NGN|TWD';
    const SIGNS = '€£¥₹₩₽₺₪฿₫₱₦', NUM = '\\d(?:[\\d.,]*\\d)?';
    const figure = new RegExp(
      `(?:\\b(${CODES})\\s*)?((?:US|CA|AU|NZ|HK|SG|MX|NT|A|C|S|R)?\\$|[${SIGNS}]|Rs\\.?)\\s*(${NUM})(?:\\s*(${CODES})(?![A-Za-z]))?` +
      `|\\b(${CODES})\\s*(${NUM})` +
      `|(?<![\\w.,])(${NUM})\\s*(${CODES}(?![A-Za-z])|[${SIGNS}]|dollars?\\b|euros?\\b|pounds?\\b|bucks\\b)` +
      `|(?<![\\w.,])(\\d[\\d,]*[.,]\\d{2})(?!\\d)` +
      `|(?<![#№\\w.,])(${NUM})` +
      `|(￼)` +
      `|\\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|and)[\\s-]+)+)(dollars?|euros?|pounds?|bucks)\\b`, 'giu');
    const SYMBOL = { '$': '$', 'US$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD', 'NZ$': 'NZD', 'HK$': 'HKD', 'SG$': 'SGD', 'S$': 'SGD',
      'MX$': 'MXN', 'NT$': 'TWD', 'R$': 'BRL', '€': 'EUR', '£': 'GBP', '¥': '¥', '₹': 'INR', '₩': 'KRW', '₽': 'RUB', '₺': 'TRY', '₪': 'ILS',
      '฿': 'THB', '₫': 'VND', '₱': 'PHP', '₦': 'NGN', 'rs': 'Rs', 'rs.': 'Rs', 'dollar': '$', 'dollars': '$', 'euro': 'EUR', 'euros': 'EUR',
      'pound': 'GBP', 'pounds': 'GBP', 'buck': '$', 'bucks': '$' };
    const GENERIC = { '$': ['USD', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'MXN', 'TWD'], '¥': ['JPY', 'CNY'], 'Rs': ['INR', 'PKR', 'LKR', 'NPR'] };
    const same = (a, b) => !a || !b || a === b || !!GENERIC[a]?.includes(b) || !!GENERIC[b]?.includes(a);
    const set = words => new Set(words.split(' '));
    const PAY = set('total amount due pay paying payment payable price cost charge charged charges charging billed billing bill owe owed owes invoice invoiced');
    const UNIT = set('per each ea unit units apiece × x payments installment installments instalment instalments monthly weekly daily yearly annually quarterly month months mo week weeks wk year yr day days hour hours hr hrs night nights');
    const PART = set('sub subtotal tax taxes vat gst hst fee fees shipping delivery handling freight postage tip tips gratuity surcharge duty duties levy item items service processing packaging insurance deposit installation before excl excluding excludes pretax without incl includes including inc plus less minus after with');
    const CUT = set('discount discounts savings saving save saved coupon coupons promo promos rebate rebates cashback reward rewards off applied redeemed');
    // A word that says a figure is not a charge clears it only inside a closed phrase. Savings nouns (discount, coupon...) end a label.
    // The rest clear a figure when the label is that word alone or the word stands straight after a closed noun ("Discount applied",
    // "Coupon redeemed", "Loyalty points earned", "Orders over"), so "Fee applied", "Debit limit" or "Card hold applied" stay plain parts.
    const NOUN_EX = set('discount discounts savings saving coupon coupons promo promos rebate rebates cashback struckthrough');
    const AFTER_NOUN = set('discount discounts savings saving coupon coupons promo promos rebate rebates cashback struckthrough credit credits code codes offer offers voucher vouchers loyalty bonus member membership club store reward rewards points point pts partial full gift earn earns');
    const AFTER_ORDER = set('order orders purchase purchases spend spending cart carts shipping delivery free item items credit transaction daily monthly weekly');
    const KIND_AFTER = set('save saved off applied redeemed available earn earned refund refunded points point pts reward rewards');
    const KIND_BOUND = set('limit minimum maximum min max over above away threshold');
    const KIND_REF = set('was original orig regular reg list msrp compare retail');
    const EXEMPT = new Set([...NOUN_EX, ...KIND_AFTER, ...KIND_BOUND, ...KIND_REF]);
    // Money movement: a label or clause that says the money leaves the card or account is never a savings line.
    const MOVE = /^(?:debit\w*|withdr\w+|deduct\w*|captur\w+|collect\w*|authori[sz]\w+|hold|held|taken|pull\w*|drawn|sweep\w*|swept|settle\w*|remit\w*|transfer\w*|sent|send\w*|submit\w*|draft\w*|cleared|wire\w*|ach|merchant|seller|vendor|payee|lender|card|cards|account|accounts|bank|wallet|paypal|stripe|visa|mastercard|amex)$/;
    const SAVE_WORDS = set('off on your you first next order orders purchase purchases item items with code codes promo coupon each per saved save today applied redeemed automatically auto included already total cart subtotal price sale regular sitewide storewide new member members customer customers only thanks thank for joining signing up newsletter being a an the of to and or is are was were will be been this that it its at in from all any more less when if spend buy over above minimum maximum min max free shipping delivery bonus extra additional back earned points rewards cash percent annual monthly annually discount discounts savings offer offers deal welcome expires expire valid until through ends end available remaining balance left limit value worth used unused now checkout one time sign signup referral friend friends birthday holiday summer winter spring fall black friday cyber monday clearance student students senior seniors military volume bulk bundle loyalty reward points pts original compare retail msrp list reg mfr was tier level gold silver bronze platinum prime premium plus pro membership subscription plan plans year years month months week weeks day days entire whole everything site store online app second third last every while supplies exclusive limited special promotion promotional campaign event season vip claim claimed unlock unlocked get gets got give gives given receive received enjoy enjoyed earn earns compared compare verified verify eligible eligibility redeem redeemable drop prices than vs versus lower cheaper better best');
    const RIGHT_OK = set('off away saved savings saving discount discounts coupon promo rebate cashback points pts reward rewards earned back available');
    const OFFER_VERBS = set('take get save enjoy receive extra additional another more');
    // balance, value, worth and credit are also names of a real charge ("Balance due", "Order value", "Credit card"): they clear a
    // figure only beside a word that makes them a store of money ("available balance", "gift card balance", "points value").
    const WEAK = set('balance value valued worth credit credits');
    const WEAK_WITH = set('available remaining gift points point pts reward rewards store loyalty member');
    // Not a charge unless it happens: "from", "up to", "starting at", "if", a late or cancellation fee.
    const NOTE_NOUN = set('code codes amount amounts offer offers deal deals line lines item items today so far applied used');
    const CHARGED = set('pay paying payable payment charge charged charges billed billing owe owed due invoice');
    const COND = set('from up upto starting if unless when');
    const LATE = set('late cancellation cancelation penalty overdue noshow');
    const LATE_LABEL = /^(?:late fees?|late payment fees?|cancellation fees?|cancelation fees?|penalty)$/;
    // "from" and "up to" clear a figure only after a plain product or price noun, never after a payment verb ("Debit from", "Withdrawal up to").
    const FROM_NOUN = 'plans? tickets? prices? pricing rooms? rates? fares? bags? checked carry on package packages tiers? options? seats? deals? memberships? subscriptions? add extras? upgrades? delivery shipping sizes? models? products? items? services? tours? courses? classes? match guarantee coverage protection insurance warranty cashback rewards? refunds? credits? saving savings save discounts? rebates? offers? free cancellation extra additional cabin economy premium basic standard pro team business enterprise';
    const FROM_LABEL = new RegExp(`^(?:(?:${FROM_NOUN.split(' ').join('|')}) ){1,4}(?:from|up|upto|starting)$`);
    const CHARGE_PART = set('carrier facility device equipment airport resort booking regulatory recovery transaction activation usage overage roaming convenience admin administrative environmental security cleaning federal state local municipal');
    const STRONG_PAY = /\b(?:total|amount|due|pay|paying|payable|payment|charged?|charges|billed|billing|owe|owed|invoice)\b/i;
    const RECOMMEND = /^(?:you (?:may|might) (?:also )?like|recommended(?: for you)?|customers (?:also )?(?:bought|viewed|like)|people also (?:bought|viewed)|related (?:items|products)|similar (?:items|products)|frequently bought together|more from|trending(?: now)?|complete the look)\b/i;
    const FILL = set('of is are will be only now today just about approx approximately currently a an the in on at for to your you re our we my this that it its s then also final full overall est estimated usd eur gbp cad aud');
    const CONNECT = set('or and to');
    const APPROX = set('approx approximately about around roughly converted conversion equivalent estimated est');
    const QUAL = set('incl includes including inc plus less minus after with before excl excluding excludes without');
    const COUNTED = /^(?:items?|pcs|pieces?|units?|qty|x|×|days?|hours?|mins?|minutes?|years?|months?|weeks?|payments?|installments?|points?|pts|interest|percent|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|st|nd|rd|th)$/i;
    // A gift card, voucher or store credit line that is bought or only offered is not a tender that paid for part of the order.
    const BOUGHT = /\b(?:purchas\w*|buy\w*|bought|add|adding|added|send|sending|ordered|sold|issued|reload|reloaded|fee)\b/i;
    const INERT = /\b(?:not|never|unused|optional|expired|invalid|eligible|ineligible|unavailable|if|can|may|could|would)\b|n't/i;
    const SOFT = /\b(?:available|balance|remaining|left)\b/i;
    const eps = 0.005;
    const parse = raw => {
      let s = String(raw).replace(/\s/g, '');
      const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
      if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
      else if (comma >= 0) s = /,\d{2}$/.test(s) && s.indexOf(',') === comma ? s.replace(',', '.') : s.replace(/,/g, '');
      else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '');
      return Number(s);
    };
    const A = parse(String(amount).replace(/[^\d.,]/g, ''));
    const words = text => text.toLowerCase().match(/\p{L}+|×/gu) ?? [];
    const digit = ch => { const c = ch.codePointAt(0); let z = c; while (/\p{Nd}/u.test(String.fromCodePoint(z - 1))) z--; return String((c - z) % 10); };
    const norm = text => String(text).normalize('NFKC').replace(/[­​-‏⁠﻿]/g, '').replace(/\p{Nd}/gu, d => /[0-9]/.test(d) ? d : digit(d))
      .replace(/\b(incl|excl|inc|approx|est|ex|vs|no)\./gi, '$1').replace(/\.{2,}|…|_{2,}|-{3,}|[·•]/g, ' ').replace(/\s+/g, ' ').trim();
    const unparen = text => { let t = text; for (let before; before !== t;) { before = t; t = t.replace(/\([^()]*\)|\[[^\[\]]*\]/g, ' '); } return t; };
    const lastBreak = text => Math.max(...[...text.matchAll(/[.;!?](?=\s|$)/g)].map(x => x.index), -1);
    const before = text => { const t = unparen(text); return t.slice(lastBreak(t) + 1); };
    const after = text => { const t = unparen(text.replace(/^[\s)\]]+/, '')), hard = /[.;!?](?=\s|$)/.exec(t); return hard ? t.slice(0, hard.index) : t; };
    const sig = text => words(text).filter(w => !FILL.has(w));
    // Exemptions come from closed lists of positive phrases, not from a list of words that take them back. A figure is a settled
    // payment, a later invoice or an estimate only if its whole label is one of the phrases below and the rest of its clause (to
    // the end of the sentence) holds nothing but punctuation, a currency code, a date or one of the few closed phrases. Any other
    // word, in any language, makes the figure a plain part of the total.
    const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
    const DATE = new RegExp(`(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?,?\\s+)?(?:${MON}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MON}(?:,?\\s+\\d{4})?|${MON}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4})`, 'gi');
    const DATE_WORD = /(?:\b(?:as of|as at|on|through|until|since|by) )?@/g;
    // Lower case, dates turned into "@", everything but letters, "@", "≈" and "~" dropped.
    const shape = text => norm(text).toLowerCase().replace(/['’]/g, '').replace(DATE, ' @ ').replace(/[^\p{L}@≈~ ]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const CODE_LOW = CODES.toLowerCase().replace('|try', '');
    const CLAUSE_PHRASES = [...CODE_LOW.split('|'), 'estimate', 'estimated', 'approx', 'approximately', 'to date', 'so far', 'as of today',
      'at todays rate', 'at the current rate', 'at current rate', 'at todays exchange rate', 'at the current exchange rate'];
    // Words that only name the next figure on the same line ("Paid $40.00 Balance due $18.00"): they do not describe this one.
    const LABEL_TAIL = new Set([...PART, ...UNIT, ...CUT, ...EXEMPT, ...WEAK, ...'total amount due price cost payment payments grand new current remaining left and or plus balance'.split(' ')]);
    const closedClause = (text, more = []) => {
      const parts = Array.isArray(text) ? text : [text];
      let t = parts.map((part, i) => {
        const u = shape(part).replace(DATE_WORD, ' ').replace(/\s+/g, ' ').trim();
        if (i === parts.length - 1) return u;
        const w = u.split(' ').filter(Boolean); while (w.length && LABEL_TAIL.has(w.at(-1))) w.pop(); return w.join(' ');
      }).join(' ');
      for (const phrase of [...CLAUSE_PHRASES, ...more].sort((x, y) => y.length - x.length)) t = t.split(new RegExp(`(?:^| )${phrase}(?= |$)`)).join(' ');
      return t.trim() === '';
    };
    // The words after a savings figure (to the sentence end) are all ordinary savings talk, a code or a date.
    const savingsClause = pieces => pieces.every((part, i) => {
      const w = shape(part).replace(DATE_WORD, ' ').split(' ').filter(Boolean);
      if (i < pieces.length - 1) while (w.length && LABEL_TAIL.has(w.at(-1))) w.pop();
      return w.every(x => x.length < 2 || x === '@' || SAVE_WORDS.has(x) || RIGHT_OK.has(x) || CODE_LOW.split('|').includes(x));
    });
    const labelPhrase = text => shape(text).replace(DATE_WORD, ' ').replace(/\s+/g, ' ').trim();
    const SETTLED_LABEL = /^(?:paid(?: to date| so far)?|(?:amount|total) paid(?: to date)?|already paid|payments? (?:received|made|applied)(?: to date)?(?: thank you)?|(?:previous|prior|earlier) (?:payments?|balance|invoices?)|credits? applied(?: to date)?|amount credited)(?: paid(?: in full)?)?$/;
    const NEXT_LABEL = /^(?:next|upcoming) (?:invoice|bill|billing|statement)(?: date)?$/;
    const EST_LABEL = new RegExp(`^(?:(?:approx|approximately|about|around|roughly|equivalent|converted|conversion|estimated|est)(?: (?:in|to|as) (?:${CODE_LOW}|euros?|pounds?|dollars?))?|≈|~)$`);
    const TENDER_NAME = '(?:gift cards?|gift certificates?|store credit|vouchers?|promo credit|account credit)';
    const TENDER_LABEL = new RegExp(`^(?:${TENDER_NAME} (?:applied|redeemed|used)|paid with ${TENDER_NAME})$`);
    // Notes that name a future penalty or a statistic, not a charge. A late or cancellation fee note is one sentence with that one figure,
    // and the sentence is one of three closed shapes that name a date, a deadline or "unpaid": "A $5.00 late fee applies after that date.",
    // "If you pay after Oct 30, a $500.00 late fee applies.", "Late fee: $25.00 if unpaid". Any other word makes it a plain figure.
    // A statistic is a closed phrase ("The average gift is", "an average of", "Donors give an average of") with nothing else in the label.
    const FEE = '(?:(?:late|late payment|cancellation|cancelation|overdue|no show|returned payment) fee|penalty|penalty fee)';
    const FEE_VERB = '(?: of)?(?: applies| will apply| is added| will be added| is assessed| will be assessed)?';
    const WHEN = '(?:(?:after|past|by|before) (?:the |that |this )?(?:@|date|due date|deadline|days?|hours?|weeks?))';
    const PENALTY_SHAPES = [
      new RegExp(`^(?:an? |the )?${FEE}${FEE_VERB} ${WHEN}$`),
      new RegExp(`^(?:if|unless) you (?:pay|paid) (?:late|${WHEN}),? (?:an? |the )?${FEE}${FEE_VERB}$`),
      new RegExp(`^(?:an? |the )?${FEE}${FEE_VERB} (?:if|unless) (?:you |payment |your payment |it |the payment )?(?:is |are |was )?(?:unpaid|late|overdue|not paid|not received|not made)(?: ${WHEN})?$`)];
    // "After Nov 27 the fine becomes $120.00": a note on what a fine grows to after a date.
    PENALTY_SHAPES.push(new RegExp(`^(?:after|from|starting|beginning) (?:the )?@ (?:the |your )?(?:fine|fee|penalty|late fee|late penalty|price|rate) (?:becomes|increases to|rises to|goes up to|will increase to|will be|is)(?: and (?:may|will) be (?:sent|referred|forwarded) to collections?)?$`));
    const penaltyNote = rest => PENALTY_SHAPES.some(x => x.test(rest));
    // A count of days, hours or weeks keeps its digits: "after 0 days" is now, not a later date.
    const penaltyShape = text => shape(norm(text).replace(/(\d+)(?=\s*(?:days?|hours?|weeks?)\b)/gi, d => /^0+$/.test(d) ? ' zerocount ' : ' '));
    // F-G, closed lists. A welcome-type offer with a minus sign is a discount. A parenthetical "(covers accidental damage up to $2,500)" after a
    // price that is within the amount, and a coverage limit or deductible beside an insurance premium, say what a plan covers, not what is charged.
    // A renewal note ("Your plan renews each week at $79.99 plus shipping.") names a later charge.
    const WELCOME_OFFER = /^(?:welcome|new customer|new member|first order|referral|member) offers?$/;
    const COVER_NOTE = /^(?:covers?|covering|coverage|protects?|protection|insures?|insured) (?:(?:accidental |physical |water |cosmetic )?(?:damage|loss|theft|accidents?|repairs?|liability|cancellation|medical expenses|baggage|trips?)(?:(?: and| or) (?:accidental )?(?:damage|loss|theft|repairs?))* )?(?:up to|of up to|to a maximum of)$/;
    const INS_LABEL = /^(?:(?:annual|yearly|per claim|per incident|per year|maximum|max|overall|lifetime) )*(?:coverage limit|coverage amount|deductible|policy limit|out of pocket (?:max|maximum))$/;
    const RENEW_LABEL = /^(?:your |the )?(?:plan |subscription |box |membership |order )?(?:renews|will renew|auto renews|renewal)(?: (?:each|every) (?:week|month|year))?(?: weekly| monthly| yearly| annually)?(?: at| for| price)?$/;
    const RENEW_CLAUSE = ['plus shipping', 'plus tax', 'plus taxes', 'plus tax and shipping', 'plus shipping and tax', 'plus taxes and shipping', 'plus shipping and taxes', 'and shipping', 'and tax', 'and taxes'];
    const STAT_LABEL = /^(?:on )?(?:(?:(?:monthly|regular|recurring|annual|new|most|our) )?(?:donors|customers|members|guests|people|users|buyers|shoppers|supporters|visitors) (?:give|donate|spend)(?: on)? )?(?:(?:the|an?|our) )?(?:average|avg|median|typical|mean)(?: (?:gift|donation|order|bill|invoice|basket|cart|purchase|payment|ticket|cost|spend|booking|stay|order value|order size|monthly gift|monthly donation))?(?: is| was| of)?$/;
    const OPTIONAL_LABEL = /^optional (?:tips?|donations?|add on|addon|add ons|gift wrap|gift wrapping|insurance|protection|gift|extras?|upgrade|warranty|coverage)$/;
    // F-A. Every exempt label (with a savings noun or without) clears a figure larger than the amount only if the WHOLE label is a closed phrase
    // ("Discount", "Coupon", "Promo code SAVE10", "Savings", "You saved", "Points redeemed", "Student discount"). One word outside the closed
    // vocabulary, a foreign word included, makes the figure a plain part, with or without a minus sign. "After/with/net of/less/final/remaining/
    // outstanding/balance" in the label names the amount still payable.
    const SAV_NOUNS = set('discount discounts coupon coupons promo promos promotion promotional saving savings rebate rebates cashback');
    const SAV_MODS = set('student students member members membership loyalty bundle bundled seasonal employee employees staff senior seniors military veteran veterans teacher teachers welcome referral birthday holiday sale clearance volume bulk multi policy safe driver early bird first order orders new customer customers online app vip sitewide storewide black friday cyber monday summer winter spring fall annual price pricing match trade family group shipping delivery code codes applied redeemed saved save off earned available used extra additional bonus instant fee fees service full amount');
    const SAV_DENY = set('after with net less minus final remaining outstanding balance post plus before incl excl including excluding');
    // A label with no savings noun ("Points redeemed", "You saved", "Credit available") is exempt only if EVERY word of it is in this closed
    // vocabulary (a foreign or unknown word anywhere makes it a plain part) and one of them is a head word, so "applied" or "off" alone is no label.
    const WALLET = set('gift points point pts reward rewards store loyalty member');
    const EXV = new Set([...NOUN_EX, ...SAV_NOUNS, ...SAV_MODS, ...AFTER_NOUN, ...AFTER_ORDER, ...KIND_AFTER, ...KIND_BOUND, ...KIND_REF, ...WEAK, ...WEAK_WITH, ...NOTE_NOUN]);
    const EX_HEAD = new Set([...NOUN_EX, ...SAV_NOUNS, ...KIND_BOUND, ...KIND_REF, ...WEAK, ...'saved save refund refunded points point pts reward rewards credit credits voucher vouchers bonus gift code codes offer offers earned'.split(' ')]);
    // Words that may stand in the sentence or line just before an exempt label (the closed vocabulary above plus a heading or two).
    const LEAD_OK = new Set([...SAVE_WORDS, ...EXV, ...LABEL_TAIL, ...FILL, ...CODE_LOW.split('|'), ...'summary details review basket bag shopping promotions rewards offers savings discounts'.split(' ')]);
    const CHARGE_LEAD = /^(?:charg\w*|billed|debit\w*|deduct\w*|collect\w*|withdr\w+|captur\w+|taken|takes|pull\w*|abgebucht\w*|belast\w*|abbuch\w+|pr[ée]lev\w+|d[ée]bit\w*|cargo|cobr\w+|addebit\w*|afgeschreven|debitad\w+)$/;
    // A code is a token right after "code", "promo", "coupon", "voucher" or "offer" that has digits among its letters ("SAVE10", "20OFF") or is
    // joined capitals ("WELCOME-SAVE"). It names the offer and is blanked (same length) before the label is read, so "code SAVE10" is never
    // "code save". A word of plain letters after "code" ("code ABGEBUCHT") and a code anywhere else stay words, and one unknown word makes the label a part.
    const defang = t => String(t).replace(/\b(codes?|promo|coupon|voucher|offer)(\s*:?\s*)([\p{L}\p{N}_-]+)/giu, (all, a, b, tok) =>
      (/\p{L}.*\p{N}|\p{N}.*\p{L}/u.test(tok) && (tok.match(/\p{L}/gu) ?? []).length >= 2 && !new RegExp('^(?:' + CODES + ')\\d', 'i').test(tok)) || /^\p{Lu}{2,}(?:[-_]\p{Lu}+)+$/u.test(tok) ? a + b + ' '.repeat(tok.length) : all);
    const savingsLabel = raw => {
      const t = norm(defang(raw)).replace(/\bpaid in full\b/gi, 'full').replace(/\(\s*[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\s*\)/g, ' ');
      const w = words(t).filter(x => !FILL.has(x)), has = w.some(x => SAV_NOUNS.has(x)), wallet = w.some(x => WALLET.has(x));
      // "Available balance" and "Gift card balance" are stores of money, "Remaining ... balance" only beside a wallet word.
      return { has, denied: w.some(x => SAV_DENY.has(x) && !(!has && (x === 'balance' && (wallet || w.includes('available')) || x === 'remaining' && wallet))),
        closed: has ? w.every(x => SAV_NOUNS.has(x) || SAV_MODS.has(x)) : w.length > 0 && w.every(x => EXV.has(x)) && w.some(x => EX_HEAD.has(x)) };
    };
    // F-E. A payment due now that is a deposit or an installment, beside the later total or balance of the same bill.
    const PARTIAL_LABEL = /^(?:(?:(?:booking|reservation|initial|first|required|down) )?(?:deposit|payment)(?: of)? due (?:now|today|at (?:booking|checkout|reservation|signup|sign up))|down payment(?: due (?:now|today|at (?:booking|checkout)))?|(?:(?:first|next|this|current) )?(?:installment|instalment)(?: of)?(?: due (?:now|today))?)$/;
    const LATER_TOTAL = /^(?:(?:estimated|full|entire) )?(?:total(?: (?:cost|price|amount))?|price|cost)$/;
    const LATER_BALANCE = /^(?:(?:remaining|outstanding) )?balance(?: of| remaining| due| owing)?$|^(?:remaining|outstanding) (?:balance|amount)$|^(?:remainder|rest)$/;
    const LATER_WHEN = ['at pickup', 'at pick up', 'at check in', 'at checkin', 'on arrival', 'at arrival', 'upon arrival', 'at delivery', 'upon delivery', 'at completion', 'upon completion', 'on completion', 'at closing', 'at departure', 'at the event', 'at move in', 'at installation', 'later', 'at the venue', 'at the property', 'at the counter'];
    const LATER_VERB = ['is due', 'due', 'is payable', 'payable', 'will be due', 'is owed', 'owed', 'remains', 'is the remainder'];
    const PERIODS = ['a month', 'per month', 'a year', 'per year', 'a week', 'per week', 'a day', 'per day', 'an hour', 'per hour', 'a night', 'per night', 'monthly', 'yearly', 'weekly', 'daily', 'each', 'each way', 'one way', 'per way', 'per person', 'a person', 'per bag'];
    // A gross figure that a tender line (gift card, store credit, voucher, credit, a payment already received) brings down to the amount.
    const TENDER = set('gift voucher vouchers credit credits certificate');
    const GROSS = /^(?:order total|invoice(?: total)?|total invoice|original (?:invoice )?(?:amount|total)|invoice amount|total before .+)$/;
    // The role of a label, read from its significant words (the nearest word decides).
    const classify = list => {
      const role = classify0(list), phrase = list.join(' ');
      if (role.cut && list.some(x => TENDER.has(x))) role.tender = true;
      if (role.kind === 'pay' && GROSS.test(phrase)) role.gross = true;
      return role;
    };
    const classify0 = list => {
      const w = list.at(-1), hasPay = list.some(x => PAY.has(x)), strong = list.some(x => PAY.has(x) && x !== 'price' && x !== 'cost');
      const stores = list.some(x => WEAK_WITH.has(x));
      // The word at list[i] clears the figure: a savings noun, a weak word beside a store word, or a modifier alone / straight after its closed noun.
      const exemptAt = i => {
        const x = list[i], p = list[i - 1];
        if (NOUN_EX.has(x)) return true;
        if (WEAK.has(x)) return stores;
        if (!EXEMPT.has(x)) return false;
        if (i === 0) return true;
        if (KIND_AFTER.has(x)) return AFTER_NOUN.has(p) || list.slice(0, i).some(y => y === 'code' || y === 'codes');
        if (KIND_BOUND.has(x)) return AFTER_ORDER.has(p);
        return KIND_REF.has(p);
      };
      const phrase = list.join(' '), cutPhrase = /\b(?:gift ?cards?|gift certificates?|store credits?|vouchers?)\b/.test(phrase);
      // "New charges $6" beside "Previous balance $12" and "Total due $18": a part of the total.
      if (/^(?:new|current|recent|additional) (?:charges?|purchases?|fees?|activity)$/.test(phrase)) return { kind: 'part' };
      if (UNIT.has(w)) return { kind: 'unit' };
      // "Late fee", "from", "up to": not a charge unless it happens, but only as the whole label ("Late fee", "Plans from", "Save up to").
      if ((COND.has(w) || list.some(x => LATE.has(x))) && (LATE_LABEL.test(phrase) || !strong && FROM_LABEL.test(phrase))) return { kind: 'exempt' };
      if (PAY.has(w)) {
        const p = list.at(-2), i = list.length - 2;
        if (PART.has(p) || i >= 0 && exemptAt(i)) return { kind: 'part', cut: CUT.has(p) };
        return CHARGE_PART.has(p) && /^(?:charges?|payments?)$/.test(w) ? { kind: 'part', chargePart: true } : { kind: 'pay' };
      }
      if (cutPhrase) return { kind: hasPay ? 'part' : 'exempt', cut: true };
      if (PART.has(w)) return { kind: 'part' };
      if (exemptAt(list.length - 1)) return { kind: hasPay ? 'part' : 'exempt', cut: CUT.has(w), sav: true };
      // A savings word ahead of an ordinary noun still clears the figure ('coupon code', 'savings amount'), but not a product name ('savings plan').
      const first = list.findIndex((x, i) => exemptAt(i));
      if (!hasPay && first >= 0 && !list.slice(first + 1).some(x => !NOTE_NOUN.has(x))) return { kind: 'exempt', sav: true };
      return { kind: 'part', unknown: true };
    };
    const analyze = rawLines => {
      // U+E000 to U+E003 are private marks put on the text of chosen controls and of text outside the order summary; they are not read.
      const chosenLine = rawLines.map(t => /\uE000/.test(t)), outsideLine = rawLines.map(t => /\uE002/.test(t));
      const list = rawLines.map(t => norm(t.replace(/[\uE000-\uE003]/g, ''))).map(t => RECOMMEND.test(t) && !STRONG_PAY.test(t) ? '' : t), found = [];
      const hasFigure = list.map(t => [...t.matchAll(figure)].some(m => m[10] === undefined));
      // A label line may carry a figure of its own in parentheses ("Gift card (balance $20.00)" above "-$20.00").
      const labelFigure = list.map(t => [...unparen(t).matchAll(figure)].some(m => m[10] === undefined));
      // The nearest line with words above a lone figure labels it. A note line that only holds an exempt word ("incl. savings",
      // "with points") is walked past to the pay or part label above it, as long as no other figure sits between; with no such
      // label the note decides.
      const labelAbove = i => {
        let note;
        for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
          if (labelFigure[j] && note) break;
          if (!/\p{L}/u.test(list[j]) || labelFigure[j]) continue;
          const s = sig(before(defang(list[j])));
          // A label of filler words that says it is an estimate ("Estimated in EUR", "About") labels the figure below it.
          if (!s.length) { if (words(before(list[j])).some(x => APPROX.has(x))) return { kind: 'part', unknown: true, adjacent: j === i - 1, raw: list.slice(j, i).join(' '), at: j }; continue; }
          const role = { ...classify(s), adjacent: j === i - 1, raw: list.slice(j, i).join(' '), at: j };
          if (role.kind !== 'exempt') return note && role.unknown ? note : role;
          note ??= role;
        }
        return note;
      };
      list.forEach((text, i) => {
        const all = [...text.matchAll(figure)], textD = defang(text);
        const alone = !/\p{L}/u.test(text.replace(figure, ' '));
        let start = 0, previous;
        all.forEach((m, k) => {
          const bare = m[10] !== undefined, mark = m[11] !== undefined, spelled = m[12] !== undefined;
          if (bare && textD[m.index] !== text[m.index]) return; // digits inside a code token ("INV-204") are no figure
          const raw = m[3] ?? m[6] ?? m[7] ?? m[9] ?? m[10];
          const next = all[k + 1], segO = text.slice(start, m.index), seg = textD.slice(start, m.index), tail = textD.slice(m.index + m[0].length, next?.index ?? text.length);
          const lw = words(before(seg)), ls = lw.filter(w => !FILL.has(w)), rs = sig(after(tail)), r0 = rs[0];
          const rp = rs.slice(0, 4).some(x => PAY.has(x));
          const period = rs.slice(0, 3).some(x => /^(?:month|months|monthly|mo)$/.test(x)) ? 'month' : rs.slice(0, 3).some(x => /^(?:year|years|yearly|annual|annually|yr)$/.test(x)) ? 'year' : undefined;
          let role, via = 'none';
          if (previous && !ls.length && lw.every(w => CONNECT.has(w))) { role = previous.role0; via = 'inherit'; }
          else if (ls.length) {
            role = classify(ls); via = 'left';
            if (role.unknown && r0 && PAY.has(r0)) { role = { kind: 'pay' }; via = 'left+right'; }
            else if (role.unknown && rp && !UNIT.has(r0)) { role = { kind: 'pay' }; via = 'left+right'; }
            else if (role.unknown && RIGHT_OK.has(r0) && ls.every(x => OFFER_VERBS.has(x))) role = { kind: 'exempt', sav: true, offer: true };
          } else if (r0) {
            if (PAY.has(r0)) role = { kind: 'pay' }; else if (RIGHT_OK.has(r0)) role = { kind: rp ? 'part' : 'exempt', cut: CUT.has(r0), sav: true };
            else if (PART.has(r0) || UNIT.has(r0)) role = classify([r0]);
            else if (rp) role = { kind: 'pay' };
            via = 'right';
          }
          // An exempt label does not clear a figure that the clause after it calls a charge ("Reward: $500.00 charged now").
          if (via === 'left' && role?.kind === 'exempt' && rs.slice(0, 3).some(x => CHARGED.has(x))) role = { kind: 'part', cut: role.cut };
          if (!role && alone && !mark) { role = labelAbove(i); via = 'above'; if (role && role.kind === 'exempt' && !role.adjacent) role = { ...role, kind: 'part' }; }
          if (r0 && UNIT.has(r0) && role && role.kind !== 'exempt') role = { kind: 'unit' };
          role ??= { kind: 'none' };
          // What the label says, in full (parentheses too), and what the rest of the line says after the figure.
          // The label is cut at the last sentence end before it, the clause at the first one after it.
          const labelOrig = via === 'above' ? role.raw ?? '' : via === 'inherit' ? previous.labelOrig : via === 'right' || via === 'none' ? '' : segO.slice(lastBreak(segO) + 1);
          const labelRaw = via === 'above' ? defang(role.raw ?? '') : via === 'inherit' ? previous.labelRaw : via === 'right' || via === 'none' ? '' : seg.slice(lastBreak(seg) + 1);
          // The clause runs to the sentence end, across later money figures (a bare number such as the 1 in "Dec 1" is part of the clause).
          // It is read as the pieces between those figures: the label words of the next figure at the end of a piece do not count.
          const rest = text.slice(m.index + m[0].length), stop = /[.;!?](?=\s|$)/.exec(rest), toEnd = stop ? rest.slice(0, stop.index) : rest;
          const pieces = []; let cut = 0;
          for (const x of toEnd.matchAll(figure)) if (x[10] === undefined) { pieces.push(toEnd.slice(cut, x.index)); cut = x.index + x[0].length; }
          pieces.push(toEnd.slice(cut));
          const clause = pieces.join(' '), tailMoney = pieces[0];
          const sStart = lastBreak(text.slice(0, m.index)) + 1, sRest = text.slice(m.index + m[0].length), sStop = /[.;!?](?=\s|$)/.exec(sRest);
          const sentence = text.slice(sStart, m.index) + ' ' + (sStop ? sRest.slice(0, sStop.index) : sRest);
          const onlyFigure = [...sentence.matchAll(figure)].every(x => x[10] !== undefined);
          const labelShape = shape(labelRaw), labelBase = labelPhrase(labelRaw), clauseOk = more => closedClause(pieces, more);
          // F-A: every exempt label (savings noun or not) is read whole. After/with/net of/remaining/... names the amount still payable. The
          // words must all be in the closed vocabulary (savings nouns and modifiers, or the wallet words for a label with no noun); one foreign
          // or unknown word makes the figure a plain part, signed or not.
          const minus = /[-−–]$/.test(seg), lab = (via === 'left' || via === 'above') && !role.offer ? savingsLabel(labelRaw) : undefined;
          const struck = words(labelRaw).at(-1) === 'struckthrough';
          if (role.sav && role.kind === 'exempt' && lab && !struck && (lab.denied || !lab.closed)) role = { kind: 'part' };
          // F-H: an exempt label that follows a sentence that is not savings talk ("Abgebucht von Ihrer Karte. Discount: $500.00"), or a line that
          // says money is charged ("We charge your card now." above "Discount", "Abgebucht" above the label above the figure), may have been cut
          // off from that statement by a break: it is a plain part. Lines holding figures are rows and do not count.
          if (role.sav && role.kind === 'exempt' && !role.offer && !struck && (via === 'left' || via === 'above')) {
            const lead = via === 'left' ? seg.slice(0, lastBreak(seg) + 1) : '';
            let bad = words(lead).some(x => !LEAD_OK.has(x) || CHARGE_LEAD.test(x));
            if (!bad && !lead.trim() && (via === 'above' || start === 0))
              for (let q = (via === 'above' ? role.at : i) - 1; q >= 0; q--) if (/[\p{L}\p{N}]/u.test(list[q])) { bad = !labelFigure[q] && words(list[q]).some(x => CHARGE_LEAD.test(x)); break; }
            if (bad) role = { kind: 'part' };
          }
          // A savings word clears a figure only if the label (parentheses too) names no money movement and the rest of the sentence is
          // ordinary savings talk ("off your first order", "(SAVE10)"). "Discount: $500.00 deducted from your card" is a plain figure.
          if (role.sav && role.kind === 'exempt' && (words(labelOrig).some(x => MOVE.test(x) || PAY.has(x) && x !== 'price' && x !== 'cost') || !savingsClause(pieces))) role = { kind: 'part' };
          // A settled payment ("Amount paid", "Previous balance", "Credit applied") is exempt only if its whole label is one of the
          // closed phrases and nothing but a date, a code or a closed phrase follows the figure. Otherwise it is a plain part.
          if (via !== 'right' && via !== 'none') {
            if (SETTLED_LABEL.test(labelBase) && clauseOk(['paid', 'paid in full'])) role = { kind: 'exempt', settled: true, cut: true, tender: true };
            else if (role.settled) role = { kind: 'part' };
            // "Next invoice: $60.00 due Dec 1" and "Next invoice on Dec 1: $60.00" are a later bill, not this charge.
            else if (role.kind !== 'exempt' && NEXT_LABEL.test(labelBase) && (labelShape.includes('@') || /\bdue\b/.test(shape(clause))) && clauseOk(['due'])) role = { kind: 'exempt' };
          }
          // "Late fee", "from", "up to", "if" exempt a figure only if nothing but a period, a code or a date follows it, or the whole
          // sentence is a late fee note ("A $5.00 late fee applies after that date.").
          // "now" and "today" are filler elsewhere, but "Late fee now" and "Late fee: today" are a fee due now. A note that sits beside a sentence
          // calling the money charged, billed or taken is no note.
          const named = sig(labelBase), lateNamed = words(labelBase).filter(x => !FILL.has(x) || x === 'now' || x === 'today');
          const otherSentences = text.slice(0, sStart) + ' ' + (sStop ? sRest.slice(sStop.index + 1) : '');
          const noteOk = onlyFigure && penaltyNote(penaltyShape(sentence)) && !words(otherSentences).some(x => MOVE.test(x) || /^(?:charged|charges|billed|billing|debited|collected|deducted|withdrawn|taken|captured)$/.test(x));
          if ((via === 'left' || via === 'above') && role.kind === 'exempt' && !role.settled && (COND.has(named.at(-1)) || named.some(x => LATE.has(x))) &&
              !((LATE_LABEL.test(lateNamed.join(' ')) || FROM_LABEL.test(named.join(' '))) && clauseOk(PERIODS) || noteOk)) role = { kind: 'part' };
          // F-G (closed lists): "Welcome offer -$40.00" is a discount; a coverage note in parentheses after a price within the amount, and a
          // coverage limit or deductible (kept only beside an insurance premium, see below), are not charges.
          let coverNote = false, insNote = false;
          if ((via === 'left' || via === 'above') && role.kind !== 'exempt') {
            const open = /\(([^()]*)$/.exec(seg);
            if (minus && WELCOME_OFFER.test(labelBase) && clauseOk()) role = { kind: 'exempt', cut: true, sav: true, offer: true };
            else if (open && previous && !previous.mark && previous.value > 0 && previous.value <= A + eps && /^\s*\)/.test(tail) && COVER_NOTE.test(shape(open[1]))) { role = { kind: 'exempt' }; coverNote = true; }
            else if (INS_LABEL.test(labelBase) && clauseOk(PERIODS)) { role = { kind: 'exempt' }; insNote = true; }
          }
          const role0 = role;
          // A tender that was bought, offered or not applied does not bring an order total down to the amount. A minus sign before the
          // figure says it was taken off. Without one, the line closes a gap only if its label is a closed phrase ("Gift card applied",
          // "Paid with store credit"); a note on what is left on the card keeps it exempt and closes nothing; anything else is a part.
          if (role.tender && !role.settled) {
            const note = labelRaw + ' ' + clause, taken = /[-−–]\s*$/.test(seg);
            if (BOUGHT.test(note)) role = { kind: 'part' };
            else if (taken) { if (INERT.test(note)) role = { ...role, cut: false, tender: false }; }
            else if (TENDER_LABEL.test(labelBase) && clauseOk()) { /* a closed phrase: keeps the gap closed */ }
            else if (SOFT.test(labelRaw) && !INERT.test(note) && clauseOk()) role = { ...role, cut: false, tender: false };
            else role = { kind: 'part' };
          }
          // A late or cancellation fee note, an optional extra, or a statistic ("an average of $25.00 a month"): not a charge.
          if (role.kind === 'part' || role.kind === 'unit' || role.kind === 'none') {
            if (!bare && !mark && !spelled && onlyFigure && (noteOk || (STAT_LABEL.test(labelBase) || OPTIONAL_LABEL.test(labelBase)) && clauseOk(PERIODS) || RENEW_LABEL.test(labelBase) && clauseOk(RENEW_CLAUSE))) role = { kind: 'exempt' };
          }
          // A bare number counts only straight after a pay word ("Total 500", "Total: 500"), and not as a count or a date.
          if (bare && (via !== 'left' || role.kind !== 'pay' || COUNTED.test(words(after(tail))[0] ?? '') || /^\s*%/.test(tail))) return;
          const suffix = m[8] ?? m[13], code = m[1] ?? m[4] ?? m[5] ?? (suffix && /^[A-Za-z]{3}$/.test(suffix) ? suffix : undefined);
          const sign = m[2] ?? (suffix && !/^[A-Za-z]{3}$/.test(suffix) ? suffix : undefined);
          const cur = code ? code.toUpperCase() : sign ? SYMBOL[sign] ?? SYMBOL[sign.toUpperCase()] ?? SYMBOL[sign.toLowerCase()] : undefined;
          // A figure in another currency that calls itself an estimate ("Approximately EUR 16.60", "≈ €16.60", "Converted: €16.60"), or that
          // sits in parentheses right after the figure that is the amount ("$18.00 (€16.60)"), is a conversion note, not a charge.
          // A pay word in its own label ("Estimated total €500.00") keeps it a charge.
          // The label must be one of the closed estimate phrases ("Approx.", "About", "≈", "Equivalent", "Estimated in EUR") and the rest of
          // the clause only a code, a date or a closed phrase ("at today's rate"). A figure with no label of its own takes the marker after it.
          const estLabel = via === 'above' ? labelRaw : seg.slice(lastBreak(seg) + 1), estBase = labelPhrase(estLabel);
          const tailMark = /^\s*\(?\s*(?:[≈~]|(?:approx|estimate|estimated|est)\b)/i.test(tail);
          const approx = !mark && !spelled && clauseOk() && (EST_LABEL.test(estBase) || estBase === '' && tailMark);
          const close = tailMoney.indexOf(')');
          const paren = previous && /^\s*\(\s*$/.test(seg) && closedClause(close < 0 ? tailMoney : tailMoney.slice(0, close)) ? previous : undefined;
          // F-E: a deposit or installment due now, and the later total or balance of the same bill.
          const named2 = via === 'left' || via === 'above' || via === 'left+right';
          const partial = named2 && PARTIAL_LABEL.test(labelBase) && clauseOk();
          const whenSaid = LATER_WHEN.some(x => (' ' + shape(clause) + ' ').includes(' ' + x + ' '));
          const later = !named2 ? undefined : LATER_TOTAL.test(labelBase) && clauseOk() ? 'total'
            : LATER_BALANCE.test(labelBase) && clauseOk([...LATER_VERB, ...LATER_WHEN]) && (!/\b(?:due|owing)\b/.test(labelBase) || whenSaid) ? 'balance' : undefined;
          // "Reward(s)" are a wallet balance unless the line says they were taken off ("Rewards applied", "-$5.00").
          const weakCut = !!role.cut && words(labelRaw).some(x => x === 'reward' || x === 'rewards'), marked = [...words(labelRaw), ...words(clause)].some(x => /^(?:applied|redeemed|used|off)$/.test(x));
          // F-E2: a part whose label or clause says the money is charged, billed, debited, withdrawn or taken from a card or account.
          const tailWords = words(pieces[0] ?? '').filter(x => !LABEL_TAIL.has(x));
          const moveish = [...words(labelOrig), ...tailWords, ...words(otherSentences)].some(x => MOVE.test(x) || CHARGE_LEAD.test(x));
          const entry = { weakCut, marked, value: mark || spelled ? Infinity : parse(raw), cur, role, role0, mark, text, period, approx, paren, labelRaw, labelOrig, at: i + ':' + m.index, chosen: chosenLine[i], outside: outsideLine[i], minus, partial, later, coverNote, insNote, moveish };
          found.push(entry); previous = entry;
          // "Total after $2.00 discount: $500.00": a qualifier figure does not end the label of the figure that follows.
          if (!(via === 'left' && QUAL.has(ls.at(-1)))) start = m.index + m[0].length;
        });
      });
      return found;
    };
    let cuts;
    const reconciled = (f, tender = false) => {
      // A discount line closes a gap when it has a minus sign or sits in the order summary; a savings figure in a banner, header or sidebar
      // does not, and neither does one whose label is not a closed phrase (F-A).
      cuts ??= analyze(strictLines() ?? []).filter(x => x.role.cut && !x.mark && Number.isFinite(x.value) && (x.minus || !x.outside) && (!x.weakCut || x.minus || x.marked));
      // One discount line can close the gap, or all the discount lines below the figure together (insurance: premium, multi-policy discount, safe driver discount).
      const lines = cuts.filter(d => d.text !== f.text && (!tender || d.role.tender));
      return lines.some(d => f.value - d.value <= A + eps) || f.value - lines.filter(d => d.value <= f.value + eps).reduce((sum, d) => sum + d.value, 0) <= A + eps;
    };
    const figures = analyze(lines);
    const reference = /^[A-Za-z]{3}$/.test(pageCurrency ?? '') ? pageCurrency.toUpperCase() : figures.find(f => !f.mark && f.cur && Math.abs(f.value - A) < eps)?.cur;
    // F-B: a chosen control's figure is an add-on the user will pay, whatever its label says: one larger than the amount asks, and
    // chosen figures (other than the amount itself) that together exceed the amount ask unless a discount line brings them down.
    const picked = figures.filter(f => f.chosen && !f.coverNote && !f.mark && !f.minus && Number.isFinite(f.value) && f.role.kind !== 'unit');
    if (picked.some(f => f.value > A + eps)) return true;
    const sumOf = (list, skipAmount) => { const seen = new Set(); let sum = 0; for (const f of list) { const k = f.at; if (seen.has(k) || skipAmount && Math.abs(f.value - A) < eps) continue; seen.add(k); sum += f.value; } return sum; };
    const pickedSum = sumOf(picked, true);
    if (pickedSum > A + eps && !reconciled({ value: pickedSum, text: '' })) return true;
    // F-D: fee-type parts ("Booking payment" + "Security payment") are added up and the sum is checked against the amount.
    const chargeSum = sumOf(figures.filter(f => f.role.chargePart && !f.mark && Number.isFinite(f.value)), false);
    if (chargeSum > A + eps && !reconciled({ value: chargeSum, text: '' })) return true;
    const partialNow = figures.some(g => g.partial && !g.mark && Math.abs(g.value - A) < eps);
    const laterTotal = partialNow ? Math.max(0, ...figures.filter(g => g.later === 'total' && !g.mark && Number.isFinite(g.value)).map(g => g.value)) : 0;
    return figures.some(f => {
      const kind = f.role.kind;
      if (f.mark) return !(kind === 'exempt' || kind === 'part' && f.role.unknown);
      // F-E: the page says what is due now (a deposit or installment equal to the amount); its items, total and balance are the bill, not this charge.
      if (partialNow && Number.isFinite(f.value) && (f.later || kind === 'part' && !f.moveish && laterTotal && f.value <= laterTotal + eps) && same(f.cur, reference)) return false;
      if (kind !== 'exempt' && !same(f.cur, reference)) {
        // An estimate note clears a euro or pound figure, not another kind of dollar: "$24.50 CAD" beside "$18.00 USD" is easy to read as the charge.
        const dollars = x => GENERIC['$'].includes(x), confusable = dollars(f.cur) && dollars(reference);
        // A conversion of the amount is within a factor of five of it either way; a figure far from that is not an estimate of this charge.
        const near = f.value >= A / 5 - eps && f.value <= A * 5 + eps;
        return confusable || !near || !(f.approx || f.paren && !f.paren.mark && Math.abs(f.paren.value - A) < eps && same(f.paren.cur, reference));
      }
      if (Math.abs(f.value - A) < eps) return false;
      // A coverage limit or deductible is a note only beside a row that names the insurance, premium or policy.
      if (f.insNote && !figures.some(g => g !== f && !g.mark && !g.insNote && /\b(?:insurance|premium|policy)\b/i.test(g.labelOrig))) return f.value > A + eps && !reconciled({ ...f, role: { kind: 'part' } });
      // A yearly price beside the monthly one that is the charge ("$18.00/month", "$180.00/year") is the other plan, not this charge.
      if (kind === 'unit') return f.value > A + eps && !(f.period === 'year' && f.value <= 12 * A + eps && figures.some(g => g.period === 'month' && Math.abs(g.value - A) < eps));
      if (kind === 'part') return f.value > A + eps && !reconciled(f);
      // "Order total $28.00" or "Invoice total $60.00" above a gift card, store credit, voucher or a payment already received that brings it down to the amount.
      if (kind === 'pay' && f.role.gross) return f.value > A + eps ? !reconciled(f, true) : true;
      return kind !== 'exempt';
    });
  };
  const field = key => {
    if (!root) return;
    const values = [], hidden = [];
    const valueOf = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').replace(new RegExp('^' + key + ':\\s*', 'i'), '') : '';
    for (const node of read(root, 'querySelectorAll')('[data-payment-' + key + '],[itemprop="' + key + '"],[name="' + key + '"],[aria-label="' + key + '" i]')) {
      const attribute = read(node, 'getAttribute')('data-payment-' + key);
      if (!visible(node)) {
        // Hidden candidates can contradict evidence, never supply authority.
        hidden.push(valueOf(attribute), valueOf(['input','select','textarea'].includes(read(node, 'localName')) ? read(node, 'value') : read(node, 'textContent')));
        continue;
      }
      const value = ['input', 'select', 'textarea'].includes(read(node, 'localName')) ? read(node, 'value') : visibleText(node);
      if (key === 'amount' && !summaryRoot) summaryRoot = summaryOf(node);
      const shown = valueOf(value);
      if (attribute !== null && attribute.trim() !== shown) return;
      if (shown) values.push(shown);
    }
    if (!values.length) {
      const label = new RegExp('^' + key + ':\\s*(.+)$', 'i');
      for (const line of visibleText(root).split('\n')) { const match = label.exec(line.trim()); if (match) values.push(match[1].trim()); }
    }
    if (key === 'amount' && values.length === 1) {
      // Anything rendered that shows a different payable figure (LOOSE) leaves the terms ambiguous.
      const lines = looseLines(); if (!lines || conflicts(lines, () => visibleText(root, true).split('\n'), values[0], field('currency'))) return;
    }
    return values.length === 1 && values[0].length <= 4096 && !hidden.some(value => value && value !== values[0]) ? values[0] : undefined;
  };
  const page = Object.fromEntries(['item', 'amount', 'payee', 'currency'].map(key => [key, field(key)]).filter(([,value]) => value !== undefined));
  const labels = read(el, 'labels') ? [...read(el, 'labels')].map(label => read(label, 'innerText').trim()).filter(Boolean) : [];
  const name = read(el, 'getAttribute')('aria-label') || (labels.length === 1 ? labels[0] : '');
  return { origin: read(view, 'location').origin, page, name };
}

function dialogTerms(message) {
  // Dialog text must independently name all page terms. An amount-only dialog
  // is insufficient evidence for the initiating item/payee and asks/refuses.
  const match = /^Pay\s+(\{[^\n]*\})\??$/i.exec(message ?? '');
  try {
    const value = match && JSON.parse(match[1]);
    if (!value || Object.keys(value).some(key => !['item', 'amount', 'payee', 'currency'].includes(key)) ||
        !['item', 'amount', 'payee'].every(key => text(value[key]))) return;
    return value;
  } catch { return; }
}

export function createV3Context({ binding, browser, ui, confirmPayments, now = Date.now } = {}) {
  const bound = bindings.get(binding);
  if (!bound || !text(browser)) throw Error('TRUSTED_TURN_REQUIRED');
  const requested = requestedPayment(bound.message.text), documents = new Map(), targets = new WeakMap(), held = new Set();
  const watched = new Map();
  const uploads = new WeakMap(), offered = new Map(), tickets = new Map(), pending = new Map();
  let closed = false, live, sequence = 0, dialogOwner;
  const current = () => { try { return !closed && bound.current() === true; } catch { return false; } };
  const fileProvider = createUserFileProvider({ now,
    readUserMessage: event => current() && event === binding ? { session: bound.message.session, text: bound.message.text } : undefined,
    resolveInput: ref => current() ? offered.get(ref) : undefined,
    current: () => current() ? live : undefined });
  // checkCurrent compares private data, never caller object identity or a page's
  // approval flag. The consumed ticket still binds every native operation field.
  let consuming;
  const native = ui && createConsentUi({ now, authenticate: event => current() && ui.authenticate(event) === true,
    checkCurrent: operation => current() && consuming === canonical(operation),
    present(view, operation) {
      const key = canonical(operation), record = pending.get(key);
      ui.present(view.id, { view, operation }, view.choices, event => {
        try { const ticket = native.respond(event); if (ticket && current() && pending.get(key) === record) tickets.set(key, ticket);
          else pending.delete(key); }
        catch { pending.delete(key); }
      });
    } });
  const files = Object.freeze({ check(paths, target) {
    try {
      const record = targets.get(target);
      if (!current() || !record || !text(record.name)) return false;
      const input = { ...record.identity, ref: target.ref, name: record.name };
      live = record.identity; offered.set(target.ref, input);
      const handle = fileProvider.offer(binding, paths, target.ref);
      uploads.set(target, { handle, paths: [...paths], record }); return true;
    } catch { return false; }
  } });
  let ruleTarget;
  const consent = Object.freeze({ consume(terms, target) {
    const record = targets.get(target) ?? dialogOwner;
    if (!record || !native || !['item','amount','payee','method'].every(key => text(terms[key]))) return false;
    const action = { type: 'fill', press: 'key', submit: 'click', check: 'click', uncheck: 'click' }[target.do] ?? target.do ?? 'click';
    const base = { ...record.identity, action, args: { ref: target.ref ?? record.ref ?? 'focused', key: target.key ?? null, accept: target.accept ?? null },
      destination: record.origin + '/', payment: { ...terms } };
    const keyBase = canonical(base);
    for (const [key, value] of pending) if (now() >= value.expires) { pending.delete(key); tickets.delete(key); }
    let entry = [...pending.values()].find(value => value.keyBase === keyBase);
    if (!entry) {
      if (pending.size >= 32) return false;
      const operation = { ...base, sequence: ++sequence }; entry = { operation, keyBase, expires: now() + 30000 };
      const key = canonical(operation); pending.set(key, entry);
      try { native.request(operation); } catch { pending.delete(key); }
      return false;
    }
    const key = canonical(entry.operation), ticket = tickets.get(key); tickets.delete(key);
    if (!ticket) return false;
    pending.delete(key); consuming = key;
    try { native.consume(ticket, entry.operation); return true; } catch { return false; }
    finally { consuming = undefined; }
  } });
  const ruleContext = { now, dialogContinuation: target => dialogOwner?.dialog === target.state?.dialog &&
      !!dialogOwner?.dialog && dialogOwner.doc.valid,
    session: bound.message.session, turn: bound.message.turn, userMessage: () => {
    if (!current()) return;
    const page = ruleTarget?.terms?.page;
    const observed = page && { ...page, method: requested?.method };
    // TS1 exactTerms equality: the whole observed terms object must match the
    // authenticated request, including optional currency. No provider echo.
    return { ...bound.message, ...(requested && observed && equal(observed, requested) ? { payment: requested } : {}) };
  }, consent, files, confirmPayments };
  async function prepare(target) {
    if (!current() || !target.locator || !target.state) throw Error('TRUSTED_TARGET_REQUIRED');
    const old = targets.get(target);
    const handle = old?.handle ?? (typeof target.locator.elementHandle === 'function' ? await target.locator.elementHandle({ timeout: 1000 }) : target.locator);
    if (!handle) throw Error('TRUSTED_TARGET_REQUIRED');
    held.add(handle);
    try {
      const frame = await handle.ownerFrame();
      if (!frame || !current() || old && (!old.doc.valid || !await trustedRead(handle, samePageDocument, old.doc.handle))) throw Error('TRUSTED_TARGET_REQUIRED');
      let doc = documents.get(frame);
      if (!doc || !doc.valid || !await trustedRead(handle, samePageDocument, doc.handle)) {
        const documentHandle = await trustedHandle(handle, ownDocument);
        doc = { valid: true, handle: documentHandle, id: 'd' + randomUUID().replaceAll('-', '') }; documents.set(frame, doc); held.add(documentHandle);
      }
      if (typeof target.page?.on === 'function' && !watched.has(target.page)) {
        const revokeDialog = () => { dialogOwner = undefined; expirePaymentDialog(ruleContext); };
        const navigate = frame => {
          const document = documents.get(frame); if (document) document.valid = false;
          if (dialogOwner?.page === target.page) revokeDialog();
        };
        const dialog = value => {
          if (!dialogOwner?.active || dialogOwner.page !== target.page || !dialogOwner.doc.valid || dialogOwner.dialog) {
            revokeDialog(); return;
          }
          dialogOwner.dialog = value;
        };
        // The pinned Playwright emits dialogclosed even for a user/browser
        // answer outside our action runner. A stale state pointer grants nothing.
        const dialogclosed = value => { if (dialogOwner?.dialog === value) revokeDialog(); };
        const close = () => { if (dialogOwner?.page === target.page) revokeDialog(); };
        const handlers = { framenavigated: navigate, dialog, dialogclosed, close };
        for (const [event, handler] of Object.entries(handlers)) target.page.on(event, handler);
        watched.set(target.page, handlers);
      }
      if (target.do === 'press' && !await trustedRead(handle, focusCheckedNode, true)) throw Error('CHECKED_FOCUS_REQUIRED');
      const observed = await trustedRead(handle, readPaymentPage);
      const parsed = new URL(frame.url());
      if (!['http:', 'https:'].includes(parsed.protocol) || observed.origin !== parsed.origin || !current()) throw Error('TRUSTED_TARGET_REQUIRED');
      const identity = { browserIncarnation: browser, brokerEpoch: 1, clientSession: bound.message.session, turn: bound.message.turn,
        leaseGeneration: 1, target: doc.id, frame: doc.id, document: doc.id, origin: observed.origin };
      const record = { handle, doc, frame, page: target.page, identity, origin: observed.origin, name: observed.name, ref: target.ref };
      targets.set(target, record); live = identity;
      // Last inspection is on the exact pinned element, after all page terms.
      const element = await trustedRead(handle, inspectElement);
      if (!current()) throw Error('TRUSTED_TARGET_REQUIRED');
      Object.assign(target, { session: bound.message.session, turn: bound.message.turn, document: doc.id, origin: observed.origin,
        element, prior: target.prior ?? target.element, locator: handle, terms: { page: observed.page, method: requested?.method },
        submit: intent(target.do ?? 'click', { ...target, element }).submit });
      return record;
    } catch (error) { held.delete(handle); await handle.dispose().catch(() => {}); throw error; }
  }
  const ctx = Object.freeze({ session: bound.message.session, turn: bound.message.turn, userMessage: ruleContext.userMessage,
    consent, files, prepareTarget: prepare, paymentTerms: target => targets.get(target) ? target.terms : undefined,
    async check(kind, target, { fieldOnly = false } = {}) {
      try {
        if (!current()) return refused();
        target.do = kind;
        if (kind !== 'dialog') { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
        if (kind === 'dialog') {
          if (target.accept === false) { dialogOwner = undefined; expirePaymentDialog(ruleContext); return { verdict: 'allow' }; }
          if (!dialogOwner?.dialog || target.state?.dialog !== dialogOwner.dialog || !dialogOwner.doc.valid || !current()) return refused();
          if (target.page && dialogOwner.page !== target.page) return refused();
          if (new URL(dialogOwner.frame.url()).origin !== dialogOwner.origin) return refused();
          const page = dialogTerms(target.message), record = dialogOwner;
          Object.assign(target, { session: bound.message.session, turn: bound.message.turn, document: record.doc.id, origin: record.origin,
            terms: { page, method: requested?.method }, element: { payment: !!page || /\bpay|payment|buy|purchase|charge\b/i.test(target.message ?? '') } });
          targets.set(target, record);
        } else if (target.locator) await prepare(target);
        else if (!['wait','back','forward','reload','viewport'].includes(kind)) return refused();
        else Object.assign(target, { session: bound.message.session, turn: bound.message.turn });
        if (fieldOnly && intent(kind, target).submit) return refused();
        ruleTarget = target;
        const result = check(ruleContext, kind, target);
        if (result.verdict === 'allow' && ['click', 'press', 'submit'].includes(kind))
          dialogOwner = { ...targets.get(target), target, active: false };
        if (kind === 'dialog' && result.verdict === 'allow') { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
        return result;
      } catch { return refused(); }
      finally { ruleTarget = undefined; }
    },
    // The action settled with no visible effect: its payment activation goes back to the request's budget at the next payment
    // check, if the control is on the closed name list and the network stayed quiet until then (deferRefund).
    refund(target, activity) {
      if (!current() || dialogOwner?.target !== target || !deferRefund(ruleContext, target, activity)) return false;
      dialogOwner = undefined; expirePaymentDialog(ruleContext); return true;
    },
    beginInput(target) { if (dialogOwner?.target === target && current()) dialogOwner.active = true; },
    finishInput(target) {
      if (dialogOwner?.target !== target) return;
      dialogOwner.active = false;
      if (!dialogOwner.dialog) { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
    },
    async pressTarget(target, key, options) {
      const record = targets.get(target);
      if (!current() || !record?.doc.valid || !await trustedRead(record.handle, samePageDocument, record.doc.handle) ||
          !await trustedRead(record.handle, focusCheckedNode, false) || !current()) throw Error('CHECKED_FOCUS_REQUIRED');
      // ElementHandle.press focuses again without verifying its recipient.
      // Use only the owned page keyboard after the checked ref retained focus.
      return target.page.keyboard.press(key, options);
    },
    async stageUploads(target, paths) {
      const entry = uploads.get(target); uploads.delete(target);
      if (!entry || !current() || !entry.record.doc.valid || !equal(paths, entry.paths) || !await trustedRead(entry.record.handle, samePageDocument, entry.record.doc.handle))
        throw Error('USER_NAMED_FILE_REQUIRED');
      const observed = await trustedRead(entry.record.handle, readPaymentPage);
      if (observed.origin !== entry.record.origin || observed.name !== entry.record.name || !current()) throw Error('USER_NAMED_FILE_REQUIRED');
      live = entry.record.identity;
      const bindingData = { ...entry.record.identity, ref: target.ref, operation: 'upload' };
      return stageUserUploads({ event: binding, binding: bindingData, provider: {
        offer(event, exactPaths, ref) {
          if (event !== binding || ref !== target.ref || !equal(exactPaths, entry.paths)) throw Error('USER_NAMED_FILE_REQUIRED');
          return entry.handle;
        }, stage: fileProvider.stage,
      } }, paths, target.ref);
    },
    async dragTo(target, destination) {
      const source = targets.get(target);
      if (!source || !current() || !source.doc.valid) throw Error('TRUSTED_TARGET_REQUIRED');
      const endpoint = { page: target.page, locator: destination, ref: target.ref, state: target.state, do: 'drag' };
      let down = false;
      try {
        const verdict = await ctx.check('drag', endpoint);
        if (verdict.verdict !== 'allow') throw Error('TRUSTED_TARGET_REQUIRED');
        const end = targets.get(endpoint);
        if (end.frame !== source.frame || end.doc !== source.doc) throw Error('TRUSTED_TARGET_REQUIRED');
        // ElementHandle has no dragTo. Its hover uses Playwright actionability
        // on the pinned node, and the mouse belongs only to this owned page.
        await end.handle.hover({ timeout: 1000 }); await source.handle.hover({ timeout: 1000 });
        if (!current() || !source.doc.valid) throw Error('TRUSTED_TARGET_REQUIRED');
        await target.page.mouse.down(); down = true;
        await end.handle.hover({ timeout: 1000 }); await end.handle.hover({ timeout: 1000 });
      } finally {
        if (down) await target.page.mouse.up();
        await ctx.releaseTarget(endpoint);
      }
    },
    async releaseTarget(target) {
      const handle = targets.get(target)?.handle;
      if (handle && held.delete(handle)) await handle.dispose().catch(() => {});
    },
    async dispose() {
      closed = true; native?.revoke(); endDeferredRefund(ruleContext);
      for (const [page, handlers] of watched) for (const [event, handler] of Object.entries(handlers)) page.off(event, handler);
      watched.clear(); tickets.clear(); pending.clear(); offered.clear();
      const receipt = fileProvider.dispose();
      await Promise.allSettled([...held].map(handle => handle.dispose?.())); held.clear(); documents.clear();
      return receipt;
    },
  });
  contexts.add(ctx); return ctx;
}
