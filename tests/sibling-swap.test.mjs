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
  assert.match(out, /clicking also swapped Review and View; tabs now: View, Review; if that wasn't intended, Undo \(Cmd\+Z\) restores the order; a move dialog is the fallback\./);
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
    assert.match(out, /swapped Review and View; tabs now: View, Review; if that wasn't intended, Undo \(Cmd\+Z\) restores the order; a move dialog is the fallback\./);
    assert.doesNotMatch(out, /shouldn't reorder/);
    assert.equal(out.match(/swapped Review and View/g)?.length, 1);
  }
});

test('clicking a column header to sort does not report a sibling swap', () => {
  const before = ['\t1 table', '\t\t2 column header Name', '\t\t3 row Alpha', '\t\t4 row Beta'];
  const after = [before[0], before[1], '\t\t3 row Beta', '\t\t4 row Alpha'];
  assert.doesNotMatch(result(before, after, 'await app.click(2)'), /also swapped/);
});

test('a column header anywhere, or sort words inside the swapped group, suppress swap notes', () => {
  const inGroup = cue => [rows[0], cue, ...rows.slice(1)];
  const inSwapped = cue => [swapped[0], cue, ...swapped.slice(1)];
  for (const [before, after, label] of [
    [[...rows, '\t90 column header Name'], swapped, 'column header before'],
    [rows, [...swapped, '\t90 column header Name'], 'column header after'],
    ...['\t\t90 tab Sort by Name', '\t\t90 tab Order, Secondary Actions: Sort', '\t\t90 tab Ascending', '\t\t90 tab Descending']
      .map(cue => [inGroup(cue), inSwapped(cue), cue])]) {
    for (const code of ['await app.click(78)', 'await app.click(77); await app.click(78)']) {
      assert.doesNotMatch(result(before, after, code), /also swapped/, `${label}: ${code}`);
    }
  }
});

// The 10:25 rerun (2026-10-17): Excel's ribbon carries "menu button Sort & Filter" outside the sheet tabs, and the
// whole-tree sort guard hid the swap note in both excel-edit failures.
test('a sort command elsewhere in the window does not hide a tab swap', () => {
  const before = ['\t5 menu button Sort & Filter', '\t6 group Sheets', '\t\t7 button Inventory', '\t\t8 button Selected, Review 2a37d191'];
  const after = ['\t5 menu button Sort & Filter', '\t6 group Sheets', '\t\t7 button Review 2a37d191', '\t\t8 button Selected, Inventory'];
  assert.match(result(before, after, 'await app.click(7)'), /swapped Inventory and Review 2a37d191;/);
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

test('a changed selected state suppresses a sibling swap despite element renumbering', () => {
  const before = ['\t1 tab bar', '\t\t2 radio button (selected) Description: First, ID: a', '\t\t3 radio button (selectable) Description: Second, ID: b'];
  const after = ['\t5 tab bar', '\t\t6 radio button (selected) Description: Second, ID: b', '\t\t7 radio button (selectable) Description: First, ID: a'];
  assert.doesNotMatch(result(before, after), /clicking also swapped/);
});

test('unchanged selection flags permit a swap with element renumbering', () => {
  const before = ['\t1 tab bar', '\t\t2 radio button (selected) Description: First, ID: a', '\t\t3 radio button (selectable) Description: Second, ID: b'];
  const after = ['\t5 tab bar', '\t\t6 radio button (selectable) Description: Second, ID: b', '\t\t7 radio button (selected) Description: First, ID: a'];
  assert.match(result(before, after), /clicking also swapped First and Second;/);
});

test('a clicked row moving to the top with a changed checked state is not a click swap', () => {
  const before = ['\t1 list', '\t\t2 row (checkable) Alpha', '\t\t3 row (checkable) Beta'];
  const after = ['\t1 list', '\t\t2 row (checked) Beta', '\t\t3 row (checkable) Alpha'];
  assert.doesNotMatch(result(before, after, 'await app.click(3)'), /also swapped/);
});

test('a leaderboard reranked by a typed Value change is not a click swap', () => {
  const before = ['\t1 list', '\t\t2 row Alpha, Value: 10', '\t\t3 row Beta, Value: 9'];
  const after = ['\t1 list', '\t\t2 row Beta, Value: 11', '\t\t3 row Alpha, Value: 10'];
  assert.doesNotMatch(result(before, after, 'await app.click(3); await app.typeText("11")'), /also swapped/);
});

test('a Value change in an unmoved child also suppresses the group swap', () => {
  const before = [...rows, '\t\t79 tab Extra, Value: 1'];
  const after = [...swapped, '\t\t79 tab Extra, Value: 2'];
  assert.doesNotMatch(result(before, after), /also swapped/);
});

for (const label of ['Move Up', 'Down', 'Sort', 'Order', 'Rank']) {
  for (const target of ['90', `{ label: "${label}" }`, `{ id: "${label}" }`]) {
    test(`a reorder control suppresses the swap note: ${label} via ${target}`, () => {
      const control = `\t90 button Description: ${label}, ID: ${label}`;
      assert.doesNotMatch(result([...rows, control], [...swapped, control], `await app.click(${target})`), /also swapped/);
    });
  }
}

test('reorder labels and IDs are checked even when the click names the other attribute', () => {
  for (const [control, target] of [
    ['\t90 button Description: Move Up, ID: action', '{ id: "action" }'],
    ['\t90 button Description: Apply, ID: moveUp', '{ label: "Apply" }'],
  ]) assert.doesNotMatch(result([...rows, control], [...swapped, control], `await app.click(${target})`), /also swapped/);
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
    assert.match(out, /Undo \(Cmd\+Z\) restores the order; a move dialog is the fallback\./);
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
  assert.doesNotMatch(result([...rows, '\t90 column header Name'], [...swapped, '\t90 column header Name'], mixedClick), /also swapped/);
  assert.doesNotMatch(result([rows[0], '\t\t90 tab Sort', ...rows.slice(1)], [swapped[0], '\t\t90 tab Sort', ...swapped.slice(1)], mixedClick), /also swapped/);
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

test('a later save repeats the observed order once after typing and reads in the same session', () => {
  const { c, call } = session();
  call(sheetRows('Inventory', true), 'await app.typeText("more")');
  c.process([text(tree(sheetRows('Inventory', true)))]);
  for (let i = 0; i < 2; i++) {
    const out = call(sheetRows('Inventory', true), 'await app.pressKey("super+s")');
    assert.match(out, /saved:/);
    if (i === 0) assert.match(out, /sleight: tabs now: Review 16f3255b, Inventory\./);
    else assert.doesNotMatch(out, /tabs now:/);
    assert.doesNotMatch(out, /also swapped/);
  }
});

for (const marker of [' — Edited', ' - Edited', ' Edited']) {
  test(`typing and saving across a trailing${marker} marker retains one reminder`, () => {
    const { c } = session();
    const call = (title, code) => c.process([text(GUARD_MARK + tree(sheetRows('Inventory', true))
      .replaceAll('Draft', title) + GUARD_END)], { action: c.beginAction(code) }).map(i => i.text).join('\n');
    call('Draft' + marker, 'await app.typeText("more")');
    assert.match(call('Draft', 'await app.pressKey("super+s")'), /sleight: tabs now: Review 16f3255b, Inventory\./);
    assert.doesNotMatch(call('Draft', 'await app.pressKey("super+s")'), /tabs now:/);
  });
}

test('edited-marker normalization retains distinct document titles, URLs and apps', () => {
  for (const change of [doc => doc.replaceAll('Draft', 'Other — Edited'),
    doc => doc.replace('App: Editor.', 'App: Other.'),
    doc => doc.replace('standard window Draft', 'standard window Draft, URL: file:///tmp/other')]) {
    const { c } = session();
    const out = c.process([text(GUARD_MARK + change(tree(sheetRows('Inventory', true))) + GUARD_END)],
      { action: c.beginAction('await app.pressKey("super+s")') }).map(i => i.text).join('\n');
    assert.doesNotMatch(out, /tabs now:/);
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
