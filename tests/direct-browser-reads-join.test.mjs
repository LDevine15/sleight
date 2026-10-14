import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';

// Before the production port this exercises the actual reviewed prototype.
const production = process.env.SLEIGHT_P2_BASELINE !== '1' && existsSync(new URL('../plugins/sleight/lib/direct-browser/reads.mjs', import.meta.url));
const { BrowserReads, inspectControl, fixedReadInspectors } = await import(production
  ? '../plugins/sleight/lib/direct-browser/reads.mjs' : '../bench/direct-browser2/reads.mjs');
const identity = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn',
  leaseGeneration: 1, target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
const lease = { target: identity.target, frame: identity.frame, document: 1, epoch: 1,
  origin: identity.origin, cdpSessionId: 'page' };
const legacy = { browser: 'browser', broker: 1, session: 'client', epoch: 1, lease: 1, target: 'target' };
function fixture(t, options = {}) {
  const calls = [], listeners = new Set(); let sequence = 0, live = true;
  const nodes = [{ nodeId: '1', backendDOMNodeId: 1, role: { value: 'RootWebArea' }, childIds: ['2'] },
    { nodeId: '2', backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Example' }, childIds: [] }];
  const raw = new Proxy({ sessionId: 'root',
    on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); },
    async send(method, params, route) {
      assert.equal(route, 'page'); calls.push({ method, params });
      if (options.send) await options.send(method, params);
      switch (method) {
        case 'Page.enable': case 'Accessibility.enable': case 'Runtime.releaseObject': return {};
        case 'DOM.getDocument': return { root: options.dom ?? { backendNodeId: 1, nodeType: 9, children: [{ backendNodeId: 2, nodeType: 1, childNodeCount: 0 }] } };
        case 'DOM.describeNode': return { node: { backendNodeId: params.backendNodeId, nodeType: 1, childNodeCount: 0 } };
        case 'Accessibility.getPartialAXTree': return { nodes: structuredClone(nodes.filter(n => n.backendDOMNodeId === params.backendNodeId)) };
        case 'Page.createIsolatedWorld': return { executionContextId: 9 };
        case 'DOM.resolveNode': return { object: { objectId: 'object-' + ++sequence } };
        case 'Runtime.callFunctionOn': return { result: { value: options.state ?? { standard: true, value: 'public-fixture' } } };
        default: throw Error('Unsupported fake method ' + method);
      }
    } }, { get(obj, key) { if (key in obj || typeof key === 'symbol' || key === 'then') return obj[key]; throw Error('Unsupported fake member ' + key); } });
  const helper = { version: 1, source: String(inspectControl), sha256: createHash('sha256').update(String(inspectControl)).digest('hex'), parameters: [] };
  const adapter = createScopedAdapter({ session: raw, checkLease: () => live, helpers: fixedReadInspectors ?? { 'control-state': helper },
    nodeBinding: id => [1, 2, 3, 4].includes(id) ? { ...lease, backendNodeId: id } : null });
  const reader = new BrowserReads({ identity: production ? identity : legacy, authorize: () => options.allow !== false, timeoutMs: 200,
    ...(options.reader ?? {}) });
  reader.addFrame({ session: adapter.forLease(lease), frameId: identity.frame, document: 1, target: identity.target });
  t.after(() => { reader.dispose(); adapter.disconnect(); });
  return { reader, nodes, calls, raw, revoke() { live = false; },
    emit(method) { for (const fn of listeners) fn({ sessionId: 'page', method, params: { frameId: 'frame', frame: { id: 'frame' } } }); } };
}
test('leased ARIA and native reads produce a complete delivered canonical ref', async t => {
  const f = fixture(t), result = await f.reader.read();
  assert.equal(result.complete, true);
  assert.equal(result.coverage.sensing, 'complete');
  const field = result.data.find(r => r.role === 'textbox');
  assert.equal(field.state.value, 'public-fixture');
  assert.throws(() => f.reader.resolve(field.ref), /stale/);
  assert.equal(f.reader.acknowledge(result.observation), true);
  assert.deepEqual(f.reader.resolve(field.ref).binding, identity);
  assert.equal(f.calls.filter(c => c.method === 'Runtime.releaseObject').length, 1);
});
test('protected native state scrubs AX values and names before full and delta output', async t => {
  const f = fixture(t, { state: { protected: true } });
  f.nodes[1].value = { value: 'synthetic-secret' }; f.nodes[1].name = { value: 'synthetic-secret' };
  const first = await f.reader.read();
  assert.equal(first.complete, true);
  f.reader.acknowledge(first.observation);
  const delta = await f.reader.read({ since: first.observation });
  assert.equal(delta.mode, 'delta');
  assert.doesNotMatch(JSON.stringify([first, delta]), /synthetic-secret/);
});
test('read authority refuses before any scoped command', async t => {
  const f = fixture(t, { allow: false });
  await assert.rejects(f.reader.read(), /Read not authorized/);
  assert.equal(f.calls.length, 0);
});
test('recycled semantic rows retire the previously delivered ref', async t => {
  const f = fixture(t), first = await f.reader.read();
  f.reader.acknowledge(first.observation);
  const old = first.data.find(r => r.role === 'textbox').ref;
  f.nodes[1].name.value = 'Replacement';
  const second = await f.reader.read({ since: first.observation });
  assert.throws(() => f.reader.resolve(old), /stale/);
  assert.notEqual(second.data.find(r => r.name === 'Replacement').ref, old);
});
for (const event of ['DOM.documentUpdated', 'Runtime.executionContextsCleared', 'Page.frameNavigated', 'Page.frameDetached'])
  test('late ARIA response after ' + event + ' publishes no envelope', async t => {
    let f;
    f = fixture(t, { send(method) { if (method === 'Accessibility.getPartialAXTree') f.emit(event); } });
    await assert.rejects(f.reader.read(), /unavailable|invalidated/);
    assert.equal(f.calls.some(c => c.method === 'Runtime.callFunctionOn'), false);
  });

test('bounded acquisition preserves incomplete sensing instead of claiming absence', async t => {
  const f = fixture(t, { reader: { maxNodes: 1 } });
  const result = await f.reader.read();
  assert.equal(result.complete, false); assert.equal(result.coverage.sensing, 'incomplete');
  assert.equal(result.resync, 'incomplete-sensing');
  assert.ok(f.calls.filter(c => c.method === 'Accessibility.getPartialAXTree').length <= 1);
});
test('undelivered and foreign-session refs never acquire a scoped value', async t => {
  const f = fixture(t), other = fixture(t), result = await f.reader.read();
  const ref = result.data.find(r => r.role === 'textbox').ref;
  const before = f.calls.length;
  await assert.rejects(f.reader.read({ ref }), /stale/);
  assert.equal(f.calls.length, before);
  f.reader.acknowledge(result.observation);
  await assert.rejects(other.reader.read({ ref }), /stale/);
  assert.equal(other.calls.length, 0);
});
test('native inspection exceptions scrub AX fallback and hostile error text', async t => {
  const f = fixture(t, { send(method) { if (method === 'Runtime.callFunctionOn') throw Error('synthetic-secret'); } });
  f.nodes[1].value = { value: 'synthetic-secret' }; f.nodes[1].name = { value: 'synthetic-secret' };
  const result = await f.reader.read();
  assert.equal(result.complete, false);
  assert.deepEqual(result.data.find(r => r.role === 'textbox').state, { unreadable: true });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});
test('the actual broker fences every reader command without a site grant', async t => {
  const f = fixture(t), secret = 'a'.repeat(64), user = {}, uid = process.getuid?.() ?? 1000;
  const scope = { browser: 'browser', broker: 1, session: 'client', turn: 'turn', target: 'target', lease: 1,
    frame: 'frame', document: 1, ref: 'ref', origin: identity.origin };
  let snapshots = 0;
  const authority = createAuthority({ current: () => scope, now: () => 100, authenticate: e => e === user,
    classify: operation => operation, snapshot: () => { snapshots++; return { scope, time: 100 }; } });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation(plan, context) {
    return { id: context.operation, kind: 'read', args: {}, scope, consequence: 'ordinary' };
  } });
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser',
    connect: async () => f.raw, verifyConnection: () => true, currentTurn: () => 'turn',
    validateRequest: frame => frame, prepare: () => ({ target: 'target' }), authorize: () => true,
    dispatchFence: () => true, transportAuthority, endSession: () => true, disconnect: () => true, redact: value => value,
    async dispatch(plan, context) {
      const adapter = createScopedAdapter({ session: context.session, helpers: fixedReadInspectors ?? {}, checkLease: () => true,
        nodeBinding: id => [1, 2].includes(id) ? { ...lease, backendNodeId: id } : null });
      const reader = new BrowserReads({ identity, authorize: () => true });
      try {
        reader.addFrame({ session: adapter.forLease(lease), frameId: 'frame', target: 'target', document: 1 });
        const observation = await reader.read();
        return { effect: 'verified', observation };
      } finally { reader.dispose(); adapter.disconnect(); }
    } });
  t.after(() => broker.shutdown());
  await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'join-v1' });
  const result = await client.request({ id: 'read', operation: 'browser_read', args: {} });
  assert.equal(result.effect, 'verified'); assert.equal(result.observation.complete, true);
  assert.equal(snapshots, f.calls.length);
  assert.ok(snapshots >= 8);
  const prior = f.calls.length;
  assert.equal((await client.request({ id: 'again', operation: 'browser_read', args: {} })).effect, 'verified');
  assert.ok(f.calls.length > prior);
});
test('shallow closed-root controls share the delivered ref namespace and retain incomplete sensing', async t => {
  const f = fixture(t, { dom: { backendNodeId: 1, nodeType: 9, children: [{ backendNodeId: 2, nodeType: 1,
    shadowRoots: [{ backendNodeId: 3, nodeType: 11, childNodeCount: 1, children: [{ backendNodeId: 4, nodeType: 1, childNodeCount: 0 }] }] }] },
    state: { ariaOnly: true } });
  f.nodes[0].childIds = ['2']; f.nodes[1].role.value = 'group'; f.nodes[1].childIds = ['4'];
  f.nodes.push({ nodeId: '4', backendDOMNodeId: 4, role: { value: 'switch' }, name: { value: 'Two-factor authentication' }, childIds: [],
    properties: [{ name: 'checked', value: { value: false } }] });
  const result = await f.reader.read(), control = result.data.find(r => r.role === 'switch');
  assert.ok(control); assert.equal(control.state.checked, false); assert.equal(result.complete, false);
  assert.equal(f.reader.acknowledge(result.observation), true);
  assert.equal(f.reader.resolve(control.ref).backendNodeId, 4);
});
