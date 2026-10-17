import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createContext, runInContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const tree = 'Window: "note.txt", App: Example Editor.\n0 standard window note.txt\n\t1 text area Value: draft';
const image = { type: 'image', data: 'AA==', mimeType: 'image/png' };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function open(t, { flag, failShot = false, failOpen = false, failRead = false, changeReview = false, warmRepl = false } = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const sent = [], received = [], events = [], approvals = [], leases = [];
  const previous = process.env.SLEIGHT_OPEN_SHOT;
  if (flag === undefined) delete process.env.SLEIGHT_OPEN_SHOT;
  else process.env.SLEIGHT_OPEN_SHOT = flag;
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview, warmRepl,
    ask: async message => { approvals.push(message); return 'accept'; },
    inputLease: { acquire: target => { leases.push(target); return 'lease'; }, renew() {}, release() {}, close() {} },
    localTools: { tools: [{ name: 'open_file' }], target: async () => ({ appId: 'org.example.editor', app: 'Example Editor' }),
      call: async (_name, _args, approve) => {
        if (!await approve(['open_file', 'Example Editor'], 'Allow opening?')) throw Error('declined');
        return failOpen ? { isError: true, content: [{ type: 'text', text: 'Open refused.' }] }
          : { content: [{ type: 'text', text: 'Opened note.txt.' }], _meta: { 'sleight/openedApp': 'org.example.editor' } };
      } } });
  if (previous === undefined) delete process.env.SLEIGHT_OPEN_SHOT;
  else process.env.SLEIGHT_OPEN_SHOT = previous;
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let content = [];
  const write = text => content.push({ type: 'text', text });
  const shot = async options => {
    events.push('screenshot');
    if (failShot) throw Error('Screenshot unavailable');
    if (options?.emit !== false) content.push(image);
    return 'fake pixels';
  };
  const raw = { getScreenshot: shot, getAXState: async () => tree,
    getAXStateAndScreenshot: async options => {
      events.push('screenshot');
      if (failShot) throw Error('Screenshot unavailable');
      if (options?.emit !== false) { write(tree); content.push(image); }
      return { state: tree, screenshot: 'fake pixels' };
    } };
  const context = createContext({ cua: { listApps: async () => [], getApp: async () => {
    events.push('acquire');
    if (failRead) throw Error('Window read refused');
    write(tree); return raw;
  } }, nodeRepl: { write, emitImage: async () => content.push(image) } });
  let queue = Promise.resolve();
  serverIn.on('data', data => {
    for (const msg of data.toString().trim().split('\n').map(JSON.parse)) {
      sent.push(msg);
      if (msg.method !== 'tools/call') continue;
      queue = queue.then(async () => {
        content = [];
        let isError = false;
        try { await runInContext(`(async () => { ${msg.params.arguments.code} })()`, context); }
        catch (error) { isError = true; write(error.message); }
        serverOut.write(JSON.stringify({ id: msg.id, result: { content, isError,
          _meta: { 'codex/toolSurface': { app: { appId: 'org.example.editor' } } } } }) + '\n');
      });
    }
  });
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'open_file',
    arguments: { app: 'Example Editor', path: '/tmp/note.txt' } } }) + '\n');
  for (let i = 0; i < 30 && !received.some(msg => msg.id === 1); i++) { await tick(); await queue; }
  const result = received.find(msg => msg.id === 1)?.result;
  assert.ok(result, JSON.stringify(received));
  return { result, sent, events, approvals, leases, received };
}

for (const flag of [undefined, '0', 'true']) test(`open screenshot stays off for flag=${flag}`, async t => {
  const h = await open(t, { flag });
  assert.deepEqual(h.events, ['acquire']);
  assert.equal(h.result.isError, false);
  assert.equal(h.result.content.some(c => c.type === 'image'), false);
  assert.ok(h.result.content.some(c => c.text === tree));
  assert.equal(h.sent.filter(msg => msg.method === 'tools/call').length, 1);
});

for (const changeReview of [false, true]) test(`flag on returns one screenshot after the tree in one engine call; changeReview=${changeReview}`, async t => {
  const h = await open(t, { flag: '1', changeReview });
  assert.deepEqual(h.events, ['acquire', 'screenshot']);
  assert.equal(h.result.isError, false);
  assert.deepEqual(h.result.content.filter(c => c.type === 'image'), [image]);
  assert.ok(h.result.content.findIndex(c => c.text === tree) < h.result.content.findIndex(c => c.type === 'image'));
  assert.match(h.result.content.map(c => c.text ?? '').join('\n'), /Window handle: `__sleightOpenedApp\d+`/);
  assert.equal(h.sent.filter(msg => msg.method === 'tools/call').length, 1);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.leases.length, 1, 'only the existing local open reserves an app');
  assert.equal(h.received.filter(msg => msg.id === 1).length, 1);
});

test('a screenshot failure keeps the successful open, tree and handle', async t => {
  const h = await open(t, { flag: '1', failShot: true });
  assert.deepEqual(h.events, ['acquire', 'screenshot']);
  assert.equal(h.result.isError, false);
  assert.ok(h.result.content.some(c => c.text === tree));
  assert.equal(h.result.content.some(c => c.type === 'image'), false);
  assert.match(h.result.content.map(c => c.text ?? '').join('\n'), /Opened note.txt.*\n.*Window:.*\n/s);
  assert.match(h.result.content.map(c => c.text ?? '').join('\n'), /Window handle:/);
});

test('failed open and failed acquisition do not request a screenshot', async t => {
  for (const failure of [{ failOpen: true }, { failRead: true }]) {
    const h = await open(t, { flag: '1', ...failure });
    assert.equal(h.result.isError, true);
    assert.equal(h.events.includes('screenshot'), false);
  }
});
