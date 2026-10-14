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
const identityB = { ...identity, target: 'target-b', frame: 'frame-b' };
const leaseB = { ...identityB, epoch: 1, cdpSessionId: 'page-b' };
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
      assert.ok(['page','page-b'].includes(route)); calls.push({ method, params, route });
      if (options.send) await options.send(method, params, route);
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
    nodeBinding: (id, bound) => ax.some(n => n.backendDOMNodeId === id) ? { ...bound, backendNodeId: id } : null });
  const adapter = createSemanticAdapter({ owner, current: bound => live ? (bound.target === 'target-b' ? identityB : identity) : { ...identity, document: 2 },
    leaseFor: tab => { assert.ok(['tfixture','tfixtureB'].includes(tab)); return tab === 'tfixture' ? lease : leaseB; } });
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
test('independent target reads retain their own active semantic authority', async t => {
  let ready, release;
  const entered = new Promise(resolve => { ready = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { async send(method, params, route) {
    if (method === 'Page.enable' && route === 'page') { ready(); await held; }
  } });
  const first = f.client.request({ id: 'readA', operation: 'browser_read', args: { tab: 'tfixture' } });
  await entered;
  const second = await f.client.request({ id: 'readB', operation: 'browser_read', args: { tab: 'tfixtureB' } });
  release();
  const a = await first;
  assert.equal(second.effect, 'verified');
  assert.equal(a.effect, 'verified', 'the second target replaced the first target active authority');
});

test('a held target preparation keeps its scope when another target finishes', async t => {
  let ready, release, f, retained;
  const entered = new Promise(resolve => { ready = resolve; }), held = new Promise(resolve => { release = resolve; });
  f = await fixture(t, { async send(method, _params, route) {
    if (method === 'Page.enable' && route === 'page') { ready(); await held; retained = f.adapter.currentScope(); }
  } });
  const first = f.client.request({ id: 'scopeA', operation: 'browser_read', args: { tab: 'tfixture' } });
  await entered;
  assert.equal((await f.client.request({ id: 'scopeB', operation: 'browser_read', args: { tab: 'tfixtureB' } })).effect, 'verified');
  release(); assert.equal((await first).effect, 'verified');
  assert.equal(retained.target, lease.target); assert.equal(retained.frame, lease.frame);
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false);
});

test('field preparation remains bound while an independent read completes', async t => {
  let ready, release, f, retained, holding = false;
  const entered = new Promise(resolve => { ready = resolve; }), held = new Promise(resolve => { release = resolve; });
  f = await fixture(t, { async send(method, _params, route) {
    if (holding && method === 'DOM.resolveNode' && route === 'page') { holding = false; ready(); await held; retained = f.adapter.currentScope(); }
  } });
  const read = await f.client.request({ id: 'field-read', operation: 'browser_read', args: { tab: 'tfixture' } });
  assert.equal(f.adapter.delivered(lease, read.observation.observation), true);
  const ref = read.observation.data.find(row => row.role === 'textbox').ref; holding = true;
  const filling = f.client.request({ id: 'fieldA', operation: 'browser_fill', args: { tab: 'tfixture', fields: [{ ref, value: 'Example' }] } });
  await entered;
  assert.equal((await f.client.request({ id: 'other-read', operation: 'browser_read', args: { tab: 'tfixtureB' } })).effect, 'verified');
  release(); assert.equal((await filling).effect, 'verified');
  assert.equal(retained.target, lease.target); assert.equal(retained.ref, ref);
  assert.ok(f.calls.filter(call => call.method.startsWith('Input.')).every(call => call.route === 'page'));
});

test('a completed request cannot borrow a later request scope from a retained callback', async t => {
  let releaseOld, readyNew, releaseNew, f, old;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  const entered = new Promise(resolve => { readyNew = resolve; }), newGate = new Promise(resolve => { releaseNew = resolve; });
  f = await fixture(t, { async send(method, _params, route) {
    if (method === 'Page.enable' && route === 'page') old = (async () => {
      await oldGate;
      try { return f.adapter.currentScope(); } catch (error) { return error.message; }
    })();
    if (method === 'Page.enable' && route === 'page-b') { readyNew(); await newGate; }
  } });
  assert.equal((await f.client.request({ id: 'retired', operation: 'browser_read', args: { tab: 'tfixture' } })).effect, 'verified');
  const next = f.client.request({ id: 'current', operation: 'browser_read', args: { tab: 'tfixtureB' } });
  await entered; releaseOld(); const result = await old;
  releaseNew(); assert.equal((await next).effect, 'verified');
  assert.equal(result, 'STALE_REF');
});
