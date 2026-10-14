import test from 'node:test';
import assert from 'node:assert/strict';
import { RefMap } from '../plugins/sleight/lib/direct-browser/refs.mjs';
import { WorldReader } from '../plugins/sleight/lib/direct-browser/worlds.mjs';

const identity = { browser: 'browser', epoch: 1, broker: 'broker', session: 'client', lease: 1,
  target: 'target', browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 1,
  leaseGeneration: 1, frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
function fixture(t, change = () => {}) {
  let current = { ...identity };
  const refs = new RefMap(identity);
  const ref = refs.observe(identity, 42, 'checkbox:Example');
  const calls = [], handlers = new Map();
  const session = new Proxy({ sessionId: 'target-session',
    on(event, fn) { handlers.set(event, fn); }, off(event) { handlers.delete(event); },
    async send(method, params) {
      calls.push({ method, params });
      change(method, () => { current = { ...current, document: current.document + 1 }; });
      if (method === 'Page.createIsolatedWorld') {
        assert.equal(params.frameId, 'frame'); return { executionContextId: 7 };
      }
      if (method === 'DOM.resolveNode') {
        assert.equal(params.backendNodeId, 42); assert.equal(params.executionContextId, 7);
        return { object: { objectId: 'node-object' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(params.objectId, 'node-object');
        assert.equal(params.arguments[0].value, 'checked');
        return { result: { value: { state: 'value', value: true } } };
      }
      if (method === 'Runtime.releaseObject') { assert.equal(params.objectId, 'node-object'); return {}; }
      throw Error(`Unsupported fake command ${method}`);
    },
  }, { get(object, key) {
    if (key in object || typeof key === 'symbol' || key === 'then') return object[key];
    throw Error(`Unsupported fake member ${key}`);
  } });
  const reader = new WorldReader(session, refs, { current: () => current });
  t.after(() => reader.dispose());
  return { refs, ref, reader, calls, current: () => current, handlers };
}

test('the shared semantic ref joins native state to its exact frame and backend node', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.reader.read(f.ref, 'checked'), { state: 'value', source: 'native', value: true });
  assert.deepEqual(f.calls.map(c => c.method), ['Page.createIsolatedWorld', 'DOM.resolveNode',
    'Runtime.callFunctionOn', 'Runtime.releaseObject']);
});
for (const key of ['turn', 'origin', 'frame', 'document', 'browserIncarnation', 'brokerEpoch', 'clientSession', 'leaseGeneration']) {
  test(`a shared semantic ref refuses changed ${key} authority`, t => {
    const f = fixture(t);
    assert.throws(() => f.refs.resolve(f.ref, { ...identity, [key]: typeof identity[key] === 'number' ? 2 : 'foreign' }), /stale|unavailable/i);
  });
}
for (const stage of ['Page.createIsolatedWorld', 'DOM.resolveNode']) {
  test(`document replacement after ${stage} stops the next content command`, async t => {
    const f = fixture(t, (method, replace) => { if (method === stage) replace(); });
    assert.deepEqual(await f.reader.read(f.ref, 'checked'), { state: 'stale', source: 'native' });
    assert.equal(f.calls.filter(c => c.method === 'Runtime.callFunctionOn').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'DOM.resolveNode').length, stage === 'DOM.resolveNode' ? 1 : 0);
  });
}
test('a ref from a different client never reaches the target transport', async t => {
  const f = fixture(t), other = new RefMap({ ...identity, session: 'foreign', clientSession: 'foreign' });
  const foreign = other.observe({ ...identity, session: 'foreign', clientSession: 'foreign' }, 42, 'checkbox:Example');
  assert.deepEqual(await f.reader.read(foreign, 'checked'), { state: 'stale', source: 'native' });
  assert.deepEqual(f.calls, []);
});
test('MAIN boolean getters require the broker to supply a context for the exact ref binding', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.reader.read(f.ref, 'checked', { semantics: 'page' }), { state: 'stale', source: 'page-reported' });
  assert.deepEqual(f.calls, []);
});

for (const stage of ['Page.createIsolatedWorld', 'DOM.resolveNode', 'Runtime.callFunctionOn']) {
  test(`world destruction during ${stage} invalidates that in-flight observation`, async t => {
    const f = fixture(t, method => {
      if (method === stage) f.handlers.get('Runtime.executionContextDestroyed')({ executionContextId: 7 });
    });
    assert.deepEqual(await f.reader.read(f.ref, 'checked'), { state: 'stale', source: 'native' });
    assert.equal(f.calls.filter(c => c.method === 'Runtime.callFunctionOn').length, stage === 'Runtime.callFunctionOn' ? 1 : 0);
  });
}
test('dispose prevents any later context preparation or content read', async t => {
  const f = fixture(t); f.reader.dispose();
  assert.deepEqual(await f.reader.read(f.ref, 'checked'), { state: 'stale', source: 'native' });
  assert.deepEqual(f.calls, []);
});
test('recycled backend nodes retire the previous semantic ref', t => {
  const f = fixture(t);
  const fresh = f.refs.observe(identity, 42, 'checkbox:Different row');
  assert.notEqual(fresh, f.ref);
  assert.throws(() => f.refs.resolve(f.ref, identity), /stale|unavailable/i);
  assert.equal(f.refs.resolve(fresh, identity).backendNodeId, 42);
});
test('a new ref cannot be minted from a foreign frame observation', t => {
  const f = fixture(t);
  assert.throws(() => f.refs.observe({ ...identity, frame: 'foreign' }, 43, 'checkbox'), /Invalid node identity/);
});

test('closed roots reuse the delivered ARIA ref for the same backend node', async t => {
  const { BackendRefs } = await import('../plugins/sleight/lib/direct-browser/closed-roots.mjs');
  const f = fixture(t), backend = new BackendRefs({ sessionId: 'target-session', on() {}, off() {} }, f.current, f.refs);
  t.after(() => backend.dispose());
  assert.equal(backend.remember(42, identity), f.ref);
  assert.equal(backend.resolve(f.ref).backendNodeId, 42);
});

for (const stage of ['DOM.getDocument', 'DOM.describeNode']) {
  test(`closed-root invalidation during ${stage} cannot publish new refs`, async t => {
    const { BackendRefs } = await import('../plugins/sleight/lib/direct-browser/closed-roots.mjs');
    const handlers = new Map(), refs = new RefMap(identity);
    const session = { sessionId: 'target-session', on(event, fn) { handlers.set(event, fn); }, off(event) { handlers.delete(event); },
      async send(method) {
        if (method === stage) handlers.get('DOM.documentUpdated')({});
        if (method === 'DOM.getDocument') return { root: { nodeType: 9, backendNodeId: 1, children: [
          { nodeType: 1, localName: 'div', backendNodeId: 42, childNodeCount: 1 },
        ] } };
        if (method === 'DOM.describeNode') return { node: { nodeType: 1, localName: 'div', backendNodeId: 42,
          children: [{ nodeType: 1, localName: 'input', backendNodeId: 43, children: [] }] } };
        throw Error('Unsupported fake command ' + method);
      } };
    const backend = new BackendRefs(session, () => identity, refs); t.after(() => backend.dispose());
    const result = await backend.scan();
    assert.equal(result.complete, false); assert.equal(result.state, 'stale');
    assert.deepEqual(result.nodes, []);
    assert.equal(refs.existing(identity, 43), undefined);
  });
}

for (const event of ['Runtime.executionContextsCleared', 'DOM.documentUpdated', 'Page.frameDetached']) {
  test(`${event} fences an in-flight native observation`, async t => {
    const f = fixture(t, method => {
      if (method === 'DOM.resolveNode') f.handlers.get(event)?.({ frameId: identity.frame });
    });
    assert.deepEqual(await f.reader.read(f.ref, 'checked'), { state: 'stale', source: 'native' });
    assert.equal(f.calls.filter(c => c.method === 'Runtime.callFunctionOn').length, 0);
  });
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
for (const stage of ['Page.createIsolatedWorld', 'DOM.resolveNode']) {
  test(`late ${stage} after the deadline cannot resume a content read`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let release, pending = true;
    const gate = new Promise(resolve => { release = resolve; }), calls = [];
    const refs = new RefMap(identity), ref = refs.observe(identity, 42, 'checkbox:Example');
    const session = { sessionId: 'target-session', on() {}, off() {}, async send(method) {
      calls.push(method);
      if (method === stage && pending) { pending = false; return gate; }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node-object' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { state: 'value', value: true } } };
      if (method === 'Runtime.releaseObject') return {};
      throw Error('Unsupported fake command ' + method);
    } };
    const reader = new WorldReader(session, refs, { current: () => identity, timeoutMs: 10 });
    t.after(() => reader.dispose());
    const first = reader.read(ref, 'checked'); await flush(); t.mock.timers.tick(11);
    assert.equal((await first).state, 'timeout');
    release(stage === 'Page.createIsolatedWorld' ? { executionContextId: 7 } : { object: { objectId: 'node-object' } });
    await flush();
    assert.equal(calls.filter(m => m === 'Runtime.callFunctionOn').length, 0);
    if (stage === 'DOM.resolveNode') assert.equal(calls.filter(m => m === 'Runtime.releaseObject').length, 1);
    const second = await reader.read(ref, 'checked'); assert.equal(second.state, 'value');
    assert.equal(calls.filter(m => m === 'Page.createIsolatedWorld').length, stage === 'Page.createIsolatedWorld' ? 2 : 1);
  });
}

test('authority scope maps once into the canonical semantic lease identity', async () => {
  const api = await import('../plugins/sleight/lib/direct-browser/refs.mjs');
  const scope = { browser: 'browser', broker: 1, session: 'client', turn: 1, target: 'target', lease: 1,
    frame: 'frame', document: 1, ref: 'r1', origin: 'https://fixture.invalid' };
  assert.deepEqual(api.refScopeFromAuthority(scope), Object.fromEntries([
    'browserIncarnation', 'brokerEpoch', 'clientSession', 'turn', 'leaseGeneration', 'target', 'frame', 'document', 'origin',
  ].map(k => [k, identity[k]])));
});

test('authority-to-ref conversion refuses getters, proxies and non-origin destinations', async () => {
  const { refScopeFromAuthority } = await import('../plugins/sleight/lib/direct-browser/refs.mjs');
  const scope = { browser: 'browser', broker: 1, session: 'client', turn: 1, target: 'target', lease: 1,
    frame: 'frame', document: 1, ref: 'r1', origin: 'https://fixture.invalid' };
  let getterCalls = 0;
  const accessor = { ...scope }; Object.defineProperty(accessor, 'session', { get() { getterCalls++; return 'client'; } });
  assert.throws(() => refScopeFromAuthority(accessor), /Invalid ref authority/);
  assert.equal(getterCalls, 0);
  assert.throws(() => refScopeFromAuthority(new Proxy(scope, {})), /Invalid ref authority/);
  for (const origin of ['https://fixture.invalid/path', 'file:///fixture', 'https://user:pass@fixture.invalid']) {
    assert.throws(() => refScopeFromAuthority({ ...scope, origin }), /Invalid ref authority/);
  }
});
