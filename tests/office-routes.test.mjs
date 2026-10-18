import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import * as continuation from '../plugins/sleight/lib/menu-continuation.mjs';

const { splitMenuActions, menuRemainder, continuedNote } = continuation;
const paletteRefusal = (...args) => continuation.paletteRefusal(...args);
import { promptNotice } from '../plugins/sleight/lib/prompt-notice.mjs';

// Reduced lines from the word-edit traces of 2026-10-18 (00-52-36 #5, 01-26-39 #1, 03-17-17 #3, 03-33-15 #1), app and
// paths scrubbed. WB2 replays the Undo item a style shortcut, a gallery pick, Replace All and Insert Table changed; WB1
// replays a sidebar field the typing missed and a gallery that the call's own click opened.
const url = 'file:///tmp/Report-abc.docx';
const CANT = "menu button (disabled) Can't Undo, Help: For more options, press Control-Option-Shift-M.";
const undo = title => `menu button Undo ${title}, Help: For more options, press Control-Option-Shift-M.`;
const doc = ({ undoLine = CANT, search = '', replace = '', body = 'The amber shipment is ready.', focus = 12 } = {}) => [
  'Window: "Report-abc  -  Compatibility Mode", App: Editor.',
  `0 standard window Report-abc  -  Compatibility Mode, Secondary Actions: Raise, URL: ${url}`,
  '\t1 split group',
  '\t\t2 split group',
  '\t\t\t3 Task Pane Sidebar',
  '\t\t\t\t8 tab Description: Find and Replace, Value: 1, ID: sidebar_tab_findAndReplace',
  '\t\t\t\t9 container Find and Replace',
  '\t\t\t\t\t10 container',
  `\t\t\t\t\t\t12 combo box (settable) Description: Search Document${search ? `, Value: ${search}` : ''}, Secondary Actions: Confirm`,
  '\t\t\t\t\t\t\t13 button',
  '\t\t\t\t\t\t14 button Find',
  `\t\t\t\t\t\t15 combo box (settable) Description: Replace With${replace ? `, Value: ${replace}` : ''}, Secondary Actions: Confirm`,
  '\t\t\t\t\t\t\t16 button',
  '\t\t\t\t\t\t17 button Replace',
  '\t\t\t\t\t\t18 button Replace All',
  '\t\t\t25 split group Document Pane',
  `\t\t\t\t28 text entry area (disabled, settable) Description: Page 1 content, Value: **Report abc**\n${body}\nKeep this line abc.`,
  '\t74 container',
  '\t\t75 menu button Styles, Value: 0',
  '\t105 toolbar',
  '\t\t106 container Secondary Actions: Remove from toolbar',
  '\t\t\t109 button Save',
  `\t\t\t110 ${undoLine}`,
  '\t\t\t111 button Repeat Style',
  '123 menu bar',
  '\t126 Edit, ID: EditMenu_MenuItem',
  '\t131 Table',
  '',
  `The focused UI element is ${focus} combo box (settable) Description: Search Document, Secondary Actions: Confirm`,
].join('\n');
const styles = [
  'Window: "Styles", App: Editor.',
  '0 window Styles, Secondary Actions: Raise',
  '\t1 container',
  '\t\t2 container Styles',
  '\t\t\t3 button Description: ¶ Normal, Help: Normal, Value: 1, ID: popover_gallery_UxGalWordQuickFormats_Control_0_0',
  '\t\t\t5 button Description: ¶ Heading 1, Help: Heading 1, Value: 0, ID: popover_gallery_UxGalWordQuickFormats_Control_0_2',
  '20 menu bar',
  '\t23 Edit, ID: EditMenu_MenuItem',
].join('\n');
const insertTable = [
  'Window: "Insert Table", App: Editor.',
  '0 dialog Insert Table, Secondary Actions: Raise',
  '\t2 text field (settable) Description: Number of columns:, Value: 2',
  '\t20 button OK',
].join('\n');
const item = text => ({ type: 'text', text });
const guard = tree => item(GUARD_MARK + tree + GUARD_END);
const UNDO_NOTE = /sleight: the Undo item changed from "([^"]+)" to "([^"]+)"/;

function session(options, first = doc()) {
  const c = createReadCompactor(options);
  c.process([item(first)]);
  return (code, content) => {
    const action = c.beginAction(code);
    return c.process(content, { action, code }).map(part => part.text).join('\n');
  };
}

// WB2 ------------------------------------------------------------------------------------------------------------------

test('WB2: a style shortcut that turned "Can\'t Undo" into "Undo Style" says the app recorded it (03-33-15 #1 call 2)', () => {
  const code = 'let app = __sleightOpenedApp3; await app.pressKey("super+Home"); await app.pressKey("super+alt+1");';
  const out = session({ undoReceipts: true })(code, [guard(doc({ undoLine: undo('Style') }))]);
  const match = UNDO_NOTE.exec(out);
  assert.ok(match, out);
  assert.deepEqual(match.slice(1), ["Can't Undo", 'Undo Style']);
  assert.match(out, /don't open a gallery or pane to confirm it\./);
  assert.equal(out.split('the Undo item changed').length, 2, 'one note');
  assert.doesNotMatch(session()(code, [guard(doc({ undoLine: undo('Style') }))]), /Undo item/, 'off by default');
});

test('WB2: a gallery pick that closed the gallery names "Undo Apply Quick Style" against the document\'s last read (00-52-36 #2 call 3)', () => {
  const call = session({ undoReceipts: true });
  // The call that opened the gallery ends in another window: nothing to compare there.
  assert.doesNotMatch(call('await app.click({ label: "Styles" });', [guard(styles)]), /Undo item/);
  const out = call('await app.click({ id: "popover_gallery_UxGalWordQuickFormats_Control_0_2" });', [guard(doc({ undoLine: undo('Apply Quick Style') }))]);
  assert.deepEqual(UNDO_NOTE.exec(out)?.slice(1), ["Can't Undo", 'Undo Apply Quick Style'], out);
});

test('WB2: OK on Insert Table compares the document with its read before the dialog (00-52-36 #5 call 19)', () => {
  const call = session({ undoReceipts: true }, doc({ undoLine: undo('Replace All') }));
  assert.doesNotMatch(call('await app.click({ label: "Table..." });', [guard(insertTable)]), /Undo item/);
  const out = call('await app.click({ label: "OK" });', [guard(doc({ undoLine: undo('Insert Table') }))]);
  assert.deepEqual(UNDO_NOTE.exec(out)?.slice(1), ['Undo Replace All', 'Undo Insert Table'], out);
});

test('WB2: no note when the Undo item kept its title, went back to "Can\'t Undo", is ambiguous or was never read', () => {
  const typed = 'await app.click(12); await app.typeText("amber"); await app.click(18);';
  // 01-26-39 #1 call 7: Replace All ran on an empty search field, and Undo still read "Undo Style".
  const same = session({ undoReceipts: true }, doc({ undoLine: undo('Style') }));
  assert.doesNotMatch(same(typed, [guard(doc({ undoLine: undo('Style'), replace: 'violet' }))]), /Undo item/);
  const back = session({ undoReceipts: true }, doc({ undoLine: undo('Style') }));
  assert.doesNotMatch(back('await app.pressKey("super+z");', [guard(doc())]), /Undo item/);
  const two = session({ undoReceipts: true });
  const ambiguous = doc({ undoLine: undo('Style') }).replace('\t\t\t111 button Repeat Style', '\t\t\t111 menu item Undo Typing');
  assert.doesNotMatch(two('await app.pressKey("super+alt+1");', [guard(ambiguous)]), /Undo item/);
  const unseen = session({ undoReceipts: true }, doc().replace(`\t\t\t110 ${CANT}\n`, ''));
  assert.doesNotMatch(unseen('await app.pressKey("super+alt+1");', [guard(doc({ undoLine: undo('Style') }))]), /Undo item/);
  // A read with no action says nothing either: the note answers what a call did.
  const read = session({ undoReceipts: true });
  assert.doesNotMatch(read('await app.getAXState();', [guard(doc({ undoLine: undo('Style') }))]), /Undo item/);
});

test('WB2: an Edit-menu item or a toolbar tooltip names the Undo action in any app', () => {
  const editor = (undoLine, title = 'notes.txt') => [`Window: "${title}", App: Editor.`, `0 standard window ${title}, URL: file:///tmp/${title}`,
    '\t1 text area (settable) Value: first', '2 menu bar', '\t3 Edit', '\t\t4 menu', `\t\t\t5 ${undoLine}`].join('\n');
  const menu = session({ undoReceipts: true }, editor('menu item (disabled) Undo'));
  assert.deepEqual(UNDO_NOTE.exec(menu('await app.typeText("x");', [guard(editor('menu item Undo Typing'))]))?.slice(1), ['Undo', 'Undo Typing']);
  const tooltip = session({ undoReceipts: true }, editor('button Description: Undo, Help: Undo'));
  assert.deepEqual(UNDO_NOTE.exec(tooltip('await app.pressKey("Delete");', [guard(editor('button Description: Undo, Help: Undo Delete'))]))?.slice(1),
    ['Undo', 'Undo Delete']);
  // Document text that says "Undo" is no control.
  const text = session({ undoReceipts: true }, editor('text Undo'));
  assert.doesNotMatch(text('await app.typeText("x");', [guard(editor('text Undo Typing'))]), /Undo item/);
});

// Review F2: Cmd+Z moves "Undo Style" back to the older "Undo Typing" and the Redo item gains "Redo Style". That undid an
// edit, so no note claims one was recorded.
const redoLine = title => `menu button ${title}, Help: For more options, press Control-Option-Shift-M.`;
const withRedo = (tree, title) => tree.replace('\t\t\t111 button Repeat Style', `\t\t\t111 ${redoLine(title)}`);
test('WB2 F2: an undo that brings back an older Undo title and fills Redo claims no edit', () => {
  const call = session({ undoReceipts: true }, doc({ undoLine: undo('Typing') }));
  assert.match(call('await app.pressKey("super+alt+1");', [guard(doc({ undoLine: undo('Style') }))]), UNDO_NOTE);
  const out = call('await app.pressKey("super+z");', [guard(withRedo(doc({ undoLine: undo('Typing') }), 'Redo Style'))]);
  assert.doesNotMatch(out, /recorded an edit/, out);
  // Without a Redo item in the tree, a title this window already showed is no proof of a new edit either.
  const bare = session({ undoReceipts: true }, doc({ undoLine: undo('Typing') }).replace('\t\t\t111 button Repeat Style\n', ''));
  bare('await app.pressKey("super+alt+1");', [guard(doc({ undoLine: undo('Style') }).replace('\t\t\t111 button Repeat Style\n', ''))]);
  assert.doesNotMatch(bare('await app.pressKey("super+z");', [guard(doc({ undoLine: undo('Typing') }).replace('\t\t\t111 button Repeat Style\n', ''))]), /recorded an edit/);
  // A Redo item that didn't gain the previous title still allows the note.
  const redo = session({ undoReceipts: true }, withRedo(doc({ undoLine: undo('Style') }), "Can't Redo"));
  assert.match(redo('await app.click(18);', [guard(withRedo(doc({ undoLine: undo('Replace All') }), "Can't Redo"))]), UNDO_NOTE);
});

// Review F3: a page's own "Undo" button (a web mail toast) is document content, not the app's Undo item.
test('WB2 F3: Undo buttons under a web or text area are not the app\'s Undo item', () => {
  const page = toast => ['Window: "Inbox", App: Editor.', '0 standard window Inbox, URL: https://mail.example/inbox',
    '\t1 web area Inbox', `\t\t2 button ${toast}`, '\t\t3 text Message sent'].join('\n');
  const call = session({ undoReceipts: true }, page('Undo Archive'));
  assert.doesNotMatch(call('await app.click({ label: "Send" });', [guard(page('Undo Send'))]), /Undo item/);
});

test('WB2: the lean prompt keeps the note short', () => {
  const note = 'sleight: the Undo item changed from "Can\'t Undo" to "Undo Style", so the app recorded an edit since your last read of this window. Treat that edit as done; don\'t open a gallery or pane to confirm it.';
  const lean = promptNotice(note, 'lean');
  assert.ok(lean.length < note.length * 0.75, lean);
  assert.match(lean, /"Undo Style"/);
  const out = session({ undoReceipts: true, prompt: 'lean' })('await app.pressKey("super+alt+1");', [guard(doc({ undoLine: undo('Style') }))]);
  assert.ok(out.includes(lean), out);
});

// WB1: field typing ----------------------------------------------------------------------------------------------------

const fill = 'let app = __sleightOpenedApp3;\nawait app.click(12);\nawait app.typeText("amber");\nawait app.click(15);\nawait app.typeText("violet");\nawait app.click(18);';

test('WB1: typing that missed the clicked sidebar field names that field and setValue (01-26-39 #1 call 7, 00-52-36 #5 call 7)', () => {
  const after = [guard(doc({ replace: 'violet', focus: 15 }))];
  const out = session({ routeSteering: true })(fill, after);
  assert.match(out, /sleight: the text typed after clicking element 12 \(Search Document\) isn't in that field\./, out);
  assert.match(out, /`setValue\(12, text\)` sets a field without typing\./);
  assert.doesNotMatch(out.split('\n').find(line => line.includes('text typed after')), /amber/, 'typed text stays out of the note');
  assert.doesNotMatch(out, /element 15/, 'the field that got its text is not named');
  assert.doesNotMatch(session()(fill, after), /text typed after clicking/, 'off by default');
});

test('WB1: no field note when every field holds its text, the value is hidden, or the call ended elsewhere', () => {
  assert.doesNotMatch(session({ routeSteering: true })(fill, [guard(doc({ search: 'amber', replace: 'violet' }))]), /text typed after clicking/);
  // Replace All opened its alert: the fields aren't in the last read, so nothing is claimed.
  const alert = 'Window: "", App: Editor.\n0 dialog Description: alert, Secondary Actions: Raise\n\t2 text All done. We made 1 replacement.\n\t3 button OK, ID: action-button--998';
  assert.doesNotMatch(session({ routeSteering: true })(fill, [guard(alert)]), /text typed after clicking/);
  const secure = doc().replace('combo box (settable) Description: Search Document', 'secure text field (settable) Description: Password');
  assert.doesNotMatch(session({ routeSteering: true }, secure)('await app.click(12); await app.typeText("hunter22");', [guard(secure)]), /text typed after clicking/);
  // Typing into the document area after a click is the document's business, not a field's.
  assert.doesNotMatch(session({ routeSteering: true })('await app.click(28); await app.typeText("Item");', [guard(doc())]), /text typed after clicking/);
});

test('WB1: the lean field note is shorter', () => {
  const out = session({ routeSteering: true, prompt: 'lean' })(fill, [guard(doc({ replace: 'violet', focus: 15 }))]);
  assert.match(out, /sleight: typing after clicking element 12 \(Search Document\) missed it; setValue\(12, text\) sets it\./, out);
});

// WB1: gallery opened by the call's own click ---------------------------------------------------------------------------

const galleryCall = 'let app = __sleightOpenedApp3;\nawait app.selectText(28, "Report abc");\nawait app.click({ label: "Styles" });\nawait app.click({ id: "popover_gallery_UxGalWordQuickFormats_Control_0_2" });';
const receipt = { index: 2, prev: { kind: 'label', value: 'Styles' }, root: '0 window Styles, Secondary Actions: Raise', windowStop: true };
const leased = { title: 'Report-abc  -  Compatibility Mode', app: 'Editor', url, appId: 'org.test.editor' };

test('WB1: a gallery window titled like the label the call clicked continues the call (03-17-17 #3 call 5)', () => {
  const plan = splitMenuActions(galleryCall);
  assert.ok(plan);
  assert.equal(menuRemainder(plan, receipt, leased, [item(styles)]), undefined, 'off by default');
  const rest = menuRemainder(plan, receipt, leased, [item(styles)], { palette: true });
  assert.equal(rest?.palette, true);
  assert.equal(rest.code, 'await app.click({ id: "popover_gallery_UxGalWordQuickFormats_Control_0_2" });');
  assert.deepEqual([rest.window.title, rest.window.app], ['Styles', 'Editor']);
  // By ID: the clicked line carries the window's title.
  const byId = splitMenuActions('await app.click({ id: "styles-button" }); await app.click({ id: "popover_gallery_UxGalWordQuickFormats_Control_0_2" });');
  assert.equal(menuRemainder(byId, { ...receipt, index: 1, prev: { kind: 'id', value: 'styles-button', line: 'menu button Styles, Value: 0, ID: styles-button' } },
    leased, [item(styles)], { palette: true })?.palette, true);
});

for (const [name, change] of [
  ['a window titled otherwise', { content: styles.replaceAll('Styles', 'Format Cells') }],
  ['a window with a URL', { content: styles.replace('0 window Styles,', `0 window Styles, URL: ${url},`) }],
  ['another app', { content: styles.replace('App: Editor.', 'App: Other.') }],
  ['a standard window', { content: styles.replace('0 window Styles', '0 standard window Styles'), root: '0 standard window Styles, Secondary Actions: Raise' }],
  ['a sheet', { content: styles.replace('0 window Styles', '0 sheet Styles'), root: '0 sheet Styles, Secondary Actions: Raise' }],
  ['a document area in the window', { content: styles + '\n\t\t30 text area (settable) Value: notes' }],
  ['a numbered click', { prev: { kind: 'number', value: 75 } }],
  ['a key', { prev: { kind: 'key', value: 'super+alt+1' } }],
  ['an ID click on a line without that title', { prev: { kind: 'id', value: 'other', line: 'button Other, ID: other' } }],
  ['a receipt for another root', { root: '0 window Other' }],
]) test(`WB1: the gallery continuation refuses ${name}`, () => {
  const plan = splitMenuActions(galleryCall);
  const r = { ...receipt, ...(change.prev ? { prev: change.prev } : {}), ...(change.root ? { root: change.root } : {}) };
  assert.equal(menuRemainder(plan, r, leased, [item(change.content ?? styles)], { palette: true })?.palette, undefined);
});

// Review F1: a "Sign In" or "Share" button can open a window with a password field, and typing after the click would land
// there. Only label or ID clicks may follow, and a window holding a secure field never takes the rest.
test('WB1 F1: the gallery continuation takes only label or ID clicks, and never a window with a secure field', () => {
  const signIn = 'Window: "Sign In", App: Editor.\n0 window Sign In, Secondary Actions: Raise\n\t1 text field (settable) Description: Email\n\t2 button Next, ID: next';
  const signInReceipt = { ...receipt, index: 1, prev: { kind: 'label', value: 'Sign In' }, root: '0 window Sign In, Secondary Actions: Raise' };
  for (const rest of ['await app.typeText("me@example.com");', 'await app.pressKey("Return");', 'await app.click(2);',
    'await app.click({ id: "next" }); await app.typeText("secret");', 'await app.setValue(1, "me@example.com");', 'await app.click([20, 40]);']) {
    const plan = splitMenuActions(`await app.click({ label: "Sign In" }); ${rest}`);
    assert.equal(menuRemainder(plan, signInReceipt, leased, [item(signIn)], { palette: true })?.palette, undefined, rest);
  }
  const clicks = splitMenuActions('await app.click({ label: "Sign In" }); await app.click({ id: "next" }); await app.click("Next");');
  assert.equal(menuRemainder(clicks, signInReceipt, leased, [item(signIn)], { palette: true })?.palette, true);
  const secure = signIn.replace('text field (settable) Description: Email', 'secure text field (settable) Description: Password');
  assert.equal(menuRemainder(clicks, signInReceipt, leased, [item(secure)], { palette: true })?.palette, undefined);
});

test('WB1 F1: a palette whose native subrole is a dialog, system dialog or sheet is refused', () => {
  const baseline = { status: 'ok', matches: 1, headerMatches: 1, epoch: 'helper', window: 1, windowNumber: 22, pid: 123, processStart: 1, hidIdleSeconds: 1000 };
  const expected = { appId: 'org.test.editor', title: 'Styles', url: null };
  const observed = { ...baseline, ...expected, window: 2, windowNumber: 31 };
  for (const subrole of ['AXDialog', 'AXSystemDialog', 'AXSheet']) {
    assert.equal(paletteRefusal(expected, baseline, { ...observed, windowSubrole: subrole }, performance.now() - 100), 'dialog-subrole', subrole);
  }
  for (const subrole of [null, 'AXFloatingWindow', 'AXStandardWindow']) {
    assert.equal(paletteRefusal(expected, baseline, { ...observed, windowSubrole: subrole }, performance.now() - 100), undefined, String(subrole));
  }
});

test('WB1: the gallery must be the focused window of the same process, idle since the call, and not the leased window', () => {
  const baseline = { status: 'ok', matches: 1, headerMatches: 1, epoch: 'helper', window: 1, windowNumber: 22, pid: 123, processStart: 1, hidIdleSeconds: 1000 };
  const expected = { appId: 'org.test.editor', title: 'Styles', url: null };
  const observed = { ...baseline, ...expected, window: 2, windowNumber: 31 };
  const since = performance.now() - 100;
  assert.equal(paletteRefusal(expected, baseline, observed, since), undefined);
  for (const [change, reason] of [[{ windowNumber: 22 }, 'same-window'], [{ windowNumber: null }, 'no-window-number'],
    [{ hidIdleSeconds: 0.01 }, 'hid-input'], [{ pid: 999 }, 'process-changed'], [{ epoch: 'other' }, 'process-changed'],
    [{ processStart: 2 }, 'process-changed'], [{ headerMatches: 2 }, 'header-matches-2'], [{ status: 'mismatch' }, 'identity-mismatch'],
    [{ title: 'Other' }, 'identity-mismatch'], [{ url: url }, 'identity-mismatch']]) {
    assert.equal(paletteRefusal(expected, baseline, { ...observed, ...change }, since), reason, JSON.stringify(change));
  }
  assert.equal(paletteRefusal(expected, undefined, observed, since), 'no-baseline');
  assert.equal(paletteRefusal(expected, baseline, undefined, since), 'identity-unavailable');
});

test('WB1: the continued call says the click opened a panel', () => {
  const plan = splitMenuActions(galleryCall);
  assert.equal(continuedNote(plan, 2, 'palette', { title: 'Styles' }),
    'sleight: all 3 actions ran: selectText, click opened a panel, then click in "Styles".');
});
