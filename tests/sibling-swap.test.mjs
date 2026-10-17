import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const tree = rows => 'Window: "Draft", App: Editor.\n0 standard window Draft\n' + rows.join('\n');
// Reduced ribbon lines from 2026-10-16T15-34-34-554Z/sleight-excel-edit-1,
// transcript line 11. The permutations below are controlled regression pairs.
const rows = ['\t10 tab group Description: ribbon, Details: Home', '\t\t77 tab Review', '\t\t78 tab View'];
const swapped = [rows[0], '\t\t77 tab View', '\t\t78 tab Review'];
const text = text => ({ type: 'text', text });
function result(before, after, code = 'await app.click(78)', options = {}) {
  const c = createReadCompactor();
  c.process([text(tree(before))]);
  const action = c.beginAction(code);
  if (options.overlap && action) action.overlap = true;
  return c.process([text(GUARD_MARK + tree(after) + GUARD_END)], { action, ...options }).map(i => i.text).join('\n');
}

test('a click that swaps two recorded sibling lines names both and gives recovery advice', () => {
  const out = result(rows, swapped);
  assert.match(out, /clicking also swapped Review and View; tabs now: View, Review; if that wasn't intended, fix the order with the app's move command\./);
  assert.equal(out.match(/clicking also swapped/g)?.length, 1);
});

for (const code of ['await app.click(7)', 'await app.click({ label: "Inventory" })']) {
  test(`selected label prefixes do not hide swapped tabs: ${code}`, () => {
    const before = ['\t6 group Sheets', '\t\t7 button Inventory', '\t\t8 button Selected, Review 2a37d191'];
    const after = ['\t6 group Sheets', '\t\t7 button Review 2a37d191', '\t\t8 button Selected, Inventory'];
    const out = result(before, after, code);
    assert.match(out, /swapped Inventory and Review 2a37d191;/);
    assert.doesNotMatch(out, /swapped Selected,|and Selected,/);
  });
}

test('swap advice allows intentional reorders, including a multi-click call', () => {
  for (const code of ['await app.click(78)', 'await app.click(77); await app.click(78)']) {
    const out = result(rows, swapped, code);
    assert.match(out, /swapped Review and View; tabs now: View, Review; if that wasn't intended, fix the order with the app's move command\./);
    assert.doesNotMatch(out, /shouldn't reorder/);
    assert.equal(out.match(/swapped Review and View/g)?.length, 1);
  }
});

test('clicking a column header to sort does not report a sibling swap', () => {
  const before = ['\t1 table', '\t\t2 column header Name', '\t\t3 row Alpha', '\t\t4 row Beta'];
  const after = [before[0], before[1], '\t\t3 row Beta', '\t\t4 row Alpha'];
  assert.doesNotMatch(result(before, after, 'await app.click(2)'), /also swapped/);
});

test('sort cues anywhere in either tree suppress click and multi-click swap notes', () => {
  for (const cue of ['\t90 column header Name', '\t90 button Sort by Name',
    '\t90 button Order, Secondary Actions: Sort', '\t90 button Ascending', '\t90 button Descending']) {
    for (const [before, after] of [[[...rows, cue], swapped], [rows, [...swapped, cue]]]) {
      for (const code of ['await app.click(78)', 'await app.click(77); await app.click(78)']) {
        assert.doesNotMatch(result(before, after, code), /also swapped/, `${cue}: ${code}`);
      }
    }
  }
});

test('unchanged siblings and an inserted, renumbered list never report a swap', () => {
  assert.doesNotMatch(result(rows, rows), /clicking also swapped/);
  assert.doesNotMatch(result(rows, [rows[0], '\t\t77 tab New', '\t\t78 tab Review', '\t\t79 tab View']), /clicking also swapped/);
});

test('sort commands, chorded keys and drags never blame a click for reordering', () => {
  for (const code of ['await app.performSecondaryAction(10, "Sort")',
    'await app.click(78); await app.pressKey("super+shift+s")',
    'await app.drag([1, 2], [3, 4]); await app.click(78)',
    'await app.click(78); await app.pressKey("super+a")']) {
    assert.doesNotMatch(result(rows, swapped, code), /clicking also swapped/);
  }
});

test('selection flags and element renumbering do not hide a sibling swap', () => {
  const before = ['\t1 tab bar', '\t\t2 radio button (selected) Description: First, ID: a', '\t\t3 radio button (selectable) Description: Second, ID: b'];
  const after = ['\t5 tab bar', '\t\t6 radio button (selected) Description: Second, ID: b', '\t\t7 radio button (selectable) Description: First, ID: a'];
  assert.match(result(before, after), /clicking also swapped First and Second;/);
});

test('lowercase labels and nonadjacent sibling swaps are reported', () => {
  const before = ['\t1 list', '\t\t2 row (selectable) alpha', '\t\t3 row (selectable) middle', '\t\t4 row (selectable) beta'];
  const after = ['\t1 list', '\t\t2 row (selectable) beta', before[2], '\t\t4 row (selectable) alpha'];
  assert.match(result(before, after), /clicking also swapped alpha and beta;/);
});

test('different parents, roles, indentation, renames and three-way rotations are not sibling swaps', () => {
  for (const [before, after] of [
    [['\t1 group Left', '\t\t2 tab One', '\t3 group Right', '\t\t4 tab Two'], ['\t1 group Left', '\t\t2 tab Two', '\t3 group Right', '\t\t4 tab One']],
    [['\t1 tab One', '\t2 button Two'], ['\t1 button Two', '\t2 tab One']],
    [['\t1 tab One', '\t\t2 tab Two'], ['\t1 tab Two', '\t\t2 tab One']],
    [rows, [rows[0], '\t\t77 tab View', '\t\t78 tab Renamed']],
    [[...rows, '\t\t79 tab Extra'], [rows[0], '\t\t77 tab View', '\t\t78 tab Extra', '\t\t79 tab Review']],
  ]) assert.doesNotMatch(result(before, after), /clicking also swapped/);
});

test('failed, overlapping, incomplete and different-window observations never attribute a swap', () => {
  for (const options of [{ failed: true }, { overlap: true }, { forceFull: true }]) {
    assert.doesNotMatch(result(rows, swapped, undefined, options), /clicking also swapped/);
  }
  assert.doesNotMatch(result(rows, [...swapped, '…(20)']), /clicking also swapped/);
  const c = createReadCompactor(); c.process([text(tree(rows))]);
  const out = c.process([text(GUARD_MARK + tree(swapped).replace('"Draft"', '"Other"') + GUARD_END)], { action: c.beginAction('await app.click(78)') });
  assert.doesNotMatch(out.map(i => i.text).join('\n'), /clicking also swapped/);
});

const sheetRows = (active, reverse = false) => [
  `\t4 layout area Content Area, Description: Workbook area, ${active}, Sheet 2 of 2, Help: The content area`,
  ...(reverse ? ['\t\t7 button Review 16f3255b', '\t\t8 button Selected, Inventory']
    : ['\t\t7 button Inventory', '\t\t8 button Selected, Review 16f3255b']),
];
const mixedClick = 'await app.click(7); await app.typeText("B2"); await app.pressKey("Return"); await app.paste("759")';

for (const code of ['await app.click(7)', mixedClick]) {
  test(`active-sheet parent descriptions do not hide a swap: ${code}`, () => {
    const out = result(sheetRows('Review 16f3255b'), sheetRows('Inventory', true), code);
    assert.match(out, /swapped Inventory and Review 16f3255b; tabs now: Review 16f3255b, Inventory;/);
    assert.match(out, /fix the order with the app's move command\./);
    assert.doesNotMatch(out, /undo/);
  });
}

test('a mixed click and plain typing reports the entire new sibling order', () => {
  const before = [...rows, '\t\t79 tab Extra'];
  const after = [...swapped, '\t\t79 tab Extra'];
  const out = result(before, after, mixedClick);
  assert.match(out, /tabs now: View, Review, Extra;/);
});

test('sort cues still suppress mixed typing swap notes', () => {
  assert.doesNotMatch(result([...rows, '\t90 button Sort'], [...swapped, '\t90 button Sort'], mixedClick), /also swapped/);
});

test('groups with the same role and child multiset are ambiguous across parent descriptions', () => {
  const before = [...sheetRows('Review 16f3255b'), ...sheetRows('Other').map(l => l.replace(/\d+ /, n => (+n + 20) + ' '))];
  const after = [...sheetRows('Inventory', true), ...sheetRows('Other')];
  assert.doesNotMatch(result(before, after), /also swapped/);
});

function session() {
  const c = createReadCompactor();
  c.process([text(tree(sheetRows('Review 16f3255b')))]);
  const call = (rows, code, options = {}) => c.process([text(GUARD_MARK + tree(rows) + GUARD_END)],
    { action: c.beginAction(code), ...options }).map(i => i.text).join('\n');
  call(sheetRows('Inventory', true), mixedClick);
  return { c, call };
}

test('a later save repeats the observed order after typing and reads in the same session', () => {
  const { c, call } = session();
  call(sheetRows('Inventory', true), 'await app.typeText("more")');
  c.process([text(tree(sheetRows('Inventory', true)))]);
  for (let i = 0; i < 2; i++) {
    const out = call(sheetRows('Inventory', true), 'await app.pressKey("super+s")');
    assert.match(out, /saved:/);
    assert.match(out, /sleight: tabs now: Review 16f3255b, Inventory\./);
    assert.doesNotMatch(out, /also swapped/);
  }
});

test('an intervening move clears the saved-order reminder', () => {
  const { call } = session();
  call(sheetRows('Review 16f3255b'), 'await app.performSecondaryAction(7, "Move")');
  assert.doesNotMatch(call(sheetRows('Review 16f3255b'), 'await app.pressKey("super+s")'), /tabs now:/);
});

test('an intervening read showing a different order also clears the reminder', () => {
  const { c, call } = session();
  c.process([text(tree(sheetRows('Review 16f3255b')))]);
  assert.doesNotMatch(call(sheetRows('Review 16f3255b'), 'await app.pressKey("super+s")'), /tabs now:/);
});

test('failed saves, incomplete reads and another document do not repeat an order', () => {
  for (const options of [{ failed: true }, {}]) {
    const { call } = session();
    const after = options.failed ? sheetRows('Inventory', true) : [...sheetRows('Inventory', true), '…(20)'];
    assert.doesNotMatch(call(after, 'await app.pressKey("super+s")', options), /tabs now:/);
  }
  const { c } = session();
  const out = c.process([text(GUARD_MARK + tree(sheetRows('Inventory', true)).replace('"Draft"', '"Other"') + GUARD_END)],
    { action: c.beginAction('await app.pressKey("super+s")') }).map(i => i.text).join('\n');
  assert.doesNotMatch(out, /tabs now:/);
});
