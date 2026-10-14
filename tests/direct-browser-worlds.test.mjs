import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { WorldReader } from '../plugins/sleight/lib/direct-browser/worlds.mjs';
import { BackendRefs } from '../plugins/sleight/lib/direct-browser/closed-roots.mjs';
import { ProtectedProof, Redactor } from '../plugins/sleight/lib/direct-browser/protected-proof.mjs';

export const binding = () => ({ browserIncarnation: 'b1', brokerEpoch: 1, clientSession: 'c1', turn: 't1',
  leaseGeneration: 1, target: 't1', frame: 'f1', document: 1, origin: 'https://fixture.invalid' });
const authority = () => { let current = binding(); return { current: () => current, change: patch => { current = { ...current, ...patch }; } }; };
function fake(handler = () => ({})) {
  const calls = [], listeners = new Map();
  return new Proxy({ sessionId: 'cdp1', calls, emit: (name, event) => { for (const cb of listeners.get(name) ?? []) cb(event); },
    on: (name, cb) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(cb); },
    off: (name, cb) => listeners.get(name)?.delete(cb),
    send: async (name, args) => { calls.push([name, args]); return handler(name, args); },
  }, { get: (obj, key) => { if (!(key in obj)) throw Error(`Unsupported session method ${String(key)}`); return obj[key]; } });
}
function reader(value = { state: 'value', value: false }, options = {}) {
  const auth = authority();
  const session = fake((method, args) => {
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 2 };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node1' } };
    if (method === 'Runtime.callFunctionOn') return typeof value === 'function' ? value(args) : { result: { value } };
    if (method === 'Runtime.releaseObject') return {};
    throw Error(`Unsupported command ${method}`);
  });
  const refs = new BackendRefs(session, auth.current);
  const ref = refs.remember(7, binding());
  return { auth, session, refs, ref, read: new WorldReader(session, refs, { current: auth.current, mainContext: () => 1, ...options }) };
}
test('native reads use isolated context; only explicit page semantics use MAIN', async () => {
  const r = reader(args => ({ result: { value: { state: 'value', value: args.arguments[1].value === 'page' } } }));
  assert.equal((await r.read.read(r.ref, 'checked')).value, false);
  const main = await r.read.read(r.ref, 'checked', { semantics: 'page' });
  assert.equal(main.value, true); assert.equal(main.source, 'page-reported');
  assert.deepEqual(r.session.calls.filter(([m]) => m === 'DOM.resolveNode').map(([, a]) => a.executionContextId), [2, 1]);
  assert.equal((await r.read.read(r.ref, 'constructor')).state, 'unreadable');
  r.read.dispose(); r.refs.dispose();
});
for (const state of ['absent', 'throwing', 'unreadable', 'redacted']) test(`getter ${state} is distinct from false`, async () => {
  const r = reader({ state }); assert.equal((await r.read.read(r.ref, 'checked', { semantics: 'page' })).state, state);
});
test('getter transport errors and hostile outputs never serialize raw details', async () => {
  const secret = 'seed-password-9'; const redactor = new Redactor(); redactor.protect(secret);
  for (const value of [() => { throw Error(secret); }, { state: 'value', value: secret }, { state: secret, value: { toJSON() { return secret; } } }]) {
    const r = reader(typeof value === 'function' ? value : { ...value }, { redactor });
    const output = await r.read.read(r.ref, 'value', { semantics: 'page' });
    assert.doesNotMatch(JSON.stringify(output), new RegExp(secret));
  }
});
test('slow getters time out without global debugger cancellation', async () => {
  const r = reader(() => new Promise(() => {}), { timeoutMs: 10 });
  assert.equal((await r.read.read(r.ref, 'checked', { semantics: 'page' })).state, 'timeout');
  assert.ok(!r.session.calls.some(([m]) => /terminate|disable/i.test(m)));
});
test('document/origin/lease/session changes and stale backend IDs invalidate refs', async () => {
  for (const patch of [{ document: 2 }, { origin: 'https://other.invalid' }, { leaseGeneration: 2 }, { clientSession: 'c2' }]) {
    const r = reader(); r.auth.change(patch); assert.equal((await r.read.read(r.ref, 'checked')).state, 'stale');
    assert.equal(r.session.calls.length, 0);
  }
  const r = reader(); r.session.emit('DOM.documentUpdated', {});
  assert.equal((await r.read.read(r.ref, 'checked')).state, 'stale');
});
test('closed and open nodes use one ref space; raw DOM attributes never escape', async () => {
  const auth = authority(); const session = fake(method => method === 'DOM.describeNode' ? { node: { children: [] } } : ({ root: { backendNodeId: 1, nodeType: 9, children: [
    { backendNodeId: 2, nodeType: 1, attributes: ['value', 'secret'], shadowRoots: [{ backendNodeId: 3,
      nodeType: 11, shadowRootType: 'closed', children: [{ backendNodeId: 4, nodeType: 1 }] }] }] } }));
  const refs = new BackendRefs(session, auth.current);
  const out = await refs.scan(); assert.equal(out.complete, true);
  assert.ok(out.nodes.every(n => /^r[\w-]+$/.test(n.ref))); assert.ok(out.nodes.some(n => n.closed));
  assert.doesNotMatch(JSON.stringify(out), /secret|backendNodeId/);
  refs.dispose();
});
function proofSetup(options = {}) {
  const auth = authority(); const redactor = new Redactor();
  const proof = new ProtectedProof({ current: auth.current, authorize: async () => true, redactor, ...options });
  return { auth, proof, redactor };
}
const intent = () => ({ ...binding(), operation: 'op1', field: 'r1', dispatchFence: 1 });
test('private equality is one authorized write, no plaintext or reusable equality query', async () => {
  const { proof, redactor } = proofSetup(); const secret = 'seed-password-9'; let writes = 0;
  const cap = await proof.prepare(intent(), secret);
  const receipt = await proof.execute(cap, intent(), { dispatch: async value => { assert.equal(value, secret); writes++; },
    observe: async () => ({ source: 'native', value: secret }) });
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.phase, 'verified');
  assert.equal(writes, 1); assert.doesNotMatch(JSON.stringify(receipt), /seed|length|hash/);
  assert.equal((await proof.execute(cap, intent(), {})).status, 'blocked');
  assert.equal((await proof.execute({}, intent(), {})).status, 'blocked');
  const output = redactor.serialize({ log: secret, error: `failed ${secret}`, delta: { value: secret } });
  assert.doesNotMatch(output, /seed-password-9/); assert.ok(output.includes('protected'));
});
test('page getter equality stays protected; unavailable native observation is unverifiable', async () => {
  for (const [source, value, status] of [['page-reported', 'secret', 'protected'], ['native', 'different', 'unverifiable']]) {
    const { proof } = proofSetup(); const cap = await proof.prepare(intent(), 'secret');
    assert.equal((await proof.execute(cap, intent(), { dispatch: async () => {}, observe: async () => ({ source, value }) })).status, status);
  }
});
test('capabilities refuse cross-session, changed field, document, operation and expiry', async () => {
  for (const patch of [{ clientSession: 'c2' }, { field: 'r2' }, { document: 2 }, { operation: 'op2' }, { origin: 'https://other.invalid' }]) {
    const { proof } = proofSetup(); const cap = await proof.prepare(intent(), 'secret');
    assert.equal((await proof.execute(cap, { ...intent(), ...patch }, {})).status, 'blocked');
  }
  let clock = 1; const { proof } = proofSetup({ now: () => clock, lifetimeMs: 10 });
  const cap = await proof.prepare(intent(), 'secret'); clock = 12;
  assert.equal((await proof.execute(cap, intent(), {})).status, 'blocked');
});
test('recheck after authorization and dispatch; revoke leaves unknown effect and never retries', async () => {
  const auth = authority(); let writes = 0;
  const proof = new ProtectedProof({ current: auth.current, authorize: async () => true });
  const cap = await proof.prepare(intent(), 'secret');
  const receipt = await proof.execute(cap, intent(), { dispatch: async () => { writes++; auth.change({ document: 2 }); }, observe: async () => { throw Error('must not read'); } });
  assert.equal(receipt.effect, 'unknown'); assert.equal(writes, 1);
  assert.equal((await proof.execute(cap, intent(), {})).status, 'blocked');
});
test('authorization denial and dispatch timeout sanitize error receipts', async () => {
  const denied = proofSetup({ authorize: async () => false });
  assert.equal(await denied.proof.prepare(intent(), 'secret'), null);
  const { proof } = proofSetup({ timeoutMs: 10 }); const cap = await proof.prepare(intent(), 'secret');
  const receipt = await proof.execute(cap, intent(), { dispatch: async () => new Promise(() => {}), observe: async () => ({ value: 'secret' }) });
  assert.equal(receipt.effect, 'unknown'); assert.doesNotMatch(JSON.stringify(receipt), /secret/);
});
test('concurrent prepares never issue two capabilities for one operation', async () => {
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const { proof } = proofSetup({ authorize: async () => { await gate; return true; } });
  const first = proof.prepare(intent(), 'secret'); const second = proof.prepare(intent(), 'guess');
  unblock(); const caps = await Promise.all([first, second]); assert.equal(caps.filter(Boolean).length, 1);
});
test('closed-root scan never requests a full pierced document or a foreign frame', async () => {
  const auth = authority(); const calls = [];
  const session = fake((method, args) => {
    calls.push([method, args]);
    if (method === 'DOM.getDocument') {
      assert.equal(args.depth, 1); assert.equal(args.pierce, false);
      return { root: { backendNodeId: 1, nodeType: 9, children: [{ backendNodeId: 2, nodeType: 1, localName: 'iframe' }] } };
    }
    throw Error('must not acquire foreign frame');
  });
  const refs = new BackendRefs(session, auth.current); const result = await refs.scan();
  assert.equal(result.state, undefined); assert.equal(result.complete, false); assert.equal(calls.length, 1);
});
test('redaction does not retain secrets or invoke hostile accessors/toJSON', () => {
  const r = new Redactor(); r.protect('native');
  const data = { log: 'native', value: 12345, toJSON() { throw Error('must not run'); } };
  Object.defineProperty(data, 'secret', { enumerable: true, get() { throw Error('must not run'); } });
  const output = r.serialize(data); assert.doesNotMatch(output, /native|12345/); assert.ok(output.includes('protected'));
  assert.equal(r.serialize(new Proxy({}, { ownKeys() { throw Error('secret'); } })), '{"error":"unreadable"}');
});
test('fixed inspector executes native descriptors and typed MAIN getters, including redefinition', async () => {
  class HTMLInputElement { get checked() { return false; } get value() { return 'seed-secret'; } }
  const node = new HTMLInputElement(); Object.defineProperty(node, 'checked', { configurable: true, get: () => true });
  const classes = { HTMLInputElement, HTMLSelectElement: class {}, HTMLTextAreaElement: class {}, HTMLOptionElement: class {} };
  const r = reader(args => ({ result: { value: runInNewContext(`(${args.functionDeclaration})`, classes).call(node, ...args.arguments.map(a => a.value)) } }));
  assert.equal((await r.read.read(r.ref, 'checked')).value, false);
  assert.equal((await r.read.read(r.ref, 'checked', { semantics: 'page' })).value, true);
  Object.defineProperty(node, 'checked', { get() { throw Error('seed-secret'); } });
  assert.equal((await r.read.read(r.ref, 'checked', { semantics: 'page' })).state, 'throwing');
  assert.equal((await r.read.read(r.ref, 'value')).state, 'redacted');
});
test('fake-session helper/world timing publishes all samples separately from browser qualification', async () => {
  const r = reader(); const samples = [];
  for (let i = 0; i < 100; i++) { const start = performance.now(); await r.read.read(r.ref, 'checked'); samples.push(performance.now() - start); }
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(JSON.stringify({ workload: '100 sequential isolated boolean reads on immediate fake CDP', samplesMs: samples, p50: sorted[49], p90: sorted[89] }));
  assert.equal(samples.length, 100); r.read.dispose(); r.refs.dispose();
});

// BP2-5 review regressions: retained independent repros.
const gate = () => { let release, enter; const pending = new Promise(r => { release = r; });
  const entered = new Promise(r => { enter = r; }); return { pending, entered, release, enter }; };

test('invalidate fences a prepare waiting for authority', async () => {
  const g = gate();
  const proof = new ProtectedProof({ current: binding, authorize: async () => { g.enter(); await g.pending; return true; } });
  const pending = proof.prepare(intent(), 'fixture-private-seed');
  await g.entered; proof.invalidate(); g.release();
  const cap = await pending;
  console.log(JSON.stringify({ case: 'prepare-after-invalidate', capabilityReturned: cap !== null }));
  proof.dispose();
  assert.equal(cap, null, 'an invalidated pending prepare must not publish a capability');
});

test('invalidate fences an execute waiting for its second authority check', async () => {
  const g = gate(); let checks = 0, dispatches = 0;
  const proof = new ProtectedProof({ current: binding, authorize: async () => {
    if (++checks === 2) { g.enter(); await g.pending; } return true;
  } });
  const op = intent(); const cap = await proof.prepare(op, 'fixture-private-seed');
  const pending = proof.execute(cap, op, { dispatch: async () => { dispatches++; },
    observe: async () => ({ source: 'native', value: 'fixture-private-seed' }) });
  await g.entered; proof.invalidate(); g.release();
  const receipt = await pending;
  console.log(JSON.stringify({ case: 'execute-after-invalidate', dispatches, status: receipt.status, effect: receipt.effect }));
  proof.dispose();
  assert.equal(dispatches, 0, 'no dispatch after explicit invalidation');
  assert.equal(receipt.effect, 'none');
});

test('a shallow closed shadow root cannot be called complete without expansion', async () => {
  const calls = [];
  const session = { sessionId: 'fixture', on() {}, off() {}, async send(method, args) {
    calls.push([method, args]);
    if (method === 'DOM.getDocument') return { root: { nodeId: 1, nodeName: '#document', localName: '', nodeValue: '', nodeType: 9, backendNodeId: 1, children: [
      { nodeId: 2, nodeName: 'DIV', nodeValue: '', nodeType: 1, localName: 'div', backendNodeId: 2, shadowRoots: [
        { nodeId: 3, nodeName: '#document-fragment', localName: '', nodeValue: '', nodeType: 11, backendNodeId: 3, shadowRootType: 'closed', childNodeCount: 1 },
      ] },
    ] } };
    if (method === 'DOM.describeNode' && args.backendNodeId === 3) return { node: {
      nodeId: 3, nodeName: '#document-fragment', localName: '', nodeValue: '', nodeType: 11, backendNodeId: 3, shadowRootType: 'closed', childNodeCount: 1, children: [
        { nodeId: 4, nodeName: 'INPUT', nodeValue: '', nodeType: 1, localName: 'input', backendNodeId: 4, childNodeCount: 0, children: [] },
      ],
    } };
    throw Error(`unsupported fake CDP method: ${method}`);
  } };
  const refs = new BackendRefs(session, binding);
  const result = await refs.scan();
  console.log(JSON.stringify({ case: 'shallow-closed-root', complete: result.complete, nodes: result.nodes, calls }));
  refs.dispose();
  assert.ok(result.nodes.some(node => node.closed) || !result.complete,
    'discover the closed child or explicitly report incomplete coverage');
});

for (const boundary of ['prepare', 'execute']) test(`dispose fences pending ${boundary} authority and future prepares`, async () => {
  const g = gate(); let checks = 0, dispatches = 0;
  const proof = new ProtectedProof({ current: binding, authorize: async () => {
    if (++checks === (boundary === 'prepare' ? 1 : 2)) { g.enter(); await g.pending; } return true;
  } });
  const op = intent();
  const pending = boundary === 'prepare' ? proof.prepare(op, 'fixture-private-seed')
    : proof.execute(await proof.prepare(op, 'fixture-private-seed'), op, {
      dispatch: async () => { dispatches++; }, observe: async () => ({ source: 'native', value: 'fixture-private-seed' }),
    });
  await g.entered; proof.dispose(); g.release();
  const result = await pending;
  if (boundary === 'prepare') assert.equal(result, null);
  else { assert.equal(result.status, 'blocked'); assert.equal(result.effect, 'none'); }
  assert.equal(dispatches, 0);
  assert.equal(await proof.prepare({ ...op, operation: 'op2' }, 'fixture-private-seed'), null);
});

for (const control of ['invalidate', 'dispose']) for (const boundary of ['dispatch', 'observe']) {
  test(`${control} during ${boundary} keeps dispatched effect unknown and refuses replay`, async () => {
    const g = gate(); let dispatches = 0, observations = 0;
    const proof = new ProtectedProof({ current: binding, authorize: async () => true });
    const op = intent(); const cap = await proof.prepare(op, 'fixture-private-seed');
    const pending = proof.execute(cap, op, {
      dispatch: async () => { dispatches++; if (boundary === 'dispatch') { g.enter(); await g.pending; } },
      observe: async () => { observations++; if (boundary === 'observe') { g.enter(); await g.pending; }
        return { source: 'native', value: 'fixture-private-seed' }; },
    });
    await g.entered; proof[control](); g.release();
    const receipt = await pending;
    assert.equal(receipt.status, 'unverifiable'); assert.equal(receipt.effect, 'unknown');
    assert.deepEqual(receipt.completed, []); assert.deepEqual(receipt.untouched, []);
    assert.equal(dispatches, 1); assert.equal(observations, boundary === 'observe' ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-private-seed/);
    assert.equal((await proof.execute(cap, op, { dispatch: async () => { dispatches++; }, observe: async () => ({}) })).status, 'blocked');
    assert.equal(dispatches, 1); proof.dispose();
  });
}

for (const response of ['missing-children', 'partial-children']) test(`closed-root ${response} reports incomplete coverage`, async () => {
  const current = binding; let expands = 0;
  const root = { nodeType: 11, backendNodeId: 3, shadowRootType: 'closed', childNodeCount: 2 };
  const session = { sessionId: 'fixture', on() {}, off() {}, async send(method) {
    if (method === 'DOM.getDocument') return { root };
    if (method === 'DOM.describeNode') { expands++; return { node: { ...root, ...(response === 'partial-children' ? {
      children: [{ nodeType: 1, localName: 'input', backendNodeId: 4, childNodeCount: 0, children: [] }],
    } : {}) } }; }
    throw Error(`unsupported fake CDP method: ${method}`);
  } };
  const refs = new BackendRefs(session, current); const result = await refs.scan(); refs.dispose();
  assert.equal(result.complete, false); assert.ok(result.omitted > 0); assert.equal(expands, 1);
});

test('closed-root expansion discovers its child in the same ref space', async () => {
  const fragment = { nodeType: 11, backendNodeId: 3, shadowRootType: 'closed', childNodeCount: 1 };
  const input = { nodeType: 1, localName: 'input', backendNodeId: 4, childNodeCount: 0, children: [] };
  const calls = [];
  const session = { sessionId: 'fixture', on() {}, off() {}, async send(method, args) {
    calls.push([method, args]);
    if (method === 'DOM.getDocument') return { root: { nodeType: 9, backendNodeId: 1, children: [
      { nodeType: 1, localName: 'div', backendNodeId: 2, children: [], shadowRoots: [fragment] },
    ] } };
    if (method === 'DOM.describeNode' && args.backendNodeId === 3) return { node: { ...fragment, children: [input] } };
    throw Error(`unsupported fake CDP method: ${method}`);
  } };
  const refs = new BackendRefs(session, binding); const result = await refs.scan();
  assert.equal(result.complete, true); assert.equal(result.omitted, 0);
  assert.equal(result.nodes.length, 2);
  const child = result.nodes.find(node => node.closed); assert.ok(child);
  assert.equal(refs.resolve(child.ref).backendNodeId, 4);
  assert.deepEqual(calls.map(([method]) => method), ['DOM.getDocument', 'DOM.describeNode']);
  refs.dispose();
});

for (const boundary of ['dispatch', 'observe']) test(`invalidate before queued ${boundary} prevents the adapter invocation`, async () => {
  let proof, checks = 0, dispatches = 0, observations = 0, queued = false;
  const current = () => {
    if (checks === 2 && !queued && dispatches === (boundary === 'dispatch' ? 0 : 1)) {
      queued = true; queueMicrotask(() => proof.invalidate());
    }
    return binding();
  };
  proof = new ProtectedProof({ current, authorize: async () => { checks++; return true; } });
  const op = intent(); const cap = await proof.prepare(op, 'fixture-private-seed');
  const receipt = await proof.execute(cap, op, {
    dispatch: async () => { dispatches++; }, observe: async () => { observations++;
      return { source: 'native', value: 'fixture-private-seed' }; },
  });
  assert.equal(dispatches, boundary === 'dispatch' ? 0 : 1);
  assert.equal(observations, 0);
  assert.equal(receipt.effect, boundary === 'dispatch' ? 'none' : 'unknown');
  proof.dispose();
});
