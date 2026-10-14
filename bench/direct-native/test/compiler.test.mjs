import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode } from '../../../plugins/sleight/lib/document-scope.mjs';
import { compileAction, validateRequest, createNativeCompiler, measureExchange } from '../compiler.mjs';
import { nativeTools } from '../tools.mjs';
import { PassThrough } from 'node:stream';
import { createRelay } from '../../../plugins/sleight/lib/relay.mjs';
import { FlowRules } from '../../../plugins/sleight/lib/flow-rules.mjs';
import { performance } from 'node:perf_hooks';

const identity = { app: 'Fixture Editor', title: 'Draft', url: null };
const tree = rows => 'Window: "Draft", App: Fixture Editor.\n0 standard window\n' + rows;
function fixture(options = {}) {
  const calls = [], submissions = [];
  let state = tree('\t1 button Next, ID: next\n\t2 text field Name, ID: name'), generation = 1;
  const binding = { alias: 'a1', handle: 'app', generation: 1 };
  const raw = new Proxy({
    getAXState: async () => { calls.push(['read']); return state; },
    click: async n => { calls.push(['click', n]); if (options.sheet) state += '\n\t3 sheet Choose\n\t\t4 button OK'; },
    typeText: async text => calls.push(['typeText', text]),
    pressKey: async key => calls.push(['pressKey', key]),
    setValue: async (n, value) => calls.push(['setValue', n, value]),
    scroll: async (...args) => calls.push(['scroll', ...args]),
  }, { get(target, key) { if (!(key in target)) throw new Error('unsupported engine method ' + String(key)); return target[key]; } });
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const observation = () => ({ source: 'engine-full', generation, text: state, complete: true });
  const route = {
    kind: 'full-relay',
    acquire: async () => ({ binding, observation: observation() }),
    bind: async alias => {
      if (alias !== 'a1' || binding.generation !== generation) throw Object.assign(new Error(), { code: 'TARGET_STALE' });
      return binding;
    },
    resolve: async (_, ref) => {
      if (ref === 'e1') return { id: 'next' };
      if (ref === 'e2') return { id: 'name' };
      throw Object.assign(new Error(), { code: 'TARGET_STALE' });
    },
    dispatch: async ({ code, timeout_ms }) => {
      submissions.push({ code, timeout_ms });
      if (options.refusal) return { status: 'refused', code: options.refusal, dispatched: false };
      if (options.unknown) return { status: 'unknown', code: 'EFFECT_UNKNOWN', dispatched: true };
      await runInNewContext(`(async () => { ${guardedCode(code, identity)} })()`, context);
      options.after?.({ binding, reset: () => { generation++; } });
      return { status: 'ok', effect: 'observed', observation: observation() };
    },
    project: async o => ({ source: o.source, generation: o.generation, text: o.text, complete: o.complete }),
    predicate: async (o, until) => ({ matched: until.title === 'Draft', complete: o.complete }),
  };
  return { calls, submissions, route, raw, context, compiler: createNativeCompiler({ route }), observation };
}

test('closed compiler emits only supported awaited native operations and escapes user text', () => {
  const b = { handle: 'app' }, selector = { id: 'name' };
  assert.equal(compileAction({ click: 'e1' }, b, selector), 'await app.click({"id":"name"});');
  assert.equal(compileAction({ type: '"; cua.computer.click(); //\n' }, b), 'await app.typeText("\\\"; cua.computer.click(); //\\n");');
  assert.equal(compileAction({ key: 'Tab' }, b), 'await app.pressKey("Tab");');
  assert.equal(compileAction({ set: { ref: 'e2', value: 'hello' } }, b, selector), 'await app.setValue({"id":"name"},"hello");');
  assert.equal(compileAction({ scroll: { ref: 'e2', direction: 'down', amount: 1 } }, b, selector), 'await app.scroll({"id":"name"},"down",1);');
});

for (const [name, request] of Object.entries({
  code: { app: 'a1', actions: [{ code: 'evil()' }] },
  approval: { app: 'a1', actions: [{ click: 'e1' }], allow: true },
  multi: { app: 'a1', actions: [{ click: 'e1', type: 'x' }] },
  rawIndex: { app: 'a1', actions: [{ click: 1 }] },
  shell: { app: 'a1', actions: [{ shell: 'echo x' }] },
  tooMany: { app: 'a1', actions: Array(17).fill({ key: 'Tab' }) },
  tooLarge: { app: 'a1', actions: [{ type: '🙂'.repeat(5000) }] },
  empty: { app: 'a1', actions: [] },
  invalidScroll: { app: 'a1', actions: [{ scroll: { ref: 'e1', direction: 'raise', amount: 1 } }] },
  infinite: { app: 'a1', actions: [{ type: 'x' }], timeout: Infinity },
  extraSet: { app: 'a1', actions: [{ set: { ref: 'e2', value: 'x', approve: true } }] },
})) test('invalid schema refuses before dispatch: ' + name, async () => {
  const f = fixture();
  await assert.rejects(f.compiler.call('native_act', request), /INVALID_REQUEST/);
  assert.equal(f.submissions.length, 0);
});

test('compiled plan matches guarded JavaScript inputs, order and observation barriers', async () => {
  const f = fixture(), legacy = fixture();
  const actions = [{ click: 'e1' }, { key: 'Tab' }, { type: 'hello' }, { set: { ref: 'e2', value: 'world' } },
    { scroll: { ref: 'e2', direction: 'down', amount: 1 } }];
  const result = await f.compiler.call('native_act', { app: 'a1', actions });
  for (const action of actions) {
    const code = compileAction(action, { handle: 'app' }, { id: 'click' in action ? 'next' : 'name' });
    await runInNewContext(`(async () => { ${guardedCode(code + '\nawait app.getAXState({disableDiffing:true});', identity)} })()`, legacy.context);
  }
  assert.deepEqual(f.calls, legacy.calls);
  assert.equal(result.completedSteps.length, 5);
  assert.equal(result.remainingSteps.length, 0);
  assert.equal(result.effect, 'observed');
});

for (const code of ['APPROVAL_REQUIRED', 'DENIED', 'FORBIDDEN', 'LEASE_BUSY', 'USER_TAKEOVER', 'WINDOW_CHANGED',
  'DOCUMENT_SCOPE', 'CHANGE_REVIEW', 'FLOW_REFUSED', 'CLIPBOARD_REFUSED', 'TARGET_STALE']) {
  test('retains full-route refusal without fallback: ' + code, async () => {
    const f = fixture({ refusal: code });
    const result = await f.compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }, { key: 'Tab' }] });
    assert.equal(result.code, code); assert.equal(result.completedSteps.length, 0);
    assert.equal(result.remainingSteps.length, 2); assert.equal(result.effect, 'none');
    assert.equal(f.submissions.length, 1); assert.equal(f.calls.length, 0);
  });
}

test('unknown target stops with completed prefix and last authorized state', async () => {
  const f = fixture();
  const result = await f.compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }, { click: 'e99' }, { type: 'x' }] });
  assert.equal(result.code, 'TARGET_STALE'); assert.equal(result.completedSteps.length, 1);
  assert.equal(result.remainingSteps.length, 2); assert.equal(result.observation.source, 'engine-full');
  assert.deepEqual(f.calls.filter(x => x[0] !== 'read'), [['click', 1]]);
});

test('engine reset or expired binding stops dependent input', async () => {
  const f = fixture({ after: ({ reset }) => reset() });
  const r = await f.compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }, { key: 'Tab' }] });
  assert.equal(r.completedSteps.length, 1); assert.equal(r.code, 'TARGET_STALE');
  assert.deepEqual(f.calls.filter(x => x[0] !== 'read'), [['click', 1]]);
});

test('sheet opened midway is observed before dependent input', async () => {
  const f = fixture({ sheet: true });
  const r = await f.compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }, { key: 'Tab' }] });
  assert.match(r.observation.text, /sheet Choose/);
  const click = f.calls.findIndex(x => x[0] === 'click'), key = f.calls.findIndex(x => x[0] === 'pressKey');
  assert.ok(f.calls.slice(click + 1, key).some(x => x[0] === 'read'));
});

test('a malformed binding, foreign alias or duplicate selector never supplies an action number', async () => {
  const f = fixture();
  f.route.resolve = async () => ({ id: 'next', label: 'Next' });
  const duplicate = await f.compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }] });
  assert.equal(duplicate.code, 'TARGET_STALE'); assert.equal(f.submissions.length, 0);
  const foreign = await f.compiler.call('native_act', { app: 'a2', actions: [{ click: 'e1' }] });
  assert.equal(foreign.code, 'TARGET_STALE'); assert.equal(f.submissions.length, 0);
  f.route.bind = async () => ({ handle: 'app;evil()' });
  const binding = await f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'x' }] });
  assert.equal(binding.code, 'TARGET_STALE'); assert.equal(f.submissions.length, 0);
});

test('a duplicate ID fails in the existing guard, retaining uncertain effect without replay', async () => {
  const f = fixture();
  f.route.resolve = async () => ({ id: 'duplicate' });
  f.raw.getAXState = async () => tree('\t1 button One, ID: duplicate\n\t2 button Two, ID: duplicate');
  const r = await f.compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }, { key: 'Tab' }] });
  assert.equal(r.code, 'EFFECT_UNKNOWN'); assert.equal(r.remainingSteps.length, 2);
  assert.equal(f.calls.length, 0);
});

test('transport deadline keeps outstanding work unknown and never launches a second operation', async t => {
  t.mock.method(performance, 'now', () => { throw new Error('deadline test consulted wall clock'); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const f = fixture(); let started = 0;
  f.compiler = createNativeCompiler({ route: f.route, now: () => clock });
  f.route.dispatch = () => { started++; return new Promise(() => {}); };
  const pending = f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'x' }], timeout: 30 });
  for (let tick = 0; !started && tick < 100; tick++) await Promise.resolve();
  assert.equal(started, 1);
  clock = 30;
  t.mock.timers.tick(30);
  const r = await pending;
  assert.equal(r.code, 'EFFECT_UNKNOWN'); assert.equal(r.effect, 'unknown');
  const read = await f.compiler.call('native_read', { app: 'a1' });
  assert.equal(read.code, 'EFFECT_UNKNOWN'); assert.equal(started, 1);
});

test('a concurrent tool call cannot dispatch while the preceding step is pending', async () => {
  const f = fixture(); let release;
  f.route.dispatch = () => new Promise(resolve => { release = resolve; });
  const pending = f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'x' }] });
  while (!release) await Promise.resolve();
  const r = await f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'y' }] });
  assert.equal(r.code, 'LEASE_BUSY');
  release({ status: 'ok', effect: 'observed', observation: f.observation() });
  assert.equal((await pending).code, 'OK');
});

test('helper-derived state cannot substitute for a mandatory engine observation', async () => {
  const f = fixture();
  f.route.dispatch = async () => ({ status: 'ok', observation: { source: 'direct-ax', generation: 1 } });
  const r = await f.compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }, { key: 'Tab' }] });
  assert.equal(r.code, 'EFFECT_UNKNOWN'); assert.equal(r.completedSteps.length, 0);
});

test('unknown effects retain the last authorized prefix observation, not error content', async () => {
  const f = fixture(); const dispatch = f.route.dispatch;
  let count = 0;
  f.route.dispatch = request => ++count === 1 ? dispatch(request) : Promise.reject(new Error('synthetic-private-error'));
  const r = await f.compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }, { type: 'x' }, { key: 'Tab' }] });
  assert.equal(r.code, 'EFFECT_UNKNOWN'); assert.equal(r.completedSteps.length, 1);
  assert.equal(r.remainingSteps.length, 2); assert.match(r.observation.text, /Draft/);
  assert.doesNotMatch(JSON.stringify(r), /synthetic-private-error/);
});

test('unsupported direct route and prototype poll configuration fail closed', () => {
  assert.throws(() => createNativeCompiler({ route: { kind: 'engine' } }), /INVALID_REQUEST/);
  assert.throws(() => createNativeCompiler({ route: fixture().route, pollMs: NaN }), /INVALID_REQUEST/);
});

test('projection consumes the same deadline and cannot hold a completed batch forever', async t => {
  t.mock.method(performance, 'now', () => { throw new Error('deadline test consulted wall clock'); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  const f = fixture();
  f.compiler = createNativeCompiler({ route: f.route, now: () => clock });
  let projecting = false;
  f.route.project = () => { projecting = true; return new Promise(() => {}); };
  const pending = f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'x' }], timeout: 30 });
  for (let tick = 0; !projecting && tick < 100; tick++) await Promise.resolve();
  assert.equal(projecting, true);
  clock = 30;
  t.mock.timers.tick(30);
  const r = await pending;
  assert.equal(r.code, 'EFFECT_UNKNOWN'); assert.equal(r.completedSteps.length, 1);
  assert.equal(r.observation, undefined);
});

test('real relay preserves native lease, document scope and flow gates for compiled inputs', async t => {
  for (const mode of ['lease', 'document', 'flow']) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const sent = [], received = [];
    serverIn.on('data', d => d.toString().split('\n').filter(Boolean).forEach(line => sent.push(JSON.parse(line))));
    clientOut.on('data', d => d.toString().split('\n').filter(Boolean).forEach(line => received.push(JSON.parse(line))));
    const flowRules = mode === 'flow' ? new FlowRules({ version: 1,
      rules: [{ id: 'fixture-rule', kind: 'pattern', pattern: 'fixture-secret', destinations: ['*'] }] }) : undefined;
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
      inputLease: mode === 'lease' ? { acquire() { throw new Error('must not acquire without window'); } } : false,
      approvalScope: mode === 'document' ? 'document' : 'session', flowRules });
    t.after(() => relay.dispose());
    const code = compileAction({ type: 'fixture-secret' }, { handle: 'app' }) + '\nawait app.getAXState({disableDiffing:true});';
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    assert.equal(sent.length, 0, mode);
    assert.equal(received[0].result.isError, true, mode);
    assert.match(received[0].result.content[0].text, mode === 'lease' ? /Input lease/ : mode === 'document' ? /Document scope/ : /Flow rules/);
  }
});

test('unknown dispatch effect poisons mutations until a new compiler session', async () => {
  const f = fixture({ unknown: true });
  const r = await f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'x' }, { type: 'y' }] });
  assert.equal(r.effect, 'unknown'); assert.equal(r.completedSteps.length, 0);
  const next = await f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'x' }] });
  assert.equal(next.code, 'EFFECT_UNKNOWN'); assert.equal(f.submissions.length, 1);
});

test('open reuses acquisition observation without duplicate read', async () => {
  const f = fixture();
  const r = await f.compiler.call('native_open', { app: 'Fixture Editor' });
  assert.equal(r.app, 'a1'); assert.equal(r.observation.source, 'engine-full'); assert.equal(f.submissions.length, 0);
});

test('read and wait share typed final predicates and exact remaining deadline', async () => {
  const f = fixture();
  const read = await f.compiler.call('native_read', { app: 'a1', budget: 12000 });
  assert.equal(read.observation.source, 'engine-full');
  const wait = await f.compiler.call('native_wait', { app: 'a1', until: { title: 'Draft' } });
  assert.equal(wait.code, 'OK'); assert.equal(wait.matched, true);
  const act = await f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'x' }], expect: { title: 'other' } });
  assert.equal(act.code, 'DEPENDENCY_FAILED'); assert.equal(act.completedSteps.length, 1);
  assert.equal(act.effect, 'observed');
});

test('schema and complete exchange measurement keep tokens unknown', () => {
  assert.deepEqual(nativeTools.map(t => t.name), ['native_open', 'native_read', 'native_act', 'native_wait']);
  const request = { app: 'a1', actions: [{ type: 'hello' }] }, response = { code: 'OK' };
  const m = measureExchange('native_act', request, response);
  assert.equal(m.requestBytes, Buffer.byteLength(JSON.stringify({ name: 'native_act', arguments: request })));
  assert.equal(m.responseBytes, Buffer.byteLength(JSON.stringify(response)));
  assert.ok(m.schemaBytes > 0); assert.equal(m.tokens, null);
  assert.throws(() => validateRequest('native_wait', { app: 'a1', until: {}, timeout: 30001 }), /INVALID_REQUEST/);
});

test('ref-resolution deadline before dispatch retains none/prepared and allows a later read', async () => {
  let clock = 0;
  const f = fixture();
  f.route.resolve = async () => { clock = 31; return { id: 'next' }; };
  const compiler = createNativeCompiler({ route: f.route, now: () => clock });
  const result = await compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }], timeout: 30 });
  assert.equal(f.submissions.length, 0);
  assert.equal(result.code, 'WAIT_TIMEOUT'); assert.equal(result.phase, 'prepared'); assert.equal(result.effect, 'none');
  assert.equal(result.completedSteps.length, 0); assert.equal(result.remainingSteps.length, 1);
  assert.equal((await compiler.call('native_read', { app: 'a1' })).code, 'OK');
});

test('expiry between the dispatch deadline check and port entry sends no input', async () => {
  let clock = 0, expireAfterCheck = false;
  const f = fixture();
  f.route.resolve = async () => { expireAfterCheck = true; return { id: 'next' }; };
  const compiler = createNativeCompiler({ route: f.route, now: () => {
    const current = clock;
    if (expireAfterCheck) { expireAfterCheck = false; clock = 31; }
    return current;
  } });
  const result = await compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }], timeout: 30 });
  assert.equal(f.submissions.length, 0);
  assert.equal(result.code, 'WAIT_TIMEOUT'); assert.equal(result.phase, 'prepared'); assert.equal(result.effect, 'none');
  assert.equal((await compiler.call('native_read', { app: 'a1' })).code, 'OK');
});

for (const expect of [undefined, { title: 'Draft' }]) test(`projection refusal preserves ${expect ? 'verified' : 'observed'} completed input`, async () => {
  const f = fixture();
  f.route.project = async () => { throw Object.assign(Error('fixture-private-detail'), { code: 'BUDGET_TOO_SMALL' }); };
  const result = await f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'fixture' }], ...(expect ? { expect } : {}) });
  assert.equal(result.code, 'BUDGET_TOO_SMALL'); assert.equal(result.phase, expect ? 'verified' : 'observed');
  assert.equal(result.effect, expect ? 'verified' : 'observed'); assert.equal(result.completedSteps.length, 1);
  assert.equal(result.remainingSteps.length, 0); assert.equal(result.observation, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-detail/);
});

test('projection refusal after a failed dependency preserves the observed prefix and untouched suffix', async () => {
  const f = fixture();
  f.route.project = async () => { throw Object.assign(Error('budget'), { code: 'BUDGET_TOO_SMALL' }); };
  const result = await f.compiler.call('native_act', { app: 'a1', actions: [{ type: 'prefix' }, { click: 'e99' }, { type: 'suffix' }] });
  assert.equal(result.code, 'BUDGET_TOO_SMALL'); assert.equal(result.phase, 'observed'); assert.equal(result.effect, 'observed');
  assert.equal(result.completedSteps.length, 1); assert.deepEqual(result.remainingSteps, [{ click: 'e99' }, { type: 'suffix' }]);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'read'), [['typeText', 'prefix']]);
});

test('a dispatched input with known readback after the deadline keeps its observed prefix', async () => {
  let clock = 0;
  const f = fixture();
  const dispatch = f.route.dispatch;
  f.route.dispatch = async request => { const reply = await dispatch(request); clock = 31; return reply; };
  const compiler = createNativeCompiler({ route: f.route, now: () => clock });
  const result = await compiler.call('native_act', { app: 'a1', actions: [{ type: 'prefix' }, { type: 'suffix' }], timeout: 30 });
  assert.equal(result.code, 'WAIT_TIMEOUT'); assert.equal(result.phase, 'observed'); assert.equal(result.effect, 'observed');
  assert.equal(result.completedSteps.length, 1); assert.deepEqual(result.remainingSteps, [{ type: 'suffix' }]);
  assert.equal((await compiler.call('native_read', { app: 'a1' })).code, 'OK');
});

for (const [mode, finalTime] of [['expire', 31], ['throw', null], ['nan', NaN],
  ['infinity', Infinity], ['negative-infinity', -Infinity], ['string', '0'], ['undefined', undefined]]) {
  test(`final timeout preparation ${mode} cannot enter dispatch or poison a later read`, async () => {
    let resolved = false, ticks = 0;
    const f = fixture();
    f.route.resolve = async () => { resolved = true; return { id: 'next' }; };
    const compiler = createNativeCompiler({ route: f.route, now: () => {
      if (resolved && ++ticks === 3) {
        if (mode === 'throw') throw Object.assign(Error('fixture-clock'), { code: 'WAIT_TIMEOUT' });
        return finalTime;
      }
      return 0;
    } });
    const result = await compiler.call('native_act', { app: 'a1', actions: [{ click: 'e1' }], timeout: 30 });
    assert.equal(f.submissions.length, 0);
    assert.equal(result.code, 'WAIT_TIMEOUT');
    assert.equal(result.phase, 'prepared'); assert.equal(result.effect, 'none');
    assert.equal(result.completedSteps.length, 0); assert.equal(result.remainingSteps.length, 1);
    assert.equal((await compiler.call('native_read', { app: 'a1' })).code, 'OK');
  });
}
