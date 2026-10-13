import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dependencyPlan } from '../bench/direct-native/planner.mjs';
import { createNativeWaiter } from '../bench/direct-native/waits.mjs';

const binding = { session: 's1', runtime: 1, pid: 123, processStart: 1, window: 1, lease: 1, policy: 1, document: 'fixture' };
const observation = (options = {}) => ({ source: 'engine-full', binding: { ...binding }, scope: 'window',
  complete: true, observedAt: performance.now(), sequence: 1, rows: [{ id: 'entry', role: 'text field', name: 'Entry', visible: true, state: 'ready' }], ...options });
const adapter = (read, authorized = () => true) => ({ read, authorized });
const predicate = { id: 'entry', state: 'ready' };

test('planner documents dependencies, delegates same-call reuse and preserves event boundaries', () => {
  const plan = dependencyPlan([{ read: true }, { set: { id: 'entry', value: 'x' } }, { key: 'Return' }, { type: 'hello' }]);
  assert.equal(plan.steps.length, 4);
  assert.equal(plan.steps[1].observationReason, 'eligible-same-call-read');
  assert.equal(plan.steps[3].observationReason, 'transition-barrier');
  assert.deepEqual(plan.steps.map(s => s.dependsOn), [[], [0], [1], [2]]);
  assert.match(plan.code, /setValue\(\{"id":"entry"\}, "x"\)/);
  assert.equal((dependencyPlan([{ type: 'a' }, { type: 'b' }]).code.match(/typeText/g) ?? []).length, 2);
});

test('wait uses eligible evidence without another engine operation', async () => {
  let reads = 0;
  const waiter = createNativeWaiter(adapter(async () => { reads++; return observation({ sequence: 2 }); }));
  const result = await waiter.wait({ binding, until: predicate, evidence: observation() });
  assert.equal(result.status, 'matched'); assert.equal(reads, 0);
  assert.deepEqual(result.counts, { engineOperations: 0, reusedObservations: 1, readReasons: [] });
});

for (const [name, options] of [
  ['stale age', { observedAt: -10001 }], ['helper source', { source: 'direct-ax' }],
  ['foreign session', { binding: { ...binding, session: 's2' } }], ['scope mismatch', { scope: 'sheet' }],
  ['missing timestamp', { observedAt: undefined }], ['incomplete observation', { complete: false }],
]) test(`wait rejects cached ${name} and reads fresh evidence`, async () => {
  let reads = 0;
  const waiter = createNativeWaiter(adapter(async () => { reads++; return observation({ sequence: 2 }); }));
  const result = await waiter.wait({ binding, until: predicate, evidence: observation(options) });
  assert.equal(result.status, 'matched'); assert.equal(reads, 1);
});

test('typed absence needs complete coverage and hidden targets cannot match', async () => {
  for (const [state, until, status] of [
    [observation({ rows: [] }), { id: 'missing', absent: true }, 'matched'],
    [observation({ rows: [], complete: false }), { id: 'missing', absent: true }, 'incomplete'],
    [observation({ rows: [] }), predicate, 'complete-not-matched'],
    [observation({ rows: [{ id: 'entry', visible: false, state: 'ready' }] }), predicate, 'complete-not-matched'],
  ]) {
    const result = await createNativeWaiter(adapter(async () => ({ ...state, observedAt: performance.now() }))).wait({ binding, until, once: true });
    assert.equal(result.status, status);
  }
});

test('cancelled waits return last authorized state and stop polling', async () => {
  const abort = new AbortController(); abort.abort(); let reads = 0;
  const result = await createNativeWaiter(adapter(async () => { reads++; return observation(); }))
    .wait({ binding, until: predicate, signal: abort.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(reads, 0);
});

test('deadline returns while a pending engine read stays owned and coalesced', async () => {
  let resolveRead, reads = 0;
  const waiter = createNativeWaiter(adapter(() => { reads++; return new Promise(resolve => { resolveRead = resolve; }); }));
  const result = await waiter.wait({ binding, until: predicate, timeoutMs: 5 });
  assert.equal(result.status, 'timeout'); assert.equal(waiter.pending(), 1);
  const second = waiter.wait({ binding, until: predicate, timeoutMs: 100 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); resolveRead(observation());
  assert.equal((await second).status, 'matched'); assert.equal(waiter.pending(), 0);
});

test('authorization revocation suppresses a late observation', async () => {
  let allowed = true;
  const result = await createNativeWaiter(adapter(async () => { allowed = false; return observation(); }, () => allowed))
    .wait({ binding, until: predicate });
  assert.equal(result.status, 'cancelled'); assert.equal(result.observation, undefined);
});

test('unknown outcomes never dispatch a read or input replay', async () => {
  let reads = 0;
  const result = await createNativeWaiter(adapter(async () => { reads++; return observation(); }))
    .wait({ binding, until: predicate, effect: 'unknown' });
  assert.equal(result.status, 'incomplete'); assert.equal(result.code, 'EFFECT_UNKNOWN'); assert.equal(reads, 0);
});

test('predicate and timeout grammar is closed', async () => {
  const waiter = createNativeWaiter(adapter(async () => observation()));
  for (const until of [{}, { id: 'entry', arbitrary: true }, { id: '' }, { absent: true }, { id: 'entry', absent: 'yes' }])
    await assert.rejects(waiter.wait({ binding, until }), /predicate/);
  for (const timeoutMs of [-1, 30001, Infinity])
    await assert.rejects(waiter.wait({ binding, until: predicate, timeoutMs }), /timeout/);
});

test('cancel during a read retains queue ownership until completion', async () => {
  let finish, reads = 0;
  const abort = new AbortController();
  const waiter = createNativeWaiter(adapter(() => { reads++; return new Promise(resolve => { finish = resolve; }); }));
  const task = waiter.wait({ binding, until: predicate, signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  assert.equal((await task).status, 'cancelled'); assert.equal(waiter.pending(), 1);
  const other = waiter.wait({ binding: { ...binding, session: 's2' }, until: predicate, timeoutMs: 5 });
  assert.equal((await other).status, 'timeout'); assert.equal(reads, 1);
  finish(observation()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiter.pending(), 0); assert.equal(reads, 1);
});

test('notification silence and repeated sequence cannot establish freshness', async () => {
  const prior = observation({ rows: [], observedAt: -10000 });
  const result = await createNativeWaiter(adapter(async () => observation()))
    .wait({ binding, until: predicate, evidence: prior });
  assert.equal(result.status, 'incomplete'); assert.equal(result.code, 'OBSERVATION_STALE');
});

test('backoff uses one monotonic deadline and reports the last complete state', async () => {
  const start = performance.now(); let reads = 0;
  const result = await createNativeWaiter(adapter(async () => { reads++; return observation({ rows: [], sequence: reads }); }))
    .wait({ binding, until: predicate, timeoutMs: 50 });
  assert.equal(result.status, 'timeout'); assert.deepEqual(result.observation.rows, []);
  assert.equal(reads, 2); assert.ok(performance.now() - start < 500);
});

test('wrong process incarnation is rejected at delivery', async () => {
  const result = await createNativeWaiter(adapter(async () => observation({ binding: { ...binding, processStart: 2 } })))
    .wait({ binding, until: predicate });
  assert.equal(result.status, 'incomplete'); assert.equal(result.observation, undefined);
});

test('read completion rechecks the monotonic deadline before returning matched', async () => {
  let clock = 0;
  const waiter = createNativeWaiter(adapter(async () => { clock = 11; return observation({ observedAt: clock }); }), { now: () => clock });
  const result = await waiter.wait({ binding, until: predicate, timeoutMs: 10 });
  assert.equal(result.status, 'timeout'); assert.equal(result.observation, undefined); assert.equal(waiter.pending(), 0);
});

test('coalesced read delivery respects each subscriber deadline', async () => {
  let clock = 0, release, reads = 0;
  const waiter = createNativeWaiter(adapter(() => { reads++; return new Promise(resolve => { release = resolve; }); }), { now: () => clock });
  const short = waiter.wait({ binding, until: predicate, timeoutMs: 10000 });
  const long = waiter.wait({ binding, until: predicate, timeoutMs: 20000 });
  await new Promise(resolve => setImmediate(resolve));
  clock = 11000; release(observation({ observedAt: clock }));
  assert.equal((await short).status, 'timeout'); assert.equal((await long).status, 'matched');
  assert.equal(reads, 1); assert.equal(waiter.pending(), 0);
});

for (const options of [
  { binding: { ...binding, session: 'other' } }, { source: 'direct-ax' }, { scope: 'sheet' },
]) test(`rejected ${Object.keys(options)[0]} evidence cannot impose a foreign sequence floor`, async () => {
  const waiter = createNativeWaiter(adapter(async () => observation({ observedAt: 1 })), { now: () => 1 });
  const result = await waiter.wait({ binding, until: predicate, evidence: observation({ ...options, sequence: 100, observedAt: 1 }) });
  assert.equal(result.status, 'matched'); assert.equal(result.counts.engineOperations, 1);
});

test('same-lineage expired evidence still prevents sequence rollback', async () => {
  const waiter = createNativeWaiter(adapter(async () => observation({ sequence: 1, observedAt: 20000 })), { now: () => 20000 });
  const result = await waiter.wait({ binding, until: predicate, evidence: observation({ sequence: 100, observedAt: 1 }) });
  assert.equal(result.status, 'incomplete'); assert.equal(result.code, 'OBSERVATION_STALE');
});

test('a read failure beyond the deadline reports timeout instead of an early engine error', async () => {
  let clock = 0;
  const waiter = createNativeWaiter(adapter(async () => { clock = 11; throw Error('fixture read unavailable'); }), { now: () => clock });
  const result = await waiter.wait({ binding, until: predicate, timeoutMs: 10 });
  assert.equal(result.status, 'timeout'); assert.equal(waiter.pending(), 0);
});

test('an early backoff timer cannot dispatch a read before its monotonic interval', async () => {
  let clock = 0, reads = 0, id = 0;
  const timers = new Map();
  const waiter = createNativeWaiter(adapter(async () => { reads++; return observation({ rows: [], sequence: reads, observedAt: clock }); }), {
    now: () => clock,
    setTimer(callback, delay) { timers.set(++id, { callback, delay }); return id; },
    clearTimer(timer) { timers.delete(timer); },
  });
  const task = waiter.wait({ binding, until: predicate, timeoutMs: 50 });
  await new Promise(resolve => setImmediate(resolve));
  const [timerId, timer] = [...timers.entries()][0];
  assert.equal(timer.delay, 25);
  timers.delete(timerId); clock = 24; timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(reads, 1); }
  finally {
    clock = 50;
    for (const [timerId, timer] of [...timers]) { timers.delete(timerId); timer.callback(); }
    assert.equal((await task).status, 'timeout');
  }
});
