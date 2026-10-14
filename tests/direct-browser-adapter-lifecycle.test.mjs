import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as api from '../plugins/sleight/lib/direct-browser/lifecycle.mjs';
import { createTransportOwner } from '../plugins/sleight/lib/direct-browser/transport-owner.mjs';

const browser = { incarnation: 'browser', brokerEpoch: 1, endpoint: 'ws://127.0.0.1:1/devtools/browser/fixture' };
const target = { ...browser, session: 'client', turn: 'turn', targetId: 'target', targetGeneration: 1,
  leaseGeneration: 1, frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
const lease = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn',
  epoch: 1, target: 'target', cdpSessionId: 'page', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
async function fixture(t, options = {}) {
  assert.equal(typeof api.bindSemanticAdapter, 'function', 'published P2 adapter lifecycle join is absent');
  const root = new EventEmitter(); root.sessionId = 'root'; const calls = []; let exists = true;
  root.send = async (method, params) => {
    calls.push(method);
    if (method === 'Target.closeTarget') { exists = false; return { success: true }; }
    if (method === 'Target.getTargets') return { targetInfos: exists ? [{ targetId: 'target' }] : [] };
    throw Error('unsupported root method ' + method);
  };
  const owner = createTransportOwner({ session: root, checkLease: () => true, helpers: {} });
  const lifecycle = new api.Lifecycle({ verifyConnection: () => true, observeTarget: () => exists ? target : null,
    saveJournal: () => true });
  await lifecycle.connect(root, browser, {});
  const hook = lifecycle.beginTurn('client', 'turn', 'frontend'), capability = lifecycle.track(target, { owned: true, ephemeral: true });
  const delivery = [];
  const adapter = new Proxy({ delivered(bound, observation) { delivery.push({ bound, observation }); return observation === 'o1'; },
    cleanupSession: async id => { assert.equal(id, 'client'); return { closed: options.closed ?? true, retained: options.retained ?? 0, cleanup: [] }; } },
    { get(o, k) { if (k in o || typeof k === 'symbol' || k === 'then') return o[k]; throw Error('unsupported P2 adapter member ' + k); } });
  const bound = api.bindSemanticAdapter({ session: 'client', adapter, transportOwner: owner, lifecycle, hook,
    leaseFor: tab => tab === 't1' ? lease : { ...lease, clientSession: 'foreign' } });
  t.after(() => owner.close());
  return { bound, capability, lifecycle, delivery, calls };
}
test('P3 maps actual delivered read metadata to P2 delivered(lease, observation)', async t => {
  const f = await fixture(t);
  assert.equal(f.bound.delivered({ name: 'browser_read', tab: 't1', observation: { observation: 'o1', complete: false } }), true);
  assert.deepEqual(f.delivery, [{ bound: lease, observation: 'o1' }]);
  assert.equal(f.bound.delivered({ name: 'browser_read', tab: 'tforeign', observation: { observation: 'o1' } }), false);
  assert.equal(f.delivery.length, 1);
});
test('P3 revokes the owner and exact target turn synchronously, then combines P2 and target cleanup', async t => {
  const f = await fixture(t); assert.equal(f.bound.revoke(), true);
  assert.throws(() => f.lifecycle.prepare(f.capability, { operation: 'late', op: 'click' }), /LEASE_LOST/);
  assert.equal(f.bound.delivered({ name: 'browser_read', tab: 't1', observation: { observation: 'o1' } }), false);
  const receipt = await f.bound.cleanup();
  assert.equal(receipt.cleanup.find(row => row.targetId === 'target').absenceVerified, true);
  assert.ok(!receipt.cleanup.some(row => row.status === 'retained'));
});
test('P2 local file/form retention remains visible even when the target and remote objects closed', async t => {
  const f = await fixture(t, { closed: false, retained: 2 }); f.bound.revoke();
  const receipt = await f.bound.cleanup();
  assert.equal(receipt.cleanup.find(row => row.resource === 'semantic-journals').status, 'retained');
  assert.equal(receipt.cleanup.find(row => row.resource === 'semantic-journals').count, 2);
});
test('unbranded owners and a hook from another session cannot bind the P2 adapter', () => {
  assert.equal(typeof api.bindSemanticAdapter, 'function', 'published P2 adapter lifecycle join is absent');
  assert.throws(() => api.bindSemanticAdapter({ session: 'client', adapter: {}, transportOwner: {} }), /TRUSTED_ROUTE_REQUIRED/);
});
test('uncertain input retains its exact target at turn end without fencing unrelated active fields', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.bound.uncertain, 'function', 'unknown target ownership join is absent');
  f.bound.uncertain({ tab: 't1', name: 'browser_act', operation: 'unknown' });
  // Marking cleanup ownership alone must not add an active-field policy gate.
  assert.doesNotThrow(() => f.lifecycle.prepare(f.capability, { operation: 'ordinary', op: 'click' }));
  assert.equal(f.bound.revoke(), true);
  const receipt = await f.bound.cleanup();
  assert.equal(receipt.cleanup.find(row => row.targetId === 'target').status, 'parked');
  assert.equal(f.calls.includes('Target.closeTarget'), false);
});
