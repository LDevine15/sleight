import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { installedPipeFixture } from './fixtures/direct-browser-installed-pipes.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { prepareInstalledStartup } from '../plugins/sleight/lib/launch.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const disposers = [];
  const pipe = await installedPipeFixture({ after: fn => disposers.push(fn) }), prepared = await prepareInstalledStartup(() => pipe.bridge);
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const received = [], sent = [], traces = [];
  clientOut.on('data', b => received.push(JSON.parse(b)));
  serverIn.on('data', b => sent.push(JSON.parse(b)));
  const relay = createRelay({ ...prepared, clientIn, clientOut, serverIn, serverOut,
    trace: (...args) => traces.push(args), changeReview: false });
  t.after(async () => { await relay.close(); for (const dispose of disposers) dispose(); });
  const send = (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args } }) + '\n');
  return { ...pipe, received, sent, traces, send, relay };
}
test('private installed bootstrap and user text never reach engine, traces or tool results', async t => {
  const f = await fixture(t);
  f.send(1, 'turn_ended', { sleight_turbo: { event: 'bootstrap' } }); await tick();
  const envelope = JSON.parse(f.received.find(row => row.id === 1).result.content[0].text).sleightTurbo;
  assert.equal(envelope.nonce, f.bridge.bootstrapEnvelope().nonce);
  f.send(2, 'turn_ended', { sleight_turbo: { ...envelope, event: 'begin', turn: 'one', text: 'private user request' } });
  await tick(); await tick();
  assert.equal(f.received.find(row => row.id === 2).result.isError, false);
  f.send(3, 'browser_read', { tab: 'tfixture' }); await tick(); await tick();
  assert.equal(f.received.find(row => row.id === 3).result.isError, false);
  assert.doesNotMatch(JSON.stringify(f.traces), /private user request|aaaaaaaaaaaaaaaa/);
  assert.equal(f.sent.length, 0);
  assert.doesNotMatch(JSON.stringify(f.received.find(row => row.id === 3)), /nonce|private user request/);
});
test('replayed bootstrap and forged turn are rejected without creating authority', async t => {
  const f = await fixture(t);
  f.send(1, 'turn_ended', { sleight_turbo: { event: 'bootstrap' } }); await tick();
  f.send(2, 'turn_ended', { sleight_turbo: { event: 'bootstrap' } }); await tick();
  assert.equal(f.received.find(row => row.id === 2).result.isError, true);
  f.send(3, 'turn_ended', { sleight_turbo: { ...f.bridge.bootstrapEnvelope(), nonce: 'b'.repeat(64), event: 'begin', turn: 'one', text: 'forged' } });
  await tick();
  assert.equal(f.received.find(row => row.id === 3).result.isError, true);
  f.send(4, 'browser_read', { tab: 'tfixture' }); await tick(); await tick();
  assert.equal(f.received.find(row => row.id === 4).result.isError, true);
});
test('an unbranded installed control host cannot be registered', () => {
  assert.throws(() => createRelay({ directHost: { bind() {} } }), /TRUSTED_ROUTE_REQUIRED/);
});
