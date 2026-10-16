import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { createBrowserStaleGuard } from '../plugins/sleight/lib/browser-stale.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const tree = rows => 'Browser tab: 1, Title: "Form", URL: "https://example.com".\n0 AXWebArea Form\n' + rows.join('\n');
function fixture(before, after) {
  const guard = createBrowserStaleGuard(), actions = [], notes = [], reads = [];
  const tab = { id: '1', getAXState: async options => { reads.push(options); return after; } };
  for (const name of ['click', 'setValue', 'typeText', 'pressKey', 'paste', 'scroll', 'selectText', 'performSecondaryAction']) {
    tab[name] = async (...args) => actions.push({ name, args });
  }
  const context = createContext({
    cua: { getTab: async () => tab }, nodeRepl: { write: text => notes.push(text) },
    setTimeout, clearTimeout,
  });
  guard.observe([{ type: 'text', text: before }]);
  const run = code => runInContext(`(async () => { ${guard.code(code)} })()`, context);
  return { guard, actions, notes, reads, run, context, tab };
}

for (const method of ['click', 'setValue', 'typeText', 'pressKey', 'paste', 'scroll', 'selectText', 'performSecondaryAction']) {
  test(`${method} follows one unique labelled row to its current number`, async () => {
    const f = fixture(tree(['\t17 button Continue']), tree(['\t17 button Back', '\t22 button Continue']));
    await f.run(`var tab = await cua.getTab('1', { browser: 'b' }); await tab.${method}(17, 'value');`);
    assert.deepEqual(f.actions, [{ name: method, args: [22, 'value'] }]);
    assert.match(f.notes.join('\n'), /went to element 22.*same.*button Continue/);
    assert.equal(f.reads[0].emit, false);
  });
}

for (const [name, before, after, code] of [
  ['duplicate old label', tree(['\t17 button Continue', '\t18 button Continue']), tree(['\t22 button Continue'])],
  ['duplicate current label', tree(['\t17 button Continue']), tree(['\t22 button Continue', '\t23 button Continue'])],
  ['bare role', tree(['\t17 container']), tree(['\t22 container'])],
  ['multiple literal numbers', tree(['\t17 button Continue']), tree(['\t22 button Continue']), 'await tab.click(17); await tab.click(18);'],
  ['changed document', tree(['\t17 button Continue']), tree(['\t22 button Continue']).replace('/example.com', '/example.org')],
  ['missing old row', tree(['\t18 button Back']), tree(['\t22 button Continue'])],
]) test(`${name} never follows a stale number`, async () => {
  const f = fixture(before, after);
  await assert.rejects(f.run(`var tab = await cua.getTab('1', { browser: 'b' }); ${code ?? 'await tab.click(17);'}`), /sleight stopped before/);
  assert.deepEqual(f.actions, []);
});

test('an unchanged row uses the original number and null input passes through', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t17 button Continue']));
  await f.run("var tab = await cua.getTab('1'); await tab.click(17); await tab.typeText(null, 'hello');");
  assert.deepEqual(f.actions.map(a => a.args[0]), [17, null]);
  assert.deepEqual(f.notes, []);
});

test('only the visible full tree is used, hidden reads do not replace it', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  await f.run("globalThis.tab = await cua.getTab('1'); await tab.getAXState({ emit: false });");
  await f.run('await tab.click(17);');
  assert.equal(f.actions[0].args[0], 22);
});

test('cut or diff trees cannot establish a unique old label', async () => {
  for (const before of [tree(['\t17 button Continue']) + '\nsleight: 100 browser tree lines omitted.', tree(['+ \t17 button Continue'])]) {
    const f = fixture(before, tree(['\t22 button Continue']));
    await f.run("var tab = await cua.getTab('1'); await tab.click(17);");
    assert.equal(f.actions[0].args[0], 17, 'without a complete baseline the engine handles the original number');
    assert.deepEqual(f.notes, []);
  }
});

test('computed indices use the caller own read rather than an old literal baseline', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  await f.run("var tab = await cua.getTab('1'); var number = 22; await tab.click(number);");
  assert.equal(f.actions[0].args[0], 22);
  assert.deepEqual(f.notes, []);
});

test('strings, comments and quoted regex characters do not invent or hide numbered actions', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  await f.run(`var tab = await cua.getTab('1'); var example = 'tab.click(88)'; var re = /'/;
    // tab.click(99)
    await tab.click(17);`);
  assert.equal(f.actions[0].args[0], 22);
});

test('a failed fresh read sends no input', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  await f.run("globalThis.tab = await cua.getTab('1');");
  await f.run('tab.getAXState = async () => { throw new Error("read failed"); };');
  await assert.rejects(f.run('await tab.click(17);'), /read failed/);
  assert.deepEqual(f.actions, []);
});

test('a later cut tree invalidates an earlier complete baseline', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  f.guard.observe([{ type: 'text', text: tree(['\t17 button Continue']) + '\nsleight: 30 browser tree lines omitted.' }]);
  await f.run("var tab = await cua.getTab('1'); await tab.click(17);");
  assert.equal(f.actions[0].args[0], 17);
  assert.deepEqual(f.notes, []);
});

test('the same tab number in two acquired browsers cannot be followed', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  const other = { ...f.tab };
  f.context.cua.getTab = async (id, options) => options.browser === 'one' ? f.tab : other;
  await assert.rejects(f.run("var a = await cua.getTab('1', {browser:'one'}); var b = await cua.getTab('1', {browser:'two'}); await a.click(17);"), /sleight stopped before/);
  assert.deepEqual(f.actions, []);
});

test('browser.tabs.new returns a guarded handle', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  f.context.cua.getBrowser = async () => ({ browserId: 'b', tabs: { new: async () => f.tab } });
  await f.run("var browser = await cua.getBrowser({id:'b'}); var tab = await browser.tabs.new(); await tab.click(17);");
  assert.equal(f.actions[0].args[0], 22);
});

test('relay supplies the last visible tab rows to the next browser call', () => {
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  try {
    clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: "var tab = await cua.getTab('1')" } } }) + '\n');
    serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: tree(['\t17 button Continue']) }] } }) + '\n');
    clientIn.write(JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: 'await tab.click(17)' } } }) + '\n');
    assert.match(sent.at(-1).params.arguments.code, /button Continue/);
    assert.match(sent.at(-1).params.arguments.code, /__sleightBrowserStale/);
  } finally { relay.dispose(); }
});

test('a no-change read keeps the existing baseline', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  f.guard.observe([{ type: 'text', text: 'There has been no change in the accessibility tree.' }]);
  await f.run("var tab = await cua.getTab('1'); await tab.click(17);");
  assert.equal(f.actions[0].args[0], 22);
});

test('a no-change banner under the tab header keeps the existing baseline', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  f.guard.observe([{ type: 'text', text: 'Browser tab: 1, Title: "Form", URL: "https://example.com".\nThere has been no change in the accessibility tree.' }]);
  await f.run("var tab = await cua.getTab('1'); await tab.click(17);");
  assert.equal(f.actions[0].args[0], 22);
});

test('a title-only header change still uses the original number when the row is the same', async () => {
  const after = tree(['\t17 button Continue']).replace('Title: "Form"', 'Title: "Cart (2)"');
  const f = fixture(tree(['\t17 button Continue']).replace('Title: "Form"', 'Title: "Cart (1)"'), after);
  await f.run("var tab = await cua.getTab('1'); await tab.click(17);");
  assert.deepEqual(f.actions, [{ name: 'click', args: [17] }]);
  assert.deepEqual(f.notes, []);
});

test('two numbered actions on one index in a call both run after the row shows a value', async () => {
  const before = tree(['\t5 text field Email']);
  const typed = tree(['\t5 text field Email, Value: abc']);
  let reads = 0;
  const f = fixture(before, before);
  f.tab.getAXState = async options => { reads++; return reads === 1 ? before : typed; };
  await f.run("var tab = await cua.getTab('1'); await tab.setValue(5, 'abc'); await tab.pressKey(5, 'Return');");
  assert.deepEqual(f.actions, [{ name: 'setValue', args: [5, 'abc'] }, { name: 'pressKey', args: [5, 'Return'] }]);
});

test('a followed number is reused on the next action in the same call', async () => {
  const start = tree(['\t5 text field Email']);
  const shifted = tree(['\t5 button Back', '\t6 text field Email']);
  const typed = tree(['\t5 button Back', '\t6 text field Email, Value: abc']);
  let reads = 0;
  const f = fixture(start, start);
  f.tab.getAXState = async () => { reads++; return reads === 1 ? shifted : typed; };
  await f.run("var tab = await cua.getTab('1'); await tab.setValue(5, 'abc'); await tab.pressKey(5, 'Return');");
  assert.deepEqual(f.actions, [
    { name: 'setValue', args: [6, 'abc'] },
    { name: 'pressKey', args: [6, 'Return'] },
  ]);
  assert.match(f.notes.join('\n'), /went to element 6/);
});

test('a second click on the same index after navigation is refused', async () => {
  const start = tree(['\t5 button Continue']);
  const next = tree(['\t5 button Back']);
  let reads = 0;
  const f = fixture(start, start);
  f.tab.getAXState = async () => { reads++; return reads === 1 ? start : next; };
  await assert.rejects(
    f.run("var tab = await cua.getTab('1'); await tab.click(5); await tab.click(5);"),
    /sleight stopped before click\(5\)/);
  assert.deepEqual(f.actions, [{ name: 'click', args: [5] }]);
});

test('a tab read that never answers lets the action through after 1.5 s', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue']));
  f.tab.getAXState = () => new Promise(() => {});
  await f.run("var tab = await cua.getTab('1'); await tab.click(17);");
  assert.deepEqual(f.actions, [{ name: 'click', args: [17] }]);
  assert.match(f.notes.join('\n'), /timed out after 1\.5 s/);
});

test('a refusal includes the fresh tab tree', async () => {
  const f = fixture(tree(['\t17 button Continue']), tree(['\t22 button Continue', '\t23 button Continue']));
  await assert.rejects(f.run("var tab = await cua.getTab('1'); await tab.click(17);"), err => {
    assert.match(err.message, /sleight stopped before click\(17\)/);
    assert.match(err.message, /22 button Continue/);
    assert.match(err.message, /23 button Continue/);
    return true;
  });
  assert.deepEqual(f.actions, []);
});

test('a refused multi-index call includes its unique current row from the existing read', async () => {
  const f = fixture(tree(['\t17 button Continue, ID: continue', '\t18 button Cancel, ID: cancel']),
    tree(['\t17 button Back', '\t22 button Continue, ID: continue, Value: current', '\t23 button Cancel, ID: cancel']));
  await assert.rejects(f.run("var tab = await cua.getTab('1', {browser:'one'}); await tab.click(17); await tab.click(18);"), err => {
    assert.match(err.message, /Current unique row 22:.*button Continue, ID: continue, Value: current/);
    return true;
  });
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.actions, []);
});

test('a followed row reports its bounded current identity instead of an unbounded old line', async () => {
  const row = 'button Continue, ID: continue, Description: ' + 'x'.repeat(2000);
  const f = fixture(tree(['\t17 ' + row]), tree(['\t22 ' + row]));
  await f.run("var tab = await cua.getTab('1', {browser:'one'}); await tab.click(17);");
  const note = f.notes.join('\n');
  assert.match(note, /Current unique row 22:.*ID: continue/);
  assert.match(note, /truncated/);
  assert.ok(note.length < 700, note.length);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.actions.map(a => a.args[0]), [22]);
});

for (const [label, after] of [
  ['missing', tree(['\t22 button Other'])],
  ['duplicate', tree(['\t22 button Continue, ID: continue', '\t23 button Continue, ID: continue'])],
  ['previous page', tree(['\t22 button Continue, ID: continue']).replace('example.com', 'other.example')],
]) test(`${label} refuses without a current identity hint`, async () => {
  const f = fixture(tree(['\t17 button Continue, ID: continue']), after);
  await assert.rejects(f.run("var tab = await cua.getTab('1', {browser:'one'}); await tab.click(17);"), err => {
    assert.doesNotMatch(err.message, /Current unique row/);
    return true;
  });
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.actions, []);
});
