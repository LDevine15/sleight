// Shapes from the 2026-10-17 claim run (textedit-save-4, excel-edit 1, 2, 3 and 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createReadCompactor, GUARD_MARK, GUARD_END, GUARD_OMIT_MARK } from '../plugins/sleight/lib/compact-reads.mjs';
import { guardedCode, menuRoot, readCode } from '../plugins/sleight/lib/document-scope.mjs';
import { createRelay, dropStaleMenuNotes, closedMenuContent, pasteHereNote, fileListing } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const text = value => ({ type: 'text', text: value });
const document = (title, url, rows = ['\t1 text entry area (settable) Value: fixture, ID: First Text View']) =>
  [`Window: ${JSON.stringify(title)}, App: TextEdit.`, `0 standard window ${title}, Secondary Actions: Raise${url ? ', URL: ' + url : ''}`,
    ...rows, '2 menu bar', '\t3 File', '\t4 Format'].join('\n');
const formatMenu = title => [`Window: ${JSON.stringify(title)}, App: TextEdit.`, '0 Format, Secondary Actions: Cancel, Pick',
  '\t1 menu Secondary Actions: Cancel', '\t\t2 Font', '\t\t3 Make Rich Text'].join('\n');

test('a menu root is the menu or its named parent over an unnamed menu, never the menu bar', () => {
  assert.equal(menuRoot(formatMenu('a.txt')), true);
  assert.equal(menuRoot('Window: "", App: Finder.\n0 menu Secondary Actions: Cancel\n\t1 menu item Copy'), true);
  for (const tree of [document('a.txt', 'file:///tmp/a.txt'), 'Window: "x", App: X.\n0 menu bar\n\t1 Edit',
    'Window: "x", App: X.\n0 Format, Secondary Actions: Cancel, Pick\n\t1 button OK', undefined]) assert.equal(menuRoot(tree), false);
});

// excel-edit-5: ten menu items shared the ID oui_performOfficeSpaceMenuAction:, so the label has to pick one.
async function locate(spec, extra = []) {
  const items = ['Insert...', 'Delete', 'Rename', 'Move or Copy...', 'View Code'];
  const tree = ['Window: "Book", App: Microsoft Excel.', '0 menu Secondary Actions: Cancel',
    ...items.map((label, i) => `\t${i + 1} ${label}, ID: oui_performOfficeSpaceMenuAction:`), '\t6 Rename, ID: renameOther', ...extra].join('\n');
  const clicked = [];
  const raw = { getAXState: async () => tree, click: async n => { clicked.push(n); } };
  const context = { cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  const run = code => runInNewContext(`(async () => { ${code} })()`, context);
  await run(readCode('await cua.getApp("Microsoft Excel");'));
  await run(guardedCode(`await app.click(${JSON.stringify(spec)});`, { title: 'Book', app: 'Microsoft Excel', url: null }));
  return clicked;
}

test('a locator with both id and label clicks the one element that has both', async () => {
  assert.deepEqual(await locate({ id: 'oui_performOfficeSpaceMenuAction:', label: 'Rename' }), [3]);
  await assert.rejects(locate({ id: 'oui_performOfficeSpaceMenuAction:' }), /5 elements with ID/);
  await assert.rejects(locate({ label: 'Rename' }), /2 elements with label/);
  await assert.rejects(locate({ id: 'oui_performOfficeSpaceMenuAction:', label: 'Paste' }),
    /no element with ID "oui_performOfficeSpaceMenuAction:" and label "Paste"/);
});

test('a locator with both id and label never falls back to a bare line, which has no ID', async () => {
  const bare = ['\t7 menu item Rename'];
  await assert.rejects(locate({ id: 'wrongId', label: 'Rename' }, bare), /no element with ID "wrongId" and label "Rename"/);
  assert.deepEqual(await locate({ id: 'renameOther', label: 'Rename' }, bare), [6]);
});

// textedit-save-4: the read before Cmd+S was an open Format menu, and the save note said "no earlier read".
// otherFile: the read after the save shows b.txt, whose file is also written. firstApp: the only standard-window
// read before the menu belongs to another app.
function saveAfterMenu(t, { write = true, title = 'a.txt', otherFile = false, firstApp = 'TextEdit', code } = {}) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-menusave-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'a.txt'), other = join(dir, 'b.txt');
  for (const path of [file, other]) { writeFileSync(path, 'before'); utimesSync(path, 1000, 1000); }
  const url = pathToFileURL(file).href;
  const c = createReadCompactor();
  c.process([text(document('a.txt', url).replace('App: TextEdit.', `App: ${firstApp}.`))]);
  // The menu read is an action's result, which leaves no baseline behind it.
  const open = c.beginAction('await app.click({ label: "Format" })');
  c.process([text(GUARD_MARK + formatMenu('a.txt') + GUARD_END)], { action: open });
  const action = c.beginAction(code ?? 'await app.performSecondaryAction(1, "Cancel"); await app.pressKey("super+s"); await app.getAXState();');
  assert.equal(action.before, undefined);
  for (const path of write ? [file, ...otherFile ? [other] : []] : []) { writeFileSync(path, 'after'); utimesSync(path, 2000, 2000); }
  const after = document(title, otherFile ? pathToFileURL(other).href : url);
  return c.process([text(GUARD_MARK + after + GUARD_END)], { action }).map(item => item.text).join('\n');
}

test('a save after a menu read is confirmed from the same document\'s file changing during the call', t => {
  assert.match(saveAfterMenu(t), /saved: observed "file:.*a\.txt" \(its file on disk changed during this call\)/);
  assert.match(saveAfterMenu(t, { code: 'await app.click({ label: "Save" }); await app.getAXState();' }), /saved: observed "file:.*a\.txt"/);
  assert.match(saveAfterMenu(t, { title: 'a.txt — Edited' }), /saved: observed/, 'an Edited marker on the title is the same document');
  assert.match(saveAfterMenu(t, { code: 'await app.click({ id: "saveMenuItem", label: "Save" }); await app.getAXState();' }), /saved: observed "file:.*a\.txt"/,
    'a save given by { id, label } counts like the label form');
});

test('a save after a menu read stays unconfirmed when the file did not change or the document differs', t => {
  assert.match(saveAfterMenu(t, { write: false }), /saved: not confirmed \(no earlier read\)/);
  assert.match(saveAfterMenu(t, { otherFile: true }), /saved: not confirmed \(no earlier read\)/);
  assert.match(saveAfterMenu(t, { title: 'b.txt' }), /saved: not confirmed \(no earlier read\)/);
  assert.match(saveAfterMenu(t, { firstApp: 'Preview' }), /saved: not confirmed \(no earlier read\)/,
    'another app\'s read of the same file is not this window\'s baseline');
});

const tabs = (order, selected) => ['Window: "Inventory-1", App: Microsoft Excel.', '0 standard window Inventory-1, URL: file:///tmp/Inventory-1.xlsx',
  '\t1 layout area Content Area', '\t\t2 button Navigate sheet tab view to the left, , ID: leftButton',
  ...order.map((name, i) => `\t\t${i + 3} button ${name === selected ? 'Selected, ' : ''}${name}, , Description: ${name}, Help: Press to make this sheet active`),
  `\t\t${order.length + 3} button Insert sheet, , ID: addBlankSheetButton`,
  `\t${order.length + 4} combo box (settable) Description: name box, Value: A1, ID: NameBox`].join('\n');

// excel-edit-2: click(4) on the Inventory tab plus a Name Box click swapped the tabs, and no note came.
test('a click that moved its sibling is reported when the call has other clicks too', () => {
  for (const code of [
    'await app.click(3); await app.click({ id: "NameBox" }); await app.typeText("D4"); await app.pressKey("Return"); await app.pressKey("F9");',
    'await app.click({ id: "NameBox" }); await app.click({ label: "Inventory" }); await app.pressKey("F9");',
  ]) {
    const c = createReadCompactor();
    c.process([text(tabs(['Inventory', 'Review'], 'Review'))]);
    const action = c.beginAction(code);
    const out = c.process([text(GUARD_MARK + tabs(['Review', 'Inventory'], 'Inventory') + GUARD_END)], { action }).map(item => item.text).join('\n');
    assert.match(out, /sleight: the click on Inventory moved it from position 2 to 3; if that wasn't intended, Undo \(Cmd\+Z\) restores the order; a move dialog is the fallback\. To switch tabs, use the app's next\/previous-tab key or go-to control, not a click\./, code);
    assert.equal(out.match(/moved it from/g).length, 1);
  }
});

// Sheet tabs that share one ID, as Excel's menu items did in excel-edit-5.
test('a click given by { id, label } on a shared ID still gets its moved-click note', () => {
  const shared = (order, selected) => tabs(order, selected).replace(/, Help: Press to make this sheet active/g, ', ID: sheetTab');
  const c = createReadCompactor();
  c.process([text(shared(['Inventory', 'Review', 'Notes'], 'Review'))]);
  const action = c.beginAction('await app.click({ id: "sheetTab", label: "Inventory" }); await app.click({ id: "NameBox" });');
  const out = c.process([text(GUARD_MARK + shared(['Review', 'Notes', 'Inventory'], 'Inventory') + GUARD_END)], { action }).map(item => item.text).join('\n');
  assert.match(out, /the click on Inventory moved it from position 2 to 4/);
});

test('a click whose target stayed put is not blamed for a sibling another click moved', () => {
  const c = createReadCompactor();
  c.process([text(tabs(['Inventory', 'Review', 'Notes'], 'Review'))]);
  // The clicked tab (Notes) stays last; Inventory and Review trade places around it.
  const action = c.beginAction('await app.click(5); await app.click({ id: "NameBox" }); await app.pressKey("F9");');
  const out = c.process([text(GUARD_MARK + tabs(['Review', 'Inventory', 'Notes'], 'Notes') + GUARD_END)], { action }).map(item => item.text).join('\n');
  assert.doesNotMatch(out, /moved it from/);
});

test('the swap note points to Undo first', () => {
  const c = createReadCompactor();
  c.process([text(tabs(['Inventory', 'Review'], 'Review'))]);
  const action = c.beginAction('await app.click(3)');
  const out = c.process([text(GUARD_MARK + tabs(['Review', 'Inventory'], 'Inventory') + GUARD_END)], { action }).map(item => item.text).join('\n');
  assert.match(out, /clicking also swapped Inventory and Review; .*; if that wasn't intended, Undo \(Cmd\+Z\) restores the order; a move dialog is the fallback\. To switch tabs, use the app's next\/previous-tab key or go-to control, not a click\./);
});

const MENU_NOTE = 'sleight: a menu is open (element 1). Escape doesn\'t always close a menu in a background app; `await app.performSecondaryAction(1, "Cancel")` does.';

test('a menu note from earlier in a call goes when the call\'s last tree shows no menu', () => {
  const head = [text(formatMenu('a.txt')), text(MENU_NOTE)];
  const closed = [text(document('a.txt', 'file:///tmp/a.txt') + '\nsleight: UI unverified (no earlier read).')];
  assert.deepEqual(dropStaleMenuNotes(head, closed), [head[0]]);
  const merged = [text(formatMenu('a.txt') + '\n\n' + MENU_NOTE + '\n' + document('a.txt', 'file:///tmp/a.txt'))];
  assert.doesNotMatch(dropStaleMenuNotes(merged, closed)[0].text, /a menu is open/);
  for (const rest of [[text(formatMenu('a.txt'))], [text('Window: "a.txt", App: TextEdit.\n0 Format, Secondary Actions: Cancel, Pick\nsleight: no change since the last full tree you saw for this window.')],
    [text('sleight: call failed (no input was sent).')], []]) assert.equal(dropStaleMenuNotes(head, rest), head);
});

test('a menu note stays when the last tree is another window or not a full tree', () => {
  const head = [text(formatMenu('a.txt')), text(MENU_NOTE)];
  assert.equal(dropStaleMenuNotes(head, [text(document('b.txt', 'file:///tmp/b.txt'))]), head, 'another window');
  const diff = [`Window: "a.txt", App: TextEdit.`, '0 standard window a.txt, Secondary Actions: Raise, URL: file:///tmp/a.txt',
    'sleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):',
    '+ \t5 button Done'].join('\n');
  assert.equal(dropStaleMenuNotes(head, [text(diff)]), head, 'a diff');
  // Two windows in the head: only the note from the window the last tree shows goes.
  const both = [text(formatMenu('b.txt')), text(MENU_NOTE), text(formatMenu('a.txt') + '\n' + MENU_NOTE)];
  assert.deepEqual(dropStaleMenuNotes(both, [text(document('a.txt', 'file:///tmp/a.txt'))]), [both[0], both[1], text(formatMenu('a.txt'))]);
});

// The menu-bar variant: a selected menu-bar item and no menu element.
test('a stuck-menu note goes when the same window\'s last full tree shows no selected menu-bar item', () => {
  const stuck = document('a.txt', 'file:///tmp/a.txt').replace('\t3 File', '\t3 File (selected)');
  const note = 'sleight: a menu may be stuck open; keys and clicks may not reach the document. Try one Escape; if it stays, click its menu-bar item by number (`app.click(3)`); if it still stays, tell the user.';
  const head = [text(stuck), text(note)];
  assert.deepEqual(dropStaleMenuNotes(head, [text(document('a.txt', 'file:///tmp/a.txt'))]), [head[0]]);
  assert.equal(dropStaleMenuNotes(head, [text(stuck)]), head, 'still selected');
  assert.equal(dropStaleMenuNotes(head, [text(document('b.txt', 'file:///tmp/b.txt'))]), head, 'another window');
});

// word-edit-1, transcript line 70 (2026-10-17): clicking a submenu header closed the menu, and the call's last
// tree added a selected menu-bar item under a document root.
test('an "is open" note goes when the last tree adds a selected menu-bar item and shows no menu', () => {
  const stuckNote = 'sleight: a menu may be stuck open; keys and clicks may not reach the document. Try one Escape; if it stays, click its menu-bar item by number (`app.click(132)`); if it still stays, tell the user.';
  const head = [text(formatMenu('a.txt')), text(''), text(MENU_NOTE)];
  const diff = ['insert submenu opened', 'Window: "a.txt", App: TextEdit.', '0 standard window a.txt, Secondary Actions: Raise, URL: file:///tmp/a.txt',
    'sleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):',
    '- \tTable', '+ \t132 (selected) Table'].join('\n');
  assert.deepEqual(dropStaleMenuNotes(head, [text(diff), text(stuckNote)]), [head[0], head[1]], 'the diff');
  const whole = document('a.txt', 'file:///tmp/a.txt').replace('\t4 Format', '\t132 (selected) Table');
  assert.deepEqual(dropStaleMenuNotes(head, [text(whole)]), [head[0], head[1]], 'the whole tree');
  // The stuck note itself stays, and a diff that adds a menu or another window keeps the "is open" note.
  const both = [text(whole), text(stuckNote)];
  assert.equal(dropStaleMenuNotes(both, [text(diff)]), both);
  assert.equal(dropStaleMenuNotes(head, [text(diff.replace('+ \t132 (selected) Table', '+ \t5 menu Secondary Actions: Cancel'))]), head);
  assert.equal(dropStaleMenuNotes(head, [text(diff.replaceAll('a.txt', 'b.txt'))]), head);
});

test('relay: a split call whose click consumed the menu ends without the acquisition\'s menu note', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-menunote-')));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  const record = into => data => into.push(...data.toString().trim().split('\n').map(JSON.parse));
  serverIn.on('data', record(sent)); clientOut.on('data', record(replies));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, inputLease: new InputLease({ directory, holder: 'fixture' }) });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); rmSync(directory, { recursive: true, force: true }); });
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, value) => serverOut.write(JSON.stringify({ id, result: { isError: false, content: [text(value)],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } }) + '\n');
  const prefix = () => sent.filter(m => String(m.id).startsWith('sleight-acquire-')).at(-1)?.id;
  const doc = document('a.txt', 'file:///tmp/a.txt');
  const stuck = doc.replace('\t4 Format', '\t132 (selected) Table');
  for (const [id, last, kept] of [[2, doc, false], [3, formatMenu('a.txt'), true], [4, stuck, false]]) {
    call(1, 'let app = await cua.getApp("TextEdit")'); await tick();
    reply(1, doc); await tick();
    call(id, 'let app = await cua.getApp("TextEdit"); await app.click({ label: "Format" });'); await tick();
    reply(prefix(), formatMenu('a.txt')); await tick();
    assert.ok(sent.some(m => m.id === id), 'the rest of the call went on');
    reply(id, GUARD_MARK + last + GUARD_END); await tick();
    const out = replies.find(m => m.id === id).result.content.map(item => item.text ?? '').join('\n');
    assert.equal(/a menu is open/.test(out), kept, out);
    assert.equal(/a menu may (?:still )?be stuck open/.test(out), last === stuck, out);
    replies.length = 0; sent.length = 0;
  }
});

// textedit-save, 2026-10-17T22-55 transcript lines 22-36: the Cancel the menu note advised closed the menu, but the
// result showed the acquisition's menu tree above the window's, and Claude sent Escape and a re-read.
const CANCEL = 'let app = await cua.getApp("TextEdit"); await app.performSecondaryAction(1, "Cancel"); await app.getAXState()';
test('a call that cancels a menu and ends on its window says the menu closed and drops the menu tree', () => {
  const doc = document('a.txt', 'file:///tmp/a.txt');
  for (const code of [CANCEL, 'await app.click({ label: "Format" }); await app.getAXState(); await app.pressKey("Escape"); await app.getAXState()']) {
    // The acquisition's result (head) and the rest's.
    const head = [text(formatMenu('a.txt')), text('')], rest = [text(GUARD_MARK + doc + GUARD_END), text('sleight: UI unverified (no earlier read).')];
    for (const [h, c] of [[head, rest], [[], [...head, ...rest]]]) {
      const out = closedMenuContent(c, code, undefined, undefined, h);
      const joined = [...out.head, ...out.content].map(item => item.text).join('\n');
      assert.doesNotMatch(joined, /Make Rich Text/, code);
      assert.match(joined, /0 standard window a\.txt/);
      assert.equal(out.content.at(-1).text, 'sleight: the menu closed.');
      assert.equal(closedMenuContent(c, code, () => false, 'lean', h).content.at(-1).text, 'sleight: menu closed.');
    }
  }
  // A guarded menu read becomes an omitted read, which the compactor leaves out.
  const guarded = [text(GUARD_MARK + formatMenu('a.txt') + GUARD_END + GUARD_MARK + doc + GUARD_END)];
  const kept = closedMenuContent(guarded, 'await app.click({ label: "Format" }); await app.getAXState(); await app.performSecondaryAction(1, "Cancel"); await app.getAXState()').content;
  assert.ok(kept[0].text.startsWith(GUARD_OMIT_MARK + 'Window: "a.txt"'));
  assert.equal(createReadCompactor().process(kept).map(item => item.text).join('\n').includes('Make Rich Text'), false);
  // Handle reuse: no menu tree in the call, but the window's last result was the menu.
  const alone = closedMenuContent([text(doc)], 'await app.performSecondaryAction(1, "Cancel"); await app.getAXState()', window => window.title === 'a.txt');
  assert.equal(alone.content.at(-1).text, 'sleight: the menu closed.');
  // The last tree has to come from the rest, not the head.
  assert.equal(closedMenuContent([text('done')], CANCEL, () => true, undefined, [text(doc)]), undefined);
});

test('no menu-closed note while the menu stays, without a cancel, or for another window', () => {
  const doc = document('a.txt', 'file:///tmp/a.txt');
  const head = [text(formatMenu('a.txt'))];
  assert.equal(closedMenuContent([...head, text(formatMenu('a.txt'))], CANCEL), undefined, 'still open');
  assert.equal(closedMenuContent([...head, text(doc.replace('\t3 File', '\t3 File (selected)'))], CANCEL), undefined, 'menu-bar item still selected');
  assert.equal(closedMenuContent([...head, text(doc)], 'let app = await cua.getApp("TextEdit"); await app.click(3); await app.getAXState()'), undefined, 'no cancel');
  assert.equal(closedMenuContent([text(formatMenu('b.txt')), text(doc)], CANCEL), undefined, 'another window\'s menu');
  assert.equal(closedMenuContent([text(doc)], 'await app.pressKey("Escape"); await app.getAXState()'), undefined, 'no menu was open');
});

test('relay: a split Cancel call shows the window once and says the menu closed', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-menuclosed-')));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  const record = into => data => into.push(...data.toString().trim().split('\n').map(JSON.parse));
  serverIn.on('data', record(sent)); clientOut.on('data', record(replies));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, inputLease: new InputLease({ directory, holder: 'fixture' }) });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); rmSync(directory, { recursive: true, force: true }); });
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, value) => serverOut.write(JSON.stringify({ id, result: { isError: false, content: [text(value)],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } }) + '\n');
  const prefix = () => sent.filter(m => String(m.id).startsWith('sleight-acquire-')).at(-1)?.id;
  const doc = document('a.txt', 'file:///tmp/a.txt');
  call(1, 'let app = await cua.getApp("TextEdit")'); await tick();
  reply(1, formatMenu('a.txt')); await tick();
  assert.match(replies.find(m => m.id === 1).result.content.at(-1).text, /a menu is open/);
  call(2, CANCEL); await tick();
  reply(prefix(), formatMenu('a.txt')); await tick();
  reply(2, GUARD_MARK + doc + GUARD_END); await tick();
  const out = replies.find(m => m.id === 2).result.content.map(item => item.text ?? '').join('\n');
  assert.doesNotMatch(out, /Make Rich Text|a menu is open/, out);
  assert.match(out, /0 standard window a\.txt/);
  assert.match(out, /^sleight: the menu closed\.$/m);
});

// finder-move, 2026-10-17T22-55: Move Item Here and Paste with the destination folder's row selected moved nothing,
// four times, since both act on the folder the window shows.
const finder = ({ selected = true, files = ['alpha.txt'], focus } = {}) => ['Window: "Files", App: Finder.',
  '0 standard window Files, ID: FinderWindow, Secondary Actions: Raise', '\t1 split group', '\t\t2 scroll area', '\t\t\t3 outline Description: list view, ID: ListView',
  ...files.flatMap((name, i) => [`\t\t\t\t${4 + i * 2} row (selectable)`, `\t\t\t\t\t${5 + i * 2} text field (settable) Value: ${name}, URL: file:///tmp/Files/${name}`]),
  `\t\t\t\t20 row (${selected ? 'selected' : 'selectable'}, collapsed) Secondary Actions: Expand`,
  `\t\t\t\t\t21 text field (${selected ? 'selected, ' : ''}settable) Value: Archive, URL: file:///tmp/Files/Archive/`,
  '22 menu bar', '\t23 Edit', ...(focus ? ['', `The focused UI element is ${focus}`] : [])].join('\n');
const editMenu = ['Window: "Files", App: Finder.', '0 Edit, Secondary Actions: Cancel, Pick', '\t1 menu Secondary Actions: Cancel',
  '\t\t2 (disabled) Cut', '\t\t8 Paste Item', '\t\t9 Move Item Here', '\t\t10 Select All'].join('\n');
const PASTE_NOTE = /^sleight: Paste and Move act on the folder the window shows, not a selected row\. Open the destination first\.$/;
test('a paste or move-here into a file browser that changed no files says it acts on the shown folder', () => {
  const before = { files: () => fileListing(finder()) };
  for (const code of ['await app.click({ label: "Move Item Here" }); await app.getAXState()', 'await app.click({ label: "Paste Item" }); await app.getAXState()',
    'await app.pressKey("super+alt+v"); await app.getAXState()', 'await app.click(9); await app.getAXState()']) {
    assert.match(pasteHereNote([text(finder())], code, { ...before, menu: editMenu }) ?? '', PASTE_NOTE, code);
  }
  // The baseline can be the call's own acquisition, and a menu read earlier in the call names the clicked number.
  assert.match(pasteHereNote([text(finder()), text(GUARD_MARK + editMenu + GUARD_END), text(GUARD_MARK + finder() + GUARD_END)],
    'let app = await cua.getApp("Finder"); await app.click({ label: "Edit" }); await app.getAXState(); await app.click(8); await app.getAXState()') ?? '', PASTE_NOTE);
  assert.equal(pasteHereNote([text(finder())], 'await app.click({ label: "Move Item Here" })'), undefined, 'no baseline');
  assert.ok(pasteHereNote([text(finder())], 'await app.click({ label: "Move Item Here" })', before, 'lean').length < 90);
});

test('no paste note when files changed, no folder row is selected, a field has focus, or the window is a text editor', () => {
  const before = { files: () => fileListing(finder()) };
  const code = 'await app.click({ label: "Move Item Here" }); await app.getAXState()';
  assert.equal(pasteHereNote([text(finder({ files: [] }))], code, before), undefined, 'the file moved');
  assert.equal(pasteHereNote([text(finder({ selected: false }))], code, before), undefined, 'no selected row');
  assert.equal(pasteHereNote([text(finder({ focus: '5 text field (settable) Value: alpha.txt' }))], 'await app.pressKey("super+v"); await app.getAXState()', before), undefined, 'renaming');
  assert.equal(pasteHereNote([text(finder())], 'await app.click({ label: "Edit" }); await app.getAXState()', before), undefined, 'not paste');
  assert.equal(pasteHereNote([text(finder())], 'await app.click(9); await app.getAXState()', before), undefined, 'a number with no menu');
  // A text editor: Paste from its Edit menu, with a selected row, lists no files.
  const editor = document('a.txt', 'file:///tmp/a.txt', ['\t1 text entry area (settable) Value: fixture, ID: First Text View', '\t2 row (selected) Value: line']);
  for (const paste of ['await app.click({ label: "Paste" }); await app.getAXState()', 'await app.pressKey("super+v"); await app.getAXState()']) {
    assert.equal(pasteHereNote([text(editor)], paste, { files: () => '' }), undefined, paste);
  }
});

test('relay: a Move Item Here after the destination row was selected gets the shown-folder note', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-pastehere-')));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, replies = [];
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, inputLease: new InputLease({ directory, holder: 'fixture' }) });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); rmSync(directory, { recursive: true, force: true }); });
  const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, value) => serverOut.write(JSON.stringify({ id, result: { isError: false, content: [text(value)],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.finder' } } } } }) + '\n');
  const out = id => replies.find(m => m.id === id).result.content.map(item => item.text ?? '').join('\n');
  call(1, 'let app = await cua.getApp("Finder")'); await tick();
  reply(1, finder()); await tick();
  assert.doesNotMatch(out(1), /Paste and Move/);
  call(2, 'await app.click({ label: "Edit" }); await app.getAXState()'); await tick();
  reply(2, GUARD_MARK + editMenu + GUARD_END); await tick();
  call(3, 'await app.click(9); await app.getAXState()'); await tick();
  reply(3, GUARD_MARK + finder() + GUARD_END); await tick();
  assert.match(out(3), new RegExp(PASTE_NOTE.source, 'm'));
});
