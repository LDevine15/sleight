import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticAdapter, formInspectors, fixedFormInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';
import { inspectControl, fixedReadInspectors } from '../plugins/sleight/lib/direct-browser/reads.mjs';
import { createTransportOwner } from '../plugins/sleight/lib/direct-browser/transport-owner.mjs';
import { createAuthority, createTransportAuthority, revokeAuthoritySession } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { validateHostRequest } from '../plugins/sleight/lib/direct-browser/request-schema.mjs';
const identity = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn', leaseGeneration: 1,
  target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
const lease = { ...identity, epoch: 1, cdpSessionId: 'page' };
async function fixture(t, options = {}) {
  const calls = [], listeners = new Set(), objects = new Map(); let serial = 0, value = '', live = true;
  const ax = [{ nodeId: '1', backendDOMNodeId: 1, role: { value: 'RootWebArea' }, childIds: ['2', '3'] },
    { nodeId: '2', backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Name' }, childIds: [] },
    { nodeId: '3', backendDOMNodeId: 3, role: { value: 'button' }, name: { value: 'Save' }, childIds: [] }];
  if (options.secondField) { ax[2].role.value = 'textbox'; ax[2].name.value = 'Other'; }
  if (options.manyRows) {
    ax.splice(1);
    for (let i = 2; i <= options.manyRows + 1; i++) ax.push({ nodeId: String(i), backendDOMNodeId: i, role: { value: 'textbox' }, name: { value: 'Field ' + i }, childIds: [] });
    ax[0].childIds = ax.slice(1).map(n => n.nodeId);
  }
  const raw = new Proxy({ sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); },
    async send(method, params, route) {
      assert.equal(route, 'page'); calls.push({ method, params });
      if (options.send) await options.send(method, params);
      switch (method) {
        case 'Page.addScriptToEvaluateOnNewDocument': return { identifier: 'strict-popup' };
        case 'Runtime.evaluate': return { result: { value: true } };
        case 'Page.setInterceptFileChooserDialog': return {};
        case 'Page.enable': case 'Accessibility.enable': case 'DOM.scrollIntoViewIfNeeded': case 'Runtime.releaseObject': return {};
        case 'DOM.getDocument': return { root: { backendNodeId: 1, nodeType: 9, children: ax.slice(1).map(n => ({ backendNodeId: n.backendDOMNodeId, nodeType: 1, childNodeCount: 0 })) } };
        case 'DOM.describeNode': return { node: { backendNodeId: params.backendNodeId, nodeType: 1, childNodeCount: 0 } };
        case 'Accessibility.getPartialAXTree': return { nodes: structuredClone(ax.filter(n => n.backendDOMNodeId === params.backendNodeId)) };
        case 'Page.createIsolatedWorld': return { executionContextId: 9 };
        case 'DOM.resolveNode': { const id = 'object-' + (++serial); objects.set(id, params.backendNodeId); return { object: { objectId: id } }; }
        case 'Runtime.callFunctionOn': {
          const s = params.functionDeclaration;
          if (s.includes('this.setupHitTargetInterceptor')) return { result: { objectId: 'interceptor-' + (++serial) } };
          if (s === 'function(){return this.stop();}') return { result: { value: 'done' } };
          if (s.startsWith('function(){const module')) return { result: { objectId: 'constructor' } };
          if (s.startsWith('function(){return new this')) return { result: { objectId: 'instance' } };
          if (s === String(inspectControl)) return { result: { value: { standard: true, value } } };
          if (s === fixedFormInspectors['form-state'].source) return { result: { value: {
            kind: !options.secondField && objects.get(params.objectId) === 3 ? 'button' : 'text', value, connected: true, enabled: true, visible: true, hit: true, readonly: false,
            rect: { x: 1, y: 1, width: 100, height: 20 }, submit: !options.secondField && objects.get(params.objectId) === 3,
          } } };
          if (s.includes('this.checkElementStates')) return { result: { value: null } };
          if (s.includes('this.expectHitTarget')) return { result: { value: 'done' } };
          if (s.includes('this.fill(node,value)')) return { result: { value: 'needsinput' } };
          throw Error('unsupported fixed helper');
        }
        case 'Input.insertText': value = params.text; return {};
        case 'Input.dispatchMouseEvent': return {};
        default: throw Error('unsupported fake CDP method ' + method);
      }
    } }, { get(o, k) { if (k in o || k === 'then' || typeof k === 'symbol') return o[k]; throw Error('unsupported fake member ' + k); } });
  const owner = createTransportOwner({ session: raw, checkLease: () => live, helpers: { ...formInspectors(), ...fixedReadInspectors },
    nodeBinding: id => ax.some(n => n.backendDOMNodeId === id) ? { ...lease, backendNodeId: id } : null });
  const adapter = createSemanticAdapter({ owner, current: () => live ? identity : { ...identity, document: 2 },
    leaseFor: tab => { assert.equal(tab, 'tfixture'); return lease; } });
  const authority = createAuthority({ current: adapter.currentScope, classify: adapter.classify, checkTarget: adapter.checkTarget,
    authenticate: () => false, snapshot: () => ({ scope: adapter.currentScope(), time: Date.now() }) });
  adapter.bindAuthority(authority);
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: adapter.resolveOperation });
  const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest,
    prepare: adapter.prepare, authorize: adapter.authorize, dispatchFence: adapter.dispatchFence, dispatch: adapter.dispatch,
    transportAuthority, endSession: id => { revokeAuthoritySession(authority, id); owner.revokeSession(id); return true; },
    disconnect: async () => (await owner.close()).closed, redact: value => value });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  return { client, adapter, authority, calls, ax, value: () => value, revoke() { live = false; } };
}
test('complete broker/owner slice retains a delivered reader across form requests without page completeness gates', async t => {
  const f = await fixture(t);
  const first = await f.client.request({ id: 'read', operation: 'browser_read', args: { tab: 'tfixture' } });
  assert.equal(first.effect, 'verified');
  const ref = first.observation.data.find(row => row.role === 'textbox').ref;
  const undelivered = await f.client.request({ id: 'not-yet', operation: 'browser_fill', args: { tab: 'tfixture', fields: [{ ref, value: 'Example' }] } });
  assert.equal(undelivered.effect, 'none'); assert.equal(f.value(), '');
  assert.equal(f.adapter.delivered(lease, first.observation.observation), true);
  const result = await f.client.request({ id: 'fill', operation: 'browser_fill', args: { tab: 'tfixture', fields: [{ ref, value: 'Example' }] } });
  assert.equal(result.effect, 'verified', JSON.stringify(result)); assert.equal(f.value(), 'Example');
  assert.equal(f.calls.some(c => ['Target.activateTarget', 'Page.bringToFront'].includes(c.method)), false);
});
test('private preparation reads do not release uncertain submit recovery; a delivered fresh read does', async t => {
  const f = await fixture(t);
  const initial = await f.client.request({ id: 'read', operation: 'browser_read', args: { tab: 'tfixture' } });
  f.adapter.delivered(lease, initial.observation.observation);
  const ref = initial.observation.data.find(row => row.role === 'button').ref;
  const request = id => f.client.request({ id, operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref } });
  assert.equal((await request('submit')).effect, 'unknown');
  const count = f.calls.filter(c => c.method.startsWith('Input.')).length;
  assert.equal((await request('fenced')).effect, 'none');
  assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, count);
  const fresh = await f.client.request({ id: 'fresh', operation: 'browser_read', args: { tab: 'tfixture' } });
  assert.equal((await request('undelivered')).effect, 'none');
  assert.equal(f.adapter.delivered(lease, fresh.observation.observation), true);
  assert.equal((await request('after-read')).effect, 'unknown');
});
test('a failed second field preserves the first native proof in both broker and host journals', async t => {
  const f = await fixture(t, { secondField: true, send(method, params) {
    if (method === 'Input.insertText' && params.text === 'Second') throw Error('unknown physical effect');
  } });
  const initial = await f.client.request({ id: 'read', operation: 'browser_read', args: { tab: 'tfixture' } });
  f.adapter.delivered(lease, initial.observation.observation);
  const refs = initial.observation.data.filter(row => row.role === 'textbox').map(row => row.ref);
  const result = await f.client.request({ id: 'form', operation: 'browser_fill', args: { tab: 'tfixture', fields: refs.map((ref, i) => ({ ref, value: i ? 'Second' : 'First' })) } });
  assert.equal(result.effect, 'unknown'); assert.equal(result.completed, 1); assert.equal(result.results.length, 1);
  assert.deepEqual(f.authority.recovery().filter(r => r.kind === 'fill').map(r => r.phase), ['verified', 'unknown']);
});
test('bounded page reads paginate through opaque read-scope handles accepted by the closed host schema', async t => {
  const f = await fixture(t, { manyRows: 80 }), names = new Set(); let scope;
  for (let i = 0; i < 100; i++) {
    const result = await f.client.request({ id: 'page' + i, operation: 'browser_read', args: { tab: 'tfixture', max_bytes: 1024, ...(scope ? { scope } : {}) } });
    assert.equal(result.effect, 'verified', JSON.stringify(result));
    for (const row of result.observation.data) if (row.role === 'textbox') names.add(row.name);
    if (!i && result.observation.cursor) {
      const count = f.calls.length;
      const early = await f.client.request({ id: 'early', operation: 'browser_read', args: { tab: 'tfixture', max_bytes: 1024, scope: result.observation.cursor } });
      assert.equal(early.effect, 'none'); assert.equal(f.calls.length, count);
    }
    f.adapter.delivered(lease, result.observation.observation);
    scope = result.observation.cursor;
    if (!scope) break;
    assert.match(scope, /^r[A-Za-z0-9_-]{1,63}$/);
  }
  assert.equal(names.size, 80);
});
