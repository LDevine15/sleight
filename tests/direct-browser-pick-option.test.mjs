import test from 'node:test';
import assert from 'node:assert/strict';
import { searchOptions, describeMiss, queries, normalize } from '../plugins/sleight/lib/direct-browser/pick-option.mjs';

import { AIRPORTS, label, virtualList } from './fixtures/virtual-list.mjs';
const run = (list, want, extra = {}) => searchOptions({ read: () => list.read(), move: to => list.move(to), want, sleep: async () => {}, ...extra });

test('a sorted list of 400 rows is bisected: the exact row is found in about ten reads', async () => {
  const items = AIRPORTS.map(label);
  for (const index of [0, 133, 399]) {
    const list = virtualList(items), result = await run(list, items[index]);
    assert.equal(result.status, 'found'); assert.equal(result.text, items[index]);
    assert.ok(list.calls.read <= 14, 'reads ' + list.calls.read + ' for row ' + index);
  }
});

test('the wanted text may differ in case, brackets and spacing from the row', async () => {
  const items = AIRPORTS.map(label), a = AIRPORTS[251];
  for (const want of [label(a).toUpperCase(), a.name + ' ' + a.code, '  ' + a.name + '   [' + a.code + ']']) {
    const result = await run(virtualList(items), want); assert.equal(result.status, 'found', want); assert.equal(result.text, label(a));
  }
});

test('a list that is not sorted is walked from the top and the row is still found', async () => {
  const items = AIRPORTS.map(label).reverse().map((text, i) => i % 2 ? text : text.toLowerCase().replace('international', 'International'));
  const target = items[301], list = virtualList(items), result = await run(list, target);
  assert.equal(result.status, 'found'); assert.equal(result.text, target);
  assert.ok(list.calls.read > 14 && list.calls.read < 400, 'reads ' + list.calls.read);
});

test('rows that render a frame late are read again before they count', async () => {
  const items = AIRPORTS.map(label), result = await run(virtualList(items, { lag: 2 }), items[222]);
  assert.equal(result.status, 'found'); assert.equal(result.text, items[222]);
});

test('a list that is not scrollable is read once', async () => {
  const items = ['Alpha (AAA)', 'Beta (BBB)', 'Gamma (GGG)'], list = virtualList(items, { client: 360 });
  const result = await run(list, 'beta bbb'); assert.equal(result.status, 'found'); assert.equal(list.calls.move, 0);
});

test('a missing option reports the closest rows from everything the walk saw', async () => {
  const items = AIRPORTS.map(label), want = AIRPORTS[40].name.split(' ')[0] + ' Nowhere International (QQQ)';
  const result = await run(virtualList(items), want);
  assert.equal(result.status, 'none'); assert.equal(result.seen, 400); assert.equal(result.closest.length, 5);
  assert.match(describeMiss(result, want), /^no option matches "[^"]+"; closest: "/);
});

test('words that only some rows contain pick the one row, or name several', async () => {
  const items = ['Alpha Field (AAA)', 'Beta Field (BBB)', 'Beta Municipal (BCC)', 'Gamma Field (GGG)'];
  const one = await run(virtualList(items), 'Gamma'); assert.equal(one.status, 'found'); assert.equal(one.text, 'Gamma Field (GGG)');
  const many = await run(virtualList(items), 'Beta'); assert.equal(many.status, 'ambiguous'); assert.deepEqual(many.options, ['Beta Field (BBB)', 'Beta Municipal (BCC)']);
  assert.match(describeMiss(many, 'Beta'), /several options match "Beta": "Beta Field \(BBB\)", "Beta Municipal \(BCC\)"; give more of the text/);
});

test('two rows with the same words are ambiguous, and a disabled exact row is named', async () => {
  const twin = await run(virtualList(['One (AAA)', 'One (AAA)', 'Two (BBB)']), 'one aaa'); assert.equal(twin.status, 'ambiguous');
  const off = await run(virtualList(['One (AAA)', 'Two (BBB)'], { disabled: [1] }), 'Two (BBB)'); assert.equal(off.status, 'disabled');
  assert.match(describeMiss(off, 'Two (BBB)'), /is disabled/);
});

test('the search stops at its time and read budgets and says so', async () => {
  const items = AIRPORTS.map(label), unsorted = items.slice().reverse();
  let clock = 0;
  const slow = await run(virtualList(unsorted), 'nothing here at all', { now: () => clock, budgetMs: 100, sleep: async () => { clock += 20; } });
  assert.equal(slow.status, 'timeout'); assert.match(describeMiss(slow, 'x'), /ran out of time/);
  const capped = await run(virtualList(unsorted), 'nothing here at all', { maxReads: 10 }); assert.equal(capped.status, 'timeout');
});

test('queries tries the wanted text, then without brackets, then the first two words', () => {
  assert.deepEqual(queries('Norcrest Point International (MAO)'), ['Norcrest Point International (MAO)', 'Norcrest Point International', 'Norcrest Point']);
  assert.deepEqual(queries('Tokyo'), ['Tokyo']);
  assert.equal(normalize('  Zürich — Flughafen (ZRH) '), 'zurich flughafen zrh');
});
