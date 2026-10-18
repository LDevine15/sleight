// excel-edit-8 (00:44 focused pass, 2026-10-18): click(7) on the Inventory tab swapped the sheet tabs. The call printed
// only the first 3 lines of its own read after the engine's full tree, that partial counted as the last read, and
// neither the swap note nor any reminder at the save came. The file saved with the wrong order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const text = value => ({ type: 'text', text: value });
const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const tab = (name, selected) => `button ${selected ? 'Selected, ' : ''}${name}, , ${name === 'Inventory' ? 'Used range: A1 to D4' : 'Blank sheet'}, ` +
  `Description: ${name}, Help: Press to make this sheet active`;
// The L31, L38 and L45 trees, cut to the tab strip, part of the ribbon and the menu bar.
function workbook(url, order, selected) {
  return ['Window: "Inventory-94d4d178", App: Microsoft Excel.',
    `0 standard window Inventory-94d4d178, Secondary Actions: Raise, URL: ${url}`,
    '\t1 split group', '\t\t2 container',
    '\t\t\t3 button Description: Copilot Chat, Help: Copilot Chat (⌃⌘I), Secondary Actions: Expand',
    `\t\t\t4 layout area Content Area, Description: Workbook area, ${selected}, Sheet 2 of 2, Help: The content area of the window`,
    '\t\t\t\t5 button Navigate sheet tab view to the left, , ID: leftButton',
    '\t\t\t\t6 button Navigate sheet tab view to the right, , ID: rightButton',
    ...order.map((name, i) => `\t\t\t\t${i + 7} ${tab(name, name === selected)}`),
    `\t\t\t\t${order.length + 7} button Insert sheet, , ID: addBlankSheetButton`,
    '\t\t10 splitter (disabled, settable, float) 1512',
    '\t11 tab group Description: ribbon, Details: Home', '\t\t12 scroll area Home Tab Commands', '\t\t\t13 container',
    '\t\t\t\t14 menu button Paste, Help: For more options, press Control-Option-Shift-M.', '\t\t\t\t15 button Cut',
    '\t\t\t\t16 toggle button Bold, Value: off', '\t\t\t\t17 toggle button Italic, Value: off',
    '\t18 toolbar', '\t\t19 button Save', '\t\t20 button Save As',
    '21 menu bar', '\t22 Excel, ID: AppMenu_MenuItem', '\t23 File', '\t24 Edit, ID: EditMenu_MenuItem', '\t25 Window, ID: WindowMenu_MenuItem',
    '', `The focused UI element is 4 layout area Content Area, Description: Workbook area, ${selected}, Sheet 2 of 2`].join('\n');
}
const REVIEW = 'Review 94d4d178';
const SWITCH = 'await app.click(7);\nconst s = await app.getAXStateAndScreenshot();\nnodeRepl.write(s.state.split("\\n").slice(0,3).join("\\n"));\nawait nodeRepl.emitImage(s.screenshot);';
const SAVE = 'await app.pressKey("super+s");\nawait app.getAXState();';
const SAVE_LINE = `sleight: tab order changed since you opened it (now: ${REVIEW}, Inventory; was: Inventory, ${REVIEW}) after a click on Inventory; Cmd+Z restores before saving again.`;

function session(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-taborder-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'Inventory-94d4d178.xlsx');
  writeFileSync(file, 'before'); utimesSync(file, 1000, 1000);
  const url = pathToFileURL(file).href, c = createReadCompactor();
  const tree = (order, selected) => workbook(url, order, selected);
  const call = (code, content, { written = false } = {}) => {
    const action = c.beginAction(code);
    if (written) { writeFileSync(file, 'after'); utimesSync(file, 2000, 2000); }
    return c.process(content, { action, code }).map(item => item.text ?? '').join('\n');
  };
  const save = order => call(SAVE, [text(GUARD_MARK + tree(order, 'Inventory') + GUARD_END)], { written: true });
  // L31: the rename's result, the last complete read before the click.
  c.process([text(tree(['Inventory', REVIEW], REVIEW))]);
  return { c, tree, call, save };
}
// L38: the engine's own tree for getAXStateAndScreenshot, then the call's 3 printed lines and the image.
const switched = tree => {
  const full = tree([REVIEW, 'Inventory'], 'Inventory');
  return [text(full), text(full.split('\n').slice(0, 3).join('\n')), image];
};

test('the swap a tab click caused is reported although the call printed a partial tree last', t => {
  const { tree, call } = session(t);
  const out = call(SWITCH, switched(tree));
  assert.match(out, /sleight: clicking also swapped Inventory and Review 94d4d178; tabs now: .*Review 94d4d178, Inventory, Insert sheet; if that wasn't intended, Undo \(Cmd\+Z\) restores the order/);
});

test('a click whose only read is degraded still arms the moved-click reminder for the next complete read', t => {
  const { tree, call, c } = session(t);
  // Only the partial: no complete tree in this result at all.
  const partial = tree([REVIEW, 'Inventory'], 'Inventory').split('\n').slice(0, 3).join('\n');
  const first = call(SWITCH, [text(partial), image]);
  assert.match(first, /UI unverified \(degraded read\)/);
  assert.doesNotMatch(first, /moved it from|swapped/);
  const later = c.process([text(tree([REVIEW, 'Inventory'], 'Inventory'))]).map(item => item.text).join('\n');
  assert.match(later, /sleight: the click on Inventory moved it from position 3 to 4; if that wasn't intended, Undo \(Cmd\+Z\) restores the order/);
});

test('the save after a missed tab move says the order changed since the document was opened', t => {
  const { call, save } = session(t);
  // A switch whose result held no read; the move first shows in the save's own read (L45).
  call('await app.click(7);', [text('done')]);
  const out = save([REVIEW, 'Inventory']);
  assert.match(out, /saved: observed "file:/);
  assert.ok(out.includes(SAVE_LINE), out);
  assert.equal(out.match(/tab order changed/g).length, 1);
});

test('the L36 to L45 replay ends with the save line instead of a bare order reminder', t => {
  const { tree, call, save } = session(t);
  call(SWITCH, switched(tree));
  const out = save([REVIEW, 'Inventory']);
  assert.ok(out.includes(SAVE_LINE), out);
  assert.doesNotMatch(out, /^sleight: tabs now:/m);
  // Saving again with the same order adds nothing more.
  assert.doesNotMatch(save([REVIEW, 'Inventory']), /tab order changed/);
});

test('an intentional reorder through a menu gets no save line, even after an earlier tab switch', t => {
  const { tree, call, save } = session(t);
  // A plain switch to Review that moved nothing, then Move or Copy from the Edit menu.
  call('await app.click(8);', [text(GUARD_MARK + tree(['Inventory', REVIEW], REVIEW) + GUARD_END)]);
  call('await app.click(24);', [text(GUARD_MARK + tree(['Inventory', REVIEW], REVIEW) + GUARD_END)]);
  call('await app.pressKey("Return");', [text(GUARD_MARK + tree([REVIEW, 'Inventory'], 'Inventory') + GUARD_END)]);
  const out = save([REVIEW, 'Inventory']);
  assert.match(out, /saved: observed/);
  assert.doesNotMatch(out, /tab order changed/);
});

test('a save with the opening order, or a tab click that moved nothing, gets no save line', t => {
  const { tree, call, save } = session(t);
  call('await app.click(8);', [text(GUARD_MARK + tree(['Inventory', REVIEW], REVIEW) + GUARD_END)]);
  assert.doesNotMatch(save(['Inventory', REVIEW]), /tab order changed/);
});
