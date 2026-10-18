import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ ObjC: { import() {} }, Application: () => ({}) });
vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
// const declarations in the script are in its scope, not on the context object.
const topAt = vm.runInContext('topAt', context), COVERED_NO_TEXT = vm.runInContext('COVERED_NO_TEXT', context);
const plain = value => JSON.parse(JSON.stringify(value));
const win = { id: 11, pid: 7, owner: 'Firefox', title: 'Settings', layer: 0, bounds: { X: 0, Y: 0, Width: 800, Height: 600 } };
const cover = (X, Y, Width, Height) => ({ id: 33, pid: 9, owner: 'Finder', title: '', layer: 0, bounds: { X, Y, Width, Height } });
const row = { X: 10, Y: 100, Width: 700, Height: 30 };
const exposedIn = list => p => { const top = topAt(list, p); return !!top && top.id === win.id && top.pid === win.pid; };

test('the exposed point is inside the same element and the nearest one to the original', () => {
  const list = [cover(300, 90, 120, 60), win];
  const original = { x: 360, y: 115 };
  const p = plain(context.exposedPointIn(row, original, exposedIn(list), () => true));
  assert.ok(p.x >= row.X && p.x <= row.X + row.Width && p.y >= row.Y && p.y <= row.Y + row.Height, JSON.stringify(p));
  assert.equal(exposedIn(list)(p), true);
  assert.equal(p.x < 300 || p.x >= 420, true);
  // Nearest: no exposed grid point is closer to the original than this one.
  const grid = context.candidatePoints(row, original).filter(exposedIn(list));
  assert.deepEqual(p, plain(grid[0]));
});

test('a fully covered element has no exposed point', () => {
  const list = [cover(0, 90, 800, 60), win];
  assert.equal(context.exposedPointIn(row, { x: 360, y: 115 }, exposedIn(list), () => true), null);
});

test('a point Accessibility resolves to another element is skipped, and the tests are bounded', () => {
  const list = [cover(300, 90, 120, 60), win];
  let tested = 0;
  assert.equal(context.exposedPointIn(row, { x: 360, y: 115 }, exposedIn(list), () => { tested++; return false; }), null);
  assert.equal(tested, 6);
  const rejectedLeft = plain(context.exposedPointIn(row, { x: 360, y: 115 }, exposedIn(list), p => p.x > 420));
  assert.ok(rejectedLeft.x > 420);
});

test('relocation moves only the covered endpoint and keeps the element, the window and the coverage test', () => {
  const list = [cover(300, 90, 120, 60), win];
  const points = { start: { x: 40, y: 115 }, end: { x: 360, y: 115 } };
  const asked = [];
  const result = plain(context.relocateCovered(list, win, points, (name, point) => { asked.push(name); return { rect: row, role: 'AXRow', leaf: false, frame: () => row, accepts: () => true }; }));
  assert.deepEqual(asked, ['to']);
  assert.deepEqual(result.moved, ['to']); assert.deepEqual(result.start, points.start);
  assert.equal(exposedIn(list)(result.end), true);
  assert.ok(result.end.x >= row.X && result.end.x <= row.X + row.Width);
});

test('relocation refuses a covered element with no exposed part, a container, or an unknown element', () => {
  const points = { start: { x: 40, y: 50 }, end: { x: 360, y: 115 } };
  const element = (rect, role = 'AXRow', leaf = false) => () => ({ rect, role, leaf, accepts: () => true });
  const full = [cover(0, 90, 800, 60), win];
  assert.match(context.relocateCovered(full, win, points, element(row)).refusal, /to is covered by Finder and no part of that element is exposed/);
  const partial = [cover(300, 90, 120, 60), win];
  assert.match(context.relocateCovered(partial, win, points, element(row, 'AXOutline')).refusal, /is not a single item/);
  for (const role of ['AXList', 'AXGroup', 'AXGrid', 'AXBrowser', 'AXTabGroup', 'AXRadioGroup', 'AXLayoutArea', 'AXSheet', 'AXWebArea']) {
    assert.match(context.relocateCovered(partial, win, points, element(row, role, false)).refusal, /is not a single item/, role);
  }
  assert.match(context.relocateCovered(partial, win, points, element(row, 'AXImage', false)).refusal, /is not a single item/);
  assert.equal(context.relocateCovered(partial, win, points, element(row, 'AXImage', true)).refusal, undefined);
  assert.match(context.relocateCovered(partial, win, points, element({ X: 0, Y: 0, Width: 800, Height: 600 })).refusal, /too large/);
  assert.match(context.relocateCovered(partial, win, points, () => null).refusal, /no element is known/);
});

test('relocation does nothing for an endpoint that only the same app covers or nothing covers', () => {
  const sameApp = { ...cover(300, 90, 120, 60), pid: 7, owner: 'Firefox' };
  const points = { start: { x: 40, y: 115 }, end: { x: 360, y: 115 } };
  const result = plain(context.relocateCovered([sameApp, win], win, points, () => assert.fail('asked')));
  assert.deepEqual(result.moved, []); assert.deepEqual(result.end, points.end);
});

test('the covered refusal names the endpoint and stops a repeated engine fallback', () => {
  const message = COVERED_NO_TEXT('Finder', '; to is covered by Finder and no part of that element is exposed');
  assert.match(message, /Finder covers the window at the drag points, and this drag has no selected text; to is covered/);
  assert.match(message, /Use the engine's app\.drag in js once/);
  assert.match(message, /don't repeat it: stop and tell the user.*nothing was pressed$/);
});

test('exposure keeps four points from another app\'s window edge and counts every layer', () => {
  const exposed = context.exposedAt;
  const near = { ...cover(0, 90, 300, 60), layer: 0 };
  assert.equal(exposed([near, win], win, { x: 303, y: 115 }), false);
  assert.equal(exposed([near, win], win, { x: 304, y: 115 }), true);
  assert.equal(exposed([{ ...near, layer: 25 }, win], win, { x: 100, y: 115 }), false);
  assert.equal(exposed([{ ...near, layer: 20, owner: 'Dock' }, win], win, { x: 310, y: 115 }), true);
  // A window behind the target, or one of the same app, never counts against clearance.
  assert.equal(exposed([win, near], win, { x: 100, y: 115 }), true);
  assert.equal(exposed([{ ...near, pid: 7 }, win], win, { x: 100, y: 115 }), false, 'same-app window on top still covers');
});

test('recheck refuses when a relocated point is covered again, the element moved, or the hit changed', () => {
  const list = [cover(300, 90, 120, 60), win];
  const points = { start: { x: 40, y: 50 }, end: { x: 360, y: 115 } };
  const state = { frame: row, hit: true };
  const result = context.relocateCovered(list, win, points, () => ({ rect: row, role: 'AXRow', leaf: true, frame: () => state.frame, accepts: () => state.hit }));
  assert.equal(result.recheck(list), null);
  assert.match(result.recheck([cover(0, 90, 800, 60), win]), /covered again/);
  assert.match(result.recheck([{ ...cover(0, 90, 800, 60), layer: 25 }, win]), /covered again/);
  state.frame = { ...row, Y: row.Y + 20 };
  assert.match(result.recheck(list), /moved/);
  state.frame = row; state.hit = false;
  assert.match(result.recheck(list), /no longer on the same element/);
});
