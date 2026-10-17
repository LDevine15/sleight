import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { dependencyPlan } from '../bench/direct-native/planner.mjs';
import { relayTrial, qualifyBatch } from '../bench/direct-native/test/relay-fixture.mjs';
import { createNativeWaiter } from '../bench/direct-native/waits.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const steps = [{ read: true }, { set: { id: 'entry', value: 'after' } }];
test('NP-4 plan matches full relay guard decisions and final state, removing one redundant read', async () => {
  const separate = await relayTrial(false);
  const compiled = await relayTrial(true, { plan: dependencyPlan(steps).code });
  for (const field of ['actions', 'value', 'finalRead', 'leaseHeld', 'guardDecisions']) assert.deepEqual(compiled[field], separate[field], field);
  assert.equal(compiled.reads, 2); assert.equal(separate.reads, 3);
  assert.equal(compiled.engineCalls, separate.engineCalls - 1);
  assert.deepEqual(compiled.approvals, ['session']);
});

for (const mode of ['careful', 'changeReview']) test(`NP-4 plan preserves full relay ${mode} gates`, async () => {
  const pair = await qualifyBatch({ mode });
  const compiled = await relayTrial(true, { mode, plan: dependencyPlan(steps, { careful: mode === 'careful' }).code });
  for (const field of ['actions', 'value', 'finalRead', 'leaseHeld', 'guardDecisions', 'reads'])
    assert.deepEqual(compiled[field], pair.combined[field], field);
});

for (const fault of ['changed-window', 'ambiguous-id', 'missing-id', 'expired-lease', 'policy-denied', 'computed-index'])
  test(`NP-4 retains full relay refusal for ${fault}`, async () => {
    const pair = await qualifyBatch({ fault });
    const compiled = fault === 'computed-index' ? pair.combined : await relayTrial(true, { fault, plan: dependencyPlan(steps).code });
    assert.ok(compiled.error); assert.equal(compiled.actions, 0); assert.equal(compiled.value, 'before');
    assert.deepEqual(compiled.guardDecisions, pair.combined.guardDecisions);
  });

for (const options of [
  { readDelay: 2100, age: 0 }, { readDelay: 2100, age: 11000 },
  { readDelay: 2100, mode: 'careful' }, { readDelay: 2100, mode: 'changeReview' },
]) test(`NP-4 retains prior-read age/mode limits ${JSON.stringify(options)}`, async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const advance = ms => t.mock.timers.tick(ms);
  const pair = await qualifyBatch({ ...options, advance });
  assert.equal(pair.combined.reads, 2);
  assert.equal(pair.separate.reads, options.age === 0 && !options.mode ? 2 : 3);
  assert.equal(pair.combined.value, pair.separate.value);
  assert.deepEqual(pair.combined.guardDecisions, pair.separate.guardDecisions);
});

test('NP-4 retains careful relay fail-stop after the first invalidating action', async () => {
  const actions = [{ read: true }, { set: { id: 'entry', value: 'first' } }, { set: { id: 'entry', value: 'after' } }];
  const compiled = await relayTrial(true, { mode: 'careful', fault: 'invalidating-action', plan: dependencyPlan(actions).code });
  assert.equal(compiled.actions, 1); assert.equal(compiled.value, 'first'); assert.ok(compiled.error);
});

test('two aliases share one eligible full-read and retain final state', async () => {
  const plan = 'const alias = app;\n' + dependencyPlan(steps, { handle: 'alias' }).code;
  const compiled = await relayTrial(true, { plan });
  assert.equal(compiled.error, null); assert.equal(compiled.value, 'after'); assert.equal(compiled.reads, 2);
});

test('transition barrier resolves an ID after element renumbering', async () => {
  const plan = dependencyPlan([{ read: true }, { key: 'Tab' }, { set: { id: 'entry', value: 'after' } }]);
  assert.equal(plan.steps[2].observationReason, 'transition-barrier');
  const compiled = await relayTrial(true, { plan: plan.code });
  assert.equal(compiled.error, null); assert.equal(compiled.value, 'after'); assert.equal(compiled.reads, 3);
});

for (const mode of ['default', 'careful']) test(`field click then typing checks focus once in ${mode} mode`, async () => {
  const plan = dependencyPlan([{ read: true }, { click: { id: 'entry' } }, { type: 'after' }]);
  const compiled = await relayTrial(true, { mode, plan: plan.code });
  assert.equal(compiled.error, null); assert.equal(compiled.value, 'after'); assert.equal(compiled.reads, 3);
});

test('user takeover stops the dependent suffix in the full relay', async () => {
  const plan = dependencyPlan([{ read: true }, { click: { id: 'entry' } }, { type: 'after' }]);
  const compiled = await relayTrial(true, { fault: 'user-takeover', plan: plan.code });
  assert.match(compiled.error, /user takeover/); assert.equal(compiled.actions, 0); assert.equal(compiled.value, 'before');
});

test('hidden engine target refuses the plan before input', async () => {
  const compiled = await relayTrial(true, { fault: 'hidden-target', plan: dependencyPlan(steps).code });
  assert.ok(compiled.error); assert.equal(compiled.actions, 0); assert.equal(compiled.value, 'before');
});

test('unknown native outcome retains the dispatched prefix and never replays it', async () => {
  const plan = dependencyPlan([...steps, { type: 'suffix' }]);
  const compiled = await relayTrial(true, { fault: 'unknown-action', plan: plan.code });
  assert.match(compiled.error, /effect unknown/); assert.equal(compiled.actions, 1); assert.equal(compiled.value, 'after');
});

function waitAdapter({ call, authorized }) {
  const binding = { session: 'aa1-offline', runtime: 'fixture', pid: 123, processStart: 1, window: 1, lease: 1, policy: 1, document: 'fixture' };
  let sequence = 0;
  const read = async () => {
    const result = await call('nodeRepl.write("[np4-full]" + JSON.stringify(await app.getAXState({ emit: false, disableDiffing: true })));');
    assert.notEqual(result.isError, true);
    const text = result.content.map(c => c.text ?? '').join('\n');
    const full = text.split('\n').find(line => line.startsWith('[np4-full]'));
    const state = JSON.parse(full.slice('[np4-full]'.length));
    return { source: 'engine-full', binding, scope: 'window', rows: [], complete: true,
      observedAt: performance.now(), sequence: ++sequence, title: windowFromText(state).title };
  };
  return { binding, waiter: createNativeWaiter({ read, authorized }) };
}

test('typed title wait traverses the complete relay read route', async () => {
  const run = await relayTrial(true, { scenario: async fixture => {
    const { binding, waiter } = waitAdapter(fixture);
    return waiter.wait({ binding, until: { title: 'Fixture' } });
  } });
  assert.equal(run.scenarioResult.status, 'matched'); assert.equal(run.reads, 1); assert.equal(run.actions, 0);
});

for (const stop of ['timeout', 'cancelled']) test(`${stop} wait retains its pending complete-relay engine request`, async () => {
  const run = await relayTrial(true, { scenario: async fixture => {
    const release = fixture.holdRead(), abort = new AbortController();
    const { binding, waiter } = waitAdapter(fixture);
    const task = waiter.wait({ binding, until: { title: 'Fixture' }, timeoutMs: stop === 'timeout' ? 5 : 1000, signal: abort.signal });
    await new Promise(resolve => setImmediate(resolve));
    if (stop === 'cancelled') abort.abort();
    const result = await task;
    assert.equal(waiter.pending(), 1); release();
    for (let i = 0; i < 20 && waiter.pending(); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiter.pending(), 0);
    return result;
  } });
  assert.equal(run.scenarioResult.status, stop); assert.equal(run.reads, 1); assert.equal(run.actions, 0);
});
