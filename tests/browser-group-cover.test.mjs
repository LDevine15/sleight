import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../bench/fowl/group-cover.mjs');
const frame = { x: 592, y: 166, width: 920, height: 436 };
const browser = { pid: 50, start: 10, bundle: 'com.apple.Safari', id: 20, onScreen: true, layer: 0, frame };
const finder = { pid: 26, start: 1, bundle: 'com.apple.finder', name: 'Finder', id: 9, onScreen: true, layer: 0,
  frame: { x: 592, y: 166, width: 460, height: 218 }, title: 'sleight-bench', document: 'file:///scratch/sleight-bench' };
const snapshot = windows => ({ apps: [], windows });
const roots = ['/scratch/sleight-bench'];

test('pre-group cover lists only visible overlapping windows in front of the exact browser', () => {
  assert.equal(typeof module.browserCovers, 'function', 'pre-group cover check is missing');
  const other = { ...finder, id: 10, bundle: 'owner.app', name: 'Owner' };
  const got = module.browserCovers(snapshot([finder, { ...other, onScreen: false },
    { ...other, frame: { ...frame, x: 2000 } }, browser, other]), 50);
  assert.equal(got.covering.length, 1);
  assert.equal(got.covering[0].id, 9);
  assert.equal(got.covering[0].fraction, 0.25);
});

test('pre-group check closes only a proven Finder fixture cover then verifies a fresh window list', async () => {
  let windows = [finder, browser];
  const events = [], actions = [];
  await module.waitForBrowserUncovered(50, { roots, snapshot: async () => snapshot(windows),
    act: async action => { actions.push(action); windows = [browser]; return { closed: true }; },
    log: event => events.push(event), wait: async () => assert.fail('no owner cover remains') });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'close');
  assert.equal(actions[0].id, 9);
  assert.equal(actions[0].bundle, 'com.apple.finder');
  assert.deepEqual(actions[0].fixtures.fixturePaths, roots);
  assert.ok(events.some(e => e.covering?.[0]?.fraction === 0.25));
});

test('pre-group check logs and waits for owner covers without pressing their close buttons', async () => {
  for (const window of [{ ...finder, bundle: 'owner.app' }, { ...finder, document: 'file:///owner/sleight-bench' },
    { ...finder, document: '' }, { ...finder, document: 'file:///scratch/sleight-bench-other' }]) {
    let reads = 0, waits = 0;
    await module.waitForBrowserUncovered(50, { roots,
      snapshot: async () => snapshot(++reads === 1 ? [window, browser] : [browser]),
      act: async () => assert.fail('owner window closed'), log() {}, wait: async ms => { waits++; assert.equal(ms, 60000); } });
    assert.equal(waits, 1);
  }
});

test('missing browser, inspection failure and unconfirmed close never release the wait early', async () => {
  for (const kind of ['missing', 'inspection', 'close']) {
    let reads = 0, waits = 0;
    await module.waitForBrowserUncovered(50, { roots, snapshot: async () => {
      if (++reads > 1) return snapshot([browser]);
      if (kind === 'inspection') throw Error('AX unavailable');
      return snapshot(kind === 'missing' ? [] : [finder, browser]);
    }, act: async () => ({ closed: false }), log() {}, wait: async () => { waits++; } });
    assert.equal(waits, 1);
    assert.equal(reads, 2);
  }
});

test('abort stops the cover wait before another inspection or action', async () => {
  const controller = new AbortController();
  await assert.rejects(module.waitForBrowserUncovered(50, { roots, signal: controller.signal,
    snapshot: async () => snapshot([{ ...finder, document: '' }, browser]), act: async () => assert.fail('press'),
    log() {}, wait: async () => controller.abort(Error('interrupted')) }), /interrupted/);
});

test('a claimed close that remains visible waits instead of repeatedly pressing the same window', async () => {
  let reads = 0, presses = 0, waits = 0;
  await module.waitForBrowserUncovered(50, { roots,
    snapshot: async () => snapshot(++reads < 3 ? [finder, browser] : [browser]),
    act: async () => { presses++; return { closed: true }; }, log() {}, wait: async () => { waits++; } });
  assert.equal(presses, 1);
  assert.equal(waits, 1);
});
