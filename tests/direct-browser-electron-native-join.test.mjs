import test from 'node:test';
import assert from 'node:assert/strict';
import { app, rect, fakeWindows, nativeWindow } from './fixtures/electron-graph.mjs';

const moduleURL = new URL('../plugins/sleight/lib/direct-browser/electron-native-join.mjs', import.meta.url);
async function load() {
  let module;
  try { module = await import(moduleURL); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  assert.equal(typeof module?.createNativeJoin, 'function', 'EPV3-3 must provide the metadata-only native window join');
  return module;
}
const view = (targetId, frame, extra = {}) => ({ targetId, geometry: { ...frame, scale: 2, visible: true, ...extra } });
async function joined(windows, candidates, options = {}) {
  const { createNativeJoin } = await load(), w = fakeWindows(windows);
  const join = createNativeJoin({ app, approved: () => w.approved, readWindows: w.read, now: () => 1000, ...options });
  return { w, join, result: await join.resolve(candidates) };
}
const statuses = result => Object.fromEntries([...result].map(([id, row]) => [id, row.status + (row.reason ? ':' + row.reason : '')]));

test('two windows of the instance join one renderer each, and a second same-bundle process never joins', async () => {
  const { result } = await joined([
    nativeWindow(11, rect(0, 0)), nativeWindow(12, rect(900, 0)),
    nativeWindow(21, rect(900, 0), { pid: 4200 }), // another instance of the same bundle, same rectangle
    nativeWindow(31, rect(0, 0), { pidBirth: '1700000999.000001' }), // a reused PID
  ], [view('a', rect(0, 0)), view('b', rect(900, 0))]);
  assert.deepEqual(statuses(result), { a: 'joined', b: 'joined' });
  assert.deepEqual(result.get('a').window, { id: 11, epoch: 1 });
  assert.deepEqual(result.get('b').window, { id: 12, epoch: 1 });
});

test('duplicate rectangles and stacked web contents views are ambiguous, so nothing gets input', async () => {
  let { result } = await joined([nativeWindow(11, rect(0, 0)), nativeWindow(12, rect(0, 0))], [view('a', rect(0, 0))]);
  assert.deepEqual(statuses(result), { a: 'ambiguous' });
  ({ result } = await joined([nativeWindow(11, rect(0, 0))], [view('a', rect(0, 0)), view('b', rect(0, 0))]));
  assert.deepEqual(statuses(result), { a: 'ambiguous', b: 'ambiguous' });
  ({ result } = await joined([nativeWindow(11, rect(0, 0))], [view('a', rect(0, 0)), view('b', rect(0, 0), { visible: false })]));
  assert.deepEqual(statuses(result), { a: 'joined', b: 'hidden:not-visible' }, 'a hidden view does not compete for its window');
  assert.equal(result.get('b').window, undefined);
});

test('hidden, minimized and offscreen windows and scale mismatches join nothing', async () => {
  const { result } = await joined([
    nativeWindow(11, rect(0, 0), { onScreen: false }), nativeWindow(12, rect(900, 0), { minimized: true }), nativeWindow(13, rect(0, 700), { scale: 1 }),
  ], [view('a', rect(0, 0)), view('b', rect(900, 0)), view('c', rect(0, 700)), view('d', rect(-5000, -5000))]);
  assert.deepEqual(statuses(result), { a: 'hidden:no-window', b: 'hidden:no-window', c: 'hidden:no-window', d: 'hidden:no-window' });
});

test('the metadata is content-free by schema: a title or any extra key refuses the whole read', async () => {
  for (const extra of [{ title: 'Quarterly plan.docx' }, { document: '/Users/x/plan' }, { value: 'text' }]) {
    const { result } = await joined([nativeWindow(11, rect(0, 0), extra)], [view('a', rect(0, 0))]);
    assert.deepEqual(statuses(result), { a: 'parked:native-metadata-invalid' });
  }
  const { result } = await joined([nativeWindow(11, rect(0, 0)), nativeWindow(11, rect(900, 0))], [view('a', rect(0, 0))]);
  assert.deepEqual(statuses(result), { a: 'parked:native-metadata-invalid' }, 'a repeated window id is malformed');
});

test('a sheet parks its window, stale metadata parks everything, and no engine approval reads nothing', async () => {
  let { result } = await joined([nativeWindow(11, rect(0, 0), { modal: 'sheet' }), nativeWindow(12, rect(900, 0))], [view('a', rect(0, 0)), view('b', rect(900, 0))]);
  assert.deepEqual(statuses(result), { a: 'parked:native-modal', b: 'joined' });
  const { createNativeJoin } = await load(), w = fakeWindows([nativeWindow(11, rect(0, 0))]);
  w.observedAt = 1000 - 5000;
  result = await createNativeJoin({ app, approved: () => true, readWindows: w.read, now: () => 1000 }).resolve([view('a', rect(0, 0))]);
  assert.deepEqual(statuses(result), { a: 'parked:stale' });
  w.approved = false; w.observedAt = undefined;
  const join = createNativeJoin({ app, approved: () => w.approved, readWindows: w.read, now: () => 1000 });
  const reads = w.reads;
  result = await join.resolve([view('a', rect(0, 0))]);
  assert.deepEqual(statuses(result), { a: 'parked:engine-approval' });
  assert.equal(w.reads, reads, 'metadata is read only after the engine approves the app');
});

test('check revalidates the admitted window: a new window epoch, a sheet, or a second matching window stops input', async () => {
  const { w, join } = await joined([nativeWindow(11, rect(0, 0))], []);
  const admitted = { id: 11, epoch: 1 }, geometry = view('a', rect(0, 0)).geometry;
  assert.deepEqual(await join.check('a', admitted, geometry), { window: admitted });
  w.windows = [nativeWindow(11, rect(0, 0), { epoch: 2 })];
  await assert.rejects(join.check('a', admitted, geometry), /ELECTRON_JOIN_CHANGED/);
  w.windows = [nativeWindow(11, rect(0, 0), { modal: 'sheet' })];
  await assert.rejects(join.check('a', admitted, geometry), /ELECTRON_JOIN_PARKED: native-modal/);
  w.windows = [nativeWindow(11, rect(0, 0)), nativeWindow(14, rect(0, 0))];
  await assert.rejects(join.check('a', admitted, geometry), /ELECTRON_JOIN_PARKED: ambiguous/);
  w.windows = [nativeWindow(11, rect(0, 0))];
  await assert.rejects(join.check('a', admitted, { ...geometry, visible: false }), /ELECTRON_JOIN_PARKED: not-visible/);
  await assert.rejects(join.check('a', { id: 11, epoch: 1, extra: 1 }, geometry), /ELECTRON_JOIN_INVALID/);
});

test('invalidation is synchronous and counted; a takeover park holds until resume', async () => {
  const { join } = await joined([nativeWindow(11, rect(0, 0))], []);
  const seen = [];
  const off = join.onChange(reason => seen.push([reason, join.generation()]));
  const before = join.generation();
  join.invalidate('native-change');
  assert.deepEqual(seen, [['native-change', before + 1]]);
  join.park('takeover');
  assert.equal(join.parked(), 'takeover');
  assert.deepEqual(statuses(await join.resolve([view('a', rect(0, 0))])), { a: 'parked:takeover' });
  await assert.rejects(join.check('a', { id: 11, epoch: 1 }, view('a', rect(0, 0)).geometry), /ELECTRON_JOIN_PARKED: takeover/);
  join.resume();
  assert.deepEqual(statuses(await join.resolve([view('a', rect(0, 0))])), { a: 'joined' });
  off(); join.invalidate('x');
  assert.equal(seen.length, 3);
});
