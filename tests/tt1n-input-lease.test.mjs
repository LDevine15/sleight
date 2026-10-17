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
async function fixture(t, { initial, base = document, after = menu, nativeChange, identity, afterItem = after, actionOutput = false, ...options } = {}) {
  let text = base, writes = [];
  const clicks = [], sent = [], received = [];
  let identityChecks = 0;
  const native = { windowNumber: 22, hidIdleSeconds: 1000, status: 'ok' };
  const raw = { getAXState: async () => text, click: async number => {
    clicks.push(number); text = clicks.length === 1 ? after : afterItem;
    if (actionOutput) writes.push('clicked:' + number);
    if (nativeChange === 'window') native.windowNumber = 23;
    if (nativeChange === 'focus') native.hidIdleSeconds = 0;
    if (nativeChange === 'unfocused') native.status = 'mismatch';
  }, pressKey: async () => {} };
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
  let next = 0, cursor = 0;
  const call = async (code, name = 'js') => {
    const id = ++next;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n');
    for (let i = 0; i < 100; i++) {
      await tick();
      while (cursor < sent.length) {
        const request = sent[cursor++]; writes = [];
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
  sent.length = received.length = 0; cursor = 0; text = initial ?? base;
  return { clicks, native, sent, received, relay, call, identityChecks: () => identityChecks, setText: value => { text = value; } };
}

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
