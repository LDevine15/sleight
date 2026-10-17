import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runProbeTrials, nativeProbe } from '../bench/xd1-probe.mjs';

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

test('foreground control runs only when neither posted variant passes all three trials', async () => {
  const h = fixture(['V1']), rows = await runProbeTrials(h.driver);
  assert.equal(rows.length, 12); assert.equal(h.moved.filter(v => v === 'V4').length, 3);
  const retagged = fixture(['V3']);
  assert.equal((await runProbeTrials(retagged.driver)).length, 9);
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

test('native cleanup closes exact owned paths and verifies both original window IDs disappeared', () => {
  for (const refuseSecond of [false, true]) {
    let windows = [11, 12, 99].map(id => ({ id, pid: 7 }));
    const closed = [], docs = [11, 12, 99].map(id => ({ path: () => `/fixture/${id}.txt`, close() {
      closed.push(id); if (!(refuseSecond && id === 12)) windows = windows.filter(w => w.id !== id);
    } }));
    const context = vm.createContext({ findApp: () => ({ processIdentifier: 7 }), Application: () => ({ documents: () => docs }),
      windows: () => windows, delay() {} });
    vm.runInContext(nativeProbe, context);
    const r = JSON.parse(context.run([JSON.stringify({ op: 'close', pid: 7, paths: ['/fixture/11.txt', '/fixture/12.txt'], windowIds: [11, 12] })]));
    assert.equal(r.ok, !refuseSecond, r.error); assert.deepEqual(closed, [11, 12]);
    assert.ok(windows.some(w => w.id === 99));
  }
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
