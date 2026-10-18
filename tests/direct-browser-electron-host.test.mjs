import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createElectronConnection, createFilterTransport } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';
import { FrameReader, bare, deriveChannel, opener, plainJson, randomToken, sealer } from '../plugins/sleight/lib/direct-browser/electron-channel.mjs';
import { loadPlaywrightCore } from '../plugins/sleight/lib/direct-browser/worlds.mjs';
import { connectWorker, fakeApp, makeHost, pageSession, rawSocket, tick, until } from './direct-browser-electron-host-fixture.mjs';

async function started(options) {
  const h = await makeHost(options);
  await h.host.start({ build: 'fake-build' });
  return h;
}
const finish = h => { h.host._crashForTest(); h.state.remove(); };
const methods = h => h.app.frames.map(frame => frame.method);

/** A hand-driven client: speaks the real handshake so a test can alter any step of it. */
async function manualClient(handle, { secret = Buffer.from(handle.secret, 'base64url'), role = 'worker', ticket = handle.ticket } = {}) {
  const socket = net.connect(handle.socket), reader = new FrameReader(1 << 20), inbox = [];
  let closed = false;
  socket.on('error', () => {}); socket.on('close', () => { closed = true; });
  const waiting = [];
  socket.on('data', chunk => { for (const frame of reader.push(chunk)) { inbox.push(frame); waiting.splice(0).forEach(resolve => resolve()); } });
  const next = async () => { while (!inbox.length) { if (closed) return undefined; await new Promise(resolve => { waiting.push(resolve); setTimeout(resolve, 50); }); } return inbox.shift(); };
  const hello = plainJson(await next());
  const clientNonce = randomToken();
  const derived = deriveChannel(secret, { host: hello.host, hostNonce: hello.nonce, clientNonce, ticket, role });
  const auth = bare({ t: 'auth', ticket, role, cn: clientNonce, proof: derived.clientProof });
  return { socket, next, hello, derived, auth, get closed() { return closed; },
    async open() {
      socket.write(auth);
      const ready = plainJson(await next());
      assert.equal(ready.t, 'ready');
      const seal = sealer(derived.clientKey), openFrame = opener(derived.hostKey);
      const read = async () => { const frame = await next(); return frame === undefined ? undefined : openFrame(frame); };
      return { seal, read, write: payload => socket.write(seal(payload)) };
    } };
}

test('a worker can end its turn or be lost and a later worker reconnects to the same app pipe', async () => {
  const h = await started();
  const first = await connectWorker(h.host, 'w1');
  assert.equal((await first.connection.session.send('Browser.getVersion')).pid, 4100);
  await first.connection.disconnect();                      // endTurn
  assert.equal(h.app.input.destroyed, false);
  assert.equal(h.host.broker.state, 'ready');
  const lost = await connectWorker(h.host, 'w2');
  lost.connection.session.send('Browser.getVersion', {}).catch(() => {});
  const raw = (await manualClient(await h.host.issueTicket({ session: 'w3' })));
  raw.socket.destroy();                                       // parent-worker loss: no goodbye
  await tick(20);
  const again = await connectWorker(h.host, 'w4');
  assert.equal(again.connection.identity.pid, 4100);
  assert.equal(h.world.apps.length, 1, 'one app, never relaunched');
  assert.equal(h.adapter.calls.filter(([cmd]) => cmd === 'spawn').length, 1);
  assert.equal(h.app.input.destroyed, false);
  assert.equal(h.host.broker.state, 'ready');
  finish(h);
});

test('worker sessions are detached when its channel ends; another worker keeps its own', async () => {
  const h = await started();
  const a = await connectWorker(h.host, 'a'), b = await connectWorker(h.host, 'b');
  const mine = (await a.connection.session.send('Target.attachToTarget', { targetId: 'T1', flatten: true })).sessionId;
  const theirs = (await b.connection.session.send('Target.attachToTarget', { targetId: 'T2', flatten: true })).sessionId;
  await a.connection.disconnect();
  await until(() => h.app.frames.some(frame => frame.method === 'Target.detachFromTarget'), 'detach');
  assert.equal(h.app.frames.filter(frame => frame.method === 'Target.detachFromTarget')[0].params.sessionId, mine);
  await b.connection.session.send('Runtime.evaluate', {}, theirs);
  await assert.rejects(b.connection.session.send('Target.detachFromTarget', { sessionId: mine }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(b.connection.session.send('Runtime.evaluate', {}, mine), /CDP_SESSION_NOT_OWNED/);
  finish(h);
});

test('forged clients: wrong secret, unknown or spent ticket, wrong role, garbage and impostor hosts all fail without effect', async () => {
  const h = await started();
  const handle = await h.host.issueTicket({ session: 'w1' });
  const wrong = await manualClient(handle, { secret: Buffer.alloc(32, 1) });
  wrong.socket.write(wrong.auth);
  assert.equal(await wrong.next(), undefined); assert.equal(wrong.closed, true);
  const unknown = await manualClient(handle, { ticket: randomToken() });
  unknown.socket.write(unknown.auth); assert.equal(await unknown.next(), undefined);
  const adminOnTicket = await manualClient(handle, { role: 'admin' });
  adminOnTicket.socket.write(adminOnTicket.auth); assert.equal(await adminOnTicket.next(), undefined);
  const garbage = rawSocket(handle.socket);
  garbage.socket.write('not json\0');
  await until(() => garbage.closed, 'garbage closed');
  const good = await manualClient(handle);
  const channel = await good.open();
  assert.equal((await channel.read()).op, 'open');
  const spent = await manualClient(handle);
  spent.socket.write(spent.auth);
  assert.equal(await spent.next(), undefined, 'a one-use ticket opens one channel');
  assert.equal(h.app.frames.length, 1, 'only the host handshake reached the app');
  // A server that has the right host id but not the secret cannot finish the client's handshake.
  const impostor = net.createServer(socket => {
    socket.write(bare({ t: 'hello', v: 1, host: handle.host, nonce: randomToken() }));
    socket.on('data', () => socket.write(bare({ t: 'ready', proof: randomToken(32) })));
    socket.on('error', () => {});
  });
  const impostorPath = join(h.state.dir, 'i.sock');
  await new Promise(resolve => impostor.listen(impostorPath, resolve));
  await assert.rejects(createElectronConnection({ handle: { ...handle, socket: impostorPath } }).then(c => c.connect()), /HOST_MISMATCH/);
  const other = net.createServer(socket => { socket.write(bare({ t: 'hello', v: 1, host: randomToken(16), nonce: randomToken() })); socket.on('error', () => {}); });
  const otherPath = join(h.state.dir, 'o.sock');
  await new Promise(resolve => other.listen(otherPath, resolve));
  await assert.rejects(createElectronConnection({ handle: { ...handle, socket: otherPath } }).then(c => c.connect()), /HOST_MISMATCH/);
  impostor.close(); other.close();
  finish(h);
});

test('handles are exact: extra fields, bad shapes and expired tickets never connect', async () => {
  const h = await started();
  const handle = await h.host.issueTicket({ session: 'w1', ttlMs: 20 });
  for (const bad of [{ ...handle, extra: 1 }, { ...handle, socket: 'relative.sock' }, { ...handle, secret: 'short' }, { ...handle, session: 'a b' }, null, 'x']) {
    await assert.rejects(createElectronConnection({ handle: bad }), /HANDLE_INVALID/);
  }
  await tick(40);
  await assert.rejects(createElectronConnection({ handle }).then(c => c.connect()), /CLOSED|TIMEOUT|closed/);
  await assert.rejects(h.host.issueTicket({ session: 'bad session' }), /SESSION_INVALID/);
  await assert.rejects(h.host.issueTicket({ session: 'ok', ttlMs: 10 ** 9 }), /BOUND/);
  await assert.rejects(h.host.issueTicket({ session: 'ok', maxUses: 99 }), /BOUND/);
  finish(h);
});

test('repeated bad proofs revoke a ticket; a replayed handshake from a recorded connection fails', async () => {
  const h = await started({ hostOptions: {} });
  const handle = await h.host.issueTicket({ session: 'w1', maxUses: 3 });
  for (let i = 0; i < 5; i++) {
    const bad = await manualClient(handle, { secret: Buffer.alloc(32, i + 1) });
    bad.socket.write(bad.auth); await bad.next();
  }
  const afterBurst = await manualClient(handle);
  afterBurst.socket.write(afterBurst.auth);
  assert.equal(await afterBurst.next(), undefined, 'five failures end the ticket');
  const fresh = await h.host.issueTicket({ session: 'w2', maxUses: 3 });
  const recorded = await manualClient(fresh);
  const channel = await recorded.open();
  assert.equal((await channel.read()).op, 'open');
  const replay = rawSocket(fresh.socket);
  await until(() => replay.text().includes('hello'), 'hello');
  replay.socket.write(recorded.auth);                       // the exact bytes that just succeeded
  await until(() => replay.closed, 'replay closed');
  assert.ok(!replay.text().includes('ready'));
  finish(h);
});

test('sealed frames: tampering, a wrong sequence, an unknown op and extra keys drop only that channel', async () => {
  const h = await started();
  const good = await connectWorker(h.host, 'good');
  const cases = [
    channel => { const frame = JSON.parse(channel.seal({ op: 'send', id: 1, method: 'Runtime.evaluate' }).toString().slice(0, -1)); frame.p = frame.p.replace('evaluate', 'evaluatf'); channel.socket.write(JSON.stringify(frame) + '\0'); },
    channel => { channel.seal({ op: 'verify', id: 1 }); channel.write({ op: 'verify', id: 2 }); },        // sequence 2 first
    channel => channel.write({ op: 'detonate', id: 1 }),
    channel => channel.write({ op: 'send', id: 1, method: 'Runtime.evaluate', params: {}, grant: 'x' }),
    channel => channel.write({ op: 'send', id: 0, method: 'Runtime.evaluate' }),
    channel => channel.write({ op: 'send', id: 'one', method: 'Runtime.evaluate' }),
    channel => channel.write('not an object'),
  ];
  for (const attack of cases) {
    const client = await manualClient(await h.host.issueTicket({ session: 'forger' }));
    const channel = await client.open();
    channel.socket = client.socket;
    assert.equal((await channel.read()).op, 'open');
    attack(channel);
    await until(() => client.closed, 'forger dropped');
  }
  assert.equal(h.host.broker.state, 'ready');
  assert.deepEqual(methods(h), ['Browser.getVersion'], 'no forged frame produced a command');
  assert.equal((await good.connection.session.send('Runtime.evaluate', {}, await pageSession(good.connection))).ok, true, 'the honest worker is unaffected');
  finish(h);
});

test('bounds: oversize frames, silent sockets, connection floods and slow readers are cut off', async () => {
  const h = await started({ hostOptions: { maxFrameBytes: 2048, handshakeMs: 60, maxUnauthenticated: 2, maxChannels: 3, maxPendingPerChannel: 2, maxBufferedBytes: 24576 } });
  const big = rawSocket(h.host.socketPath);
  await until(() => big.text().includes('hello'), 'hello');
  big.socket.write(Buffer.alloc(2100, 0x61));                      // no NUL: > the 2 KiB handshake bound before auth
  await until(() => big.closed, 'pre-auth overflow');
  const silent = rawSocket(h.host.socketPath);
  await until(() => silent.closed, 'handshake deadline');
  const holds = [rawSocket(h.host.socketPath), rawSocket(h.host.socketPath)];
  await until(() => holds.every(item => item.text().includes('hello')), 'two unauthenticated');
  const third = rawSocket(h.host.socketPath);
  await until(() => third.closed, 'third unauthenticated refused');
  await until(() => holds.every(item => item.closed), 'holders time out');
  const careful = await createElectronConnection({ handle: await h.host.issueTicket({ session: 'careful' }), maxFrameBytes: 2048 });
  await careful.connect();
  await assert.rejects(careful.session.send('Runtime.evaluate', { text: 'x'.repeat(4000) }), /INVALID_CDP_COMMAND/);
  const oversize = await connectWorker(h.host, 'oversize');
  await assert.rejects(oversize.connection.session.send('Runtime.evaluate', { text: 'x'.repeat(4000) }), /CLOSED/);
  assert.equal(methods(h).includes('Runtime.evaluate'), false, 'the host cut the channel before the frame became a command');
  const worker = await connectWorker(h.host, 'w'), ws = await pageSession(worker.connection);
  h.app.hang.add('Page.captureScreenshot');
  const one = worker.connection.session.send('Page.captureScreenshot', {}, ws), two = worker.connection.session.send('Page.captureScreenshot', {}, ws);
  one.catch(() => {}); two.catch(() => {});
  await tick(20);
  await assert.rejects(worker.connection.session.send('Page.captureScreenshot', {}, ws), /QUEUE_FULL/);
  h.app.hang.clear();
  // A reader that never drains is dropped instead of buffered without bound.
  const slow = await manualClient(await h.host.issueTicket({ session: 'slow' }));
  const channel = await slow.open();
  assert.equal((await channel.read()).op, 'open');
  slow.socket.pause();
  const before = h.host.status().channels;
  // Events arrive over many turns in practice; an honest reader drains between them, the paused one cannot.
  for (let batch = 0; batch < 1500 && h.host.status().channels >= before; batch++) {
    for (let i = 0; i < 3; i++) h.app.emit({ method: 'Runtime.consoleAPICalled', params: { text: 'x'.repeat(4000) } });
    await tick(2);
  }
  await until(() => h.host.status().channels < before, 'slow reader dropped');
  assert.equal(h.host.broker.state, 'ready', JSON.stringify(h.host.status().broker.parked));
  assert.equal(h.host.status().channels, before - 1, 'only the reader that never drained was cut off');
  const after = (await connectWorker(h.host, 'after')).connection;
  assert.equal((await after.session.send('Runtime.evaluate', {}, await pageSession(after))).ok, true);
  void one; void two;
  finish(h);
});

test('no socket: the host listens only on a private Unix path, and Playwright gets a transport object, not a listener', async () => {
  const listens = [];
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) { listens.push(args[0]); return original.apply(this, args); };
  let h;
  try {
    h = await started();
    const { connection } = await connectWorker(h.host);
    const filter = connection.createFilter();
    assert.throws(() => filter.listen(), /NO_LISTENER/);
    let received;
    const stub = { chromium: { connectOverCDP: async (...args) => { received = args; return { stub: true }; } } };
    await filter.connectPlaywright(stub);
    assert.equal(typeof received[0], 'object');
    assert.equal(typeof received[0].send, 'function');
    assert.equal(typeof received[0].close, 'function');
    assert.deepEqual(received[1].noDefaults, true);
    assert.equal(connection.endpoint, undefined, 'no endpoint exists to protect or to leak');
  } finally { net.Server.prototype.listen = original; }
  assert.ok(listens.length >= 1 && listens.every(value => typeof value === 'string' && value.startsWith('/')), JSON.stringify(listens));
  const status = statSync(h.host.socketPath), directory = statSync(h.state.dir);
  assert.equal(status.isSocket(), true);
  assert.equal(status.mode & 0o077, 0);
  assert.equal(directory.mode & 0o077, 0);
  assert.ok(!JSON.stringify(h.app.frames).includes('remote-debugging'));
  finish(h);
});

test('the pinned Playwright 1.64.0 connects in-process through the channel, closing it leaves the app connection ready', async () => {
  const h = await started();
  const { connection } = await connectWorker(h.host);
  const filter = connection.createFilter();
  const playwright = loadPlaywrightCore({ turbo: true }).inprocess.playwright;
  const browser = await filter.connectPlaywright(playwright, { timeout: 5000 });
  assert.equal(browser.version(), '130.0.6723.0');
  const cdp = await browser.newBrowserCDPSession();
  assert.equal((await cdp.send('Browser.getVersion')).pid, 4100);
  await assert.rejects(cdp.send('Browser.close'), /CDP_COMMAND_REFUSED/);
  await assert.rejects(cdp.send('Target.activateTarget', { targetId: 'x' }), /CDP_COMMAND_REFUSED/);
  await assert.rejects(cdp.send('Target.createTarget', { url: 'about:blank', background: true }), /CDP_COMMAND_REFUSED/, 'the app filter never makes windows');
  assert.throws(() => connection.createFilter(['some-target']), /ELECTRON_ADMISSION_REQUIRED/, 'no owned list that skips admission');
  assert.ok(!methods(h).includes('Browser.close'), 'the worker filter refuses it before the host sees it');
  await browser.close();
  assert.equal(h.app.input.destroyed, false);
  assert.equal(h.host.broker.state, 'ready');
  assert.equal(await filter.dispose(), true);
  await connection.disconnect();
  finish(h);
});

test('the filter transport translates between Playwright messages and the filtered session', async () => {
  const sent = [], handlers = new Set();
  const filter = { session: { send: async (method, params, route) => { sent.push([method, params, route]); if (method === 'A.fail') throw Error('boom'); return { method }; },
    on: (_, fn) => handlers.add(fn), off: (_, fn) => handlers.delete(fn) } };
  const transport = createFilterTransport(filter);
  const got = [];
  transport.onmessage = message => got.push(message);
  let closedWith;
  transport.onclose = reason => { closedWith = reason; };
  transport.send({ id: 1, method: 'A.ok', params: { a: 1 }, sessionId: 'S1' });
  transport.send({ id: 2, method: 'A.fail' });
  transport.send({ id: 3, method: 'A.ok' });
  await tick(); await tick();
  [...handlers][0]({ method: 'Page.x', params: {} });
  assert.deepEqual(got.find(m => m.id === 1), { id: 1, result: { method: 'A.ok' }, sessionId: 'S1' });
  assert.deepEqual(got.find(m => m.id === 2), { id: 2, error: { code: -32000, message: 'CDP_COMMAND_FAILED' } });
  assert.deepEqual(got.at(-1), { method: 'Page.x', params: {} });
  transport.close(); transport.close();
  await tick();
  assert.equal(closedWith, 'closed'); assert.equal(handlers.size, 0);
  transport.send({ id: 9, method: 'A.ok' });
  await tick();
  assert.equal(sent.length, 3, 'a closed transport sends nothing');
  const bad = createFilterTransport(filter);
  let badClosed = false; bad.onclose = () => { badClosed = true; };
  bad.send({ id: 'x', method: 'A.ok' }); await tick();
  assert.equal(badClosed, true);
});

test('events reach the owner as v3 session events, frozen and validated', async () => {
  const h = await started();
  const a = await connectWorker(h.host, 'a'), b = await connectWorker(h.host, 'b');
  const mine = (await a.connection.session.send('Target.attachToTarget', { targetId: 'T1', flatten: true })).sessionId;
  const theirs = (await b.connection.session.send('Target.attachToTarget', { targetId: 'T2', flatten: true })).sessionId;
  const seenA = [], seenB = [];
  a.connection.session.on('event', frame => seenA.push(frame));
  b.connection.session.on('event', frame => seenB.push(frame));
  h.app.emit({ method: 'Page.frameNavigated', params: { n: 1 }, sessionId: mine });
  h.app.emit({ method: 'Page.frameNavigated', params: { n: 2 }, sessionId: theirs });
  h.app.emit({ method: 'Target.attachedToTarget', params: { sessionId: theirs, targetInfo: { targetId: 'T2' } } });
  h.app.emit({ method: 'Target.attachedToTarget', params: { sessionId: mine, targetInfo: { targetId: 'T1' } } });
  h.app.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'S999' } });
  h.app.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T3' } } });
  h.app.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'T1' } } });
  h.app.emit({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'T2' } } });
  await until(() => seenA.length >= 3 && seenB.length >= 3, 'events');
  await tick(20);
  assert.deepEqual(seenA.map(frame => frame.method + ':' + (frame.sessionId ?? frame.params.sessionId ?? frame.params.targetInfo?.targetId ?? '')), ['Page.frameNavigated:' + mine, 'Target.attachedToTarget:' + mine, 'Target.targetInfoChanged:T1']);
  assert.deepEqual(seenB.map(frame => frame.method + ':' + (frame.sessionId ?? frame.params.sessionId ?? frame.params.targetInfo?.targetId ?? '')), ['Page.frameNavigated:' + theirs, 'Target.attachedToTarget:' + theirs, 'Target.targetInfoChanged:T2']);
  assert.ok(Object.isFrozen(seenA[0]));
  finish(h);
});

test('revocation parks the app connection, ends every channel, and a command delayed behind it is never written', async () => {
  const h = await started({ hostOptions: { brokerOptions: { identityMaxAgeMs: 0 } } });
  const a = await connectWorker(h.host, 'a'), b = await connectWorker(h.host, 'b');
  let lostA = 0, lostB = 0;
  a.connection.onConnectionLoss(() => lostA++); b.connection.onConnectionLoss(() => lostB++);
  const route = await pageSession(a.connection);
  const original = h.adapter.rpc.bind(h.adapter);
  let release;
  h.adapter.rpc = (cmd, payload) => cmd === 'inspect' ? new Promise(resolve => { release = () => resolve(original(cmd, payload)); }) : original(cmd, payload);
  const delayed = a.connection.session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'x' }, route);
  delayed.catch(() => {});
  await until(() => release, 'delayed identity check');
  h.host.revokeSession('a', 'user revoked');
  release();
  await assert.rejects(delayed, /APP_PARKED|CLOSED|PARKED/);
  await until(() => lostA === 1 && lostB === 1, 'both workers told');
  assert.ok(!methods(h).includes('Input.dispatchKeyEvent'), 'the delayed key press was never sent');
  assert.equal(h.app.input.destroyed, false, 'the writer stays open');
  assert.equal(h.host.status().broker.parked.resumable, true);
  assert.equal(await a.connection.verifyConnection(a.connection.session), false);
  await assert.rejects(createElectronConnection({ handle: await h.host.issueTicket({ session: 'late' }) }).then(c => c.connect()), /PARKED/);
  h.adapter.rpc = original;
  assert.equal((await h.host.resume()).event, 'resumed');
  const back = await connectWorker(h.host, 'back');
  assert.equal((await back.connection.session.send('Runtime.evaluate', {}, await pageSession(back.connection))).ok, true);
  assert.equal(h.world.apps.length, 1);
  finish(h);
});

test('PID reuse parks the connection without sending, and the workers are told', async () => {
  const h = await started();
  const a = await connectWorker(h.host, 'a');
  let lost = 0; a.connection.onConnectionLoss(() => lost++);
  const route = await pageSession(a.connection);
  const original = h.adapter.rpc.bind(h.adapter);
  h.adapter.rpc = async (cmd, payload) => cmd === 'inspect' ? { parent: { pid: 4100, birth: 'someone-else' }, descendants: [], complete: true } : original(cmd, payload);
  await assert.rejects(a.connection.session.send('Runtime.evaluate', {}, route), /APP_PARKED|FAILED|CLOSED|identity/);
  await until(() => lost === 1, 'loss');
  assert.ok(!methods(h).includes('Runtime.evaluate'));
  assert.equal(h.host.status().broker.parked.resumable, false);
  await assert.rejects(h.host.resume(), /not resumable/);
  finish(h);
});

test('verifyConnection proves the exact app instance and epoch, and rejects other candidates', async () => {
  const h = await started();
  const { connection } = await connectWorker(h.host);
  assert.equal(await connection.verifyConnection(connection.session), true);
  assert.equal(await connection.verifyConnection(connection.session, connection.browserIncarnation), true);
  assert.equal(await connection.verifyConnection({ ...connection.session }), false);
  assert.equal(await connection.verifyConnection(connection.session, 'e' + 'f'.repeat(64)), false);
  assert.match(connection.browserIncarnation, /^e[0-9a-f]{64}$/);
  assert.equal(connection.identity.birth, 'birth-1');
  assert.throws(() => { connection.identity.pid = 1; });
  await assert.rejects(connection.session.send('nodots'), /INVALID_CDP_COMMAND/);
  assert.equal(await connection.disconnect({}), false, 'only the connection\'s own session releases it');
  assert.equal(await connection.disconnect(connection.session), true);
  await assert.rejects(connection.session.send('Runtime.evaluate'), /CLOSED/);
  assert.throws(() => connection.createFilter(), /CLOSED/);
  finish(h);
});

test('admin channel: the key is the parent\'s per-start secret, no file in the state directory opens it, and issue asks the parent', async () => {
  const secret = randomBytes(32), asked = [];
  let current = true;
  const h = await started({ hostOptions: { adminSecret: secret, authorizeIssue: async ({ session }) => { asked.push(session); return current; } } });
  assert.equal(existsSync(join(h.state.dir, 'admin.key')), false, 'no admin key is written');
  // Anything running as this user can read the state directory. No file there is an admin credential.
  for (const name of readdirSync(h.state.dir)) {
    const path = join(h.state.dir, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    for (const candidate of [bytes, Buffer.from(bytes.toString().trim(), 'base64url')]) {
      const forged = await manualClient({ socket: h.host.socketPath }, { secret: candidate, role: 'admin', ticket: 'admin' });
      forged.socket.write(forged.auth);
      assert.equal(await forged.next(), undefined, name + ' does not open the admin channel');
    }
  }
  const admin = await manualClient({ socket: h.host.socketPath, ticket: 'admin', secret: 'x' }, { secret, role: 'admin', ticket: 'admin' });
  const channel = await admin.open();
  assert.equal((await channel.read()).admin, true);
  const second = await manualClient({ socket: h.host.socketPath }, { secret, role: 'admin', ticket: 'admin' });
  second.socket.write(second.auth);
  assert.equal(await second.next(), undefined, 'a second administrator is refused');
  channel.write({ op: 'issue', id: 1, args: { session: 'via-admin' } });
  const issued = await channel.read();
  assert.deepEqual(asked, ['via-admin']);
  const connection = await createElectronConnection({ handle: issued.result });
  await connection.connect();
  assert.equal((await connection.session.send('Runtime.evaluate', {}, await pageSession(connection))).ok, true);
  current = false;
  channel.write({ op: 'issue', id: 2, args: { session: 'stale' } });
  assert.equal((await channel.read()).error.code, 'FAILED', 'a grant the parent no longer holds issues nothing');
  await assert.rejects(h.host.issueTicket({ session: 'stale' }), /GRANT_NOT_CURRENT/);
  current = true;
  channel.write({ op: 'status', id: 3 });
  assert.equal((await channel.read()).result.ownership.state, 'owned');
  channel.write({ op: 'issue', id: 4, args: { session: 'bad session' } });
  assert.equal((await channel.read()).error.code, 'FAILED');
  channel.write({ op: 'revoke', id: 5, args: { session: 'via-admin' } });
  await channel.read();
  await until(() => h.host.status().broker.state === 'parked', 'parked');
  channel.write({ op: 'resume', id: 6 });
  assert.equal((await channel.read()).result.event, 'resumed');
  finish(h);
});

test('without the parent\'s secret there is no admin channel, and without its callback no ticket', async () => {
  const h = await started({ hostOptions: { authorizeIssue: undefined } });
  assert.equal(existsSync(join(h.state.dir, 'admin.key')), false);
  const forged = await manualClient({ socket: h.host.socketPath }, { secret: Buffer.alloc(32, 0), role: 'admin', ticket: 'admin' });
  forged.socket.write(forged.auth);
  assert.equal(await forged.next(), undefined);
  await assert.rejects(h.host.issueTicket({ session: 'w1' }), /GRANT_NOT_CURRENT/);
  finish(h);
});

test('a revoked debugger grant revokes its session at the host, and a revoke that lands during resume wins', async () => {
  const h = await started();
  const hooks = [];
  h.host.bindGrant('a', { current: () => true, onRevoke: hook => hooks.push(hook) });
  assert.throws(() => h.host.bindGrant('b', { current: () => true }), /GRANT_INVALID/);
  let lost = 0;
  const a = await connectWorker(h.host, 'a');
  a.connection.onConnectionLoss(() => lost++);
  assert.equal(hooks.length, 1);
  hooks[0]({ reason: 'session-revoked' });
  await until(() => h.host.status().broker.state === 'parked' && lost === 1, 'revoked grant parks');
  await assert.rejects(h.host.issueTicket({ session: 'a' }), /GRANT_NOT_CURRENT/, 'a revoked grant issues no more tickets');
  const original = h.adapter.rpc.bind(h.adapter);
  let release;
  h.adapter.rpc = (cmd, payload) => cmd === 'inspect' ? new Promise(resolve => { release = () => resolve(original(cmd, payload)); }) : original(cmd, payload);
  const resuming = h.host.resume();
  resuming.catch(() => {});
  await until(() => release, 'resume waiting on the identity check');
  h.host.revokeSession('b', 'user revoked');
  release();
  await assert.rejects(resuming, /interrupted/);
  assert.equal(h.host.status().broker.state, 'parked', 'the revoke took effect');
  assert.equal(h.host.status().broker.parked.resumable, true, 'a revoked connection can still be resumed later');
  h.adapter.rpc = original;
  assert.equal((await h.host.resume()).event, 'resumed');
  finish(h);
});

test('synthetic 1/4/13 worker contention: cold start, warm reconnect and command distributions', async t => {
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  for (const count of [1, 4, 13]) {
    const cold = [], warm = [], calls = [];
    for (let run = 0; run < 5; run++) {
      let start = performance.now();
      const h = await started();
      const first = await Promise.all(Array.from({ length: count }, (_, i) => connectWorker(h.host, 's' + i)));
      cold.push(performance.now() - start);
      await Promise.all(first.map(item => item.connection.disconnect()));
      start = performance.now();
      const second = await Promise.all(Array.from({ length: count }, (_, i) => connectWorker(h.host, 'r' + i)));
      warm.push(performance.now() - start);
      start = performance.now();
      const results = await Promise.all(second.map(item => item.connection.session.send('Browser.getVersion', {})));
      calls.push(performance.now() - start);
      assert.ok(results.every(result => result.pid === 4100));
      assert.equal(h.world.apps.length, 1);
      finish(h);
    }
    t.diagnostic(JSON.stringify({ clients: count, trials: 5, unit: 'ms', synthetic: true, fake: true,
      distributions: Object.fromEntries(Object.entries({ cold, warm, calls }).map(([key, values]) => [key, { p50: percentile(values, .5), p90: percentile(values, .9) }])) }));
  }
});
