// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
// EPV3-7a host additions: one session at a time, the instance mutation fence held in the host,
// prepareProfile between reserve and spawn, admin start/quit/collect, and the package location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PipeTransport } from '../plugins/sleight/lib/direct-browser/electron/broker.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElectronConnection } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';
import { FrameReader, bare, deriveChannel, opener, plainJson, randomToken, sealer } from '../plugins/sleight/lib/direct-browser/electron-channel.mjs';
import { errorFrame } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { hostReason, parkedReceipt } from '../plugins/sleight/lib/direct-browser/electron-host-reasons.mjs';
import { parseHostArguments } from '../plugins/sleight/lib/direct-browser/electron-host-entry.mjs';
import { buildReceipt } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { connectWorker, fakeWorld, makeHost, pageSession, until } from './direct-browser-electron-host-fixture.mjs';
import { writableTreeSkip } from './requirements.mjs';

const checkoutSkip = writableTreeSkip(fileURLToPath(new URL('../plugins/sleight', import.meta.url)));

async function started(options) {
  const h = await makeHost(options);
  await h.host.start({ build: 'fake-build' });
  return h;
}
const finish = h => { h.host._crashForTest(); h.state.remove(); };
const methods = h => h.app.frames.map(frame => frame.method);
const key = { type: 'keyDown', text: 'x' };

test('the channel admits 256 requests and reports its next refusal with a diagnostic and no park', async t => {
  const rows = [], h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  const { connection } = await connectWorker(h.host);
  h.app.hang.add('Browser.getVersion');
  const requests = Array.from({ length: 256 }, () => {
    const pending = connection.session.send('Browser.getVersion'); pending.catch(() => {}); return pending;
  });
  await until(() => h.host.broker.pipe.pending.size === 256);
  await assert.rejects(connection.session.send('Browser.getVersion'), error =>
    error.message === 'CDP_HOST_QUEUE_FULL' && error.dispatched === false);
  assert.deepEqual(rows, [{ method: 'queue', message: 'count bound', code: 'CDP_HOST_QUEUE_FULL', sessionKind: 'host' }]);
  assert.equal(h.host.broker.state, 'ready');
  const frames = h.app.frames.slice(1);
  assert.equal(frames.length, 256);
  assert.deepEqual(frames.map(f => f.id), Array.from({ length: 256 }, (_, i) => frames[0].id + i));
  for (const frame of frames) h.app.emit({ id: frame.id, result: {} });
  await Promise.all(requests);
});

test('park records its fixed host reason without forwarding arbitrary error text', async t => {
  const rows = [];
  const h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  h.host.broker.park('pipe queue full', { resumable: true });
  h.host.broker.park('page supplied private text');
  assert.deepEqual(rows, [
    { method: 'park', message: 'pipe queue full', code: null, sessionKind: 'host' },
    { method: 'park', message: 'host failure', code: null, sessionKind: 'host' },
  ]);
});

test('backpressure sends the next broker request after drain without parking', async t => {
  const rows = [], h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  const { connection } = await connectWorker(h.host), route = await pageSession(connection);
  const write = h.app.input.write.bind(h.app.input);
  let blocked = true;
  h.app.input.write = bytes => { const result = write(bytes); return blocked ? false : result; };
  await connection.session.send('Runtime.evaluate', {}, route);
  const next = connection.session.send('DOM.describeNode', {}, route);
  const settled = next.then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.app.frames.some(frame => frame.method === 'DOM.describeNode'), false);
  blocked = false; h.app.input.emit('drain');
  assert.deepEqual(await settled, { value: { ok: true } });
  assert.equal(h.host.broker.state, 'ready');
  assert.deepEqual(rows, []);
});

test('a never-written request rejects undispatched and leaves the broker ready', async t => {
  const rows = [], h = await started({ hostOptions: { brokerOptions: { transport: { maxPending: 1 }, diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  const { connection } = await connectWorker(h.host), route = await pageSession(connection);
  h.app.hang.add('Runtime.evaluate');
  const first = connection.session.send('Runtime.evaluate', {}, route);
  await until(() => h.app.frames.some(frame => frame.method === 'Runtime.evaluate'));
  await assert.rejects(connection.session.send('DOM.describeNode', {}, route), error =>
    error.message === 'CDP_HOST_QUEUE_FULL' && error.dispatched === false);
  assert.equal(h.host.broker.state, 'ready');
  assert.equal(h.app.frames.some(frame => frame.method === 'DOM.describeNode'), false);
  assert.deepEqual(rows, [{ method: 'queue', message: 'count bound', code: 'CDP_HOST_QUEUE_FULL', sessionKind: 'host' }]);
  const frame = h.app.frames.at(-1);
  h.app.emit({ id: frame.id, sessionId: route, result: {} });
  await first;
});

test('revoke stops queued writes before drain and retains the app pipe', async t => {
  const h = await started();
  t.after(() => finish(h));
  const { connection } = await connectWorker(h.host), route = await pageSession(connection);
  const write = h.app.input.write.bind(h.app.input);
  h.app.input.write = bytes => { write(bytes); return false; };
  await connection.session.send('Runtime.evaluate', {}, route);
  const pending = connection.session.send('DOM.describeNode', {}, route).catch(error => error);
  await until(() => h.host.broker.pipe.pending.size === 1);
  h.host.revokeAll();
  await until(() => h.host.broker.pipe.pending.size === 0);
  h.app.input.emit('drain');
  h.app.input.emit('drain');
  await pending;
  assert.equal(h.app.frames.some(frame => frame.method === 'DOM.describeNode'), false);
  assert.equal(h.app.input.destroyed, false);
  assert.equal(h.host.broker.state, 'parked');
});

test('the pipe accepts 256 pending frames, bounds the bank and drains each queued frame once', async () => {
  const input = new EventEmitter(), output = new EventEmitter(), frames = [];
  let blocked = true;
  input.write = bytes => { frames.push(JSON.parse(bytes.toString().slice(0, -1))); return !blocked; };
  const pipe = new PipeTransport({ input, output });
  assert.equal(pipe.maxPending, 256);
  assert.throws(() => new PipeTransport({ input, output, maxPending: 257 }), /bound/);
  const requests = Array.from({ length: 256 }, () => pipe.request('Browser.getVersion'));
  await assert.rejects(pipe.request('Browser.getVersion'), error => error.dispatched === false && error.message === 'pipe queue full');
  assert.equal(frames.length, 1, 'write(false) accepted only the first frame');
  blocked = false; input.emit('drain');
  assert.equal(frames.length, 256);
  assert.equal(new Set(frames.map(frame => frame.id)).size, 256);
  assert.deepEqual(frames.map(frame => frame.id), Array.from({ length: 256 }, (_, i) => i + 1));
  for (const frame of frames) output.emit('data', Buffer.from(JSON.stringify({ id: frame.id, result: {} }) + '\0'));
  await Promise.all(requests);
  input.emit('drain');
  assert.equal(frames.length, 256, 'a second drain replays nothing');
  assert.equal(pipe.pending.size, 0);
  assert.equal(pipe.writes.size, 0);
});

test('a second write(false) stops a flush until a second drain, without replay', async () => {
  const input = new EventEmitter(), output = new EventEmitter(), ids = [];
  input.write = bytes => { ids.push(JSON.parse(bytes.toString().slice(0, -1)).id); return ids.length !== 1 && ids.length !== 3; };
  const pipe = new PipeTransport({ input, output });
  const requests = Array.from({ length: 6 }, () => pipe.request('Browser.getVersion'));
  assert.deepEqual(ids, [1]);
  input.emit('drain');
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(pipe.blocked, true);
  input.emit('drain');
  input.emit('drain');
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6]);
  for (const id of ids) output.emit('data', Buffer.from(JSON.stringify({ id, result: {} }) + '\0'));
  await Promise.all(requests);
});

test('a synchronous drain during write(false) does not stall later frames', async () => {
  const input = new EventEmitter(), output = new EventEmitter(), ids = [];
  input.write = bytes => {
    const { id } = JSON.parse(bytes.toString().slice(0, -1)); ids.push(id);
    if (id !== 1) input.emit('drain');
    queueMicrotask(() => output.emit('data', Buffer.from(JSON.stringify({ id, result: {} }) + '\0')));
    return false;
  };
  const pipe = new PipeTransport({ input, output });
  const requests = Array.from({ length: 3 }, () => pipe.request('Browser.getVersion'));
  assert.deepEqual(ids, [1]);
  input.emit('drain');
  await Promise.all(requests);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(pipe.blocked, false);
});

test('unwritten frames have an 8 MiB byte bound and cancellation releases their bytes', async () => {
  const input = new EventEmitter(), output = new EventEmitter(), ids = [];
  input.write = bytes => { ids.push(JSON.parse(bytes.toString().slice(0, -1)).id); return false; };
  const pipe = new PipeTransport({ input, output });
  assert.equal(pipe.maxQueuedBytes, 8 * 1024 * 1024);
  const first = pipe.request('Browser.getVersion');
  const controller = new AbortController();
  const requests = Array.from({ length: 8 }, () => pipe.request('Runtime.evaluate', { expression: 'x'.repeat(1024 * 1024 - 128) }, { signal: controller.signal }));
  assert.ok(pipe.queuedBytes <= pipe.maxQueuedBytes);
  await assert.rejects(pipe.request('Runtime.evaluate', { expression: 'x'.repeat(1024) }),
    error => error.message === 'pipe queue full' && error.dispatched === false);
  controller.abort();
  for (const request of requests) await assert.rejects(request, error => error.dispatched === false);
  assert.equal(pipe.queuedBytes, 0);
  assert.deepEqual(ids, [1]);
  output.emit('data', Buffer.from('{"id":1,"result":{}}\0'));
  await first;
  input.emit('drain');
  assert.deepEqual(ids, [1]);
  await assert.rejects(pipe.request('Browser.getVersion', {}, { signal: AbortSignal.abort() }), /cancelled/);
});

test('a reply for a queued id is invalid and fails the pipe without sending that frame', async () => {
  const input = new EventEmitter(), output = new EventEmitter(), ids = [];
  input.write = bytes => { ids.push(JSON.parse(bytes.toString().slice(0, -1)).id); return false; };
  const pipe = new PipeTransport({ input, output });
  const first = pipe.request('Browser.getVersion'), queued = pipe.request('Browser.getVersion');
  output.emit('data', Buffer.from('{"id":2,"result":{}}\0'));
  await assert.rejects(first, /invalid pipe reply/);
  await assert.rejects(queued, error => error.message === 'invalid pipe reply' && error.dispatched === false);
  input.emit('drain');
  assert.deepEqual(ids, [1]);
  assert.equal(pipe.queuedBytes, 0);
});

test('detach cancels only that client queued entries immediately and later drains never replay them', async t => {
  const h = await started();
  t.after(() => finish(h));
  const broker = h.host.broker, a = broker.connect('a'), b = broker.connect('b');
  const write = h.app.input.write.bind(h.app.input);
  let blocked = true;
  h.app.input.write = bytes => { const result = write(bytes); return blocked ? false : result; };
  await broker.transportSend(a, { method: 'Browser.getVersion' });
  const cancelled = broker.transportSend(a, { method: 'Browser.getVersion' });
  const kept = broker.transportSend(b, { method: 'Browser.getVersion' });
  await until(() => broker.pipe.writes.size === 2);
  broker.detach(a);
  assert.equal(broker.pipe.pending.size, 1);
  assert.equal(broker.pipe.writes.size, 1);
  await assert.rejects(cancelled, error => error.dispatched === false && /client detached/.test(error.message));
  assert.equal(broker.state, 'ready');
  blocked = false; h.app.input.emit('drain');
  await kept;
  h.app.input.emit('drain');
  assert.deepEqual(h.app.frames.map(f => f.id), [1, 2, 4]);
  assert.equal(broker.pipe.queuedBytes, 0);
});

test('Input queued behind backpressure rechecks the fence at write time', async t => {
  const h = await started();
  t.after(() => finish(h));
  const { connection } = await connectWorker(h.host), route = await pageSession(connection);
  await connection.fence('acquire');
  const write = h.app.input.write.bind(h.app.input);
  h.app.input.write = bytes => { write(bytes); return false; };
  await connection.session.send('Runtime.evaluate', {}, route);
  const queued = connection.session.send('Input.dispatchKeyEvent', key, route);
  await until(() => h.host.broker.pipe.writes.size === 1);
  await connection.fence('release');
  h.app.input.emit('drain');
  await assert.rejects(queued, error => error.message === 'FENCE_REQUIRED' && error.dispatched === false);
  assert.equal(h.app.frames.some(f => f.method.startsWith('Input.')), false);
  assert.equal(h.host.broker.state, 'ready');
});

test('queued cancellation and timeout are undispatched and never park the broker', async t => {
  const rows = [], h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  const client = h.host.broker.connect('direct');
  h.host.broker.pipe.blocked = true;
  h.host.broker.pipe.timeoutMs = 20;
  const controller = new AbortController();
  const cancelled = h.host.broker.transportSend(client, { method: 'Browser.getVersion' }, { signal: controller.signal });
  await until(() => h.host.broker.pipe.pending.size === 1);
  controller.abort();
  await assert.rejects(cancelled, error => error.dispatched === false && error.message === 'cancelled before dispatch');
  await assert.rejects(h.host.broker.transportSend(client, { method: 'Browser.getVersion' }),
    error => error.dispatched === false && error.message === 'pipe queue timeout');
  assert.equal(h.host.broker.state, 'ready');
  assert.deepEqual(rows, [{ method: 'queue', message: 'queue timeout', code: 'CDP_HOST_QUEUE_FULL', sessionKind: 'host' }]);
  const before = h.app.frames.length;
  h.app.input.emit('drain');
  assert.equal(h.app.frames.length, before);
  assert.equal(h.host.broker.pipe.queuedBytes, 0);
});

test('the pipe byte bound records a fixed queue reason before the host refusal', async t => {
  const rows = [], h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  const { connection } = await connectWorker(h.host), route = await pageSession(connection);
  h.host.broker.pipe.maxQueuedBytes = 64;
  await assert.rejects(connection.session.send('Runtime.evaluate', { expression: 'private text'.repeat(20) }, route),
    error => error.message === 'CDP_HOST_QUEUE_FULL' && error.dispatched === false);
  assert.deepEqual(rows, [{ method: 'queue', message: 'byte bound', code: 'CDP_HOST_QUEUE_FULL', sessionKind: 'host' }]);
  assert.equal(h.host.broker.state, 'ready');
});

test('both authorization queue bounds record a fixed reason without parking', async t => {
  const rows = [], h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  const broker = h.host.broker, client = broker.connect('direct');
  broker.queued = broker.maxTransportQueue;
  await assert.rejects(broker.transportSend(client, { method: 'Browser.getVersion' }), /authorization queue full/);
  broker.preparing = 64;
  broker.authorize = async () => assert.fail('queue full');
  await assert.rejects(broker.dispatch(client, {}), /authorization queue full/);
  assert.deepEqual(rows, Array.from({ length: 2 }, () => ({ method: 'queue', message: 'authorization queue', code: 'CDP_HOST_QUEUE_FULL', sessionKind: 'host' })));
  assert.equal(broker.state, 'ready');
});

test('the broker client count bound records a fixed queue reason', async t => {
  const rows = [], h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  for (let i = 0; i < 64; i++) h.host.broker.connect('direct');
  assert.throws(() => h.host.broker.connect('direct'), /client queue full/);
  assert.deepEqual(rows, [{ method: 'queue', message: 'count bound', code: 'CDP_HOST_QUEUE_FULL', sessionKind: 'host' }]);
  assert.equal(h.host.broker.state, 'ready');
});

for (const throws of [false, true]) test(`a failed Quit result resets the expected-exit tag (throws=${throws})`, async t => {
  const rows = [], h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) },
    requestQuit: async () => { if (throws) throw Error('Quit refused'); } } });
  t.after(() => finish(h));
  assert.equal((await h.host.quit(async () => true)).cleanup, 'retained');
  h.host.broker.child.events.emit('exit', 1);
  assert.equal(rows.at(-1).message, 'child exited');
  assert.equal(rows.at(-1).expected, undefined);
});

test('pipe errno reasons stay fixed and retain their failure class in diagnostics and receipts', async t => {
  for (const reason of ['write EPIPE', 'read ECONNRESET', 'write ENOTCONN', 'read EBADF', 'write ETIMEDOUT']) {
    assert.equal(hostReason(reason + ': private path'), reason);
    assert.deepEqual(parkedReceipt({ reason: reason + ': private path', resumable: false }), { reason, resumable: false });
  }
  assert.equal(hostReason('private page text EPIPE'), 'host failure');
  assert.equal(hostReason('write PRIVATE_ERRNO: private path'), 'host failure');
  const rows = [], h = await started({ hostOptions: { brokerOptions: { diagnostic: row => rows.push(row) } } });
  t.after(() => finish(h));
  const client = h.host.broker.connect('direct');
  h.app.input.write = () => { throw Object.assign(Error('private path'), { code: 'EPIPE' }); };
  await assert.rejects(h.host.broker.transportSend(client, { method: 'Browser.getVersion' }),
    error => error.message === 'write EPIPE' && error.dispatched === true);
  assert.deepEqual(rows, [{ method: 'park', message: 'write EPIPE', code: null, sessionKind: 'host' }]);
});

test('a pipe fault distinguishes written commands from waiting commands', async () => {
  const input = new EventEmitter(), output = new EventEmitter();
  input.write = () => false;
  const pipe = new PipeTransport({ input, output });
  const written = pipe.request('Browser.getVersion'), waiting = pipe.request('Browser.getVersion');
  pipe.fail(Error('pipe EOF'));
  await assert.rejects(written, error => error.dispatched === true);
  await assert.rejects(waiting, error => error.dispatched === false);
  assert.equal(pipe.writes.size, 0);
});

test('a drained command gets its reply timeout from dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new EventEmitter(), output = new EventEmitter();
  input.write = () => true;
  const pipe = new PipeTransport({ input, output, timeoutMs: 20 });
  pipe.blocked = true;
  const pending = pipe.request('Browser.getVersion');
  t.mock.timers.tick(19);
  input.emit('drain');
  t.mock.timers.tick(2);
  output.emit('data', Buffer.from('{"id":1,"result":{}}\0'));
  assert.deepEqual(await pending, {});
});

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
  assert.deepEqual(errorFrame(Error(`${MAC_USERS}someone/secret path`)), { code: 'FAILED', dispatched: false });
  for (const reason of ['pipe queue full', 'authorization queue full', 'pipe queue timeout'])
    assert.deepEqual(errorFrame(Error(reason)), { code: 'CDP_HOST_QUEUE_FULL', dispatched: false });
  for (const reason of ['broker parked', 'broker parked during preparation', 'client detached during preparation'])
    assert.deepEqual(errorFrame(Error(reason)), { code: 'CDP_HOST_PARKED', dispatched: false });
  assert.equal(errorFrame(Object.assign(Error('pipe queue full private page text'), { cdp: true })).code, 'CDP_ERROR');
  assert.equal(errorFrame(Error('pipe queue full private page text')).code, 'QUEUE_FULL');
});

test('the broker, launch adapter, registry and notices are package files the receipt hashes, and the host entry finds them there', { skip: checkoutSkip }, () => {
  const paths = buildReceipt().receipt.files.map(file => file.path);
  for (const name of ['broker.mjs', 'launch.py', 'recipes.json', 'THIRD_PARTY_NOTICES.md']) assert.ok(paths.includes('lib/direct-browser/electron/' + name), name);
  const parsed = parseHostArguments(['--state-dir', '/tmp/s', '--registry', '/tmp/r.json', '--temp-root', '/tmp/t', '--builds', 'a']);
  assert.match(parsed.script, /\/lib\/direct-browser\/electron\/launch\.py$/);
  assert.match(parsed.brokerModule, /\/lib\/direct-browser\/electron\/broker\.mjs$/);
  assert.equal(existsSync(parsed.script) && existsSync(parsed.brokerModule), true);
  assert.equal(existsSync(new URL('../bench/direct-electron', import.meta.url)), false, 'no copy left outside the package');
});
