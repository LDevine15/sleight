import { randomUUID } from 'node:crypto';
import { trustedRead, trustedHandle } from './trusted-dom.mjs';
import { canonical } from './authority.mjs';
import { check, inspectElement, intent, expirePaymentDialog } from './rules.mjs';
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
  // plus the activating control's own label. An image or canvas is a mark (￼) where a figure we cannot read may sit; a box that
  // shows area but holds nothing could host a closed shadow root, and what it shows cannot be read, so the read gives up.
  const looseLines = () => {
    const parts = []; let previous, count = 0;
    const push = (text, owner) => {
      const t = String(text ?? '').normalize('NFKC').replace(/[­​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim(); if (!t) return;
      let block = owner; while (block && /^(?:inline(?:-.*)?|contents)$/.test(gs(block).display)) block = up(block);
      if (parts.length) parts.push(previous === block ? ' ' : '\n');
      parts.push(t); previous = block;
    };
    const pseudo = (n, which) => { const c = gs(n, which)?.content; if (/counters?\(/.test(c ?? '')) throw Error('counter content'); if (c && c !== 'none' && c !== 'normal') push(c.replace(/^["']|["']$/g, ''), n); };
    const media = ['img', 'canvas', 'svg', 'video', 'picture', 'object', 'embed'], hollow = ['img', 'input', 'textarea', 'select', 'canvas', 'video', 'svg', 'iframe', 'object', 'embed', 'br', 'hr', 'wbr', 'meter', 'progress', 'audio', 'button', 'picture', 'source', 'track', 'area', 'col', 'base', 'link', 'meta', 'param', 'script', 'style', 'template', 'noscript', 'slot'];
    const walk = n => {
      if (++count > 20000) throw Error('too many nodes');
      const on = shown(n), tag = read(n, 'localName');
      if (on && media.includes(tag)) {
        const b = read(n, 'getBoundingClientRect')();
        // A banner-sized image or canvas can show a total we can't read; a smaller one is an unknown figure.
        if (b.width >= 100 && b.height >= 16) throw Error('unreadable content');
        const alt = read(n, 'getAttribute')('alt');
        if (alt) push(alt, n); else if (b.width >= (tag === 'svg' ? 50 : 24) && b.height >= (tag === 'svg' ? 12 : 8) && !(tag === 'svg' && (read(n, 'textContent') ?? '').trim())) push('￼', n);
      }
      if (on) {
        pseudo(n, '::before');
        if (tag === 'input') { if (!/^(?:hidden|password|checkbox|radio|file)$/.test(read(n, 'type'))) push(read(n, 'value'), n); }
        else if (tag === 'textarea') push(read(n, 'value'), n);
        else if (tag === 'select') for (const o of Array.from(read(n, 'selectedOptions') ?? [])) push(read(o, 'textContent'), n);
        else if (n !== root && !hollow.includes(tag) && !read(n, 'shadowRoot') && !read(n, 'childElementCount') && !(read(n, 'textContent') ?? '').trim()) {
          const b = read(n, 'getBoundingClientRect')(), g = ['::before', '::after'].some(which => { const c = gs(n, which)?.content; return c && c !== 'none' && c !== 'normal'; });
          if (b.width >= 24 && b.height >= 8 && !g) throw Error('empty box');
        }
      }
      if (['select', 'textarea', 'input'].includes(tag)) { if (on) pseudo(n, '::after'); return; }
      const shadow = read(n, 'shadowRoot'); if (shadow) for (const c of Array.from(read(shadow, 'childNodes') ?? [])) if (read(c, 'nodeType') === 1) walk(c);
      if (tag === 'iframe') { try { const body = read(read(n, 'contentDocument'), 'body'); if (body) walk(body); } catch { /* cross-origin */ } }
      for (const c of Array.from(read(n, 'childNodes') ?? [])) {
        if (read(c, 'nodeType') === 1) walk(c); else if (read(c, 'nodeType') === 3 && on) push(read(c, 'textContent'), n);
      }
      if (on) pseudo(n, '::after');
    };
    try { walk(root); } catch { return; }
    const tag = read(el, 'localName'), isField = ['input', 'select', 'textarea'].includes(tag);
    const own = [read(el, 'getAttribute')('aria-label'), isField ? undefined : read(el, 'textContent'), isField ? undefined : read(el, 'getAttribute')('value'),
      tag === 'input' && /^(?:submit|button|image|reset)$/.test(read(el, 'type')) ? read(el, 'value') : undefined].filter(Boolean);
    return parts.join('').split('\n').concat(own.map(t => String(t).normalize('NFKC').replace(/\s+/g, ' ').trim()));
  };
  // Does any rendered figure show a payable amount that differs from `amount`? Each figure gets a role from the words next to it:
  //   pay   the word just before it (or, for a figure first, just after it) is total/amount/due/pay/price/cost/billed: it must equal the amount.
  //   sub   a part of the total (subtotal, tax, fee, shipping, discount, "before tax"), or a compound like "tax amount": it may be smaller
  //         than the amount; a larger one needs a visible discount line at least as large as the gap, else the real total is unknown.
  //   unit  per/each/unit/payments/monthly: may be smaller than the amount, never larger.
  //   none  balances, limits, "over $50", "incl. $1.50": not a charge.
  // Only the words right at the figure decide (back to the last sentence break or colon), so a leading "Includes tax & fees." exempts nothing.
  // Label, qualifier and figure may sit on three separate lines, so up to three lines are read as one.
  const conflicts = (lines, strictLines, amount) => {
    const num = value => Number(String(value).replace(/[^\d.]/g, ''));
    const A = num(amount), eps = 0.005;
    const figure = /(?:[$€£¥]\s*|\b(?:USD|EUR|GBP|CAD|AUD)\s*)(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*\.\d{2})\b|(\d[\d,]*(?:\.\d+)?)\s*(?:USD|EUR|GBP|CAD|AUD)\b|(?<=[:=]\s*)(\d[\d,]*(?:\.\d+)?)|(￼)/gi;
    const PAY = /^(?:total|amount|due|pay|payment|payable|price|cost|charge[ds]?|charges|billed|bill|owe[ds]?)$/;
    const UNIT = /^(?:per|each|ea|unit|units|apiece|x|×|payments|installments?|monthly|weekly|daily|yearly|annually)$/;
    const PART = /^(?:sub-?\s?total|tax(?:es)?|vat|gst|hst|fees?|shipping|delivery|handling|tips?|surcharge|discounts?|savings?|saved?|coupon|promo|rebate|off|before|excl|excluding|excludes|pretax|without)$/;
    const CUT = /^(?:discounts?|savings?|saved?|coupon|promo|rebate|off)$/;
    const QUAL = /^(?:incl|includes?|including|inc|plus|less|minus|after|with|and|from|before|excl|excluding|excludes)$/;
    const FILL = /^(?:of|is|are|will|be|only|now|today|just|about|approx|approximately|currently|a|an|the|in|usd|eur|gbp|cad|aud)$/;
    const words = text => (text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*|×/g) ?? []);
    const trim = text => text.replace(/[\s:=\-–—()\[\]~≈]+$/, '');
    const role = (left, right) => {
      const lw = words(left), rw = words(right);
      let i = lw.length - 1; while (i >= 0 && FILL.test(lw[i])) i--;
      const rj = rw.findIndex(w => !FILL.test(w)), r0 = rj >= 0 ? rw[rj] : undefined;
      if (r0 && UNIT.test(r0)) return { kind: 'unit', qualifier: false };
      if (i >= 0) {
        const w = lw[i];
        if (UNIT.test(w)) return { kind: 'unit', qualifier: false };
        if (PAY.test(w)) return { kind: PART.test(lw[i - 1] ?? '') ? 'sub' : 'pay', qualifier: false };
        if (PART.test(w)) return { kind: lw.some(x => PAY.test(x)) || /^sub-?total$/.test(w) ? 'sub' : 'none', qualifier: false, cut: CUT.test(w) };
        return { kind: 'none', qualifier: QUAL.test(w) };
      }
      if (r0 && PAY.test(r0)) return { kind: rw.slice(rj + 1).some(w => PART.test(w)) ? 'sub' : 'pay', qualifier: false };
      if (r0 && CUT.test(r0)) return { kind: 'none', cut: true, qualifier: false };
      return { kind: 'none', qualifier: false };
    };
    // Every figure of one (joined) text with its role.
    const figuresOf = text => {
      const found = []; let start = 0;
      const all = [...text.matchAll(figure)];
      all.forEach((m, k) => {
        let seg = text.slice(start, m.index).replace(figure, ' ');
        seg = trim(seg); const cut = Math.max(...[...seg.matchAll(/[.;!?:|]/g)].map(x => x.index), -1); seg = seg.slice(cut + 1);
        const next = all[k + 1], tail = text.slice(m.index + m[0].length, next?.index ?? text.length);
        const rest = tail.replace(/^[\s)\]]+/, ''), hard = /[.;!?:|]/.exec(rest), right = hard ? rest.slice(0, hard.index) : rest;
        const r = role(seg, right);
        found.push({ ...r, at: m.index, value: m[5] ? Infinity : num(m[1] ?? m[2] ?? m[3] ?? m[4]) });
        if (!r.qualifier) start = m.index + m[0].length;
      });
      return found;
    };
    const joined = list => list.flatMap((line, i) => [[line], i > 0 && [list[i - 1], line], i > 1 && [list[i - 2], list[i - 1], line]].filter(Boolean).map(from => ({ text: from.join(' '), from })));
    const prepare = list => list.map(t => String(t).replace(/\b(incl|excl|inc|approx|est|ex|vs)\./gi, '$1'));
    let cuts;
    const reconciled = (value, line) => {
      cuts ??= joined(prepare(strictLines() ?? [])).flatMap(({ text, from }) => figuresOf(text).filter(f => f.cut && Number.isFinite(f.value)).map(f => ({ value: f.value, from })));
      return cuts.some(d => !d.from.includes(line) && value - d.value <= A + eps);
    };
    // The line a figure sits on: the last line that starts at or before it in the joined text.
    const ownLine = (from, at) => { let pos = 0, own = from[0]; for (const part of from) { if (pos <= at) own = part; pos += part.length + 1; } return own; };
    return joined(prepare(lines)).some(({ text, from }) => figuresOf(text).some(f => {
      if (Math.abs(f.value - A) < eps) return false;
      if (f.kind === 'pay') return true;
      if (f.kind === 'unit') return f.value > A + eps;
      if (f.kind === 'sub') return f.value > A + eps && !reconciled(f.value, ownLine(from, f.at));
      return false;
    }));
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
      const lines = looseLines(); if (!lines || conflicts(lines, () => visibleText(root).split('\n'), values[0])) return;
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
