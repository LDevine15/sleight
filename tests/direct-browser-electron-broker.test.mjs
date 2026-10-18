// EPV3-7a host additions: one session at a time, the instance mutation fence held in the host,
// prepareProfile between reserve and spawn, admin start/quit/collect, and the package location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { createElectronConnection } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';
import { FrameReader, bare, deriveChannel, opener, plainJson, randomToken, sealer } from '../plugins/sleight/lib/direct-browser/electron-channel.mjs';
import { errorFrame } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { parseHostArguments } from '../plugins/sleight/lib/direct-browser/electron-host-entry.mjs';
import { buildReceipt } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { connectWorker, fakeWorld, makeHost, pageSession, until } from './direct-browser-electron-host-fixture.mjs';

async function started(options) {
  const h = await makeHost(options);
  await h.host.start({ build: 'fake-build' });
  return h;
}
const finish = h => { h.host._crashForTest(); h.state.remove(); };
const methods = h => h.app.frames.map(frame => frame.method);
const key = { type: 'keyDown', text: 'x' };

test('one session at a time: another session gets ELECTRON_BUSY while a worker channel is open, the same session does not', async () => {
  const h = await started();
  const a = await connectWorker(h.host, 'a');
  await assert.rejects(h.host.issueTicket({ session: 'b' }), /^Error: ELECTRON_BUSY$/);
  const again = await connectWorker(h.host, 'a');           // a second channel of the same session
  assert.equal((await again.connection.session.send('Browser.getVersion')).pid, 4100);
  await again.connection.disconnect();
  await a.connection.disconnect();
  await until(() => h.host.status().channels === 0, 'channels closed');
  const b = await connectWorker(h.host, 'b');
  assert.equal((await b.connection.session.send('Browser.getVersion')).pid, 4100);
  // A ticket issued before another session connected cannot open beside it.
  const early = await h.host.issueTicket({ session: 'b' });
  await b.connection.disconnect();
  await until(() => h.host.status().channels === 0, 'b closed');
  const late = await h.host.issueTicket({ session: 'c' });
  const c = await createElectronConnection({ handle: late });
  await c.connect();
  await assert.rejects(createElectronConnection({ handle: early }).then(item => item.connect()), /ELECTRON_BUSY/);
  assert.equal(h.host.broker.state, 'ready', 'a busy refusal parks nothing');
  await c.disconnect();
  finish(h);
});

test('Input.* without the fence is refused FENCE_REQUIRED, undispatched, and never reaches the app', async () => {
  const h = await started();
  const { connection } = await connectWorker(h.host, 'a');
  const route = await pageSession(connection);
  const refused = await connection.session.send('Input.dispatchKeyEvent', key, route).then(() => undefined, error => error);
  assert.equal(refused.message, 'FENCE_REQUIRED');
  assert.equal(refused.dispatched, false);
  assert.ok(!methods(h).includes('Input.dispatchKeyEvent'));
  assert.equal((await connection.session.send('Runtime.evaluate', {}, route)).ok, true, 'reads need no fence');
  assert.deepEqual(await connection.fence('acquire'), { held: true, holder: 'a', leaseMs: 30000 });
  assert.equal((await connection.session.send('Input.dispatchKeyEvent', key, route)).ok, true);
  assert.equal(methods(h).filter(name => name === 'Input.dispatchKeyEvent').length, 1);
  assert.deepEqual(await connection.fence('release'), { held: false, holder: null, leaseMs: 30000 });
  await assert.rejects(connection.session.send('Input.dispatchKeyEvent', key, route), /FENCE_REQUIRED/);
  assert.equal(h.host.broker.state, 'ready', 'a fence refusal does not park');
  finish(h);
});

test('the fence has one holder channel; release or a dropped channel frees it', async () => {
  const h = await started();
  const one = (await connectWorker(h.host, 's')).connection, two = (await connectWorker(h.host, 's')).connection;
  const route = await pageSession(two);
  assert.equal((await one.fence('acquire')).held, true);
  assert.deepEqual(await two.fence('acquire'), { held: false, holder: 's', leaseMs: 30000 });
  await assert.rejects(two.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, route), /FENCE_REQUIRED/);
  assert.deepEqual(await two.fence('release'), { held: false, holder: 's', leaseMs: 30000 }, 'only the holder releases');
  await one.disconnect();
  await until(() => h.host.status().channels === 1, 'holder dropped');
  assert.equal((await two.fence('acquire')).held, true, 'a dropped holder leaves the fence free');
  assert.equal((await two.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, route)).ok, true);
  finish(h);
});

test('the fence lapses 30 s after the holder\'s last send or verify, and each one renews it', async () => {
  let clock = 1000;
  const h = await started({ hostOptions: { now: () => clock } });
  const one = (await connectWorker(h.host, 's')).connection, two = (await connectWorker(h.host, 's')).connection;
  const route = await pageSession(one);
  assert.equal((await one.fence('acquire')).held, true);
  clock += 29000;
  assert.equal(await one.verifyConnection(one.session), true);   // renews
  clock += 29000;
  assert.equal((await one.session.send('Input.dispatchKeyEvent', key, route)).ok, true, 'still held 58 s after acquire');
  clock += 29999;
  assert.equal((await two.fence('acquire')).held, false);
  clock += 1;
  assert.deepEqual(await two.fence('acquire'), { held: true, holder: 's', leaseMs: 30000 }, 'lapsed at 30 s');
  await assert.rejects(one.session.send('Input.dispatchKeyEvent', key, route), /FENCE_REQUIRED/);
  finish(h);
});

test('a malformed fence frame drops the channel; the client refuses a bad action before sending', async () => {
  const h = await started();
  const { connection } = await connectWorker(h.host, 's');
  await assert.rejects(connection.fence('steal'), /INVALID_FENCE/);
  assert.equal(await connection.verifyConnection(connection.session), true, 'nothing was sent');
  for (const frame of [{ op: 'fence', id: 1, action: 'steal' }, { op: 'fence', id: 1, action: 'acquire', session: 'other' }, { op: 'fence', action: 'acquire' }]) {
    const raw = await sealedClient(await h.host.issueTicket({ session: 's' }));
    raw.write(frame);
    await until(() => raw.closed, 'forged fence frame dropped');
  }
  assert.deepEqual(await connection.fence('acquire'), { held: true, holder: 's', leaseMs: 30000 }, 'no forged frame took the fence');
  finish(h);
});

/** The real handshake by hand, so a test can send a frame the client library would refuse. */
async function sealedClient(handle) {
  const socket = net.connect(handle.socket), reader = new FrameReader(1 << 20), inbox = [];
  let closed = false;
  socket.on('error', () => {}); socket.on('close', () => { closed = true; });
  socket.on('data', chunk => { for (const frame of reader.push(chunk)) inbox.push(frame); });
  const next = async () => { await until(() => inbox.length || closed, 'frame'); return inbox.shift(); };
  const hello = plainJson(await next()), cn = randomToken();
  const derived = deriveChannel(Buffer.from(handle.secret, 'base64url'), { host: hello.host, hostNonce: hello.nonce, clientNonce: cn, ticket: handle.ticket, role: 'worker' });
  socket.write(bare({ t: 'auth', ticket: handle.ticket, role: 'worker', cn, proof: derived.clientProof }));
  assert.equal(plainJson(await next()).t, 'ready');
  const seal = sealer(derived.clientKey), open = opener(derived.hostKey);
  assert.equal(open(await next()).op, 'open');
  return { write: payload => socket.write(seal(payload)), get closed() { return closed; } };
}

test('prepareProfile runs after reserve and before spawn with the reserved root and the spec', async () => {
  const seen = [], world = fakeWorld();
  const h = await started({ world, hostOptions: { prepareProfile: async (root, spec) => { seen.push([root, spec, world.lock?.phase, world.apps.length]); } } });
  assert.deepEqual(seen, [['/tmp/sleight-ep2-fake1', { build: 'fake-build' }, 'reserved', 0]], 'reserved, not yet spawned');
  assert.equal(world.apps.length, 1);
  finish(h);
  await assert.rejects(makeHost({ hostOptions: { prepareProfile: 'x' } }), /HOST_DEPENDENCIES_REQUIRED/);
});

test('a failing prepareProfile spawns nothing and leaves ownership unresolved until reconciled', async () => {
  const h = await makeHost({ hostOptions: { prepareProfile: async () => { throw Error('copy failed'); } } });
  await assert.rejects(h.host.start({ build: 'fake-build' }), /copy failed/);
  assert.equal(h.adapter.calls.some(([cmd]) => cmd === 'spawn'), false);
  assert.equal(h.host.status().ownership.state, 'unresolved');
  await assert.rejects(h.host.start({ build: 'fake-build' }), /ownership unresolved/);
  assert.equal((await h.host.reconcile()).resolved, true);
  assert.equal(h.host.status().ownership.state, 'free');
  h.host._crashForTest(); h.state.remove();
});

test('quit rechecks the app birth right before the parent\'s requestQuit, and a changed birth quits nothing', async () => {
  const quits = [];
  const h = await started({ hostOptions: { requestQuit: async identity => { quits.push(identity); } } });
  const original = h.adapter.rpc.bind(h.adapter);
  let inspections = 0;
  h.adapter.rpc = async (cmd, payload) => {
    if (cmd !== 'inspect') return original(cmd, payload);
    inspections++;
    return inspections === 1 ? original(cmd, payload) : { parent: { pid: 4100, birth: 'recycled' }, descendants: [], complete: true };
  };
  const receipt = await h.host.quit(async () => true);
  assert.equal(receipt.cleanup, 'retained');
  assert.match(receipt.reason, /QUIT_IDENTITY_CHANGED/);
  assert.deepEqual(quits, [], 'no quit request for a process that is not the launched app');
  finish(h);
});

test('quit asks the parent with the exact pid and birth, then collects', async () => {
  const quits = [];
  const h = await started({ hostOptions: { requestQuit: async identity => { quits.push(identity); h.world.alive = false; h.app.output.end(); } } });
  const receipt = await h.host.quit(async () => true);
  assert.equal(receipt.cleanup, 'removed', JSON.stringify(receipt));
  assert.deepEqual(quits, [{ pid: 4100, birth: 'birth-1' }]);
  assert.equal(h.host.status().ownership.state, 'free');
  finish(h);
});

test('worker-visible error codes are a closed set that now names busy, fence and ownership', () => {
  for (const code of ['ELECTRON_BUSY', 'FENCE_REQUIRED', 'GRANT_NOT_CURRENT', 'BUILD_NOT_REGISTERED', 'SESSION_INVALID'])
    assert.deepEqual(errorFrame(Error(code)), { code, dispatched: false });
  assert.deepEqual(errorFrame(Error('ownership unresolved: host-crash-possible-app-exit')), { code: 'OWNERSHIP_UNRESOLVED', dispatched: false });
  assert.deepEqual(errorFrame(Error('retained ownership prevents another launch')), { code: 'OWNERSHIP_RETAINED', dispatched: false });
  assert.deepEqual(errorFrame(Error('/Users/someone/secret path')), { code: 'FAILED', dispatched: false });
});

test('the broker, launch adapter, registry and notices are package files the receipt hashes, and the host entry finds them there', () => {
  const paths = buildReceipt().receipt.files.map(file => file.path);
  for (const name of ['broker.mjs', 'launch.py', 'recipes.json', 'THIRD_PARTY_NOTICES.md']) assert.ok(paths.includes('lib/direct-browser/electron/' + name), name);
  const parsed = parseHostArguments(['--state-dir', '/tmp/s', '--registry', '/tmp/r.json', '--temp-root', '/tmp/t', '--builds', 'a']);
  assert.match(parsed.script, /\/lib\/direct-browser\/electron\/launch\.py$/);
  assert.match(parsed.brokerModule, /\/lib\/direct-browser\/electron\/broker\.mjs$/);
  assert.equal(existsSync(parsed.script) && existsSync(parsed.brokerModule), true);
  assert.equal(existsSync(new URL('../bench/direct-electron', import.meta.url)), false, 'no copy left outside the package');
});

