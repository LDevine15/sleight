// Wire order through the app pipe: a reply and the events after it must reach the consumer in the order
// the app wrote them, even when they share one pipe chunk. Playwright installs its Runtime listeners in
// Page.getFrameTree's .then, so an event that overtakes the reply before it is lost (missing MAIN context).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { ElectronBroker, PipeTransport } from '../plugins/sleight/lib/direct-browser/electron/broker.mjs';
import { connectWorker, makeHost, pageSession, until } from './direct-browser-electron-host-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };
const record = body => JSON.stringify(body) + '\0';

// A fake app on in-memory pipes. Methods in `manual` wait for the test to answer them.
function harness({ manual = [], brokerOptions = {} } = {}) {
  const input = new PassThrough(), output = new PassThrough(), frames = [], held = new Set(manual);
  let sessions = 0;
  input.on('data', data => {
    for (const raw of data.toString().split('\0').filter(Boolean)) {
      const request = JSON.parse(raw);
      frames.push(request);
      if (held.has(request.method)) continue;
      const route = request.sessionId ? { sessionId: request.sessionId } : {};
      const send = result => queueMicrotask(() => output.write(record({ id: request.id, result, ...route })));
      if (request.method === 'Target.attachToTarget') send({ sessionId: 'S' + (++sessions) });
      else if (request.method === 'Target.getTargetInfo') send({ targetInfo: { targetId: request.params.targetId, type: 'page', url: 'app://main/' } });
      else send({ ok: true });
    }
  });
  const owned = { pid: 100, birth: 'one' };
  const child = { identity: owned, input, output, events: new EventEmitter(),
    inspect: async () => ({ parent: owned, descendants: [], complete: true }), requestQuit: async () => {} };
  const broker = new ElectronBroker({
    ownership: { reserve: async () => ({}), record: async () => {}, remove: async () => {} },
    launch: async () => child, authorizeLaunch: async () => true, admitTarget: async info => info.type === 'page', ...brokerOptions,
  });
  const last = method => frames.findLast(frame => frame.method === method);
  const reply = (request, result = {}) => ({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
  return { broker, input, output, frames, held, last, reply, chunk: (...bodies) => output.write(bodies.map(record).join('')) };
}

// The resident host's forwarding, as electron-host.mjs does it: broker events go out synchronously,
// a command's reply goes out in transportSend(...).then. `sent` is the order the worker would read.
function host(h, client, { depth = 0 } = {}) {
  const sent = [];
  h.broker.on('routed', (owner, frame) => {
    if (owner === undefined || owner === client) sent.push('event ' + frame.method + (frame.params.tag ? ' ' + frame.params.tag : ''));
  });
  const send = (method, params = {}, sessionId, beforeWrite) => {
    let pending = h.broker.transportSend(client, { method, params, sessionId }, { beforeWrite });
    for (let i = 0; i < depth; i++) pending = pending.then(value => value);
    return pending.then(result => { sent.push('reply ' + method); return result; },
      error => { sent.push('error ' + method + ' ' + error.message); throw error; });
  };
  return { sent, send };
}

async function ready(options) {
  const h = harness(options);
  await h.broker.start({});
  const client = h.broker.connect('order-test');
  return { ...h, client };
}

// A page session S1 owned by the client, then one command held for the test to answer.
async function heldCommand(options = {}, method = 'Page.getFrameTree') {
  const h = await ready({ ...options, manual: [method, ...(options.manual ?? [])] });
  const consumer = host(h, h.client, options);
  const page = (await consumer.send('Target.attachToTarget', { targetId: 'T1', flatten: true })).sessionId;
  consumer.sent.length = 0;
  const pending = consumer.send(method, {}, page);
  pending.catch(() => {});
  await until(() => h.last(method), method + ' written');
  return { ...h, consumer, page, pending, request: h.last(method) };
}
const contextCreated = (sessionId, tag) => ({ sessionId, method: 'Runtime.executionContextCreated',
  params: { tag, context: { id: 1, origin: 'app://main', name: '', auxData: { isDefault: true, type: 'default', frameId: 'F' } } } });

test('a reply and the event after it in ONE chunk reach the consumer reply first', async () => {
  const h = await heldCommand();
  h.chunk(h.reply(h.request, { frameTree: {} }), contextCreated(h.page, 'main'));
  await h.pending; await settle();
  assert.deepEqual(h.consumer.sent, ['reply Page.getFrameTree', 'event Runtime.executionContextCreated main']);
});

test('the same records split over two chunks written in one tick keep reply-then-event order', async () => {
  const h = await heldCommand();
  h.chunk(h.reply(h.request, { frameTree: {} }));
  h.chunk(contextCreated(h.page, 'main'));
  await h.pending; await settle();
  assert.deepEqual(h.consumer.sent, ['reply Page.getFrameTree', 'event Runtime.executionContextCreated main']);
});

test('an event written before the reply stays before it', async () => {
  const h = await heldCommand();
  h.chunk(contextCreated(h.page, 'early'), h.reply(h.request, { frameTree: {} }));
  await h.pending; await settle();
  assert.deepEqual(h.consumer.sent, ['event Runtime.executionContextCreated early', 'reply Page.getFrameTree']);
});

test('a reply followed by several events keeps every event after it, in wire order', async () => {
  const h = await heldCommand();
  h.chunk(contextCreated(h.page, 'a'), h.reply(h.request, { frameTree: {} }), contextCreated(h.page, 'b'), contextCreated(h.page, 'c'), contextCreated(h.page, 'd'));
  await h.pending; await settle();
  assert.deepEqual(h.consumer.sent, ['event Runtime.executionContextCreated a', 'reply Page.getFrameTree',
    'event Runtime.executionContextCreated b', 'event Runtime.executionContextCreated c', 'event Runtime.executionContextCreated d']);
});

test('two replies then an event in one chunk arrive reply, reply, event', async () => {
  const h = await heldCommand({ manual: ['Runtime.enable'] });
  const second = h.consumer.send('Runtime.enable', {}, h.page);
  await until(() => h.last('Runtime.enable'), 'Runtime.enable written');
  h.chunk(h.reply(h.request, { frameTree: {} }), h.reply(h.last('Runtime.enable')), contextCreated(h.page, 'main'));
  await Promise.all([h.pending, second]); await settle();
  assert.deepEqual(h.consumer.sent, ['reply Page.getFrameTree', 'reply Runtime.enable', 'event Runtime.executionContextCreated main']);
});

test('a deep promise chain on the reply path still finishes before the next wire record', async () => {
  const h = await heldCommand({ depth: 500 });
  h.chunk(h.reply(h.request, { frameTree: {} }), contextCreated(h.page, 'main'));
  await h.pending; await settle();
  assert.deepEqual(h.consumer.sent, ['reply Page.getFrameTree', 'event Runtime.executionContextCreated main']);
});

test('an attach reply followed by its child attachedToTarget publishes the route before the child event', async () => {
  const h = await ready({ manual: ['Target.attachToTarget'] });
  const consumer = host(h, h.client);
  const attached = consumer.send('Target.attachToTarget', { targetId: 'T1', flatten: true });
  await until(() => h.last('Target.attachToTarget'), 'attach written');
  h.chunk(h.reply(h.last('Target.attachToTarget'), { sessionId: 'S9' }), { sessionId: 'S9', method: 'Target.attachedToTarget',
    params: { sessionId: 'C1', targetInfo: { targetId: 'F1', type: 'iframe', url: 'app://main/frame' }, waitingForDebugger: false } });
  assert.equal((await attached).sessionId, 'S9');
  await settle();
  assert.deepEqual(consumer.sent, ['reply Target.attachToTarget', 'event Target.attachedToTarget']);
  assert.equal(h.broker.routes.get('C1')?.parentSession, 'S9', 'the child route hangs off the attach the reply published');
});

test('an Input command issued while a detach waits in the inbound queue is refused before any write', async () => {
  const h = await heldCommand();
  let input;
  // The reply's own continuation issues input on the page route; the detach that follows it on the wire must win.
  const chained = h.pending.then(() => { input = h.consumer.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, h.page); return input.catch(error => error); });
  h.chunk(h.reply(h.request, { frameTree: {} }), { method: 'Target.detachedFromTarget', params: { sessionId: h.page, targetId: 'T1' } });
  const error = await chained;
  assert.equal(error.message, 'CDP_SESSION_NOT_OWNED');
  assert.equal(error.dispatched, false);
  assert.equal(h.frames.some(frame => frame.method === 'Input.dispatchMouseEvent'), false, 'no input reached the app');
  assert.equal(h.broker.routes.has(h.page), false);
});

test('a request made while inbound records are queued is written only after they are dispatched', async () => {
  const h = await heldCommand();
  const seen = [];
  h.broker.on('routed', (owner, frame) => seen.push(frame.method));
  h.chunk(h.reply(h.request, { frameTree: {} }), contextCreated(h.page, 'main'));
  const count = h.frames.length;
  const later = h.broker.pipe.request('Runtime.evaluate', { expression: '1' }, { sessionId: h.page });
  assert.equal(h.frames.length, count, 'held while an event waits behind the reply');
  assert.equal(h.broker.pipe.writes.size, 1);
  await later;
  assert.deepEqual(seen, ['Runtime.executionContextCreated']);
});

test('a failed attach can still collect its session when the cleanup reply comes in a later chunk', async () => {
  const h = await ready({ manual: ['Target.attachToTarget', 'Target.detachFromTarget'] });
  const consumer = host(h, h.client);
  const attached = consumer.send('Target.attachToTarget', { targetId: 'T1', flatten: true });
  attached.catch(() => {});
  await until(() => h.last('Target.attachToTarget'), 'attach written');
  h.broker.detach(h.client); // the worker went away while its attach was in flight
  let logged = false, loggedBeforeCleanupWrite;
  h.broker.on('routed', (_owner, frame) => { if (frame.method === 'Log.entryAdded') logged = true; });
  h.input.on('data', data => { if (String(data).includes('Target.detachFromTarget')) loggedBeforeCleanupWrite ??= logged; });
  // The attach reply and an event behind it: the cleanup request is issued while that event still waits.
  h.chunk(h.reply(h.last('Target.attachToTarget'), { sessionId: 'S7' }), { method: 'Log.entryAdded', params: { entry: {} } });
  await until(() => h.last('Target.detachFromTarget'), 'cleanup detach written', 1000);
  assert.deepEqual(h.last('Target.detachFromTarget').params, { sessionId: 'S7' });
  assert.equal(loggedBeforeCleanupWrite, true, 'the cleanup write waited for the event ahead of it, then went out');
  h.chunk(h.reply(h.last('Target.detachFromTarget')));
  await assert.rejects(attached, /client detached during preparation/);
  assert.equal(h.broker.state, 'ready', 'cleanup was confirmed, nothing parked');
  assert.equal(h.broker.attachments.has('S7'), false);
});

test('a fault clears queued records at once: no queued event or reply is delivered afterwards', async () => {
  const input = new PassThrough(), output = new PassThrough(), events = [], faults = [];
  const pipe = new PipeTransport({ input, output });
  pipe.on('event', frame => events.push(frame.params.tag));
  pipe.on('fault', error => faults.push(error.message));
  const first = pipe.request('Page.one'), second = pipe.request('Page.two');
  const outcomes = [];
  first.then(() => outcomes.push('first ok'), error => outcomes.push('first ' + error.message));
  second.then(() => outcomes.push('second ok'), error => outcomes.push('second ' + error.message));
  output.write(record({ id: 1, result: {} }) + record({ method: 'Page.ev', params: { tag: 'queued' } }) + record({ id: 2, result: {} }));
  output.emit('error', new Error('pipe broke'));
  assert.deepEqual(faults, ['pipe broke'], 'the fault is synchronous');
  assert.equal(pipe.inbound.length, 0);
  await settle();
  assert.deepEqual(events, []);
  assert.deepEqual(outcomes, ['first ok', 'second pipe broke'], 'the queued reply never succeeds after the fault');
});

test('EOF behind a queued reply fails that request instead of resolving it late', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const pipe = new PipeTransport({ input, output });
  pipe.on('fault', () => {});
  const first = pipe.request('Page.one'), second = pipe.request('Page.two');
  output.write(record({ id: 1, result: {} }) + record({ id: 2, result: {} }));
  pipe.fail(new Error('pipe EOF'));
  assert.deepEqual(await first, {});
  await assert.rejects(second, /pipe EOF/);
});

test('a burst of 4200 events behind a reply pauses the output, then delivers every event in order without a fault', async () => {
  const input = new PassThrough(), output = new PassThrough(), events = [], faults = [], flow = [];
  const pipe = new PipeTransport({ input, output }); // on('data') resumes the stream once; record only what follows
  const pause = output.pause.bind(output), resume = output.resume.bind(output);
  output.pause = () => { flow.push('pause'); return pause(); };
  output.resume = () => { flow.push('resume'); return resume(); };
  pipe.on('event', frame => events.push(frame.params.i));
  pipe.on('fault', error => faults.push(error.message));
  const answered = pipe.request('Page.getFrameTree');
  const wire = Buffer.from(record({ id: 1, result: {} }) + Array.from({ length: 4200 }, (_, i) => record({ method: 'Runtime.consoleAPICalled', params: { i } })).join(''));
  for (let at = 0; at < wire.length; at += 65536) output.write(wire.subarray(at, at + 65536)); // one tick, 64 KB chunks
  assert.deepEqual(flow, ['pause'], 'the FIFO passed high water inside the burst');
  await answered;
  for (let i = 0; i < 50 && events.length < 4200; i++) await tick();
  assert.deepEqual(faults, []);
  assert.equal(events.length, 4200);
  assert.deepEqual(events, Array.from({ length: 4200 }, (_, i) => i));
  assert.deepEqual(flow, ['pause', 'resume']);
  assert.equal(output.isPaused(), false);
  assert.equal(pipe.inbound.length + pipe.chunks.length, 0);
});

test('an output that ignores pause hits the hard inbound bound and fails the transport', async () => {
  const input = new PassThrough(), output = new EventEmitter(), faults = [];
  const pipe = new PipeTransport({ input, output, inboundHighWater: 2, maxInboundBytes: 400 });
  pipe.on('fault', error => faults.push(error.message));
  const waiting = pipe.request('Page.one'), other = pipe.request('Page.two');
  output.emit('data', Buffer.from(record({ id: 1, result: {} })));
  for (let i = 0; i < 20 && !faults.length; i++) output.emit('data', Buffer.from(record({ method: 'Page.ev', params: { i } })));
  assert.deepEqual(faults, ['inbound queue full']);
  assert.deepEqual(await waiting, {});
  await assert.rejects(other, /inbound queue full/);
  assert.throws(() => new PipeTransport({ input, output, inboundHighWater: 0 }), /invalid pipe bound/);
});

test('a request a listener makes while the rest of its chunk is unparsed waits until that rest is dispatched', async () => {
  const input = new PassThrough(), output = new PassThrough(), order = [];
  const pipe = new PipeTransport({ input, output });
  input.on('data', data => order.push('write ' + JSON.parse(String(data).split('\0')[0]).method));
  pipe.on('event', frame => {
    order.push('event ' + frame.params.tag);
    if (frame.params.tag === 'a') pipe.request('Input.dispatchKeyEvent', { type: 'keyDown' }).catch(() => {});
  });
  output.write(record({ method: 'Page.ev', params: { tag: 'a' } }) + record({ method: 'Target.detachedFromTarget', params: { tag: 'b' } }) +
    record({ method: 'Page.ev', params: { tag: 'c' } }));
  assert.deepEqual(order, ['event a', 'event b', 'event c', 'write Input.dispatchKeyEvent']);
  pipe.fail(new Error('done'));
});

test('a nested receive from a listener keeps wire order: the outer chunk finishes first', async () => {
  // A PassThrough holds a write made inside its own 'data' handler until the handler returns, so it never nests.
  // This output emits synchronously, as a stream may, so the inner chunk arrives while b is still unparsed.
  const input = new PassThrough(), output = new EventEmitter(), order = [];
  const pipe = new PipeTransport({ input, output });
  pipe.on('event', frame => {
    order.push(frame.params.tag);
    if (frame.params.tag === 'a') output.emit('data', Buffer.from(record({ method: 'Page.ev', params: { tag: 'c' } })));
  });
  output.emit('data', Buffer.from(record({ method: 'Page.ev', params: { tag: 'a' } }) + record({ method: 'Page.ev', params: { tag: 'b' } })));
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('through the real host and worker connection, a coalesced reply+event reaches Playwright reply first', async t => {
  const h = await makeHost();
  await h.host.start({ build: 'fake-build' });
  const { connection } = await connectWorker(h.host);
  t.after(async () => {
    await connection.disconnect();
    await until(() => h.host.broker.attachments.size === 0, 'worker session collected');
    h.host._crashForTest(); h.state.remove();
  });
  const page = await pageSession(connection);
  const seen = [];
  connection.session.on('event', frame => seen.push('event ' + frame.method));
  h.app.hang.add('Page.getFrameTree');
  const tree = connection.session.send('Page.getFrameTree', {}, page).then(() => seen.push('reply Page.getFrameTree'));
  await until(() => h.app.frames.some(frame => frame.method === 'Page.getFrameTree'), 'getFrameTree written');
  const request = h.app.frames.findLast(frame => frame.method === 'Page.getFrameTree');
  h.app.output.write(record({ id: request.id, result: { frameTree: {} }, sessionId: page }) + record(contextCreated(page, 'main')));
  await tree;
  await until(() => seen.length === 2, 'both frames delivered');
  assert.deepEqual(seen, ['reply Page.getFrameTree', 'event Runtime.executionContextCreated']);
});
