// A drag that holds the mouse down and moves in steps, for what the engine's
// instant drag can't do (moving selected text). Try Accessibility text writes
// first, then window-targeted PID posting. Only unchanged text or no posting
// posting, permits the foreground path. The relay asks first (launch.mjs).
//
//   osascript -l JavaScript drag.js '<json request>'
//   { app, from: [x, y], to: [x, y], windowId?, holdMs?, steps?, settleMs? }
//
// Coordinates are relative to one identified window's top-left corner, as in
// the engine's screenshots. Ambiguous windows refuse. Prints one JSON object.

ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
// sleight's own consent host (its menu bar glove, approval and payment cards) is the binary sleight builds in its helper
// cache. Only the person's click answers it, so no local tool acts on that process (own-host.mjs).
const OWN_HOST_LINE = "That is sleight's own confirmation window; only you can answer it.";
function ownHost(app) {
  const read = fn => { try { return String(ObjC.unwrap(fn()) ?? ''); } catch (e) { return ''; } };
  return /\/Library\/Caches\/sleight\/turbo-host\//i.test(read(() => app.executableURL.path)) || /^consent-host$/i.test(read(() => app.localizedName).trim());
}

// The person at the Mac. The foreground path takes the pointer and keyboard
// focus for a few seconds, and keys typed then land in the target app: a
// space the owner typed into Claude went into TextEdit's selection mid-drag
// (2026-10-08). So it starts only after IDLE_S without any input, waits up to
// WAIT_S for that, and checks for keys typed once it has taken focus.
const IDLE_S = 2, WAIT_S = 10, PRESS_BUDGET_MS = 20000;
const sinceInput = type => $.CGEventSourceSecondsSinceLastEventType(1, type); // HID system state
function waitForIdle() {
  for (let waited = 0; ;) {
    const idle = sinceInput(0xFFFFFFFF); // any input
    if (idle >= IDLE_S) return;
    const step = Math.max(0.2, IDLE_S - idle);
    if (waited + step > WAIT_S) {
      throw new Error(`the person at the Mac kept typing or using the mouse for ${WAIT_S} s, and a foreground drag would take their pointer and keyboard focus; nothing was pressed. Tell the user, and retry when they've paused, or ask them to uncover the drop point so the drag can run in the background`);
    }
    delay(step);
    waited += step;
  }
}
const typedSince = startedAt => sinceInput(10) <= (Date.now() - startedAt) / 1000; // key down

function windows(onScreenOnly) {
  const options = onScreenOnly ? $.kCGWindowListOptionOnScreenOnly : $.kCGWindowListOptionAll;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(options | $.kCGWindowListExcludeDesktopElements, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    out.push({
      id: ObjC.unwrap(w.objectForKey('kCGWindowNumber')),
      title: ObjC.unwrap(w.objectForKey('kCGWindowName')) || '',
      owner: ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')),
      pid: ObjC.unwrap(w.objectForKey('kCGWindowOwnerPID')),
      layer: ObjC.unwrap(w.objectForKey('kCGWindowLayer')),
      bounds: ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')),
    });
  }
  return out; // front to back
}

const inside = (b, p) => p.x >= b.X && p.x < b.X + b.Width && p.y >= b.Y && p.y < b.Y + b.Height;
// Windows that are never cover: the engine's own overlay, and the ghost hand's panel (any layer), whose
// host pid the launcher sends as handPid. The panel ignores mouse events, so a drop passes through it.
let handPid = 0;
const overlay = w => /Computer Use$/.test(w.owner) || (handPid > 0 && w.pid === handPid);
const attempt = (fn, fallback) => { try { return fn(); } catch (e) { if (e?.axCode === -25204) throw e; return fallback; } };
const axFailure = (name, code) => Object.assign(new Error(`AX ${name} failed (${code})`), { axCode: Number(code) });
const at = (b, p) => ({ x: b.X + p[0], y: b.Y + p[1] });
const sameBounds = (a, b) => ['X', 'Y', 'Width', 'Height'].every(k => Math.abs(a[k] - b[k]) < 0.5);
function frame(el) {
  const p = el.position(), s = el.size();
  if (![...p, ...s].every(Number.isFinite) || s[0] <= 0 || s[1] <= 0) throw new Error('AX geometry is unavailable');
  return { X: p[0], Y: p[1], Width: s[0], Height: s[1] };
}
function clip(a, b) {
  const X = Math.max(a.X, b.X), Y = Math.max(a.Y, b.Y);
  return { X, Y, Width: Math.max(0, Math.min(a.X + a.Width, b.X + b.Width) - X), Height: Math.max(0, Math.min(a.Y + a.Height, b.Y + b.Height) - Y) };
}
// Claude reads from and to off the engine's screenshot, which is in pixels: 1312×844 for a
// 656×422-point TextEdit window on a Retina display (2026-10-08). Taken as points, they
// landed a line below the text, and 3 of Claude's first drags per run changed nothing.
// The relay passes the size of the app's latest engine screenshot; a size that doesn't
// match this window's shape is from another window and is ignored.
function screenshotScale(request, bounds, title) {
  const own = request.screenshots && Object.hasOwn(request.screenshots, title ?? '') ? request.screenshots[title ?? ''] : undefined;
  const s = own ?? request.screenshot;
  if (!Array.isArray(s) || s.length !== 2 || !s.every(n => Number.isFinite(n) && n > 0)) return null;
  const x = s[0] / bounds.Width, y = s[1] / bounds.Height;
  return Math.abs(x - y) <= 0.03 * Math.max(x, y) && x >= 0.25 && x <= 4 ? { x, y, size: s } : null;
}
const toPoints = (p, scale) => scale ? [p[0] / scale.x, p[1] / scale.y] : p;
function resolveWindow(own, request) {
  const list = () => JSON.stringify(own.map(w => ({ windowId: w.id, title: w.title, bounds: w.bounds })));
  const candidates = request.windowId === undefined
    ? own.filter(w => !Array.isArray(request.from) || inside(w.bounds, at(w.bounds, toPoints(request.from, screenshotScale(request, w.bounds, w.title)))))
    : own.filter(w => w.id === request.windowId);
  if (!candidates.length && request.windowId !== undefined) throw new Error(`windowId ${request.windowId} matches no window of this app; pass one of ${own.map(w => w.id).join(', ')} (window IDs, not indexes). Windows: ${list()}`);
  if (candidates.length !== 1) throw new Error(`drag target is ${candidates.length > 1 ? 'ambiguous; supply windowId' : 'unavailable; read the window again'}. Windows: ${list()}`);
  return candidates[0];
}

const coordinate = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const selectionEndpoint = p => p === 'the current text selection';
const lineEndpoint = p => typeof p === 'string' && /^end of line [1-9]\d*$/.test(p) && Number.isSafeInteger(Number(p.slice(12)));
const elementEndpoint = p => Number.isSafeInteger(p) && p >= 0;

function elementIdentity(line) {
  if (typeof line !== 'string') throw new Error('element number has no observed identity; read this window again');
  const roles = { AXButton: 'button', AXCheckBox: 'checkbox', AXRadioButton: 'radio button', AXImage: 'image',
    AXRow: 'row', AXCell: 'cell', AXGroup: 'group', AXTextArea: 'text entry area', AXTextField: 'text field',
    AXStaticText: 'text', AXLink: 'link', AXTable: 'table', AXOutline: 'outline', AXScrollArea: 'scroll area' };
  const role = Object.keys(roles).sort((a, b) => roles[b].length - roles[a].length)
    .find(key => line === roles[key] || line.startsWith(roles[key] + ' '));
  const body = role && line.slice(roles[role].length).trim().replace(/^(?:\([^()]*\)\s*)+/, '').replace(/^Selected, /, '');
  // Like compact-reads' sibling labels, only named attribute boundaries end a value; commas in names stay.
  const fields = 'Description|Value|Secondary Actions|ID|Help|Details|URL';
  const attribute = name => new RegExp('(?:^|, )' + name + ': (.*?)(?=, (?:' + fields + '):|$)').exec(body)?.[1];
  const title = body && body.split(new RegExp('(?:^|, )(?:' + fields + '): '))[0];
  const id = attribute('ID'), description = attribute('Description');
  if (!role || !(id || description || title)) throw new Error('element has no supported AX name or ID; use coordinates from a fresh screenshot');
  return { role, id, description, title };
}

function matchesIdentity(el, identity, role = attempt(() => el.role(), '')) {
  const { id, description, title } = identity;
  return role === identity.role &&
    (!id || attempt(() => el.attributes.byName('AXIdentifier').value(), null) === id) &&
    (!description || attempt(() => el.attributes.byName('AXDescription').value(), null) === description) &&
    (!title || attempt(() => el.name(), null) === title || attempt(() => el.attributes.byName('AXDescription').value(), null) === title);
}

function elementsForLines(win, lines) {
  const entries = Object.entries(lines).map(([number, line]) => ({ number, identity: elementIdentity(line) }));
  const started = Date.now();
  let visited = 0;
  const walk = (el, depth) => {
    if (depth >= 64 || ++visited > 5000) throw new Error('AX element scan exceeded its depth or 5000-element limit');
    if (Date.now() - started > 1500) throw new Error('AX element scan exceeded its time limit');
    const role = attempt(() => el.role(), '');
    if (role === 'AXToolbar' || /^AX(?:Close|Minimize|Zoom|FullScreen|TitleBar)/.test(attempt(() => el.subrole(), ''))) return;
    for (const entry of entries) if (matchesIdentity(el, entry.identity, role)) {
      if (entry.el) throw new Error('element identity must match exactly one named AX element in this window; ambiguous, read again');
      entry.el = el;
    }
    for (const child of attempt(() => el.uiElements(), [])) walk(child, depth + 1);
  };
  if (entries.length) walk(win, 0);
  if (entries.some(entry => !entry.el)) throw new Error('element identity must match exactly one named AX element in this window; missing, read again');
  return Object.fromEntries(entries.map(entry => [entry.number, entry]));
}

function requireAncestor(el, win, message = 'the focused text selection is outside the chosen window', contentOnly = false) {
  for (let depth = 0; depth < 64; depth++) {
    if ($.CFEqual(el.reference, win.reference)) return;
    const role = el.role();
    if (contentOnly && (role === 'AXToolbar' || /^AX(?:Close|Minimize|Zoom|FullScreen|TitleBar)/.test(attempt(() => el.subrole(), '')))) {
      throw new Error('drag element moved into window chrome outside the content; read the window again');
    }
    if (role === 'AXWindow') break;
    el = axElement(axAttribute(el.reference, 'AXParent'));
  }
  throw new Error(message);
}

// Numbers name identities from the relay's observed tree, never a fresh traversal index.
// Text points use a nonempty glyph range; a zero-length line-end range can be at (0, 0).
function semanticPoints(request, pid, win, main, knownElements, endpoint, windowText) {
  const references = [], state = [], bounds = main.bounds;
  const numbers = [...new Set((endpoint ? [request[endpoint]] : [request.from, request.to]).filter(elementEndpoint))];
  if (numbers.length) {
    const observed = request.elementWindow;
    if (!observed || observed.title !== main.title || (observed.windowId !== undefined && observed.windowId !== main.id)) {
      throw new Error('element number belongs to another or unobserved window; read this window again');
    }
  }
  const elements = knownElements || elementsForLines(win, Object.fromEntries(numbers.map(n => [n, request.elementLines?.[n]])));
  let textArea;
  const text = () => {
    if (textArea) return textArea;
    const app = $.AXUIElementCreateApplication(pid);
    if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) throw new Error('AX deadline unavailable');
    const candidates = windowText && content(win, bounds).areas.filter(a => ['AXTextArea', 'AXTextField'].includes(a.role) &&
      (windowText !== 'selection' || attempt(() => a.el.attributes.byName('AXSelectedText').value().trim(), '')));
    if (candidates && candidates.length !== 1) throw new Error('need exactly one text area with the requested selection or line in this window; read again');
    const focused = candidates ? candidates[0].el : axElement(axAttribute(app, 'AXFocusedUIElement'));
    requireAncestor(focused, win);
    if (!['AXTextArea', 'AXTextField'].includes(focused.role())) throw new Error('the current text selection is not in a text area or field');
    const area = axTextArea(pid, null, focused.reference), value = area.value(), selection = area.selection();
    const selected = focused.attributes.byName('AXSelectedText').value();
    if (typeof value !== 'string' || typeof selected !== 'string' || (windowText !== 'area' && !selected.trim()) ||
        !Number.isSafeInteger(selection.location) || !Number.isSafeInteger(selection.length) || selection.location < 0 || selection.length < (windowText === 'area' ? 0 : 1) ||
        selection.location + selection.length > value.length ||
        value.slice(selection.location, selection.location + selection.length) !== selected) throw new Error('text selection or range is unavailable or changed; read again');
    references.push(focused.reference); state.push({ value, selected, selection });
    return textArea = { area, value, selected, selection, bounds: clip(bounds, frame(focused)) };
  };
  const glyphPoint = (field, index, end) => {
    const length = String.fromCodePoint(field.value.codePointAt(index)).length;
    const r = field.area.rect(index, length);
    if (!r || !Object.values(r).every(Number.isFinite) || r.Width <= 0 || r.Height <= 0 ||
        r.X < field.bounds.X || r.Y < field.bounds.Y || r.X + r.Width > field.bounds.X + field.bounds.Width ||
        r.Y + r.Height > field.bounds.Y + field.bounds.Height) throw new Error('text glyph geometry is unavailable or outside the window');
    return { x: end ? r.X + r.Width - Math.min(1, r.Width / 4) : r.X + r.Width / 2, y: r.Y + r.Height / 2 };
  };
  const resolve = endpoint => {
    if (coordinate(endpoint)) return toPoints(endpoint, screenshotScale(request, bounds, main.title));
    let point;
    if (elementEndpoint(endpoint)) {
      const { el, identity } = elements[endpoint];
      if (!matchesIdentity(el, identity)) throw new Error('drag element identity changed before input; read the window again');
      requireAncestor(el, win, 'drag element left the chosen window; read the window again', true);
      const r = frame(el);
      references.push(el.reference);
      point = { x: r.X + r.Width / 2, y: r.Y + r.Height / 2 };
      if (!inside(bounds, point)) throw new Error('resolved element endpoint is outside the chosen window');
      const app = $.AXUIElementCreateApplication(pid), hit = Ref();
      if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) throw new Error('AX deadline unavailable');
      const error = Number($.AXUIElementCopyElementAtPosition(app, point.x, point.y, hit));
      if (error) throw axFailure('element endpoint hit test', error);
      requireAncestor(axElement(ObjC.castRefToObject(hit[0])), el, 'resolved element endpoint is covered or its identity changed; read the window again');
    } else if (selectionEndpoint(endpoint)) {
      const field = text();
      point = glyphPoint(field, field.selection.location + field.selected.search(/\S/u), false);
    } else if (lineEndpoint(endpoint)) {
      const field = text(), range = field.area.lineRange(Number(endpoint.slice(12)) - 1);
      if (!range || !Number.isSafeInteger(range.location) || !Number.isSafeInteger(range.length) || range.location < 0 || range.length <= 0 ||
          range.location + range.length > field.value.length) throw new Error('line range is unavailable');
      const line = field.value.slice(range.location, range.location + range.length).replace(/[\r\n]+$/, '');
      if (!line.length) throw new Error('line has no final glyph; read the window and choose another target');
      const last = [...line].at(-1);
      point = glyphPoint(field, range.location + line.length - last.length, true);
    } else throw new Error('invalid semantic drag endpoint');
    if (!inside(bounds, point)) throw new Error('resolved drag point is outside the chosen window');
    return [point.x - bounds.X, point.y - bounds.Y];
  };
  const from = endpoint === 'to' ? undefined : resolve(request.from), to = endpoint === 'from' ? undefined : resolve(request.to);
  return { from, to, references, elements, signature: JSON.stringify({ from, to, state, bounds: [bounds.X, bounds.Y, bounds.Width, bounds.Height] }) };
}

function checkSemantic(before, request, pid, win, main) {
  const after = semanticPoints(request, pid, win, main, before.elements);
  if (after.signature !== before.signature || after.references.length !== before.references.length ||
      after.references.some((el, i) => !$.CFEqual(el, before.references[i]))) throw new Error('drag element, text, selection or geometry changed before input; read the window again');
}
// Keep the guard's element interface, with bounded C API reads instead of an
// Apple event for each attribute. Retain bridged elements for later readback.
function axAttribute(el, name) {
  const out = Ref(), error = Number($.AXUIElementCopyAttributeValue(el, $(name), out));
  if (error) throw axFailure(name, error);
  return ObjC.castRefToObject(out[0]);
}
function axElements(value) {
  return Array.from({ length: Number(value.count) }, (_, i) => axElement(value.objectAtIndex(i)));
}
// JXA's Ref('CGPoint') reads back as the number 0, so x and y came back undefined and no window ever matched
// (textedit-drag, macOS 27.0.1, 2026-10-16). Copy the struct into bytes and read it back through NSValue.
function axPair(value, type) {
  const bytes = $.NSMutableData.dataWithLength(16);
  if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
  const boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
  const s = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
  return type === 1 ? [s.x, s.y] : [s.width, s.height];
}
function axElement(el) {
  const scalar = name => ObjC.unwrap(axAttribute(el, name));
  const geometry = (name, type) => {
    const pair = axPair(axAttribute(el, name), type);
    if (!pair) throw new Error('AX geometry is unavailable');
    return pair;
  };
  return {
    reference: el,
    role: () => scalar('AXRole'), subrole: () => scalar('AXSubrole'), name: () => scalar('AXTitle'),
    position: () => geometry('AXPosition', 1), size: () => geometry('AXSize', 2),
    value: () => scalar('AXValue'), uiElements: () => axElements(axAttribute(el, 'AXChildren')),
    attributes: { byName: name => ({
      get value() { return () => scalar(name); },
      set value(value) {
        const error = Number($.AXUIElementSetAttributeValue(el, $(name), $(value)));
        if (error) throw new Error(`AX write of ${name} failed (${error})`);
      },
    }) },
    actions: { byName: name => ({ perform: () => {
      const error = Number($.AXUIElementPerformAction(el, $(name)));
      if (error) throw new Error(`AX ${name} failed (${error})`);
    } }) },
  };
}
function axWindow(pid, window) {
  const app = $.AXUIElementCreateApplication(pid);
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) throw new Error('AX deadline unavailable');
  const all = axElements(axAttribute(app, 'AXWindows'));
  const byId = all.filter(w => attempt(() => w.attributes.byName('AXWindowNumber').value(), null) === window.id);
  const matches = byId.length ? byId : all.filter(w =>
    attempt(() => sameBounds(frame(w), window.bounds) && (!window.title || w.name() === window.title), false));
  if (matches.length !== 1) throw new Error(`cannot match window ${window.id} to one AX window; nothing was pressed`);
  return matches[0];
}
function content(win, bounds) {
  const areas = [], toolbars = [];
  let visited = 0;
  const walk = (el, parent, depth) => {
    if (depth > 12 || ++visited > 300) throw new Error('AX content scan exceeded its depth or 300-element limit');
    const role = attempt(() => el.role(), '');
    const own = attempt(() => frame(el), null);
    const visible = own ? clip(parent, own) : parent;
    if (role === 'AXToolbar') { if (own) toolbars.push(visible); return; }
    if (/^AX(?:Close|Minimize|Zoom|FullScreen|TitleBar)/.test(attempt(() => el.subrole(), ''))) return;
    const body = ['AXScrollArea', 'AXTextArea', 'AXTextField', 'AXWebArea', 'AXTable', 'AXOutline', 'AXImage', 'AXSplitGroup'];
    // A group covering the whole frame is not evidence of a content area.
    if (own && (body.includes(role) || (role === 'AXGroup' && own.Y > bounds.Y))) areas.push({ el, role, bounds: visible });
    for (const child of attempt(() => el.uiElements(), [])) walk(child, visible, depth + 1);
  };
  walk(win, bounds, 0);
  return { areas, toolbars };
}
// Non-text drags need only the two hit elements and their ancestors. Walking
// unrelated rows can exhaust the scan limit before reaching either point.
function dragContent(pid, win, bounds, from, to, textDestination = false) {
  const app = $.AXUIElementCreateApplication(pid);
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) throw new Error('AX deadline unavailable');
  const areas = [];
  let textSource = null;
  for (const [index, offset] of [from, to].entries()) {
    const point = at(bounds, offset), hit = Ref();
    if (!inside(bounds, point)) throw new Error('drag point is outside the window content; nothing was pressed');
    const error = Number($.AXUIElementCopyElementAtPosition(app, point.x, point.y, hit));
    if (error) throw axFailure('endpoint hit test', error);
    let el = axElement(ObjC.castRefToObject(hit[0])), matched = false;
    const path = [];
    // Electron windows put web text about 31 parents below the window (2026-10-17).
    for (let depth = 0; depth < 64; depth++) {
      if ($.CFEqual(el.reference, win.reference)) { matched = true; break; }
      const role = el.role(), subrole = attempt(() => el.subrole(), '');
      if (role === 'AXWindow' || role === 'AXToolbar' || /^AX(?:Close|Minimize|Zoom|FullScreen|TitleBar)/.test(subrole)) {
        throw new Error('drag endpoint is outside the chosen window content (title bar, toolbar or another window); nothing was pressed');
      }
      if (index === 0 && ['AXTextArea', 'AXTextField'].includes(role)) textSource = el;
      path.push({ el, role, bounds: attempt(() => frame(el), null) });
      el = axElement(axAttribute(el.reference, 'AXParent'));
    }
    if (!matched) throw new Error('AX endpoint parent path exceeded its limit before the chosen window; nothing was pressed');
    if (textSource) {
      const selected = textSource.attributes.byName('AXSelectedText').value();
      if (!textDestination && (typeof selected !== 'string' || !selected.trim())) throw new Error('Select non-whitespace text in this window before dragging; nothing was pressed');
      return content(win, bounds);
    }
    // The hit test already found this element at the point, inside the chosen window. Ancestor frames
    // can be wrong: Chess's board reported ones that cut off its right half, so every drag there was
    // refused (2026-10-17 A/B). A frame that misses the point falls back to the window bounds, except a
    // text field's: widened, it would contain a non-text start point and its selection could move instead.
    let body = false;
    for (const item of path.reverse()) {
      if (!item.bounds) throw new Error('AX endpoint geometry is unavailable; nothing was pressed');
      if (['AXScrollArea', 'AXTextArea', 'AXTextField', 'AXWebArea', 'AXTable', 'AXOutline', 'AXImage', 'AXSplitGroup'].includes(item.role) ||
          (item.role === 'AXGroup' && item.bounds.Y > bounds.Y)) {
        const visible = clip(bounds, item.bounds);
        const text = ['AXTextArea', 'AXTextField'].includes(item.role);
        areas.push({ ...item, bounds: inside(visible, point) || text ? visible : bounds }); body = true;
      }
    }
    if (!body) throw new Error('drag endpoint is outside the window content area; nothing was pressed');
  }
  return { areas, toolbars: [] };
}
function validatePoints(info, bounds, from, to, app) {
  const start = at(bounds, from), end = at(bounds, to);
  for (const [name, point] of [['from', start], ['to', end]]) {
    if (!inside(bounds, point) || info.toolbars.some(b => inside(b, point)) || !info.areas.some(a => inside(a.bounds, point))) {
      throw new Error(`${name} is outside the window content area (title bar, toolbar or frame); nothing was pressed. For a point in another window of this app, pass that window's id as toWindowId`);
    }
  }
  let text = null;
  const fields = info.areas.filter(a => ['AXTextArea', 'AXTextField'].includes(a.role) && inside(a.bounds, start));
  if (fields.length) {
    if (fields.length !== 1 || !inside(fields[0].bounds, end)) throw new Error(`${app} from and to must be inside the same visible text area or field; nothing was pressed. To drop the text in another window of this app, pass that window's id as toWindowId`);
    const el = fields[0].el;
    const value = el.value(), selected = el.attributes.byName('AXSelectedText').value();
    if (typeof value !== 'string' || typeof selected !== 'string' || !selected.trim()) throw new Error(`Select non-whitespace ${app} text in this window before dragging; nothing was pressed`);
    text = { el, text: value, selected, app };
  }
  return { start, end, text };
}

// Only repair a uniquely identified word move whose whole text matches, with
// at most one source-side space removed by TextEdit's smart deletion.
function textDropSpace(before, word, after, selected) {
  if (typeof before !== 'string' || typeof after !== 'string' || !word || word !== selected ||
      !/^[\p{L}\p{N}]+$/u.test(word) || before === after) return null;
  const source = before.indexOf(word);
  const drop = after.indexOf(word);
  if (source < 0 || drop <= 0 || before.indexOf(word, source + 1) >= 0 || after.indexOf(word, drop + 1) >= 0) return null;
  if (/[\p{L}\p{N}]$/u.test(before.slice(0, source)) || /^[\p{L}\p{N}]/u.test(before.slice(source + word.length))) return null;
  if (!/[\p{L}\p{N}]$/u.test(after.slice(0, drop)) || !/^(?:\r?\n|$)/.test(after.slice(drop + word.length))) return null;
  const left = before.slice(0, source), right = before.slice(source + word.length);
  const remainder = after.slice(0, drop) + after.slice(drop + word.length);
  const candidates = [left + right];
  if (left.endsWith(' ')) candidates.push(left.slice(0, -1) + right);
  if (right.startsWith(' ')) candidates.push(left + right.slice(1));
  return candidates.includes(remainder) ? ` ${word}` : null;
}

function repairTextDrop(snapshot) {
  const settle = () => { if (snapshot?.pid) attempt(() => settleAfterTextWrite(snapshot.pid)); };
  if (!snapshot || snapshot.preserveFormatting) return { spaceInserted: false };
  try {
    const after = snapshot.el.value();
    const selected = snapshot.el.attributes.byName('AXSelectedText');
    const replacement = textDropSpace(snapshot.text, snapshot.selected, after, selected.value());
    if (!replacement) return { spaceInserted: false };
    selected.value = replacement;
    settle();
    const at = after.indexOf(snapshot.selected);
    const expected = after.slice(0, at) + ' ' + after.slice(at);
    if (snapshot.el.value() !== expected) throw new Error(`${snapshot.app} did not confirm the spacing repair; read the text before continuing`);
    return { spaceInserted: true };
  } catch (e) {
    if (e?.axCode === -25204) throw e;
    return { spaceInserted: false, spacingError: String(e.message || e) };
  }
}

function finishTextDrop(snapshot, window) {
  if (!snapshot) return { spaceInserted: false };
  const name = `${snapshot.app} window ${window.id} (${window.title})`;
  if (snapshot.el.value() === snapshot.text) return {
    spaceInserted: false, textChanged: false,
    error: `Text in ${name} is unchanged after dragging; read it before continuing.`,
  };
  const lost = () => ({ lostText: true, error: `Dragged text disappeared from ${name} and was not inserted in its text area. Press Cmd+Z in that window now, then read it again before continuing.` });
  // A deletion can join surrounding fragments into the selected word. Check
  // its characters as well as presence. Smart deletion may change spaces.
  const characters = text => {
    const counts = new Map();
    for (const c of text) if (!/\s/u.test(c)) counts.set(c, (counts.get(c) || 0) + 1);
    return counts;
  };
  const before = characters(snapshot.text), selected = characters(snapshot.selected);
  const verify = () => {
    const after = snapshot.el.value();
    if (typeof after !== 'string') throw new Error(`cannot verify the drop in ${name}; read that window before continuing`);
    const counts = characters(after);
    return !after.replace(/\s/gu, '').includes(snapshot.selected.replace(/\s/gu, '')) ||
      [...selected.keys()].some(c => (counts.get(c) || 0) < before.get(c));
  };
  if (verify()) return lost();
  const outcome = repairTextDrop(snapshot);
  if (verify()) return lost();
  if (outcome.spacingError) return { ...outcome, error: outcome.spacingError };
  return outcome;
}

// After another process writes text through Accessibility, TextEdit's next Cmd+S deadlocked on the
// document's save lock in 10 of 13 probe trials (2026-10-08). One Shift press and release posted to
// the app (not the HID stream, so it never reaches the user's keyboard) after the write: 0 hangs in
// 10 trials that edited, against 5 in 8 without it (2026-10-09). Why it works is unknown.
function settleAfterTextWrite(pid) {
  for (const down of [true, false]) {
    const e = $.CGEventCreateKeyboardEvent(null, 56, down); // kVK_Shift
    $.CGEventSetFlags(e, down ? $.kCGEventFlagMaskShift : 0);
    $.CGEventSetType(e, $.kCGEventFlagsChanged);
    $.CGEventPostToPid(pid, e);
    delay(0.05);
  }
}

// The effective range is optional and passed as null. JXA refuses a malloc'd void* for that NSRangePointer
// with "Ref has incompatible type", which failed the Accessibility text move in all 64 benchmark transcripts
// that tried one (2026-10-16 to 2026-10-19).
function attributedTextHasAttributes(value, length, start = 0) {
  if (!value || Number(value.length) !== length) throw new Error('the selected attributed string is unavailable or incomplete');
  const attributesAt = i => {
    const attributes = value.attributesAtIndexEffectiveRange(i, null);
    if (!attributes || !Number.isSafeInteger(Number(attributes.count))) throw new Error('the selected text attributes are unavailable');
    return attributes;
  };
  const baseline = attributesAt(0);
  for (let i = start; i < length; i++) {
    if (!attributesAt(i).isEqualToDictionary(baseline)) return true;
  }
  return false;
}

// The text area under a screen point, through the Accessibility C API, which
// can map a point to a character and write text without the pointer or focus.
// JXA can't pass struct pointers, so AXValues are built from an NSValue's bytes.
function axTextArea(pid, point, reference) {
  ObjC.import('ApplicationServices');
  ObjC.bindFunction('malloc', ['void*', ['unsigned long']]);
  ObjC.bindFunction('free', ['void', ['void*']]);
  ObjC.bindFunction('AXValueCreate', ['id', ['int', 'void*']]);
  const axValue = (type, nsvalue) => { const buf = $.malloc(32); try { nsvalue.getValue(buf); return $.AXValueCreate(type, buf); } finally { $.free(buf); } };
  const range = (location, length) => axValue(4, $.NSValue.valueWithRange($.NSMakeRange(location, length)));
  const described = ref => ObjC.unwrap(ObjC.castRefToObject(ref).description);
  const get = (el, name) => { const out = Ref(); const err = $.AXUIElementCopyAttributeValue(el, $(name), out); if (err) throw axFailure(name, err); return out[0]; };
  const ask = (el, name, arg) => { const out = Ref(); const err = $.AXUIElementCopyParameterizedAttributeValue(el, $(name), arg, out); if (err) throw axFailure(name, err); return out[0]; };
  const set = (el, name, v) => { const err = $.AXUIElementSetAttributeValue(el, $(name), v); if (err) throw new Error(`AX write of ${name} failed (${err})`); };
  const app = $.AXUIElementCreateApplication(pid);
  const hit = Ref();
  // An app element hit-tests only that app's windows, so a covering app doesn't matter.
  if (!reference && $.AXUIElementCopyElementAtPosition(app, point.x, point.y, hit)) throw new Error('no accessibility element at the drop point');
  // A web text area answers the hit test with a group or static text inside it (Safari,
  // 2026-10-09), so walk up to the nearest text area or field.
  let el = reference || hit[0];
  const role = e => attempt(() => ObjC.unwrap(ObjC.castRefToObject(get(e, 'AXRole'))), '');
  for (let up = 0; up < 6 && !['AXTextArea', 'AXTextField'].includes(role(el)); up++) {
    const parent = attempt(() => get(el, 'AXParent'), null);
    if (!parent) break;
    el = ObjC.castRefToObject(parent); // a raw parent reference can't go back through the bridge
  }
  if (!['AXTextArea', 'AXTextField'].includes(role(el))) throw new Error('the drop point is not in a text area or field');
  const rangeOf = ref => { const m = /location:(\d+) length:(\d+)/.exec(described(ref)); if (!m) throw new Error('unreadable AX range'); return { location: +m[1], length: +m[2] }; };
  const rect = (index, length = 1) => {
    const m = /x:([-\d.]+) y:([-\d.]+) w:([-\d.]+) h:([-\d.]+)/.exec(described(ask(el, 'AXBoundsForRange', range(index, length))));
    return m && { X: +m[1], Y: +m[2], Width: +m[3], Height: +m[4] };
  };
  return {
    value: () => ObjC.unwrap(ObjC.castRefToObject(get(el, 'AXValue'))),
    selection: () => rangeOf(get(el, 'AXSelectedTextRange')),
    lineRange: line => rangeOf(ask(el, 'AXRangeForLine', $.NSNumber.numberWithInteger(line))),
    hasAttributes: (location, length, baseline) => attributedTextHasAttributes(
      ObjC.castRefToObject(ask(el, 'AXAttributedStringForRange', range(baseline, location + length - baseline))),
      location + length - baseline, location - baseline),
    indexAt: p => rangeOf(ask(el, 'AXRangeForPosition', axValue(1, $.NSValue.valueWithPoint($.NSMakePoint(p.x, p.y))))).location,
    rect,
    lineEnd: index => {
      const line = ObjC.unwrap(ObjC.castRefToObject(ask(el, 'AXLineForIndex', $(index))));
      const r = rangeOf(ask(el, 'AXRangeForLine', $(line)));
      return r.location + r.length;
    },
    replace: (location, length, text) => { set(el, 'AXSelectedTextRange', range(location, length)); set(el, 'AXSelectedText', $(text)); },
    select: (location, length) => set(el, 'AXSelectedTextRange', range(location, length)),
    settle: () => settleAfterTextWrite(pid),
  };
}

// Where text dropped at a point lands: before or after the character under it,
// or at the end of its line when the point is past the line's last character
// (AXRangeForPosition answers 0 there).
function dropIndex(area, p, text) {
  const onRow = r => r && p.y >= r.Y && p.y < r.Y + r.Height;
  const index = area.indexAt(p), r = area.rect(index);
  if (onRow(r) && p.x >= r.X && p.x < r.X + r.Width) return p.x < r.X + r.Width / 2 ? index : index + 1;
  for (let x = p.x - 4; x >= p.x - 600; x -= 4) {
    const i = area.indexAt({ x, y: p.y }), q = area.rect(i);
    if (onRow(q) && x >= q.X && x < q.X + q.Width) {
      const end = area.lineEnd(i);
      return end > 0 && text[end - 1] === '\n' ? end - 1 : end;
    }
  }
  throw new Error('cannot find where the drop point falls in the text; nothing was changed');
}

// Moves selected text to the drop point, preserving word boundaries:
// one space comes out with a word at the source, and one goes in at the drop
// when the word would touch another. Checks the whole result, and on a mismatch
// says to undo.
function accessibilityMove(area, snapshot, end, window) {
  let before, sel, formatted = false;
  try {
    before = area.value(); sel = area.selection();
    if (before !== snapshot.text || before.slice(sel.location, sel.location + sel.length) !== snapshot.selected) {
      throw new Error('the text or selection changed before the move; nothing was changed, read the window again');
    }
    const baseline = Math.max(before.lastIndexOf('\n', sel.location - 1), before.lastIndexOf('\r', sel.location - 1)) + 1;
    formatted = area.hasAttributes(sel.location, sel.length, baseline);
    if (formatted) {
      snapshot.preserveFormatting = true;
      throw new Error('the selected text carries formatting; use the guarded posted or foreground drag to preserve it');
    }
  } finally { if (!formatted) snapshot.preserveFormatting = false; }
  const word = snapshot.selected, src = sel.location, srcEnd = src + sel.length;
  const dest = dropIndex(area, end, before);
  if (dest >= src && dest <= srcEnd) throw new Error('the drop point is inside the selection; nothing was changed');
  const isWord = /^[\p{L}\p{N}]/u.test(word) && /[\p{L}\p{N}]$/u.test(word);
  // Source span, with one space when the word leaves two side by side or one at a line edge.
  let cutFrom = src, cutTo = srcEnd;
  if (isWord) {
    const left = before[src - 1], right = before[srcEnd];
    if (right === ' ' && (left === undefined || left === '\n' || left === ' ')) cutTo++;
    else if (left === ' ' && (right === undefined || right === '\n' || right === ' ')) cutFrom--;
  }
  const leftOfDrop = before[dest - 1], rightOfDrop = before[dest];
  const touches = c => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const insert = (isWord && touches(leftOfDrop) ? ' ' : '') + word + (isWord && touches(rightOfDrop) ? ' ' : '');
  const expected = dest > srcEnd
    ? before.slice(0, cutFrom) + before.slice(cutTo, dest) + insert + before.slice(dest)
    : before.slice(0, dest) + insert + before.slice(dest, cutFrom) + before.slice(cutTo);
  // The later edit first, so the earlier one's indices still hold.
  const edits = dest > srcEnd ? [[dest, 0, insert], [cutFrom, cutTo - cutFrom, '']] : [[cutFrom, cutTo - cutFrom, ''], [dest, 0, insert]];
  let after;
  try {
    area.replace(...edits[0]);
  } catch (e) {
    after = attempt(() => area.value(), null);
    if (after === before) throw e; // nothing changed, so another path may try
  }
  if (after === undefined) {
    try { area.replace(...edits[1]); } catch (_) {}
    after = attempt(() => area.value(), null);
  }
  attempt(() => area.settle());
  // Safari's web text areas accept the writes and change nothing (2026-10-09). Nothing to undo,
  // so another path may try.
  if (after === before) throw new Error('the app ignored the Accessibility text writes');
  if (after !== expected) {
    return { lostText: typeof after !== 'string' || after.replace(/\s/gu, '').length < before.replace(/\s/gu, '').length,
      error: `The text in ${snapshot.app} window ${window.id} (${window.title}) isn't what the move should have made. Press Cmd+Z twice in that window, then read it again before continuing.` };
  }
  const movedAt = after.indexOf(word, dest > srcEnd ? dest - (cutTo - cutFrom) : dest);
  attempt(() => area.select(movedAt, word.length));
  return { textChanged: true, spaceInserted: insert !== word };
}

function findApp(name) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (let i = 0; i < apps.count; i++) {
    const a = apps.objectAtIndex(i);
    const id = ObjC.unwrap(a.bundleIdentifier);
    const path = ObjC.unwrap(a.bundleURL.path);
    if (ObjC.unwrap(a.localizedName) === name || id === name || path === name) {
      if (ownHost(a)) throw new Error(OWN_HOST_LINE);
      return a;
    }
  }
  return null;
}

function backgroundBuilder() {
  // JXA exposes NSEvent.CGEvent as an opaque Ref that its CF function bridge
  // cannot consume. A typed message send returns the same pointer as a CF id.
  ObjC.bindFunction('objc_msgSend', ['id', ['id', 'selector']]);
  // Named CGPoint aliases silently bind as scalars in JXA. Encode both fields.
  const pointType = '{CGPoint="x"d"y"d}';
  ObjC.bindFunction('CGEventSetWindowLocation', ['void', ['id', pointType]]);
  ObjC.bindFunction('CGEventGetWindowLocation', [pointType, ['id']]);
  return (type, point, main) => {
    const b = main.bounds, local = $.CGPointMake(point.x - b.X, point.y - b.Y);
    const native = $.NSEvent.mouseEventWithTypeLocationModifierFlagsTimestampWindowNumberContextEventNumberClickCountPressure(
      type, $.CGPointMake(local.x, b.Height - local.y), 0,
      $.NSProcessInfo.processInfo.systemUptime, main.id, null, 1, 1, type === 2 ? 0 : 1);
    const event = $.objc_msgSend(native, 'CGEvent');
    if ($.CGEventGetType(event) !== type) throw new Error('NSEvent CGEvent bridge failed');
    $.CGEventSetLocation(event, $.CGPointMake(point.x, point.y));
    $.CGEventSetWindowLocation(event, local);
    const read = $.CGEventGetWindowLocation(event);
    if (!read || Math.abs(read.x - local.x) > 0.5 || Math.abs(read.y - local.y) > 0.5 ||
        ![read.x, read.y].every(Number.isFinite)) throw new Error('CGEventSetWindowLocation did not retain the window coordinates');
    $.CGEventSetIntegerValueField(event, 7, 3); // window-local mouse subtype
    $.CGEventSetIntegerValueField(event, 1, 1); // click state
    $.CGEventSetIntegerValueField(event, 91, main.id);
    $.CGEventSetIntegerValueField(event, 92, main.id);
    return { native, event }; // retain the NSEvent until its CGEvent has posted
  };
}

function checkWindow(main, pid, win) {
  const list = windows(true);
  const current = list.find(w => w.id === main.id && w.pid === pid && w.layer === 0);
  if (!current || !sameBounds(current.bounds, main.bounds) || !sameBounds(frame(win), main.bounds)) {
    throw new Error('the chosen window moved or disappeared; read it again');
  }
  return list;
}

// The app's focused element's selected text, or '' when there is none or it can't be read.
function focusedSelection(pid) {
  return attempt(() => {
    const proc = Application('System Events').processes.whose({ unixId: pid })[0];
    const selected = proc.attributes.byName('AXFocusedUIElement').value().attributes.byName('AXSelectedText').value();
    return typeof selected === 'string' ? selected.trim() : '';
  }, '');
}

// The engine's app.drag reaches a covered window (a Chess pawn moved 1/1) but changed no list order in 13 of 13
// Firefox reorders (2026-10-17), so it gets one try, and an unchanged result ends the attempt.
const COVERED_NO_TEXT = (cover, detail = '') => `${cover} covers the window at the drag points, and this drag has no selected text${detail}. Use the engine's app.drag in js once if the content may change; if the order or content is unchanged afterwards, don't repeat it: stop and tell the user that part of the window needs uncovering; nothing was pressed`;

function raiseWindow(win) {
  attempt(() => { win.attributes.byName('AXMain').value = true; });
  win.actions.byName('AXRaise').perform();
}

// The process the window server gives a click at p to, from the system-wide Accessibility hit test, or null
// when it can't say (nothing there, an error or a timeout). One test per point and window list.
function eventPidAt(list, p) {
  const key = `${p.x},${p.y}`;
  if (!list.eventPids) list.eventPids = new Map();
  if (!list.eventPids.has(key)) {
    let pid = null;
    try {
      const hit = Ref(), owner = Ref();
      if (Number($.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), p.x, p.y, hit)) === 0 &&
          Number($.AXUIElementGetPid(ObjC.castRefToObject(hit[0]), owner)) === 0) pid = Number(owner[0]);
    } catch (_) {}
    list.eventPids.set(key, Number.isSafeInteger(pid) && pid > 0 ? pid : null);
  }
  return list.eventPids.get(key);
}
// Another app's window that lets clicks at p through. Some system windows are on screen and in front without
// taking events: Notification Center's full-display window (layer 21) whenever a banner shows, which stopped a
// drag whose point was half a screen from the banner (2026-10-19), and the Dock's tiling backdrop (layer 0,
// "half-backdrop") after Move & Resize, where the hit test reached the app below it (read-only probe, 2026-10-19).
// An unknown answer counts as cover, and so does a banner over the point, since the hit test then lands on it.
const passesThrough = (list, w, p) => { const pid = eventPidAt(list, p); return pid !== null && pid !== w.pid; };
const blocks = (list, w, p, pid) => !overlay(w) && (w.pid === pid || !passesThrough(list, w, p));
// A background agent's window (activation policy not regular), such as a notification banner, rather than a
// window of an app someone works in.
const systemOverlay = w => attempt(() => {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(w.pid);
  return !!app && !app.isNil() && Number(app.activationPolicy) !== 0;
}, false);

function exposedEndpoints(list, main, points, sameAppOnly, destination = main) {
  for (const [name, point, target] of [['from', points.start, main], ['to', points.end, destination]]) {
    const top = list.find(w => inside(w.bounds, point) && (sameAppOnly ? w.pid === target.pid && !overlay(w) : blocks(list, w, point, target.pid)));
    if (!top || top.id !== target.id || top.pid !== target.pid) {
      const shown = top && ` (windowId ${top.id}${top.title ? ', "' + top.title + '"' : ''})`;
      // A system overlay seldom stays, and acting on it is not the drag's business: in a 2026-10-19 run Claude
      // turned to the notifications tool, whose approval the run refused, and the pass stopped.
      if (top && top.pid !== target.pid && systemOverlay(top)) {
        throw Object.assign(new Error(`${name} is covered by ${top.owner}${shown}, a system overlay such as a notification banner; nothing was pressed. It usually goes away within seconds: wait about 5 s, read the window again and retry the drag once. If it's still covered, tell the user rather than acting on the overlay`), { systemOverlay: true });
      }
      // A window of the same app with no title over the target is usually a dialog: Chess's New Game
      // dialog covered the board and stopped 9 drags in one run (2026-10-09).
      const dialog = top && top.pid === target.pid && !top.title
        ? ` by another window of ${top.owner} with no title (windowId ${top.id}), likely a dialog or sheet: finish or close it, read the window again, then drag`
        : top ? ` by ${top.pid === target.pid ? 'another window of ' + top.owner : top.owner}${shown}` : '';
      throw new Error(`${name} is covered${dialog || ' by another window'}; nothing was pressed`);
    }
  }
}

// The other app on top at either drag point, or null when the window is exposed at both.
function coveringApp(list, main, points) {
  for (const point of [points.start, points.end]) {
    const top = list.find(w => w.layer === 0 && inside(w.bounds, point) && blocks(list, w, point, main.pid));
    if (top && top.pid !== main.pid) return top.owner || 'another app';
  }
  return null;
}

// The topmost on-screen window at a point that takes the click, as the window server would pick the drop
// target. Every layer counts (Dock, menu bar, floating panels, picture-in-picture, banners), not only layer 0.
const topAt = (list, p, pid) => list.find(w => inside(w.bounds, p) && blocks(list, w, p, pid));
// Points of clearance a relocated point keeps from the edge of any window of another app in front of the target.
const EDGE_CLEARANCE = 4;
function exposedAt(list, main, p) {
  const top = topAt(list, p, main.pid);
  if (!top || top.id !== main.id || top.pid !== main.pid) return false;
  const index = list.findIndex(w => w.id === main.id && w.pid === main.pid);
  // A window that lets the click at p through needs no clearance; one whose edge is near p still does.
  return list.slice(0, index).every(w => w.pid === main.pid || overlay(w) ||
    !inside({ X: w.bounds.X - EDGE_CLEARANCE, Y: w.bounds.Y - EDGE_CLEARANCE,
      Width: w.bounds.Width + 2 * EDGE_CLEARANCE, Height: w.bounds.Height + 2 * EDGE_CLEARANCE }, p) ||
    (inside(w.bounds, p) && passesThrough(list, w, p)));
}

// Only a leaf item can take a point of its own: a group, list or web area holds other rows and controls, and
// in web content nearly everything is an AXGroup. A group or image qualifies only with no children.
const ITEM_ROLES = ['AXRow', 'AXCell', 'AXButton', 'AXStaticText', 'AXCheckBox', 'AXRadioButton', 'AXLink'];
const LEAF_ONLY_ROLES = ['AXGroup', 'AXImage'];

// Grid points inside one element's frame, nearest the original point first.
function candidatePoints(rect, point) {
  const inset = Math.min(2, rect.Width / 4, rect.Height / 4), out = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    out.push({ x: rect.X + inset + (rect.Width - 2 * inset) * i / 11, y: rect.Y + inset + (rect.Height - 2 * inset) * j / 11 });
  }
  return out.sort((a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y));
}

// A point inside the rect that the window server shows (exposed) and that Accessibility still resolves
// to the same element (accept). At most `tries` Accessibility hit tests. null when none qualifies.
function exposedPointIn(rect, point, exposed, accept, tries = 6) {
  let tested = 0;
  for (const p of candidatePoints(rect, point)) {
    if (!exposed(p)) continue;
    if (++tested > tries) return null;
    if (accept(p)) return p;
  }
  return null;
}

// Another app covers an endpoint of a drag with no selected text. Rather than refuse, choose an exposed point
// inside the exact same element (a list row, a button); every coverage check runs again on the new points.
// endpointElement(name, point) returns { rect, role, leaf, frame(), accepts(p) } for the element under the
// original point: accepts(p) is true only when a hit test at p is that element itself, not a descendant.
// Returns { start, end, moved: [names], recheck(list) }, or { refusal } naming the endpoint with no exposed part.
// recheck(list) is for just before the first post: null when every moved point still holds, else why not.
function relocateCovered(list, main, points, endpointElement) {
  const result = { start: points.start, end: points.end, moved: [] }, kept = [];
  for (const [name, key] of [['from', 'start'], ['to', 'end']]) {
    const top = topAt(list, points[key], main.pid);
    if (!top || top.pid === main.pid) continue;
    const covered = `${name} is covered by ${top.owner || 'another app'}`;
    const target = endpointElement(name, points[key]);
    if (!target || !target.rect) return { refusal: `; ${covered} and no element is known there` };
    if (!(ITEM_ROLES.includes(target.role) || (LEAF_ONLY_ROLES.includes(target.role) && target.leaf))) {
      return { refusal: `; ${covered} and the element there (${target.role || 'unknown'}${target.leaf ? '' : ', with children'}) is not a single item, so the point can't move within it` };
    }
    const rect = clip(target.rect, main.bounds);
    if (rect.Width < 4 || rect.Height < 4 || rect.Width * rect.Height > main.bounds.Width * main.bounds.Height / 2) {
      return { refusal: `; ${covered} and the element there is too large or too small to move the point within it` };
    }
    const found = exposedPointIn(rect, points[key], p => exposedAt(list, main, p), target.accepts);
    if (!found) return { refusal: `; ${covered} and no part of that element is exposed` };
    result[key] = found; result.moved.push(name); kept.push({ name, point: found, target });
  }
  result.recheck = fresh => {
    for (const { name, point, target } of kept) {
      if (!exposedAt(fresh, main, point)) return `the ${name} point is covered again`;
      const now = target.frame && target.frame();
      if (!now || !sameBounds(now, target.rect)) return `the element at the ${name} point moved`;
      if (!target.accepts(point)) return `the ${name} point is no longer on the same element`;
    }
    return null;
  };
  return result;
}

// The element under a covered endpoint, from Accessibility's hit test (which ignores other apps' windows) or,
// for a numbered element, the observed element itself. accepts(p) is true only when a hit at p is that element itself.
function coveredEndpoint(pid, main, resolved, request) {
  const app = $.AXUIElementCreateApplication(pid);
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.5)) !== 0) throw new Error('AX deadline unavailable');
  const hit = p => {
    const out = Ref(), error = Number($.AXUIElementCopyElementAtPosition(app, p.x, p.y, out));
    if (error) throw axFailure('endpoint hit test', error);
    return axElement(ObjC.castRefToObject(out[0]));
  };
  return (name, point) => {
    const numbered = resolved && elementEndpoint(request[name]) ? resolved.elements[request[name]]?.el : null;
    const el = numbered || attempt(() => hit(point), null);
    const rect = el && attempt(() => frame(el), null);
    if (!el || !rect) return null;
    return { rect, role: attempt(() => el.role(), ''), leaf: attempt(() => el.uiElements().length === 0, false),
      frame: () => attempt(() => frame(el), null), accepts: p => attempt(() => $.CFEqual(hit(p).reference, el.reference), false) };
  };
}

function finishCrossWindowDrop(source, destination, a, b) {
  const left = source.el.value(), right = destination.el.value();
  const names = `${source.app} window ${a.id} (${a.title}) and window ${b.id} (${b.title})`;
  if (typeof left !== 'string' || typeof right !== 'string') throw new Error(`cannot verify the drop in ${names}; read both windows before continuing`);
  if (left === source.text && right === destination.text) return { textChanged: false, error: `Text in ${names} is unchanged after dragging; read both windows before continuing.` };
  const counts = text => {
    const result = new Map();
    for (const c of text) if (!/\s/u.test(c)) result.set(c, (result.get(c) || 0) + 1);
    return result;
  };
  const matches = (before, after, direction) => {
    const expected = counts(before), actual = counts(after);
    for (const [c, n] of counts(source.selected)) expected.set(c, (expected.get(c) || 0) + direction * n);
    return [...new Set([...expected.keys(), ...actual.keys()])].every(c => (expected.get(c) || 0) === (actual.get(c) || 0));
  };
  const gained = right.replace(/\s/gu, '').includes(source.selected.replace(/\s/gu, '')) && matches(destination.text, right, 1);
  if (!matches(source.text, left, -1) || !gained) return { textChanged: true, lostText: left !== source.text && !gained,
    error: `The text move between ${names} was not confirmed. Stop and read both windows; if text disappeared, press Cmd+Z in the source window, then check the destination before undoing there.` };
  return { textChanged: true, deliveryVerified: true };
}

// Insert and verify B before deleting A. Any partial write stops all later paths.
function accessibilityCrossWindowMove(sourceArea, destinationArea, source, destination, end, a, b, progress = {}) {
  const before = sourceArea.value(), other = destinationArea.value(), sel = sourceArea.selection();
  const destinationSelection = destinationArea.selection();
  const sameRange = (left, right) => left.location === right.location && left.length === right.length;
  if (before !== source.text || other !== destination.text || before.slice(sel.location, sel.location + sel.length) !== source.selected) {
    throw new Error('text or selection changed before the move; read both windows again');
  }
  const baseline = Math.max(before.lastIndexOf('\n', sel.location - 1), before.lastIndexOf('\r', sel.location - 1)) + 1;
  if (sourceArea.hasAttributes(sel.location, sel.length, baseline)) throw new Error('selected text carries formatting; use the guarded posted or foreground drag');
  const dest = dropIndex(destinationArea, end, other), word = source.selected;
  if (!Number.isSafeInteger(dest) || dest < 0 || dest > other.length) throw new Error('drop index is outside destination text');
  let cutFrom = sel.location, cutTo = cutFrom + sel.length;
  const isWord = /^[\p{L}\p{N}]/u.test(word) && /[\p{L}\p{N}]$/u.test(word);
  const touches = c => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  if (isWord) {
    const left = before[cutFrom - 1], right = before[cutTo];
    if (right === ' ' && (left === undefined || left === '\n' || left === ' ')) cutTo++;
    else if (left === ' ' && (right === undefined || right === '\n' || right === ' ')) cutFrom--;
  }
  const insert = (isWord && touches(other[dest - 1]) ? ' ' : '') + word + (isWord && touches(other[dest]) ? ' ' : '');
  const expected = other.slice(0, dest) + insert + other.slice(dest);
  const names = `${source.app} window ${a.id} (${a.title}) and window ${b.id} (${b.title})`;
  // B holds a verified insertion that A can't match: remove exactly that range, and report only once B reads as before.
  const rollback = reason => {
    let now = attempt(() => destinationArea.value(), null);
    if (now === expected) {
      try { destinationArea.replace(dest, insert.length, ''); } catch (_) {}
      now = attempt(() => destinationArea.value(), null);
    }
    if (now === other) {
      attempt(() => destinationArea.select(destinationSelection.location, destinationSelection.length));
      return { textChanged: false, rolledBack: true, deliveryVerified: false,
        error: `Nothing moved between ${names}: ${reason}. The text inserted in window ${b.id} was removed, and it reads as before. Read both windows before trying again.` };
    }
    const shown = typeof now === 'string' ? JSON.stringify(now.length > 600 ? now.slice(0, 600) : now) + (now.length > 600 ? ` (first 600 of ${now.length} characters)` : '') : 'text that could not be read';
    return { textChanged: true, rolledBack: false, deliveryVerified: false, lostText: false,
      error: `Partial Accessibility text move between ${names}: ${reason}, and removing the inserted ${JSON.stringify(insert)} at index ${dest} could not be verified: window ${b.id} (${b.title}) now contains ${shown}. Read both windows before continuing; undo the insertion there if the source still has its text.` };
  };
  let attempted = false, inserted = false;
  try {
    attempted = true; progress.wrote = true;
    destinationArea.replace(dest, 0, insert);
    if (destinationArea.value() === other && sourceArea.value() === before) throw new Error('the app ignored the Accessibility text writes');
    inserted = destinationArea.value() === expected;
    if (inserted) {
      if (sourceArea.value() !== before) return rollback('the source text changed when the destination was written (the two windows may share one document) or was edited');
      if (source.el.attributes.byName('AXSelectedText').value() !== source.selected || !sameRange(sourceArea.selection(), sel)) return rollback('the source selection changed during the move');
      try { sourceArea.replace(cutFrom, cutTo - cutFrom, ''); } catch (error) {
        if (attempt(() => sourceArea.value(), null) === before) return rollback(`the source window refused the cut (${error.message || error}); it may be read-only`);
        throw error;
      }
      if (sourceArea.value() === before) return rollback('the source window ignored the cut; it may be read-only');
    }
  } catch (error) {
    if (error?.axCode === -25204) throw error;
    // A failing setter may already have changed text. Only proven unchanged permits retry.
    if (!inserted && attempt(() => sourceArea.value(), null) === before && attempt(() => destinationArea.value(), null) === other) {
      const current = destinationArea.selection();
      if (!sameRange(sourceArea.selection(), sel) || (!sameRange(current, destinationSelection) && !sameRange(current, { location: dest, length: 0 }))) {
        throw new Error('selection changed before the move; read both windows again');
      }
      // replace sets B's range before its text setter. Restore only that exact authored range,
      // with both values unchanged; an unrelated selection must still stop the next path.
      if (!sameRange(current, destinationSelection)) destinationArea.select(destinationSelection.location, destinationSelection.length);
      throw error;
    }
  } finally { if (attempted) attempt(() => sourceArea.settle()); }
  const outcome = finishCrossWindowDrop(source, destination, a, b);
  if (sourceArea.value() !== before.slice(0, cutFrom) + before.slice(cutTo) || destinationArea.value() !== expected) {
    outcome.error = `Partial Accessibility text move between ${names}. Read both windows before continuing; undo the destination insertion there if the source still has its text.`;
    outcome.deliveryVerified = false;
    return outcome;
  }
  // As the single-window move does, leave the moved text selected in its new place.
  attempt(() => destinationArea.select(dest + (insert.startsWith(word) ? 0 : 1), word.length));
  return outcome;
}

function runCrossWindow(request) {
  const { app, from, to, holdMs = 500, steps = 25, settleMs = 1500 } = request;
  let previous, saved, post, release, pressed = false, didPress = false, path = 'none', fallbackReason = null, a, b;
  const started = Date.now(), progress = { wrote: false };
  try {
    if (!Number.isInteger(request.toWindowId) || request.toWindowId <= 0 || request.windowId === undefined || request.toWindowId === request.windowId) {
      throw new Error('toWindowId must name a different window of the same app and requires windowId');
    }
    const target = findApp(app);
    if (!target) throw new Error(`${app} isn't running`);
    const pid = target.processIdentifier, own = windows(true).filter(w => w.pid === pid && w.layer === 0);
    a = resolveWindow(own, request); b = resolveWindow(own, { ...request, windowId: request.toWindowId });
    const aw = axWindow(pid, a), bw = axWindow(pid, b);
    // Coordinates use a screenshot of that same window, never the app's latest one: by window id,
    // or by title when no other window of the app has it.
    const keyedShot = main => {
      const byId = request.screenshotsByWindow && Object.hasOwn(request.screenshotsByWindow, String(main.id)) ? request.screenshotsByWindow[String(main.id)] : undefined;
      if (byId) return byId;
      const unique = own.filter(w => w.title === main.title).length === 1;
      return unique && request.screenshots && Object.hasOwn(request.screenshots, main.title) ? request.screenshots[main.title] : undefined;
    };
    const shotA = keyedShot(a), shotB = keyedShot(b);
    if (coordinate(request.to) && !shotB) {
      throw new Error(`to coordinates for window ${b.id} (${b.title}) need a screenshot of that window, and this session has none keyed to it; nothing was pressed. Use an element number from a read of window ${b.id}, or "end of line N" in its text, or take a screenshot of that window first`);
    }
    const aRequest = { ...request, screenshot: shotA, screenshots: {} };
    const bRequest = { ...request, screenshot: shotB, screenshots: {}, elementLines: request.toElementLines, elementWindow: request.toElementWindow };
    for (const [endpoint, main, r] of [['from', a, aRequest], ['to', b, bRequest]]) {
      if (elementEndpoint(request[endpoint]) && r.elementWindow?.windowId === undefined && own.filter(w => w.title === main.title).length !== 1) {
        throw new Error('element window title is ambiguous; read the exact window again');
      }
    }
    const resolve = (r, win, main, endpoint, known) => semanticPoints(r, pid, win, main, known, endpoint, endpoint === 'from' ? 'selection' : 'area');
    const startState = resolve(aRequest, aw, a, 'from'), endState = resolve(bRequest, bw, b, 'to');
    const verifySemantic = () => {
      for (const [r, win, main, endpoint, state] of [[aRequest, aw, a, 'from', startState], [bRequest, bw, b, 'to', endState]]) {
        const current = resolve(r, win, main, endpoint, state.elements);
        if (state.signature !== current.signature || state.references.length !== current.references.length ||
            state.references.some((el, i) => !$.CFEqual(el, current.references[i]))) throw new Error('drag element, text, selection or geometry changed before input; read both windows again');
      }
    };
    previous = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    raiseWindow(aw); delay(settleMs / 1000);
    const checkBoth = () => { checkWindow(a, pid, aw); return checkWindow(b, pid, bw); };
    checkBoth(); verifySemantic();
    const points = { start: at(a.bounds, startState.from), end: at(b.bounds, endState.to) };
    const exposed = (list, sameAppOnly) => {
      try {
        exposedEndpoints(list, a, points, sameAppOnly, b);
      } catch (error) {
        if (error.systemOverlay) throw error;
        throw new Error(`${error.message}; tile the windows with Window > Move & Resize, then read again`);
      }
    };
    exposed(checkBoth(), true);
    const sourceInfo = dragContent(pid, aw, a.bounds, startState.from, startState.from);
    const sourcePoints = validatePoints(sourceInfo, a.bounds, startState.from, startState.from, app);
    if (!sourcePoints.text) throw new Error('cross-window drag requires selected text in the source window');
    const destinationInfo = dragContent(pid, bw, b.bounds, endState.to, endState.to, true);
    const end = at(b.bounds, endState.to);
    const fields = destinationInfo.areas.filter(area => ['AXTextArea', 'AXTextField'].includes(area.role) && inside(area.bounds, end));
    if (!inside(b.bounds, end) || destinationInfo.toolbars.some(bounds => inside(bounds, end)) || fields.length !== 1) throw new Error('to is outside one destination text content area; nothing was pressed');
    const source = sourcePoints.text, destination = { el: fields[0].el, text: fields[0].el.value() };
    if (typeof destination.text !== 'string') throw new Error('destination text is unavailable');
    const unchanged = () => {
      if (source.el.value() !== source.text || source.el.attributes.byName('AXSelectedText').value() !== source.selected || destination.el.value() !== destination.text) {
        throw new Error('text or selection changed before input; read both windows again');
      }
    };
    const validate = (foreground = false) => { const list = checkBoth(); verifySemantic(); unchanged(); exposed(list, !foreground); return list; };
    const withinBudget = () => { if (Date.now() - started > PRESS_BUDGET_MS) throw new Error('reading both windows took too long to start a drag; read both windows again'); };
    const list = validate();
    const cover = coveringApp(list, a, points);
    if (globalThis.SLEIGHT_ACCESSIBILITY_MOVE !== false) {
      try {
        withinBudget(); validate();
        const outcome = accessibilityCrossWindowMove(axTextArea(pid, points.start, source.el.reference),
          axTextArea(pid, points.end, destination.el.reference), source, destination, end, a, b, progress);
        return JSON.stringify({ ok: !outcome.error, app, windowId: a.id, toWindowId: b.id, from, to, path: 'accessibility', ...outcome });
      } catch (error) {
        if (error?.axCode === -25204 && progress.wrote) { path = 'accessibility'; throw error; }
        unchanged(); fallbackReason = `accessibility move unavailable: ${error.message || error}`;
      }
    }
    let sequence;
    if (!cover) try {
      const build = backgroundBuilder(), event = (type, p) => build(type, p, a);
      sequence = [event(5, points.start), event(1, points.start), ...Array.from({ length: steps }, (_, i) => event(6, {
        x: points.start.x + (points.end.x - points.start.x) * (i + 1) / steps,
        y: points.start.y + (points.end.y - points.start.y) * (i + 1) / steps,
      })), event(2, points.end)];
    } catch (error) { fallbackReason = `background unavailable: ${error.message || error}`; }
    if (sequence) {
      path = 'background'; withinBudget(); validate();
      post = item => { $.CGEventSetTimestamp(item.event, $.NSProcessInfo.processInfo.systemUptime * 1e9); $.CGEventPostToPid(pid, item.event); };
      release = sequence.at(-1);
      let postingError;
      try {
        post(sequence[0]); delay(0.05);
        if (coveringApp(validate(), a, points)) throw new Error('another app now covers a drag endpoint; background mouse-down was skipped');
        pressed = true; didPress = true; post(sequence[1]); delay(holdMs / 1000);
        for (const item of sequence.slice(2, -1)) { post(item); delay(0.02); }
      } catch (error) { postingError = String(error.message || error); }
      finally { if (pressed) { try { post(release); pressed = false; } catch (error) { throw new Error(`background release failed: ${error.message}; read both windows before continuing`); } } }
      delay(0.2);
      const outcome = finishCrossWindowDrop(source, destination, a, b);
      if (outcome.textChanged || (postingError && didPress)) return JSON.stringify({ ok: !outcome.error && !postingError, app, windowId: a.id, toWindowId: b.id,
        path, ...outcome, ...(postingError ? { error: [outcome.error, postingError].filter(Boolean).join('; ') } : {}) });
      fallbackReason = postingError ? `background unavailable before press: ${postingError}` : 'background text unchanged';
    }
    unchanged(); waitForIdle(); unchanged();
    path = 'foreground'; saved = $.CGEventGetLocation($.CGEventCreate(null));
    const focusedAt = Date.now();
    target.activateWithOptions(0); raiseWindow(aw); delay(settleMs / 1000);
    validate(true); withinBudget();
    post = e => $.CGEventPost($.kCGHIDEventTap, e);
    const event = (type, p) => { const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(p.x, p.y), $.kCGMouseButtonLeft); $.CGEventSetIntegerValueField(e, 1, 1); return e; };
    post(event(5, points.start)); delay(0.05);
    if (typedSince(focusedAt)) throw new Error('the user typed while the app was in front; nothing was pressed. Read both windows again and tell the user');
    validate(true); release = event(2, points.start); pressed = true; didPress = true; post(event(1, points.start)); delay(holdMs / 1000);
    for (let i = 1; i <= steps; i++) {
      const p = { x: points.start.x + (end.x - points.start.x) * i / steps, y: points.start.y + (end.y - points.start.y) * i / steps };
      release = event(2, p); post(event(6, p)); delay(0.02);
    }
    post(release); pressed = false; delay(0.2);
    const outcome = finishCrossWindowDrop(source, destination, a, b);
    if (typedSince(focusedAt)) outcome.error = [outcome.error, 'the user typed during the drag; read both windows again and tell the user'].filter(Boolean).join('; ');
    return JSON.stringify({ ok: !outcome.error, app, windowId: a.id, toWindowId: b.id, from, to, path, fallbackReason, ...outcome });
  } catch (error) {
    // A timed-out read after input or a text write proves nothing either way, as in the single-window path.
    if ((didPress || progress.wrote) && error?.axCode === -25204) return JSON.stringify({ ok: false, path, fallbackReason, deliveryVerified: false,
      error: `cannot verify the drop between window ${a?.id} (${a?.title}) and window ${b?.id} (${b?.title}); read both windows before continuing` });
    return JSON.stringify({ ok: false, path, fallbackReason, deliveryVerified: false,
      error: String(error.message || error) + (didPress || String(error.message).includes('nothing was pressed') ? '' : '; nothing was pressed') });
  } finally {
    if (pressed && post) attempt(() => post(release));
    if (saved) attempt(() => $.CGWarpMouseCursorPosition(saved));
    if (previous && !previous.isNil() && (path === 'foreground' || attempt(() => $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, null) !== previous.processIdentifier)) attempt(() => previous.activateWithOptions(0));
  }
}

function run(argv) {
  let previous = null, saved = null, pid = null, pressed = false, didPress = false, post = null, current = null, relocated = null;
  let path = 'none', fallbackReason = null, units = {};
  let backgroundSnapshot = null, scanned = null;
  // The launcher stops this process at 30 s, maybe mid-press. Never start a press late.
  const startedAt = Date.now();
  const withinBudget = () => {
    if (Date.now() - startedAt > PRESS_BUDGET_MS) throw new Error(`reading the window took over ${PRESS_BUDGET_MS / 1000} s, too close to the 30 s limit to start a drag; nothing was pressed. Read the window again, then retry once`);
  };
  const unchangedText = () => {
    if (backgroundSnapshot && (backgroundSnapshot.el.value() !== backgroundSnapshot.text ||
        backgroundSnapshot.el.attributes.byName('AXSelectedText').value() !== backgroundSnapshot.selected)) {
      throw new Error('text or selection changed before foreground fallback; foreground mouse-down was skipped, read the window again');
    }
  };
  try {
    const request = JSON.parse(argv[0]);
    handPid = Number.isSafeInteger(request.handPid) && request.handPid > 0 ? request.handPid : 0;
    const { app, from, to, holdMs = 500, steps = 25, settleMs = 1500 } = request;
    if (!(coordinate(from) || elementEndpoint(from) || selectionEndpoint(from)) ||
        !(coordinate(to) || elementEndpoint(to) || lineEndpoint(to)) ||
        (request.windowId !== undefined && !Number.isSafeInteger(request.windowId)) ||
        !Number.isInteger(steps) || steps < 1 || steps > 100 || !Number.isInteger(holdMs) || holdMs < 0 || holdMs > 5000 ||
        !Number.isInteger(settleMs) || settleMs < 0 || settleMs > 5000) throw new Error('invalid drag points, windowId or timing');
    if (request.toWindowId !== undefined) return runCrossWindow(request);
    const target = findApp(app);
    if (!target) throw new Error(`${app} isn't running`);
    pid = target.processIdentifier;
    const own = windows(true).filter(w => w.pid === pid && w.layer === 0);
    if (!own.length || (request.windowId !== undefined && !own.some(w => w.id === request.windowId))) {
      const offScreen = windows(false).filter(w => w.pid === pid && w.layer === 0 && (request.windowId === undefined || w.id === request.windowId));
      if (offScreen.length) throw new Error(`${app}'s window is off screen, on another desktop or Space (or hidden/minimized); nothing was pressed. Ask the user to show and unminimize this exact window on the current desktop. Drag needs it on screen. Then acquire the app again, take a fresh window screenshot, and use its current windowId and coordinates. Do not retry the old drag or switch to another window`);
      if (!own.length) throw new Error(`${app} has no window; open one on the current desktop before dragging`);
      // Claude passed a handle's number (3) and a tree index (0) as windowId in 2 of 4 textedit-drag
      // runs (2026-10-17), each refused and retried. With one window there is nothing to choose.
      if (own.length === 1) {
        units = { note: `windowId ${request.windowId} matched no window; used the app's only window ${own[0].id}` };
        request.windowId = own[0].id;
      }
    }
    let main = resolveWindow(own, request);
    const scale = screenshotScale(request, main.bounds, main.title);
    const semantic = !coordinate(from) || !coordinate(to);
    if ([from, to].some(elementEndpoint) && request.elementWindow?.windowId === undefined &&
        own.filter(w => w.title === main.title).length !== 1) throw new Error('element window title is ambiguous; read the exact window again');
    const win = semantic ? axWindow(pid, main) : null;
    const resolved = semantic ? semanticPoints(request, pid, win, main) : null;
    let pointFrom = resolved ? resolved.from : toPoints(from, scale), pointTo = resolved ? resolved.to : toPoints(to, scale);
    const verifySemantic = () => { if (resolved) checkSemantic(resolved, request, pid, chosenWindow, main); };
    // Name the frame Claude's numbers were read in, not the internal pixels-per-point factor. In
    // both Firefox settings runs (2026-10-17) Claude retried drags sent in the shown image's frame,
    // and `screenshotScale: 2` sat beside Claude Code's "multiply by 1.28". The size here is the
    // one Claude Code calls the original.
    units = { ...units, ...scale ? { coordinates: `engine screenshot pixels, ${scale.size[0]} × ${scale.size[1]}` }
      : { coordinates: request.screenshot ? 'window points: the latest screenshot is of another window size' : 'window points: no engine screenshot of this app yet' } };
    // A drag no other app lets through is decided before any window scan: without selected text it
    // is refused below anyway, and the raise and scan took 10 to 13 s to get there (2026-10-09).
    const listed = windows(true);
    let early = coveringApp(listed, main, { start: at(main.bounds, pointFrom), end: at(main.bounds, pointTo) });
    if (early && !focusedSelection(pid)) {
      // Plan around the covering window: an exposed point inside the same element, or a refusal.
      const moved = relocateCovered(listed, main, { start: at(main.bounds, pointFrom), end: at(main.bounds, pointTo) },
        coveredEndpoint(pid, main, resolved, request));
      if (moved.refusal) throw new Error(COVERED_NO_TEXT(early, moved.refusal));
      pointFrom = [moved.start.x - main.bounds.X, moved.start.y - main.bounds.Y];
      pointTo = [moved.end.x - main.bounds.X, moved.end.y - main.bounds.Y];
      relocated = moved.recheck;
      units = { ...units, relocated: moved.moved, note: [units.note, `${moved.moved.join(' and ')} moved to an exposed point inside the same element (window points ${moved.moved.map(n => (n === 'from' ? pointFrom : pointTo).map(v => Math.round(v * 10) / 10).join(', ')).join(' and ')})`].filter(Boolean).join('; ') };
      early = coveringApp(windows(true), main, { start: moved.start, end: moved.end });
      if (early) throw new Error(COVERED_NO_TEXT(early, '; the moved points are still covered'));
    }
    const chosenWindow = win || axWindow(pid, main);
    let build;
    try { build = backgroundBuilder(); }
    catch (e) { fallbackReason = `background unavailable: ${e.message || e}`; }
    if (build || globalThis.SLEIGHT_ACCESSIBILITY_MOVE !== false) {
      previous = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      raiseWindow(chosenWindow);
      delay(settleMs / 1000);
      checkWindow(main, pid, chosenWindow);
      verifySemantic();
      scanned = { info: dragContent(pid, chosenWindow, main.bounds, pointFrom, pointTo), bounds: main.bounds };
      const points = validatePoints(scanned.info, main.bounds, pointFrom, pointTo, app);
      scanned.text = !!points.text;
      if (points.text) points.text.pid = pid;
      // Another document of this app must not receive the press: check fresh
      // own-app order at both ends, then other apps' coverage below.
      const ordered = checkWindow(main, pid, chosenWindow);
      exposedEndpoints(ordered, main, points, true);
      // The window server picks the drop target from what is on screen at the
      // drop point, so a window another app covers never receives a background
      // drop (0/3 covered, 3/3 uncovered, 2026-10-05). Chess ignored our covered
      // posts too (0/2, 2026-10-09), though the engine's app.drag moved the same
      // pawn there. Go straight to foreground.
      const cover = coveringApp(ordered, main, points);
      // Without selected text this tool has no hold to offer, and its foreground path missed Chess
      // in every covered run of the 2026-10-09 head-to-head. Keep the pointer and say what works.
      if (cover && !points.text) throw new Error(COVERED_NO_TEXT(cover));
      if (cover) fallbackReason = `background skipped: ${cover} covers the window at the drag points`;
      // A text move can be done without any pointer at all: the foreground
      // path took the owner's pointer and focus mid-sentence (2026-10-08). The write
      // is followed by settleAfterTextWrite, without which TextEdit's next save could
      // deadlock. The tests turn it off where they test the other paths.
      const byAccessibility = () => {
        if (globalThis.SLEIGHT_ACCESSIBILITY_MOVE === false) return null;
        verifySemantic();
        let area;
        try { area = axTextArea(pid, points.end); }
        catch (e) { fallbackReason = [fallbackReason, `accessibility move unavailable: ${e.message || e}`].filter(Boolean).join('; '); return null; }
        try {
          const outcome = accessibilityMove(area, points.text, points.end, main);
          path = 'accessibility';
          return JSON.stringify({ ok: !outcome.error, app, windowId: main.id, from, to, ...units, path, fallbackReason, ...outcome });
        } catch (e) {
          if (/changed before the move|inside the selection/.test(String(e.message))) throw e;
          fallbackReason = [fallbackReason, `accessibility move failed: ${e.message || e}`].filter(Boolean).join('; ');
          return null;
        }
      };
      // Selected text uses the same pointer-free path in every app.
      if (points.text) {
        const moved = byAccessibility();
        if (moved) return moved;
      }
      let sequence;
      if (!cover && build) try {
        const moves = Array.from({ length: steps }, (_, i) => ({
          x: points.start.x + (points.end.x - points.start.x) * (i + 1) / steps,
          y: points.start.y + (points.end.y - points.start.y) * (i + 1) / steps,
        }));
        // Prepare and validate every event, including the release, before down.
        const event = (type, p) => build(type, p, main);
        // One stationary move on the destination before the release: raw mouse input without it never got an
        // accepted dragover on the target, so the drop was missing 6/6 and one extra move fixed 6/6 (headless
        // Chromium, 2026-10-18). The hold and the step spacing are unchanged.
        sequence = [event(5, points.start), event(1, points.start),
          ...moves.map(p => event(6, p)), event(6, points.end), event(2, points.end)];
      } catch (e) { fallbackReason = `background unavailable: ${e.message || e}`; }
      if (sequence) {
        path = 'background';
        post = item => {
          $.CGEventSetTimestamp(item.event, $.NSProcessInfo.processInfo.systemUptime * 1e9);
          $.CGEventPostToPid(pid, item.event);
        };
        let postingError, releaseError;
        withinBudget();
        verifySemantic();
        // The exposed points were chosen before the raise and the settle wait; hold them to the same tests now.
        const stale = relocated && relocated(windows(true));
        if (stale) throw new Error(`${stale} since it was chosen; read the window again; nothing was pressed`);
        try {
          post(sequence[0]); delay(0.05);
          // Mark down before posting, so a posting exception still releases.
          pressed = true; didPress = true; current = sequence[sequence.length - 1];
          post(sequence[1]); delay(holdMs / 1000);
          for (const item of sequence.slice(2, -1)) { post(item); delay(0.02); }
          post(current); pressed = false;
        } catch (e) { postingError = String(e.message || e); }
        finally {
          if (pressed) {
            try { post(current); }
            catch (e) { releaseError = `background release failed: ${e.message || e}; read the window before continuing`; }
            pressed = false;
          }
        }
        delay(0.2);
        // An unreadable snapshot is not unchanged. Never repeat an uncertain or
        // changed edit, even if posting or the spacing repair failed.
        const after = points.text ? points.text.el.value() : null;
        if (points.text && typeof after !== 'string') throw new Error('cannot verify background text; read the window before continuing');
        if (releaseError) {
          const outcome = finishTextDrop(points.text, main);
          return JSON.stringify({ ok: false, path, app, windowId: main.id, ...units, ...outcome,
            error: [outcome.error, releaseError].filter(Boolean).join('; ') });
        }
        if ((!points.text && (!postingError || didPress)) || (points.text && after !== points.text.text)) {
          const outcome = finishTextDrop(points.text, main);
          if (postingError && !outcome.error) outcome.error = postingError;
          return JSON.stringify({ ok: !outcome.error, app, windowId: main.id, from, to, ...units, holdMs, steps, path, fallbackReason,
            textChanged: points.text ? true : null, deliveryVerified: !!points.text && !outcome.error, ...outcome });
        }
        fallbackReason = !points.text && postingError ? `background unavailable: ${postingError}` : 'background text unchanged';
        backgroundSnapshot = points.text;
        unchangedText();
      }
    }
    unchangedText();
    // A drag that was covered and moved to exposed points was only cleared for background posting.
    if (relocated) throw new Error(`background posting did not work${fallbackReason ? ` (${fallbackReason})` : ''}; the foreground path would take the pointer of the person at the Mac and this drag was covered, so it was not tried${didPress ? '. The background drag was posted and the content did not change; read the window before continuing' : '; nothing was pressed'}`);
    waitForIdle();
    unchangedText();
    path = 'foreground';
    const ws = $.NSWorkspace.sharedWorkspace;
    previous = previous || ws.frontmostApplication;
    saved = $.CGEventGetLocation($.CGEventCreate(null));
    const focusedAt = Date.now();
    target.activateWithOptions(0);
    // AXRaise alone can leave another stacked document as the app's main window.
    // Some apps expose AXMain as read-only, so coverage still decides whether
    // the raise succeeded. Never ignore a covering window of the same app.
    raiseWindow(chosenWindow);
    // Right after the engine acts (say, selecting the text), a press that comes
    // at once doesn't take; 2 s later it does (2026-10-04). Wait for things to settle.
    delay(settleMs / 1000);
    main = windows(true).find(w => w.id === main.id && w.pid === pid && w.layer === 0);
    if (!main || !sameBounds(frame(chosenWindow), main.bounds)) throw new Error('the chosen window changed or disappeared; read it again');
    verifySemantic();
    // Reuse a text scan while the window hasn't moved; non-text endpoints are cheap to recheck.
    const info = scanned?.text && sameBounds(scanned.bounds, main.bounds) ? scanned.info
      : dragContent(pid, chosenWindow, main.bounds, pointFrom, pointTo);
    const { start, end, text } = validatePoints(info, main.bounds, pointFrom, pointTo, app);
    if (text) text.pid = pid;
    // Match the exact window at both endpoints, even for another window of
    // the same app. The engine cursor overlay lets events through.
    const currentWindows = windows(true);
    const unchanged = currentWindows.find(w => w.id === main.id && w.pid === pid);
    if (!unchanged || !sameBounds(unchanged.bounds, main.bounds)) throw new Error('the chosen window moved during validation; read it again');
    exposedEndpoints(currentWindows, main, { start, end }, false);
    withinBudget();
    post = (type, p) => {
      const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(p.x, p.y), $.kCGMouseButtonLeft);
      $.CGEventSetIntegerValueField(e, 1, 1); // click state
      $.CGEventPost($.kCGHIDEventTap, e);
    };
    post($.kCGEventMouseMoved, start);
    current = start;
    delay(0.05);
    if (typedSince(focusedAt)) throw new Error(`the user typed while ${app} was in front, so their keys may have gone into it; nothing was pressed. Read the window again before continuing, and tell the user`);
    unchangedText();
    verifySemantic();
    post($.kCGEventLeftMouseDown, start);
    pressed = true; didPress = true;
    delay(holdMs / 1000);
    for (let i = 1; i <= steps; i++) {
      current = { x: start.x + (end.x - start.x) * i / steps, y: start.y + (end.y - start.y) * i / steps };
      post($.kCGEventLeftMouseDragged, current);
      delay(0.02);
    }
    post($.kCGEventLeftMouseUp, end);
    pressed = false;
    delay(0.2);
    const outcome = finishTextDrop(text, main);
    if (typedSince(focusedAt)) {
      outcome.error = [outcome.error, `the user typed during the drag while ${app} was in front, so their keys may have gone into it. Read the window again and tell the user`].filter(Boolean).join('; ');
    }
    return JSON.stringify({ ok: !outcome.error, app, windowId: main.id, from, to, ...units, holdMs, steps, path, fallbackReason, ...outcome });
  } catch (e) {
    if (didPress && e?.axCode === -25204) return JSON.stringify({ ok: false, path, fallbackReason, ...units,
      deliveryVerified: false, error: 'cannot verify the drop; read the window before continuing' });
    const message = String(e.message || e);
    return JSON.stringify({ ok: false, path, fallbackReason, ...units, error: message + (!didPress && !/nothing was pressed/i.test(message) ? '; nothing was pressed' : '') });
  } finally {
    if (pressed && post) attempt(() => post($.kCGEventLeftMouseUp, current));
    if (saved) attempt(() => $.CGWarpMouseCursorPosition(saved));
    if (previous && !previous.isNil() && previous.processIdentifier !== pid &&
        (path === 'foreground' || attempt(() => $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier, null) === pid)) {
      attempt(() => previous.activateWithOptions(0));
    }
  }
}
