import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { guardStopMark, takeGuardStop, menuRemainder, splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const window = { title: 'Draft', app: 'Fixture Editor', url: null };
const tree = rows => 'Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n' + rows;
const text = value => ({ type: 'text', text: value });
async function execute(rows, code, options = {}) {
  const output = [], inputs = [], mark = guardStopMark();
  const raw = { getAXState: async () => tree(rows), click: async n => {
    inputs.push(n);
    if (options.engineError) throw new Error(options.engineError);
  }, pressKey: async key => inputs.push(key) };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: value => output.push(String(value)) } };
  let error;
  try { await runInNewContext(`(async () => { ${guardedCode(code, window, undefined, undefined, { guardStopMark: mark, ...options })} })()`, context); }
  catch (e) { error = e; output.push(String(e)); }
  return { inputs, error, taken: takeGuardStop([text(output.join('\n'))], mark) };
}

for (const line of ['close button', 'close button (enabled), ID: window-close',
  'close button Description: Close, ID: window-close']) {
  test('a numbered window close stops before input: ' + line, async () => {
    const f = await execute('\t1 ' + line, 'await app.click(1);');
    assert.deepEqual(f.inputs, []);
    assert.match(f.error?.message ?? '', /element 1 is the window's close button; close a window by label or with Cmd\+W/);
    assert.equal(f.taken.input, false);
    assert.equal(f.taken.receipt?.index, 0);
  });
}

for (const selector of ['"Close"', '{ label: "Close" }', '{ id: "window-close" }']) {
  test('an explicit window close still passes: ' + selector, async () => {
    const f = await execute('\t1 close button Description: Close, ID: window-close', `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [1]);
  });
}

for (const line of ['button Target', 'button Close', 'button Description: close button',
  'button Target, ID: close button', 'minimize button', 'full screen button']) {
  test('other numbered controls still pass: ' + line, async () => {
    const f = await execute('\t1 ' + line, 'await app.click(1);');
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [1]);
  });
}

test('a close number computed from the current read still stops before input', async () => {
  const f = await execute('\t1 close button',
    'const text = await app.getAXState(); const n = Number(/(\\d+) close button/.exec(text)[1]); await app.click(n);',
    { literals: [] });
  assert.deepEqual(f.inputs, []);
  assert.match(f.error?.message ?? '', /element 1 is the window's close button/);
});

for (const selector of ['"Insert"', '{ label: "Insert" }']) {
  test(`one content match beats menu-bar descendants for ${selector}`, async () => {
    const f = await execute('\t1 tab group Ribbon\n\t\t2 tab Insert\n3 menu bar\n\t4 Insert\n\t5 menu Extra\n\t\t6 menu item Insert', `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [2]);
  });
}

for (const [name, rows] of [
  ['two content matches', '\t1 tab group Ribbon\n\t\t2 tab Insert\n\t3 group Tools\n\t\t4 button Insert\n5 menu bar\n\t6 Insert'],
  ['only menu matches', '1 menu bar\n\t2 Insert\n\t3 menu More\n\t\t4 menu item Insert'],
  ['unknown root', '\t1 group Tools\n\t\t2 button Insert\n3 button Insert'],
  ['menu words in a content label', '\t1 group menu bar\n\t\t2 button Insert\n\t3 button Insert'],
]) test(`${name} stays ambiguous and lists candidate numbers and parents`, async () => {
  const f = await execute(rows, 'await app.click({ label: "Insert" });');
  assert.match(f.error?.message ?? '', /elements with label "Insert"/);
  assert.deepEqual(f.inputs, []);
  if (name === 'two content matches') {
    // A menu-bar title among them is named apart from the other elements.
    assert.match(f.error.message, /menu-bar item 6; other elements 2 \(parent tab group Ribbon\), 4 \(parent group Tools\)\./);
    return;
  }
  for (const line of rows.split('\n').filter(line => /(?:tab|button|menu item) Insert$|\d+ Insert$/.test(line))) {
    const number = /\d+/.exec(line)[0];
    assert.match(f.error.message, new RegExp('candidate ' + number + ': parent '));
  }
});

// word-edit-1 and -2 (2026-10-17): { label: "Table" } clicked the menu-bar title, whose menu then trapped typing.
for (const selector of ['"Table"', '{ label: "Table" }']) {
  test(`a menu-bar title loses to the one element outside the menu bar for ${selector}`, async () => {
    // The toolbar is its own root, so no window-content preference applies.
    const f = await execute('3 toolbar Tools\n\t4 button Table\n5 menu bar\n\t6 Insert\n\t7 Table', `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [4]);
  });
  test(`a label only a menu-bar title has still clicks it for ${selector}`, async () => {
    const f = await execute('\t1 button Insert\n5 menu bar\n\t6 Insert\n\t7 Table', `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [7]);
  });
  test(`a menu-bar title and two other elements stop before input, naming both sides, for ${selector}`, async () => {
    const f = await execute('3 toolbar Tools\n\t4 button Table\n8 group Panel\n\t9 button Table\n5 menu bar\n\t7 Table', `await app.click(${selector});`);
    assert.deepEqual(f.inputs, []);
    assert.match(f.error?.message ?? '', /3 elements with label (?:or ID )?"Table" in this window\. menu-bar item 7; other elements 4 \(parent toolbar Tools\), 9 \(parent group Panel\)\./);
  });
}

test('duplicate IDs and full lines never get the content-label preference', async () => {
  for (const selector of ['{ id: "duplicate" }', '{ line: "button Insert, ID: duplicate" }']) {
    const f = await execute('\t1 button Insert, ID: duplicate\n2 menu bar\n\t3 button Insert, ID: duplicate', `await app.click(${selector});`);
    assert.match(f.error?.message ?? '', /2 elements/);
    assert.deepEqual(f.inputs, []);
  }
});

test('the window root itself is not a match inside window content', async () => {
  const f = await execute('1 menu bar\n\t2 Draft', 'await app.click("Draft");');
  assert.match(f.error?.message ?? '', /2 elements with label or ID "Draft"/);
  assert.deepEqual(f.inputs, []);
});

for (const [name, code, options, expected] of [
  ['first label stop', 'await app.click("Missing");', {}, 'no input was sent'],
  ['native denial', 'await app.click("Target");', { nativeDenied: 'native route denied' }, 'no input was sent'],
  ['window stop', 'await app.click("Target");', { }, 'no input was sent'],
  ['later stop', 'await app.click("Target"); await app.click("Missing");', {}, 'partial input possible'],
  ['engine rejection', 'await app.click("Target");', { engineError: 'engine target disappeared' }, 'partial input possible'],
  ['caught stop followed by input', 'try { await app.click("Missing"); } catch {} await app.click("Target");', {}, 'partial input possible'],
  ['cancel then stop', 'await app.pressKey("Escape"); await app.click("Missing");', { fileOnly: true }, 'partial input possible'],
]) test(`${name} reports the cause and actual input boundary`, async () => {
  const f = await execute('\t1 button Target', code, name === 'window stop' ? { ...options, prior: { text: tree('\t1 button Target').replaceAll('Draft', 'Other'), windows: null } } : options);
  const c = createReadCompactor(); c.process([text(tree('\t1 button Target'))]);
  const result = c.process(f.taken.content, { action: c.beginAction(code), failed: true,
    failure: { message: f.taken.receipt?.error, noInput: f.taken.receipt?.index === 0 && !f.taken.input } });
  const note = result.at(-1).text;
  assert.match(note, new RegExp(expected));
  const cause = f.taken.receipt?.error;
  assert.ok(cause && note.includes(cause), note);
  assert.doesNotMatch(JSON.stringify(f.taken.content), /sleight:guard-stop:/);
});

function relayFixture(t, options = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, received = [], sent = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, ...options });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  for (const [stream, messages] of [[clientOut, received], [serverIn, sent]])
    stream.on('data', data => messages.push(...data.toString().trim().split('\n').map(JSON.parse)));
  return { sent, received,
    call: (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    reply: msg => serverOut.write(JSON.stringify(msg) + '\n') };
}

test('the recorded missing-label path puts its buried cause in the final note', t => {
  const f = relayFixture(t), cause = 'sleight stopped before click: no element with label "Missing" in this window.';
  f.call(1, 'await app.click("Missing");');
  f.reply({ id: 1, result: { isError: true, content: [text(tree('\t1 button Target')), text(cause + '\n' + tree('\t1 button Target')), text(tree('\t1 button Target'))] } });
  assert.ok(f.received.at(-1).result.content.at(-1).text.includes(cause));
});

test('engine errors keep their cause in notes with and without an input action', t => {
  const f = relayFixture(t);
  for (const [id, code] of [[1, 'await app.click(1)'], [2, 'await app.getAXState()']]) {
    f.call(id, code);
    f.reply({ id, result: { isError: true, content: [text(tree('\t1 button Target')), text('[7:0]: engine target is unavailable')] } });
    const note = f.received.at(-1).result.content.at(-1).text;
    assert.match(note, id === 1 ? /call failed.*engine target is unavailable/ : /engine target is unavailable/);
    assert.doesNotMatch(note, /no input was sent/);
  }
});

test('JSON-RPC errors repeat their engine cause in the failure note', t => {
  const f = relayFixture(t);
  f.call(1, 'await app.click(1)');
  f.reply({ id: 1, error: { code: -32603, message: 'engine disconnected' } });
  assert.match(f.received.at(-1).error.message, /sleight: call failed.*engine disconnected/);
});

test('an engine rejection or lookup stop never qualifies for automatic menu continuation', () => {
  const plan = splitMenuActions('await app.click("File"); await app.click("Save");');
  const receipt = { index: 1, prev: { kind: 'label', value: 'File' }, root: '0 menu File', windowStop: false };
  assert.equal(menuRemainder(plan, receipt, window, [text('Window: "Draft", App: Fixture Editor.\n0 menu File\n\t1 Save')]), undefined);
});

test('a combined engine output block keeps the error after its tree, without its stack', t => {
  const f = relayFixture(t);
  f.call(1, 'await app.click(1)');
  f.reply({ id: 1, result: { isError: true, content: [text(tree('\t1 button Target') + '\nengine input refused\n    at engine.js:3:1')] } });
  assert.match(f.received.at(-1).result.content.at(-1).text, /call failed.*engine input refused/);
});

for (const [name, code, engineError, expected] of [
  ['first stop', 'await app.click("Missing");', false, 'no input was sent'],
  ['later stop', 'await app.click("Target"); await app.click("Missing");', false, 'partial input possible'],
  ['engine error', 'await app.click("Target");', true, 'partial input possible'],
]) test(`the relay consumes the generated guard record for a ${name}`, async t => {
  const f = relayFixture(t, { changeReview: true });
  const content = tree('\t1 button Target');
  f.call(1, 'let app = await cua.getApp("Fixture Editor");');
  f.reply({ id: 1, result: { content: [text(content)], _meta: { 'codex/toolSurface': { app: { appId: 'org.test.editor' } } } } });
  f.call(2, code);
  const forwarded = f.sent.find(m => m.id === 2);
  assert.ok(forwarded, JSON.stringify(f.received));
  const output = [], inputs = [];
  const raw = { getAXState: async () => content, click: async n => { inputs.push(n); if (engineError) throw new Error('engine refused input'); } };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: value => output.push(String(value)) } };
  try { await runInNewContext(`(async () => { ${forwarded.params.arguments.code} })()`, context); }
  catch (error) { output.push(String(error)); }
  f.reply({ id: 2, result: { isError: true, content: [text(output.join('\n'))] } });
  const result = f.received.at(-1).result;
  assert.match(result.content.at(-1).text, new RegExp(expected));
  assert.match(result.content.at(-1).text, engineError ? /engine refused input/ : /no element with label or ID "Missing"/);
  assert.doesNotMatch(JSON.stringify(result), /sleight:guard-stop:/);
  assert.deepEqual(inputs, name === 'first stop' ? [] : [1]);
});

test('the content-label preference still refuses a different document', async () => {
  const rows = '\t1 group Ribbon\n\t\t2 tab Insert\n3 menu bar\n\t4 Insert';
  const f = await execute(rows, 'await app.click("Insert");', { prior: { text: tree(rows).replaceAll('Draft', 'Other'), windows: null } });
  assert.match(f.error?.message ?? '', /Document scope stopped/);
  assert.deepEqual(f.inputs, []);
});

for (const selector of ['"Apply"', '{ label: "Apply" }']) {
  for (const state of ['disabled', 'disabled, settable']) test(`one enabled label wins over ${state}: ${selector}`, async () => {
    const f = await execute(`\t1 button (${state}) Apply\n\t2 button Apply`, `await app.click(${selector});`);
    assert.equal(f.error, undefined);
    assert.deepEqual(f.inputs, [2]);
  });
}

for (const rows of ['\t1 button Apply\n\t2 button Apply',
  '\t1 button (disabled) Apply\n\t2 button (disabled) Apply',
  '\t1 button Description: Apply, Help: (disabled)\n\t2 button Apply']) {
  test('enabled-label preference keeps ambiguous candidates: ' + rows, async () => {
    const f = await execute(rows, 'await app.click({ label: "Apply" });');
    assert.match(f.error?.message ?? '', /2 elements with label/);
    assert.deepEqual(f.inputs, []);
  });
}

test('enabled-label preference precedes the menu-content preference', async () => {
  const f = await execute('\t1 button (disabled) Apply\n2 menu bar\n\t3 menu item Apply', 'await app.click("Apply");');
  assert.equal(f.error, undefined);
  assert.deepEqual(f.inputs, [3]);
});

test('duplicate IDs do not acquire an enabled-label preference', async () => {
  const f = await execute('\t1 button (disabled) Apply, ID: duplicate\n\t2 button Apply, ID: duplicate', 'await app.click({ id: "duplicate" });');
  assert.match(f.error?.message ?? '', /2 elements with ID/);
  assert.deepEqual(f.inputs, []);
});

test('the enabled-label preference still refuses a different document', async () => {
  const rows = '\t1 button (disabled) Apply\n\t2 button Apply';
  const f = await execute(rows, 'await app.click("Apply");', { prior: { text: tree(rows).replaceAll('Draft', 'Other'), windows: null } });
  assert.match(f.error?.message ?? '', /Document scope stopped/);
  assert.deepEqual(f.inputs, []);
});
