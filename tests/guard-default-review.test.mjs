// Adversarial review of the 2026-10-14 guard default (first-off, quiet-edits, bind), sleight 2c1eea6f.
// Each test runs one call sequence under the old default (OLD) and the new default (NEW) with the same
// fake engine, and asserts what reaches the engine. Run: node --test /private/tmp/opus-guard-review/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { guardedCode, hasLabel } from '../plugins/sleight/lib/document-scope.mjs';
import { literalNumbers } from '../plugins/sleight/lib/relay.mjs';

const header = (title, app = 'TextEdit', url) => `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window${url ? `, URL: ${url}` : ''}`;
const win = (title, app = 'TextEdit', url = null) => ({ title, app, url });

// Options as relay.mjs:2104-2112 builds them for an ordinary native call with an input lease.
function options(code, seen, mode) {
  const literals = literalNumbers(code);
  const base = { adoptUrl: true, literals, seenLines: Object.fromEntries(literals.filter(n => seen.has(n)).map(n => [n, seen.get(n)])),
    uniqueSeen: literals.filter(n => [...seen.values()].filter(l => l === seen.get(n)).length === 1) };
  return mode === 'new' ? { ...base, firstOff: true, focused: false, quietEdits: true, bind: true } : base;
}
const lines = text => new Map(text.split('\n').map(l => /^\t*(\d+) (.*)$/.exec(l)).filter(Boolean).map(m => [Number(m[1]), m[2]]));

// A fake engine whose window is `screens[i]`, advancing when an action matches `advance`.
function engine(screens, advance = () => true) {
  let at = 0;
  const calls = [];
  const raw = { async getAXState() { calls.push(['read', screens[at].split('\n')[0]]); return screens[at]; } };
  for (const name of ['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText'])
    raw[name] = async (...args) => { calls.push([name, ...args]); if (advance(name, args) && at < screens.length - 1) at++; };
  return { raw, calls, async listApps() {
    const title = JSON.parse(/^Window: (.*), App:/.exec(screens[at])[1]);
    const name = /, App: (.*)\./.exec(screens[at])[1];
    return [{ id: 'fixture.app', name, windows: [{ id: title, title }] }];
  } };
}
async function run(code, { screens, advance, expected, seen = lines(screens[0]), mode, extra = {}, overrides = {} }) {
  const e = engine(screens, advance);
  const context = { app: e.raw, cua: { getApp: async () => e.raw, listApps: e.listApps }, nodeRepl: { write() {} }, ...extra };
  const opts = { ...options(code, seen, mode), ...overrides };
  let error;
  try { await runInNewContext(`(async () => { ${guardedCode(code, expected, 'changed window', undefined, opts)} })()`, context); }
  catch (err) { error = err.message.split('\n')[0]; }
  return { inputs: e.calls.filter(c => c[0] !== 'read'), reads: e.calls.filter(c => c[0] === 'read').length, error };
}

// 1. bind: a plain button that asks for confirmation. The engine header names the sheet.
// Both numbers are literals Claude saw, so CC5's batch check stops first, with its own wording.
test('bind stops the second numbered click after a confirmation sheet', async () => {
  const main = header('Groups') + '\n\t19 button Remove Group\n\t20 button Remove Member\n\t21 button Done';
  const sheet = header('Remove “Design”?') + '\n0 sheet\n\t19 button Cancel\n\t20 button Remove\n\t21 text Removing a group cannot be undone';
  const code = 'await app.click(19); await app.click(20);';
  const old = await run(code, { screens: [main, sheet], expected: win('Groups'), mode: 'old' });
  const now = await run(code, { screens: [main, sheet], expected: win('Groups'), mode: 'new' });
  assert.deepEqual(old.inputs, [['click', 19]]);
  assert.match(old.error, /changed what element 20 is|element 20 changed since you read the window/);   // adopted the sheet, then saw 20 is now its Remove
  assert.deepEqual(now.inputs, old.inputs);
  assert.match(now.error, /changed what element 20 is|element 20 changed since you read the window/);
});

// 1b. bind: the same with a label: the old default looked the label up in the sheet and found none.
test('bind resolves a label again after a confirmation sheet', async () => {
  const main = header('Groups') + '\n\t19 button Remove Group\n\t20 button Remove Member';
  const sheet = header('Remove “Design”?') + '\n0 sheet\n\t19 button Cancel\n\t20 button Remove';
  const code = 'await app.click(19); await app.click({ label: "Remove Member" });';
  const old = await run(code, { screens: [main, sheet], expected: win('Groups'), mode: 'old' });
  const now = await run(code, { screens: [main, sheet], expected: win('Groups'), mode: 'new' });
  assert.match(old.error, /no element with label/);
  assert.deepEqual(now.inputs, old.inputs);
  assert.match(now.error, /no element with label/);
});

// 2. bind: a non-opener click closes the document.
test('bind stops numbers and identifiers after a document closes', async () => {
  const a = header('a.txt', 'TextEdit', 'file:///tmp/a.txt') + '\n\t1 button Close\n\t2 button Revert, ID: revert';
  const b = header('b.txt', 'TextEdit', 'file:///tmp/b.txt') + '\n\t1 button Close\n\t2 button Revert, ID: revert';
  for (const code of ['await app.click(1); await app.click(2);', 'await app.click(1); await app.click({ id: "revert" });']) {
    const old = await run(code, { screens: [a, b], expected: win('a.txt', 'TextEdit', 'file:///tmp/a.txt'), mode: 'old' });
    const now = await run(code, { screens: [a, b], expected: win('a.txt', 'TextEdit', 'file:///tmp/a.txt'), mode: 'new' });
    assert.match(old.error, /changed window/, code);
    assert.deepEqual(old.inputs, [['click', 1]]);
    assert.deepEqual(now.inputs, old.inputs, code);
    assert.match(now.error, /changed window/);
  }
});

// 2b. A plain pane button is not a known opener: GD2R accepts this binding limitation.
test('a plain toolbar pane stays bound; careful mode rechecks its retitled window', async () => {
  const general = header('General', 'Mail') + '\n\t1 button General\n\t2 button Junk Mail\n\t3 checkbox Enable junk mail filtering';
  const junk = header('Junk Mail', 'Mail') + '\n\t1 button General\n\t2 button Junk Mail\n\t3 checkbox Trust junk mail headers';
  const code = 'await app.click(3); await app.click(2); await app.click(3);'; // toggle, switch pane, "toggle back"
  const old = await run(code, { screens: [general, general, junk], expected: win('General', 'Mail'), mode: 'old' });
  const now = await run(code, { screens: [general, general, junk], expected: win('General', 'Mail'), mode: 'new' });
  const careful = await run(code, { screens: [general, general, junk], expected: win('General', 'Mail'), mode: 'new', overrides: { careful: true } });
  // LW2: the window change is reported ahead of the element check; either way nothing after the pane switch is sent.
  assert.match(old.error, /changed window/);
  assert.equal(old.inputs.length, 2);
  assert.deepEqual(now.inputs, [['click', 3], ['click', 2], ['click', 3]]);
  assert.equal(now.error, undefined);
  assert.equal(now.reads, 2, 'one capture and one final read');
  assert.equal(careful.inputs.length, 2);
  assert.match(careful.error, /changed window|changed what element 3 is/);
});

// 3. first-off: the app's key window changed between calls. Cmd+A then typing replaces another document.
test('first-off requires focused-window confirmation before Cmd+A and typing', async () => {
  const other = header('budget.txt', 'TextEdit', 'file:///Users/x/budget.txt') + '\n\t1 text area';
  const code = 'await app.pressKey("super+a"); await app.typeText("Dear team,");';
  const old = await run(code, { screens: [other], expected: win('a.txt', 'TextEdit', 'file:///tmp/a.txt'), seen: new Map(), mode: 'old' });
  const now = await run(code, { screens: [other], expected: win('a.txt', 'TextEdit', 'file:///tmp/a.txt'), seen: new Map(), mode: 'new' });
  assert.equal(old.inputs.length, 0); assert.match(old.error, /changed window/);
  assert.deepEqual(now.inputs, []);
  assert.match(now.error, /changed window/);
});

// 5. first-off: a second handle on another app takes the leased window's header as its own.
test('first-off checks another handle even after focused-window confirmation', async () => {
  const leased = header('a.txt', 'TextEdit', 'file:///tmp/a.txt') + '\n\t1 text area';
  const notes = { async getAXState() { return header('Shopping', 'Notes') + '\n\t1 text area'; },
    async pressKey(...a) { notesInputs.push(['pressKey', ...a]); }, async typeText(...a) { notesInputs.push(['typeText', ...a]); } };
  let notesInputs = [];
  const code = 'const notes = globalThis.__sleightDocumentGuard.wrap(globalThis.notesRaw); await notes.pressKey("super+v");';
  const old = await run(code, { screens: [leased], expected: win('a.txt', 'TextEdit', 'file:///tmp/a.txt'), mode: 'old', extra: { notesRaw: notes } });
  const oldInputs = notesInputs; notesInputs = [];
  const now = await run(code, { screens: [leased], expected: win('a.txt', 'TextEdit', 'file:///tmp/a.txt'), mode: 'new', extra: { notesRaw: notes }, overrides: { focused: true } });
  assert.match(old.error, /app changed\. 0 earlier actions in this call ran/); assert.deepEqual(oldInputs, []);
  assert.match(now.error, /app changed\. 0 earlier actions in this call ran/); assert.deepEqual(notesInputs, []);
});

// 4. quiet-edits: shortcuts in the edit list that navigate or open a window outside text fields.
for (const [key, after] of [['super+Down', header('Invoices', 'Finder')], ['super+Up', header('Documents', 'Finder')],
  ['super+i', header('Invoices Info', 'Finder')]]) {
  test('quiet-edits reads after ' + key + ' outside a text field', async () => {
    const before = header('Projects', 'Finder') + '\n\t1 row Invoices';
    const code = `await app.click(1); await app.pressKey(${JSON.stringify(key)}); await app.typeText("draft"); await app.pressKey("super+BackSpace");`;
    const advance = (name, args) => name === 'pressKey' && args[0] === key;
    const old = await run(code, { screens: [before, after], advance, expected: win('Projects', 'Finder'), mode: 'old' });
    const now = await run(code, { screens: [before, after], advance, expected: win('Projects', 'Finder'), mode: 'new' });
    assert.match(old.error, /changed window/); assert.equal(old.inputs.length, 2);
    assert.match(now.error, /changed window/);
    assert.deepEqual(now.inputs, old.inputs);
  });
}

// 6. bind: actions that are not clicks never count as openers.
test('bind reads after secondary actions and scrolling', async () => {
  const list = header('Inbox', 'Mail') + '\n\t5 row Invoice March\n\t6 row Invoice April\n\t7 button Archive';
  const scrolled = header('Inbox', 'Mail') + '\n\t5 row Newsletter\n\t6 row Invoice March\n\t7 button Archive';
  for (const first of ['performSecondaryAction(5, "AXShowMenu")', 'scroll(5, "down", 1)']) {
    const code = `await app.${first}; await app.click(6);`;
    const old = await run(code, { screens: [list, scrolled], expected: win('Inbox', 'Mail'), mode: 'old' });
    const now = await run(code, { screens: [list, scrolled], expected: win('Inbox', 'Mail'), mode: 'new' });
    assert.match(old.error, /changed what element 6 is|element 6 changed since you read the window/, first);          // old: re-read, row 6 is another message now
    assert.deepEqual(now.inputs, old.inputs, first);
    assert.match(now.error, /changed what element 6 is|element 6 changed since you read the window/);
  }
});

test('roleless open menu labels match only their complete leading label', () => {
  assert.equal(hasLabel('Scientific, ID: menuAction:', 'Scientific'), true);
  assert.equal(hasLabel('Scientific mode, ID: menuAction:', 'Scientific'), false);
  assert.equal(hasLabel('button Description: Scientific, ID: mode', 'Scientific'), true);
});
