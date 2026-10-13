import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createBroker } from '../broker.mjs';
import { encodeFrame, createFrameDecoder, authenticate, assertPrivateIPC, listenIPC, connectIPC } from '../ipc.mjs';
import { createScopedAdapter } from '../scoped-adapter.mjs';

const secret = 'a'.repeat(64);
const hello = (id = 'one') => ({ version: 1, secret, uid: process.getuid(), session: id, incarnation: id + '-process' });
const request = (id, tab = 't1', operation = 'browser_act') => ({ id, operation, args: { tab } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  const sends = [], checks = [], events = new Map();
  const session = new Proxy({ sessionId: 'approved-socket',
    async send(method, params, sessionId) { sends.push({ method, params, sessionId }); return {}; },
    on(event, callback) { events.set(event, callback); }, off(event) { events.delete(event); } },
  { get(target, key) { if (key in target || typeof key === 'symbol' || key === 'then') return target[key]; throw Error('unsupported CDP member ' + key); } });
  let connects = 0;
  const broker = createBroker({ uid: process.getuid(), secret, idlePolicy: 'retain',
    browserIncarnation: 'fixture-browser', verifyConnection: () => true, currentTurn: () => 'fixture-turn',
    async connect() { connects++; return session; },
    validateRequest: frame => frame,
    async prepare(args, context) { return { tab: args.tab, target: args.tab, frame: 'frame', document: 1, lease: 1, origin: 'https://fixture.test', ...context }; },
    authorize(plan) { checks.push(plan); return true; },
    dispatchFence: () => true,
    async dispatch(plan, context) { await context.session.send('Fixture.operation', { tab: plan.tab }); return { effect: 'verified', observation: { text: 'fixture' } }; },
    redact: x => x, ...options });
  return { broker, session, sends, checks, events, connects: () => connects };
}
async function connected(options) { const f = fixture(options); await f.broker.connect({ userInitiated: true }); return f; }

test('connection is deliberate, retained across 1/4/13 clients, and never inferred from a frontend', async () => {
  const f = fixture(); const before = f.broker.attach(hello());
  assert.equal((await before.request(request('before'))).error.code, 'DISCONNECTED');
  assert.equal(f.connects(), 0); before.disconnect();
  await assert.rejects(f.broker.connect({ userInitiated: false }), /EXPLICIT_CONNECT_REQUIRED/);
  await f.broker.connect({ userInitiated: true });
  for (const count of [1, 4, 13]) {
    const clients = Array.from({ length: count }, (_, i) => f.broker.attach(hello('c' + count + '-' + i)));
    const receipts = await Promise.all(clients.map((c, i) => c.request(request('op', 't' + i))));
    assert.ok(receipts.every(r => r.effect === 'verified'));
    clients.forEach(c => c.disconnect());
  }
  assert.equal(f.connects(), 1); assert.equal(f.broker.status().state, 'connected');
});
test('idle policy has no guessed default', () => {
  assert.throws(() => fixture({ idlePolicy: undefined }), /IDLE_POLICY_REQUIRED/);
});
test('same authenticated incarnation can retrieve a dropped receipt after frontend reconnect', async () => {
  const f = await connected(); const first = f.broker.attach(hello());
  const receipt = await first.request(request('retained')); first.disconnect();
  assert.throws(() => f.broker.attach({ ...hello(), incarnation: 'different' }), /SESSION_IN_USE/);
  const resumed = f.broker.attach(hello());
  assert.deepEqual(await resumed.request(request('retained')), receipt);
  assert.equal(f.sends.length, 1); resumed.disconnect();
});
test('private IPC binds one listener, authenticates its peer, and preserves other clients', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp2-ipc-live-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); chmodSync(root, 0o700);
  const f = await connected();
  const server = await listenIPC({ directory: root, broker: f.broker, uid: process.getuid(), secret,
    peerIdentity: () => ({ uid: process.getuid(), testOnly: true }) });
  t.after(() => server.close());
  await assert.rejects(listenIPC({ directory: root, broker: f.broker, uid: process.getuid(), secret,
    peerIdentity: () => ({ uid: process.getuid() }) }), /IPC_SINGLETON/);
  assertPrivateIPC(root, server.path);
  const a = await connectIPC({ path: server.path, hello: hello('ipc-a') });
  const b = await connectIPC({ path: server.path, hello: hello('ipc-b') });
  t.after(() => { a.close(); b.close(); });
  assert.equal((await a.request(request('one', 'ta'))).effect, 'verified'); a.close();
  assert.equal((await b.request(request('two', 'tb'))).effect, 'verified');
  await assert.rejects(connectIPC({ path: server.path, hello: { ...hello('wrong'), secret: 'b'.repeat(64) } }), /IPC_CLOSED/);
  assert.equal(f.connects(), 1);
});
for (const [label, changes] of Object.entries({ version: { version: 2 }, token: { secret: 'b'.repeat(64) }, uid: { uid: -1 }, session: { session: '' }, incarnation: { incarnation: '' }, extra: { approved: true } }))
  test('rejects unauthenticated IPC ' + label, () => assert.throws(() => authenticate({ ...hello(), ...changes }, { uid: process.getuid(), secret }), /IPC_AUTH/));
test('bounded UTF-8 framing supports split messages and refuses malformed length/body', () => {
  const input = { message: '🙂' }; const bytes = encodeFrame(input); const decoder = createFrameDecoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(bytes.subarray(3)), [input]);
  const large = Buffer.alloc(4); large.writeUInt32BE(4 * 1024 * 1024 + 1);
  assert.throws(() => createFrameDecoder().push(large), /FRAME_LIMIT/);
  assert.throws(() => createFrameDecoder().push(Buffer.from([0, 0, 0, 1, 255])), /FRAME_JSON/);
  assert.throws(() => encodeFrame({ message: 'x'.repeat(4 * 1024 * 1024) }), /FRAME_LIMIT/);
});
test('private IPC filesystem rejects non-socket, public directory and symlink paths', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp2-ipc-')));
  try {
    chmodSync(root, 0o700); const p = join(root, 'broker.sock'); writeFileSync(p, '', { mode: 0o600 });
    assert.throws(() => assertPrivateIPC(root, p), /IPC_SOCKET/);
    chmodSync(root, 0o755); assert.throws(() => assertPrivateIPC(root, p), /IPC_DIRECTORY/);
    const nested = join(root, 'nested'); mkdirSync(nested); assert.throws(() => assertPrivateIPC(root, join(nested, 'broker.sock')), /IPC_PATH/);
    chmodSync(root, 0o700); const alias = root + '-alias'; symlinkSync(root, alias);
    try { assert.throws(() => assertPrivateIPC(alias, join(alias, 'broker.sock')), /IPC_DIRECTORY/); } finally { rmSync(alias); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('request shape is closed and immutable before asynchronous preparation', async () => {
  const gate = deferred(); let seen;
  const f = await connected({ async prepare(args, context) { await gate.promise; seen = args.tab; return { target: args.tab, ...context }; } });
  const client = f.broker.attach(hello()); const input = request('a'); const pending = client.request(input); input.args.tab = 'foreign'; gate.resolve();
  await pending; assert.equal(seen, 't1');
  for (const operation of ['Runtime.evaluate', 'Browser.close', 'browser_capture']) assert.equal((await client.request(request(operation, 't1', operation))).error.code, 'INVALID_ARGUMENT');
  assert.equal((await client.request({ ...request('bad'), approved: true })).error.code, 'INVALID_ARGUMENT');
});
test('duplicate exact request returns its retained receipt; changed args never dispatch', async () => {
  const f = await connected(); const c = f.broker.attach(hello());
  const first = await c.request(request('same')); const repeat = await c.request(request('same'));
  assert.deepEqual(repeat, first); assert.equal(f.sends.length, 1);
  assert.equal((await c.request(request('same', 't2'))).error.code, 'DUPLICATE_MISMATCH');
});
test('receipt mutation by a frontend cannot rewrite retained history', async () => {
  const f = await connected(); const c = f.broker.attach(hello()); const r = await c.request(request('a'));
  r.effect = 'unknown'; r.observation.text = 'forged';
  const retained = await c.request(request('a')); assert.equal(retained.effect, 'verified'); assert.equal(retained.observation.text, 'fixture');
});
test('two sessions never share receipt keys or policy context', async () => {
  const f = await connected(); const a = f.broker.attach(hello('a')), b = f.broker.attach(hello('b'));
  await Promise.all([a.request(request('same', 'ta')), b.request(request('same', 'tb'))]);
  assert.equal(f.sends.length, 2); assert.deepEqual(new Set(f.checks.map(x => x.session)), new Set(['a', 'b']));
  assert.throws(() => f.broker.attach(hello('a')), /SESSION_IN_USE/);
});
test('control revocation fences queued work before dispatch', async () => {
  const gate = deferred(); const f = await connected({ async prepare(args, context) { await gate.promise; return { target: args.tab, ...context }; } });
  const c = f.broker.attach(hello()); const pending = c.request(request('a')); f.broker.pause(); gate.resolve();
  assert.equal((await pending).effect, 'none'); assert.equal(f.sends.length, 0);
});
test('an expired or false dispatch fence never sends input', async () => {
  const f = await connected({ dispatchFence: () => false });
  assert.equal((await f.broker.attach(hello()).request(request('a'))).error.code, 'PERMISSION_REQUIRED');
  assert.equal(f.sends.length, 0);
});
test('disconnect after dispatch preserves unknown and cannot auto replay after reconnect', async () => {
  const gate = deferred(); const f = await connected({ async dispatch(plan, context) { await context.session.send('Fixture.operation', {}); await gate.promise; return { effect: 'verified', observation: {} }; } });
  const c = f.broker.attach(hello()); const pending = c.request(request('a'));
  await new Promise(r => setImmediate(r)); f.broker.loseConnection('disconnected'); gate.resolve();
  assert.equal((await pending).effect, 'unknown'); assert.equal(f.connects(), 1);
  await f.broker.connect({ userInitiated: true });
  assert.equal((await c.request(request('a'))).effect, 'unknown'); assert.equal(f.sends.length, 1);
  assert.equal((await c.request(request('new'))).error.code, 'LEASE_LOST');
});
test('frontend disconnect does not cancel another session or close a retained socket', async () => {
  const f = await connected(); const a = f.broker.attach(hello('a')), b = f.broker.attach(hello('b')); a.disconnect();
  assert.equal((await b.request(request('one'))).effect, 'verified'); assert.equal(f.broker.status().state, 'connected');
  assert.equal((await a.request(request('two'))).error.code, 'CLIENT_DISCONNECTED');
});
test('slow client cannot hold an independent target; same target remains serialized', async () => {
  const gate = deferred(); const order = []; const f = await connected({ async dispatch(plan) { order.push(plan.target); if (plan.target === 'slow') await gate.promise; return { effect: 'verified', observation: {} }; } });
  const a = f.broker.attach(hello('a')), b = f.broker.attach(hello('b')); const slow = a.request(request('a', 'slow'));
  assert.equal((await b.request(request('b', 'fast'))).effect, 'verified'); gate.resolve(); await slow;
  assert.deepEqual(order, ['slow', 'fast']);
});
test('one end-to-end timeout preserves dispatch uncertainty and no retry', async () => {
  const f = await connected({ timeoutMs: 15, dispatch: () => new Promise(() => {}) }); const c = f.broker.attach(hello());
  const r = await c.request(request('a')); assert.equal(r.effect, 'unknown'); assert.equal(r.error.code, 'TIMEOUT');
  assert.deepEqual(await c.request(request('a')), r);
});
test('redaction occurs before delivery; failures preserve unknown, never secret error output', async () => {
  const f = await connected({ dispatch: async () => ({ effect: 'protected', observation: { value: 'secret' } }), redact: () => ({ value: '[protected]' }) });
  assert.doesNotMatch(JSON.stringify(await f.broker.attach(hello()).request(request('a'))), /secret/);
  const bad = await connected({ redact: () => { throw Error('secret'); } }); const r = await bad.broker.attach(hello()).request(request('a'));
  assert.equal(r.effect, 'unknown'); assert.doesNotMatch(JSON.stringify(r), /secret/);
});
test('queue and receipt banks are bounded, including retained unknown effects', async () => {
  const gate = deferred(); const f = await connected({ maxSession: 2, dispatch: () => gate.promise }); const c = f.broker.attach(hello());
  const a = c.request(request('a')), b = c.request(request('b'));
  assert.equal((await c.request(request('c'))).error.code, 'BACKPRESSURE'); gate.resolve({ effect: 'verified', observation: {} }); await Promise.all([a, b]);
});
test('the virtual adapter never forwards global autoattach, downloads or unrelated targets', async () => {
  const f = fixture(); const lease = { target: 'owned', cdpSessionId: 'owned-session', document: 1, frame: 'f', origin: 'https://fixture.test', epoch: 1, executionContextId: 41 };
  const adapter = createScopedAdapter({ session: f.session, checkLease: () => true, helpers: { read: { version: 1, source: 'function(){return document.title}' } } });
  const view = adapter.forLease(lease);
  assert.deepEqual((await view.send('Target.getTargets')).targetInfos.map(t => t.targetId), ['owned']);
  await view.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.equal(f.sends.length, 0);
  for (const method of ['Browser.close', 'Browser.setDownloadBehavior', 'Target.activateTarget', 'Runtime.evaluate', 'Network.getAllCookies']) await assert.rejects(view.send(method, {}), /SCOPED_COMMAND_DENIED/);
  await assert.rejects(view.send('Target.attachToTarget', { targetId: 'unrelated' }), /FOREIGN_TARGET/);
  await view.callFixed('read', []); assert.equal(f.sends[0].sessionId, 'owned-session');
  assert.equal(f.sends[0].params.executionContextId, 41);
  await assert.rejects(view.callFixed('model-code', []), /FIXED_HELPER_REQUIRED/);
  adapter.disconnect(); assert.equal(f.sends.some(x => x.method === 'Browser.close'), false);
});
test('a fixed helper without a current frame context fails closed', async () => {
  const f = fixture(); const adapter = createScopedAdapter({ session: f.session, checkLease: () => true, helpers: { read: { version: 1, source: 'function(){return 1}' } } });
  const view = adapter.forLease({ target: 'owned', cdpSessionId: 'own', document: 1, frame: 'f', origin: 'https://fixture.test', epoch: 1 });
  await assert.rejects(view.callFixed('read', []), /FRAME_CONTEXT_REQUIRED/); assert.equal(f.sends.length, 0); adapter.disconnect();
});
test('same target operations serialize while authorization is held', async () => {
  const gate = deferred(); let count = 0;
  const f = await connected({ async dispatch() { count++; if (count === 1) await gate.promise; return { effect: 'verified', observation: {} }; } });
  const c = f.broker.attach(hello()); const first = c.request(request('first')), second = c.request(request('second'));
  await new Promise(r => setImmediate(r)); assert.equal(count, 1); gate.resolve(); await Promise.all([first, second]); assert.equal(count, 2);
});
test('cancelling a queued client cannot release another client target owner', async () => {
  const gate = deferred(); let count = 0;
  const f = await connected({ async dispatch() { count++; if (count === 1) await gate.promise; return { effect: 'verified', observation: {} }; } });
  const a = f.broker.attach(hello('a')), b = f.broker.attach(hello('b')), c = f.broker.attach(hello('c'));
  const first = a.request(request('first')); await new Promise(r => setImmediate(r));
  const second = b.request(request('second')); await new Promise(r => setImmediate(r)); b.disconnect(); await second;
  const third = c.request(request('third')); await new Promise(r => setImmediate(r));
  const countWhileHeld = count; gate.resolve(); await Promise.all([first, third]);
  assert.equal(countWhileHeld, 1);
});
test('authenticated IPC 1/4/13 frontend clients share one connection and retain raw timings', async t => {
  const metrics = { workload: 'bp2-authenticated-uds-fake-dispatch-v1', realConsent: false, realIPC: true,
    independentProcesses: false, trials: 20, order: [1, 4, 13], cells: [] };
  for (const count of metrics.order) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp2-ipc-matrix-'))); chmodSync(root, 0o700);
    const f = await connected(); let listener; const clients = [];
    try {
      listener = await listenIPC({ directory: root, broker: f.broker, uid: process.getuid(), secret,
        peerIdentity: () => ({ uid: process.getuid(), testOnly: true }) });
      for (let i = 0; i < count; i++) clients.push(await connectIPC({ path: listener.path, hello: hello('client' + i) }));
      const samplesMs = [];
      for (let trial = 0; trial < 20; trial++) await Promise.all(clients.map(async (client, index) => {
        const start = performance.now(); const response = await client.request(request('trial' + trial, 't' + index));
        samplesMs.push(performance.now() - start); assert.equal(response.effect, 'verified');
      }));
      const sorted = [...samplesMs].sort((a, b) => a - b), rank = p => sorted[Math.ceil(sorted.length * p) - 1];
      metrics.cells.push({ clients: count, samplesMs, p50Ms: rank(.5), p90Ms: rank(.9), connects: f.connects() });
      assert.equal(f.connects(), 1);
    } finally { clients.forEach(c => c.close()); await listener?.close(); rmSync(root, { recursive: true, force: true }); }
  }
  t.diagnostic('BP2_IPC_METRICS ' + JSON.stringify(metrics));
});
test('a failed identity verifier leaves no accepted connection', async () => {
  let closed = 0; const f = fixture({ verifyConnection: () => false, disconnect: () => closed++ });
  await assert.rejects(f.broker.connect({ userInitiated: true }), /STALE_INSTANCE/);
  assert.equal(f.broker.status().state, 'stale-instance'); assert.equal(closed, 1);
});
test('missing trusted integration is never represented as an allow', () => {
  for (const name of ['verifyConnection', 'currentTurn', 'validateRequest', 'prepare', 'authorize', 'dispatchFence', 'dispatch', 'redact']) assert.throws(() => fixture({ [name]: undefined }), /TRUSTED_CONTRACT_REQUIRED/);
});
test('adapter rechecks scope on every dispatch and filters unrelated events', async () => {
  let live = true; const f = fixture(); const adapter = createScopedAdapter({ session: f.session, checkLease: () => live, helpers: {} });
  const view = adapter.forLease({ target: 'owned', cdpSessionId: 'own', document: 1, frame: 'f', origin: 'https://fixture.test', epoch: 1 });
  let seen = 0; view.on('Page.loadEventFired', () => seen++);
  f.events.get('event')({ method: 'Page.loadEventFired', sessionId: 'other', params: {} });
  f.events.get('event')({ method: 'Page.loadEventFired', sessionId: 'own', params: {} }); assert.equal(seen, 1);
  live = false; await assert.rejects(view.send('Page.enable'), /LEASE_LOST/); assert.equal(f.sends.length, 0);
});
test('changed turn or socket incarnation during preparation never reaches dispatch', async () => {
  for (const change of ['turn', 'socket']) {
    const gate = deferred(); let turn = 'fixture-turn';
    const f = await connected({ currentTurn: () => turn, async prepare(args, context) { await gate.promise; return { target: args.tab, ...context }; } });
    const c = f.broker.attach(hello()); const pending = c.request(request('a'));
    if (change === 'turn') turn = 'next-turn'; else f.session.sessionId = 'next-socket';
    gate.resolve(); assert.equal((await pending).effect, 'none'); assert.equal(f.sends.length, 0);
  }
});
test('timeout before preparation is no-effect and late work cannot dispatch', async () => {
  const gate = deferred(); const f = await connected({ timeoutMs: 10, prepare: () => gate.promise }); const c = f.broker.attach(hello());
  assert.equal((await c.request(request('a'))).effect, 'none'); gate.resolve({ target: 't1' });
  await new Promise(r => setImmediate(r)); assert.equal(f.sends.length, 0);
});
test('unknown target is quarantined rather than retried under a new operation id', async () => {
  const f = await connected({ dispatch: async () => ({ effect: 'unknown', observation: {} }) }); const c = f.broker.attach(hello());
  assert.equal((await c.request(request('a'))).effect, 'unknown');
  const r = await c.request(request('b')); assert.equal(r.effect, 'none'); assert.equal(r.error.code, 'STATE_UNVERIFIABLE');
});
test('an oversized verified observation is omitted without losing completion or replay protection', async () => {
  const f = await connected({ dispatch: async () => ({ effect: 'verified', observation: { text: '🙂'.repeat(4000) } }) });
  const c = f.broker.attach(hello()); const r = await c.request(request('a'));
  assert.equal(r.effect, 'verified'); assert.equal(r.completed, 1); assert.equal(r.observation.omitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 12000); assert.deepEqual(await c.request(request('a')), r);
});
test('four public verbs compose an explicit fake fixture slice without a root-CDP escape', async () => {
  const page = { value: '', clicked: false }; const f = await connected({
    async dispatch(plan) {
      if (plan.operationName === 'browser_act') page.clicked = true;
      if (plan.operationName === 'browser_fill') page.value = 'fixture';
      return { effect: 'verified', observation: { ...page }, ...(plan.operationName === 'browser_open' ? { tab: 'tfixture' } : {}) };
    } });
  const c = f.broker.attach(hello());
  const opened = await c.request(request('open', 'tfixture', 'browser_open')); assert.equal(opened.tab, 'tfixture');
  assert.equal((await c.request(request('read', opened.tab, 'browser_read'))).observation.value, '');
  assert.equal((await c.request(request('click', opened.tab))).observation.clicked, true);
  assert.equal((await c.request(request('fill', opened.tab, 'browser_fill'))).observation.value, 'fixture');
  c.disconnect(); assert.equal(f.broker.status().clients, 0);
});
test('named fake workload records whole-request distributions and every sample', async t => {
  const metrics = { workload: 'bp2-fake-four-verb-broker-v1', transport: 'strict in-process fake CDP',
    trials: 20, order: [1, 4, 13], realConsent: false, realIPC: false, policy: 'explicit fixture callbacks', cells: [] };
  for (const count of metrics.order) {
    const f = await connected(); const clients = Array.from({ length: count }, (_, i) => f.broker.attach(hello('m' + i)));
    const samples = [];
    for (let trial = 0; trial < metrics.trials; trial++) await Promise.all(clients.map(async (c, i) => {
      const start = performance.now(); const result = await c.request(request('trial' + trial, 'tab' + i));
      samples.push(performance.now() - start); assert.equal(result.effect, 'verified');
    }));
    const sorted = [...samples].sort((a, b) => a - b), rank = p => sorted[Math.ceil(sorted.length * p) - 1];
    metrics.cells.push({ clients: count, samplesMs: samples, p50Ms: rank(0.5), p90Ms: rank(0.9), connects: f.connects() });
    clients.forEach(c => c.disconnect());
  }
  t.diagnostic('BP2_METRICS ' + JSON.stringify(metrics));
});
test('partial form preserves protected completed prefix and untouched suffix with unknown recovery', async () => {
  const f = await connected({ dispatch: async () => ({ effect: 'unknown', completed: 1, untouched: 2,
    results: [{ effect: 'protected', observation: { value: 'private' } }], observation: {} }), redact: () => ({ value: '[protected]' }) });
  const r = await f.broker.attach(hello()).request(request('form', 't1', 'browser_fill'));
  assert.equal(r.completed, 1); assert.equal(r.untouched, 2); assert.equal(r.results[0].effect, 'protected');
  assert.equal(r.error.code, 'EFFECT_UNKNOWN'); assert.doesNotMatch(JSON.stringify(r), /private/);
});
test('unverifiable proof returns a recovery error instead of a success-shaped receipt', async () => {
  const f = await connected({ dispatch: async () => ({ effect: 'unverifiable', observation: {} }) });
  const r = await f.broker.attach(hello()).request(request('a'));
  assert.equal(r.error.code, 'STATE_UNVERIFIABLE'); assert.equal(r.phase, 'observed');
});

// Run fault probes in an owned Node child so the pre-fix unhandled rejection is
// measured without escaping the parent test. Each probe owns its socket bank.
async function ipcFaultProbe(mode) {
  const assert = (await import('node:assert/strict')).default;
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { listenIPC, connectIPC, FRAME_LIMIT } = await import('./bench/direct-browser2/ipc.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp2-ipc-fault-'))); fs.chmodSync(root, 0o700);
  const uid = process.getuid(), secret = 'd'.repeat(64), unhandled = [], clients = [];
  const record = error => unhandled.push(error.message);
  process.on('unhandledRejection', record);
  let listener;
  try {
    const broker = { attach() { return { disconnect() {}, request(input) {
      return Promise.resolve(input.id === 'encoder-fault' ? { text: 'x'.repeat(FRAME_LIMIT) } : { effect: 'verified' });
    } }; } };
    listener = await listenIPC({ directory: root, broker, uid, secret, peerIdentity: () => ({ uid, testOnly: true }) });
    const hello = session => ({ version: 1, secret, uid, session, incarnation: session + '-client' });
    const bad = await connectIPC({ path: listener.path, hello: hello('bad'), timeoutMs: 2000 }); clients.push(bad);
    const good = await connectIPC({ path: listener.path, hello: hello('good') }); clients.push(good);
    const id = mode === 'long-id' ? 'x'.repeat(FRAME_LIMIT - 64) : 'encoder-fault';
    await assert.rejects(bad.request({ id }), /IPC_CLOSED/);
    assert.equal((await good.request({ id: 'healthy' })).effect, 'verified');
    assert.deepEqual(unhandled, []);
  } finally {
    clients.forEach(client => client.close()); await listener?.close();
    fs.rmSync(root, { recursive: true, force: true }); process.off('unhandledRejection', record);
  }
}
for (const mode of ['long-id', 'encoder-fault']) test(`IPC contains ${mode} failure and preserves another frontend`, async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `(${ipcFaultProbe})(${JSON.stringify(mode)})`],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('IPC rejects malformed IDs and serves valid maximum-length IDs', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp2-ipc-ids-'))); chmodSync(root, 0o700);
  const f = await connected();
  const listener = await listenIPC({ directory: root, broker: f.broker, uid: process.getuid(), secret,
    peerIdentity: () => ({ uid: process.getuid(), testOnly: true }) });
  const clients = [];
  t.after(async () => { clients.forEach(c => c.close()); await listener.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [i, id] of ['', 'has space', 'has/slash', 'x'.repeat(129)].entries()) {
    const client = await connectIPC({ path: listener.path, hello: hello('invalid' + i) }); clients.push(client);
    await assert.rejects(client.request({ id }), /IPC_CLOSED/);
  }
  const client = await connectIPC({ path: listener.path, hello: hello('valid') }); clients.push(client);
  assert.equal((await client.request(request('x'.repeat(128)))).effect, 'verified');
});
