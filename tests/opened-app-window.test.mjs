import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const appId = 'com.apple.TextEdit', app = 'TextEdit';
const window = name => ({ appId, app, title: `${name}.txt`, url: `file:///tmp/${name}.txt` });
const identity = target => ({ ...target, status: 'ok', epoch: 'fixture', window: target.title === 'Source.txt' ? 1 : 2,
  windowNumber: target.title === 'Source.txt' ? 11 : 12, pid: 7, processStart: 1, matches: 1 });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const sent = [], received = [], selections = [], leases = [], drags = [];
  let current, broken = false;
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    ask: async () => 'accept',
    inputLease: { acquire: target => { leases.push(target); return 'lease'; }, grant: () => ({}), renew() {}, release() {}, close() {} },
    windowIdentity: async target => broken ? { status: 'unknown' } : identity(target),
    localTools: { tools: [{ name: 'open_file' }, { name: 'select_window' }, { name: 'drag' }],
      target: async () => ({ appId, app, pid: 7 }),
      selectionWindow: async () => options.selection ?? { ok: true, target: window('Source'), pid: 7 },
      call: async (name, args, approve) => {
        if (name === 'drag') { drags.push(args); return { content: [] }; }
        if (name === 'select_window') {
          selections.push(args);
          if (options.decline || !await approve(['select_window', appId], 'Select?')) return { isError: true, content: [] };
          current = options.wrongRead ? window('Target') : window('Source');
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, target: window('Source'), identity: { pid: 7, windowNumber: 11 } }) }] };
        }
        current = window(args.path.includes('Source') ? 'Source' : 'Target');
        return { content: [], _meta: { 'sleight/openedApp': appId,
          'sleight/openedFile': { path: args.path, real: args.path, size: 30 } } };
      } } });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', bytes => {
    for (const msg of bytes.toString().trim().split('\n').map(JSON.parse)) {
      sent.push(msg);
      if (msg.method !== 'tools/call') continue;
      serverOut.write(JSON.stringify({ id: msg.id, result: { content: [{ type: 'text',
        text: `Window: "${current.title}", App: ${app}.\nURL: ${current.url}\n0 standard window ${current.title}\n\t1 text area Value: sample\n\t2 text area Value: alpha move-62f9a451 omega` }],
      _meta: { 'codex/toolSurface': { app: { appId } } } } }) + '\n');
    }
  });
  const call = async (id, name, args) => {
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < 50 && !received.some(msg => msg.id === id); i++) await tick();
    const reply = received.find(msg => msg.id === id);
    assert.ok(reply, `no reply for ${id}`);
    return reply.result;
  };
  const open = async name => {
    const result = await call(name, 'open_file', { app, path: `/tmp/${name}.txt` });
    return /Window handle: `([^`]+)`/.exec(result.content.map(c => c.text ?? '').join('\n'))[1];
  };
  return { call, open, sent, selections, leases, drags, breakIdentity: () => { broken = true; } };
}

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
