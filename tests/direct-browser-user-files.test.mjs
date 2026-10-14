import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const api = await import('../plugins/sleight/lib/direct-browser/files.mjs').catch(() => ({}));
const identity = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn', leaseGeneration: 1,
  target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
function fixture(t, messageText = path => `Upload "${path}" to Resume`) {
  assert.equal(typeof api.createUserFileProvider, 'function');
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'p2-user-file-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.txt'); writeFileSync(path, 'approved bytes');
  let time = 100, live = identity;
  const user = {}, provider = api.createUserFileProvider({ now: () => time, current: () => live,
    readUserMessage: event => event === user ? { session: 'client', text: messageText(path) } : null,
    resolveInput: ref => ref === 'rresume' ? { ...identity, ref, name: 'Resume' } : null });
  return { provider, user, path, expire() { time += 30001; }, change() { live = { ...identity, document: 2 }; } };
}
test('exact authenticated user path and input produce an opaque byte-backed single-use file stage', async t => {
  const f = fixture(t), handle = f.provider.offer(f.user, [f.path], 'rresume');
  assert.match(handle, /^f[A-Za-z0-9_-]+$/); assert.doesNotMatch(handle, /fixture\.txt/);
  const binding = { ...identity, operation: 'upload', ref: 'rresume' };
  const stage = await f.provider.stage([handle], binding);
  assert.equal(stage.payloads[0].buffer.toString(), 'approved bytes');
  await assert.rejects(f.provider.stage([handle], binding));
  assert.deepEqual(stage.cleanup(), { retained: false });
});
for (const text of [path => `Do not upload "${path}" to Resume`, path => `Upload "${path}.backup" to Resume`,
  path => `Upload "${path}" to Resume history`]) test('a mention alone is not exact file intent: ' + text('').slice(0, 32), t => {
  const f = fixture(t, text); assert.throws(() => f.provider.offer(f.user, [f.path], 'rresume'));
});
for (const cause of ['page', 'different-input', 'expiry', 'changed-document', 'changed-bytes']) test('file provider refuses ' + cause, async t => {
  const f = fixture(t);
  if (cause === 'page') { assert.throws(() => f.provider.offer({}, [f.path], 'rresume')); return; }
  if (cause === 'different-input') { assert.throws(() => f.provider.offer(f.user, [f.path], 'rother')); return; }
  const handle = f.provider.offer(f.user, [f.path], 'rresume');
  if (cause === 'expiry') f.expire(); if (cause === 'changed-document') f.change();
  if (cause === 'changed-bytes') writeFileSync(f.path, 'different bytes');
  await assert.rejects(f.provider.stage([handle], { ...identity, operation: 'upload', ref: 'rresume' }));
});
test('session teardown cleans retained owned staging even after lease loss', async t => {
  const f = fixture(t), handle = f.provider.offer(f.user, [f.path], 'rresume');
  const stage = await f.provider.stage([handle], { ...identity, operation: 'upload', ref: 'rresume' });
  f.change(); const receipt = f.provider.dispose();
  assert.equal(receipt.retained, 0); assert.equal(stage.receipt().retained, false);
});
