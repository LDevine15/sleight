import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';
import * as hooks from '../plugins/sleight/lib/direct-browser/lifecycle.mjs';

async function fixture(t) {
  const read = new PassThrough(), write = new PassThrough(), frames = []; let ends = 0, revoked = false;
  write.on('data', bytes => frames.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, verifyResume: () => false,
    packageCurrent: () => true, status: () => 'connected', redact: value => value,
    client: { request: () => ({ completed: 1, effect: 'verified', observation: { complete: true } }) },
    endSession: () => { ends++; revoked = true; return { revoked: true, cleanup: [{ resource: 'owned-target', status: 'retained' }] }; } });
  assert.equal(typeof hooks.createTurnHookChannel, 'function', 'authenticated fixed hook is absent');
  const channel = hooks.createTurnHookChannel({ frontend, read, write, session: 's1', turn: 'turn1', brokerEpoch: 1 });
  t.after(() => channel.close());
  return { channel, read, write, frames, frontend, ends: () => ends, revoked: () => revoked,
    send(value) { read.write(JSON.stringify(value) + '\n'); } };
}
for (const mutate of [value => ({ ...value, session: 's2' }), value => ({ ...value, turn: 'turn2' }),
  value => ({ ...value, brokerEpoch: 2 }), value => ({ ...value, nonce: 'a'.repeat(64) }),
  value => ({ ...value, event: 'resume' }), value => ({ ...value, approved: true })]) {
  test('forged turn hook cannot finish another session, resume or grant input ' + mutate.toString(), async t => {
    const f = await fixture(t), hook = { ...f.frames[0], event: 'end' };
    f.send(mutate(hook)); assert.equal(f.ends(), 0);
    assert.equal((await f.frontend.call({ name: 'browser_read', arguments: { tab: 't1' } })).completed, 1);
    f.send(hook); assert.equal(f.revoked(), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.frames.at(-1).cleanup[0].status, 'retained');
  });
}
test('authentic fixed hook consumes once, revokes synchronously and preserves cleanup uncertainty', async t => {
  const f = await fixture(t), hook = { ...f.frames[0], event: 'end' };
  f.send(hook); assert.equal(f.revoked(), true); f.send(hook);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ends(), 1);
  assert.equal((await f.frontend.call({ name: 'browser_read', arguments: { tab: 't1' } })).error.code, 'LEASE_LOST');
  assert.equal(f.frames.at(-1).revoked, true); assert.equal(f.frames.at(-1).cleanup[0].status, 'retained');
});
test('loss of the private inherited turn pipe fences the exact frontend', async t => {
  const f = await fixture(t); f.read.end();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.revoked(), true); assert.equal(f.ends(), 1);
});
test('a project object cannot install a fixed turn hook', () => {
  assert.throws(() => hooks.createTurnHookChannel({ frontend: { end() {} }, read: new PassThrough(), write: new PassThrough(),
    session: 's1', turn: 'turn1', brokerEpoch: 1 }), /TRUSTED_ROUTE_REQUIRED/);
});

test('late errors on the owned hook pipes cannot crash the relay after revocation', async t => {
  const f = await fixture(t);
  f.send({ ...f.frames[0], event: 'end' });
  assert.doesNotThrow(() => f.write.emit('error', Error('owned pipe lost')));
  assert.doesNotThrow(() => f.read.emit('error', Error('owned pipe lost')));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.ends(), 1);
});
