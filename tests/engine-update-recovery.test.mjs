import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createContext, runInContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { createStartupCache } from '../plugins/sleight/lib/startup-cache.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const tree = 'Window: "Untitled", App: Example.\n0 standard window Untitled\n\t7 button Keep, ID: keep';
const pipeError = { isError: true, content: [{ type: 'text', text: 'Sky Computer Use native pipe startup failed' }] };
const approval = (app = 'Example') => ({ id: 'permission', method: 'elicitation/create', params: { message: `Allow ${app}?`,
  _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app }, riskLevel: 'low' } } });
const flush = async () => { for (let n = 0; n < 10; n++) await setImmediate(); };

function fixture(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), replies = [], engines = [];
  let asks = 0, stops = 0, starts = 0, changed = false;
  const fresh = () => {
    const serverIn = new PassThrough(), serverOut = new PassThrough(), sent = [];
    const reply = msg => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    serverIn.on('data', bytes => {
      for (const line of bytes.toString().trim().split('\n')) {
        const msg = JSON.parse(line); sent.push(msg);
        if (msg.method === 'initialize' && !options.holdInitialize) reply({ id: msg.id,
          ...(starts && options.initializeError ? { error: { code: -32603, message: 'fixture initialization failed' } }
            : { result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }) });
        if (msg.params?.name === 'turn_ended') reply({ id: msg.id, result: { content: [] } });
      }
    });
    engines.push({ serverIn, serverOut, sent, reply });
    return { serverIn, serverOut };
  };
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, ...fresh(), changeReview: false, stopGraceMs: 1,
    ask: async () => { asks++; return 'accept'; },
    engineChanged: () => changed,
    stopEngine: async () => { stops++; return { collected: options.collected !== false }; },
    restartEngine: async () => { starts++; changed = false; return fresh(); },
    inspectInput: async () => ({ ok: true }),
    ...options.relay,
  });
  t.after(() => relay.dispose());
  const send = msg => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  send({ id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ method: 'notifications/initialized' });
  return { relay, replies, engines, send, replace: () => { changed = true; },
    get starts() { return starts; }, get stops() { return stops; }, get asks() { return asks; },
    call: (id, code) => send({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }),
    reply: (id, result = { content: [{ type: 'text', text: tree }], _meta: { 'codex/toolSurface': { app: { appId: 'test.example' } } } }) =>
      engines.at(-1).reply({ id, result }),
  };
}

test('a pipe error reconnects even without a version change, and keeps preapproved grants', async t => {
  const preapproved = new PreapprovedApps({ version: 1, apps: [{ app: 'Example', riskLevel: 'low' }] });
  const h = fixture(t, { relay: { preapproved } });
  h.call(1, 'await cua.getApp("Example")'); h.engines[0].reply(approval()); await flush(); h.reply(1);
  h.call(2, 'await cua.getApp("Example")'); h.reply(2, pipeError); await flush();
  assert.equal(h.starts, 1); assert.equal(h.stops, 1);
  assert.deepEqual(h.engines[1].sent.find(msg => msg.id === 2).params._meta,
    h.engines[0].sent.find(msg => msg.id === 2).params._meta, 'reconnection keeps the client session and turn identity');
  h.engines[1].reply(approval()); await flush(); h.reply(2);
  assert.equal(h.asks, 0);
  assert.equal(h.engines[1].sent.find(msg => msg.result?.action)?.result.action, 'accept');
  assert.ok(!h.replies.find(msg => msg.id === 2).result.isError);
  assert.equal(h.replies.filter(msg => msg.id === 2).length, 1);
});

for (const handle of ['app', '$app']) for (const proactive of [false, true]) for (const fail of [false, true]) test(`reconnected ${handle} keeps the stale-number guard (${proactive ? 'version change' : 'pipe error'}, ${fail ? 'changed' : 'same'} row)`, async t => {
  const h = fixture(t, { relay: { inputLease: { acquire: () => 'owned', grant: () => undefined, renew() {}, close() {} } } });
  h.call(1, `let ${handle} = await cua.getApp("Example")`); h.reply(1);
  if (proactive) h.replace();
  h.call(2, `await ${handle}.click(7)`);
  if (!proactive) h.reply(2, pipeError);
  await flush();
  assert.equal(h.starts, 1);
  const request = h.engines[1].sent.find(msg => msg.id === 2);
  assert.ok(request, 'the pending action is retried after initialization');
  let clicks = 0;
  const raw = { getAXState: async () => fail ? tree.replace('Keep, ID: keep', 'Delete, ID: delete') : tree,
    click: async () => { clicks++; }, appId: 'test.example' };
  const context = createContext({ cua: { getApp: async id => { assert.equal(id, 'test.example'); return raw; } }, nodeRepl: { write() {} } });
  const execute = () => runInContext(`(async () => { ${request.params.arguments.code} })()`, context);
  if (fail) { await assert.rejects(execute, /changed|stale|matches/i); assert.equal(clicks, 0); }
  else { await execute(); assert.equal(clicks, 1); }
  h.reply(2);
});

test('an initialization failure returns the original pipe error and the failed reconnect, without a retry loop', async t => {
  const h = fixture(t, { initializeError: true });
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, pipeError); await flush();
  const reply = h.replies.find(msg => msg.id === 1);
  assert.equal(reply.result.isError, true);
  assert.match(JSON.stringify(reply), /Sky Computer Use native pipe startup failed/);
  assert.match(JSON.stringify(reply), /fixture initialization failed/);
  assert.equal(h.starts, 1);
  assert.equal(h.engines[1].sent.some(msg => msg.method === 'tools/call' && msg.params.name === 'js'), false);
});

test('failed collection never starts a replacement or hides the pending failure', async t => {
  const h = fixture(t, { collected: false });
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, pipeError); await flush();
  assert.equal(h.starts, 0);
  assert.match(JSON.stringify(h.replies.find(msg => msg.id === 1)), /collection is unconfirmed/);
  h.call(2, 'await cua.getApp("Example")');
  assert.match(JSON.stringify(h.replies.find(msg => msg.id === 2)), /collection is unconfirmed/);
  assert.equal(h.stops, 1);
});

test('version changes and pipe failures do not collect another pending call', async t => {
  const h = fixture(t);
  h.call(1, 'await cua.getState()'); h.replace(); h.call(2, 'await cua.getState()');
  assert.match(JSON.stringify(h.replies.find(msg => msg.id === 2)), /pending/);
  assert.equal(h.stops, 0);
  // A second already-running read also prevents collection on an error.
  const other = fixture(t);
  other.call(1, 'await cua.getState()'); other.call(2, 'await cua.getState()');
  other.reply(1, pipeError); await flush();
  assert.equal(other.stops, 0); assert.equal(other.starts, 0);
  assert.equal(other.replies.find(msg => msg.id === 1).result.isError, true);
  other.reply(2); h.reply(1);
});

test('Stop during replacement initialization prevents the queued retry and keeps internal replies private', async t => {
  const h = fixture(t, { holdInitialize: true });
  h.engines[0].reply({ id: 'init', result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } });
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, pipeError); await flush();
  assert.equal(h.starts, 1);
  h.send({ id: 'stop', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
  await flush();
  assert.ok(h.replies.find(msg => msg.id === 'stop'));
  assert.equal(h.engines[1].sent.some(msg => msg.params?.name === 'js'), false);
  assert.equal(h.replies.some(msg => String(msg.id).startsWith('sleight-initialize-')), false);
});

test('a replacement never serves or verifies its tools against the old engine handshake cache', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-update-cache-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const startupCache = createStartupCache({ directory, identity: { engine: 'old' } });
  const warm = fixture(t, { relay: { startupCache } });
  warm.send({ id: 'old-list', method: 'tools/list' });
  warm.engines[0].reply({ id: 'old-list', result: { tools: [{ name: 'js', description: 'Old engine', inputSchema: { type: 'object' } }] } });
  warm.relay.dispose();
  const h = fixture(t, { relay: { startupCache } });
  h.call(1, 'await cua.getApp("Example")'); h.reply(1, pipeError); await flush(); h.reply(1);
  h.send({ id: 'new-list', method: 'tools/list' });
  assert.equal(h.replies.some(msg => msg.id === 'new-list'), false, 'old cached tools must not escape');
  h.engines[1].reply({ id: 'new-list', result: { tools: [{ name: 'js', description: 'New engine', inputSchema: { type: 'object' } }] } });
  assert.match(h.replies.find(msg => msg.id === 'new-list').result.tools[0].description, /New engine/);
});
