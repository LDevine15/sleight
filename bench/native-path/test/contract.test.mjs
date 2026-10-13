import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeRefs, OperationJournal, NativeError, nextFor } from '../contract.mjs';
import { verifyWindowIdentity } from '../../../plugins/sleight/lib/window-identity.mjs';

const identity = () => ({ session: 's1', runtimeEpoch: 'rt1', pid: 7, processStart: 123, windowEpoch: 'h1', windowId: 1,
  appId: 'fixture.app', title: 'Fixture', url: '', document: 'doc1', leaseGeneration: 1, leaseExpires: 1000, revoked: false });
const row = (number = 1, patch = {}) => ({ number, role: 'button', name: 'Go', id: 'go', ancestor: 'panel', nodeIdentity: 'node1', ...patch });
const evidence = (patch = {}) => ({ source: 'engine-full', identity: identity(), scope: 'window', coverage: 'scope-complete',
  observedAt: 10, fullGeneration: 1, viewGeneration: 1, rows: [row()], delivered: [1], ...patch });
function setup(options = {}) {
  let current = identity(); let clock = 10;
  const refs = new NativeRefs({ current: () => current, now: () => clock, ...options });
  return { refs, change: patch => { current = { ...current, ...patch }; }, tick: value => { clock = value; } };
}
function code(expected) { return error => error instanceof NativeError && error.code === expected; }

test('same-title replacement and PID reuse agree with the existing native identity guard', () => {
  for (const patch of [{ windowId: 2 }, { processStart: 124 }, { windowEpoch: 'h2' }]) {
    const f = setup(); const out = f.refs.observe(evidence()); f.change(patch);
    assert.throws(() => f.refs.resolve('s1', out.elements[0].ref), code('WINDOW_CHANGED'));
    const expected = { appId: 'fixture.app', title: 'Fixture', url: '', nativeIdentity: { epoch: 'h1', window: 1, pid: 7, processStart: 123 } };
    const actual = { status: 'ok', matches: 1, epoch: patch.windowEpoch ?? 'h1', window: patch.windowId ?? 1,
      pid: 7, processStart: patch.processStart ?? 123, appId: 'fixture.app', title: 'Fixture', url: '' };
    assert.throws(() => verifyWindowIdentity(expected, actual));
  }
});
test('strong unique delivered refs follow fresh harmless renumbering, never a cached index', () => {
  const f = setup(); const first = f.refs.observe(evidence()); const ref = first.elements[0].ref;
  f.refs.observe(evidence({ fullGeneration: 2, viewGeneration: 2, rows: [row(7)], delivered: [7] }));
  const found = f.refs.resolve('s1', ref); assert.equal(found.number, 7); assert.equal(found.source, 'engine-full');
  assert.equal(found.fullGeneration, 2); assert.equal(first.app, 'a1'); assert.equal(first.window, 'w1');
});
for (const [name, rows] of [
  ['duplicate IDs', [row(2), row(3, { nodeIdentity: 'node2' })]],
  ['recycled row', [row(2, { name: 'Stop' })]], ['replaced object', [row(2, { nodeIdentity: 'node2' })]],
  ['contradictory ancestry', [row(2, { ancestor: 'other' })]], ['missing node', []],
]) test(`${name} retires an existing ref`, () => {
  const f = setup(); const ref = f.refs.observe(evidence()).elements[0].ref;
  f.refs.observe(evidence({ fullGeneration: 2, viewGeneration: 2, rows, delivered: rows.map(r => r.number) }));
  assert.throws(() => f.refs.resolve('s1', ref), code('TARGET_STALE'));
});
test('identical weak labels cannot survive a mutation or supply an ambiguous ref', () => {
  const f = setup(); const rows = [row(1, { id: '', nodeIdentity: '' }), row(2, { id: '', nodeIdentity: '' })];
  const first = f.refs.observe(evidence({ rows, delivered: [1, 2] }));
  const ref = first.elements[0].ref;
  f.refs.observe(evidence({ fullGeneration: 2, viewGeneration: 2, rows, delivered: [1, 2] }));
  assert.throws(() => f.refs.resolve('s1', ref), code('TARGET_STALE'));
});
test('foreign sessions and omitted refs never resolve, even with eligible full evidence', () => {
  const f = setup(); const first = f.refs.observe(evidence({ rows: [row(1), row(2, { id: 'other', nodeIdentity: 'n2' })], delivered: [1] }));
  assert.equal(first.elements.length, 1); assert.equal(first.omittedRows, 1);
  assert.throws(() => f.refs.resolve('s2', first.elements[0].ref), code('TARGET_STALE'));
  assert.throws(() => f.refs.resolve('s1', 'e2'), code('TARGET_STALE'));
  const empty = f.refs.observe(evidence({ fullGeneration: 2, viewGeneration: 2, delivered: [] }));
  assert.equal(empty.elements.length, 0); assert.throws(() => f.refs.resolve('s1', first.elements[0].ref), code('TARGET_STALE'));
});
test('hidden fresh evidence cannot advance delivered lineage or emit new aliases', () => {
  const f = setup(); const first = f.refs.observe(evidence());
  const hidden = f.refs.observe(evidence({ fullGeneration: 2, viewGeneration: 1, rows: [row(7)], delivered: null }));
  assert.equal(hidden.viewGeneration, 1); assert.equal(hidden.elements.length, 0);
  assert.equal(f.refs.resolve('s1', first.elements[0].ref).number, 7);
});
for (const patch of [{ document: 'doc2' }, { runtimeEpoch: 'rt2' }, { leaseGeneration: 2 }, { revoked: true }])
  test(`identity/lease change refuses ${JSON.stringify(patch)}`, () => {
    const f = setup(); const ref = f.refs.observe(evidence()).elements[0].ref; f.change(patch);
    assert.throws(() => f.refs.resolve('s1', ref), error => error instanceof NativeError);
  });
test('expired evidence/lease, partial snapshot and helper-derived target cannot enter guard evidence', () => {
  const f = setup(); const ref = f.refs.observe(evidence()).elements[0].ref; f.tick(1001);
  assert.throws(() => f.refs.resolve('s1', ref), code('LEASE_BUSY'));
  for (const source of ['direct-ax', 'engine-partial']) {
    const g = setup(); const out = g.refs.observe(evidence({ source, coverage: 'rendered-partial' }));
    assert.equal(out.source, source); assert.equal(out.elements.length, 0);
    assert.throws(() => g.refs.resolve('s1', 'e1'), code('TARGET_STALE'));
  }
});
test('partial snapshots retain uncertain absence and cannot preserve full-engine refs', () => {
  const f = setup(); const ref = f.refs.observe(evidence()).elements[0].ref;
  const view = f.refs.observe(evidence({ source: 'engine-partial', coverage: 'unknown', fullGeneration: 2, viewGeneration: 2, rows: [], delivered: [] }));
  assert.equal(view.absence, 'unknown'); assert.throws(() => f.refs.resolve('s1', ref), code('TARGET_STALE'));
});
test('caller mutation of evidence cannot rewrite authority or an element target', () => {
  const f = setup(); const data = evidence(); const out = f.refs.observe(data);
  data.rows[0].number = 99; data.identity.runtimeEpoch = 'forged';
  assert.equal(f.refs.resolve('s1', out.elements[0].ref).number, 1);
});
test('untrusted role strings cannot leak protected document text through a view', () => {
  const f = setup(); const out = f.refs.observe(evidence({ rows: [row(1, { role: 'seed-secret-content' })] }));
  assert.doesNotMatch(JSON.stringify(out), /seed-secret-content/); assert.equal(out.elements[0].role, 'unknown');
});
test('capacity and malformed observations fail closed with bounded alias storage', () => {
  const f = setup({ maxBytes: 128 }); assert.throws(() => f.refs.observe(evidence()), code('BUDGET_TOO_SMALL'));
  for (const patch of [{ source: 'forged' }, { observedAt: NaN }, { fullGeneration: -1 }, { delivered: [999] }]) {
    assert.throws(() => setup().refs.observe(evidence(patch)), error => error instanceof NativeError);
  }
});
test('closed errors contain only sanitized metadata and read-only suggestions', () => {
  for (const error of ['TARGET_STALE','TARGET_AMBIGUOUS','VIEW_INCOMPLETE','WINDOW_CHANGED','BUDGET_TOO_SMALL',
    'APPROVAL_REQUIRED','DENIED','FORBIDDEN','LEASE_BUSY','USER_TAKEOVER','WAIT_TIMEOUT','AX_UNSUPPORTED','AX_TIMEOUT','ENGINE_UNAVAILABLE','EFFECT_UNKNOWN']) {
    const next = nextFor(error); assert.ok(['native_read','native_wait','handoff','stop'].includes(next.kind));
    assert.doesNotMatch(JSON.stringify(new NativeError(error, 'seed-secret').toJSON()), /seed-secret/);
  }
  assert.throws(() => nextFor('forged'), TypeError);
});
test('receipt journal preserves verified prefix, unknown effect and untouched suffix without replay', () => {
  const journal = new OperationJournal(); journal.prepare('op1', 3);
  journal.dispatch('op1', 0); journal.observe('op1', 0); journal.verify('op1', 0);
  journal.dispatch('op1', 1); journal.unknown('op1');
  const out = journal.receipt('op1'); assert.deepEqual(out.completedSteps, [0]);
  assert.equal(out.failedStep, 1); assert.deepEqual(out.remainingSteps, [2]); assert.equal(out.effect, 'unknown');
  assert.throws(() => journal.prepare('op1', 3), code('EFFECT_UNKNOWN'));
  assert.throws(() => journal.dispatch('op1', 1), code('EFFECT_UNKNOWN'));
});
test('receipt phases cannot verify before observation or skip a dependent step', () => {
  const journal = new OperationJournal(); assert.equal(journal.prepare('op1', 2).phase, 'prepared');
  assert.throws(() => journal.verify('op1', 0), code('EFFECT_UNKNOWN'));
  assert.throws(() => journal.dispatch('op1', 1), code('EFFECT_UNKNOWN'));
  journal.dispatch('op1', 0); journal.observe('op1', 0); journal.verify('op1', 0);
  journal.dispatch('op1', 1); journal.observe('op1', 1); journal.verify('op1', 1);
  assert.equal(journal.receipt('op1').phase, 'verified'); assert.deepEqual(journal.receipt('op1').remainingSteps, []);
});
test('serialization bytes, bounded table bytes and resolution timing publish raw samples', () => {
  const f = setup(); const output = f.refs.observe(evidence()); const samples = [];
  for (let i = 0; i < 100; i++) { const start = performance.now(); f.refs.resolve('s1', output.elements[0].ref); samples.push(performance.now() - start); }
  const sorted = [...samples].sort((a,b) => a-b);
  console.log(JSON.stringify({ workload: '100 immediate offline native ref resolutions, one row', bytes: Buffer.byteLength(JSON.stringify(output)),
    tableBytes: f.refs.stats().bytes, samplesMs: samples, p50: sorted[49], p90: sorted[89] }));
  assert.ok(f.refs.stats().bytes > 0);
});
test('a newer ambiguous observation retires old input refs until a valid full read', () => {
  const f = setup(); const ref = f.refs.observe(evidence()).elements[0].ref;
  assert.throws(() => f.refs.observe(evidence({ fullGeneration: 2, viewGeneration: 2,
    rows: [row(), row(1, { id: 'other', nodeIdentity: 'other' })] })), code('TARGET_AMBIGUOUS'));
  assert.throws(() => f.refs.resolve('s1', ref), code('TARGET_STALE'));
  assert.equal(f.refs.stats().refs, 0);
  const fresh = f.refs.observe(evidence({ fullGeneration: 3, viewGeneration: 3, rows: [row(7)], delivered: [7] }));
  assert.equal(f.refs.resolve('s1', fresh.elements[0].ref).number, 7);
  assert.throws(() => f.refs.resolve('s1', ref), code('TARGET_STALE'));
});
test('malformed top-level and row input yields a closed error and clears reuse', () => {
  for (const input of [null, undefined, {}, evidence({ rows: [null] }), evidence({ rows: [undefined] }), evidence({ delivered: [999] })]) {
    const f = setup(); const ref = f.refs.observe(evidence()).elements[0].ref;
    assert.throws(() => f.refs.observe(input), error => error instanceof NativeError && ['VIEW_INCOMPLETE', 'TARGET_AMBIGUOUS'].includes(error.code));
    assert.throws(() => f.refs.resolve('s1', ref), code('TARGET_STALE'));
  }
});
test('invalid freshness and byte limits cannot disable their fences', () => {
  for (const maxAgeMs of [NaN, Infinity, -Infinity, -1, 'bad']) assert.throws(() => setup({ maxAgeMs }), TypeError);
  for (const maxBytes of [NaN, Infinity, -Infinity, -1, 0, 1.5, 'bad']) assert.throws(() => setup({ maxBytes }), TypeError);
  const f = setup({ maxAgeMs: 20000 }); f.change({ leaseExpires: 100000 });
  const ref = f.refs.observe(evidence()).elements[0].ref; f.tick(10011);
  assert.throws(() => f.refs.resolve('s1', ref), code('TARGET_STALE'));
});
test('an older delayed valid generation does not erase newer eligible evidence', () => {
  const f = setup(); const first = f.refs.observe(evidence());
  f.refs.observe(evidence({ fullGeneration: 2, viewGeneration: 2, rows: [row(7)], delivered: [7] }));
  assert.throws(() => f.refs.observe(evidence()), code('TARGET_STALE'));
  assert.equal(f.refs.resolve('s1', first.elements[0].ref).number, 7);
});
