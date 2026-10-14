import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../plugins/sleight/lib/direct-browser/lifecycle.mjs';

const identity = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn',
  leaseGeneration: 1, target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
function fixture(options = {}) {
  assert.equal(typeof api.createSemanticLifecycle, 'function', 'P2 reader/form lifecycle join is absent');
  let current = identity, readDisposed = false, formDisposed = false;
  const calls = [], pending = new Set(['o1']);
  const strict = value => new Proxy(value, { get(o, key) {
    if (key in o || typeof key === 'symbol' || key === 'then') return o[key];
    throw Error('unsupported P2 method ' + key);
  } });
  const reader = strict({ acknowledge(id) { calls.push(['acknowledge', id]); return !readDisposed && pending.delete(id); },
    dispose() { readDisposed = true; calls.push(['reader-dispose']); return options.dispose?.(); } });
  const form = strict({ pendingRead(id, scope) { assert.deepEqual(scope, identity); calls.push(['pendingRead', id]); },
    deliveredRead(id, scope) { assert.deepEqual(scope, identity); calls.push(['deliveredRead', id]); return !formDisposed; },
    dispose() { formDisposed = true; calls.push(['form-dispose']); }, cleanup() { return { retained: options.retained ?? 0 }; } });
  const lifecycle = api.createSemanticLifecycle({ session: 'client' });
  lifecycle.register({ tab: 't1', identity, current: () => current, reader, form,
    cleanup: options.cleanup ?? (() => ({ cleanup: [{ resource: 'owned-target', target: 'target', status: 'closed', absenceVerified: true }] })) });
  return { lifecycle, calls, current: value => { current = value; }, reader, form };
}
const delivery = { operation: 'op1', name: 'browser_read', tab: 't1', observation: { observation: 'o1', complete: false, data: [] } };
test('successful incomplete P2 read exposes its refs and clears only the bound form submit fence', () => {
  const f = fixture(); assert.equal(f.lifecycle.delivered(delivery), true);
  assert.deepEqual(f.calls, [['acknowledge', 'o1'], ['pendingRead', 'o1'], ['deliveredRead', 'o1']]);
  assert.equal(f.lifecycle.delivered(delivery), false);
});
test('an open observation exposes refs without clearing an existing submit fence', () => {
  const f = fixture(); assert.equal(f.lifecycle.delivered({ ...delivery, name: 'browser_open' }), true);
  assert.deepEqual(f.calls, [['acknowledge', 'o1']]);
});
for (const [name, patch] of [['foreign tab', { tab: 'tforeign' }], ['omitted output', { observation: { omitted: true } }],
  ['unknown observation', { observation: { observation: 'oforged' } }]]) test(name + ' cannot expose another reader or release submit recovery', () => {
  const f = fixture(); assert.equal(f.lifecycle.delivered({ ...delivery, ...patch }), false);
  assert.ok(!f.calls.some(call => call[0] === 'deliveredRead'));
});
test('a replaced document cannot acknowledge the previous read', () => {
  const f = fixture(); f.current({ ...identity, document: 2 }); assert.equal(f.lifecycle.delivered(delivery), false);
  assert.deepEqual(f.calls, []);
});
test('cross-session and duplicate tab registration refuse before borrowing P2 resources', () => {
  const f = fixture();
  assert.throws(() => f.lifecycle.register({ tab: 't2', identity: { ...identity, clientSession: 'foreign' },
    current: () => identity, reader: f.reader, form: f.form }), /SEMANTIC_BINDING_REQUIRED/);
  assert.throws(() => f.lifecycle.register({ tab: 't1', identity, current: () => identity, reader: f.reader, form: f.form }), /SEMANTIC_BINDING_REQUIRED/);
});
test('revoke disposes both P2 components before returning and keeps retained form cleanup', async () => {
  const f = fixture({ retained: 2 }); assert.equal(f.lifecycle.revoke(), true);
  assert.deepEqual(f.calls, [['reader-dispose'], ['form-dispose']]);
  assert.equal(f.lifecycle.delivered(delivery), false);
  const receipt = await f.lifecycle.cleanup();
  assert.equal(receipt.cleanup.find(row => row.resource === 'form-journal').status, 'retained');
  assert.equal(receipt.cleanup.find(row => row.resource === 'form-journal').count, 2);
  assert.equal(receipt.cleanup.find(row => row.resource === 'owned-target').absenceVerified, true);
});
test('missing or failed target cleanup remains retained and an explicit retry can collect it', async () => {
  let complete = false;
  const f = fixture({ cleanup: () => { if (!complete) throw Error('private path'); return { cleanup: [{ target: 'target', status: 'closed', absenceVerified: true }] }; } });
  f.lifecycle.revoke(); const first = await f.lifecycle.cleanup();
  assert.equal(first.cleanup.at(-1).status, 'retained'); assert.doesNotMatch(JSON.stringify(first), /private path/);
  complete = true; assert.equal((await f.lifecycle.cleanup()).cleanup.at(-1).status, 'closed');
});
test('cleanup before revocation and asynchronous revocation cannot report full cleanup', async () => {
  const f = fixture({ dispose: () => Promise.resolve() });
  assert.equal((await f.lifecycle.cleanup()).cleanup[0].status, 'retained');
  assert.equal(f.lifecycle.revoke(), false);
  assert.equal((await f.lifecycle.cleanup()).cleanup[0].status, 'retained');
});
for (const cleanup of [[], [{ target: 'target', status: 'closed' }], [{ target: 'foreign', status: 'closed', absenceVerified: true }]]) {
  test('empty, close-only and foreign cleanup cannot substitute for exact owned absence ' + JSON.stringify(cleanup), async () => {
    const f = fixture({ cleanup: () => ({ cleanup }) }); f.lifecycle.revoke();
    assert.equal((await f.lifecycle.cleanup()).cleanup.at(-1).status, 'retained');
  });
}
