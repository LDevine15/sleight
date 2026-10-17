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
  assert.match(out, /this click also swapped Review and View; a click shouldn't reorder, so check the order and fix it with the app's undo or move command\./);
  assert.equal(out.match(/this click also swapped/g)?.length, 1);
});

test('unchanged siblings and an inserted, renumbered list never report a swap', () => {
  assert.doesNotMatch(result(rows, rows), /this click also swapped/);
  assert.doesNotMatch(result(rows, [rows[0], '\t\t77 tab New', '\t\t78 tab Review', '\t\t79 tab View']), /this click also swapped/);
});

test('a legitimate sort command and mixed input never blame a click for reordering', () => {
  for (const code of ['await app.performSecondaryAction(10, "Sort")',
    'await app.click(78); await app.pressKey("super+shift+s")',
    'await app.drag([1, 2], [3, 4]); await app.click(78)',
    'await app.click(78); await app.typeText("sort")']) {
    assert.doesNotMatch(result(rows, swapped, code), /this click also swapped/);
  }
});

test('selection flags and element renumbering do not hide a sibling swap', () => {
  const before = ['\t1 tab bar', '\t\t2 radio button (selected) Description: First, ID: a', '\t\t3 radio button (selectable) Description: Second, ID: b'];
  const after = ['\t5 tab bar', '\t\t6 radio button (selected) Description: Second, ID: b', '\t\t7 radio button (selectable) Description: First, ID: a'];
  assert.match(result(before, after), /this click also swapped First and Second;/);
});

test('lowercase labels and nonadjacent sibling swaps are reported', () => {
  const before = ['\t1 list', '\t\t2 row (selectable) alpha', '\t\t3 row (selectable) middle', '\t\t4 row (selectable) beta'];
  const after = ['\t1 list', '\t\t2 row (selectable) beta', before[2], '\t\t4 row (selectable) alpha'];
  assert.match(result(before, after), /this click also swapped alpha and beta;/);
});

test('different parents, roles, indentation, renames and three-way rotations are not sibling swaps', () => {
  for (const [before, after] of [
    [['\t1 group Left', '\t\t2 tab One', '\t3 group Right', '\t\t4 tab Two'], ['\t1 group Left', '\t\t2 tab Two', '\t3 group Right', '\t\t4 tab One']],
    [['\t1 tab One', '\t2 button Two'], ['\t1 button Two', '\t2 tab One']],
    [['\t1 tab One', '\t\t2 tab Two'], ['\t1 tab Two', '\t\t2 tab One']],
    [rows, [rows[0], '\t\t77 tab View', '\t\t78 tab Renamed']],
    [[...rows, '\t\t79 tab Extra'], [rows[0], '\t\t77 tab View', '\t\t78 tab Extra', '\t\t79 tab Review']],
  ]) assert.doesNotMatch(result(before, after), /this click also swapped/);
});

test('failed, overlapping, incomplete and different-window observations never attribute a swap', () => {
  for (const options of [{ failed: true }, { overlap: true }, { forceFull: true }]) {
    assert.doesNotMatch(result(rows, swapped, undefined, options), /this click also swapped/);
  }
  assert.doesNotMatch(result(rows, [...swapped, '…(20)']), /this click also swapped/);
  const c = createReadCompactor(); c.process([text(tree(rows))]);
  const out = c.process([text(GUARD_MARK + tree(swapped).replace('"Draft"', '"Other"') + GUARD_END)], { action: c.beginAction('await app.click(78)') });
  assert.doesNotMatch(out.map(i => i.text).join('\n'), /this click also swapped/);
});
