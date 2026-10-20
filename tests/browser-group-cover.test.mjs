import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'browser-cover-test-')));
after(() => rmSync(dir, { recursive: true, force: true }));
const roots = [join(dir, 'sleight-bench')];
mkdirSync(roots[0]);

const module = await import('../bench/fowl/group-cover.mjs');
const frame = { x: 592, y: 166, width: 920, height: 436 };
const browser = { pid: 50, start: 10, bundle: 'com.apple.Safari', id: 20, onScreen: true, layer: 0, frame };
const finder = { pid: 26, start: 1, bundle: 'com.apple.finder', name: 'Finder', id: 9, onScreen: true, layer: 0,
  frame: { x: 592, y: 166, width: 460, height: 218 }, title: 'sleight-bench', document: pathToFileURL(roots[0]).href };
const snapshot = windows => ({ apps: [], windows });

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

test('persistent cover or inspection errors release admission after three fake-clock waits', async () => {
  for (const kind of ['owner', 'AX untrusted', 'helper timeout', 'missing browser', 'unconfirmed close', 'dialog']) {
    let reads = 0, elapsed = 0;
    const warnings = [], events = [];
    await module.waitForBrowserUncovered(50, { roots,
      snapshot: async () => {
        reads++;
        if (kind === 'AX untrusted' || kind === 'helper timeout') throw Error(kind);
        return snapshot(kind === 'missing browser' ? [] : [kind === 'owner' ? { ...finder, document: '' } : finder, browser]);
      },
      act: async () => ({ closed: kind === 'dialog', dialog: kind === 'dialog' }),
      log: event => events.push(event), warn: line => warnings.push(line),
      wait: async ms => { elapsed += ms; assert.ok(elapsed <= 180000, 'fourth wait stalled admission'); assert.equal(ms, 60000); },
    });
    assert.equal(elapsed, 180000, kind);
    assert.equal(reads, 4, kind);
    assert.equal(warnings.length, 1, kind);
    assert.doesNotMatch(warnings[0], /\n/);
    assert.equal(events.at(-1).event, 'browser-group-cover-cap', kind);
  }
});

test('engine overlays, Cua Driver, floating windows and sub-five-percent slivers do not wait', async () => {
  const windows = ['ChatGPT Computer Use', 'Cua Driver', 'Dock'].map(name => ({ ...finder, name }));
  windows.push({ ...finder, name: 'Owner', layer: 19 },
    { ...finder, name: 'Owner', frame: { ...frame, width: 45 } });
  assert.deepEqual(module.browserCovers(snapshot([...windows, browser]), 50).covering, []);
  await module.waitForBrowserUncovered(50, { roots, snapshot: async () => snapshot([...windows, browser]),
    act: async () => assert.fail('ignored window closed'), log() {}, wait: async () => assert.fail('ignored window stalled admission') });
  const boundary = module.browserCovers(snapshot([{ ...finder, frame: { ...frame, width: 46 } }, browser]), 50);
  assert.equal(boundary.covering.length, 1);
  assert.equal(boundary.covering[0].fraction, 0.05);
});

test('a hold appearing during a cover wait stops before another inspection or close', async () => {
  let reads = 0, held = false;
  await assert.rejects(module.waitForBrowserUncovered(50, { roots,
    held: () => held, snapshot: async () => { reads++; return snapshot([{ ...finder, document: '' }, browser]); },
    act: async () => assert.fail('owner close'), log() {},
    wait: async () => { if (held) throw Error('hold was ignored'); held = true; },
  }), /Benchmark hold is active/);
  assert.equal(reads, 1);
});

test('fixture paths cannot escape through symlinks, dot traversal or missing symlink descendants', async () => {
  const owner = join(dir, 'owner'); mkdirSync(owner);
  symlinkSync(owner, join(roots[0], 'escape'));
  for (const document of [join(roots[0], 'escape'), join(roots[0], 'escape', 'missing'),
    roots[0] + '/../owner', pathToFileURL(join(roots[0], 'escape')).href]) {
    let reads = 0, waits = 0, actions = 0;
    await module.waitForBrowserUncovered(50, { roots,
      snapshot: async () => snapshot(++reads === 1 ? [{ ...finder, document }, browser] : [browser]),
      act: async () => { actions++; return { closed: false }; }, log() {}, wait: async () => { waits++; } });
    assert.equal(actions, 0, document);
    assert.equal(waits, 1, document);
  }
});

test('fresh fixture window IDs cannot bypass the wait cap with claimed closes', async () => {
  let reads = 0, waits = 0;
  await module.waitForBrowserUncovered(50, { roots,
    snapshot: async () => {
      assert.ok(++reads <= 8, 'new window IDs bypassed the cap');
      return snapshot([{ ...finder, id: 100 + reads }, browser]);
    }, act: async () => ({ closed: true }), log() {}, warn() {},
    wait: async () => { assert.ok(++waits <= 3); } });
  assert.equal(waits, 3);
});
