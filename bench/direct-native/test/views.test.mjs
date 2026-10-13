import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeViews } from '../views.mjs';
import { verifyWindowIdentity } from '../../../plugins/sleight/lib/window-identity.mjs';

const identity = { session: 's1', runtimeEpoch: 'r1', pid: 1, processStart: 1,
  windowEpoch: 'w1', windowId: 1, appId: 'fixture', title: 'fixture', url: '',
  document: 'd1', leaseGeneration: 1 };
const row = (number, extra = {}) => ({ number, role: 'cell', name: `Cell ${number}`,
  id: `id${number}`, ancestor: 'root', nodeIdentity: `node${number}`, parent: 0,
  value: 'value', ...extra });
const observation = (rows = [row(0, { role: 'window', parent: null }), row(1)], extra = {}) => ({
  identity, source: 'engine-full', scope: 'window', coverage: 'scope-complete',
  observedAt: 1, fullGeneration: 1, viewGeneration: 1, evidence: 'full private evidence', rows, ...extra });
const setup = (data = observation(), options = {}) => {
  const views = new NativeViews({ current: () => identity, ...options });
  views.observe(data); return views;
};
const code = expected => error => error.code === expected;

test('default projection bounds whole UTF-8 reply, preserves rows and guard evidence', () => {
  const rows = [row(0, { role: 'window', parent: null }), ...Array.from({ length: 1000 }, (_, i) => row(i + 1, { value: '日本語😀'.repeat(20) }))];
  const data = observation(rows), before = JSON.stringify(data);
  const views = setup(data), reply = views.read();
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 12000);
  assert.ok(reply.omittedRows > 0); assert.ok(reply.cursor);
  assert.equal(JSON.stringify(views.guardEvidence()), before);
  assert.equal(views.stats().deliveredNodes, reply.rows.length);
  assert.ok(reply.rows.every(r => !r.value?.includes('�')));
});
test('exact query keeps ancestors and modal controls with authorized values', () => {
  const views = setup(observation([row(0, { role: 'window', parent: null }), row(1),
    row(2, { role: 'sheet', parent: 0 }), row(3, { parent: 2, role: 'button', name: 'Save', value: '', selected: true })]));
  const reply = views.read({ query: { name: 'Cell 1' } });
  assert.deepEqual(reply.rows.map(r => r.number), [0, 1, 2, 3]);
  assert.equal(reply.rows.at(-1).selected, true);
});
test('exact region and query avoid substring ambiguity', () => {
  const views = setup(observation([row(0, { parent: null }), row(1, { name: 'Cell' }), row(2, { name: 'Cell extra' })]));
  assert.deepEqual(views.read({ scope: { kind: 'region', number: 1 }, query: { name: 'Cell' } }).rows.map(r => r.number), [0, 1]);
  assert.equal(views.read({ query: { name: 'missing' } }).absence, 'scoped');
});
test('virtual rows and incomplete scope never establish absence', () => {
  assert.equal(setup(observation(undefined, { coverage: 'rendered-partial' })).read({ query: { name: 'missing' } }).absence, 'unknown');
});
test('unsupported scopes and queries have explicit capability errors', () => {
  const views = setup();
  assert.throws(() => views.read({ scope: { kind: 'range', start: 1 } }), code('AX_UNSUPPORTED'));
  assert.throws(() => views.read({ query: { regex: '.*' } }), code('AX_UNSUPPORTED'));
});
test('secure and hidden control text never enters delivered output', () => {
  const reply = setup(observation([row(0, { parent: null }), row(1, { secure: true, name: 'secret', value: 'secret' }),
    row(2, { hidden: true, name: 'hidden-secret', value: 'hidden-secret' })])).read();
  assert.ok(!JSON.stringify(reply).includes('secret'));
  assert.ok(!reply.rows.some(r => r.number === 2));
});
test('a long indivisible value is omitted with progress instead of split', () => {
  const views = setup(observation([row(0, { parent: null }), row(1, { value: '😀'.repeat(20000) }), row(2)]));
  const reply = views.read({ budgetBytes: 2000 });
  assert.ok(!reply.rows.some(r => r.number === 1)); assert.deepEqual(reply.oversizedRows, [1]);
  assert.ok(reply.rows.some(r => r.number === 2)); assert.equal(reply.absence, 'unknown');
});
test('metadata and requested ceiling cannot be weakened', () => {
  const views = setup();
  for (const budgetBytes of [1, 64001, NaN, Infinity, 1.5]) assert.throws(() => views.read({ budgetBytes }), code('BUDGET_TOO_SMALL'));
  assert.ok(Buffer.byteLength(JSON.stringify(views.read({ budgetBytes: 64000 }))) <= 64000);
});
test('pagination is versioned, reader bound and does not deliver the suffix early', () => {
  const views = setup(observation([row(0, { parent: null }), ...Array.from({ length: 100 }, (_, i) => row(i + 1, { value: 'x'.repeat(100) }))]));
  const first = views.read({ reader: 'a', budgetBytes: 2000 });
  assert.ok(first.cursor); assert.equal(views.delivered('a', 100), false);
  assert.throws(() => views.read({ reader: 'b', cursor: first.cursor }), code('TARGET_STALE'));
  const second = views.read({ reader: 'a', cursor: first.cursor, budgetBytes: 2000 });
  assert.ok(second.rows.some(r => !first.rows.some(f => f.number === r.number)));
  views.observe(observation(undefined, { fullGeneration: 2 }));
  assert.throws(() => views.read({ reader: 'a', cursor: second.cursor }), code('TARGET_STALE'));
});
test('hidden guard reads create no delivered base or seen numbers', () => {
  const views = setup();
  assert.equal(views.stats().deliveredNodes, 0);
  const reply = views.read({ deltaFrom: 'unknown' });
  assert.equal(reply.resync, true); assert.equal(reply.mode, 'full');
  assert.equal(views.delivered('default', 999), false);
});
test('delta uses exact delivered base; reordered or renumbered rows resync', () => {
  const views = setup(), base = views.read();
  views.observe(observation(undefined, { fullGeneration: 2 }));
  assert.deepEqual(views.read({ deltaFrom: base.view }).rows, []);
  const next = views.read();
  views.observe(observation([row(0, { parent: null }), row(2), row(1)], { fullGeneration: 3 }));
  assert.equal(views.read({ deltaFrom: next.view }).resync, true);
});
test('duplicate labels remain distinct, hidden rows never become seen through delta', () => {
  const views = setup(observation([row(0, { parent: null }), row(1, { name: 'same' }), row(2, { name: 'same' })]));
  assert.deepEqual(views.read({ query: { name: 'same' } }).rows.map(r => r.number), [0, 1, 2]);
});
test('readers have independent delivery; evicted views require resync', () => {
  const views = setup(), base = views.read({ reader: 'a' });
  assert.equal(views.delivered('b', 1), false);
  for (let i = 0; i < 33; i++) views.read({ reader: 'a' });
  assert.equal(views.read({ reader: 'a', deltaFrom: base.view }).resync, true);
  assert.ok(views.stats().views <= 32);
});
test('snapshot eviction invalidates cursors and reuse while bounded reads continue', () => {
  const views = setup(observation(undefined, { evidence: 'x'.repeat(1000) }), { cacheBytes: 500 });
  assert.equal(views.guardEvidence(), null);
  assert.equal(views.read().resync, true);
  assert.equal(views.stats().evidenceGenerations, 0);
});
test('uncertain or changed identity refuses and retires delivered state', () => {
  let current = identity;
  const views = setup(observation(), { current: () => current }); views.read();
  current = { ...identity, processStart: 2 };
  assert.throws(() => views.read(), code('WINDOW_CHANGED'));
  assert.equal(views.stats().deliveredNodes, 0);
});
test('legacy explicit full read preserves exact trusted engine evidence', () => {
  const views = setup();
  assert.deepEqual(views.legacyFull(), observation());
});
test('direct AX cannot enter guard evidence or supply actionable delivered numbers', () => {
  const views = setup(observation(undefined, { source: 'direct-ax' }));
  assert.equal(views.guardEvidence(), null);
  views.read(); assert.equal(views.delivered('default', 1), false);
});
test('modal and focused ancestor chain survive a large background grid', () => {
  const rows = [row(0, { parent: null }), ...Array.from({ length: 500 }, (_, i) => row(i + 1, { value: 'x'.repeat(100) })),
    row(900, { role: 'sheet' }), row(901, { parent: 900, role: 'button', name: 'Save', focused: true })];
  const reply = setup(observation(rows)).read({ budgetBytes: 2000 });
  assert.ok(reply.rows.some(r => r.number === 900)); assert.ok(reply.rows.some(r => r.number === 901));
});
test('every expanded page preserves ancestors', () => {
  const views = setup(observation([row(0, { parent: null }), ...Array.from({ length: 50 }, (_, i) => row(i + 1, { value: 'x'.repeat(200) }))]));
  const first = views.read({ budgetBytes: 2000 });
  const next = views.read({ cursor: first.cursor, budgetBytes: 2000 });
  assert.ok(next.rows.some(r => r.number === 0));
});
test('same-number replacement and renumbering force full resync', () => {
  for (const extra of [{ nodeIdentity: 'replaced' }, { number: 2 }]) {
    const views = setup(), base = views.read();
    views.observe(observation([row(0, { role: 'window', parent: null }), row(1, extra)], { fullGeneration: 2 }));
    assert.equal(views.read({ deltaFrom: base.view }).resync, true);
  }
});
test('hidden subtrees and direct AX content stay private', () => {
  const views = setup(observation([row(0, { parent: null }), row(1, { hidden: true }), row(2, { parent: 1, name: 'secret' })]));
  assert.ok(!JSON.stringify(views.read()).includes('secret'));
  const direct = setup(observation([row(0, { parent: null }), row(1, { name: 'secret', value: 'secret' })], { source: 'direct-ax' }));
  const reply = direct.read();
  assert.ok(!JSON.stringify(reply).includes('secret'));
  assert.ok(reply.rows.every(r => !Object.hasOwn(r, 'number')));
});
test('guard identity decisions agree before and after projection', () => {
  const expected = { appId: 'fixture', title: 'fixture', url: '', nativeIdentity: { epoch: 'w1', window: 1, pid: 1, processStart: 1 } };
  for (const extra of [{}, { processStart: 2 }, { pid: 2 }, { window: 2 }, { epoch: 'w2' }, { matches: 2 }]) {
    const native = { status: 'ok', epoch: 'w1', window: 1, pid: 1, processStart: 1, matches: 1,
      appId: 'fixture', title: 'fixture', url: '', ...extra };
    const views = setup(observation(undefined, { nativeIdentity: native }));
    const verdict = value => { try { verifyWindowIdentity(expected, value); return 'allow'; } catch (error) { return error.message; } };
    const before = verdict(native); views.read({ query: { name: 'missing' } });
    assert.equal(verdict(views.guardEvidence().nativeIdentity), before);
  }
});
test('synthetic 1000-cell grid replays 100 exact selections without hidden guesses', t => {
  const rows = [row(0, { role: 'window', parent: null }), ...Array.from({ length: 1000 }, (_, i) => row(i + 1, { value: '日本語😀'.repeat(20) }))];
  const data = observation(rows), views = setup(data), initial = views.read();
  let successes = 0;
  for (let number = 10; number <= 1000; number += 10) {
    const reply = views.read({ query: { id: `id${number}` } });
    if (reply.rows.some(r => r.number === number) && views.delivered('default', number)) successes++;
  }
  assert.equal(successes, 100);
  t.diagnostic(JSON.stringify({ inputBytes: Buffer.byteLength(JSON.stringify(data)), deliveredBytes: Buffer.byteLength(JSON.stringify(initial)),
    initialRows: initial.rows.length, selectionReplays: successes, guardUnchanged: JSON.stringify(views.guardEvidence()) === JSON.stringify(data) }));
});
test('malformed and cyclic observations retire the view, delayed evidence preserves newer state', () => {
  const views = setup(); views.read();
  views.observe(observation(undefined, { fullGeneration: 2 }));
  assert.throws(() => views.observe(observation()), code('TARGET_STALE'));
  assert.equal(views.guardEvidence().fullGeneration, 2);
  assert.throws(() => views.observe(observation([row(0, { parent: 1 }), row(1, { parent: 0 })], { fullGeneration: 3 })), code('VIEW_INCOMPLETE'));
  assert.throws(() => views.read(), code('VIEW_INCOMPLETE'));
});
test('pagination makes progress when a row fits alone but not beside required context', () => {
  const views = setup(observation([row(0, { parent: null, value: 'x'.repeat(100) }), row(1, { value: 'x'.repeat(1400) }), row(2)]));
  const reply = views.read({ budgetBytes: 2000 });
  assert.deepEqual(reply.oversizedRows, [1]);
  assert.equal(reply.cursor, null); assert.ok(reply.rows.some(r => r.number === 2));
});
test('byte bounds hold across 200 synthetic Unicode budgets', () => {
  for (let i = 0; i < 200; i++) {
    const budgetBytes = 600 + i * 17;
    const views = setup(observation([row(0, { parent: null }), ...Array.from({ length: 40 }, (_, j) =>
      row(j + 1, { value: '\\"日本語😀'.repeat((i + j) % 80) }))]));
    try { assert.ok(Buffer.byteLength(JSON.stringify(views.read({ budgetBytes }))) <= budgetBytes); }
    catch (error) { assert.equal(error.code, 'BUDGET_TOO_SMALL'); }
  }
});
test('engine refusal survives budgeting and delivers no actionable rows', () => {
  const views = setup(observation(undefined, { refusal: { code: 'FORBIDDEN' } }));
  const reply = views.read();
  assert.equal(reply.refusal.code, 'FORBIDDEN'); assert.deepEqual(reply.rows, []);
  assert.equal(views.delivered('default', 1), false);
});
test('weak node correspondence resyncs; returned rows cannot mutate a delivered base', () => {
  const views = setup(observation([row(0, { parent: null }), row(1, { nodeIdentity: '' })]));
  const base = views.read();
  views.observe(observation([row(0, { parent: null }), row(1, { nodeIdentity: '' })], { fullGeneration: 2 }));
  assert.equal(views.read({ deltaFrom: base.view }).resync, true);
  const strong = setup(), known = strong.read(); known.rows[1].value = 'changed by caller';
  strong.observe(observation(undefined, { fullGeneration: 2 }));
  assert.deepEqual(strong.read({ deltaFrom: known.view }).rows, []);
});
test('a query miss with hidden or secure source rows remains unknown', () => {
  for (const extra of [{ hidden: true }, { secure: true }]) {
    const views = setup(observation([row(0, { parent: null }), row(1, extra)]));
    assert.equal(views.read({ query: { name: 'missing' } }).absence, 'unknown');
  }
});
