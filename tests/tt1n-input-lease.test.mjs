import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext, constants } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const document = 'Window: "report.txt", App: Fixture Editor.\n0 standard window report.txt, URL: file:///tmp/report.txt\n\t1 menu bar\n\t\t2 File, ID: file-menu\n\t3 button Other';
const menu = 'Window: "report.txt", App: Fixture Editor.\n0 File, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel\n\t\t4 Save, ID: save-item';
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

// TT1N's string-read VM fixture, now joined to the real relay. Native truth stays outside
// the engine realm: only the relay's injected read-only identity helper can observe it.
async function fixture(t, { initial, base = document, after = menu, nativeChange, identity, afterItem = after, actionOutput = false,
  retryFirst, beforeRetry, onAction, onRead, ...options } = {}) {
  let text = base, writes = [];
  const clicks = [], keys = [], values = [], typed = [], sent = [], received = [];
  let identityChecks = 0;
  const native = { windowNumber: 22, hidIdleSeconds: 1000, status: 'ok' };
  // onAction(name, argument, text) returns the window an action leaves, for a scripted sequence.
  const raw = { getAXState: async () => { onRead?.(); return text; }, click: async number => {
    clicks.push(number); text = onAction ? onAction('click', number, text) : clicks.length === 1 ? after : afterItem;
    if (actionOutput) writes.push('clicked:' + number);
    if (nativeChange === 'window') native.windowNumber = 23;
    if (nativeChange === 'focus') native.hidIdleSeconds = 0;
    if (nativeChange === 'unfocused') native.status = 'mismatch';
  }, pressKey: async key => {
    keys.push(key); text = onAction ? onAction('pressKey', key, text) : keys.length + clicks.length === 1 ? after : afterItem;
    if (nativeChange === 'window') native.windowNumber = 23;
    if (nativeChange === 'focus') native.hidIdleSeconds = 0;
    if (nativeChange === 'unfocused') native.status = 'mismatch';
  }, setValue: async (number, value) => { values.push([number, value]); if (onAction) text = onAction('setValue', number, text); },
  typeText: async value => { typed.push(value); if (onAction) text = onAction('typeText', value, text); } };
  const context = createContext({ cua: { getApp: async () => raw, listApps: async () => [
    { id: 'org.test.editor', windows: [{ title: 'report.txt' }] }
  ] }, nodeRepl: { write: value => writes.push(String(value)) } });
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-tt1n-'))));
  const inputLease = new InputLease({ directory, holder: 'TT1N2 test' });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false,
    windowIdentity: async expected => { identityChecks++; return identity ? identity(expected, native, identityChecks) : ({ ...expected, ...native,
      matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 }); }, ...options });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let next = 0, cursor = 0, retried = false;
  const call = async (code, name = 'js') => {
    const id = ++next;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n');
    for (let i = 0; i < (retryFirst ? 1500 : 100); i++) {
      await tick();
      while (cursor < sent.length) {
        const request = sent[cursor++]; writes = [];
        if (retryFirst && next > 1 && !retried) {
          retried = true; beforeRetry(native);
          serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: true,
            content: [{ type: 'text', text: 'Sky Computer Use native pipe startup failed' }] } }) + '\n');
          continue;
        }
        let error;
        try { await runInContext(`(async () => { ${request.params.arguments.code} })()`, context,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (e) { error = e; }
        // Acquisitions print their header in the real engine even without an explicit read.
        if (/cua\.getApp\(/.test(request.params.arguments.code) && !error) writes.push(text);
        if (error) writes.push(String(error));
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: !!error,
          content: [{ type: 'text', text: writes.join('\n') }],
          _meta: { 'codex/toolSurface': { app: { appId: 'org.test.editor' } } } } }) + '\n');
      }
      const reply = received.find(msg => msg.id === id);
      if (reply) return reply.result;
    }
    throw new Error('Fixture did not receive a client result');
  };
  await call('await cua.getApp("Fixture Editor");');
  // The setup read's process probe doesn't count.
  sent.length = received.length = 0; cursor = 0; text = initial ?? base; identityChecks = 0;
  return { clicks, keys, values, typed, native, sent, received, relay, call, send: msg => clientIn.write(JSON.stringify(msg) + '\n'), identityChecks: () => identityChecks, setText: value => { text = value; } };
}

const navigation = 'Window: "Parent", App: Fixture Editor.\n0 standard window Parent, URL: file:///tmp/Parent\n\t2 row Child, ID: child\n\t3 button Other';
const child = navigation.replaceAll('Parent', 'Child');
for (const action of ['pressKey("Super+Down")', 'pressKey("Super+Up")', 'pressKey("Return")',
  'click("Child")', 'click({ id: "child" })', 'click(2)', 'click([20, 40])']) {
  test(`TW2: own ${action} retitles the same window and continues once`, async t => {
    const h = await fixture(t, { base: navigation, after: child });
    const result = await h.call(`await app.${action}; await app.pressKey("Tab");`);
    assert.notEqual(result.isError, true);
    assert.equal(h.sent.length, 2);
    assert.equal(h.received.length, 1);
    assert.equal(h.identityChecks(), 3, 'shared admission baseline, post-stop, and immediately before forwarding');
    assert.equal(h.keys.at(-1), 'Tab');
    assert.doesNotMatch(JSON.stringify(result), /guard-stop|window or URL changed/);
  });
}

for (const [name, options] of [
  ['another window number', { nativeChange: 'window' }],
  ['user HID input', { nativeChange: 'focus' }],
  ['lost focus', { nativeChange: 'unfocused' }],
  ['sheet root', { after: child.replace('standard window', 'sheet') }],
  ['dialog root', { after: child.replace('standard window', 'dialog') }],
  ['nested sheet', { after: child + '\n\t4 sheet Confirm' }],
  ['another app', { after: child.replace('App: Fixture Editor.', 'App: Other Editor.') }],
  ['careful mode', { guardMode: 'careful' }],
  ['a document opened into the window', { after: child + '\n\t4 text area (settable) Value: draft' }],
  ['a page opened into the window', { after: child + '\n\t4 web area Child page' }],
  ['a page whose role is capitalized', { after: child + '\n\t4 HTML Content Child page' }],
]) test(`TW2: navigation stops on ${name}`, async t => {
  const h = await fixture(t, { base: navigation, after: child, ...options });
  const result = await h.call('await app.pressKey("Return"); await app.click("Other");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, ['Return']);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.sent.length, 1);
});

test('TW2: a second navigation in the remainder stops the following action', async t => {
  const h = await fixture(t, { base: navigation, after: child, afterItem: navigation });
  const result = await h.call('await app.pressKey("Return"); await app.pressKey("Return"); await app.click("Other");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, ['Return', 'Return']);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.sent.length, 2);
});

for (const shape of ['menu', 'navigation']) for (const failure of ['hid', 'window', 'focus', 'error', 'missing', 'timeout']) {
  test(`TW2: ${shape} returns its original stop when final evidence fails (${failure})`, async t => {
    const h = await fixture(t, { ...(shape === 'navigation' ? { base: navigation, after: child } : {}),
      menuContinuationTimeoutMs: 5, identity: async (expected, native, count) => {
        const observed = { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
        if (count !== 3) return observed;
        if (failure === 'error') throw Error('final check unavailable');
        if (failure === 'missing') return {};
        if (failure === 'timeout') return new Promise(() => {});
        return { ...observed, ...(failure === 'hid' ? { hidIdleSeconds: 0 } :
          failure === 'window' ? { windowNumber: 23 } : { status: 'mismatch' }) };
      } });
    const result = await h.call(shape === 'navigation' ? 'await app.pressKey("Return"); await app.click("Other");' :
      'await app.click("File"); await app.click("Save");');
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /window or URL changed/);
    assert.doesNotMatch(JSON.stringify(result), /guard-stop/);
    assert.equal(h.sent.length, 1);
    assert.equal(h.identityChecks(), 3);
    assert.equal(h.received.length, 1);
    assert.deepEqual(h.clicks, shape === 'menu' ? [2] : []);
  });
}

test('TW2: final refusal releases a pending clipboard transaction and returns the original stop', async t => {
  let held = false;
  const h = await fixture(t, { clipboardMode: 'preserve', clipboardIO: async request => {
    if (request.op === 'acquire') { assert.equal(held, false); held = true; }
    if (request.op === 'release') held = false;
    if (request.op === 'read') return { count: 1, items: [] };
  }, identity: async (expected, native, count) => ({ ...expected, ...native, matches: 1,
    epoch: 'helper', window: 1, pid: 123, processStart: 1, ...(count === 3 ? { hidIdleSeconds: 0 } : {}) }) });
  const result = await h.call('await app.click("File"); await app.pressKey("Super+C");');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /window or URL changed/);
  assert.equal(held, false);
  assert.deepEqual(h.clicks, [2]);
  assert.deepEqual(h.keys, []);
  assert.equal(h.sent.length, 1);
});

test('TW2: input during remainder clipboard preparation is caught by the final check', async t => {
  let h, acquisitions = 0, held = false;
  h = await fixture(t, { clipboardMode: 'preserve', clipboardIO: async request => {
    if (request.op === 'acquire') { acquisitions++; held = true; }
    if (request.op === 'release') held = false;
    if (request.op === 'read') {
      if (acquisitions === 2) h.native.hidIdleSeconds = 0;
      return { count: 1, items: [] };
    }
  } });
  const result = await h.call('await app.click("File"); await app.pressKey("Super+C");');
  assert.equal(result.isError, true);
  assert.equal(acquisitions, 2);
  assert.equal(h.identityChecks(), 3);
  assert.equal(held, false);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.keys, []);
});

test('TW2: a late final helper result cannot forward after the deadline', async t => {
  let finish;
  const h = await fixture(t, { menuContinuationTimeoutMs: 5, identity: async (expected, native, count) => {
    const observed = { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
    return count === 3 ? new Promise(resolve => { finish = () => resolve(observed); }) : observed;
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  finish(); await tick();
  assert.equal(h.received.length, 1);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.clicks, [2]);
});

test('TW2: disposal during final evidence collection never forwards the remainder', async t => {
  let h;
  h = await fixture(t, { identity: async (expected, native, count) => {
    if (count === 3) h.relay.dispose();
    return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.clicks, [2]);
});

test('TW2: helper startup retry cannot reset the original call forwarding time', async t => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const h = await fixture(t, { retryFirst: true, beforeRetry: native => {
    now = 2100; native.hidIdleSeconds = 0.15;
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /window or URL changed/);
  assert.equal(h.sent.length, 2, 'only the original call and its startup retry');
  assert.deepEqual(h.clicks, [2]);
});

for (const [kind, first, second] of [['label', '{ label: "File" }', '{ label: "Save" }'],
  ['ID', '{ id: "file-menu" }', '{ id: "save-item" }']]) {
  test(`TT1N: own ${kind} click opens the matching menu before its item click`, async t => {
    const h = await fixture(t);
    const result = await h.call(`await app.click(${first}); await app.click(${second});`);
    assert.deepEqual(h.clicks, [2, 4]);
    assert.notEqual(result.isError, true);
    assert.equal(h.received.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /sleight:guard-stop|window or URL changed/);
  });
}

const cases = [
  ['the same menu without a preceding click in this call', { initial: menu }, 'await app.click("Save");', []],
  ['a different native window number with the same menu text', { nativeChange: 'window' }],
  ['focus leaving and returning with the same menu text', { nativeChange: 'focus' }],
  ['a focused window change', { nativeChange: 'unfocused' }],
  ['a retitled ordinary window', { after: document.replaceAll('report.txt', 'other.txt') }],
  ['another app', { after: menu.replace('App: Fixture Editor.', 'App: Other Editor.') }],
  ['a numeric click', {}, 'await app.click(2); await app.click("Save");'],
  ['an ordinary button click', {}, 'await app.click("Other"); await app.click("Save");', [3]],
  ['a different menu title', { after: menu.replace('0 File,', '0 Edit,') }],
  ['a helper error', { identity: async () => { throw Error('helper unavailable'); } }],
  ['missing native fields', { identity: async () => ({ status: 'ok' }) }],
  ['a helper timeout', { identity: () => new Promise(() => {}), menuContinuationTimeoutMs: 5 }],
  ['code that does not split', {}, 'if (true) { await app.click("File"); await app.click("Save"); }'],
];
for (const [name, options, code = 'await app.click("File"); await app.click("Save");', clicks = [2]] of cases) {
  test(`TT1N: ${name} stops`, async t => {
    const h = await fixture(t, options);
    const result = await h.call(code);
    assert.equal(result.isError, true);
    assert.deepEqual(h.clicks, clicks);
    assert.doesNotMatch(JSON.stringify(result), /sleight:guard-stop:/);
  });
}

test('TT1N: a second header change in the rest stops before the following action', async t => {
  const h = await fixture(t, { afterItem: document });
  const result = await h.call('await app.click("File"); await app.click("Save"); await app.click("Other");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2, 4]);
  assert.equal(h.sent.length, 2);
});

for (const failure of ['error', 'missing', 'timeout']) test(`TT1N: ${failure} from the fresh post-stop helper stops`, async t => {
  const h = await fixture(t, { menuContinuationTimeoutMs: 5, identity: async (expected, native, count) => {
    if (count === 2) {
      if (failure === 'error') throw Error('post-stop helper unavailable');
      if (failure === 'missing') return { status: 'ok' };
      return new Promise(() => {});
    }
    return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.equal(h.identityChecks(), 2);
  assert.deepEqual(h.clicks, [2]);
  assert.equal(h.sent.length, 1);
});

test('TT1N: a role-menu root also continues and preserves head output before tail output', async t => {
  const h = await fixture(t, { after: menu.replace('0 File, Secondary Actions: Cancel, Pick', '0 menu File'), actionOutput: true });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.deepEqual(h.clicks, [2, 4]);
  const output = result.content.map(c => c.text ?? '').join('\n');
  assert.ok(output.indexOf('clicked:2') < output.indexOf('clicked:4'));
  assert.doesNotMatch(output, /guard-stop|window or URL changed/);
  assert.notEqual(result.isError, true);
});

for (const mode of ['document', 'review']) test(`TT1N: ${mode} mode never probes or continues a stopped call`, async t => {
  const base = document.replace(', URL: file:///tmp/report.txt', '');
  const h = await fixture(t, { base, after: menu.replace('0 File,', '0 File, URL: file:///tmp/other.txt,'),
    ...(mode === 'document' ? { approvalScope: 'document', ask: async () => 'accept' } : { changeReview: true }) });
  if (mode === 'document') {
    await h.call(undefined, 'document_scope'); h.received.length = 0;
  }
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.identityChecks(), 0);
});

test('TT1N: flow rules still refuse the whole call before its opening click', async t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = await fixture(t, { flowRules });
  const result = await h.call('await app.click("File"); await app.click("Save"); await app.typeText("SECRET");');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /secret/);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.sent.length, 0);
});

test('TT1N: a late post-stop helper result cannot resume after its timeout', async t => {
  let finish;
  const h = await fixture(t, { menuContinuationTimeoutMs: 5, identity: async (expected, native, count) => {
    const observed = { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
    return count === 2 ? new Promise(resolve => { finish = () => resolve(observed); }) : observed;
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  finish(); await tick();
  assert.deepEqual(h.clicks, [2]);
  assert.equal(h.received.length, 1);
  assert.equal(h.sent.length, 1);
});

test('TT1N: disposal during the fresh helper check prevents the remainder', async t => {
  let h;
  h = await fixture(t, { identity: async (expected, native, count) => {
    if (count === 2) h.relay.dispose();
    return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2]);
  assert.equal(h.sent.length, 1);
});

// DR1: Word's Replace All alert (word-edit, 2026-10-17). The lease moved from the document to the alert; the next
// call's OK closed it and the rest stopped as 'window changed' in 7 of 8 runs.
const page = 'Window: "report.txt", App: Fixture Editor.\n0 standard window report.txt, URL: file:///tmp/report.txt\n\t1 text area (settable) Value: draft\n\t2 button Replace All';
const alert = 'Window: "", App: Fixture Editor.\n0 dialog Description: alert\n\t1 text All done. We made 1 replacement.\n\t2 button OK, ID: ok';
const dialogIdentity = (expected, native) => ({ ...expected, ...native, matches: 1, headerMatches: 1, epoch: 'helper', pid: 123, processStart: 1,
  ...(expected.title === '' ? { windowNumber: 31, window: 2 } : { window: 1 }) });
async function dialogFixture(t, { bare, ...options } = {}) {
  const h = await fixture(t, bare ? { base: alert, after: page, identity: dialogIdentity, ...options } :
    { base: page, after: alert, afterItem: options.base ?? page, identity: dialogIdentity, ...options });
  if (!bare) assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /\\n0 dialog /);
  const start = h.sent.length;
  return { ...h, sentSince: () => h.sent.length - start };
}
const dismiss = 'await app.click({ id: "ok" }); await app.pressKey("super+End");';
// The document loses focus once the alert is up (the alert's own probe has an empty title).
const lostFocus = () => {
  let alerted = false;
  return (expected, native) => expected.title === '' ? (alerted = true, dialogIdentity(expected, native))
    : alerted ? { status: 'mismatch', error: 'Focused window differs' } : dialogIdentity(expected, native);
};

test('DR1: OK on an alert the lease moved to continues on the document it covered', async t => {
  const h = await dialogFixture(t);
  const result = await h.call(dismiss);
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.keys, ['super+End']);
  assert.equal(h.sentSince(), 2);
  assert.doesNotMatch(JSON.stringify(result), /guard-stop|window or URL changed/);
});

test('DR1: a filtered trailing read still continues', async t => {
  const h = await dialogFixture(t);
  const result = await h.call(dismiss + ' const s = await app.getAXState(); s.split("\\n").filter(l => /draft/.test(l)).join("\\n")');
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.keys, ['super+End']);
});

for (const [name, options] of [
  ['another document', { afterItem: page.replaceAll('report.txt', 'other.txt') }],
  ['the same title at another URL', { afterItem: page.replace('file:///tmp/report.txt', 'file:///tmp/copy/report.txt') }],
  ['another app', { afterItem: page.replace('App: Fixture Editor.', 'App: Other Editor.') }],
  ['another window of the app', { afterItem: 'Window: "Styles", App: Fixture Editor.\n0 standard window Styles\n\t1 button Apply' }],
  ['user input during the call', { identity: (expected, native) => ({ ...dialogIdentity(expected, native), ...(expected.title ? { hidIdleSeconds: 0 } : {}) }) }],
  ['a lost focus', { identity: lostFocus() }],
  ['a dialog read without the window it covered', { bare: true }],
  // LW1 review: window-identity narrows two same-title windows to the focused one.
  ['a second window with the same title and URL', { identity: (expected, native) => ({ ...dialogIdentity(expected, native), ...(expected.title ? { headerMatches: 2 } : {}) }) }],
  // LW1 review: a parent recorded from a dialog would continue into that dialog.
  ['a covered window that was itself a dialog', { base: 'Window: "Find", App: Fixture Editor.\n0 dialog Find, URL: file:///tmp/find\n\t1 text area (settable) Value: \n\t2 button Replace All' }],
]) test(`DR1: closing the dialog onto ${name} stops`, async t => {
  const h = await dialogFixture(t, options);
  const result = await h.call(dismiss);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.equal(h.sentSince(), 1);
});

test('DR1: a re-acquire of the same alert keeps the covered window and continues', async t => {
  const h = await dialogFixture(t);
  const result = await h.call('let app = await cua.getApp("Fixture Editor"); ' + dismiss);
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.keys, ['super+End']);
});

// LW2: word-edit 2026-10-17T19-02-45-300Z. open_file's handle renamed, the document shown as a dialog root while the
// Find sidebar is open, Replace All's alert, then OK and the rest in one call.
const sheetRoot = page.replace('0 standard window report.txt', '0 dialog report.txt');
test('LW2: OK on the alert continues after the document showed a dialog root, through a renamed open_file handle', async t => {
  const events = [];
  const h = await fixture(t, { base: page, after: alert, afterItem: page, identity: dialogIdentity,
    trace: (direction, msg) => { if (process.env.LW2_DEBUG) events.push(direction + ' ' + JSON.stringify(msg).slice(0, 300)); } });
  await h.call('globalThis.__sleightOpenedApp3 = await cua.getApp("Fixture Editor");');
  h.setText(sheetRoot);
  assert.match(JSON.stringify(await h.call('let app = __sleightOpenedApp3; let s = await app.getAXState(); s')), /0 dialog report/);
  const replaced = await h.call('let app = __sleightOpenedApp3; await app.click({ label: "Replace All" }); let s = await app.getAXState({ disableDiffing: true }); nodeRepl.write(s.split("\\n").filter(l => /MATCHES|Report/.test(l)).slice(0, 10).join("\\n"));');
  assert.match(JSON.stringify(replaced), /All done/, JSON.stringify(replaced));
  const result = await h.call('let app = __sleightOpenedApp3; await app.click({ label: "OK" }); await app.pressKey("super+End"); await app.pressKey("Return"); let s = await app.getAXState({ disableDiffing: true }); nodeRepl.write(s.split("\\n").filter(l => /Table|Insert|menu|Window:/i.test(l)).slice(0, 40).join("\\n"));');
  if (process.env.LW2_DEBUG) console.log(events.join('\n'), JSON.stringify(result).slice(0, 1500));
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.keys, ['super+End', 'Return']);
});

// LW2: the whole of that run from the Styles gallery on, with Word's window shapes (paths shortened).
const wordTitle = 'Report-2001a6ad  -  Compatibility Mode';
const wordDoc = `Window: "${wordTitle}", App: Microsoft Word.\n0 standard window ${wordTitle}, Secondary Actions: Raise, URL: file:///tmp/Report-2001a6ad.docx\n\t1 split group\n\t\t2 tab Description: Find and Replace, Value: 0, ID: sidebar_tab_findAndReplace\n\t3 text entry area (disabled, settable) Description: Page 1 content, Value: Report\n\t4 button Styles\n\t5 combo box (settable) Description: Search Document\n\t6 combo box (settable) Description: Replace With\n\t7 button Replace All`;
const wordSheet = wordDoc.replace(`0 standard window ${wordTitle}`, `0 dialog ${wordTitle}`);
const wordStyles = 'Window: "Styles", App: Microsoft Word.\n0 window Styles, Secondary Actions: Raise\n\t1 container';
const wordAlert = 'Window: "", App: Microsoft Word.\n0 dialog Description: alert, Secondary Actions: Raise\n\t1 image Word alert\n\t2 text Microsoft Word All done. We made 1 replacement.\n\t3 button OK, ID: action-button--998\n4 menu bar';
const wordActions = (name, argument, text) => name === 'click' && argument === 4 ? wordStyles : argument === 'Escape' ? wordDoc
  : argument === 'super+h' ? wordSheet : name === 'click' && argument === 7 ? wordAlert : text === wordAlert ? wordDoc : text;
const filtered = pattern => ` let s = await app.getAXState({ disableDiffing: true }); nodeRepl.write(s.split("\\n").filter(l => /${pattern}/i.test(l)).slice(0, 40).join("\\n"));`;
test('LW2: the 19-02-45 word-edit sequence continues past Escape on Styles and OK on the alert', async t => {
  const events = [];
  const h = await fixture(t, { base: wordDoc, onAction: wordActions, identity: dialogIdentity,
    trace: (direction, msg) => { if (process.env.LW2_DEBUG && !/^(?:to-server|to-client|from-server|call-received)$/.test(direction)) events.push(direction + ' ' + JSON.stringify(msg).slice(0, 300)); } });
  const step = async code => { const result = await h.call('let app = __sleightOpenedApp3; ' + code); if (process.env.LW2_DEBUG) console.log('STEP', code.slice(0, 60), '=>', JSON.stringify(result).slice(0, 700), '\n', events.splice(0).join('\n')); return result; };
  await h.call('globalThis.__sleightOpenedApp3 = await cua.getApp("Microsoft Word");');
  await step('let s = await app.getAXState(); s');
  assert.match(JSON.stringify(await step('await app.click({ label: "Styles" });' + filtered('Heading|Normal'))), /Styles/);
  const escape = await step('await app.pressKey("Escape"); await app.pressKey("super+h");' + filtered('Find|Replace|Window|dialog|sheet|Description'));
  assert.notEqual(escape.isError, true);
  assert.deepEqual(h.keys, ['Escape', 'super+h']);
  // The run's "degraded read": a second header without the URL, so the lease lost its window and the relay re-acquired
  // the document, now a dialog root, before the next two calls (acquisition-split for ids 13 and 14).
  await step(`await app.click({ id: "sidebar_tab_findAndReplace" }); nodeRepl.write('Window: "${wordTitle}", App: Microsoft Word.\\n');`);
  await step('await app.setValue(5, "amber"); await app.setValue(6, "violet");' + filtered('Search Document|Replace With'));
  assert.match(JSON.stringify(await step('await app.click({ label: "Replace All" });' + filtered('MATCHES|Report'))), /All done/);
  const ok = await step('await app.click({ label: "OK" }); await app.pressKey("super+End"); await app.pressKey("Return");' + filtered('Table|Insert|menu|Window:'));
  assert.notEqual(ok.isError, true);
  assert.deepEqual(h.keys, ['Escape', 'super+h', 'super+End', 'Return']);
});

// LW2: word-edit 2026-10-17T19-00-39-523Z. Replace All's result still showed the document; the next call's re-acquire
// showed the alert, and its numbered click after OK stopped as "an earlier action in this call changed what element 28
// is", a stop that no continuation reads. The window change now wins over that element check.
test('LW2: the 19-00-39 shape continues to a numbered click after OK on an alert its re-acquire showed', async t => {
  const events = [];
  const h = await fixture(t, { base: wordDoc, identity: dialogIdentity, onAction: (name, argument, text) => text === wordAlert ? wordDoc : text,
    trace: direction => events.push(direction) });
  assert.doesNotMatch(JSON.stringify(await h.call('let app = await cua.getApp("Microsoft Word"); await app.setValue(5, "amber"); await app.setValue(6, "violet"); await app.click(7);' + filtered('amber|violet|MATCHES'))), /isError":true/);
  h.setText(wordAlert);
  const result = await h.call('let app = await cua.getApp("Microsoft Word"); await app.click({ id: "action-button--998" }); await app.click(3); await app.pressKey("super+End"); await app.pressKey("Return");' + filtered('Table|menu|Insert'));
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(events.includes('menu-continuation'));
  assert.deepEqual(h.clicks.slice(-2), [3, 3], 'OK in the alert, then the document\'s element 3');
  assert.deepEqual(h.keys, ['super+End', 'Return']);
});

test('LW2: a window change outranks a stale number, and the stop is a window stop the relay can read', async t => {
  const h = await fixture(t, { base: wordDoc, identity: dialogIdentity, onAction: (name, argument, text) => text === wordAlert ? wordDoc.replaceAll('Report-2001a6ad', 'Other') : text });
  h.setText(wordAlert);
  await h.call('let s = await app.getAXState(); s');
  const result = await h.call('await app.click({ id: "action-button--998" }); await app.click(3);');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /window or URL changed/);
  assert.doesNotMatch(JSON.stringify(result), /changed what element/);
  assert.deepEqual(h.clicks, [3]);
});

for (const [name, options, reason] of [
  ['no covered window', { bare: true }, 'no-covered-window'],
  ['another document', { afterItem: page.replaceAll('report.txt', 'other.txt') }, 'other-title'],
  ['a second same-title window', { identity: (expected, native) => ({ ...dialogIdentity(expected, native), ...(expected.title ? { headerMatches: 2 } : {}) }) }, 'header-matches-2'],
  ['HID input', { identity: (expected, native) => ({ ...dialogIdentity(expected, native), ...(expected.title ? { hidIdleSeconds: 0 } : {}) }) }, 'hid-input'],
  ['lost focus', { identity: lostFocus() }, 'identity: Input lease: Focused window differs'],
]) test(`LW2: the trace names why a dialog stop did not continue (${name})`, async t => {
  const events = [];
  const h = await dialogFixture(t, { ...options, trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.equal((await h.call(dismiss)).isError, true);
  assert.ok(events.some(event => event.startsWith(reason)), JSON.stringify(events));
});

// LW3 review 1: the bundle ID comes from the handle's metadata, so another app's dialog looked like the document's own.
test('LW3: another app\'s dialog over the document never continues onto it', async t => {
  const security = 'Window: "", App: SecurityAgent.\n0 dialog Description: authenticate\n\t1 text Word wants to make changes.\n\t2 button OK, ID: ok';
  const events = [];
  const h = await dialogFixture(t, { after: security, trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  const result = await h.call(dismiss);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.ok(events.includes('no-covered-window'), JSON.stringify(events));
});

test('LW3: no baseline for the dialog, no continuation', async t => {
  const events = [];
  const h = await dialogFixture(t, { identity: (expected, native) => expected.title === '' ? { status: 'ok', matches: 2 } : dialogIdentity(expected, native),
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, []);
  assert.ok(events.includes('no-baseline'), JSON.stringify(events));
});

// LW3 review 2: a palette that stays open hands focus back without closing.
const palette = 'Window: "Formatting Palette", App: Fixture Editor.\n0 floating window Formatting Palette\n\t1 button Bold, ID: bold\n\t2 button Close, ID: close';
for (const [name, open, code, continues] of [
  ['a palette button that leaves it open stops', true, 'await app.click({ id: "bold" }); await app.pressKey("super+End");', false],
  ['a palette button that closes it continues', false, 'await app.click({ id: "close" }); await app.pressKey("super+End");', true],
  ['Escape on an open palette continues', true, 'await app.pressKey("Escape"); await app.pressKey("super+End");', true],
]) test(`LW3: ${name}`, async t => {
  let clicked = false;
  const h = await fixture(t, { base: page, onAction: (action, argument, text) => text === page && argument === 2 ? palette : text === palette ? (clicked = true, page) : text,
    identity: (expected, native) => expected.title !== 'Formatting Palette' || !clicked ? dialogIdentity(expected, native)
      : open ? { status: 'mismatch', error: 'Focused window differs' } : { status: 'ok', matches: 0, headerMatches: 0 } });
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /Formatting Palette/);
  const result = await h.call(code);
  assert.equal(result.isError === true, !continues, JSON.stringify(result).slice(0, 400));
  assert.deepEqual(h.keys.filter(key => key === 'super+End'), continues ? ['super+End'] : []);
});

// LW3 review 3: a dialog closing onto another dialog under the document's title and URL is not the document.
test('LW3: the alert closing onto a dialog root under the document\'s title stops', async t => {
  const events = [];
  const h = await dialogFixture(t, { afterItem: sheetRoot, trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, []);
  assert.ok(events.includes('returned-root-not-standard'), JSON.stringify(events));
});

// LW3 review 4: HID idle runs from when the covered window was last seen standard, and a new process forgets it.
// The relay's clock is injected: the document is seen standard at 1 s, the alert opens and closes at 11 s, and the
// helper reports the last input 5 s ago (at 6 s, after the document was seen). With 20 s idle the same calls continue.
for (const [idleSeconds, continues] of [[5, false], [20, true]]) test(`LW3: ${continues ? 'no input' : 'input'} since the document was last seen standard ${continues ? 'continues' : 'stops'}`, async t => {
  let ms = 1000;
  const events = [];
  const h = await fixture(t, { base: page, after: alert, afterItem: page, clock: () => ms,
    identity: (expected, native) => ({ ...dialogIdentity(expected, native), hidIdleSeconds: idleSeconds }),
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  ms = 11000;
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  assert.equal((await h.call(dismiss)).isError === true, !continues);
  assert.deepEqual(h.keys, continues ? ['super+End'] : []);
  assert.deepEqual(events, continues ? [] : ['hid-input']);
});

test('LW3: a relaunched app forgets the standard windows it showed before', async t => {
  let pid = 123;
  const events = [];
  const h = await fixture(t, { base: page, identity: (expected, native) => ({ ...dialogIdentity(expected, native), pid }),
    onAction: (action, argument, text) => text === page && argument === 2 ? alert : text === alert ? page : text,
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.notEqual((await h.call('await app.click(1); await app.pressKey("a");')).isError, true);
  pid = 456;
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, ['a']);
  assert.ok(events.includes('no-covered-window'), JSON.stringify(events));
});

// LW4 review 1: nothing noted a process before the alert, so a relaunch between the document's read and the alert left
// the old process's window looking current. The read now asks for the process, and a note drops windows it can't place.
for (const [name, unknownAtRead] of [['the read learned', false], ['the read could not learn', true]]) test(`LW4: a relaunch after the document's read, before any other process note, never continues (${name} the process)`, async t => {
  let pid = 123, alerted = false;
  const events = [];
  const h = await fixture(t, { base: page, after: alert, afterItem: page,
    identity: (expected, native) => {
      if (expected.title === '') alerted = true;
      return unknownAtRead && !alerted ? { status: 'unknown', error: 'probe unavailable' } : { ...dialogIdentity(expected, native), pid };
    },
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  pid = 456;
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(events, ['no-covered-window']);
});

// LW4 review 2: "Don't Save" on a never-saved document's alert closes the document, and focus can land on another
// window with its title. Without a URL, a dialog needs the covered window's certified native identity. (A title of
// Untitled or Untitled n doesn't reach this: the guard adopts it as a window the click opened.)
test('LW4: a document without a URL or a certified window never continues after its dialog closes', async t => {
  const untitled = page.replace(', URL: file:///tmp/report.txt', '').replaceAll('report.txt', 'Document1');
  const events = [];
  const h = await fixture(t, { base: untitled, after: alert, afterItem: untitled, identity: dialogIdentity,
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(events, ['untitled-needs-certified-window']);
});

// LW1 review: two untitled dialogs compare equal, so a later one could inherit an earlier one's parent. Continuing
// needs HID idle since the parent was recorded.
test('LW1: input after the dialog appeared, though none during the call, stops', async t => {
  let ms = 1000;
  const h = await dialogFixture(t, { clock: () => ms, identity: (expected, native) => ({ ...dialogIdentity(expected, native), hidIdleSeconds: 5 }) });
  ms = 11000;
  const result = await h.call(dismiss);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
});

test('DR1: a lease stop says which actions ran and which were not sent', async t => {
  const h = await dialogFixture(t, { afterItem: page.replaceAll('report.txt', 'other.txt') });
  const text = (await h.call(dismiss + ' await app.typeText("secret words");')).content.map(c => c.text ?? '').join('\n');
  assert.match(text, /sleight: this call ran 1 action \(click id "ok"\); not sent: pressKey "super\+End", typeText\./);
  assert.doesNotMatch(text, /secret words/);
  const unsplit = await dialogFixture(t, { afterItem: page.replaceAll('report.txt', 'other.txt') });
  const plain = (await unsplit.call('await app.click({ id: "ok" }); if (true) await app.pressKey("super+End");')).content.map(c => c.text ?? '').join('\n');
  assert.match(plain, /sleight: this call ran 1 action; the stopped pressKey and everything after it were not sent\./);
});

// AB3: a date picker re-rendered its days after the first date's click, so the engine refused the next date's number
// from the call's bound capture (Firefox travel, 2026-10-17). A diff read, a full read and a lone click followed (9.4 s).
const picker = rendered => 'Window: "report.txt", App: Fixture Editor.\n0 standard window report.txt, URL: file:///tmp/report.txt\n' +
  '\t1 text field Dates' + (rendered ? ', Value: Dec 14\n\t2 text Check-in set' : '') + '\n' +
  ['button Monday, December 14, ID: d14', 'button Saturday, December 19, ID: d19', 'button Add adult, ID: add-adult', 'button Add child, ID: add-child']
    .map((line, i) => `\t${i + (rendered ? 3 : 2)} ${line}`).join('\n');
async function pickerFixture(t, { failRead = false } = {}) {
  // The engine's capture: a read takes a new one, and any click replaces the elements it holds.
  let stale = false;
  return fixture(t, { base: picker(false), onRead: () => { if (failRead && stale) throw new Error('read failed'); stale = false; },
    onAction: (name, number) => {
      if (stale) throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`);
      stale = true;
      return picker(true);
    } });
}

test('AB3: a refused element says what ran, what was not sent, and where the rest are now', async t => {
  const h = await pickerFixture(t);
  const result = await h.call('await app.click({ label: "Monday, December 14" }); await app.click({ label: "Saturday, December 19" }); ' +
    'await app.click({ label: "Add adult" }); await app.click(5);');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2, 3], 'the refused click is not resent and nothing after it runs');
  const text = result.content.map(c => c.text ?? '').join('\n');
  assert.match(text, /sleight: this call ran 1 action \(click\); the engine refused the next click \(element 3\): its number came from this call's first read, and the element changed \(perhaps replaced by an earlier action\)\. Not sent after it: click, click 5\./);
  // click(5) was Add child in the tree Claude saw; it is 6 now.
  assert.match(text, /In this result's window, the refused action and the rest are now click 4, click 5, click 6\. /);
  assert.match(text, /sleight now reads this window before each numbered or named action, so the rest can go in one call\./);
  assert.match(text, /Dates, Value: Dec 14/, 'the fresh tree is in the result');
  assert.doesNotMatch(text.slice(text.indexOf('sleight: this call ran')), /December 19|Add adult/, 'the note names no label text');
});

test('AB3 review: when the read after a refusal fails, the note claims no current window', async t => {
  const h = await pickerFixture(t, { failRead: true });
  const result = await h.call('await app.click({ label: "Monday, December 14" }); await app.click({ label: "Saturday, December 19" }); await app.click(5);');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2, 3]);
  const text = result.content.map(c => c.text ?? '').join('\n');
  assert.match(text, /Not sent after it: click 5\. sleight couldn't read the window after it, so read it before acting\./);
  assert.doesNotMatch(text, /is current|are now/);
});

test('AB3: after a refusal, the rest goes in one call', async t => {
  const h = await pickerFixture(t);
  await h.call('await app.click({ label: "Monday, December 14" }); await app.click({ label: "Saturday, December 19" });');
  const result = await h.call('await app.click({ label: "Saturday, December 19" }); await app.click({ label: "Add adult" }); ' +
    'await app.click({ label: "Add adult" }); await app.click({ label: "Add child" });');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, [2, 3, 4, 5, 5, 6]);
});

// AB1: the Firefox race round's new-tab stops (2026-10-17). A leased browser-like window without a URL; Cmd+T adds a
// selected tab and retitles the window, with focus in the address field outside the page.
const marker = 'Window: "Marker", App: Fixture Editor.\n0 standard window Marker, Secondary Actions: Raise\n\t1 tab group\n' +
  '\t\t2 tab (selected) Value: Marker, Marker\nClose tab\n\t\t3 button Open a new tab\n\t4 combo box (settable) Address\n' +
  '\t5 HTML Content Description: Marker\n\t\t6 link Home\n\nThe focused UI element is 1 tab group';
const newTab = 'Window: "New Tab", App: Fixture Editor.\n0 standard window New Tab, Secondary Actions: Raise\n\t1 tab group\n' +
  '\t\t2 tab (selectable) Value: Marker, Marker\nClose tab\n\t\t3 tab (selected) Value: New Tab, New Tab\nClose tab\n\t\t4 button Open a new tab\n' +
  '\t5 combo box (settable) Address\n\t6 HTML Content Description: New Tab\n\t\t7 link Shortcuts\n\nThe focused UI element is 5 combo box (settable) Address';
const shop = newTab.replaceAll('New Tab', 'Shop').replace(/The focused UI element is .*/, 'The focused UI element is 7 link Shortcuts');
const fieldFocus = { sheets: 0, role: 'AXComboBox', subrole: null, inWindow: true, inPage: false };
const tabCall = 'await app.pressKey("super+t");\nawait app.typeText("http://127.0.0.1:5420/shop");\nawait app.pressKey("Return");\nawait app.getAXState();';
const tabScript = (opened = newTab) => (name, argument, text) => name === 'pressKey' && argument === 'super+t' ? opened
  : name === 'pressKey' && argument === 'Return' ? shop : text;
async function tabFixture(t, { opened, focus = fieldFocus, ...options } = {}) {
  const refusals = [], continued = [];
  const h = await fixture(t, { base: marker, onAction: tabScript(opened), trace: (direction, msg) => {
    if (direction === 'tab-continuation-refused') refusals.push(msg.reason);
    if (direction === 'menu-continuation') continued.push(msg.kind);
  }, ...options });
  h.native.focus = focus;
  return { ...h, refusals, continued };
}
const stoppedAtTab = (h, result) => {
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /window or URL changed|app changed/);
  assert.deepEqual(h.keys, ['super+t']);
  assert.deepEqual(h.typed, []);
  assert.equal(h.sent.length, 1);
};

test('AB1: the call\'s own Cmd+T into a new tab of the same window types the URL there in the same call', async t => {
  const h = await tabFixture(t);
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop']);
  assert.equal(h.sent.length, 2);
  assert.equal(h.identityChecks(), 3, 'admission baseline, post-stop, and immediately before forwarding');
  assert.deepEqual(h.continued, ['tab']);
  assert.deepEqual(h.refusals, []);
  assert.doesNotMatch(JSON.stringify(result), /guard-stop|window or URL changed/);
});

test('AB1: Ctrl+T without a trailing read continues too', async t => {
  const h = await tabFixture(t, { onAction: (name, argument, text) => name === 'pressKey' && argument === 'ctrl+t' ? newTab : tabScript()(name, argument, text) });
  const result = await h.call('await app.pressKey("ctrl+t"); await app.typeText("example.org"); await app.pressKey("Return");');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.typed, ['example.org']);
});

for (const [name, options, reason] of [
  ['the baseline flag', { tabContinuation: false }, 'off'],
  ['careful mode', { guardMode: 'careful' }, 'careful'],
  ['user HID input since the call began', { nativeChange: 'focus' }, 'hid-input'],
  ['another window in front', { nativeChange: 'window' }, 'identity: Input lease: the selected window number changed. Read the intended window again before acting.'],
  ['the window no longer focused', { nativeChange: 'unfocused' }, 'identity: Input lease: the native window changed. Read the intended window again before acting.'],
  ['a new process', { identity: (expected, native, count) => ({ ...expected, ...native, matches: 1, epoch: 'helper', window: 1,
    pid: count === 1 ? 123 : 456, processStart: 1 }) }, 'identity: Input lease: the native window or its process changed. Read the intended window again before acting.'],
  ['a sheet only the helper sees', { focus: { ...fieldFocus, sheets: 1 } }, 'native-sheet'],
  ['a password field in focus', { focus: { ...fieldFocus, role: 'AXTextField', subrole: 'AXSecureTextField' } }, 'secure-field'],
  ['focus outside the window', { focus: { ...fieldFocus, inWindow: false } }, 'focus-outside-window'],
  ['focus on the page', { opened: newTab.replace(/The focused UI element is .*/, 'The focused UI element is 7 link Shortcuts') }, 'focus-not-app-field'],
  ['a field inside the page', { opened: newTab.replace('\t\t7 link Shortcuts', '\t\t7 text field Search').replace(/The focused UI element is .*/,
    'The focused UI element is 7 text field Search') }, 'focus-in-document'],
  ['a tab switch (no new tab)', { opened: newTab.replace('\t\t2 tab (selectable) Value: Marker, Marker\nClose tab\n', '') }, 'no-new-tab'],
  ['two new tabs', { opened: newTab.replace('\t\t4 button', '\t\t8 tab (selectable) Value: Other, Other\n\t\t4 button') }, 'no-new-tab'],
  ['another app in front', { opened: newTab.replace('App: Fixture Editor.', 'App: Other Editor.') }, 'other-app'],
]) test(`AB1: a new-tab stop stays a stop on ${name}`, async t => {
  const h = await tabFixture(t, options);
  stoppedAtTab(h, await h.call(tabCall));
  assert.deepEqual(h.continued, []);
  if (reason) assert.deepEqual(h.refusals, [reason]);
});

for (const [name, code, reason] of [
  ['a click on the new-tab button', 'await app.click(3); await app.typeText("example.org"); await app.pressKey("Return");', 'not-a-tab-shortcut'],
  ['Cmd+Shift+T', 'await app.pressKey("super+shift+t"); await app.typeText("example.org"); await app.pressKey("Return");', 'not-a-tab-shortcut'],
  ['an unsplit call', 'await app.pressKey("super+t"); if (true) await app.typeText("example.org");', 'not-admitted'],
]) test(`AB1: ${name} stops before typing`, async t => {
  const h = await tabFixture(t, { onAction: (action, argument, text) => action === 'typeText' ? text : action === 'pressKey' && argument === 'Return' ? shop : newTab });
  const result = await h.call(code);
  assert.equal(result.isError, true);
  assert.deepEqual(h.typed, []);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.refusals, [reason]);
});

test('AB1: input during the remainder\'s final check stops it with the original stop', async t => {
  const h = await tabFixture(t, { identity: (expected, native, count) => ({ ...expected, ...native, matches: 1, epoch: 'helper', window: 1,
    pid: 123, processStart: 1, ...(count === 3 ? { hidIdleSeconds: 0 } : {}) }) });
  stoppedAtTab(h, await h.call(tabCall));
  assert.equal(h.identityChecks(), 3);
  assert.deepEqual(h.refusals, ['final-check']);
});

test('AB1: a tab the remainder opens again stops before its next action', async t => {
  const h = await tabFixture(t, { onAction: (name, argument, text) => name === 'pressKey' && argument === 'super+t' ? (text === marker ? newTab : marker) : text });
  const result = await h.call('await app.pressKey("super+t"); await app.pressKey("super+t"); await app.typeText("example.org");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, ['super+t', 'super+t']);
  assert.deepEqual(h.typed, []);
});

test('AB1: a sheet the helper sees only at the final check stops the remainder', async t => {
  const h = await tabFixture(t, { identity: (expected, native, count) => ({ ...expected, ...native, matches: 1, epoch: 'helper', window: 1,
    pid: 123, processStart: 1, ...(count === 3 ? { focus: { ...fieldFocus, sheets: 1 } } : {}) }) });
  stoppedAtTab(h, await h.call(tabCall));
  assert.equal(h.identityChecks(), 3);
  assert.deepEqual(h.refusals, ['final-check']);
});

const tabIdentity = change => async (expected, native, count) => ({ ...expected, ...native, matches: 1, epoch: 'helper', window: 1,
  pid: 123, processStart: 1, ...change(count) });
test('AB1 review: a baseline without a window number never continues', async t => {
  const h = await tabFixture(t, { identity: tabIdentity(count => count === 1 ? { windowNumber: null } : {}) });
  stoppedAtTab(h, await h.call(tabCall));
  assert.deepEqual(h.refusals, ['no-window-number']);
});

test('AB1 review: a helper that matches other than one window never continues', async t => {
  for (const matches of [0, 2]) {
    const h = await tabFixture(t, { identity: tabIdentity(count => count === 2 ? { matches } : {}) });
    stoppedAtTab(h, await h.call(tabCall));
    assert.deepEqual(h.refusals, [`identity: Input lease: window identity is ambiguous (${matches} matching windows). Read the intended window again before acting.`]);
  }
});

test('AB1 review: a lease that moved while the helper looked never continues', async t => {
  let h;
  h = await tabFixture(t, { identity: async (expected, native, count) => {
    if (count === 2) {
      h.send({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'js_reset', arguments: {} } });
      for (let i = 0; i < 5; i++) await tick();
    }
    return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
  } });
  const result = await h.call(tabCall);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, ['super+t']);
  assert.deepEqual(h.typed, []);
  assert.equal(h.sent.filter(msg => msg.params?.name === 'js').length, 1, 'the js_reset only, no remainder');
  assert.deepEqual(h.refusals, ['lease-moved']);
});

// The remainder's numbers come from the tree Claude read before the call; the guard checks them against the new tab's.
test('AB1 review: a numbered click in the remainder after a tab continuation stops as stale', async t => {
  const h = await tabFixture(t);
  const result = await h.call('await app.pressKey("super+t"); await app.click(5);');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, []);
  assert.match(JSON.stringify(result), /element 5 changed since you read the window/);
});

// OT2 (SLEIGHT_POPOVER_CONTINUATION): a popover root covers the window under it like the palette path's plain window and
// floating window; =0 records only dialogs and sheets. An untitled palette can't be shown gone (the helper skips windows
// without a title), so its button close stops.
const closeButton = 'await app.click({ id: "close" }); await app.pressKey("super+End");';
for (const [name, root, title, { open = false, ...options }, continues, reason, code = closeButton] of [
  ['a popover its own button closed continues', 'popover', 'Format', {}, true],
  ['Escape on a popover continues', 'popover', 'Format', {}, true, undefined, 'await app.pressKey("Escape"); await app.pressKey("super+End");'],
  ['a popover with the flag off stops', 'popover', 'Format', { popoverContinuation: false }, false, 'no-covered-window'],
  ['a floating window with the flag off stops', 'floating window', 'Format', { popoverContinuation: false }, false, 'no-covered-window'],
  ['an untitled popover its button closed stops', 'popover', '', {}, false, 'palette-untitled'],
  ['a popover still open after its button stops', 'popover', 'Format', { open: true }, false, 'palette-still-open'],
]) test(`OT2: ${name}`, async t => {
  const popover = `Window: ${JSON.stringify(title)}, App: Fixture Editor.\n0 ${root} ${title}\n\t1 button Bold, ID: bold\n\t2 button Close, ID: close`;
  let clicked = false;
  const events = [];
  const h = await fixture(t, { base: page, ...options,
    onAction: (action, argument, text) => text === page && argument === 2 ? popover : text === popover ? (clicked = true, page) : text,
    identity: (expected, native) => expected.title !== title || expected.url || !clicked ? dialogIdentity(expected, native)
      : open ? { status: 'ok', matches: 1, headerMatches: 1 } : { status: 'ok', matches: 0, headerMatches: 0 },
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), new RegExp(`0 ${root}`));
  const result = await h.call(code);
  assert.equal(result.isError === true, !continues, JSON.stringify(result).slice(0, 400));
  assert.deepEqual(h.keys.filter(key => key === 'super+End'), continues ? ['super+End'] : []);
  if (reason) assert.ok(events.includes(reason), JSON.stringify(events));
});

// OT2 (SLEIGHT_PARENT_LEASE): Insert Table and Word's alert (2026-10-17 office runs, 7 stale-lease refusals). The call's
// own OK closed the dialog, its result showed the document under a second header without a URL (a filtered write),
// so the lease dropped; the next call's recovery re-acquisition showed the document and stopped as stale.
const parentOf = (expected, native, extra = {}) => ({ ...dialogIdentity(expected, native), windowSubrole: 'AXStandardWindow',
  ...extra, focus: { sheets: 0, role: null, subrole: null, inWindow: false, inPage: false, ...extra.focus } });
async function parentFixture(t, { parent = {}, gone = true, reply, ...options } = {}) {
  const state = { closed: false };
  const events = [];
  const h = await fixture(t, { base: page, after: alert, afterItem: page, ...options,
    identity: (expected, native) => !state.closed ? dialogIdentity(expected, native)
      : expected.title === '' ? (gone ? { status: 'ok', matches: 0, headerMatches: 0 } : dialogIdentity(expected, native))
      : typeof parent === 'function' ? parent(expected, native) : parentOf(expected, native, parent),
    trace: (direction, msg) => { if (/^parent-lease/.test(direction)) events.push(direction === 'parent-lease' ? 'accepted' : msg.reason); } });
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  const closed = await h.call('await app.click({ id: "ok" }); nodeRepl.write(\'Window: "report.txt", App: Fixture Editor.\\n\');');
  assert.match(JSON.stringify(closed), /0 standard window report\.txt/);
  state.closed = true;
  if (reply) h.setText(reply);
  return { ...h, events };
}
const nextCall = 'await app.pressKey("super+End");';

test('OT2: the next call after OK closed the alert leases the document it covered and runs', async t => {
  const h = await parentFixture(t);
  const result = await h.call(nextCall);
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 600));
  assert.deepEqual(h.keys, ['super+End']);
  assert.deepEqual(h.events, ['accepted']);
  assert.doesNotMatch(JSON.stringify(result), /nothing from this call ran/);
});

test('OT2: the parent lease pins the native window for that call only', async t => {
  let epoch = 'helper';
  const h = await parentFixture(t, { parent: (expected, native) => parentOf(expected, native, { epoch }) });
  assert.notEqual((await h.call(nextCall)).isError, true);
  // A new helper epoch (it quits after about 20 s idle) refuses a pinned identity; the next call's keys still go.
  epoch = 'helper-2';
  const later = await h.call('await app.pressKey("Return");');
  assert.notEqual(later.isError, true, JSON.stringify(later).slice(0, 400));
  assert.deepEqual(h.keys, ['super+End', 'Return']);
});

test('OT2: the pinned native window must still match when the rest is admitted', async t => {
  // The real helper narrows by the pinned number and answers mismatch once that window is gone.
  const pinned = [];
  const h = await parentFixture(t, { parent: (expected, native) => {
    if (expected.nativeIdentity) { pinned.push(expected.nativeIdentity.windowNumber); return { status: 'mismatch', error: 'Known window number disappeared' }; }
    return parentOf(expected, native);
  } });
  const result = await h.call(nextCall);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(h.events, ['accepted']);
  assert.deepEqual(pinned, [22], 'the admission asked for the window number the parent check observed');
});

for (const [name, options, reason] of [
  ['the flag off', { parentLease: false }, undefined],
  ['user input since the document was seen', { parent: { hidIdleSeconds: 0 } }, 'hid-input'],
  ['another window with the same title and URL', { parent: { headerMatches: 2 } }, 'header-matches-2'],
  ['a new process', { parent: { pid: 456 } }, 'covered-process-changed'],
  ['the dialog still present natively', { gone: false }, 'dialog-still-open'],
  ['a sheet in the returned tree', { reply: page + '\n\t5 sheet Confirm' }, 'dialog-present'],
  ['a sheet on the window natively', { parent: { focus: { sheets: 1 } } }, 'native-sheet'],
  ['a different window focused', { parent: () => ({ status: 'mismatch', error: 'Focused window differs' }) }, 'identity-mismatch'],
  ['a window that is not standard natively', { parent: { windowSubrole: 'AXFloatingWindow' } }, 'not-standard-native'],
  ['no native answer', { parent: () => ({ status: 'unknown', error: 'probe unavailable' }) }, 'identity-unavailable'],
  ['another document in front', { reply: page.replaceAll('report.txt', 'other.txt') }, 'not-the-covered-window'],
]) test(`OT2: the parent lease refuses ${name}`, async t => {
  const h = await parentFixture(t, options);
  const result = await h.call(nextCall);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.match(JSON.stringify(result), /nothing from this call ran/);
  assert.deepEqual(h.events, reason ? [reason] : []);
});
