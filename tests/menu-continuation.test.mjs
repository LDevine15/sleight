import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardStopMark, splitMenuActions, takeGuardStop, menuRemainder, dialogRemainder, dialogRefusal, returnedWindow, returnRefusal, stopNote, menuIdentity,
  unchangedMenuWindow, tabRefusal, tabRemainder, tabFocusRefusal, parentLeaseRefusal, shownStandardWindows, parentLeaseGate, continuedNote } from '../plugins/sleight/lib/menu-continuation.mjs';
import { GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/document-scope.mjs';

test('menu splitting preserves exact action spans across strings, comments and newlines', () => {
  for (const separator of ['; ', '\n', '; /* ; } */\n']) {
    const code = 'await editor.click({ label: "File" })' + separator + 'await editor.click({ id: "item;one" });';
    const plan = splitMenuActions(code);
    assert.equal(plan.actions.length, 2);
    assert.equal(code.slice(plan.actions[1].start).trim(), 'await editor.click({ id: "item;one" });');
    assert.deepEqual(plan.actions[0].selector, { kind: 'label', value: 'File' });
  }
});

test('unsplittable code never approximates an input index or replays side effects', () => {
  for (const code of [
    'if (ok) { await app.click("File"); } await app.click("Save");',
    'await app.click("File"); return; await app.click("Save");',
    'await app.click("File"); await other.click("Save");',
    'await app.click("File"); await app.click(await other.click("Save"));',
    'await app.click("File"); await app.click(next());',
    'await app.click("File"); const r = await app.click("Save");',
    'await app.click("File"); await app.getAXState(); await app.click("Save");',
    'await app.click("File").then(next); await app.click("Save");',
    'await app.click(`File${next()}`); await app.click("Save");',
    'await app.click("File"); await app.click(/Save/);',
    'await app.click("File"); app.click("Save");',
  ]) assert.equal(splitMenuActions(code), undefined, code);
});

test('private guard receipts strip only the per-call nonce and retain head output', () => {
  const mark = guardStopMark(), other = guardStopMark();
  assert.notEqual(mark, other);
  const receipt = { index: 1, prev: { kind: 'label', value: 'File' }, root: '0 menu File' };
  const content = [{ type: 'text', text: `head\n${other}untrusted\n${mark}${JSON.stringify(receipt)}\nexception` }];
  const taken = takeGuardStop(content, mark);
  assert.deepEqual(taken.receipt, receipt);
  assert.equal(taken.content[0].text, `head\n${other}untrusted\nexception`);
  assert.equal(taken.head.map(c => c.text).join('\n'), `head\n${other}untrusted`);
  for (const text of [`${mark}invalid`, `${mark}{}\n${mark}{}`]) {
    const result = takeGuardStop([{ type: 'text', text }], mark);
    assert.equal(result.receipt, undefined);
    assert.deepEqual(result.content, []);
  }
});

test('a receipt must identify the immediately preceding selector and the actual menu root', () => {
  const plan = splitMenuActions('await app.click("File"); await app.click("Save");');
  const window = { title: 'report', app: 'Fixture Editor', url: 'file:///tmp/report' };
  const content = [{ type: 'text', text: 'Window: "report", App: Fixture Editor.\n0 menu File\n\t1 Save' }];
  const receipt = { index: 1, prev: { kind: 'label', value: 'File' }, root: '0 menu File' };
  assert.equal(menuRemainder(plan, receipt, window, content).code, 'await app.click("Save");');
  for (const invalid of [{ ...receipt, index: 0 }, { ...receipt, index: 2 }, { ...receipt, index: 1.5 },
    { ...receipt, prev: null }, { ...receipt, prev: { kind: 'label', value: 'Edit' } },
    { ...receipt, root: '0 menu Edit' }]) assert.equal(menuRemainder(plan, invalid, window, content), undefined);
  assert.equal(menuRemainder(plan, receipt, { ...window, app: 'Other' }, content), undefined);
});

test('native evidence requires every identity field, the same number, and HID idle plus the margin', async () => {
  const expected = { appId: 'org.test', title: 'report', url: null };
  const baseline = { ...expected, status: 'ok', matches: 1, epoch: 'helper', window: 1, windowNumber: 22,
    pid: 123, processStart: 1, hidIdleSeconds: 1000 };
  const forwardedAt = performance.now() - 100;
  assert.equal(unchangedMenuWindow(expected, baseline, baseline, forwardedAt), true);
  for (const changed of [{ windowNumber: 23 }, { hidIdleSeconds: 0.12 }, { hidIdleSeconds: null },
    { hidIdleSeconds: NaN }, { epoch: 'replacement' }, { pid: 999 }, { processStart: 2 },
    { matches: 2 }, { status: 'mismatch' }, { appId: 'other' }]) {
    assert.equal(unchangedMenuWindow(expected, baseline, { ...baseline, ...changed }, forwardedAt), false);
  }
  assert.equal(unchangedMenuWindow(expected, { ...baseline, windowNumber: null }, baseline, forwardedAt), false);
  assert.equal(await menuIdentity(async () => { throw Error('unavailable'); }, expected), undefined);
  assert.equal(await menuIdentity(() => new Promise(() => {}), expected, 1), undefined);
});

test('navigation receipts bind the exact preceding key or click to a retitled standard window', () => {
  const expected = { title: 'Parent', app: 'Fixture Editor', url: null };
  const content = [{ type: 'text', text: 'Window: "Child", App: Fixture Editor.\n0 standard window Child\n\t1 button Other' }];
  for (const [action, prev] of [['pressKey("Return")', { kind: 'key', value: 'Return' }],
    ['click(2)', { kind: 'number', value: 2 }], ['click([20,40])', { kind: 'point', value: [20, 40] }],
    ['click("Child")', { kind: 'label', value: 'Child' }]]) {
    const plan = splitMenuActions(`await app.${action}; await app.click("Other");`);
    const receipt = { index: 1, prev, root: '0 standard window Child', windowStop: true };
    assert.equal(menuRemainder(plan, receipt, expected, content).navigation, true);
    for (const invalid of [{ ...receipt, prev: { ...prev, value: 'wrong' } },
      { ...receipt, prev: { ...prev, kind: prev.kind === 'key' ? 'label' : 'key' } },
      { ...receipt, root: '0 standard window Other' }, { ...receipt, windowStop: false }]) {
      assert.equal(menuRemainder(plan, invalid, expected, content), undefined);
    }
    assert.equal(menuRemainder(plan, receipt, { ...expected, title: 'Child' }, content), undefined);
  }
});

// LA1: the calls that stopped on their own menu click in textedit-calculator (2026-10-17), paths scrubbed.
const transcriptShapes = [
  ['let te2 = await cua.getApp("TextEdit");\nawait te2.click({ label: "File" });\nawait te2.click({ label: "Save" });\nconst t3 = await te2.getAXState();\nnodeRepl.write(t3.split("\\n").slice(0, 4).join("\\n"));',
    'te2', ['File', 'Save']],
  ['let te3 = await cua.getApp("TextEdit"); await te3.click({label:"Edit"}); await te3.click({label:"Select All"}); let t3 = await te3.getAXState(); nodeRepl.write(t3.split("\\n").slice(0,8).join("\\n"));',
    'te3', ['Edit', 'Select All']],
  // The same calls after the relay sends their acquisition on its own.
  ['await te2.click({ label: "File" });\nawait te2.click({ label: "Save" });\nconst t3 = await te2.getAXState();\nnodeRepl.write(t3.split("\\n").slice(0, 4).join("\\n"));',
    'te2', ['File', 'Save']],
  ['app = await cua.getApp("TextEdit"); await app.click({ label: "Edit" }); await app.click({ label: "Select All" });', 'app', ['Edit', 'Select All']],
  ['const doc = await cua.getApp({ windowId: 12 }); await doc.click("File"); await doc.click("Save"); doc', 'doc', ['File', 'Save']],
];
test('LA1: a leading acquisition and trailing reads of the same handle still split the menu actions', () => {
  for (const [code, handle, labels] of transcriptShapes) {
    const plan = splitMenuActions(code);
    assert.ok(plan, code);
    assert.deepEqual(plan.actions.map(a => [a.handle, a.selector.value]), labels.map(label => [handle, label]), code);
    const receipt = { index: 1, prev: { kind: 'label', value: labels[0] }, root: `0 menu ${labels[0]}` };
    const content = [{ type: 'text', text: `Window: "report", App: Fixture Editor.\n0 menu ${labels[0]}\n\t1 ${labels[1]}` }];
    const rest = menuRemainder(plan, receipt, { title: 'report', app: 'Fixture Editor', url: 'file:///tmp/report' }, content).code;
    assert.ok(rest.startsWith(`await ${handle}.click(`) && rest.includes(labels[1]), rest);
    assert.doesNotMatch(rest, /cua\.getApp/);
  }
});

test('LA1: other leading or trailing statements still leave the call unsplit', () => {
  for (const code of [
    'let te = await cua.getApp("TextEdit"); await other.click("File"); await other.click("Save");',
    'await app.click("File"); app = await cua.getApp("TextEdit"); await app.click("Save");',
    'let te = await cua.getApp(name); await te.click("File"); await te.click("Save");',
    'let te = await cua.getApp("TextEdit", next()); await te.click("File"); await te.click("Save");',
    'let te = await cua.getApp("TextEdit"); let te2 = await cua.getApp("Other"); await te.click("File"); await te.click("Save");',
    'await app.click("File"); await app.click("Save"); nodeRepl.write(await app.click("Other"));',
    'await app.click("File"); await app.click("Save"); nodeRepl.write(app.pressKey("Return"));',
    'await app.click("File"); await app.click("Save"); const s = await other.getAXState();',
    'await app.click("File"); await app.click("Save"); const s = await app.getAXState(); await app.click("Other");',
    'await app.click("File"); await app.click("Save"); nodeRepl.write(cua.getApp("Other"));',
    'await app.click("File"); await app.click("Save"); const s = await app.getAXState(next());',
  ]) assert.equal(splitMenuActions(code), undefined, code);
});

// LA1R: the trailing write takes only reads of this call's handle and their string methods.
test('LA1R: a trailing write that could reach an action leaves the call unsplit', () => {
  const head = 'let te = await cua.getApp("TextEdit"); await te.click("File"); await te.click("Save"); const t = await te.getAXState(); ';
  for (const write of [
    'nodeRepl.write(app["pressKey"]("Return"))', 'nodeRepl.write(app[k](1))', 'nodeRepl.write(app?.["typeText"]("z"))',
    'nodeRepl.write(app.getAXState().then(()=>app["click"](3)))', 'nodeRepl.write(other.getAXState())',
    'nodeRepl.write(te["pressKey"]("Return"))', 'nodeRepl.write(te?.getAXState())', 'nodeRepl.write(t.constructor.constructor("x")())',
    'nodeRepl.write(t.split`x`)', 'nodeRepl.write(t.replace("a", "b"))', 'nodeRepl.write(te.typeText)', 'nodeRepl.write(pressKey)',
    'nodeRepl.write(t.split("\\n"), te.click(3))', 'nodeRepl.write(te)', 'nodeRepl.write(x)', 'typeText',
  ]) {
    assert.equal(splitMenuActions(head + write), undefined, write);
    assert.equal(splitMenuActions('await app.click("File"); await app.click("Save"); ' + write), undefined, write);
  }
});

test('LA1R: trailing writes of the handle\'s reads still split', () => {
  for (const write of ['nodeRepl.write(t.split("\\n").slice(0, -4).join("\\n"))', 'nodeRepl.write(te.getAXState({ disableDiffing: true }))',
    'nodeRepl.write(t.trim().length)', 'nodeRepl.write("done")', 'nodeRepl.write(t)', 't']) {
    const plan = splitMenuActions('let te = await cua.getApp("TextEdit"); await te.click("File"); await te.click("Save"); const t = await te.getAXState(); ' + write);
    assert.deepEqual(plan?.actions.map(a => a.selector.value), ['File', 'Save'], write);
  }
});

// DR1: the calls that clicked OK on Word's Replace All alert in word-edit (2026-10-17), paths scrubbed.
const dialogShapes = [
  ['const a = __sleightOpenedApp3; await a.click({ id: "action-button--998" }); await a.pressKey("super+End"); await a.pressKey("Return"); await a.click({ label: "Table" }); const s = await a.getAXState({ disableDiffing: true }); s.split("\\n").filter(l => /Insert|Table|menu|Page 1 content|Keep this/i.test(l)).slice(0, 40).join("\\n")', 'a', 4],
  ['await app.click({ label: "OK" });\nawait app.click([600, 401]);\nawait app.pressKey("super+End");\nawait app.pressKey("Return");\nconst sh3 = await app.getScreenshot();\n"done"', 'app', 4],
  ['await app.click({ id: "action-button--998" });\nawait app.pressKey("super+Home");\nawait app.pressKey("super+alt+1");\nlet s = await app.getAXState();\nnodeRepl.write(s.split("\\n").filter(l => /Heading|Report|Window|dialog|alert/i.test(l)).join("\\n"));', 'app', 3],
  ['let app = await cua.getApp("Microsoft Word");\nawait app.click({ id: "action-button--998" });\nawait app.pressKey("super+End");\nconst st = await app.getAXState();\nst.split("\\n").filter(l => /Table|menu|Insert/i.test(l)).slice(0, 40).join("\\n")', 'app', 2],
  ['let app = await cua.getApp("Microsoft Word");\nawait app.click({ id: "action-button--998" });\nawait app.pressKey("super+End");\nconst st = await app.getAXState();\nnodeRepl.write(st.split("\\n").filter(l => /Page 1 content|dialog|alert|OK|focused/i.test(l)).join("\\n"));', 'app', 2],
];
test('DR1: a renamed handle, screenshots, a final literal and regex-filtered reads still split', () => {
  for (const [code, handle, count] of dialogShapes) {
    const plan = splitMenuActions(code);
    assert.equal(plan?.actions.length, count, code);
    assert.ok(plan.actions.every(a => a.handle === handle), code);
    assert.match(code.slice(plan.actions[1].start), /^\s*await \w+\.(?:pressKey|click)\(/);
  }
});

test('DR1: callbacks that do more than test one regex, and renames of non-names, leave the call unsplit', () => {
  const head = 'await app.click("OK"); await app.pressKey("super+End"); const s = await app.getAXState(); ';
  for (const tail of [
    's.split("\\n").filter(l => app.click(3))', 's.split("\\n").filter(l => /x/.test(m))', 's.split("\\n").filter(l => /x/.exec(l))',
    's.split("\\n").filter(l => /x/.test(l) && app.click(3))', 's.split("\\n").map(l => /x/.test(l))', 's.split("\\n").filter(l => /x/.test(l), app)',
    's.split("\\n").filter(l => { return /x/.test(l); })', 's.split("\\n").filter(async l => /x/.test(l))', 's.split("\\n").filter(/x/.test)',
    'nodeRepl.write(s.split("\\n").filter(l => /x/.test(l)).map(l => l))', 'const shot = await other.getScreenshot()', 'await app.getScreenshot()',
  ]) assert.equal(splitMenuActions(head + tail), undefined, tail);
  for (const code of ['const a = cua; await a.click("OK"); await a.pressKey("x");', 'const a = app.click; await a.click("OK"); await a.pressKey("x");',
    'await app.click(l => /x/.test(l)); await app.pressKey("x");', 'let a = await cua.getApp(l => /x/.test(l)); await a.click("OK"); await a.pressKey("x");',
    'const a = b; await b.click("OK"); await b.pressKey("x");']) assert.equal(splitMenuActions(code), undefined, code);
});

test('LW2: refusal reasons name the first failing condition', () => {
  const plan = splitMenuActions('await app.click({ id: "ok" }); await app.pressKey("super+End");');
  const covered = { title: 'report', app: 'Fixture Editor', url: 'file:///tmp/report', appId: 'org.test' };
  const content = [{ type: 'text', text: 'Window: "report", App: Fixture Editor.\n0 standard window report, URL: file:///tmp/report' }];
  const receipt = { index: 1, prev: { kind: 'id', value: 'ok' }, root: '0 standard window report, URL: file:///tmp/report', windowStop: true };
  for (const [args, reason] of [[[plan, undefined, covered, content], 'no-receipt'], [[plan, { ...receipt, windowStop: false }, covered, content], 'not-a-window-stop'],
    [[plan, receipt, undefined, content], 'no-covered-window'], [[undefined, receipt, covered, content], 'unsplit-call'],
    [[plan, { ...receipt, prev: { kind: 'id', value: 'no' } }, covered, content], 'receipt-mismatch'], [[plan, { ...receipt, root: '0 x' }, covered, content], 'tree-mismatch'],
    [[plan, receipt, { ...covered, url: null }, content], 'other-url'], [[plan, receipt, covered, content], undefined]]) assert.equal(dialogRefusal(...args), reason);
  // LW4 review 2: a dialog or sheet over a window without a URL needs its certified native identity.
  const bare = [{ type: 'text', text: 'Window: "report", App: Fixture Editor.\n0 standard window report' }];
  const bareReceipt = { ...receipt, root: '0 standard window report' };
  for (const over of ['dialog', 'sheet', 'system dialog']) {
    assert.equal(dialogRefusal(plan, bareReceipt, { ...covered, url: null, over }, bare), 'untitled-needs-certified-window', over);
    assert.equal(dialogRefusal(plan, bareReceipt, { ...covered, url: null, over, nativeIdentity: { windowNumber: 22, epoch: 'e', pid: 1 } }, bare), undefined, over);
    assert.equal(dialogRefusal(plan, bareReceipt, { ...covered, url: null, over, nativeIdentity: { windowNumber: 22, epoch: 'e' } }, bare), 'untitled-needs-certified-window', over);
  }
  const observed = { ...covered, status: 'ok', matches: 1, headerMatches: 1, epoch: 'e', window: 1, windowNumber: 22, pid: 1, processStart: 1, hidIdleSeconds: 1000 };
  const since = performance.now() - 10;
  const b = { ...observed, title: '', window: 2, windowNumber: 31 };
  for (const [args, reason] of [[[covered, b, undefined, since], 'identity-unavailable'], [[covered, undefined, observed, since], 'no-baseline'],
    [[covered, b, { ...observed, windowNumber: 0 }, since], 'no-window-number'],
    [[covered, b, { ...observed, hidIdleSeconds: 0 }, since], 'hid-input'], [[covered, { ...b, pid: 2 }, observed, since], 'process-changed'],
    [[covered, b, { ...observed, headerMatches: undefined }, since], 'header-matches-missing'], [[covered, b, { ...observed, title: 'x' }, since], 'identity-mismatch'],
    [[covered, b, observed, since], undefined]]) assert.equal(returnRefusal(...args), reason);
});

// LW3 review: the window returned to must be a standard window, and a palette needs Escape or a check that it closed.
test('LW3: a dialog root under the document\'s title, or a palette without Escape, is no plain dialog remainder', () => {
  const covered = { title: 'report', app: 'Fixture Editor', url: 'file:///tmp/report', appId: 'org.test' };
  const sheet = [{ type: 'text', text: 'Window: "report", App: Fixture Editor.\n0 dialog report, URL: file:///tmp/report' }];
  const plan = splitMenuActions('await app.click({ id: "ok" }); await app.pressKey("super+End");');
  const receipt = { index: 1, prev: { kind: 'id', value: 'ok' }, root: '0 dialog report, URL: file:///tmp/report', windowStop: true };
  assert.equal(dialogRefusal(plan, receipt, covered, sheet), 'returned-root-not-standard');
  assert.equal(dialogRemainder(plan, receipt, covered, sheet), undefined);
  const page = [{ type: 'text', text: 'Window: "report", App: Fixture Editor.\n0 standard window report, URL: file:///tmp/report' }];
  const standard = { ...receipt, root: '0 standard window report, URL: file:///tmp/report' };
  for (const over of ['window', 'floating window']) {
    assert.equal(dialogRefusal(plan, standard, { ...covered, over }, page), 'palette-needs-close-check');
    assert.equal(dialogRemainder(plan, standard, { ...covered, over }, page).closeCheck, true);
  }
  const escape = splitMenuActions('await app.pressKey("Escape"); await app.pressKey("super+h");');
  assert.equal(dialogRefusal(escape, { ...standard, prev: { kind: 'key', value: 'Escape' } }, { ...covered, over: 'window' }, page), undefined);
  for (const over of ['dialog', 'sheet', 'system dialog']) assert.equal(dialogRemainder(plan, standard, { ...covered, over }, page).closeCheck, false);
});

// LW1 review: a rename counts only for open_file's handles or a name the relay binds to the leased app.
test('LW1: only vouched-for handles may be renamed', () => {
  const code = name => `const a = ${name}; await a.click({ id: "ok" }); await a.pressKey("Return");`;
  assert.equal(splitMenuActions(code('__sleightOpenedApp12'))?.actions.length, 2);
  for (const name of ['other', 'finder', '__sleightOpenedApp', 'x__sleightOpenedApp3']) assert.equal(splitMenuActions(code(name)), undefined, name);
  assert.equal(splitMenuActions(code('word'), { alias: name => name === 'word' })?.actions.length, 2);
  assert.equal(splitMenuActions(code('__sleightOpenedApp3'), { alias: () => false }), undefined);
});

test('DR1: only the covered window, after the receipt\'s own action, is a dialog remainder', () => {
  const plan = splitMenuActions('await app.click({ id: "ok" }); await app.pressKey("super+End");');
  const covered = { title: 'report', app: 'Fixture Editor', url: 'file:///tmp/report', appId: 'org.test' };
  const content = [{ type: 'text', text: 'Error: Input lease stopped this action: window or URL changed.\nWindow: "report", App: Fixture Editor.\n0 standard window report, URL: file:///tmp/report\n\t1 text area' }];
  const receipt = { index: 1, prev: { kind: 'id', value: 'ok' }, root: '0 standard window report, URL: file:///tmp/report', windowStop: true };
  assert.equal(dialogRemainder(plan, receipt, covered, content).code, 'await app.pressKey("super+End");');
  for (const invalid of [{ ...receipt, windowStop: false }, { ...receipt, windowStop: undefined }, { ...receipt, index: 0 },
    { ...receipt, prev: { kind: 'id', value: 'cancel' } }, { ...receipt, root: '0 standard window other' }]) {
    assert.equal(dialogRemainder(plan, invalid, covered, content), undefined);
  }
  for (const other of [{ title: 'other' }, { url: 'file:///tmp/other' }, { url: null }, { app: 'Other' }]) {
    assert.equal(dialogRemainder(plan, receipt, { ...covered, ...other }, content), undefined);
  }
  assert.equal(dialogRemainder(plan, receipt, undefined, content), undefined);
});

test('DR1: the returned window needs one focused match, the same process, its certified number and HID idle', () => {
  const covered = { title: 'report', app: 'Fixture Editor', url: null, appId: 'org.test' };
  const observed = { ...covered, status: 'ok', matches: 1, headerMatches: 1, epoch: 'helper', window: 1, windowNumber: 22, pid: 123, processStart: 1, hidIdleSeconds: 1000 };
  const baseline = { ...observed, title: '', window: 2, windowNumber: 31 }, since = performance.now() - 100;
  assert.equal(returnedWindow(covered, baseline, observed, since), true);
  assert.equal(returnedWindow(covered, undefined, observed, since), false, 'LW3 review: the dialog\'s baseline is required');
  for (const changed of [{ hidIdleSeconds: 0.01 }, { hidIdleSeconds: null }, { matches: 2 }, { status: 'mismatch' }, { pid: 9 },
    { processStart: 2 }, { epoch: 'other' }, { title: 'other' }, { url: 'file:///x' }, { appId: 'other' }, { windowNumber: null }]) {
    assert.equal(returnedWindow(covered, baseline, { ...observed, ...changed }, since), false, JSON.stringify(changed));
  }
  // LW1 review: without a certified window, a second same-title window (narrowed to the focused one) stops.
  for (const headerMatches of [2, 0, undefined]) assert.equal(returnedWindow(covered, baseline, { ...observed, headerMatches }, since), false);
  assert.equal(returnedWindow(covered, baseline, observed, NaN), false, 'a parent without its time never continues');
  const certified = { ...covered, nativeIdentity: observed };
  assert.equal(returnedWindow(certified, baseline, observed, since), true);
  assert.equal(returnedWindow(certified, baseline, { ...observed, headerMatches: 2 }, since), true);
  assert.equal(returnedWindow(certified, baseline, { ...observed, windowNumber: 23 }, since), false);
  assert.equal(returnedWindow(certified, baseline, { ...observed, window: 3 }, since), false);
});

test('DR1: stop notes name methods, keys and selectors, never typed text', () => {
  const plan = splitMenuActions('await app.click({ id: "ok" }); await app.pressKey("super+End"); await app.typeText("hunter2"); await app.setValue(4, "pin 1234"); await app.click(7); await app.click([1, 2]);');
  const stop = { index: 1, windowStop: true, completed: 1, name: 'pressKey', error: 'Input lease stopped this action: window or URL changed.' };
  const note = stopNote(stop, plan);
  // AB1: a stop after an action ran gives the two-call recipe; one before any action has nothing to split.
  const recipe = ' After an action that opens a tab or page, end the call there; the next call can send the rest to the window shown here with no new read.';
  assert.equal(note, 'sleight: this call ran 1 action (click id "ok"); not sent: pressKey "super+End", typeText, setValue, click 7 and 1 more.' + recipe);
  assert.doesNotMatch(note, /hunter2|1234/);
  assert.equal(stopNote({ ...stop, index: 0, completed: 0 }, plan), 'sleight: this call ran 0 actions; not sent: click id "ok", pressKey "super+End", typeText, setValue and 2 more.');
  // LW1 review: label text and keys that type a character stay out.
  const typed = splitMenuActions('await app.click({ label: "Card 4242" }); await app.pressKey("a"); await app.pressKey("shift+B"); await app.pressKey("ctrl+c");');
  assert.equal(stopNote(stop, typed), 'sleight: this call ran 1 action (click); not sent: pressKey, pressKey, pressKey "ctrl+c".' + recipe);
  const named = splitMenuActions('await app.click("Card 4242"); await app.pressKey("Return"); await app.pressKey("shift+Tab"); await app.pressKey("ArrowDown"); await app.pressKey("7");');
  assert.equal(stopNote(stop, named), 'sleight: this call ran 1 action (click); not sent: pressKey "Return", pressKey "shift+Tab", pressKey "ArrowDown", pressKey.' + recipe);
  assert.equal(stopNote(stop), 'sleight: this call ran 1 action; the stopped pressKey and everything after it were not sent.' + recipe);
  assert.equal(stopNote({ ...stop, completed: 0 }, undefined, 2), 'sleight: this call ran 2 actions; the stopped pressKey and everything after it were not sent.' + recipe);
  assert.equal(stopNote({ ...stop, completed: 0 }), 'sleight: this call ran 0 actions; the stopped pressKey and everything after it were not sent.');
  assert.equal(stopNote({ ...stop, windowStop: false }, plan), undefined);
  assert.equal(stopNote({ ...stop, error: 'Input lease stopped this action: app changed. 1 earlier action in this call ran' }, plan), undefined);
});

test('AB3: a refusal note maps the rest by ID, label and seen line, with ? for an ambiguous one', () => {
  const plan = splitMenuActions('await app.click(1); await app.click({ id: "go" }); await app.click({ label: "Twin" }); await app.click(4); await app.pressKey("Return");');
  const fresh = 'Window: "a", App: A.\n0 standard window a\n\t1 button First\n\t2 button Twin\n\t3 button Twin\n\t5 button Go, ID: go\n\t6 button Last, ID: last';
  // Other trees in the result, marked before or unmarked after it, are not the guard's fresh one.
  const content = [{ type: 'text', text: GUARD_MARK + fresh.replace('6 button Last', '9 button Last') + GUARD_END + GUARD_MARK + fresh + GUARD_END +
    '\nWindow: "a", App: A.\n0 standard window a\n\t7 button Last, ID: last' }];
  const refusal = { index: 1, completed: 1, name: 'click', refused: true, bound: true, fresh: true, error: 'Computer Use server error -10005: 2 is an invalid element ID' };
  const seen = { 4: 'button Last, ID: last' }, uniqueSeen = [4];
  assert.equal(stopNote(refusal, plan, 0, { content, seen, uniqueSeen }),
    'sleight: this call ran 1 action (click 1); the engine refused the next click (element 2): its number came from this call\'s first read, and the element changed (perhaps replaced by an earlier action). ' +
    'Not sent after it: click, click 4, pressKey "Return". In this result\'s window, the refused action and the rest are now click 5, click ?, click 6, pressKey "Return" (? where the target is ambiguous or missing). ' +
    'sleight now reads this window before each numbered or named action, so the rest can go in one call.');
  // Unbound, or a call the plan can't follow: what ran, by count, and no claim about later reads.
  assert.equal(stopNote({ ...refusal, bound: false, completed: 3 }, plan, 0, { content }),
    'sleight: this call ran 3 actions; the engine refused the next click (element 2): that element is gone. Nothing after it was sent. This result\'s window is current.');
  assert.equal(stopNote({ ...refusal, windowStop: false }, undefined, 0, { content }), 'sleight: this call ran 1 action; the engine refused the next click (element 2): its number came from this call\'s first read, ' +
    'and the element changed (perhaps replaced by an earlier action). Nothing after it was sent. This result\'s window is current. sleight now reads this window before each numbered or named action, so the rest can go in one call.');
});

test('AB3 review: a seen line maps only when it was unique and carries an ID, Description or Help', () => {
  const plan = splitMenuActions('await app.click(1); await app.click(15); await app.click(16);');
  const fresh = 'Window: "a", App: A.\n0 standard window a\n\t1 button First\n\t20 button Description: 15\n\t21 button Plain';
  const content = [{ type: 'text', text: GUARD_MARK + fresh + GUARD_END }];
  const refusal = { index: 1, completed: 1, name: 'click', refused: true, bound: true, fresh: true, error: 'Computer Use server error -10005: 15 is an invalid element ID' };
  // Claude's tree had two "15" buttons; one remains, so it may not be the one Claude meant. "button Plain" has no ID.
  const seen = { 15: 'button Description: 15', 16: 'button Plain' };
  assert.match(stopNote(refusal, plan, 0, { content, seen, uniqueSeen: [16] }), /are now click \?, click \? \(/);
  assert.match(stopNote(refusal, plan, 0, { content, seen, uniqueSeen: [15, 16] }), /are now click 20, click \? \(/);
});

test('AB3 review: without the guard\'s fresh tree the note claims no current window and lists no targets', () => {
  const plan = splitMenuActions('await app.click(1); await app.click({ label: "Second" }); await app.click(3);');
  const refusal = { index: 1, completed: 1, name: 'click', refused: true, bound: true, fresh: false, error: 'Computer Use server error -10005: 2 is an invalid element ID' };
  // A tree in the result without fresh: true (a read the code made itself) doesn't count.
  const content = [{ type: 'text', text: GUARD_MARK + 'Window: "a", App: A.\n0 standard window a\n\t2 button Second' + GUARD_END }];
  for (const note of [stopNote(refusal, plan, 0, { content }), stopNote({ ...refusal, fresh: true }, plan, 0, { content: [] }), stopNote(refusal, undefined, 0, { content })]) {
    assert.match(note, /sleight couldn't read the window after it, so read it before acting\./);
    assert.doesNotMatch(note, /is current|are now/);
  }
});

// AB1: the Firefox race round's new-tab shape (2026-10-17), with the engine's own role names.
const markerTree = 'Window: "Marker", App: Fixture Browser.\n0 standard window Marker, Secondary Actions: Raise\n\t1 tab group\n' +
  '\t\t2 tab (selected) Value: Marker, Marker\nClose tab\n\t\t3 button Open a new tab\n\t4 combo box (settable) Address\n\t5 HTML Content Description: Marker';
const newTabTree = 'Window: "New Tab", App: Fixture Browser.\n0 standard window New Tab, Secondary Actions: Raise\n\t1 tab group\n' +
  '\t\t2 tab (selectable) Value: Marker, Marker\nClose tab\n\t\t3 tab (selected) Value: New Tab, New Tab\nClose tab\n\t\t4 button Open a new tab\n' +
  '\t5 combo box (settable) Address\n\t6 HTML Content Description: New Tab\n\t\t7 text field Search\n\nThe focused UI element is 5 combo box (settable) Address';
const linesOf = tree => Object.fromEntries([...tree.matchAll(/^\t*(\d+) (.*)$/gm)].map(([, n, line]) => [n, line]));

test('AB1: a trailing getAXState is a read, so the new-tab call splits; a read between actions still does not', () => {
  const plan = splitMenuActions('await app.pressKey("super+t");\nawait app.typeText("u");\nawait app.pressKey("Return");\nawait app.getAXState()');
  assert.equal(plan.actions.length, 3);
  assert.equal(splitMenuActions('await app.pressKey("super+t"); await app.typeText("u"); await app.getAXState({ disableDiffing: true });').actions.length, 2);
  for (const code of ['await app.pressKey("super+t"); await app.getAXState(); await app.typeText("u");',
    'await app.pressKey("super+t"); await other.getAXState();', 'await app.pressKey("super+t"); await app.getAXState(next());'])
    assert.equal(splitMenuActions(code), undefined, code);
});

test('AB1: a tab remainder needs the call\'s own Cmd+T or Ctrl+T, one new selected tab and focus in an app field', () => {
  const plan = splitMenuActions('await app.pressKey("super+t"); await app.typeText("u"); await app.pressKey("Return");');
  const expected = { title: 'Marker', app: 'Fixture Browser', url: null };
  const content = [{ type: 'text', text: 'Input lease stopped this action: window or URL changed.\n' + newTabTree }];
  const receipt = { index: 1, prev: { kind: 'key', value: 'super+t' }, root: '0 standard window New Tab, Secondary Actions: Raise', windowStop: true };
  const before = linesOf(markerTree);
  const tree = text => [{ type: 'text', text }];
  for (const [args, reason] of [
    [[plan, undefined, expected, content, before], 'no-receipt'], [[plan, { ...receipt, windowStop: false }, expected, content, before], 'not-a-window-stop'],
    [[undefined, receipt, expected, content, before], 'unsplit-call'], [[plan, { ...receipt, prev: { kind: 'key', value: 'super+n' } }, expected, content, before], 'receipt-mismatch'],
    [[splitMenuActions('await app.pressKey("super+shift+t"); await app.typeText("u");'), { ...receipt, prev: { kind: 'key', value: 'super+shift+t' } }, expected, content, before], 'not-a-tab-shortcut'],
    [[splitMenuActions('await app.pressKey("Return"); await app.typeText("u");'), { ...receipt, prev: { kind: 'key', value: 'Return' } }, expected, content, before], 'not-a-tab-shortcut'],
    [[plan, { ...receipt, root: '0 x' }, expected, content, before], 'tree-mismatch'],
    [[plan, receipt, { ...expected, app: 'Other' }, content, before], 'other-app'],
    [[plan, { ...receipt, root: '0 sheet New Tab, Secondary Actions: Raise' }, expected, tree(newTabTree.replace('0 standard window', '0 sheet')), before], 'root-not-standard'],
    [[plan, receipt, { ...expected, title: 'New Tab' }, content, before], 'same-header'],
    ...['sheet', 'dialog', 'system dialog'].map(role => [[plan, receipt, expected, tree(newTabTree.replace('\t5 combo box', `\t8 ${role} Confirm\n\t5 combo box`)), before], 'sheet']),
    [[plan, receipt, expected, content, undefined], 'no-earlier-tree'],
    [[plan, receipt, expected, content, linesOf(newTabTree)], 'no-new-tab'],
    [[plan, receipt, expected, tree(newTabTree.replace('(selectable) Value: Marker', '(selected) Value: Marker')), before], 'no-new-tab'],
    [[plan, receipt, expected, tree(newTabTree.replace('Value: Marker, Marker', 'Value: Other, Other')), before], 'no-new-tab'],
    [[plan, receipt, expected, tree(newTabTree.replace(/The focused UI element is .*/, '')), before], 'focus-not-app-field'],
    [[plan, receipt, expected, tree(newTabTree.replace(/The focused UI element is .*/, 'The focused UI element is 4 button Open a new tab')), before], 'focus-not-app-field'],
    [[plan, receipt, expected, tree(newTabTree.replace(/The focused UI element is .*/, 'The focused UI element is 7 text field Search')), before], 'focus-in-document'],
    [[plan, receipt, expected, content, before], undefined],
  ]) assert.equal(tabRefusal(...args), reason, reason);
  // A new tab with the same label as an older one still counts once.
  const twin = newTabTree.replaceAll('Value: Marker, Marker', 'Value: New Tab, New Tab');
  assert.equal(tabRefusal(plan, receipt, expected, tree(twin), linesOf(markerTree.replaceAll('Value: Marker, Marker', 'Value: New Tab, New Tab'))), undefined);
  // Review 6: a header that differs only in its URL is a change; the same title and URL is not.
  const withUrl = url => tree(newTabTree.replace('0 standard window New Tab, Secondary', `0 standard window New Tab, URL: ${url}, Secondary`));
  const urlReceipt = url => ({ ...receipt, root: `0 standard window New Tab, URL: ${url}, Secondary Actions: Raise` });
  assert.equal(tabRefusal(plan, urlReceipt('https://b.test/'), { ...expected, title: 'New Tab', url: 'https://a.test/' }, withUrl('https://b.test/'), before), undefined);
  assert.equal(tabRefusal(plan, urlReceipt('https://a.test/'), { ...expected, title: 'New Tab', url: 'https://a.test/' }, withUrl('https://a.test/'), before), 'same-header');
  // Review 2: only Cmd+T or Ctrl+T.
  for (const key of ['super+n', 'cmd+d', 'ctrl+l']) {
    const other = splitMenuActions(`await app.pressKey("${key}"); await app.typeText("u");`);
    assert.equal(tabRefusal(other, { ...receipt, prev: { kind: 'key', value: key } }, expected, content, before), 'not-a-tab-shortcut', key);
  }
  for (const key of ['Super+T', 'cmd+t', 'command+t', 'meta+t', 'control+t']) {
    const own = splitMenuActions(`await app.pressKey("${key}"); await app.typeText("u");`);
    assert.equal(tabRefusal(own, { ...receipt, prev: { kind: 'key', value: key } }, expected, content, before), undefined, key);
  }
  const remainder = tabRemainder(plan, receipt, expected, content, before);
  assert.equal(remainder.code, 'await app.typeText("u"); await app.pressKey("Return");');
  assert.deepEqual([remainder.tab, remainder.navigation, remainder.window.title], [true, true, 'New Tab']);
  assert.equal(tabRemainder(plan, receipt, expected, content, undefined), undefined);
});

test('AB1: the helper must see no sheet and a non-password text field or combo box focused in the window', () => {
  const focus = { sheets: 0, role: 'AXComboBox', subrole: null, inWindow: true, inPage: false };
  assert.equal(tabFocusRefusal({ focus }), undefined);
  assert.equal(tabFocusRefusal({ focus: { ...focus, role: 'AXTextField', subrole: 'AXSearchField' } }), undefined);
  for (const [observed, reason] of [[undefined, 'no-native-focus'], [{ focus: true }, 'no-native-focus'], [{ focus: { ...focus, sheets: 1 } }, 'native-sheet'],
    [{ focus: { ...focus, sheets: undefined } }, 'native-sheet'], [{ focus: { ...focus, inWindow: false } }, 'focus-outside-window'],
    [{ focus: { ...focus, role: 'AXTextField', subrole: 'AXSecureTextField' } }, 'secure-field'], [{ focus: { ...focus, role: 'AXWebArea' } }, 'focus-not-text-field'],
    // Review 1: a page's own text field passes the tree check when the tree omits its page; the helper's walk refuses it.
    [{ focus: { ...focus, role: 'AXTextField', inPage: true } }, 'focus-in-page'], [{ focus: { ...focus, inPage: undefined } }, 'focus-in-page']])
    assert.equal(tabFocusRefusal(observed), reason, reason);
});

test('TW2: a navigation into a page names it in any case', () => {
  const plan = splitMenuActions('await app.pressKey("Return"); await app.click("Other");');
  const receipt = { index: 1, prev: { kind: 'key', value: 'Return' }, root: '0 standard window Child', windowStop: true };
  const expected = { title: 'Parent', app: 'Fixture Editor', url: null };
  const page = role => [{ type: 'text', text: `Window: "Child", App: Fixture Editor.\n0 standard window Child\n\t1 ${role} Child` }];
  assert.equal(menuRemainder(plan, receipt, expected, page('group')).navigation, true);
  for (const role of ['HTML Content', 'HTML content', 'Web Area']) assert.equal(menuRemainder(plan, receipt, expected, page(role)), undefined, role);
});

test('OT2 review: the parent lease gate excludes every mode it must', () => {
  const parent = { title: 'Report', app: 'Word', url: 'file:///tmp/r.docx', appId: 'com.example.word' };
  const ok = { enabled: true, recovered: true, selected: false, documentMode: false, changeReview: false, helper: true, numbers: [],
    stale: { parent }, window: { ...parent } };
  assert.equal(parentLeaseGate(ok), undefined);
  for (const [change, reason] of [
    [{ enabled: false }, 'off'], [{ recovered: false }, 'not-recovered'], [{ selected: true }, 'selected-window'],
    [{ documentMode: true }, 'document-scope'], [{ changeReview: true }, 'change-review'], [{ helper: false }, 'no-helper'],
    [{ stale: {} }, 'no-parent'], [{ window: undefined }, 'not-the-covered-window'], [{ window: { ...parent, appId: 'com.example.other' } }, 'not-the-covered-window'],
    [{ window: { ...parent, title: 'Other' } }, 'not-the-covered-window'], [{ window: { ...parent, url: null } }, 'not-the-covered-window'],
    [{ numbers: [3] }, 'element-numbers'],
  ]) assert.equal(parentLeaseGate({ ...ok, ...change }), reason, JSON.stringify(change));
});

test('OT2 review: a popover the call closed is a panel in the continued note, not a dialog', () => {
  const plan = splitMenuActions('await app.click({ id: "close" }); await app.pressKey("super+End");');
  for (const over of ['popover', 'window', 'floating window']) assert.match(continuedNote(plan, 1, 'dialog', { over }), /closed the panel/, over);
  assert.match(continuedNote(plan, 1, 'dialog', { over: 'dialog' }), /closed the dialog/);
});

test('OT2: a result shows a standard window only under a header whose own section has a standard root', () => {
  const doc = 'Window: "Report", App: Word.\n0 standard window Report, URL: file:///tmp/r.docx\n\t1 button OK';
  const key = JSON.stringify({ title: 'Report', app: 'Word', url: 'file:///tmp/r.docx' });
  assert.deepEqual([...shownStandardWindows(doc + '\nWindow: "Report", App: Word.\n\t5 table Table')], [key]);
  assert.equal(shownStandardWindows(doc.replace('standard window', 'dialog')).size, 0);
  assert.equal(shownStandardWindows('Window: "Report", App: Word.\n\t1 button OK').size, 0);
  assert.equal(shownStandardWindows(undefined).size, 0);
});

test('OT2: the parent lease takes the covered window only when every condition holds', () => {
  const url = 'file:///tmp/r.docx';
  const parent = { title: 'Report', app: 'Word', url, appId: 'com.example.word', at: 900, seenAt: 800, seen: { process: '123:1' }, over: 'dialog' };
  const stale = { title: 'Insert Table', app: 'Word', url: null, appId: 'com.example.word', parent };
  const reply = `Window: "Report", App: Word.\n0 standard window Report, URL: ${url}\n\t1 text area Value: x`;
  const observed = { status: 'ok', matches: 1, headerMatches: 1, appId: 'com.example.word', title: 'Report', url, epoch: 'e', window: 1,
    windowNumber: 40, pid: 123, processStart: 1, hidIdleSeconds: 10, windowSubrole: 'AXStandardWindow', focus: { sheets: 0 } };
  const base = { stale, shown: new Set([JSON.stringify({ title: 'Report', app: 'Word', url })]), reply, gone: true, observed, now: 1000 };
  assert.equal(parentLeaseRefusal(base), undefined);
  for (const over of ['sheet', 'system dialog', 'window', 'floating window', 'popover']) {
    assert.equal(parentLeaseRefusal({ ...base, stale: { ...stale, parent: { ...parent, over } } }), undefined, over);
  }
  const certified = { windowNumber: 40, epoch: 'e', window: 1, pid: 123, processStart: 1 };
  for (const [name, change, reason] of [
    ['no parent', { stale: { ...stale, parent: undefined } }, 'no-parent'],
    ['a standard window over it', { stale: { ...stale, parent: { ...parent, over: 'standard window' } } }, 'not-over-a-dialog'],
    ['another bundle', { stale: { ...stale, appId: 'com.example.other' } }, 'other-bundle'],
    ['a last result that did not show it', { shown: new Set() }, 'not-shown'],
    ['a read with two disagreeing headers', { reply: reply + '\nWindow: "Other", App: Word.' }, 'no-header'],
    ['another app', { reply: reply.replace('App: Word.', 'App: Pages.') }, 'other-app'],
    ['another title', { reply: reply.replaceAll('Report', 'Other') }, 'other-title'],
    ['another URL', { reply: reply.replace(url, 'file:///tmp/copy.docx') }, 'other-url'],
    ['a dialog root', { reply: reply.replace('standard window', 'dialog') }, 'returned-root-not-standard'],
    ['a sheet in the tree', { reply: reply + '\n\t2 sheet Save' }, 'dialog-present'],
    ['the dialog still open', { gone: false }, 'dialog-still-open'],
    ['an uncertified window without a URL', { stale: { ...stale, parent: { ...parent, url: null } }, reply: reply.replace(`, URL: ${url}`, ''),
      shown: new Set([JSON.stringify({ title: 'Report', app: 'Word', url: null })]) }, 'untitled-needs-certified-window'],
    ['a focus mismatch', { observed: { status: 'mismatch', error: 'Focused window differs' } }, 'identity-mismatch'],
    ['no observation', { observed: undefined }, 'identity-unavailable'],
    ['no window number', { observed: { ...observed, windowNumber: null } }, 'no-window-number'],
    ['a floating window natively', { observed: { ...observed, windowSubrole: 'AXFloatingWindow' } }, 'not-standard-native'],
    ['a native sheet', { observed: { ...observed, focus: { sheets: 1 } } }, 'native-sheet'],
    ['no native sheet count', { observed: { ...observed, focus: undefined } }, 'native-sheet'],
    ['input since the document was seen', { observed: { ...observed, hidIdleSeconds: 0.1 } }, 'hid-input'],
    ['a relaunched process', { observed: { ...observed, pid: 456 } }, 'covered-process-changed'],
    ['no process for the covered window', { stale: { ...stale, parent: { ...parent, seen: {} } } }, 'covered-process-changed'],
    ['two windows with the header', { observed: { ...observed, headerMatches: 2 } }, 'header-matches-2'],
    ['two focused matches', { observed: { ...observed, matches: 2 } }, 'identity-mismatch'],
    ['another certified window', { stale: { ...stale, parent: { ...parent, nativeIdentity: { ...certified, windowNumber: 41 } } } }, 'identity-mismatch'],
    ['another helper epoch for a certified window', { stale: { ...stale, parent: { ...parent, nativeIdentity: { ...certified, epoch: 'old' } } } }, 'identity-mismatch'],
  ]) assert.equal(parentLeaseRefusal({ ...base, ...change }), reason, name);
  // Review B: an untitled cover can't be shown gone; a sheet is checked by the tree and the native sheet count.
  assert.equal(parentLeaseRefusal({ ...base, stale: { ...stale, title: '' } }), 'untitled-cover');
  assert.equal(parentLeaseRefusal({ ...base, stale: { ...stale, title: '', parent: { ...parent, over: 'popover' } } }), 'untitled-cover');
  assert.equal(parentLeaseRefusal({ ...base, stale: { ...stale, title: '', parent: { ...parent, over: 'sheet' } } }), undefined);
  // Review F: HID idle counts from min(at, seenAt) = 800 to now = 1000, so 0.2 s plus 0.05 s.
  for (const [seconds, reason] of [[0.15, 'hid-input'], [0.2, 'hid-input'], [0.24, 'hid-input'], [0.26, undefined], [undefined, 'hid-input'],
    [Number.NaN, 'hid-input'], [Infinity, 'hid-input'], [null, 'hid-input'], ['5', 'hid-input']]) {
    assert.equal(parentLeaseRefusal({ ...base, observed: { ...observed, hidIdleSeconds: seconds } }), reason, String(seconds));
  }
  // The later reference alone (at = 900) would pass 0.16 s; seenAt keeps it a refusal.
  assert.equal(parentLeaseRefusal({ ...base, observed: { ...observed, hidIdleSeconds: 0.16 } }), 'hid-input');
  assert.equal(parentLeaseRefusal({ ...base, stale: { ...stale, parent: { ...parent, seenAt: 900 } }, observed: { ...observed, hidIdleSeconds: 0.16 } }), undefined);
  // Review F: every root must be standard, not just one.
  const twice = `${reply}\nWindow: "Report", App: Word.\n0 dialog Report, URL: ${url}`;
  assert.equal(parentLeaseRefusal({ ...base, reply: twice }), 'returned-root-not-standard');
  assert.equal(parentLeaseRefusal({ ...base, reply: `${reply}\n${reply}` }), undefined);
  // A certified window narrows same-title windows by its number.
  assert.equal(parentLeaseRefusal({ ...base, stale: { ...stale, parent: { ...parent, nativeIdentity: certified } }, observed: { ...observed, headerMatches: 2 } }), undefined);
});
