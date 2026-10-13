import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSurface, compactTools, expandSchema, measureSurface } from '../surface.mjs';
import { browserTools } from '../../direct-browser/tools.mjs';
import { BrowserFailure } from '../errors.mjs';

const click = { name: 'browser_act', arguments: { tab: 't1', op: 'click', ref: 'r7' } };
const read = { name: 'browser_read', arguments: { tab: 't1' } };
export function fixture(options = {}) {
  let connects = 0;
  const inputs = [], authorizations = [], fallbackCalls = [];
  const token = Symbol('trusted resume');
  const session = new Proxy({ sessionId: 'cdp-1', send: async (...args) => inputs.push(args), on() {}, off() {} },
    { get(target, key) { if (key in target || typeof key === 'symbol' || key === 'then') return target[key]; throw Error('Unsupported CDP member ' + key); } });
  const operate = async (args, context) => {
    await context.session.send('Fixture.operation', args);
    if (options.error) throw options.error;
    return { effect: options.effect ?? 'verified', observation: { text: 'synthetic observed state', untrusted: true },
      ...(args.browser ? { tab: 't1' } : {}) };
  };
  const surface = createSurface({ state: options.state ?? 'ready',
    connect: async () => { connects++; return { session, operations: { open: operate, read: operate, act: operate, fill: operate } }; },
    authorize: async (...args) => { authorizations.push(args); return options.allowed !== false; },
    redact: x => x, authorizeResume: async authority => authority === token,
    fallback: async request => { fallbackCalls.push(request); return { completed: 1, results: [{ effect: 'verified', observation: {} }], observation: {} }; },
    allowEngineFallback: options.allowEngineFallback ?? false });
  return { surface, inputs, authorizations, fallbackCalls, token, session, connects: () => connects, options };
}
test('four lean schemas preserve all v1 constraints after local reference expansion', () => {
  const tools = compactTools();
  assert.deepEqual(tools.map(tool => tool.name), browserTools().map(tool => tool.name));
  tools.forEach((tool, i) => assert.deepEqual(expandSchema(tool.inputSchema), browserTools()[i].inputSchema));
  assert.ok(Buffer.byteLength(JSON.stringify(tools)) < Buffer.byteLength(JSON.stringify(browserTools())));
});
test('initialization is shared across concurrent calls and reused for later actions', async () => {
  const f = fixture(); await Promise.all([f.surface.call(read), f.surface.call(read)]);
  await f.surface.call(click);
  assert.equal(f.connects(), 1); assert.equal(f.inputs.length, 3);
  assert.equal(f.authorizations.length, 3, 'cached transport never caches permission');
});
for (const [state, code] of Object.entries({ setting_off: 'SETTING_OFF', unsupported: 'CONNECTION_UNSUPPORTED',
  approval_pending: 'CONNECTION_APPROVAL_PENDING', declined: 'CONNECTION_DECLINED', stale_instance: 'STALE_INSTANCE', disconnected: 'DISCONNECTED' }))
  test('transport state ' + state + ' is distinct from site/action denial', async () => {
    const f = fixture({ state }); const result = await f.surface.call(click);
    assert.equal(result.error.code, code); assert.equal(result.receipt.stage, 'prepared');
    assert.equal(result.error.effect, 'none'); assert.equal(f.connects(), 0); assert.equal(f.inputs.length, 0);
    assert.equal(f.fallbackCalls.length, 0);
  });
test('trusted fallback is restricted to unavailable transport, not declines or safety failures', async () => {
  for (const state of ['unsupported', 'setting_off']) {
    const f = fixture({ state, allowEngineFallback: true }); const result = await f.surface.call(read);
    assert.equal(result.route, 'engine'); assert.equal(f.fallbackCalls.length, 1);
  }
  for (const options of [{ state: 'declined' }, { allowed: false },
    { error: new BrowserFailure('STALE_REF', { effect: 'none' }) },
    { error: new BrowserFailure('PERMISSION_REQUIRED', { effect: 'none' }) }]) {
    const f = fixture({ ...options, allowEngineFallback: true });
    const result = await f.surface.call(click); assert.ok(result.error); assert.equal(f.fallbackCalls.length, 0);
  }
});
test('raw evaluate and model approval flags cannot escape through fallback', async () => {
  const f = fixture({ state: 'unsupported', allowEngineFallback: true });
  for (const request of [{ name: 'js', arguments: { code: 'Runtime.evaluate("pay")' } },
    { ...click, arguments: { ...click.arguments, approved: true } }]) {
    const result = await f.surface.call(request); assert.equal(result.error.code, 'INVALID_ARGUMENT');
  }
  assert.equal(f.fallbackCalls.length, 0); assert.equal(f.inputs.length, 0);
});
test('read-only fallback failure cannot become phantom success or disclose raw errors', async () => {
  const surface = createSurface({ state: 'unsupported', allowEngineFallback: true,
    fallback: async () => { throw Error('private credentials'); }, authorize: () => true, redact: x => x });
  const result = await surface.call(read);
  assert.equal(result.receipt.stage, 'unknown'); assert.ok(result.error);
  assert.doesNotMatch(JSON.stringify(result), /private credentials/);
});
test('connection state during a call fences new dispatch without replay', async () => {
  const f = fixture();
  const pending = f.surface.call(click); f.surface.setState('disconnected');
  const result = await pending;
  assert.equal(result.error.code, 'DISCONNECTED'); assert.equal(f.inputs.length, 0);
});
test('an unknown effect survives reconnect until a new read, without replaying its operation', async () => {
  const f = fixture({ error: new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' }) });
  const result = await f.surface.call(click);
  assert.equal(result.receipt.stage, 'unknown'); assert.equal(f.inputs.length, 1);
  f.surface.setState('disconnected');
  assert.equal((await f.surface.reconnect('model approval')).error.code, 'PERMISSION_REQUIRED');
  assert.equal(f.connects(), 1);
  f.options.error = null;
  assert.equal((await f.surface.reconnect(f.token)).connected, true);
  assert.equal(f.connects(), 2); assert.equal(f.inputs.length, 1);
  const blocked = await f.surface.call(click);
  assert.equal(blocked.error.code, 'RECOVERY_READ_REQUIRED'); assert.equal(f.inputs.length, 1);
  await f.surface.call(read); await f.surface.call(click);
  assert.equal(f.inputs.length, 3); assert.equal(f.surface.receipt(result.receipt.operation).stage, 'unknown');
});
test('unknown dispatch recovery is a valid read and never an automatic retry instruction', async () => {
  const f = fixture({ error: new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' }) });
  const result = await f.surface.call(click);
  assert.equal(result.error.next.tool, 'browser_read'); assert.deepEqual(result.error.next.arguments, { tab: 't1' });
  assert.equal(result.receipt.untouched, 0); assert.equal(f.inputs.length, 1);
});
test('complete overhead accounting labels proxies and measures whole serialized calls', async () => {
  const f = fixture(); const measurements = await measureSurface(f.surface, read, 20);
  assert.equal(measurements.samples, 20); assert.equal(measurements.actual_model_tokens, null);
  assert.equal(measurements.raw.length, 20);
  assert.deepEqual(measurements.raw.map(row => row.trial), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(measurements.schema_bytes > 0); assert.ok(measurements.call_bytes > 0); assert.ok(measurements.response_bytes > 0);
  assert.ok(measurements.overhead_p90_ms >= measurements.overhead_p50_ms);
  assert.equal(measurements.transport, 'unmeasured; supplied adapter');
  console.log('OFFLINE_SURFACE_MEASUREMENTS', JSON.stringify({ ...measurements,
    source_schema_bytes: Buffer.byteLength(JSON.stringify(browserTools())),
    configuration: { samples: 20, state: 'ready', adapter: 'in-process CDP fake', node: process.version } }));
});
test('disconnect during an awaited policy decision cancels queued input', async () => {
  let resolvePolicy, calls = 0;
  const session = { sessionId: 's1', send() {}, on() {}, off() {} };
  const surface = createSurface({ state: 'ready', connect: async () => ({ session,
    operations: { act: async () => { calls++; return { effect: 'verified', observation: {} }; } } }),
    authorize: () => new Promise(resolve => { resolvePolicy = resolve; }), redact: x => x });
  const pending = surface.call(click);
  while (!resolvePolicy) await new Promise(resolve => setImmediate(resolve));
  surface.setState('disconnected'); resolvePolicy(true);
  const result = await pending;
  assert.equal(calls, 0); assert.equal(result.error.code, 'DISCONNECTED'); assert.equal(result.error.effect, 'none');
});
test('a stopped batch retains its verified prefix with an observed operation receipt', async () => {
  let approved = 0;
  const session = { sessionId: 's1', send() {}, on() {}, off() {} };
  const surface = createSurface({ state: 'ready', connect: async () => ({ session,
    operations: { act: async () => ({ effect: 'verified', observation: {} }) } }),
    authorize: () => ++approved === 1, redact: x => x });
  const result = await surface.call({ name: 'browser_act', arguments: { tab: 't1', steps: [
    { op: 'click', ref: 'r1' }, { op: 'click', ref: 'r2' }] } });
  assert.equal(result.receipt.stage, 'observed'); assert.equal(result.receipt.completed, 1);
  assert.equal(result.receipt.untouched, 1); assert.equal(result.error.effect, 'none');
});
test('concurrent trusted reconnect requests share one new connection', async () => {
  const f = fixture(); await f.surface.call(read); f.surface.setState('disconnected');
  await Promise.all([f.surface.reconnect(f.token), f.surface.reconnect(f.token), f.surface.reconnect(f.token)]);
  assert.equal(f.connects(), 2);
});
test('an engine fallback denial preserves policy and effect instead of becoming a transport error', async () => {
  const surface = createSurface({ state: 'unsupported', allowEngineFallback: true, authorize: () => true, redact: x => x,
    fallback: async () => ({ error: { code: 'PERMISSION_REQUIRED', phase: 'policy', effect: 'none', completed: 0 }, results: [] }) });
  const result = await surface.call(click);
  assert.equal(result.error.code, 'PERMISSION_REQUIRED'); assert.equal(result.error.effect, 'none');
  assert.equal(result.receipt.stage, 'prepared');
});
test('pending reconnection returns promptly without queuing a read for later consent', async () => {
  let finishConnection, operations = 0;
  const session = { sessionId: 's1', send() {}, on() {}, off() {} };
  const surface = createSurface({ state: 'disconnected', authorizeResume: () => true, authorize: () => true, redact: x => x,
    connect: () => new Promise(resolve => { finishConnection = () => resolve({ session, operations: {
      read: async () => { operations++; return { effect: 'verified', observation: {} }; } } }); }) });
  const pending = surface.reconnect('trusted');
  while (!finishConnection) await new Promise(resolve => setImmediate(resolve));
  assert.equal(surface.status().connection, 'approval_pending');
  const result = await surface.call(read);
  assert.equal(result.error.code, 'CONNECTION_APPROVAL_PENDING'); assert.equal(operations, 0);
  finishConnection(); await pending;
  assert.equal(operations, 0); await surface.call(read); assert.equal(operations, 1);
});
test('an authorized fallback open returns its adapter-owned tab for later reads', async () => {
  const surface = createSurface({ state: 'unsupported', allowEngineFallback: true, authorize: () => true, redact: x => x,
    fallback: async () => ({ completed: 1, results: [{ effect: 'verified', tab: 't1', observation: {} }], observation: {} }) });
  const result = await surface.call({ name: 'browser_open', arguments: { browser: 'b1', url: 'https://example.test' } });
  assert.equal(result.results[0].tab, 't1'); assert.equal(result.receipt.stage, 'verified');
});
test('a fallback policy throw is pre-dispatch and a callback throw is dispatch-unknown', async () => {
  for (const at of ['policy', 'callback']) {
    let calls = 0;
    const surface = createSurface({ state: 'unsupported', allowEngineFallback: true, redact: x => x,
      authorize: () => { if (at === 'policy') throw Error('private'); return true; },
      fallback: () => { calls++; throw Error('private'); } });
    const result = await surface.call(click);
    assert.equal(result.error.effect, at === 'policy' ? 'none' : 'unknown');
    assert.equal(result.error.phase, at === 'policy' ? 'policy' : 'dispatch');
    assert.equal(calls, at === 'policy' ? 0 : 1);
  }
});
test('a connection change during fallback cannot publish phantom verified success', async () => {
  let finish;
  const surface = createSurface({ state: 'unsupported', allowEngineFallback: true, authorize: () => true, redact: x => x,
    fallback: () => new Promise(resolve => { finish = () => resolve({ completed: 1, results: [{ effect: 'verified', observation: {} }], observation: {} }); }) });
  const pending = surface.call(click);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  surface.setState('disconnected'); finish();
  const result = await pending;
  assert.equal(result.receipt.stage, 'unknown'); assert.equal(result.error.code, 'DISCONNECTED');
});
test('an explicit broker decline during connect survives a later connection exception', async () => {
  let surface;
  surface = createSurface({ state: 'disconnected', authorizeResume: () => true, authorize: () => true, redact: x => x,
    connect: async () => { surface.setState('declined'); throw Error('private handshake'); } });
  const result = await surface.reconnect('trusted');
  assert.equal(result.error.code, 'CONNECTION_DECLINED'); assert.equal(surface.status().connection, 'declined');
});
test('a proved unavailable direct capability can use a separately authorized engine adapter', async () => {
  let fallbacks = 0, approvals = 0;
  const session = { sessionId: 's1', send() {}, on() {}, off() {} };
  const surface = createSurface({ state: 'ready', allowEngineFallback: true,
    connect: async () => ({ session, operations: {} }), authorize: () => { approvals++; return true; }, redact: x => x,
    fallback: async () => { fallbacks++; return { completed: 1, results: [{ effect: 'verified', observation: {} }], observation: {} }; } });
  const result = await surface.call(click);
  assert.equal(result.route, 'engine'); assert.equal(result.receipt.stage, 'verified');
  assert.equal(fallbacks, 1); assert.equal(approvals, 1);
});
test('partial completion or uncertain capability failure never reroutes a batch', async () => {
  for (const effect of ['none', 'unknown']) {
    let calls = 0, fallbacks = 0;
    const session = { sessionId: 's1', send() {}, on() {}, off() {} };
    const surface = createSurface({ state: 'ready', allowEngineFallback: true, authorize: () => true, redact: x => x,
      connect: async () => ({ session, operations: { act: async () => {
        if (++calls === 2) throw new BrowserFailure('BACKGROUND_UNAVAILABLE', { effect });
        return { effect: 'verified', observation: {} };
      } } }), fallback: async () => { fallbacks++; } });
    const result = await surface.call({ name: 'browser_act', arguments: { tab: 't1', steps: [
      { op: 'click', ref: 'r1' }, { op: 'click', ref: 'r2' }] } });
    assert.equal(result.error.completed, 1); assert.equal(fallbacks, 0); assert.equal(calls, 2);
  }
});

function regressionSurface(operations, options = {}) {
  const session = new Proxy({ sessionId: 'regression', send() {}, on() {}, off() {} },
    { get(target, key) { if (key in target || typeof key === 'symbol' || key === 'then') return target[key]; throw Error('Unsupported CDP member ' + key); } });
  return createSurface({ state: 'ready', authorize: () => true, redact: x => x,
    connect: async () => ({ session, operations }), ...options });
}
const threeSteps = { name: 'browser_act', arguments: { tab: 't1', steps: [
  { op: 'click', ref: 'r1' }, { op: 'click', ref: 'r2' }, { op: 'click', ref: 'r3' }] } };
for (const effect of ['verified', 'protected']) test('oversized ' + effect + ' form proof keeps every completed field', async () => {
  let calls = 0;
  const surface = regressionSurface({ fill: async () => { calls++; return { effect, observation: { text: 'x'.repeat(13000), secret: 'private' } }; } },
    { redact: value => { const { secret, ...safe } = value ?? {}; return safe; } });
  const result = await surface.call({ name: 'browser_fill', arguments: { tab: 't1', fields: [
    { ref: 'r1', value: 'one' }, { ref: 'r2', value: 'two' }] } });
  assert.equal(calls, 2); assert.equal(result.receipt.completed, 2); assert.equal(result.receipt.stage, 'verified');
  assert.equal(result.receipt.effect, effect); assert.equal(result.receipt.untouched, 0);
  assert.ok(result.results.every(row => row.effect === effect && row.observation.omitted));
  assert.doesNotMatch(JSON.stringify(result), /private/); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12000);
});
test('explicit read budgets are per-call and do not truncate an overlapping larger read', async () => {
  const surface = regressionSurface({ read: async args => { await new Promise(resolve => setImmediate(resolve));
    return { effect: 'verified', observation: { text: 'x'.repeat(args.tab === 't1' ? 2000 : 13000) } }; } });
  const [small, large] = await Promise.all([surface.call({ name: 'browser_read', arguments: { tab: 't1', max_bytes: 1024 } }),
    surface.call({ name: 'browser_read', arguments: { tab: 't2', max_bytes: 64000 } })]);
  assert.equal(small.receipt.completed, 1); assert.equal(small.observation.omitted, true);
  assert.equal(large.observation.text.length, 13000); assert.ok(!large.error);
});
test('wrong tab, scoped read and omitted state cannot release unknown target recovery', async () => {
  let mutations = 0, omit = false;
  const surface = regressionSurface({ act: async () => { if (++mutations === 1) throw new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' });
    return { effect: 'verified', observation: {} }; }, read: async () => ({ effect: 'verified', observation: omit ? { omitted: true } : {} }) });
  const unknown = await surface.call(click);
  for (const request of [{ name: 'browser_read', arguments: { tab: 't2' } },
    { name: 'browser_read', arguments: { tab: 't1', scope: 'r99' } }, read]) {
    omit = request === read;
    await surface.call(request);
    assert.equal((await surface.call(click)).error.code, 'RECOVERY_READ_REQUIRED');
  }
  assert.equal(mutations, 1); omit = false; await surface.call(read);
  assert.equal((await surface.call(click)).receipt.stage, 'verified');
  assert.deepEqual(surface.receipt(unknown.receipt.operation), unknown.receipt);
});
test('two unknown targets retain independent recovery gates', async () => {
  const counts = new Map();
  const surface = regressionSurface({ act: async args => { const n = (counts.get(args.tab) ?? 0) + 1; counts.set(args.tab, n);
    if (n === 1) throw new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' }); return { effect: 'verified', observation: {} }; },
    read: async () => ({ effect: 'verified', observation: {} }) });
  const second = { ...click, arguments: { ...click.arguments, tab: 't2' } };
  await surface.call(click); await surface.call(second); await surface.call(read);
  assert.equal((await surface.call(click)).receipt.stage, 'verified');
  assert.equal((await surface.call(second)).error.code, 'RECOVERY_READ_REQUIRED');
  assert.equal(counts.get('t2'), 1); assert.equal(surface.status().needsRead, true);
});
test('a read begun before the unknown result cannot reconcile that operation', async () => {
  let finishRead;
  const surface = regressionSurface({ read: () => new Promise(resolve => { finishRead = () => resolve({ effect: 'verified', observation: {} }); }),
    act: async () => { throw new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' }); } });
  const pending = surface.call(read); while (!finishRead) await new Promise(resolve => setImmediate(resolve));
  await surface.call(click); finishRead(); await pending;
  assert.equal((await surface.call(click)).error.code, 'RECOVERY_READ_REQUIRED');
});
test('fallback partial counts exclude unknown work and missing counts promise no untouched work', async () => {
  for (const untouched of [1, undefined]) {
    const surface = regressionSurface({}, { state: 'unsupported', allowEngineFallback: true, fallback: async () => ({
      error: { code: 'EFFECT_UNKNOWN', phase: 'dispatch', effect: 'unknown', completed: 1 },
      results: [{ effect: 'verified', observation: {} }], ...(untouched === undefined ? {} : { untouched }) }) });
    const result = await surface.call(threeSteps);
    assert.equal(result.receipt.completed, 1); assert.equal(result.receipt.untouched, untouched ?? 0);
  }
  const surface = regressionSurface({}, { state: 'unsupported', allowEngineFallback: true, fallback: async () => { throw Error('lost reply'); } });
  assert.equal((await surface.call(threeSteps)).receipt.untouched, 0);
});
test('fallback contradictory untouched counts cannot be published as proof', async () => {
  const surface = regressionSurface({}, { state: 'unsupported', allowEngineFallback: true, fallback: async () => ({
    error: { code: 'EFFECT_UNKNOWN', phase: 'dispatch', effect: 'unknown', completed: 1 },
    results: [{ effect: 'verified', observation: {} }], untouched: 2 }) });
  const result = await surface.call(threeSteps);
  assert.equal(result.receipt.effect, 'unknown'); assert.equal(result.receipt.untouched, 0);
  assert.equal(result.receipt.completed, 1); assert.equal(result.results.length, 1);
});
for (const route of ['direct', 'engine']) test(route + ' generation change retains verified prefix and exact suffix', async () => {
  let surface, calls = 0;
  const partial = { error: { code: 'EFFECT_UNKNOWN', phase: 'dispatch', effect: 'unknown', completed: 1 },
    results: [{ effect: 'verified', observation: {} }], untouched: 1 };
  surface = regressionSurface({ act: async () => { if (++calls === 2) { surface.setState('disconnected');
    throw new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' }); } return { effect: 'verified', observation: {} }; } },
    route === 'engine' ? { state: 'unsupported', allowEngineFallback: true, fallback: async () => { surface.setState('disconnected'); return partial; } } : {});
  const result = await surface.call(threeSteps);
  assert.equal(result.error.code, 'DISCONNECTED'); assert.equal(result.receipt.completed, 1);
  assert.equal(result.results.length, 1); assert.equal(result.receipt.untouched, 1); assert.equal(result.receipt.stage, 'unknown');
});
test('budget accounting never executes observation getters or serializes non-JSON values', async () => {
  let getterCalls = 0;
  const accessor = {}; Object.defineProperty(accessor, 'private', { enumerable: true, get() { getterCalls++; return 'secret'; } });
  for (const observation of [accessor, { toJSON() { throw Error('must not execute'); } }, { number: NaN }, new Date()]) {
    const surface = regressionSurface({ act: async () => ({ effect: 'verified', observation }) });
    const result = await surface.call(click);
    assert.equal(result.receipt.effect, 'unknown'); assert.doesNotMatch(JSON.stringify(result), /secret|must not execute/);
  }
  assert.equal(getterCalls, 0);
});
test('an incomplete full read retains unknown recovery and another target still has its own policy', async () => {
  let reads = 0, calls = 0, policies = 0;
  const surface = regressionSurface({ act: async () => { calls++; throw new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' }); },
    read: async () => ({ effect: 'verified', observation: { coverage: ++reads === 1 ? 'rendered-partial' : 'unknown' } }) },
    { authorize: () => { policies++; return true; } });
  await surface.call(click); await surface.call(read); await surface.call(read);
  assert.equal((await surface.call(click)).error.code, 'RECOVERY_READ_REQUIRED');
  await surface.call({ ...click, arguments: { ...click.arguments, tab: 't2' } });
  assert.equal(calls, 2); assert.equal(policies, 4);
});
test('missing redaction output stays unknown while missing fallback observations reach redaction as null', async () => {
  const missing = regressionSurface({ act: async () => ({ effect: 'verified', observation: {} }) }, { redact: () => undefined });
  assert.equal((await missing.call(click)).receipt.effect, 'unknown');
  let seen = 0;
  const fallback = regressionSurface({}, { state: 'unsupported', allowEngineFallback: true,
    redact: value => { assert.equal(value, null); seen++; return null; },
    fallback: async () => ({ completed: 1, results: [{ effect: 'verified' }] }) });
  assert.equal((await fallback.call(click)).receipt.completed, 1); assert.equal(seen, 2);
});
test('state omitted by the combined receipt budget cannot clear recovery', async () => {
  const surface = regressionSurface({ act: async () => { throw new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' }); },
    read: async () => ({ effect: 'verified', observation: { text: 'x'.repeat(400) } }) });
  await surface.call(click);
  const fresh = await surface.call({ name: 'browser_read', arguments: { tab: 't1', max_bytes: 1024 } });
  assert.equal(fresh.observation.omitted, true);
  assert.equal((await surface.call(click)).error.code, 'RECOVERY_READ_REQUIRED');
});

const incompleteStates = [
  { complete: false }, { pending: true }, { omitted: 1 }, { truncated: true },
  { coverage: { sensing: 'incomplete' } }, { coverage: { complete: false } },
  { coverage: { omitted: 2 } }, { complete: true, pending: true, omitted: 0, coverage: { sensing: 'complete' } },
];
for (const route of ['direct', 'engine']) {
  for (const [index, observation] of incompleteStates.entries()) test(`${route} recovery retains incomplete metadata ${index}`, async () => {
    let mutations = 0;
    const surface = regressionSurface({
      act: async () => { if (++mutations === 1) throw new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' });
        return { effect: 'verified', observation: {} }; },
      read: async () => ({ effect: 'verified', observation }),
    }, route === 'engine' ? { state: 'unsupported', allowEngineFallback: true, fallback: async request => {
      if (request.name !== 'browser_read' && ++mutations === 1) return {
        error: { code: 'EFFECT_UNKNOWN', phase: 'dispatch', effect: 'unknown', completed: 0 }, results: [] };
      return { completed: 1, results: [{ effect: 'verified', observation }], observation };
    } } : {});
    const unknown = await surface.call(click); await surface.call(read);
    assert.equal((await surface.call(click)).error?.code, 'RECOVERY_READ_REQUIRED');
    assert.equal(mutations, 1);
    assert.deepEqual(surface.receipt(unknown.receipt.operation), unknown.receipt);
  });
  for (const observation of [{}, { complete: true, pending: false, omitted: 0, coverage: { sensing: 'complete' } }]) {
    test(`${route} recovery preserves complete legacy and v2 controls ${Object.keys(observation).length}`, async () => {
      let mutations = 0;
      const surface = regressionSurface({
        act: async () => { if (++mutations === 1) throw new BrowserFailure('EFFECT_UNKNOWN', { effect: 'unknown' });
          return { effect: 'verified', observation: {} }; }, read: async () => ({ effect: 'verified', observation }),
      }, route === 'engine' ? { state: 'unsupported', allowEngineFallback: true, fallback: async request => {
        if (request.name !== 'browser_read' && ++mutations === 1) return {
          error: { code: 'EFFECT_UNKNOWN', phase: 'dispatch', effect: 'unknown', completed: 0 }, results: [] };
        return { completed: 1, results: [{ effect: 'verified', observation }], observation };
      } } : {});
      const unknown = await surface.call(click); await surface.call(read);
      assert.equal((await surface.call(click)).receipt.stage, 'verified');
      assert.equal(mutations, 2);
      assert.deepEqual(surface.receipt(unknown.receipt.operation), unknown.receipt);
    });
  }
}
for (const [index, observation] of incompleteStates.entries()) test(`reconnect read remains required for incomplete metadata ${index}`, async () => {
  let state = observation, mutations = 0;
  const surface = regressionSurface({ act: async () => { mutations++; return { effect: 'verified', observation: {} }; },
    read: async () => ({ effect: 'verified', observation: state }) }, { authorizeResume: () => true });
  surface.setState('disconnected'); await surface.reconnect({});
  await surface.call(read);
  assert.equal(surface.status().needsRead, true);
  assert.equal((await surface.call(click)).error?.code, 'RECOVERY_READ_REQUIRED');
  assert.equal(mutations, 0);
  state = { complete: true, omitted: 0, pending: false, coverage: { sensing: 'complete' } };
  await surface.call(read); assert.equal(surface.status().needsRead, false);
  assert.equal((await surface.call(click)).receipt.stage, 'verified'); assert.equal(mutations, 1);
});
