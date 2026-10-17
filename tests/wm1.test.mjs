import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay, openMenuNote } from '../plugins/sleight/lib/relay.mjs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';

const header = 'Window: "Draft", App: Editor.\n0 standard window Draft';
// Reduced exact lines from the 2026-10-17 10:25 word-edit rerun (runs 3 and 1).
const menu = '124 menu bar\n\t129 Insert\n\t132 (selected) Table\n\t133 Window, ID: WindowMenu_MenuItem';
const search = '\t\t\t\t\t\t12 combo box (settable) Description: Search Document, Secondary Actions: Confirm';
const body = '\t\t\t\t\t\t\t29 text entry area (disabled, settable) Description: Page 1 content, Value: Amber';
const beforeBody = body.replace('Amber', 'Report');
const tree = rows => header + '\n' + rows.join('\n');
const item = text => ({ type: 'text', text });
const mark = '[sleight:filtered-read:wm1]';
const warning = /typed text landed in/;

test('a selected menu-bar title gives numbered recovery without promising it will work', () => {
  for (const prompt of [undefined, 'lean']) {
    const note = openMenuNote(header + '\n' + menu, prompt);
    assert.match(note, prompt === 'lean' ? /Menu may trap input/ : /a menu may be stuck open; keys and clicks may not reach the document/);
    assert.match(note, prompt === 'lean' ? /Escape once, then click menu-bar item/ : /Try one Escape; if it stays, click its menu-bar item by number/);
    assert.match(note, /\(`app.click\(132\)`\); if (?:it still stays|still stuck), tell the user/);
    assert.doesNotMatch(note, /closes it|won't land/);
  }
});

test('selected menu-bar items with an explicit role also warn', () => {
  assert.match(openMenuNote(header + '\n' + menu.replace('(selected) Table', 'menu bar item (selected) Table')), /app.click\(132\)/);
});

test('the relay gives full advice once until selection disappears, then starts a new episode', t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const replies = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let id = 0;
  const read = rows => {
    clientIn.write(JSON.stringify({ id: ++id, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.getAXState();' } } }) + '\n');
    serverOut.write(JSON.stringify({ id, result: { content: [item(rows)] } }) + '\n');
    return replies.find(reply => reply.id === id).result.content.map(part => part.text ?? '').join('\n');
  };
  assert.match(read('## Computer Use\n\nNative reference.\n' + header + '\n' + menu), /Escape/);
  for (const rows of [menu, menu.replace('132', '142'), menu.replace('Table', 'Insert')]) {
    const out = read(header + '\n' + rows);
    assert.doesNotMatch(out, /Try one Escape|if it still stays|Escape or a click/);
    const notes = out.split('\n').filter(line => /^sleight:.*menu.*(?:stuck|open)/.test(line));
    assert.ok(notes.length <= 1);
  }
  read('No tree in this reply.');
  assert.doesNotMatch(read(header + '\n' + menu), /Try one Escape/);
  read(header + '\n…(20)');
  assert.doesNotMatch(read(header + '\n' + menu), /Try one Escape/);
  read(header + '\n+ 20 button Save');
  assert.doesNotMatch(read(header + '\n' + menu), /Try one Escape/);
  assert.doesNotMatch(read('## Computer Use\n\nNative reference.\n' + header + '\n' + menu), /Try one Escape/);
  read(header + '\n' + menu.replace('(selected) ', ''));
  assert.match(read(header + '\n' + menu), /Try one Escape/);
});

test('menu warnings require selection under the menu bar and keep Cancel recovery', () => {
  for (const text of [header, header + '\n' + menu.replace('(selected) ', ''),
    header + '\n\t132 (selected) Table', header + '\n124 menu bar\n\t125 File\n126 group\n\t132 (selected) Table',
    header + '\n124 menu bar\n\t125 menu\n\t\t132 row (selected) Table',
    'Window: "", App: Editor.\n0 menu Table\n' + menu]) {
    assert.equal(openMenuNote(text), undefined, text);
  }
  const note = openMenuNote('Window: "", App: Editor.\n0 menu Secondary Actions: Cancel\n' + menu);
  assert.match(note, /performSecondaryAction\(0, "Cancel"\)/);
  assert.doesNotMatch(note, /tracking loop/);
});

function result(after, { code = 'await app.click(12); await app.typeText(query);', typed = ['amber'],
  before = [search, beforeBody], failed = false, overlap = false, suffix = '', otherWindow = false } = {}) {
  const c = createReadCompactor();
  c.process([item(tree(before))]);
  const action = c.beginAction(code);
  if (action) action.overlap = overlap;
  const current = tree(after).replace('App: Editor.', otherWindow ? 'App: Other.' : 'App: Editor.') + suffix;
  return c.process([item(GUARD_MARK + current + GUARD_END + mark + JSON.stringify({ typed }) + '\n')],
    { action, code, failed, filterMark: mark }).map(i => i.text).join('\n');
}

test('runtime typed text in the changed body names it and the clicked Search field once', () => {
  const out = result([search, body]);
  assert.match(out, /typed text landed in element 29 \(Page 1 content\), not in the clicked element 12 \(Search Document\)/);
  assert.equal(out.match(warning)?.length, 1);
  assert.doesNotMatch(out, /filtered-read|"typed"/);
});

test('the word-edit call shape permits a trailing Return and AX read', () => {
  const code = 'await app.click(12); await app.typeText("amber"); await app.pressKey("Return"); await app.getAXState();';
  assert.match(result([search, body], { code }), warning);
  assert.match(result([search, body], { code: 'await app.click(12); await app.typeText(query); await app.getAXState();' }), warning);
  for (const code of ['await app.click(12); await app.pressKey("Return"); await app.typeText(query);',
    'await app.click(12); await app.typeText(query); await other.pressKey("Return");']) {
    assert.doesNotMatch(result([search, body], { code }), warning);
  }
});

test('a field cleared on Return and its newly added row never imply misplaced typing', () => {
  const code = 'await app.click(12); await app.typeText(query); await app.pressKey("Return"); await app.getAXState();';
  const added = '\t13 row\n\t\t14 text field (settable) Description: Task, Value: amber';
  assert.doesNotMatch(result([search, added], { before: [search], code }), warning);
});

test('short input and common text already in the destination stay silent', () => {
  for (const typed of ['a', ' a ', 'ab', '  ab  ']) {
    assert.doesNotMatch(result([search, body.replace('Amber', typed)], { typed: [typed] }), warning);
  }
  assert.doesNotMatch(result([search, body.replace('Amber', 'the report')],
    { before: [search, beforeBody.replace('Report', 'the draft')], typed: ['the'] }), warning);
});

test('new settable elements and matching fields at a different position path stay silent', () => {
  assert.doesNotMatch(result([search, body], { before: [search] }), warning);
  assert.doesNotMatch(result([search, '\t90 group\n' + body], { before: [search, beforeBody] }), warning);
  assert.doesNotMatch(result([search, beforeBody.replace('29 text', '30 text').replace('Page 1 content', 'Other content'), body]), warning);
});

test('the clicked field showing the typed text suppresses the warning even if the body changed too', () => {
  assert.doesNotMatch(result([search.replace(', Secondary', ', Value: amber, Secondary'), body]), warning);
});

test('matching follows a renumbered field and does not confuse its new number with another field', () => {
  assert.match(result([search.replace('12 combo', '14 combo'), body]), warning);
  assert.doesNotMatch(result([search.replace('12 combo', '14 combo').replace(', Secondary', ', Value: Amber, Secondary'), body]), warning);
});

test('unchanged text, labels and Help are not evidence that input landed there', () => {
  for (const [after, options] of [
    [[search, body], { before: [search, body] }],
    [[search, beforeBody + ', Help: amber'], {}],
    [[search, beforeBody.replace('Page 1 content', 'amber')], {}],
    [[search, body], { typed: [] }],
    [[search, body], { typed: ['   '] }],
    [[search, body], { typed: ['different'] }],
  ]) assert.doesNotMatch(result(after, options), warning);
});

test('ambiguous recipients, missing clicked fields and non-settable clicks stay silent', () => {
  for (const [after, options] of [
    [[search, body, body.replace('29 text', '30 text').replace('Page 1 content', 'Other content')], {}],
    [[body], {}],
    [[search, body], { before: [search, search.replace('12 combo', '14 combo'), beforeBody] }],
    [[search, body], { before: [search.replace(' (settable)', ''), beforeBody] }],
  ]) assert.doesNotMatch(result(after, options), warning);
});

test('failed, overlapping, incomplete and different-window observations stay silent', () => {
  for (const options of [{ failed: true }, { overlap: true }, { suffix: '\n…(20)' }, { otherWindow: true }]) {
    assert.doesNotMatch(result([search, body], options), warning);
  }
});

test('typing before the click, another handle, multiple clicks or a focus-moving key stay silent', () => {
  for (const code of ['await app.typeText(query); await app.click(12);',
    'await app.click(12); await other.typeText(query);',
    'await app.click(12); await app.click(29); await app.typeText(query);',
    'await app.click(12); await app.pressKey("Tab"); await app.typeText(query);',
    'await app.click(12); await app.setValue(29, query);']) {
    assert.doesNotMatch(result([search, body], { code }), warning);
  }
});

test('typed receipts coexist with a filtered-read receipt and are removed from the result', () => {
  const c = createReadCompactor();
  const out = c.process([item(mark + JSON.stringify({ full: true }) + '\n' + mark + JSON.stringify({ typed: ['amber'] }) + '\n')],
    { filterMark: mark });
  assert.deepEqual(out, []);
});

test('the document guard emits this call\'s runtime typed value, then resets it on reuse', async () => {
  const output = [];
  const raw = { getAXState: async () => tree([search, beforeBody]), click: async () => {}, typeText: async () => {} };
  const context = createContext({ app: raw, query: 'amber', cua: { getApp: async () => raw }, nodeRepl: { write: text => output.push(text) } });
  const window = { title: 'Draft', app: 'Editor', url: null };
  await runInContext(`(async () => { ${guardedCode('await app.click(12); await app.typeText(query);', window, undefined, undefined, { resultMark: mark })} })()`, context);
  assert.ok(output.includes(mark + JSON.stringify({ typed: ['amber'] }) + '\n'));
  output.length = 0;
  await runInContext(`(async () => { ${guardedCode('await app.click(12);', window, undefined, undefined, { reuseSetup: true, resultMark: mark })} })()`, context);
  assert.ok(!output.some(text => text.startsWith(mark)), 'no previous call\'s typed text');
});

test('the relay carries the runtime receipt into the compactor without driving an app', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-wm1-'));
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const pending = new Map();
  let content = [], changed = false, id = 0;
  const write = text => content.push(item(text));
  const current = () => tree([search, changed ? body : beforeBody]);
  const raw = { getAXState: async () => current(), click: async () => {}, typeText: async () => { changed = true; }, pressKey: async () => {} };
  const context = createContext({ query: 'amber', cua: { getApp: async () => { write(current()); return raw; }, listApps: async () => [] }, nodeRepl: { write } });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'wm1-fixture', changeReview: false,
    inputLease: new InputLease({ directory, holder: 'fixture' }) });
  t.after(() => { relay.dispose(); streams.forEach(s => s.destroy()); rmSync(directory, { recursive: true, force: true }); });
  clientOut.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const msg = JSON.parse(line); pending.get(msg.id)?.(msg.result);
    }
  });
  let queue = Promise.resolve();
  serverIn.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.method !== 'tools/call') continue;
      queue = queue.then(async () => {
        content = [];
        let isError = false;
        try { await runInContext(`(async () => { ${msg.params.arguments.code.replace(/\bvar app\s*=/, 'globalThis.app =')} })()`, context,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (error) { isError = true; write(error.message); }
        serverOut.write(JSON.stringify({ id: msg.id, result: { content, isError, _meta: { 'codex/toolSurface': { app: { appId: 'example.fixture' } } } } }) + '\n');
      });
    }
  });
  const call = code => new Promise(resolve => {
    pending.set(++id, resolve);
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  });
  assert.equal((await call('var app = await cua.getApp("example.fixture")')).isError, false);
  const reply = await call('await app.click(12); await app.typeText("amber"); await app.pressKey("Return"); await app.getAXState();');
  assert.equal(reply.isError, false, JSON.stringify(reply.content));
  const out = reply.content.map(i => i.text).join('\n');
  assert.match(out, warning);
  assert.doesNotMatch(out, /filtered-read|"typed"/);
});
