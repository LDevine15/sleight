import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runScript } from '../plugins/sleight/lib/launch.mjs';
import { handPid, setHandPid } from '../plugins/sleight/lib/hand/pid.mjs';

// The ghost hand's panel floats over the target window at any layer. Pinned by the request's handPid,
// it is never cover for a drag endpoint or a hover point.
const HAND = 4242;
const script = name => {
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => ({}) });
  vm.runInContext(readFileSync(new URL(`../plugins/sleight/lib/${name}`, import.meta.url), 'utf8'), context);
  return context;
};
const win = { id: 11, pid: 7, owner: 'Editor', title: 'Notes', layer: 0, bounds: { X: 100, Y: 100, Width: 800, Height: 600 } };
const other = { id: 12, pid: 7, owner: 'Editor', title: 'Draft', layer: 0, bounds: { X: 950, Y: 100, Width: 400, Height: 600 } };
const points = { start: { x: 200, y: 200 }, end: { x: 600, y: 500 } };
const cross = { start: points.start, end: { x: 1100, y: 300 } };
const panel = (X, Y, Width, Height, layer = 3) => ({ id: 90, pid: HAND, owner: 'consent-host', title: '', layer, bounds: { X, Y, Width, Height } });
// The panel is the path's bounding box plus 48 pt, or display-sized, at the floating layer or (should the
// host's level change) layer 0.
const shapes = {
  'over from': panel(152, 152, 96, 96),
  'over to': panel(552, 452, 96, 96),
  'over both': panel(152, 152, 496, 396),
  'whole display': panel(0, 0, 1512, 982),
  'layer 0 over both': panel(152, 152, 1200, 396, 0),
};
const plain = value => JSON.parse(JSON.stringify(value));

function dragChecks(context, hand) {
  const list = [hand, win, other];
  const covered = [];
  for (const [label, check] of [
    ['any app', () => context.exposedEndpoints(list, win, points, false)],
    ['same app', () => context.exposedEndpoints(list, win, points, true)],
    ['cross-window', () => context.exposedEndpoints(list, win, cross, false, other)],
  ]) { try { check(); } catch (error) { covered.push(`${label}: ${error.message}`); } }
  if (context.coveringApp(list, win, points)) covered.push(`coveringApp: ${context.coveringApp(list, win, points)}`);
  const moved = plain(context.relocateCovered(list, win, points, () => null));
  if (moved.refusal || moved.moved.length) covered.push(`relocateCovered: ${moved.refusal || moved.moved}`);
  for (const point of [points.start, points.end]) if (!context.exposedAt(list, win, point)) covered.push(`exposedAt ${point.x},${point.y}`);
  return covered;
}

test('drag reports both endpoints exposed under the pinned hand in 5 of 5 shapes', () => {
  const context = script('drag.js');
  // The request's handPid is the flag: run() takes it before anything else (here findApp has no AppKit).
  JSON.parse(context.run([JSON.stringify({ app: 'Editor', from: [1, 1], to: [2, 2], handPid: HAND })]));
  assert.equal(vm.runInContext('handPid', context), HAND);
  const exposed = Object.entries(shapes).filter(([, hand]) => !dragChecks(context, hand).length).map(([name]) => name);
  assert.deepEqual(exposed, Object.keys(shapes), `exposed in ${exposed.length} of 5`);
});

test('without the pin, the same windows are cover, so the pin is what exempts them', () => {
  const context = script('drag.js');
  JSON.parse(context.run([JSON.stringify({ app: 'Editor', from: [1, 1], to: [2, 2] })]));
  assert.equal(vm.runInContext('handPid', context), 0);
  for (const [name, hand] of Object.entries(shapes)) assert.notDeepEqual(dragChecks(context, hand), [], name);
  // A pid Claude could name is no exemption either: only a positive safe integer pins.
  for (const handPid of [-1, 0, 1.5, '4242', null]) {
    JSON.parse(context.run([JSON.stringify({ app: 'Editor', from: [1, 1], to: [2, 2], handPid })]));
    assert.equal(vm.runInContext('handPid', context), 0, String(handPid));
  }
});

// Hover at the middle of the panel, in window coordinates.
const middle = ({ bounds: b }) => [b.X + b.Width / 2 - win.bounds.X, b.Y + b.Height / 2 - win.bounds.Y];
function hover(hand, request = { app: 'Editor', at: middle(hand), waitMs: 100, handPid: HAND }) {
  const context = script('hover.js');
  context.windowList = () => [hand, win];
  let time = 0;
  const native = Object.assign(context.nativeHover(), {
    now: () => time, idleSeconds: () => 60, typedSince: () => false, screenCaptureAllowed: () => true,
    resolve: () => ({ pid: win.pid }), save: () => ({}), activate() {}, wait: ms => { time += ms; }, move() {},
    capture: () => 'PNG', restorePointer() {}, restoreFront() {},
    point(target, at) { Object.assign(target, { bounds: win.bounds, windowId: win.id, windowTitle: win.title }); return { x: win.bounds.X + at[0], y: win.bounds.Y + at[1] }; },
  });
  return plain(context.performHover(request, native));
}

test('hover reports no cover under the pinned hand in 5 of 5 shapes', () => {
  const clear = Object.entries(shapes).filter(([, hand]) => {
    const result = hover(hand);
    return result.ok && result.blocker === undefined;
  }).map(([name]) => name);
  assert.deepEqual(clear, Object.keys(shapes), `no cover in ${clear.length} of 5`);
  // Unpinned, the same panel is a blocker, and so is any other app's window.
  const unpinned = hover(shapes['over from'], { app: 'Editor', at: middle(shapes['over from']), waitMs: 100 });
  assert.equal(unpinned.ok, false);
  assert.deepEqual(unpinned.blocker, { owner: 'consent-host', pid: HAND, id: 90, layer: 3 });
  assert.equal(hover({ ...shapes['over from'], pid: 9 }).ok, false);
});

test('the launcher sends the hand pid to drag and hover, and never a pid from the call', async t => {
  t.after(() => setHandPid(0));
  const sent = [];
  const run = (_command, args, _options, callback) => { sent.push(JSON.parse(args.at(-1))); callback(null, '{"ok":true}', ''); };
  setHandPid(0);
  await runScript('drag.js', { app: 'Editor', from: [1, 1], to: [2, 2], handPid: 9 }, run);
  await runScript('hover.js', { app: 'Editor', at: [1, 1], handPid: 9 }, run);
  assert.deepEqual(sent.map(request => request.handPid), [undefined, undefined]);
  setHandPid(HAND);
  assert.equal(handPid(), HAND);
  await runScript('drag.js', { app: 'Editor', from: [1, 1], to: [2, 2], handPid: 9 }, run);
  await runScript('hover.js', { app: 'Editor', at: [1, 1] }, run);
  assert.deepEqual(sent.slice(2).map(request => request.handPid), [HAND, HAND]);
});
