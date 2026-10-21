import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as arm from '../bench/electron-arm-server.mjs';
import { createArmCancellation, createArmDrain, runArmWithCancellation } from '../bench/electron-arm-cancellation.mjs';
import { createProtocol } from '../bench/turbo/v3-protocol.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const stateDir = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'arm-cancel-')));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const config = { stateDir, session: 'owned-session', cancelNonce: 'a'.repeat(64) };
  return { config, control: createArmCancellation(config) };
}
test('a cancelled arm refuses startup before creating a worker', async t => {
  const { config, control } = fixture(t); control.request();
  await assert.rejects(arm.createArmSession({ config, control, createWorker: () => assert.fail('no fork') }), /ARM_CANCELLED/);
});
test('drain acknowledgment follows admission closure, accepted call settlement and exact clean worker end', async t => {
  const { config, control } = fixture(t), events = []; let finish;
  const worker = { send: async op => {
    events.push(op);
    if (op === 'start') return { ok: true };
    if (op === 'call') return new Promise(resolve => { finish = () => resolve({ ok: true, result: { text: 'done', isError: false } }); });
    return { ok: true, ended: true, cleanup: [] };
  }, kill() { events.push('collected'); } };
  const protocol = createProtocol({ output: { write(_s, cb) { cb(); } }, tools: [{ name: 'tool' }], validate: x => x,
    start: () => arm.createArmSession({ config, control, worker }) });
  const call = protocol.message({ id: 1, method: 'tools/call', params: { name: 'tool', arguments: {} } });
  for (let n = 0; !finish && n < 20; n++) await tick();
  control.request(); const drain = createArmDrain({ protocol, control }); const stopping = drain.stop();
  await tick(); assert.equal(control.drained(), false);
  await protocol.message({ id: 2, method: 'tools/call', params: { name: 'tool', arguments: {} } });
  finish(); await call; await stopping;
  assert.equal(control.drained(), true); assert.deepEqual(events, ['start', 'call', 'end', 'collected']);
});
for (const reply of [{ ok: false }, { ok: true, ended: true }, { ok: true, ended: true, cleanup: [{ retained: true }] }]) {
  test(`an unconfirmed worker end withholds drain acknowledgment: ${JSON.stringify(reply)}`, async t => {
    const { config, control } = fixture(t);
    const session = await arm.createArmSession({ config, control, worker: { send: async op => op === 'start' ? { ok: true } : reply, kill() {} } });
    const drain = createArmDrain({ control, protocol: { close: () => session.close() } });
    await drain.stop(); assert.equal(control.drained(), false);
  });
}
test('an accepted effect-unknown result cannot become a clean drain acknowledgment', async t => {
  const { config, control } = fixture(t);
  const session = await arm.createArmSession({ config, control, worker: {
    send: async op => op === 'start' ? { ok: true } : op === 'call' ? { ok: false, error: 'V3_WORKER_UNAVAILABLE' } : { ok: true, ended: true, cleanup: [] }, kill() {} } });
  await session.call({});
  await createArmDrain({ control, protocol: { close: () => session.close() } }).stop();
  assert.equal(control.drained(), false);
});
test('a rejected accepted worker call cannot be upgraded by a later successful end', async t => {
  const { config, control } = fixture(t);
  const session = await arm.createArmSession({ config, control, worker: { send: async op => {
    if (op === 'call') throw Error('IPC_LOST');
    return op === 'start' ? { ok: true } : { ok: true, ended: true, cleanup: [] };
  }, kill() {} } });
  await assert.rejects(session.call({}), /IPC_LOST/);
  await createArmDrain({ control, protocol: { close: () => session.close() } }).stop();
  assert.equal(control.drained(), false);
});
test('replacing the private state directory cannot supply a drain acknowledgment', t => {
  const { config, control } = fixture(t), old = config.stateDir + '-original';
  renameSync(config.stateDir, old); t.after(() => rmSync(old, { recursive: true, force: true }));
  mkdirSync(config.stateDir, { mode: 0o700 });
  const replacement = createArmCancellation(config); replacement.acknowledge();
  assert.equal(control.drained(), false);
  assert.throws(() => control.request(), /ARM_CANCEL_STATE_CHANGED/);
});
test('ACK is bound to the run nonce and cannot reverse a latched timeout', async t => {
  const { control } = fixture(t), lifecycle = { cleanupAllowed: true };
  writeFileSync(control.ackPath, JSON.stringify({ version: 1, session: 'owned-session', nonce: 'b'.repeat(64), status: 'drained' }), { mode: 0o600 });
  assert.equal(await control.waitForDrain({ lifecycle, timeoutMs: 0 }), false);
  assert.equal(lifecycle.cleanupAllowed, false); assert.equal(lifecycle.effectUnknown, true);
  rmSync(control.ackPath); control.acknowledge();
  assert.equal(control.drained(), true);
  assert.equal(await control.waitForDrain({ lifecycle, timeoutMs: 0 }), false);
});
test('the private marker and ACK disclose only their exact binding', t => {
  const { control } = fixture(t); control.request(); control.acknowledge();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(control.markerPath))).sort(), ['nonce', 'session', 'version']);
  assert.equal(control.requested(), true);
});
test('the parent marks cancellation immediately and awaits work plus checked drain before returning', async t => {
  const { control } = fixture(t), controller = new AbortController(), lifecycle = { cleanupAllowed: true }; let finish;
  let modelSignal;
  const work = runArmWithCancellation(signal => { modelSignal = signal; return new Promise(resolve => { finish = resolve; }); }, { control, signal: controller.signal, lifecycle, waitMs: 50 });
  controller.abort(); assert.equal(control.requested(), true);
  assert.equal(modelSignal.aborted, false, 'the current call can settle before model-group collection');
  control.acknowledge(); finish({ groupClean: true });
  await assert.rejects(work, /RUN_INTERRUPTED/);
  assert.equal(modelSignal.aborted, true);
  assert.equal(lifecycle.cleanupAllowed, true);
});
test('missing cancellation ACK stops only the model group and retains app/host ownership', async t => {
  const { control } = fixture(t), controller = new AbortController(), lifecycle = { cleanupAllowed: true };
  const work = runArmWithCancellation(signal => new Promise(resolve => signal.addEventListener('abort', () => resolve({ groupClean: true }))),
    { control, signal: controller.signal, lifecycle, waitMs: 0 });
  controller.abort();
  await assert.rejects(work, /ARM_DRAIN_UNCONFIRMED/);
  assert.equal(lifecycle.cleanupAllowed, false); assert.equal(lifecycle.effectUnknown, true);
});
test('a model exit without its exact drain acknowledgment retains every pipe owner', async t => {
  const { control } = fixture(t), lifecycle = { cleanupAllowed: true };
  await assert.rejects(runArmWithCancellation(async () => ({ groupClean: true }), { control, lifecycle, waitMs: 0 }), /ARM_DRAIN_UNCONFIRMED/);
  assert.equal(lifecycle.cleanupAllowed, false); assert.equal(lifecycle.effectUnknown, true);
});
test('clean drain does not upgrade a failed model-group collection', async t => {
  const { control } = fixture(t), lifecycle = { cleanupAllowed: true }; control.acknowledge();
  await assert.rejects(runArmWithCancellation(async () => ({ groupClean: false, signalErrors: [{ code: 'EPERM' }] }), { control, lifecycle, waitMs: 0 }), /ARM_GROUP_UNCONFIRMED/);
  assert.equal(lifecycle.cleanupAllowed, false); assert.equal(lifecycle.modelGroupUnconfirmed, true);
});
