import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import vm from 'node:vm';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease, leaseKey } from '../plugins/sleight/lib/input-lease.mjs';

const appId = 'com.apple.TextEdit', app = 'TextEdit';
const window = name => ({ appId, app, title: `${name}.txt`, url: `file:///tmp/${name}.txt` });
const identityScript = readFileSync(new URL('../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const root = options.root ?? '/tmp';
  const window = name => ({ appId, app, title: `${name}.txt`, url: `file://${root}/${name}.txt` });
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const sent = [], received = [], selections = [], leases = [], drags = [], invalidRequests = [], actions = [];
  let current, broken = false, epoch = 1, focusOverride;
  const observations = [], released = [], active = new Set();
  const windows = ['Source', 'Target'].map((name, i) => ({ AXTitle: `${name}.txt`, AXDocument: `file://${root}/${name}.txt`, AXWindowNumber: 11 + i }));
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const axApp = { AXWindows: list(windows) };
  let context;
  const resetIdentity = () => {
    const $ = Object.assign(value => value, {
      NSUUID: { UUID: { UUIDString: `fixture-${epoch++}` } }, AXIsProcessTrusted: () => true,
      NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list([{ processIdentifier: 7, launchDate: { timeIntervalSince1970: 1 } }]) },
      AXUIElementCreateApplication: () => { axApp.AXFocusedWindow = windows[focusOverride ?? (current?.title === 'Source.txt' ? 0 : 1)]; return axApp; },
      AXUIElementSetMessagingTimeout: () => 0,
      AXUIElementCopyAttributeValue: (el, key, out) => { if (el[key] === undefined) return -25205; out[0] = el[key]; return 0; },
      CFEqual: (a, b) => a === b, CGEventSourceSecondsSinceLastEventType: () => 20,
    });
    context = vm.createContext({ $, Ref: () => [], ObjC: { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v } });
    vm.runInContext(identityScript, context);
  };
  resetIdentity();
  const snapshot = () => options.tree?.(current) ?? `Window: "${current.title}", App: ${app}.\nURL: ${current.url}\n0 standard window ${current.title}\n\t1 text area Value: sample\n\t2 text area Value: alpha move-62f9a451 omega`;
  let output;
  const raw = { getAXState: async (args = {}) => {
    const text = snapshot(); if (args.emit !== false) output.push(text); return text;
  } };
  for (const name of ['click', 'pressKey', 'performSecondaryAction', 'typeText']) raw[name] = async (...args) => {
    actions.push([name, ...args]); options.action?.(name, args);
  };
  const engine = vm.createContext({ app: raw, cua: { getApp: async () => { output.push(snapshot()); return raw; } },
    setTimeout, clearTimeout, nodeRepl: { write: value => output.push(String(value)) } });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: options.changeReview ?? false, flowRules: options.flowRules,
    restartEngine: async () => ({ serverIn, serverOut }),
    ask: options.ask ?? (async () => 'accept'),
    inputLease: options.inputLease ?? { acquire: (target, scope = 'window') => {
      if (options.busy && scope === 'app' && target.title === 'Source.txt' && current?.title === 'Target.txt') throw Error('Input lease: held by another session, retry after 20 seconds');
      if (options.busyWindow && scope === 'window') throw Error('Input lease: window action refused');
      leases.push(target); const key = `${scope}:${target.title}`; active.add(key); return key;
    }, grant: () => ({}), renew() {}, release: keys => { for (const key of keys) { released.push(key); active.delete(key); } }, close: () => active.clear() },
    windowIdentity: async target => {
      observations.push(structuredClone(target));
      const observed = broken ? { status: 'unknown' } : JSON.parse(context.run([JSON.stringify(target)]));
      return { ...observed, ...options.nativeMutation };
    },
    localTools: { tools: [{ name: 'open_file' }, { name: 'select_window' }, { name: 'drag' }],
      target: async () => ({ appId, app, pid: 7 }),
      selectionWindow: async () => options.selection ?? { ok: true, target: { ...window('Source'), windowNumber: 11 }, pid: 7 },
      call: async (name, args, approve) => {
        if (name === 'drag') { drags.push(args); return { content: [] }; }
        if (name === 'select_window') {
          selections.push(args);
          if (options.decline || !await approve(['select_window', appId], 'Select?')) return { isError: true, content: [] };
          current = options.wrongRead ? window('Target') : window('Source');
          if (options.unfocusedSelection) focusOverride = 1;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, target: window('Source'), identity: { pid: 7, windowNumber: options.wrongNumber ? 12 : 11 } }) }] };
        }
        current = window(args.path.includes('Source') ? 'Source' : 'Target');
        return { content: [], _meta: { 'sleight/openedApp': appId,
          'sleight/openedFile': { path: args.path, real: args.path, size: 30 } } };
      } } });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', async bytes => {
    for (const msg of bytes.toString().trim().split('\n').map(JSON.parse)) {
      sent.push(msg);
      if (msg.method !== 'tools/call') continue;
      options.onEngineCall?.(msg);
      if (options.strictProtocol && msg.jsonrpc !== '2.0') {
        invalidRequests.push(msg);
        queueMicrotask(() => relay.engineEnded('Engine exited (0).'));
        continue;
      }
      if (options.holdOpenedRead && String(msg.id).startsWith('sleight-opened-window-')) continue;
      output = [];
      let isError;
      if (options.execute) {
        try { await vm.runInContext(`(async () => { ${msg.params.arguments.code} })()`, engine,
          { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (error) { isError = true; output.push(error.message); }
        const proxy = engine.__sleightDocumentGuard?.wrap(raw) ?? raw;
        engine.app = proxy;
        for (const [handle] of msg.params.arguments.code.matchAll(/\b__sleightOpenedApp\d+\b/g)) engine[handle] = proxy;
      } else output.push(snapshot());
      serverOut.write(JSON.stringify({ id: msg.id, result: { ...(isError ? { isError } : {}), content: [{ type: 'text', text: output.join('\n') }],
      _meta: { 'codex/toolSurface': { app: { appId: options.engineAppId ?? appId } } } } }) + '\n');
    }
  });
  const call = async (id, name, args) => {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < 50 && !received.some(msg => msg.id === id); i++) await tick();
    const reply = received.find(msg => msg.id === id);
    assert.ok(reply, `no reply for ${id}`);
    return reply.result;
  };
  const open = async name => {
    const result = await call(name, 'open_file', { app, path: `${root}/${name}.txt` });
    return /Window handle: `([^`]+)`/.exec(result.content.map(c => c.text ?? '').join('\n'))[1];
  };
  return { call, open, sent, selections, leases, drags, relay, received, invalidRequests, actions, send: (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'), released, active, observations, resetIdentity, focusDuplicate: () => { Object.assign(windows[1], { AXTitle: 'Source.txt', AXDocument: window('Source').url }); focusOverride = 1; }, breakIdentity: () => { broken = true; } };
}

// B transcript lines 120-184: opened alias, URL-less Edit menu, another item,
// fresh getApp, advertised Cancel, fresh getApp and Escape. Use a generic editor.
const childTree = (window, root = '0 Edit, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel') =>
  `Window: "${window.title}", App: ${window.app}.\n${window.url ? `URL: ${window.url}\n` : ''}${root}\n\t\t19 Replace..., ID: replace:`;

test('OH1 B actions execute through the generated runtime guards, including both menu dismissals', async t => {
  let child = false;
  const directory = mkdtempSync('/tmp/oh1-runtime-leases-');
  const inputLease = new InputLease({ directory, holder: 'OH1' });
  t.after(() => { inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
  const h = fixture(t, { execute: true, inputLease,
    action: (name, args) => { if (name === 'click') child = true; else if (name === 'pressKey' || name === 'performSecondaryAction') child = false; },
    tree: current => child ? childTree({ ...current, url: undefined }) : undefined });
  const source = await h.open('Source');
  for (const [id, code] of [
    ['menu', `let app = ${source}; await app.click(1);`],
    ['replace', `let app = ${source}; await app.click(19);`],
    ['fresh', 'let app = await cua.getApp("TextEdit");'],
    ['cancel', 'let app = await cua.getApp("TextEdit"); await app.performSecondaryAction(1, "Cancel");'],
    ['menu-again', `let app = ${source}; await app.click(1);`],
    ['escape', 'let app = await cua.getApp("TextEdit"); await app.pressKey("Escape");'],
    ['reacquire', 'let app = await cua.getApp("TextEdit");'],
    ['continued', 'await app.typeText("continued");'],
  ]) {
    const result = await h.call(id, 'js', { code });
    assert.ok(!result.isError, `${id}: ${JSON.stringify(result)}`);
  }
  assert.deepEqual(h.actions, [['click', 1], ['click', 19], ['performSecondaryAction', 1, 'Cancel'],
    ['click', 1], ['pressKey', 'Escape'], ['typeText', 'continued']]);
});

for (const root of ['0 Edit, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel',
  '0 menu Secondary Actions: Cancel', '0 sheet\n\t1 button Cancel', '0 dialog\n\t1 button Cancel']) {
  test(`OH1 B sequence keeps the selected document through a URL-less child: ${root.split('\n')[0]}`, async t => {
    let child = false;
    const options = { onEngineCall: msg => { if (msg.id === 'menu') child = true; },
      tree: current => child ? childTree({ ...current, url: undefined }, root) : undefined };
    const h = fixture(t, options), source = await h.open('Source');
    const cancel = root.includes('menu') ? `await app.performSecondaryAction(${root.startsWith('0 menu') ? 0 : 1}, "Cancel");`
      : 'await app.click(1);';
    for (const [id, code] of [
      ['menu', `let app = ${source}; await app.click(1);`],
      ['replace', `let app = ${source}; await app.click(19);`],
      ['fresh', 'let app = await cua.getApp("TextEdit");'],
      ['cancel', cancel],
      ['acquire-cancel', `let app = await cua.getApp("TextEdit"); ${cancel}`],
      ['escape', 'let app = await cua.getApp("TextEdit"); await app.pressKey("Escape");'],
      ['reacquire', 'let app = await cua.getApp("TextEdit");'],
      ['continued', 'await app.typeText("continued");'],
    ]) {
      const result = await h.call(id, 'js', { code });
      assert.ok(!result.isError, `${id}: ${JSON.stringify(result)}`);
      assert.ok(h.sent.some(msg => msg.id === id), `${id} must reach the engine`);
      if (id === 'reacquire') assert.doesNotMatch(JSON.stringify(result), /selected window not observed/);
    }
    assert.equal(h.selections.length, 0, 'a child must not trigger another window selection');
    assert.ok(h.observations.some(o => o.url === window('Source').url && o.nativeIdentity?.pid === 7));
  });
}

test('OH1 fresh acquisition verifies a URL-less menu after explicit selection', async t => {
  let child = false;
  const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined }) : undefined });
  const source = await h.open('Source');
  await h.call('first', 'js', { code: `await ${source}.click(1);` });
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  child = true;
  const result = await h.call('recovered', 'js', { code: 'let app = await cua.getApp("TextEdit"); await app.performSecondaryAction(1, "Cancel");' });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(h.sent.some(msg => msg.id === 'recovered'));
});

test('OH1 menu dismissal still requires the window lease', async t => {
  let child = false;
  const options = { onEngineCall: msg => { if (msg.id === 'menu') child = true; },
    tree: current => child ? childTree({ ...current, url: undefined }) : undefined };
  const h = fixture(t, options), source = await h.open('Source');
  await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` });
  options.busyWindow = true;
  const result = await h.call('cancel', 'js', { code: 'await app.performSecondaryAction(1, "Cancel");' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /window action refused/);
  assert.equal(h.sent.some(msg => msg.id === 'cancel'), false);
});

for (const [label, change] of [
  ['different URL', { url: 'file:///tmp/Other.txt' }],
  ['different title', { title: 'Other.txt', url: undefined }],
  ['other app', { app: 'Other', url: undefined }],
  ['standard document without URL', { url: undefined, root: '0 standard window' }],
]) test(`OH1 a ${label} never inherits the selected document`, async t => {
  let child = false;
  const options = { decline: true, onEngineCall: msg => { if (msg.id === 'menu') child = true; },
    tree: current => child ? childTree({ ...current, ...change }, change.root) : undefined };
  const h = fixture(t, options), source = await h.open('Source');
  await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` });
  const result = await h.call('wrong', 'js', { code: `await ${source}.typeText("must not run");` });
  assert.equal(result.isError, true);
  assert.equal(h.sent.some(msg => msg.id === 'wrong'), false);
});

for (const nativeMutation of [{ pid: 99 }, { processStart: 99 }, { windowNumber: 99 }, { window: 99 },
  { status: 'unknown' }, { matches: 2 }, { url: 'file:///tmp/Other.txt' }, { appId: 'org.example.Other' }]) {
  test(`OH1 a URL-less menu cannot hide changed native identity: ${JSON.stringify(nativeMutation)}`, async t => {
    let child = false;
    const options = { onEngineCall: msg => { if (msg.id === 'menu') child = true; },
      tree: current => child ? childTree({ ...current, url: undefined }) : undefined };
    const h = fixture(t, options), source = await h.open('Source');
    await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` });
    assert.ok(!(await h.call('same-app', 'js', { code: 'let app = await cua.getApp("TextEdit");' })).isError);
    options.nativeMutation = nativeMutation;
    for (const [id, code] of [['cancel', 'await app.performSecondaryAction(1, "Cancel");'],
      ['escape', 'await app.pressKey("Escape");']]) {
      const result = await h.call(id, 'js', { code });
      assert.equal(result.isError, true);
      assert.equal(h.sent.some(msg => msg.id === id), false);
    }
    const fresh = await h.call('fresh', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
    assert.equal(fresh.isError, true, 'a fresh read must not certify a different process or document');
  });
}

test('WD456 calls 5 to 7: refusal, select_window and handle retry send valid JSON-RPC', async t => {
  const options = { strictProtocol: true, decline: true };
  const h = fixture(t, options), source = await h.open('Source');
  await h.open('Target');
  const refused = await h.call('call5', 'js', { code: `let src = ${source}; await src.selectText(2, "move-62f9a451"); src` });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /window unconfirmed.*select_window/);
  options.decline = false;
  assert.ok(!(await h.call('call6', 'select_window', { app: appId, url: window('Source').url })).isError);
  const retry = await h.call('call7', 'js', { code: `await ${source}.selectText(2, "move-62f9a451")` });
  assert.equal(h.invalidRequests.length, 0);
  assert.ok(!retry.isError, JSON.stringify(retry));
  assert.equal(h.active.has('app:Source.txt'), false);
});

test('the app reservation survives prepareLease through the internal read and final handle action', async t => {
  const directory = mkdtempSync('/tmp/wd6c-leases-');
  const inputLease = new InputLease({ directory, holder: 'WD6c' });
  t.after(() => { inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
  const h = fixture(t, { inputLease, onEngineCall: msg => {
    if (msg.id !== 'action' && !String(msg.id).startsWith('sleight-opened-window-')) return;
    assert.equal(inputLease.inspect(leaseKey(window('Source'), 'app'))?.active, true);
  } });
  const source = await h.open('Source'); await h.open('Target');
  const result = await h.call('action', 'js', { code: `await ${source}.selectText(2, "move-62f9a451")` });
  assert.ok(!result.isError);
  assert.equal(inputLease.owned.has(leaseKey(window('Source'), 'app')), false);
});

for (const reset of [false, true]) test(`engine exit during an internal opened-window read recovers${reset ? ' through js_reset' : ''}`, async t => {
  const options = { holdOpenedRead: true };
  const h = fixture(t, options), source = await h.open('Source');
  await h.open('Target');
  h.send('interrupted', 'js', { code: `await ${source}.selectText(2, "move-62f9a451")` });
  for (let i = 0; i < 50 && !h.sent.some(msg => String(msg.id).startsWith('sleight-opened-window-')); i++) await tick();
  assert.ok(h.sent.some(msg => String(msg.id).startsWith('sleight-opened-window-')));
  assert.equal(h.active.has('app:Source.txt'), true);
  h.relay.engineEnded('Engine exited (0).');
  await tick();
  assert.equal(h.received.filter(msg => msg.id === 'interrupted').length, 1);
  assert.match(h.received.find(msg => msg.id === 'interrupted').result.content[0].text, /Engine exited/);
  assert.equal(h.active.size, 0, 'a dead engine retains no lease or heartbeat');
  if (reset) assert.ok(!(await h.call('reset', 'js_reset', {})).isError);
  const unsafe = await h.call('unsafe', 'js', { code: `await ${source}.typeText("never replay")` });
  assert.equal(unsafe.isError, true, 'a new app read is required after engine death');
  assert.equal(h.sent.some(msg => msg.id === 'unsafe'), false);
  assert.ok(!(await h.call('state', 'js', { code: 'await cua.getState()' })).isError);
  assert.ok(!(await h.call('fresh', 'js', { code: 'let fresh = await cua.getApp("TextEdit")' })).isError);
  assert.ok(!(await h.call('action', 'js', { code: 'await fresh.typeText("recovered")' })).isError);
  assert.ok(!(await h.call('select', 'select_window', { app: appId, url: window('Source').url })).isError);
});

test('WD3 calls 4 to 8: the first opened handle selects its Source URL before selectText', async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('select', 'js', { code: `let src = ${source};\nawait src.selectText(2, "move-62f9a451");\nsrc` });
  assert.ok(!result.isError);
  assert.equal(h.selections.length, 1);
  assert.equal(h.selections[0].url, 'file:///tmp/Source.txt');
  assert.equal(h.selections[0].expectedAppId, appId);
  assert.ok(h.leases.some(target => target.appId === appId && target.title == null));
  const action = h.sent.find(msg => msg.id === 'select');
  assert.match(action.params.arguments.code, /Source\.txt/);
  assert.doesNotMatch(action.params.arguments.code, /"title":"Target\.txt"/);
});

test('an opened handle alias keeps its file and avoids selection while already targeted', async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.call('alias', 'js', { code: `let doc = ${source}; await doc.selectText(1, "sample")` });
  assert.equal(h.selections.length, 0);
  await h.open('Target');
  await h.call('act', 'js', { code: 'await doc.typeText("text")' });
  assert.equal(h.selections.length, 1);
});

test('a standalone alias keeps its document on a later call', async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.call('alias', 'js', { code: `let app = ${source};` });
  await h.open('Target');
  const result = await h.call('act', 'js', { code: 'await app.selectText(1, "sample")' });
  assert.ok(!result.isError);
  assert.equal(h.selections.length, 1);
});

test('a call using two opened documents refuses before either receives input', async t => {
  const h = fixture(t), source = await h.open('Source'), target = await h.open('Target');
  const result = await h.call('both', 'js', { code: `await ${source}.typeText("a"); await ${target}.typeText("b")` });
  assert.equal(result.isError, true);
  assert.equal(h.sent.some(msg => msg.id === 'both'), false);
});

for (const options of [{ decline: true }, { wrongRead: true }]) test(`unproven opened window refuses with its URL and select_window call: ${JSON.stringify(options)}`, async t => {
  const h = fixture(t, options), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('refuse', 'js', { code: `await ${source}.selectText(1, "sample")` });
  assert.equal(result.isError, true);
  assert.equal(h.sent.some(msg => msg.id === 'refuse'), false);
  const text = result.content.map(c => c.text).join('\n');
  assert.match(text, /Source\.txt.*select_window.*"url":"file:\/\/\/tmp\/Source.txt"/);
  assert.equal(text.split('\n').length, 1);
});

test('unavailable native identity refuses an opened handle instead of falling back to another document', async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.open('Target'); h.breakIdentity();
  const result = await h.call('refuse', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.equal(h.sent.some(msg => msg.id === 'refuse'), false);
  assert.match(result.content[0].text, /Source.txt.*select_window/);
});

test('WD3 call 13: the sole selected window supplies only the drag source windowId', async t => {
  const h = fixture(t);
  await h.open('Source'); await h.open('Target');
  const result = await h.call('drag', 'drag', { app, from: 'the current text selection', to: [20, 98] });
  assert.ok(!result.isError);
  assert.equal(h.drags[0].windowId, 11);
  assert.equal(h.drags[0].toWindowId, undefined);
});

test('an explicit drag source and destination stay unchanged', async t => {
  const h = fixture(t);
  await h.open('Source'); await h.open('Target');
  await h.call('drag', 'drag', { app, windowId: 12, toWindowId: 11, from: 'the current text selection', to: [100, 120] });
  assert.equal(h.drags[0].windowId, 12);
  assert.equal(h.drags[0].toWindowId, 11);
});

for (const selection of [{ ok: false }, { ok: true, target: window('Source'), pid: 99 }]) test(`unproven selection retains drag ambiguity: ${JSON.stringify(selection)}`, async t => {
  const h = fixture(t, { selection });
  await h.open('Source');
  await h.call('drag', 'drag', { app, from: 'the current text selection', to: [100, 120] });
  assert.equal(h.drags[0]?.windowId, undefined);
});


test('a successful selection releases its app lease after the action reply', async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.open('Target');
  assert.ok(!(await h.call('act', 'js', { code: `await ${source}.typeText("text")` })).isError);
  assert.ok(h.released.includes('app:Source.txt'));
  assert.equal(h.active.has('app:Source.txt'), false);
});

test('busy opened-window lease reports the holder instead of an unconfirmed window', async t => {
  const h = fixture(t, { busy: true }), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('busy', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /held by another session/);
  assert.doesNotMatch(result.content[0].text, /window unconfirmed/);
  assert.equal(h.selections.length, 0);
});

test('a selection returning a different window number never forwards the action', async t => {
  const h = fixture(t, { wrongNumber: true }), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('wrong-number', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.equal(h.sent.some(msg => msg.id === 'wrong-number'), false);
});

test('opened bindings survive a helper epoch change after a fresh app read', async t => {
  const h = fixture(t), source = await h.open('Source');
  assert.ok(!(await h.call('first', 'js', { code: `await ${source}.typeText("text")` })).isError);
  h.resetIdentity();
  await h.call('fresh', 'js', { code: 'let fresh = await cua.getApp("TextEdit")' });
  const result = await h.call('second', 'js', { code: `await ${source}.typeText("text")` });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(h.observations.filter(o => o.allowUnfocused).every(o => o.nativeIdentity === undefined));
});

for (const rebound of [
  'doc &&= other', 'doc ||= other', 'doc ??= other', 'doc += 1', 'doc++',
  'for (doc of items) {}', 'for (let doc of items) {}', 'for (doc in items) {}',
  '[doc] = items', '({ value: doc } = other)', 'let { value: doc } = other',
  '((doc) => doc)(other)', '(doc => doc)(other)', '(function(doc) { return doc; })(other)',
  'let doc = other',
]) test(`a mixed call forgets a non-trivial opened alias rebinding: ${rebound}`, async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.call('alias', 'js', { code: `let doc = ${source};` });
  await h.call('mixed', 'js', { code: `${rebound}; await ${source}.typeText("text")` });
  await h.open('Target');
  const before = h.selections.length;
  await h.call('later', 'js', { code: 'await doc.typeText("text")' });
  assert.equal(h.selections.length, before, 'a forgotten alias must not select Source');
});

test('flow refusal happens before opened-window selection', async t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = fixture(t, { flowRules }), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('blocked', 'js', { code: `await ${source}.typeText("SECRET")` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Flow rules:/);
  assert.equal(h.selections.length, 0);
});

test('an opened-window call cannot select while a flow decision is pending', async t => {
  let decide;
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = fixture(t, { flowRules, ask: (_message, _scope, options) => options?.kind === 'flow'
    ? new Promise(resolve => { decide = resolve; }) : Promise.resolve('accept') });
  const source = await h.open('Source'), target = await h.open('Target');
  await h.call('blocked', 'js', { code: `await ${target}.typeText("SECRET")` });
  h.send('exception', 'flow_exception', {});
  await tick();
  assert.equal(typeof decide, 'function');
  const result = await h.call('while-asking', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.equal(h.selections.length, 0);
  decide('cancel'); await tick();
});

test('a flow exception permits one identical opened-window retry', async t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = fixture(t, { flowRules }), source = await h.open('Source');
  await h.open('Target');
  const code = `await ${source}.typeText("SECRET")`;
  assert.equal((await h.call('blocked', 'js', { code })).isError, true);
  assert.ok(!(await h.call('exception', 'flow_exception', {})).isError);
  const result = await h.call('permitted', 'js', { code });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(h.selections.length, 1);
});


test('selection still requires focused identity after the engine read confirms the header', async t => {
  const h = fixture(t, { unfocusedSelection: true }), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('unfocused', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.equal(h.selections.length, 1);
  assert.equal(h.sent.some(msg => msg.id === 'unfocused'), false);
  assert.equal(h.active.has('app:Source.txt'), false);
});

test('drag inference uses the census number when a different window of the same file is focused', async t => {
  const h = fixture(t);
  await h.open('Source'); h.focusDuplicate();
  await h.call('drag', 'drag', { app, from: 'the current text selection', to: [20, 98] });
  assert.equal(h.drags[0].windowId, 11);
});

test('a selection census without a window number cannot infer the focused duplicate', async t => {
  const h = fixture(t, { selection: { ok: true, target: window('Source'), pid: 7 } });
  await h.open('Source'); h.focusDuplicate();
  await h.call('drag', 'drag', { app, from: 'the current text selection', to: [20, 98] });
  assert.equal(h.drags[0].windowId, undefined);
});

test('an opened-window call cannot select while saved changes await a review decision', async t => {
  const root = mkdtempSync('/tmp/lane-wd6b-review-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['Source', 'Target']) writeFileSync(`${root}/${name}.txt`, 'before');
  let decide;
  const h = fixture(t, { root, changeReview: true, ask: (_message, _scope, options) => options?.kind === 'review'
    ? new Promise(resolve => { decide = resolve; }) : Promise.resolve('accept') });
  const source = await h.open('Source');
  assert.ok(!(await h.call('edit', 'js', { code: `await ${source}.typeText("text")` })).isError);
  await h.open('Target');
  h.send('review', 'review_changes', { op: 'review' }); await tick();
  assert.equal(typeof decide, 'function');
  const result = await h.call('while-reviewing', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /reviewing changes/);
  assert.equal(h.selections.length, 0);
  decide('cancel'); await tick();
});


test('a refusal after opened-window selection releases its app lease', async t => {
  const h = fixture(t, { busyWindow: true }), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('late-refusal', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /window action refused/);
  assert.equal(h.selections.length, 1);
  assert.equal(h.active.has('app:Source.txt'), false);
});
