import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

// Reduced exact lines from excel-edit 2026-10-17T23-30-19 (call 3 and 4) and 2026-10-18T00-04-33 r5 (call 2).
const url = 'file:///tmp/Inventory-bc704cec.xlsx';
const doc = (nameBox = 'A1', cell = 'A,1 Item', focus = '0 standard window Inventory-bc704cec') => [
  `Window: "Inventory-bc704cec", App: Editor.`,
  `0 standard window Inventory-bc704cec, Secondary Actions: Raise, URL: ${url}`,
  '\t1 split group',
  '\t\t2 container',
  '\t\t\t4 layout area Content Area, Description: Workbook area, Inventory, Sheet 1 of 1, Used range: A1 to B4, Help: The content area of the window',
  '\t\t\t\t7 button Selected, Inventory, , Used range: A1 to B4, Description: Inventory, Help: Press to make this sheet active',
  '\t\t\t\t8 button Insert sheet, , ID: addBlankSheetButton',
  `\t78 combo box (settable) Description: name box, Help: Name Box, Value: ${nameBox}, ID: NameBox, Secondary Actions: Confirm`,
  '\t\t79 button',
  `\t81 text entry area Description: Formula Bar. ${cell}, ID: XLFormulaEditor`,
  '110 menu bar',
  '\t111 Edit, ID: EditMenu_MenuItem',
  '',
  `The focused UI element is ${focus}`,
].join('\n');
const alert = [
  'Window: "", App: Editor.',
  '0 dialog Description: alert, Secondary Actions: Raise',
  '\t1 image Editor alert',
  "\t2 text The data you're pasting isn't the same size as your selection. Do you want to paste anyway?",
  '\t3 button Cancel, ID: action-button--999',
  '\t4 button OK, ID: action-button--998',
  '5 menu bar',
  '\t6 Edit, ID: EditMenu_MenuItem',
  '',
  'The focused UI element is 0 dialog Description: alert, Secondary Actions: Raise',
].join('\n');
const item = text => ({ type: 'text', text });
const guard = tree => item(GUARD_MARK + tree + GUARD_END);
const moved = 'sleight: this call acted on "Inventory-bc704cec" in Editor. The window it shows now is "" in Editor.';
const pasteTwice = 'let app = __sleightOpenedApp3;\nawait app.setValue({ id: "NameBox" }, "A2");\nawait app.pressKey("Return");\n' +
  'await app.paste("Apples\\t8\\nBananas\\t5\\nPears\\t3", { format: "text" });\nawait app.setValue({ id: "NameBox" }, "D1");\n' +
  'await app.pressKey("Return");\nawait app.paste("Budget\\n11\\n4\\n=SUM(D2:D3)", { format: "text" });';
const note = 'sleight: setValue on 78 (name box) didn\'t hold (Value: A1); the next action began at A1. Undo restores. Click the field, type, Return.';

function session(options) {
  const c = createReadCompactor(options);
  c.process([item(doc())]);
  return (code, content) => {
    const action = c.beginAction(code);
    return c.process(content, { action, code }).map(part => part.text).join('\n');
  };
}

test('r5: a name box that kept A1 after setValue, Return and a paste gets the note in the same result', () => {
  const call = session();
  const out = call('let app = __sleightOpenedApp3;\nawait app.setValue({ id: "NameBox" }, "A2");\nawait app.pressKey("Return");\nawait app.paste("Apples\\t8\\nBananas\\t5\\nPears\\t3", { format: "text" });\n',
    [guard(doc('A1', 'A,1 Apples'))]);
  assert.ok(out.includes(note), out);
  assert.equal(out.split("didn't hold").length, 2);
});

test('23-30: a call that ends on an alert quotes it, and the note follows when the document returns', () => {
  const call = session();
  const third = call(pasteTwice, [guard(doc()), item(''), guard(alert), item(moved)]);
  assert.ok(third.includes(`sleight: the alert says "The data you're pasting isn't the same size as your selection. Do you want to paste anyway?" Its buttons: Cancel ({ id: "action-button--999" }), OK ({ id: "action-button--998" }).`), third);
  assert.doesNotMatch(third, /didn't hold/);
  const fourth = call('let app = __sleightOpenedApp3;\nawait app.click({ id: "action-button--999" });', [guard(doc('A1', 'A,1 Apples')), item(moved)]);
  assert.ok(fourth.includes(note), fourth);
  assert.doesNotMatch(fourth, /alert says/);
  // Reported once.
  assert.doesNotMatch(call('await app.getAXState();', [item(doc('A1', 'A,1 Apples'))]), /didn't hold/);
});

test('the lean prompt shortens both notes', () => {
  const call = session({ prompt: 'lean' });
  const third = call(pasteTwice, [guard(doc()), guard(alert), item(moved)]);
  assert.match(third, /^sleight: alert "The data you're pasting[^"]*" buttons: Cancel \(\{ id: "action-button--999" \}\), OK/m);
  const fourth = call('await app.click({ id: "action-button--999" });', [guard(doc('A1', 'A,1 Apples'))]);
  assert.match(fourth, /^sleight: setValue 78 \(name box\) reverted to A1; input went to A1\. Click it, type, Return\.$/m);
});

test('a focused element other than the window and the field names where the input went', () => {
  const call = session();
  const out = call('await app.setValue(78, "A2"); await app.pressKey("Return");',
    [guard(doc('A1', 'A,1 Item', '81 text entry area Description: Formula Bar. A,1 Item, ID: XLFormulaEditor'))]);
  assert.match(out, /setValue on 78 \(name box\) didn't hold \(Value: A1\); the next action began at Formula Bar\. A,1 Item\. Click the field, type, Return\./);
  assert.doesNotMatch(out, /Undo restores/, 'only a paste has something to undo');
});

test('no note when the value held, the field was empty, nothing followed, input stopped, or the call acted there again', () => {
  for (const [code, after, extra] of [
    ['await app.setValue({ id: "NameBox" }, "A2"); await app.pressKey("Return");', doc('A2', 'A,2 Pears')],
    ['await app.setValue({ id: "NameBox" }, "a1"); await app.pressKey("Return");', doc('A1')],
    ['await app.setValue({ id: "NameBox" }, "A2");', doc('A1')],
    ['await app.setValue({ id: "NameBox" }, someCell); await app.pressKey("Return");', doc('A1')],
    ['await app.setValue({ id: "addBlankSheetButton" }, "A2"); await app.pressKey("Return");', doc('A1')],
    ['await app.setValue({ id: "NameBox" }, "A2"); await app.pressKey("Return");', doc('A1'), 'sleight: an action in this call failed: timeout'],
    ['await app.setValue({ id: "NameBox" }, "A2"); await app.pressKey("Return");', doc('A1'), 'Input lease stopped this action: window or URL changed. Read the intended window again before acting.'],
  ]) {
    const call = session();
    assert.doesNotMatch(call(code, [guard(after), ...(extra ? [item(extra)] : [])]), /didn't hold/, code);
  }
  // An empty field that stays empty, such as a message box that sent and cleared.
  const c = createReadCompactor();
  c.process([item(doc().replace('Value: A1, ', ''))]);
  const code = 'await app.setValue({ id: "NameBox" }, "hello"); await app.pressKey("Return");';
  assert.doesNotMatch(c.process([guard(doc().replace('Value: A1, ', ''))], { action: c.beginAction(code), code }).map(p => p.text).join('\n'), /didn't hold/);
  // After the alert, a call that acts in the document itself owns the value.
  const call = session();
  call(pasteTwice, [guard(doc()), guard(alert), item(moved)]);
  call('await app.click({ id: "action-button--999" });', [guard(alert)]);
  call('await app.getAXState();', [item(doc('A1', 'A,1 Apples') + '\n…(20)')]);
  assert.doesNotMatch(call('await app.click({ id: "addBlankSheetButton" });', [guard(doc('A1', 'A,1 Apples'))]), /didn't hold/);
});

test('an alert note needs a small dialog with text and buttons, new in this call', () => {
  const sheet = alert.replace('0 dialog Description: alert', '0 sheet Save').replace('\t4 button OK', '\t4 text field (settable) Description: Save As:, Value: Untitled\n\t9 button OK');
  for (const tree of [sheet, alert.replace(/\t2 text [^\n]*\n/, ''), alert.replace(/\t[34] button [^\n]*\n/g, '')]) {
    const call = session();
    assert.doesNotMatch(call('await app.pressKey("super+v");', [guard(tree)]), /alert says/, tree);
  }
  const call = session();
  call('await app.pressKey("super+v");', [guard(alert)]);
  assert.doesNotMatch(call('await app.pressKey("Tab");', [guard(alert)]), /alert says/, 'the alert was already there');
});
