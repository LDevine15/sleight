import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardStopMark, splitMenuActions, takeGuardStop, menuRemainder, menuIdentity,
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
