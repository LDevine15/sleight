import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runSharedHost } from './fixtures/shared-consent-host.mjs';

const nonce = 'a'.repeat(64), token = 'e'.repeat(32);
const ready = { hand: 'consent-ready', nonce, token };
const reset = { hand: 'consent-reset', nonce, token };
const successor = { id: 'successor', nonce: 'd'.repeat(64) };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fakeHost() {
  const child = new EventEmitter(), writes = [], signals = [];
  child.exitCode = child.signalCode = null;
  child.stdio = Array.from({ length: 5 }, () => new PassThrough());
  child.stdout = child.stdio[1]; child.stderr = child.stdio[2];
  for (const fd of [0, 3]) child.stdio[fd].on('data', data => writes.push([fd, JSON.parse(String(data))]));
  child.finish = (code = 0, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal); };
  child.kill = signal => { signals.push(signal); setImmediate(() => child.finish(null, signal)); return true; };
  return { child, writes, signals, options: { spawnProcess: () => child, timeoutMs: 1000, readyTimeoutMs: 1000, collectTimeoutMs: 1000 } };
}

for (const early of [false, true]) test(`shared fixture waits for the exact delayed ACK before the ${early ? 'early-reset' : 'normal'} successor`, async () => {
  const h = fakeHost();
  const initial = early ? [[3, reset], [0, { hand: 'menu', nonce }]] : [[0, { hand: 'menu', nonce }], [3, reset]];
  const work = runSharedHost('unused-fake-binary', [...initial, ['ready', { nonce, token }], [3, successor]], [], h.options);
  await tick(); assert.equal(h.writes.some(([, row]) => row.id === 'successor'), false);
  const serialized = JSON.stringify(ready) + '\n';
  h.child.stdout.write(serialized.slice(0, 20)); await tick();
  assert.equal(h.writes.some(([, row]) => row.id === 'successor'), false, 'partial JSON is not an ACK');
  h.child.stdout.write(serialized.slice(20)); await tick();
  assert.equal(h.writes.at(-1)[1].id, 'successor');
  h.child.finish(); const result = await work;
  assert.equal(result.code, 0); assert.equal(result.stdout, serialized); assert.deepEqual(h.signals, []);
});

for (const kind of ['wrong-nonce', 'wrong-token', 'extra-key', 'malformed', 'missing', 'early-close']) test(`shared fixture rejects ${kind} ACK and collects its own child before failing`, async () => {
  const h = fakeHost();
  const work = runSharedHost('unused-fake-binary', [[3, reset], ['ready', { nonce, token }], [3, successor]], [], { ...h.options, readyTimeoutMs: 5 });
  const failure = assert.rejects(work, /SHARED_(?:READY|HOST)_/);
  if (kind === 'early-close') h.child.finish(65);
  else if (kind !== 'missing') h.child.stdout.write(kind === 'malformed' ? 'not-json\n' : JSON.stringify({ ...ready,
    ...(kind === 'wrong-nonce' ? { nonce: 'b'.repeat(64) } : {}), ...(kind === 'wrong-token' ? { token: 'f'.repeat(32) } : {}),
    ...(kind === 'extra-key' ? { extra: true } : {}) }) + '\n');
  await failure;
  assert.equal(h.writes.some(([, row]) => row.id === 'successor'), false);
  assert.notEqual(h.child.exitCode === null && h.child.signalCode === null, true, 'failure waits for close, not just a signal request');
  assert.deepEqual(h.signals, kind === 'early-close' ? [] : ['SIGKILL']);
});

test('shared fixture reports unconfirmed collection at a bounded deadline without signaling anything else', async () => {
  const h = fakeHost(); h.child.kill = signal => { h.signals.push(signal); return false; };
  await assert.rejects(runSharedHost('unused-fake-binary', [['ready', { nonce, token }]], [],
    { ...h.options, readyTimeoutMs: 1, collectTimeoutMs: 1 }), /SHARED_HOST_COLLECTION_UNCONFIRMED/);
  assert.deepEqual(h.signals, ['SIGKILL']);
});
test('shared fixture collects its child on the overall timeout even without a ready step', async () => {
  const h = fakeHost();
  await assert.rejects(runSharedHost('unused-fake-binary', [], [], { ...h.options, timeoutMs: 1 }), /SHARED_HOST_TIMEOUT/);
  assert.equal(h.child.signalCode, 'SIGKILL'); assert.deepEqual(h.signals, ['SIGKILL']);
});
test('shared fixture collects its child after a child error', async () => {
  const h = fakeHost(), work = runSharedHost('unused-fake-binary', [], [], h.options);
  const failed = assert.rejects(work, /SHARED_HOST_ERROR/); h.child.emit('error', Error('fake failure'));
  await failed; assert.equal(h.child.signalCode, 'SIGKILL'); assert.deepEqual(h.signals, ['SIGKILL']);
});
