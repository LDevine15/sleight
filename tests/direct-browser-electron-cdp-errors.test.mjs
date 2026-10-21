const MAC_USERS = '/' + 'Users/';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createElectronConnection, createFilterTransport } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';
import { CHANNEL_VERSION, FrameReader, bare, deriveChannel, opener, plainJson, sealer } from '../plugins/sleight/lib/direct-browser/electron-channel.mjs';
import { errorFrame } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { staleDOMReference } from '../plugins/sleight/lib/direct-browser/electron-cdp-errors.mjs';
import { connectWorker, makeHost, pageSession, until } from './direct-browser-electron-host-fixture.mjs';

// An authenticated host channel entirely in memory. One emit is one coalesced socket data chunk.
async function orderedWire(t, { connectionOptions = {}, responseDepth = 0 } = {}) {
  const secret = Buffer.alloc(32, 7), hostNonce = 'n'.repeat(32), instance = 'i'.repeat(32);
  const handle = { host: 'h'.repeat(32), ticket: 't'.repeat(32), secret: secret.toString('base64url'),
    socket: '/tmp/electron-ordering-in-memory', session: 'ordering-test', expiresAt: Date.now() + 60000 };
  const socket = new EventEmitter(), reader = new FrameReader(), requests = [];
  let seal, open;
  socket.destroyed = false;
  socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit('close'); } };
  socket.write = (bytes, callback) => {
    for (const raw of reader.push(bytes)) {
      if (!open) {
        const auth = plainJson(raw);
        const derived = deriveChannel(secret, { host: handle.host, hostNonce, clientNonce: auth.cn, ticket: handle.ticket, role: 'worker' });
        assert.deepEqual(auth, { t: 'auth', ticket: handle.ticket, role: 'worker', cn: auth.cn, proof: derived.clientProof });
        seal = sealer(derived.hostKey); open = opener(derived.clientKey);
        queueMicrotask(() => socket.emit('data', Buffer.concat([bare({ t: 'ready', proof: derived.hostProof }),
          seal({ op: 'open', incarnation: { pid: 4100, birth: 'fixture-birth' }, epoch: 1, instance })])));
      } else requests.push(open(raw));
    }
    callback?.();
    return true;
  };
  const connection = await createElectronConnection({ ...connectionOptions, handle, connect(path) {
    assert.equal(path, handle.socket);
    queueMicrotask(() => socket.emit('data', bare({ t: 'hello', v: CHANNEL_VERSION, host: handle.host, nonce: hostNonce })));
    return socket;
  } });
  await connection.connect();
  const session = responseDepth ? { ...connection.session, async send(...args) {
    const result = await connection.session.send(...args);
    for (let i = 0; i < responseDepth; i++) await Promise.resolve();
    return result;
  } } : connection.session;
  const transport = createFilterTransport({ session });
  t.after(async () => { transport.close(); await connection.disconnect(); });
  return { transport, connection, socket, requests,
    deliver: messages => socket.emit('data', Buffer.concat(messages.map(message => seal(message)))),
    corrupt: () => socket.emit('data', bare({ s: 999, p: '{}', a: 'invalid' })) };
}

for (const delivery of ['coalesced', 'split']) for (const order of [['reply', 'event'], ['event', 'reply']]) {
  test(`${delivery} authenticated ${order.join('-then-')} preserves frame/context initialization order`, async t => {
    const h = await orderedWire(t, { responseDepth: 12 }), received = [];
    let frameInstalled = false, contextAccepted = false, eventSawFrame;
    const complete = new Promise(resolve => {
      h.transport.onmessage = frame => {
        if (frame.id === 1) { received.push('reply'); frameInstalled = true; }
        else {
          assert.equal(frame.method, 'Runtime.executionContextCreated');
          received.push('event'); eventSawFrame = frameInstalled;
          if (frameInstalled) contextAccepted = true;
        }
        if (received.length === 2) resolve();
      };
    });
    h.transport.send({ id: 1, method: 'Page.getFrameTree', params: {}, sessionId: 'owned-page' });
    assert.equal(h.requests.length, 1);
    const request = h.requests[0];
    assert.equal(request.method, 'Page.getFrameTree');
    const messages = {
      reply: { op: 'reply', id: request.id, result: { frameTree: { frame: { id: 'fixture-frame' } } } },
      event: { op: 'event', frame: { method: 'Runtime.executionContextCreated', sessionId: 'owned-page',
        params: { context: { id: 7, auxData: { frameId: 'fixture-frame', isDefault: true } } } } },
    };
    if (delivery === 'coalesced') h.deliver(order.map(kind => messages[kind]));
    else for (const kind of order) h.deliver([messages[kind]]);
    await complete;
    assert.deepEqual({ received, eventSawFrame, contextAccepted }, {
      received: order, eventSawFrame: order[0] === 'reply', contextAccepted: order[0] === 'reply',
    }, 'a reply-following default context must arrive after its frame exists; an earlier event must stay earlier');
  });
}

const contextEvent = (ordinal = 1, padding = '') => ({ op: 'event', frame: { method: 'Runtime.executionContextCreated',
  sessionId: 'owned-page', params: { context: { id: ordinal, padding } } } });
const task = () => new Promise(resolve => setImmediate(resolve));

test('authenticated ingress preserves interleaved records and drains each response microtask chain before the next record', async t => {
  const h = await orderedWire(t, { responseDepth: 20 }), received = [];
  h.transport.onmessage = frame => received.push(frame.id ? 'reply-' + frame.id : 'event-' + frame.params.context.id);
  for (const id of [1, 2, 3]) h.transport.send({ id, method: 'Page.getFrameTree', params: {}, sessionId: 'owned-page' });
  const reply = index => ({ op: 'reply', id: h.requests[index].id, result: {} });
  h.deliver([contextEvent(1), reply(1), contextEvent(2), reply(0), reply(2), contextEvent(3)]);
  assert.deepEqual(received, [], 'normal callbacks must not run inside socket data delivery');
  await until(() => received.length === 6);
  assert.deepEqual(received, ['event-1', 'reply-2', 'event-2', 'reply-1', 'reply-3', 'event-3']);
});

test('authenticated ingress delivers only one ordinary record per task', async t => {
  const h = await orderedWire(t), received = [];
  h.connection.session.on('event', frame => {
    received.push(frame.params.context.id);
    queueMicrotask(() => received.push('microtask-' + frame.params.context.id));
  });
  h.deliver([contextEvent(1), contextEvent(2)]);
  assert.deepEqual(received, []);
  await task();
  assert.deepEqual(received, [1, 'microtask-1']);
  await task();
  assert.deepEqual(received, [1, 'microtask-1', 2, 'microtask-2']);
});

for (const cause of ['parked', 'protocol', 'authentication', 'close']) {
  test(`authenticated ingress ${cause} fences synchronously before queued records drain`, async t => {
    const h = await orderedWire(t), events = [];
    let losses = 0;
    h.connection.onConnectionLoss(() => losses++);
    h.connection.session.on('event', frame => events.push(frame));
    const pending = h.connection.session.send('Page.getFrameTree', {}, 'owned-page').catch(error => error);
    const reply = { op: 'reply', id: h.requests[0].id, result: {} };
    if (cause === 'parked') h.deliver([reply, contextEvent(), { op: 'parked' }, contextEvent(2)]);
    else if (cause === 'protocol') h.deliver([reply, contextEvent(), { op: 'event', frame: { method: 'invalid' } }, contextEvent(2)]);
    else { h.deliver([reply, contextEvent()]); if (cause === 'authentication') h.corrupt(); else h.socket.destroy(); }
    assert.equal(losses, 1, 'loss notification is immediate and exactly once');
    assert.equal(h.socket.destroyed, true);
    assert.match((await pending).message, /CLOSED|PARKED/);
    await assert.rejects(h.connection.session.send('Input.insertText', { text: 'must not send' }, 'owned-page'), /CLOSED/);
    await task(); await task();
    assert.deepEqual(events, [], 'queued and trailing events must be discarded after fencing');
    assert.equal(h.requests.some(request => request.method?.startsWith('Input.')), false);
  });
}

test('authenticated ingress stops remaining listeners and queued records when an event listener fences reentrantly', async t => {
  const h = await orderedWire(t), received = [];
  h.connection.session.on('event', () => { received.push('first'); void h.connection.disconnect(); });
  h.connection.session.on('event', () => received.push('late'));
  h.deliver([contextEvent(1), contextEvent(2)]);
  await task(); await task();
  assert.deepEqual(received, ['first']);
});

test('authenticated ingress rejects a duplicate queued reply before any normal callback', async t => {
  const h = await orderedWire(t), events = [];
  h.connection.session.on('event', frame => events.push(frame));
  const pending = h.connection.session.send('Page.getFrameTree', {}, 'owned-page').catch(error => error);
  const reply = { op: 'reply', id: h.requests[0].id, result: {} };
  h.deliver([contextEvent(), reply, reply]);
  assert.equal(h.socket.destroyed, true);
  assert.match((await pending).message, /CLOSED/);
  await task();
  assert.deepEqual(events, []);
});

for (const bound of ['count', 'bytes']) {
  test(`authenticated ingress ${bound} overflow fences without delivering queued events`, async t => {
    const connectionOptions = bound === 'count' ? { maxPending: 2 } : { maxFrameBytes: 1024 };
    const h = await orderedWire(t, { connectionOptions }), events = [];
    let losses = 0;
    h.connection.onConnectionLoss(() => losses++);
    h.connection.session.on('event', frame => events.push(frame));
    const pending = h.connection.session.send('Page.getFrameTree', {}, 'owned-page').catch(error => error);
    h.deliver(bound === 'count' ? [contextEvent(1), contextEvent(2), contextEvent(3)] : [contextEvent(1, 'x'.repeat(450)), contextEvent(2, 'x'.repeat(450))]);
    assert.equal(losses, 1);
    assert.equal(h.socket.destroyed, true);
    assert.match((await pending).message, /CLOSED/);
    await task(); await task();
    assert.deepEqual(events, []);
  });
}

test('closing the Playwright transport before authenticated ingress drains suppresses late transport callbacks', async t => {
  const h = await orderedWire(t), received = [];
  h.transport.onmessage = frame => received.push(frame);
  h.transport.send({ id: 1, method: 'Page.getFrameTree', params: {}, sessionId: 'owned-page' });
  h.deliver([{ op: 'reply', id: h.requests[0].id, result: {} }, contextEvent()]);
  h.transport.close();
  await task(); await task();
  assert.deepEqual(received, []);
});

test('an expired DOM object keeps its CDP cause through the host and Playwright transport', async t => {
  const h = await makeHost();
  t.after(() => { h.host._crashForTest(); h.state.remove(); });
  await h.host.start({ build: 'fake-build' });
  const { connection } = await connectWorker(h.host);
  const route = await pageSession(connection);
  h.app.hang.add('DOM.describeNode');
  h.app.input.on('data', bytes => {
    for (const raw of bytes.toString().split('\0').filter(Boolean)) {
      const command = JSON.parse(raw);
      if (command.method !== 'DOM.describeNode') continue;
      h.app.emit({ id: command.id, sessionId: command.sessionId,
        error: { code: -32000, message: 'Could not find object with given id' } });
    }
  });
  const transport = createFilterTransport({ session: connection.session });
  t.after(() => transport.close());
  const replies = [];
  transport.onmessage = frame => replies.push(frame);
  transport.send({ id: 1, method: 'DOM.describeNode', params: { objectId: 'expired-utility-object' }, sessionId: route });
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { id: 1, sessionId: route,
    error: { code: -32000, message: 'Could not find object with given id' } });
  assert.equal(h.host.broker.state, 'ready', 'a CDP refusal does not park a healthy app');
  assert.equal(await connection.verifyConnection(connection.session), true);
  assert.equal((await connection.session.send('Runtime.evaluate', {}, route)).ok, true, 'a fresh read remains possible');
  assert.equal(h.app.frames.some(frame => frame.method.startsWith('Input.')), false, 'no retry sends input');
});

test('host CDP errors expose only fixed reasons and numeric protocol codes', () => {
  const cdp = (message, code = -32000) => errorFrame(Object.assign(Error(message), { cdp: true, code }));
  for (const message of ['Could not find object with given id', 'No node with given id found', 'Cannot find context with specified id',
    'Argument should belong to the same JavaScript world as target object']) {
    assert.deepEqual(cdp(message), { code: 'CDP_ERROR', reason: message, protocolCode: -32000, dispatched: true });
  }
  assert.deepEqual(cdp(`secret ${MAC_USERS}fixture/private.html object-123`),
    { code: 'CDP_ERROR', reason: 'CDP_COMMAND_FAILED', protocolCode: -32000, dispatched: true });
  assert.deepEqual(cdp(`Could not find object with given id ${MAC_USERS}fixture/private.html`, 'secret'),
    { code: 'CDP_ERROR', reason: 'CDP_COMMAND_FAILED', dispatched: true });
});

test('detached and layout errors stay generic at both CDP boundaries to avoid Playwright retries', async () => {
  for (const message of ['Node is detached from document', 'Node does not have a layout object']) {
    const error = Object.assign(Error(message), { cdp: true, code: -32000 });
    assert.deepEqual(errorFrame(error), { code: 'CDP_ERROR', reason: 'CDP_COMMAND_FAILED', protocolCode: -32000, dispatched: true });
    const session = { on() {}, off() {}, async send() { throw error; } };
    const transport = createFilterTransport({ session });
    try {
      const reply = new Promise(resolve => { transport.onmessage = resolve; });
      transport.send({ id: 1, method: 'DOM.getContentQuads', params: { objectId: 'expired' }, sessionId: 'owned' });
      assert.deepEqual(await reply, { id: 1, sessionId: 'owned', error: { code: -32000, message: 'CDP_COMMAND_FAILED' } });
    } finally { transport.close(); }
  }
});

test('the Playwright transport never forwards arbitrary error text or invalid codes', async () => {
  const session = { on() {}, off() {}, async send() {
    throw Object.assign(Error(`secret ${MAC_USERS}fixture/private.html`), { cdp: true, code: 'secret' });
  } };
  const transport = createFilterTransport({ session });
  try {
    const reply = new Promise(resolve => { transport.onmessage = resolve; });
    transport.send({ id: 1, method: 'DOM.describeNode', params: { objectId: 'gone' }, sessionId: 'owned' });
    assert.deepEqual(await reply, { id: 1, sessionId: 'owned', error: { code: -32000, message: 'CDP_COMMAND_FAILED' } });
  } finally { transport.close(); }
});

test('numeric CDP errors survive the bridge without exposing an unknown message', async () => {
  const session = { on() {}, off() {}, async send() {
    throw Object.assign(Error(`secret ${MAC_USERS}fixture/private.html`), { cdp: true, code: -32602 });
  } };
  const transport = createFilterTransport({ session });
  try {
    const reply = new Promise(resolve => { transport.onmessage = resolve; });
    transport.send({ id: 1, method: 'DOM.describeNode', params: { objectId: 'gone' }, sessionId: 'owned' });
    assert.deepEqual(await reply, { id: 1, sessionId: 'owned', error: { code: -32602, message: 'CDP_COMMAND_FAILED' } });
  } finally { transport.close(); }
});

test('only a fixed missing DOM reference asks the preflight for a new read', () => {
  assert.equal(staleDOMReference('Protocol error (DOM.describeNode): Could not find object with given id'), true);
  assert.equal(staleDOMReference('Protocol error (DOM.resolveNode): No node with given id found'), true);
  for (const message of ['Protocol error (Runtime.callFunctionOn): Could not find object with given id',
    'Protocol error (DOM.describeNode): CDP_COMMAND_FAILED',
    'Protocol error (DOM.describeNode): Could not find object with given id secret',
    'Protocol error (DOM.describeNode): Argument should belong to the same JavaScript world as target object'])
    assert.equal(staleDOMReference(message), false, message);
});
