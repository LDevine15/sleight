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

test('a selected menu-bar title warns about a tracking loop while the root is a window', () => {
  for (const prompt of [undefined, 'lean']) {
    const note = openMenuNote(header + '\n' + menu, prompt);
    assert.match(note, prompt === 'lean' ? /possible menu tracking loop/ : /menu may still be open in a tracking loop/);
    assert.match(note, prompt === 'lean' ? /document input won't land/ : /keys and clicks into the document won't land/);
    assert.match(note, /Escape.*click.*menu-bar title/);
    assert.match(note, /Table/);
  }
});

test('selected menu-bar items with an explicit role also warn', () => {
  assert.match(openMenuNote(header + '\n' + menu.replace('(selected) Table', 'menu bar item (selected) Table')), /tracking loop/);
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
  const raw = { getAXState: async () => current(), click: async () => {}, typeText: async () => { changed = true; } };
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
  const reply = await call('await app.click(12); await app.typeText(query);');
  assert.equal(reply.isError, false, JSON.stringify(reply.content));
  const out = reply.content.map(i => i.text).join('\n');
  assert.match(out, warning);
  assert.doesNotMatch(out, /filtered-read|"typed"/);
});
