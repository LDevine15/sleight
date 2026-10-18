import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moved, shortestPlan, runReorder } from '../plugins/sleight/lib/reorder-plan.mjs';

const start = ['Billing', 'Security', 'Product updates', 'Mentions', 'Reminders'];
const names = plan => plan.map(step => `${step.item}>${step.target}`);

test('the shortest plan takes two drops where the runs used three', () => {
  const first = shortestPlan(start, ['Security', 'Mentions', 'Billing', 'Reminders', 'Product updates']);
  assert.equal(first.length, 2);
  assert.deepEqual(names(first), ['Billing>Mentions', 'Product updates>Reminders']);
  const second = shortestPlan(start, ['Mentions', 'Reminders', 'Security', 'Product updates', 'Billing']);
  assert.equal(second.length, 3);
});

test('the plan length is the minimum for all 120 orders of five rows', () => {
  const permutations = items => items.length < 2 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
  const ids = [0, 1, 2, 3, 4].map(String);
  for (const target of permutations(ids)) {
    // Rows outside a longest increasing subsequence each need one drop.
    const at = target.map(id => ids.indexOf(id));
    const best = at.map(() => 1);
    for (let i = 0; i < at.length; i++) for (let j = 0; j < i; j++) if (at[j] < at[i]) best[i] = Math.max(best[i], best[j] + 1);
    assert.equal(shortestPlan(ids, target).length, ids.length - Math.max(...best), target.join());
  }
});

test('blocked endpoints choose an equivalent route and a fully blocked list has no plan', () => {
  const target = ['Security', 'Mentions', 'Billing', 'Reminders', 'Product updates'];
  const blockedUpper = (order, from, to) => to >= from; // nothing may be dropped above its row
  const plan = shortestPlan(start, target, blockedUpper);
  assert.ok(plan.every(step => step.to > step.from));
  assert.equal(shortestPlan(start, target, () => false), null);
  assert.equal(shortestPlan(start, start, () => false).length, 0);
});

test('labels must be unique, at most seven and match', () => {
  assert.throws(() => shortestPlan(['a', 'a'], ['a', 'a']));
  assert.throws(() => shortestPlan(['a', 'b'], ['a', 'c']));
  assert.throws(() => shortestPlan(Array.from({ length: 8 }, (_, i) => String(i)), Array.from({ length: 8 }, (_, i) => String(i))));
});

// A list that drops by inserting at the target's original index, like the settings fixture.
function list(initial, behavior = {}) {
  const state = { order: [...initial], drops: [], observes: 0 };
  return {
    state,
    observe: async () => { state.observes++; return [...state.order]; },
    drop: async (method, step) => {
      state.drops.push({ method, item: step.item, target: step.target });
      if (behavior[method] === 'ignored') return;
      if (behavior[method] === 'scrambled') { state.order.reverse(); return; }
      state.order = moved(state.order, step.from, step.to);
    },
  };
}

test('every drop is verified by an observation before the next one', async () => {
  const target = ['Security', 'Mentions', 'Billing', 'Reminders', 'Product updates'];
  const fixture = list(start);
  const reads = [];
  const result = await runReorder({ target, observe: async () => { const order = await fixture.observe(); reads.push(fixture.state.drops.length); return order; }, drop: fixture.drop });
  assert.equal(result.verified, true); assert.equal(result.drops, 2);
  assert.deepEqual(fixture.state.order, target);
  // One read at the start, then one after each drop, and no drop without a read after the previous one.
  assert.deepEqual(reads, [0, 1, 2]);
});

test('an unexpected order after a drop stops the run before the next drop', async () => {
  const fixture = list(start, { background: 'scrambled' });
  const result = await runReorder({ target: ['Security', 'Billing', 'Product updates', 'Mentions', 'Reminders'], observe: fixture.observe, drop: fixture.drop });
  assert.equal(result.verified, false); assert.match(result.reason, /not the expected one/);
  assert.equal(fixture.state.drops.length, 1);
});

test('an ineffective method is never repeated and the next method gets the step', async () => {
  const target = ['Security', 'Billing', 'Product updates', 'Mentions', 'Reminders'];
  const fixture = list(start, { background: 'ignored' });
  const result = await runReorder({ target, observe: fixture.observe, drop: fixture.drop, methods: ['background', 'engine'] });
  assert.equal(result.verified, true);
  assert.deepEqual(fixture.state.drops.map(d => d.method), ['background', 'engine']);
});

test('when every method was ineffective the run refuses instead of repeating a fallback', async () => {
  const fixture = list(start, { background: 'ignored', engine: 'ignored' });
  const result = await runReorder({ target: [...start].reverse(), observe: fixture.observe, drop: fixture.drop, methods: ['background', 'engine'] });
  assert.equal(result.verified, false); assert.match(result.reason, /no effective method left.*background, engine.*instead of repeating/);
  assert.deepEqual(fixture.state.drops.map(d => d.method), ['background', 'engine']);
  assert.deepEqual(fixture.state.order, start);
});

test('a method that did nothing for one step is not used for another step', async () => {
  const fixture = list(start, { engine: 'ignored' });
  const result = await runReorder({ target: [...start].reverse(), observe: fixture.observe, drop: fixture.drop, methods: ['engine'] });
  assert.equal(result.verified, false);
  assert.equal(fixture.state.drops.length, 1);
});

test('a fully covered list stops with no route and drops nothing', async () => {
  const fixture = list(start);
  const result = await runReorder({ target: [...start].reverse(), observe: fixture.observe, drop: fixture.drop, allowed: () => false });
  assert.equal(result.verified, false); assert.match(result.reason, /no route/);
  assert.equal(fixture.state.drops.length, 0);
});

test('a list already in order drops nothing', async () => {
  const fixture = list(start);
  const result = await runReorder({ target: start, observe: fixture.observe, drop: fixture.drop });
  assert.equal(result.verified, true); assert.equal(result.drops, 0); assert.equal(fixture.state.drops.length, 0);
});
