import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProbeTrials, nativeProbe, fixtureDriver, main } from '../bench/xd1-probe.mjs';

// main() requires the macOS private temporary bank; the driver tests need any private dir.
const mainSkip = process.platform !== 'darwin' && 'the probe requires the macOS private temporary bank';
const scratch = tmpdir();

function fixture(pass = []) {
  const closed = [], moved = [], snapshots = [];
  let current;
  return { closed, moved, snapshots, driver: {
    async setup(variant, trial) { current = { variant, trial }; return { ...current }; },
    async snapshot(pair) { snapshots.push(pair.variant); return { source: 'alpha beta\n', destination: 'gamma delta\n' }; },
    async move(pair, variant) { moved.push(variant); return { pass: pass.includes(variant) }; },
    async judge(pair, before, after, reply) { return reply.pass; },
    async close(pair) { closed.push([pair.variant, pair.trial]); return true; },
  } };
}

test('probe runs three fresh trials per background variant and omits foreground when posted A passes', async () => {
  const h = fixture(['V2']), rows = await runProbeTrials(h.driver);
  assert.equal(rows.length, 9); assert.equal(rows.filter(r => r.variant === 'V2' && r.pass).length, 3);
  assert.deepEqual(h.moved, ['V1', 'V1', 'V1', 'V2', 'V2', 'V2', 'V3', 'V3', 'V3']);
  assert.equal(h.closed.length, 9); assert.equal(h.snapshots.length, 18);
});

test('foreground control runs only when no background variant passes all three trials', async () => {
  const none = fixture(), rows = await runProbeTrials(none.driver);
  assert.equal(rows.length, 12); assert.equal(none.moved.filter(v => v === 'V4').length, 3);
  for (const pass of [['V1'], ['V3']]) {
    const h = fixture(pass);
    assert.equal((await runProbeTrials(h.driver)).length, 9, pass[0]); assert.equal(h.moved.includes('V4'), false);
  }
});

test('failed move still records both snapshots and closes its exact pair', async () => {
  const h = fixture(['V2']);
  h.driver.move = async () => { throw new Error('posting failed'); };
  const rows = await runProbeTrials(h.driver);
  assert.equal(rows.length, 12); assert.equal(rows[0].error, 'posting failed'); assert.ok(rows[0].before); assert.ok(rows[0].after);
  assert.equal(h.closed.length, 12);
});

test('unconfirmed owned-window closure stops all later trials and preserves the evidence row', async () => {
  const h = fixture(), saved = [];
  h.driver.close = async () => false;
  await assert.rejects(runProbeTrials(h.driver, rows => saved.push(structuredClone(rows))), /cleanup/);
  assert.equal(saved.at(-1).length, 1); assert.equal(saved.at(-1)[0].cleanup, false);
});

test('a cleanup exception is recorded before stopping later trials', async () => {
  const h = fixture(), saved = [];
  h.driver.close = async () => { throw new Error('close timed out'); };
  await assert.rejects(runProbeTrials(h.driver, rows => saved.push(structuredClone(rows))), /cleanup/);
  assert.equal(saved.at(-1)[0].cleanup, false); assert.equal(saved.at(-1)[0].cleanupError, 'close timed out');
});

test('the native probe sends no Apple events and its snapshot names no window outside the fixture', () => {
  assert.doesNotMatch(nativeProbe, /(?<![A-Za-z])Application\(|\.documents\(|doc\.path/);
  const owner = 'Owner Secret.txt';
  const context = vm.createContext({
    attempt: (fn, fallback) => { try { return fn(); } catch { return fallback; } },
    axAttribute: () => 'focused', axElement: reference => ({ reference, name: () => owner }), ObjC: { unwrap: v => v },
    windows: () => [{ id: 50, pid: 9, layer: 0, title: owner }, { id: 51, pid: 9, layer: 0, title: 'Other' }, { id: 11, pid: 7, layer: 0, title: 'Source' },
      { id: 60, pid: 7, layer: 0, title: owner }, { id: 12, pid: 7, layer: 0, title: 'Target' }],
    $: { AXUIElementCreateApplication: () => ({}), CFEqual: (x, y) => x === y, CGEventCreate: () => ({}), CGEventGetLocation: () => ({ x: 1, y: 2 }),
      NSWorkspace: { sharedWorkspace: { frontmostApplication: { bundleIdentifier: 'org.example.Other' } } } },
  });
  vm.runInContext(nativeProbe, context);
  const side = (id, value) => ({ win: { reference: `win${id}` }, main: { id, pid: 7, title: id === 11 ? 'Source' : 'Target' },
    el: { value: () => value, attributes: { byName: () => ({ value: () => 'alpha' }) } } });
  const snapshot = context.probeSnapshot({ pid: 7, pair: [side(11, 'alpha beta\n'), side(12, 'gamma delta\n')] });
  assert.equal(snapshot.keyWindow, 'other'); assert.deepEqual([...snapshot.order], ['other', 'source', 'same app', 'destination']);
  assert.doesNotMatch(JSON.stringify(snapshot), /Secret/);
});

function fakeFixtures({ closeFails = false, openFails = 0 } = {}) {
  const opened = [], closed = [];
  return { opened, closed,
    open: async (ctx, request) => { if (openFails && opened.length + 1 === openFails) throw new Error('fixture setup failed'); opened.push({ ctx, request }); return {}; },
    close: async ctx => { closed.push(ctx); if (closeFails) throw new Error('Owned TextEdit fixture window cleanup unconfirmed'); } };
}
const passingNative = async request => request.op === 'place' ? { ok: true, pid: 7, windowIds: [11, 12] }
  : request.op === 'snapshot' ? { source: ' beta\n', destination: 'gamma delta alpha\n' } : { ok: true };

test('each trial opens its own nonce documents through openFixture and closes them through closeFixtures', async () => {
  const dir = mkdtempSync(join(scratch, 'xd1r-driver-')), f = fakeFixtures();
  try {
    const driver = fixtureDriver({ dir, nonce: 'n0nce', native: passingNative, open: f.open, close: f.close, settleMs: 0 });
    const pair = await driver.setup('V1', 2);
    assert.equal(f.opened.length, 2);
    for (const [i, { ctx, request }] of f.opened.entries()) {
      assert.equal(ctx, pair.ctx); assert.equal(request.target, pair.paths[i]); assert.match(basename(request.target), /n0nce-V1-2\.txt$/);
      assert.equal(request.token, basename(request.target)); assert.equal(request.mode, 'document');
      assert.equal(request.bundle, 'com.apple.TextEdit'); assert.equal(request.stopOnLiveHold, true);
      assert.ok(request.target.startsWith(dir + '/'));
    }
    assert.equal(await driver.close(pair), true); assert.deepEqual(f.closed, [pair.ctx]);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a setup failure closes what opened; an unconfirmed close is marked so the lock stays', async () => {
  const dir = mkdtempSync(join(scratch, 'xd1r-driver-'));
  try {
    for (const closeFails of [false, true]) {
      const f = fakeFixtures({ openFails: 2, closeFails });
      const driver = fixtureDriver({ dir, nonce: `n${closeFails}`, native: passingNative, open: f.open, close: f.close, settleMs: 0 });
      const error = await driver.setup(closeFails ? 'V2' : 'V1', 1).then(() => assert.fail('setup should fail'), e => e);
      assert.equal(f.closed.length, 1); assert.equal(error.cleanupUnconfirmed === true, closeFails); assert.equal(error.cleanupConfirmed === true, !closeFails);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

function liveHarness({ holdChecks = 0, closeFails = false, holdAfterTrial = 0 } = {}) {
  const events = [], f = fakeFixtures({ closeFails }), dir = mkdtempSync('/private/tmp/xd1r-main-');
  let checks = 0;
  const deps = { open: f.open, close: f.close, native: passingNative, settleMs: 0, log() {}, makeDir: () => dir,
    exists: path => {
      if (path !== '/tmp/sleight-hold') return false;
      checks++; return checks <= holdChecks || (holdAfterTrial > 0 && f.closed.length >= holdAfterTrial);
    },
    sleep: async ms => { events.push(['sleep', ms]); },
    takeLock: async (path, options) => { events.push(['lock', path, options.wait]); return async () => { events.push(['release']); }; } };
  return { deps, events, f, dir, output: `${dir}/results.json`, done: () => { process.exitCode = undefined; rmSync(dir, { recursive: true, force: true }); } };
}

test('main waits out the hold, then takes the live lock and releases it after confirmed cleanup', { skip: mainSkip }, async () => {
  const h = liveHarness({ holdChecks: 3 });
  try {
    const rows = await main(h.output, h.deps);
    assert.deepEqual(h.events.slice(0, 3), [['sleep', 30000], ['sleep', 30000], ['lock', '/tmp/sleight-live.lock', true]]);
    assert.deepEqual(h.events.at(-1), ['release']); assert.equal(h.events.filter(e => e[0] === 'release').length, 1);
    assert.equal(rows.length, 9); assert.equal(rows.some(r => r.variant === 'V4'), false);
    assert.equal(h.f.closed.length, 9);
  } finally { h.done(); }
});

test('main keeps the live lock when fixture cleanup is unconfirmed', { skip: mainSkip }, async () => {
  const h = liveHarness({ closeFails: true });
  try {
    await assert.rejects(main(h.output, h.deps), /cleanup unconfirmed/);
    assert.equal(h.events.some(e => e[0] === 'release'), false); assert.equal(h.f.closed.length, 1);
  } finally { h.done(); }
});

test('a hold that appears mid-run stops before the next trial and still releases after cleanup', { skip: mainSkip }, async () => {
  const h = liveHarness({ holdAfterTrial: 1 });
  try {
    await assert.rejects(main(h.output, h.deps), /interrupted/);
    assert.equal(h.f.closed.length, 1); assert.deepEqual(h.events.at(-1), ['release']);
  } finally { h.done(); }
});

test('interruption waits for the owned move and cleans its pair before stopping later trials', async () => {
  const h = fixture(); let stopping = false, collected = false;
  h.driver.cancelled = () => stopping;
  h.driver.move = async () => { stopping = true; await new Promise(r => setImmediate(r)); collected = true; return { pass: false }; };
  const close = h.driver.close;
  h.driver.close = async pair => { assert.equal(collected, true); return close(pair); };
  await assert.rejects(runProbeTrials(h.driver), /interrupted/); assert.equal(h.closed.length, 1);
});

test('native move honors the cooperative cancellation marker before touching the fixture', () => {
  const context = vm.createContext({ $: { NSFileManager: { defaultManager: { fileExistsAtPath: () => true } } } });
  vm.runInContext(nativeProbe, context);
  const r = JSON.parse(context.run([JSON.stringify({ op: 'move', cancelFile: '/fixture/cancel' })]));
  assert.equal(r.ok, false); assert.match(r.error, /interrupted/);
});

test('a timed-out native child preserves fixtures and stops instead of assuming its release ran', async () => {
  const h = fixture(), saved = [];
  h.driver.move = async () => { throw Object.assign(new Error('native timeout'), { killed: true }); };
  await assert.rejects(runProbeTrials(h.driver, rows => saved.push(structuredClone(rows))), /cleanup/);
  assert.equal(saved.at(-1).length, 1); assert.equal(saved.at(-1)[0].uncertainInput, true);
  assert.equal(saved.at(-1)[0].cleanup, false); assert.equal(h.closed.length, 0);
});
