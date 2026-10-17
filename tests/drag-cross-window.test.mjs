import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Replace only AX/CG and the native text-area adapter; run() keeps the real guards and path ordering.
function fixture(options = {}) {
  const events = [], writes = [], activations = [], settles = [], restored = [];
  const frames = [{ X: 100, Y: 100, Width: 600, Height: 400 }, { X: 750, Y: 100, Width: 500, Height: 400 }];
  if (options.stacked) frames[1] = { ...frames[0] };
  const area = (id, value, selected) => ({ id, AXRole: 'AXTextArea', AXValue: value, AXSelectedText: selected,
    AXPosition: { x: frames[id - 11].X + 5, y: 130 }, AXSize: { width: 480, height: 365 }, AXChildren: [] });
  const a = area(11, 'alpha beta\n', 'alpha'), b = area(12, 'gamma delta\n', '');
  a.range = { location: 0, length: 5 }; b.range = { location: 0, length: 0 };
  const wins = [a, b].map((el, i) => {
    const win = { AXRole: 'AXWindow', AXWindowNumber: i + 11, AXTitle: `${i + 11}.txt`, AXChildren: [el],
      AXPosition: { x: frames[i].X, y: 100 }, AXSize: { width: frames[i].Width, height: 400 } };
    el.AXParent = win; return win;
  });
  const list = items => ({ count: items.length, objectAtIndex: i => items[i] });
  const target = { processIdentifier: 7, activateWithOptions: () => { activations.push(7); options.onActivate?.({ a, b, frames }); } };
  const previous = { processIdentifier: 99, isNil: () => false, activateWithOptions() {} };
  const app = { AXWindows: wins, AXFocusedUIElement: b };
  let order = [12, 11], delayed = 0;
  const applyDrop = () => {
    if (options.unchanged) return;
    a.AXValue = ' beta\n'; a.AXSelectedText = '';
    if (!options.lost) b.AXValue = 'gamma delta alpha\n';
  };
  const $ = Object.assign(value => value, {
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout: () => 0, CFEqual: (x, y) => x === y,
    AXUIElementCopyAttributeValue: (el, key, out) => {
      if (options.readbackTimeout && events.some(e => e.type === 2) && el === b && key === 'AXValue') return -25204;
      if (!(key in el)) return -25205;
      out[0] = Array.isArray(el[key]) ? list(el[key]) : el[key]; return 0;
    },
    AXUIElementCopyElementAtPosition: (_app, x, y, out) => {
      const el = [a, b].find(el => x >= el.AXPosition.x && x < el.AXPosition.x + el.AXSize.width && y >= 130);
      out[0] = el ?? wins.find(w => x >= w.AXPosition.x && x < w.AXPosition.x + w.AXSize.width);
      return out[0] ? 0 : -25212;
    },
    AXUIElementSetAttributeValue: (el, key, value) => { el[key] = value; return 0; },
    AXUIElementPerformAction: (el) => { const id = el.AXWindowNumber; order = [id, ...order.filter(n => n !== id)]; return 0; },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return true; },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { bytes, mutableBytes: bytes }; } },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: previous } }, NSProcessInfo: { processInfo: { systemUptime: 1 } },
    CGPointMake: (x, y) => ({ x, y }), CGEventGetLocation: () => ({ x: 1, y: 2 }), CGEventCreate: () => ({}), CGWarpMouseCursorPosition: p => restored.push(p),
    CGEventSourceSecondsSinceLastEventType: (_state, type) => options.busy && type !== 10 ? 0 : options.typing && activations.length && type === 10 ? 0 : 60,
    kCGEventMouseMoved: 5, kCGEventLeftMouseDown: 1, kCGEventLeftMouseDragged: 6, kCGEventLeftMouseUp: 2,
    CGEventCreateMouseEvent: (_src, type, point) => ({ type, point }), CGEventSetIntegerValueField() {},
    CGEventPost: (_tap, e) => { events.push({ ...e, foreground: true }); if (e.type === 2) applyDrop(); },
    CGEventSetTimestamp() {}, CGEventPostToPid: (_pid, e) => {
      events.push(e);
      if (options.postFail === e.type) throw new Error('posting failed');
      if (e.type === 2 && !options.postedUnchanged) applyDrop();
    },
  });
  const context = vm.createContext({ $, Ref: () => [], ObjC: { import() {}, bindFunction() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v },
    delay: () => { if (++delayed === 1) options.onSettle?.({ a, b, frames }); },
    Application: () => assert.fail('cross-window selection must not use app focus or Apple events'),
    SLEIGHT_ACCESSIBILITY_MOVE: options.ax !== false });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
  context.findApp = () => target;
  context.windows = () => [
    ...(options.cover ? [{ id: 50, pid: 99, title: 'cover', owner: 'Other', layer: 0, bounds: frames[1] }] : []),
    ...order.filter(id => !(options.foreign && id === 12)).map(id => ({ id, pid: 7, title: `${id}.txt`, owner: 'Editor', layer: 0, bounds: { ...frames[id - 11] } })),
  ];
  context.backgroundBuilder = () => {
    if (options.lateCover) options.cover = true;
    if (options.noPosting) throw new Error('no window-local API');
    return (type, point, window) => ({ event: { type, point, windowId: window.id } });
  };
  context.axTextArea = (_pid, point, reference) => {
    const el = reference ?? (point.x < 750 ? a : b);
    const x = el.AXPosition.x;
    return {
      value: () => el.AXValue,
      selection: () => ({ ...el.range }),
      lineRange: n => n === 0 ? { location: 0, length: el.AXValue.length } : null,
      hasAttributes: () => !!options.formatted,
      rect: i => ({ X: x + i * 8, Y: 130, Width: 8, Height: 14 }),
      indexAt: p => Math.min(Math.floor((p.x - x) / 8), el.AXValue.length - 1), lineEnd: () => el.AXValue.length,
      replace: (at, length, text) => {
        if (options.rangeSideEffects) { el.range = { location: at, length }; el.AXSelectedText = el.AXValue.slice(at, at + length); }
        if (options.failWrite === writes.length + 1) throw new Error('write unavailable');
        writes.push([el.id, at, length, text]);
        if (!options.ignoreWrites) el.AXValue = el.AXValue.slice(0, at) + text + el.AXValue.slice(at + length);
        options.afterWrite?.({ a, b, writes });
      },
      select: (location, length) => { el.range = { location, length }; el.AXSelectedText = el.AXValue.slice(location, location + length); }, settle: () => settles.push(7),
    };
  };
  const run = (change = {}) => JSON.parse(context.run([JSON.stringify({ app: 'Editor', windowId: 11, toWindowId: 12,
    from: 'the current text selection', to: 'end of line 1', holdMs: 0, settleMs: 0, steps: 2, ...change })]));
  return { run, context, a, b, frames, wins, events, writes, activations, settles, restored };
}

test('cross-window AX move finds A selection while B has focus and inserts at B line end', () => {
  const h = fixture(), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'accessibility'); assert.equal(r.toWindowId, 12);
  assert.equal(h.a.AXValue, 'beta\n'); assert.equal(h.b.AXValue, 'gamma delta alpha\n');
  assert.deepEqual(h.writes, [[12, 11, 0, ' alpha'], [11, 0, 6, '']]);
  assert.equal(h.settles.length, 1); assert.equal(h.events.length, 0); assert.equal(h.activations.length, 0);
});

test('destination coordinates use B screenshot scale even when A and B differ in size', () => {
  const h = fixture(), r = h.run({ from: [14, 37], to: [190, 74], screenshots: { '11.txt': [600, 400], '12.txt': [1000, 800] } });
  assert.equal(r.ok, true, r.error); assert.equal(h.b.AXValue, 'gamma delta alpha\n');
});

test('each endpoint number uses its own window read, including the same number in both', () => {
  const h = fixture(); h.a.AXTitle = 'source'; h.b.AXTitle = 'destination';
  const r = h.run({ from: 4, to: 4, elementLines: { 4: 'text entry area source' }, elementWindow: { title: '11.txt', windowId: 11 },
    toElementLines: { 4: 'text entry area destination' }, toElementWindow: { title: '12.txt', windowId: 12 } });
  assert.equal(r.ok, true, r.error); assert.equal(h.a.AXValue.trim(), 'beta');
});

for (const [name, change, setup] of [
  ['missing source windowId', { windowId: undefined }, {}], ['same window', { toWindowId: 11 }, {}],
  ['fractional destination', { toWindowId: 12.5 }, {}], ['foreign destination', {}, { foreign: true }],
  ['source title bar', { from: [20, 10] }, {}], ['destination title bar', { to: [20, 10] }, {}],
  ['destination outside', { to: [600, 40] }, {}], ['wrong destination read', { to: 4, toElementLines: { 4: 'text entry area destination' }, toElementWindow: { title: '11.txt', windowId: 11 } }, {}],
  ['covered destination of same app', {}, { stacked: true }],
]) test(`cross-window refuses ${name} before any edit or press`, () => {
  const h = fixture(setup), r = h.run(change);
  assert.equal(r.ok, false); assert.equal(h.writes.length, 0); assert.equal(h.events.length, 0);
  if (setup.stacked) assert.match(r.error, /tile the windows with Window > Move & Resize, then read again/);
});

test('source selection must be unique within A and non-blank', () => {
  for (const duplicate of [false, true]) {
    const h = fixture();
    if (duplicate) h.wins[0].AXChildren.push({ ...h.a }); else h.a.AXSelectedText = ' ';
    assert.equal(h.run().ok, false); assert.equal(h.writes.length + h.events.length, 0);
  }
});

for (const [name, mutate] of [
  ['destination geometry', h => { h.frames[1].X++; }],
  ['destination text', h => { h.b.AXValue = 'owner edit\n'; }],
  ['source selection', h => { h.a.AXSelectedText = 'beta'; }],
]) test(`cross-window rechecks ${name} after raising A`, () => {
  const h = fixture({ onSettle: mutate }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.writes.length + h.events.length, 0);
});

test('posted drag uses global B endpoint with A event tags and verifies both values', () => {
  const h = fixture({ ax: false }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background'); assert.equal(r.deliveryVerified, true);
  assert.equal(h.events.at(-1).point.x, 842); assert.ok(h.events.every(e => e.windowId === 11));
  assert.equal(h.activations.length, 0);
});

test('lost text names both windows and never retries in foreground', () => {
  const h = fixture({ ax: false, lost: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.lostText, true); assert.match(r.error, /11.*12/);
  assert.equal(h.activations.length, 0); assert.equal(h.events.filter(e => e.type === 1).length, 1);
});

test('a destination readback timeout is unverified and cannot trigger a second drag', () => {
  const h = fixture({ ax: false, readbackTimeout: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.deliveryVerified, false); assert.equal(h.activations.length, 0);
});

test('foreground fallback checks endpoint against B and restores the pointer', () => {
  const h = fixture({ ax: false, postedUnchanged: true }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'foreground');
  assert.equal(h.activations.length, 1); assert.ok(h.events.at(-1).point.x > 750);
  assert.deepEqual(h.restored, [{ x: 1, y: 2 }]);
});

test('foreground refuses busy input and owner edits in either window', () => {
  for (const options of [{ busy: true }, { typing: true }, { onActivate: h => { h.b.AXValue = 'owner edit\n'; } }]) {
    const h = fixture({ ax: false, noPosting: true, ...options }), r = h.run();
    assert.equal(r.ok, false); assert.equal(h.events.filter(e => e.type === 1).length, 0);
  }
});

test('partial AX insert reports both windows without deleting or posting again', () => {
  const h = fixture({ failWrite: 2 }), r = h.run();
  assert.equal(r.ok, false); assert.match(r.error, /11.*12/); assert.equal(h.a.AXValue, 'alpha beta\n');
  assert.equal(h.b.AXValue, 'gamma delta alpha\n'); assert.equal(h.events.length, 0); assert.equal(h.settles.length, 1);
});

test('ignored destination AX insert leaves source intact and permits the posted path', () => {
  const h = fixture({ ignoreWrites: true }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background');
  assert.equal(h.writes.filter(([id]) => id === 11).length, 0);
});

test('formatted source selection skips plain AX writes', () => {
  const h = fixture({ formatted: true }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background'); assert.equal(h.writes.length, 0);
});

test('failure before background mouse-down permits guarded foreground fallback', () => {
  const h = fixture({ ax: false, postFail: 5 }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'foreground');
  assert.equal(h.events.filter(e => e.type === 1).length, 1);
});

test('uncertain background release never repeats the drag in foreground', () => {
  const h = fixture({ ax: false, postFail: 2 }), r = h.run();
  assert.equal(r.ok, false); assert.equal(r.deliveryVerified, false); assert.equal(h.activations.length, 0);
  assert.equal(h.events.filter(e => e.type === 1).length, 1);
});

test('destination coverage is labeled to and names tiling as recovery', () => {
  const h = fixture({ stacked: true }), r = h.run();
  assert.match(r.error, /to is covered/); assert.equal(h.writes.length + h.events.length, 0);
});

test('a preexisting copy in B cannot conceal lost text from A', () => {
  const h = fixture({ ax: false }); h.b.AXValue = 'gamma delta alpha\n';
  const r = h.run();
  assert.equal(r.ok, false); assert.equal(r.lostText, true); assert.equal(h.activations.length, 0);
});

test('an owner edit between destination insertion and source deletion stops the move', () => {
  const h = fixture({ afterWrite: h => { h.a.AXValue = 'owner alpha beta\n'; } }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.writes.length, 1); assert.equal(h.a.AXValue, 'owner alpha beta\n');
  assert.equal(h.events.length, 0);
});

test('covering another app at B permits AX but forbids background posting', () => {
  const ax = fixture({ cover: true }); assert.equal(ax.run().path, 'accessibility');
  const h = fixture({ ax: false, cover: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.events.filter(e => e.type === 1).length, 0);
});

test('another app covering B after event construction stops background mouse-down', () => {
  const h = fixture({ ax: false, lateCover: true }), r = h.run();
  assert.equal(r.ok, false); assert.equal(h.events.filter(e => e.type === 1).length, 0);
});

test('a repeated selected string does not hide a changed source selection range', () => {
  const h = fixture({ afterWrite: h => { h.a.range = { location: 6, length: 5 }; } });
  h.a.AXValue = 'alpha alpha beta\n';
  const r = h.run();
  assert.equal(r.ok, false); assert.equal(h.writes.length, 1); assert.equal(h.a.AXValue, 'alpha alpha beta\n');
});

test('ignored native AX insertion restores its own range change before posted fallback', () => {
  const h = fixture({ ignoreWrites: true, rangeSideEffects: true }), r = h.run();
  assert.equal(r.ok, true, r.error); assert.equal(r.path, 'background'); assert.equal(h.activations.length, 0);
});
