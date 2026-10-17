import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardStopMark, splitMenuActions, takeGuardStop, menuRemainder, dialogRemainder, dialogRefusal, returnedWindow, returnRefusal, stopNote, menuIdentity,
  unchangedMenuWindow } from '../plugins/sleight/lib/menu-continuation.mjs';

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
  assert.equal(note, 'sleight: this call ran 1 action (click id "ok"); not sent: pressKey "super+End", typeText, setValue, click 7 and 1 more.');
  assert.doesNotMatch(note, /hunter2|1234/);
  assert.equal(stopNote({ ...stop, index: 0, completed: 0 }, plan), 'sleight: this call ran 0 actions; not sent: click id "ok", pressKey "super+End", typeText, setValue and 2 more.');
  // LW1 review: label text and keys that type a character stay out.
  const typed = splitMenuActions('await app.click({ label: "Card 4242" }); await app.pressKey("a"); await app.pressKey("shift+B"); await app.pressKey("ctrl+c");');
  assert.equal(stopNote(stop, typed), 'sleight: this call ran 1 action (click); not sent: pressKey, pressKey, pressKey "ctrl+c".');
  const named = splitMenuActions('await app.click("Card 4242"); await app.pressKey("Return"); await app.pressKey("shift+Tab"); await app.pressKey("ArrowDown"); await app.pressKey("7");');
  assert.equal(stopNote(stop, named), 'sleight: this call ran 1 action (click); not sent: pressKey "Return", pressKey "shift+Tab", pressKey "ArrowDown", pressKey.');
  assert.equal(stopNote(stop), 'sleight: this call ran 1 action; the stopped pressKey and everything after it were not sent.');
  assert.equal(stopNote({ ...stop, completed: 0 }, undefined, 2), 'sleight: this call ran 2 actions; the stopped pressKey and everything after it were not sent.');
  assert.equal(stopNote({ ...stop, windowStop: false }, plan), undefined);
  assert.equal(stopNote({ ...stop, error: 'Input lease stopped this action: app changed. 1 earlier action in this call ran' }, plan), undefined);
});
