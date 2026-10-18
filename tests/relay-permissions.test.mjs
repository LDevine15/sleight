import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { appRefusal } from '../plugins/sleight/lib/permissions.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
const LINE = 'You blocked sleight in Blocked App (sleight-mcp permissions unblock com.example.blocked lifts it).';

// The user's blocks, as the launcher's permission check gives them: only com.example.blocked ("Blocked App").
function blocks() {
  const perms = { state: 'ok', apps: [{ id: 'com.example.blocked', name: 'Blocked App' }], sites: [] }, noted = [];
  return { noted, app: query => appRefusal(perms, query), noteApp: app => noted.push(app) };
}

function harness(t, options = {}) {
  const [clientIn, clientOut, serverIn, serverOut] = [new PassThrough(), new PassThrough(), new PassThrough(), new PassThrough()];
  const toServer = [], toClient = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const directory = mkdtempSync(join(tmpdir(), 'sleight-permissions-relay-'));
  const permissions = 'permissions' in options ? options.permissions : blocks();
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 's', permissions,
    inputLease: new InputLease({ directory, holder: 'A' }), ...options });
  t.after(() => { relay.close(); removeTemp(directory); });
  const call = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return {
    toServer, toClient, permissions,
    js: (id, code) => call(id, 'js', { code }), call,
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
    reply: id => toClient.find(m => m.id === id),
    sent: id => toServer.some(m => m.id === id),
  };
}
const read = (id, app, appId, title = 'Doc') => ({ jsonrpc: '2.0', id, result: {
  content: [{ type: 'text', text: `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window ${title}\n\t1 button Save` }],
  _meta: { 'codex/toolSurface': { app: { appId } } } } });

test('a call that names a blocked app, by bundle id or name, gets the user\'s line and never reaches the engine', async t => {
  const h = harness(t);
  for (const [id, code] of [[1, 'let app = await cua.getApp("com.example.blocked")'], [2, "let app = await cua.getApp('Blocked App')"],
    [3, 'let a = await cua.getApp("com.example.fine"); let b = await cua.getApp("blocked app"); await b.click(1)']]) {
    h.js(id, code);
    await settle();
    assert.equal(h.sent(id), false, code);
    assert.deepEqual(h.reply(id).result, { isError: true, content: [{ type: 'text', text: LINE }] }, code);
  }
});

test('a read that turns out to be a blocked app shows Claude only the line, and the next action stops before the engine', async t => {
  const h = harness(t);
  h.js(1, 'let app = await cua.getApp("Some Alias")');
  await settle();
  assert.equal(h.sent(1), true, 'an unknown name still goes to the engine');
  h.fromServer(read(1, 'Blocked App', 'com.example.blocked'));
  await settle();
  assert.deepEqual(h.reply(1).result, { isError: true, content: [{ type: 'text', text: LINE }] });
  assert.doesNotMatch(JSON.stringify(h.reply(1)), /button Save/, 'nothing of the window reaches Claude');
  h.js(2, 'await app.click(1)');
  await settle();
  assert.equal(h.sent(2), false);
  assert.equal(h.reply(2).result.content[0].text, LINE);
  assert.deepEqual(h.permissions.noted, [], 'a blocked app is never offered as the current app');
});

test('an allowed app is noted for the menu, and a handle to a blocked app is refused while another app holds the lease', async t => {
  const h = harness(t);
  h.js(1, 'let other = await cua.getApp("com.example.fine")');
  await settle();
  h.fromServer(read(1, 'Fine App', 'com.example.fine'));
  await settle();
  assert.equal(h.reply(1).result.isError, undefined);
  assert.deepEqual(h.permissions.noted.at(-1), { bundleId: 'com.example.fine', name: 'Fine App' });
  h.js(2, 'await other.click(1)');
  await settle();
  assert.equal(h.sent(2), true);
  h.fromServer(read(2, 'Fine App', 'com.example.fine'));
  await settle();
  // An action on a handle that an earlier read bound to the blocked app.
  h.js(3, 'let held = await cua.getApp("Alias Two")');
  await settle();
  h.fromServer(read(3, 'Blocked App', 'com.example.blocked'));
  await settle();
  h.js(4, 'let x = await cua.getApp("com.example.fine"); await held.click(1)');
  await settle();
  assert.equal(h.sent(4), false);
  assert.equal(h.reply(4).result.content[0].text, LINE);
});

test('the engine\'s approval for a blocked app is declined without asking, and the call answers with the line', async t => {
  const asked = [];
  const h = harness(t, { ask: async message => { asked.push(message); return 'accept'; } });
  h.js(1, 'let app = await cua.getApp("Alias")');
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "Blocked App"?',
    _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'high', tool_params: { app: 'Blocked App' } } } });
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual(h.toServer.find(m => m.id === 'e1').result, { action: 'decline' });
  h.fromServer({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'The user declined.' } });
  await settle();
  assert.deepEqual(h.reply(1).result, { isError: true, content: [{ type: 'text', text: LINE }] });
});

test('a local tool naming a blocked app is refused before it runs', async t => {
  const ran = [];
  const h = harness(t, { localTools: { tools: [{ name: 'menu_bar', description: 'x', inputSchema: { type: 'object' } }],
    call: async name => { ran.push(name); return { content: [{ type: 'text', text: 'ok' }] }; } } });
  h.call(1, 'menu_bar', { op: 'open', app: 'com.example.blocked' });
  await settle();
  assert.deepEqual(ran, []);
  assert.equal(h.reply(1).result.content[0].text, LINE);
});

test('a revoke that takes an app off the always list also ends this session\'s own approval of it', async t => {
  const asked = [];
  let removed;
  const preapproved = { size: 0, allows: () => false, list: () => [], add() {}, onRemoved: listener => { removed = listener; } };
  const h = harness(t, { preapproved, ask: async message => { asked.push(message); return 'accept'; } });
  const approval = id => h.fromServer({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message: 'Allow Computer Use to use "com.example.notes"?',
    _meta: { connector_id: 'computer-use', persist: ['session', 'always'], riskLevel: 'low', tool_params: { app: 'com.example.notes' } } } });
  approval('e1'); await settle();
  approval('e2'); await settle();
  assert.equal(asked.length, 1, 'the session remembers the first answer');
  removed(['com.example.other']); approval('e3'); await settle();
  assert.equal(asked.length, 1, 'another app\'s revoke changes nothing here');
  removed(['com.example.notes']); approval('e4'); await settle();
  assert.equal(asked.length, 2, 'after the revoke the app asks again');
});

test('without the launcher\'s permissions nothing is blocked', async t => {
  const h = harness(t, { permissions: null });
  h.js(1, 'let app = await cua.getApp("com.example.blocked")');
  await settle();
  assert.equal(h.sent(1), true);
});
