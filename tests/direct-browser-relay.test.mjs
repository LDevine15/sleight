import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';
import { directBrowserServer } from '../plugins/sleight/lib/launch.mjs';

async function route() {
  return createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true, status: () => 'connected',
    redact: value => value, endSession: () => ({ revoked: true, cleanup: [] }),
    client: { request: () => ({ phase: 'verified', effect: 'verified', completed: 1, untouched: 0,
      observation: { complete: true }, results: [{ effect: 'verified', observation: { complete: true } }] }) } });
}
function harness(t, directBrowser) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  for (const [stream, records] of [[serverIn, sent], [clientOut, received]]) stream.on('data', b => records.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, directBrowser, changeReview: false });
  t.after(() => relay.close());
  return { relay, sent, received,
    send: message => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'),
    reply: message => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') };
}
test('the route selects computer-only engine authority without changing the default config', async () => {
  const server = { command: 'synthetic-engine', env: { CUA_REPL_ENABLED_SURFACES: 'browser,computer', other: 'kept' } };
  assert.equal(directBrowserServer(server), server);
  assert.throws(() => directBrowserServer(server, { approved: true }), /TRUSTED_ROUTE_REQUIRED/);
  const selected = directBrowserServer(server, await route());
  assert.equal(selected.env.CUA_REPL_ENABLED_SURFACES, 'computer');
  assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  assert.equal(selected.env.other, 'kept');
});
test('relay advertises four verbs and handles them without engine native leases', async t => {
  const h = harness(t, await route());
  h.send({ id: 1, method: 'tools/list' });
  h.reply({ id: 1, result: { tools: [{ name: 'js', description: 'native engine JS' }, { name: 'turn_ended' }] } });
  assert.deepEqual(h.received.at(-1).result.tools.filter(t => t.name.startsWith('browser_')).map(t => t.name),
    ['browser_open', 'browser_read', 'browser_act', 'browser_fill']);
  const before = h.sent.length;
  h.send({ id: 2, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await new Promise(r => setImmediate(r));
  assert.equal(h.sent.length, before);
  assert.equal(JSON.parse(h.received.at(-1).result.content[0].text).completed, 1);
  await h.relay.close();
  h.send({ id: 3, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await new Promise(r => setImmediate(r));
  assert.equal(h.received.at(-1).result.isError, true);
});
test('an unbranded project object cannot install a direct route', t => {
  assert.throws(() => harness(t, { approved: true }), /TRUSTED_ROUTE_REQUIRED/);
});
