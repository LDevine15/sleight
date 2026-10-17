// AN2: results and stops that make the next call right the first time (finder-move-2 and
// textedit-calculator-2, 2026-10-17). Each test fails with its change reverted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { guardedCode, disabledLabelNote } from '../plugins/sleight/lib/document-scope.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const expected = { title: 'Files', app: 'Files', url: null };
const header = (window = expected) => `Window: ${JSON.stringify(window.title)}, App: ${window.app}.`;
const listing = header() + '\n0 standard window Files\n\t1 row (selected)\n\t\t2 cell Value: alpha.txt\n\t3 row (selectable)\n\t\t4 cell Value: Archive\n\t5 button Open';
// The Edit menu as finder-move-2's line 104 read it, trimmed.
const editMenu = header() + '\n0 Edit, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel\n' +
  ['2 Undo Move of “alpha.txt”', '3 (disabled) Redo', '4 (disabled) Cut', '5 Copy “alpha.txt”', '6 Paste Item',
    '7 (disabled) Move Item Here', '8 Emoji & Symbols, ID: orderFrontCharacterPalette:'].map(row => '\t\t' + row).join('\n');

function fixture(current = () => listing, action = () => {}) {
  const calls = [], output = [], acquired = [];
  const raw = { async getAXState() { calls.push(['read']); return current(); } };
  for (const name of ['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']) {
    raw[name] = async (...args) => { calls.push([name, ...args]); return action(name, args); };
  }
  const context = { app: raw, setTimeout, nodeRepl: { write: value => output.push(value), emitImage: async () => {} },
    cua: { getApp: async (...args) => { acquired.push(args); return raw; }, listApps: async () => [] } };
  const run = (code, options = {}) => runInNewContext(`(async () => { ${guardedCode(code, expected, 'changed window', undefined, { focused: true, ...options })} })()`, context);
  return { run, calls, output, acquired };
}
const inputs = calls => calls.filter(([name]) => name !== 'read');

test('a click with an unsupported locator object stops before input and lists the forms that work', async () => {
  const f = fixture();
  await assert.rejects(f.run('await app.click({ ref: 4 }, { clickCount: 2 });'), error => {
    assert.match(error.message, /^sleight stopped before click\(\{"ref":4\}, \{"clickCount":2\}\): that object names no element/);
    assert.match(error.message, /as in click\(4\)/);
    for (const form of ['[x, y] point', 'label or ID string', '{ id: "<ID>" }', '{ label: "<label>" }', '{ line: ']) assert.ok(error.message.includes(form), form);
    return true;
  });
  assert.deepEqual(inputs(f.calls), []);
  // Supported objects still resolve.
  await f.run('await app.click({ label: "Open" });');
  assert.deepEqual(JSON.parse(JSON.stringify(inputs(f.calls))), [['click', 5]]);
});

test('getApp with a window ID of 0 fails before the engine, and the result says so even when the code caught it', async () => {
  const f = fixture();
  await f.run('let other = await cua.getApp({ windowId: 0 }).catch(() => null); await app.click(2);');
  assert.deepEqual(f.acquired, []);
  const note = f.output.find(text => String(text).startsWith('sleight: an action in this call failed'));
  assert.ok(note, f.output.join('\n'));
  assert.match(note, /getApp: cua\.getApp\(\{ windowId: 0 \}\) names no window/);
  assert.match(note, /call select_window with the app and its exact title or file URL, then let <handle> = await cua\.getApp\("<app>"\)/);
  // A positive window ID still goes to the engine.
  await f.run('let other = await cua.getApp({ windowId: 7 });');
  assert.equal(JSON.stringify(f.acquired), '[[{"windowId":7}]]');
});

test('a label only a disabled menu item has stops with that item and the enabled items beside it', async () => {
  for (const [label, number] of [['Cut', 4], ['Move Item Here', 7]]) {
    const f = fixture(() => editMenu);
    await assert.rejects(f.run(`await app.click({ label: ${JSON.stringify(label)} });`), error => {
      const first = error.message.split('\n')[0];
      assert.equal(first, `sleight stopped before click: ${JSON.stringify(label)} is element ${number}, and it is disabled. ` +
        'Enabled beside it: 2 Undo Move of “alpha.txt”, 5 Copy “alpha.txt”, 6 Paste Item, 8 Emoji & Symbols. ' +
        'A disabled item needs a selection or an earlier step, such as Copy before Paste or Move.');
      assert.match(error.message, /\nWindow: "Files"/);
      return true;
    });
    assert.deepEqual(inputs(f.calls), []);
  }
  // A label nothing has keeps the old stop.
  const f = fixture(() => editMenu);
  await assert.rejects(f.run('await app.click({ label: "Delete" });'), /no element with label "Delete" in this window/);
  assert.equal(disabledLabelNote(editMenu, 'Copy “alpha.txt”'), undefined);
});

test('an app-switch stop names the actions that ran, the ones that did not, and the call that switches', async () => {
  let switched = false;
  const other = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator\n\t9 Edit';
  const f = fixture(() => switched ? other : listing, name => { if (name === 'pressKey') switched = true; });
  await assert.rejects(f.run('await app.click(2); await app.pressKey("super+c"); await app.click({ label: "Edit" }); await app.click({ label: "Paste" });', { adoptUrl: true }), error => {
    const first = error.message.split('\n')[0];
    assert.ok(first.startsWith('Input lease stopped this action: app changed. 2 earlier actions in this call ran, in Files: click(2), pressKey("super+c"). ' +
      'Not run: this click({"label":"Edit"}) and every action after it; nothing was sent to Calculator. The lease moves to Calculator. ' +
      'Send the actions that didn\'t run in a new call that starts with let <handle> = await cua.getApp("Calculator") and acts through that handle, without select_window.'), first);
    assert.match(first, /One call acts in one app: to switch apps, end the call and start the next with that app's getApp\./);
    return true;
  });
  assert.deepEqual(inputs(f.calls).map(([name]) => name), ['click', 'pressKey']);
});

test('select_window that finds no window names the titles the app has now', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/select-window.js', import.meta.url), 'utf8');
  const app = { bundleIdentifier: 'fixture.files', localizedName: 'Files', bundleURL: { isNil: () => false, path: '/Applications/Files.app' },
    processIdentifier: 1, active: false };
  const list = entries => ({ count: entries.length, objectAtIndex: i => entries[i] });
  const $ = key => key;
  Object.assign($, { NSWorkspace: { sharedWorkspace: { runningApplications: list([app]), frontmostApplication: { processIdentifier: 2 } } } });
  const windows = ['Archive', 'Downloads'].map(title => ({ attributes: { byName: key => ({ value: () => key === 'AXTitle' ? title : null }) },
    actions: { byName: () => ({ perform: () => { throw new Error('no AX action expected'); } }) } }));
  const result = JSON.parse(runInNewContext(source + '\nrun([JSON.stringify({ app: "Files", title: "Files-49d38066" })])', { $,
    Application: () => ({ processes: { whose: () => () => [{ windows: () => windows }] } }), ObjC: { import() {}, unwrap: x => x } }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Expected exactly one matching window, found 0. Files\'s windows now: "Archive", "Downloads". ' +
    'A window that navigated or was renamed is still the same window: select it by the title it has now, or act on it through the handle you have.');
});

test('a native Cut says sleight cannot see whether it took effect; a Copy alone keeps the short notice', async () => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = [];
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  serverIn.resume();
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, clipboardIO: async () => {} });
  try {
    for (const [id, key] of [[1, 'super+x'], [2, 'super+c']]) {
      clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: `app.pressKey("${key}")` } } }) + '\n');
      await setImmediate();
      serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'engine result' }] } }) + '\n');
      await setImmediate();
    }
    const text = id => replies.find(reply => reply.id === id).result.content.map(c => c.text).join(' ');
    assert.match(text(1), /sleight can't see whether Cut took effect: an app that disables Cut for the selection ignores the key, and its Edit menu shows Cut disabled\. Copy works there\./);
    assert.match(text(2), /native clipboard.*not restored/i);
    assert.doesNotMatch(text(2), /Cut took effect/);
  } finally { await relay.close(); }
});
