import { randomUUID } from 'node:crypto';
import { trustedRead, trustedHandle } from './trusted-dom.mjs';
import { canonical } from './authority.mjs';
import { check, inspectElement, intent, expirePaymentDialog, deferRefund } from './rules.mjs';
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
  const visibleText = node => {
    const walker = read(doc, 'createTreeWalker')(node, 5), parts = []; let part, previous;
    while ((part = walker.nextNode())) if (read(part, 'nodeType') === 1) {
      if (read(part, 'localName') === 'br') { parts.push('\n'); previous = undefined; }
    } else if (read(part, 'parentElement')) {
      const range = read(doc, 'createRange')(); range.selectNodeContents(part);
      if (!read(part, 'textContent').trim() || !visible(read(part, 'parentElement'), range.getClientRects())) continue;
      let block = read(part, 'parentElement');
      while (block !== node && /^(?:inline(?:-.*)?|contents)$/.test(gs(block).display)) block = read(block, 'parentElement');
      if (parts.length) parts.push(previous === block ? ' ' : '\n');
      parts.push(read(part, 'textContent').trim()); previous = block;
    }
    return parts.join('');
  };
  // LOOSE: every rendered string under the form (offscreen, faint, ::before/::after, input values, open shadow roots, same-origin frames)
  // plus the activating control's own label. An image or canvas outside a control is a mark (￼) where a figure we cannot read may sit.
  // Known limits: a figure drawn as a CSS background image, or held in a closed shadow root with no text, is not seen.
  const looseLines = () => {
    const parts = []; let previous, count = 0;
    const push = (text, owner) => {
      let t = String(text ?? '').normalize('NFKC').replace(/[­​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim(); if (!t) return;
      // A struck-out price is the old price ("was").
      for (let a = owner; a; a = up(a)) if (['del', 's', 'strike'].includes(read(a, 'localName')) || /line-through/.test(gs(a).textDecorationLine ?? '')) { t = 'was ' + t; break; }
      let block = owner; while (block && /^(?:inline(?:-.*)?|contents)$/.test(gs(block).display)) block = up(block);
      if (parts.length) parts.push(previous === block ? ' ' : '\n');
      parts.push(t); previous = block;
    };
    const pseudo = (n, which) => { const c = gs(n, which)?.content; if (/counters?\(/.test(c ?? '')) throw Error('counter content'); if (c && c !== 'none' && c !== 'normal') push(c.replace(/^["']|["']$/g, ''), n); };
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
    const walk = (n, inControl = false) => {
      if (++count > 20000) throw Error('too many nodes');
      if (alternative(n)) return;
      const on = shown(n), tag = read(n, 'localName');
      inControl ||= controlled(n);
      if (on && media.includes(tag)) {
        const b = read(n, 'getBoundingClientRect')();
        // A banner-sized image or canvas can show a total we can't read; a smaller one outside a control is a mark: it may hold a figure.
        if (b.width >= 100 && b.height >= 16) throw Error('unreadable content');
        const alt = read(n, 'getAttribute')('alt');
        if (alt) push(alt, n); else if (!inControl && b.width >= (tag === 'svg' ? 50 : 24) && b.height >= (tag === 'svg' ? 12 : 8) && !(tag === 'svg' && (read(n, 'textContent') ?? '').trim())) push('￼', n);
      }
      if (on) {
        pseudo(n, '::before');
        if (tag === 'input') { if (!/^(?:hidden|password|checkbox|radio|file)$/.test(read(n, 'type'))) push(read(n, 'value'), n); }
        else if (tag === 'textarea') push(read(n, 'value'), n);
        else if (tag === 'select') for (const o of Array.from(read(n, 'selectedOptions') ?? [])) push(read(o, 'textContent'), n);
      }
      if (['select', 'textarea', 'input'].includes(tag)) { if (on) pseudo(n, '::after'); return; }
      const shadow = read(n, 'shadowRoot'); if (shadow) for (const c of Array.from(read(shadow, 'childNodes') ?? [])) if (read(c, 'nodeType') === 1) walk(c, inControl);
      if (tag === 'iframe') { try { const body = read(read(n, 'contentDocument'), 'body'); if (body) walk(body, inControl); } catch { /* cross-origin */ } }
      for (const c of Array.from(read(n, 'childNodes') ?? [])) {
        if (read(c, 'nodeType') === 1) walk(c, inControl); else if (read(c, 'nodeType') === 3 && on) push(read(c, 'textContent'), n);
      }
      if (on) pseudo(n, '::after');
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
    const UNIT = set('per each ea unit units apiece × x payments installment installments instalment instalments monthly weekly daily yearly annually quarterly month months mo week weeks wk year yr day days');
    const PART = set('sub subtotal tax taxes vat gst hst fee fees shipping delivery handling freight postage tip tips gratuity surcharge duty duties levy item items service processing packaging insurance deposit installation before excl excluding excludes pretax without incl includes including inc plus less minus after with');
    const CUT = set('discount discounts savings saving save saved coupon promo rebate off applied redeemed');
    const EXEMPT = set('discount discounts savings saving save saved coupon promo rebate off applied redeemed available limit minimum maximum min max over above away points point pts reward rewards was original orig regular reg list msrp compare retail threshold earn earned cashback refund refunded');
    // balance, value, worth and credit are also names of a real charge ("Balance due", "Order value", "Credit card"): they clear a
    // figure only beside a word that makes them a store of money ("available balance", "gift card balance", "points value").
    const WEAK = set('balance value valued worth credit credits');
    const WEAK_WITH = set('available remaining gift points point pts reward rewards store loyalty member');
    // Not a charge unless it happens: "from", "up to", "starting at", "if", a late or cancellation fee.
    const NOTE_NOUN = set('code codes amount amounts offer offers deal deals line lines item items today so far applied used');
    const CHARGED = set('pay paying payable payment charge charged charges billed billing owe owed due invoice');
    const COND = set('from up upto starting if unless when');
    const COND_AFTER = set('if unless when applies applicable');
    const LATE = set('late cancellation cancelation penalty overdue noshow');
    const STRONG_PAY = /\b(?:total|amount|due|pay|paying|payable|payment|charged?|charges|billed|billing|owe|owed|invoice)\b/i;
    const RECOMMEND = /^(?:you (?:may|might) (?:also )?like|recommended(?: for you)?|customers (?:also )?(?:bought|viewed|like)|people also (?:bought|viewed)|related (?:items|products)|similar (?:items|products)|frequently bought together|more from|trending(?: now)?|complete the look)\b/i;
    const FILL = set('of is are will be only now today just about approx approximately currently a an the in on at for to your you re our we my this that it its s then also final full overall est estimated usd eur gbp cad aud');
    const CONNECT = set('or and to');
    const QUAL = set('incl includes including inc plus less minus after with before excl excluding excludes without');
    const COUNTED = /^(?:items?|pcs|pieces?|units?|qty|x|×|days?|hours?|mins?|minutes?|years?|months?|weeks?|payments?|installments?|points?|pts|interest|percent|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|st|nd|rd|th)$/i;
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
    // The role of a label, read from its significant words (the nearest word decides).
    const classify = list => {
      const w = list.at(-1), hasPay = list.some(x => PAY.has(x)), strong = list.some(x => PAY.has(x) && x !== 'price' && x !== 'cost');
      const stores = list.some(x => WEAK_WITH.has(x));
      const exempt = x => EXEMPT.has(x) || WEAK.has(x) && stores;
      const phrase = list.join(' '), cutPhrase = /\b(?:gift ?cards?|gift certificates?|store credits?|vouchers?)\b/.test(phrase);
      if (UNIT.has(w)) return { kind: 'unit' };
      if (COND.has(w) || list.some(x => LATE.has(x))) return { kind: strong ? 'part' : 'exempt' };
      if (PAY.has(w)) { const p = list.at(-2); return PART.has(p) || exempt(p) ? { kind: 'part', cut: CUT.has(p) } : { kind: 'pay' }; }
      if (cutPhrase) return { kind: hasPay ? 'part' : 'exempt', cut: true };
      if (PART.has(w)) return { kind: 'part' };
      if (exempt(w)) return { kind: hasPay ? 'part' : 'exempt', cut: CUT.has(w) };
      // An exempt word ahead of an ordinary noun still clears the figure ('coupon code', 'savings amount'), but not a product name ('savings plan').
      if (!hasPay && list.some(exempt) && !list.slice(list.findIndex(exempt) + 1).some(x => !NOTE_NOUN.has(x))) return { kind: 'exempt' };
      return { kind: 'part', unknown: true };
    };
    const analyze = rawLines => {
      const list = rawLines.map(norm).map(t => RECOMMEND.test(t) && !STRONG_PAY.test(t) ? '' : t), found = [];
      const hasFigure = list.map(t => [...t.matchAll(figure)].some(m => m[10] === undefined));
      // The nearest line with words above a lone figure labels it. A note line that only holds an exempt word ("incl. savings",
      // "with points") is walked past to the pay or part label above it, as long as no other figure sits between; with no such
      // label the note decides.
      const labelAbove = i => {
        let note;
        for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
          if (hasFigure[j] && note) break;
          if (!/\p{L}/u.test(list[j]) || hasFigure[j]) continue;
          const s = sig(before(list[j])); if (!s.length) continue;
          const role = { ...classify(s), adjacent: j === i - 1 };
          if (role.kind !== 'exempt') return note && role.unknown ? note : role;
          note ??= role;
        }
        return note;
      };
      list.forEach((text, i) => {
        const all = [...text.matchAll(figure)];
        const alone = !/\p{L}/u.test(text.replace(figure, ' '));
        let start = 0, previous;
        all.forEach((m, k) => {
          const bare = m[10] !== undefined, mark = m[11] !== undefined, spelled = m[12] !== undefined;
          const raw = m[3] ?? m[6] ?? m[7] ?? m[9] ?? m[10];
          const next = all[k + 1], seg = text.slice(start, m.index), tail = text.slice(m.index + m[0].length, next?.index ?? text.length);
          const lw = words(before(seg)), ls = lw.filter(w => !FILL.has(w)), rs = sig(after(tail)), r0 = rs[0];
          const rp = rs.slice(0, 4).some(x => PAY.has(x));
          const period = rs.slice(0, 3).some(x => /^(?:month|months|monthly|mo)$/.test(x)) ? 'month' : rs.slice(0, 3).some(x => /^(?:year|years|yearly|annual|annually|yr)$/.test(x)) ? 'year' : undefined;
          let role, via = 'none';
          if (previous && !ls.length && lw.every(w => CONNECT.has(w))) { role = previous.role; via = 'inherit'; }
          else if (ls.length) {
            role = classify(ls); via = 'left';
            if (role.unknown && r0 && PAY.has(r0)) { role = { kind: 'pay' }; via = 'left+right'; }
            else if (role.unknown && rp && !UNIT.has(r0)) { role = { kind: 'pay' }; via = 'left+right'; }
            else if (role.unknown && r0 && (EXEMPT.has(r0) || COND_AFTER.has(r0))) role = { kind: 'exempt' };
          } else if (r0) {
            if (PAY.has(r0)) role = { kind: 'pay' }; else if (EXEMPT.has(r0)) role = { kind: rp ? 'part' : 'exempt', cut: CUT.has(r0) };
            else if (COND_AFTER.has(r0)) role = { kind: 'exempt' };
            else if (PART.has(r0) || UNIT.has(r0)) role = classify([r0]);
            else if (rp) role = { kind: 'pay' };
            via = 'right';
          }
          // An exempt label does not clear a figure that the clause after it calls a charge ("Reward: $500.00 charged now").
          if (via === 'left' && role?.kind === 'exempt' && rs.slice(0, 3).some(x => CHARGED.has(x))) role = { kind: 'part', cut: role.cut };
          if (!role && alone && !mark) { role = labelAbove(i); via = 'above'; if (role && role.kind === 'exempt' && !role.adjacent) role = { ...role, kind: 'part' }; }
          if (r0 && UNIT.has(r0) && role && role.kind !== 'exempt') role = { kind: 'unit' };
          role ??= { kind: 'none' };
          // A bare number counts only straight after a pay word ("Total 500", "Total: 500"), and not as a count or a date.
          if (bare && (via !== 'left' || role.kind !== 'pay' || COUNTED.test(words(after(tail))[0] ?? '') || /^\s*%/.test(tail))) return;
          const suffix = m[8] ?? m[13], code = m[1] ?? m[4] ?? m[5] ?? (suffix && /^[A-Za-z]{3}$/.test(suffix) ? suffix : undefined);
          const sign = m[2] ?? (suffix && !/^[A-Za-z]{3}$/.test(suffix) ? suffix : undefined);
          const cur = code ? code.toUpperCase() : sign ? SYMBOL[sign] ?? SYMBOL[sign.toUpperCase()] ?? SYMBOL[sign.toLowerCase()] : undefined;
          const entry = { value: mark || spelled ? Infinity : parse(raw), cur, role, mark, text, period };
          found.push(entry); previous = entry;
          // "Total after $2.00 discount: $500.00": a qualifier figure does not end the label of the figure that follows.
          if (!(via === 'left' && QUAL.has(ls.at(-1)))) start = m.index + m[0].length;
        });
      });
      return found;
    };
    let cuts;
    const reconciled = f => {
      cuts ??= analyze(strictLines() ?? []).filter(x => x.role.cut && !x.mark && Number.isFinite(x.value));
      return cuts.some(d => d.text !== f.text && f.value - d.value <= A + eps);
    };
    const figures = analyze(lines);
    const reference = /^[A-Za-z]{3}$/.test(pageCurrency ?? '') ? pageCurrency.toUpperCase() : figures.find(f => !f.mark && f.cur && Math.abs(f.value - A) < eps)?.cur;
    return figures.some(f => {
      const kind = f.role.kind;
      if (f.mark) return !(kind === 'exempt' || kind === 'part' && f.role.unknown);
      if (kind !== 'exempt' && !same(f.cur, reference)) return true;
      if (Math.abs(f.value - A) < eps) return false;
      // A yearly price beside the monthly one that is the charge ("$18.00/month", "$180.00/year") is the other plan, not this charge.
      if (kind === 'unit') return f.value > A + eps && !(f.period === 'year' && f.value <= 12 * A + eps && figures.some(g => g.period === 'month' && Math.abs(g.value - A) < eps));
      if (kind === 'part') return f.value > A + eps && !reconciled(f);
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
      const lines = looseLines(); if (!lines || conflicts(lines, () => visibleText(root).split('\n'), values[0], field('currency'))) return;
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
      closed = true; native?.revoke();
      for (const [page, handlers] of watched) for (const [event, handler] of Object.entries(handlers)) page.off(event, handler);
      watched.clear(); tickets.clear(); pending.clear(); offered.clear();
      const receipt = fileProvider.dispose();
      await Promise.allSettled([...held].map(handle => handle.dispose?.())); held.clear(); documents.clear();
      return receipt;
    },
  });
  contexts.add(ctx); return ctx;
}
