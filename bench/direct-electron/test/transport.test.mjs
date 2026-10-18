import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { ElectronBroker, PipeTransport, transportMethodAllowed } from '../broker.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const frames = [], hang = new Set();
  let sessions = 0;
  input.on('data', data => {
    for (const raw of data.toString().split('\0').filter(Boolean)) {
      const request = JSON.parse(raw);
      frames.push(request);
      if (hang.has(request.method)) continue;
      const route = request.sessionId ? { sessionId: request.sessionId } : {};
      const send = body => queueMicrotask(() => output.write(JSON.stringify({ id: request.id, ...body, ...route }) + '\0'));
      if (request.method === 'Target.attachToTarget') send({ result: { sessionId: 'S' + (++sessions) } });
      else if (request.method === 'Target.getTargetInfo') {
        const targetId = request.params.targetId;
        send({ result: { targetInfo: { targetId, type: targetId.startsWith('W') ? 'service_worker' : 'page',
          url: targetId.startsWith('D') ? 'devtools://devtools/inspector.html' : 'app://main/index.html' } } });
      }
      else if (request.method === 'Page.fail') send({ error: { code: -32000, message: 'no such node' } });
      else send({ result: { ok: true } });
    }
  });
  const events = new EventEmitter(), owned = { pid: 100, birth: 'one' };
  let alive = true;
  const calls = [];
  const child = { identity: owned, input, output, events,
    inspect: async () => ({ parent: alive ? owned : null, descendants: [], complete: true }),
    requestQuit: async () => { alive = false; events.emit('exit', 0); } };
  const broker = new ElectronBroker({
    ownership: { reserve: async () => ({}), record: async () => {}, remove: async () => calls.push('remove') },
    launch: async () => child, authorizeLaunch: async () => true,
    admitTarget: async info => info.type === 'page' && !info.url.startsWith('devtools:'), ...options,
  });
  return { broker, child, frames, input, output, hang, calls, setAlive: value => { alive = value; } };
}
const ready = async options => { const h = harness(options); await h.broker.start({}); return h; };
const methods = h => h.frames.map(frame => frame.method + (frame.sessionId ? '@' + frame.sessionId : ''));
const attach = async (h, client, targetId = 'T1') => (await h.broker.transportSend(client, { method: 'Target.attachToTarget', params: { targetId, flatten: true } })).sessionId;

test('the host fence matches the app filter: app-mode denials, a session on page commands, attach only to admitted targets', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  for (const [method, params] of [['Runtime.evaluate', { expression: '1' }], ['Fetch.enable', {}], ['Input.dispatchKeyEvent', { type: 'keyDown' }],
    ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }], ['Page.navigate', { url: 'https://x.example/' }],
    ['Target.setDiscoverTargets', { discover: true, filter: [{}] }], ['Target.attachToTarget', { targetId: 'T1' }],
    ['Target.attachToTarget', { targetId: 'T1', flatten: true, waitForDebuggerOnStart: true }]])
    await assert.rejects(h.broker.transportSend(client, { method, params }), /CDP_COMMAND_REFUSED/, method);
  assert.deepEqual(methods(h), ['Browser.getVersion'], 'nothing sessionless beyond the browser and target reads reaches the app');
  for (const targetId of ['D1', 'W1']) await assert.rejects(attach(h, client, targetId), /CDP_TARGET_NOT_OWNED/);
  assert.ok(!h.frames.some(frame => frame.method === 'Target.attachToTarget'), 'DevTools and workers are never attached');
  const sessionId = await attach(h, client);
  for (const method of ['Page.close', 'Page.crash', 'Emulation.setFocusEmulationEnabled', 'Target.createTarget', 'Target.closeTarget'])
    await assert.rejects(h.broker.transportSend(client, { method, params: {}, sessionId }), /CDP_COMMAND_REFUSED/, method);
  await assert.rejects(h.broker.transportSend(client, { method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId }),
    /CDP_COMMAND_REFUSED/, 'child auto-attach must ask for frames only');
  await h.broker.transportSend(client, { method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'iframe' }, { exclude: true }] }, sessionId });
  await h.broker.transportSend(client, { method: 'Target.setDiscoverTargets', params: { discover: true } });
  assert.deepEqual(await h.broker.transportSend(client, { method: 'Runtime.evaluate', params: { expression: '1' }, sessionId }), { ok: true });
  assert.equal(h.broker.state, 'ready');
  const closed = await ready({ admitTarget: undefined });
  await assert.rejects(attach(closed, closed.broker.connect('a')), /CDP_TARGET_NOT_OWNED/, 'without a parent callback nothing is attachable');
});

test('private NUL events become v3 session events; malformed events and replies fault the pipe', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new PipeTransport({ input, output });
  const seen = [];
  transport.on('event', frame => seen.push(frame));
  output.write('{"method":"Page.frameNavigated","params":{"a":1},"sessionId":"S1"}\0{"method":"Target.targetCreated"}\0');
  await tick();
  assert.deepEqual(seen, [{ method: 'Page.frameNavigated', params: { a: 1 }, sessionId: 'S1' }, { method: 'Target.targetCreated', params: {} }]);
  assert.ok(Object.isFrozen(seen[0]));
  for (const bad of ['{"method":"nodots"}', '{"method":"A.b","params":[]}', '{"method":"A.b","sessionId":""}', '{"method":5}']) {
    const faulty = new PipeTransport({ input: new PassThrough(), output: new PassThrough() });
    let fault;
    faulty.on('fault', error => { fault = error; });
    faulty.output.write(bad + '\0');
    await tick();
    assert.match(fault?.message, /invalid pipe event/, bad);
  }
  const throwing = new PipeTransport({ input: new PassThrough(), output: new PassThrough() });
  throwing.on('event', () => { throw Error('listener bug'); });
  throwing.output.write('{"method":"A.b"}\0'); await tick();
  assert.equal(throwing.failed, false, 'a throwing listener is not a pipe fault');
});

test('a reply must come on its request route and carry exactly one of result or error', async () => {
  for (const reply of ['{"id":1,"result":{},"sessionId":"S2"}', '{"id":1,"result":{},"error":{}}', '{"id":1}']) {
    const input = new PassThrough(), output = new PassThrough();
    const transport = new PipeTransport({ input, output, timeoutMs: 100 });
    const pending = transport.request('A.b', {}, { sessionId: 'S1' });
    output.write(reply.replace('S2', 'S2') + '\0');
    await assert.rejects(pending, /invalid pipe reply/, reply);
    assert.equal(transport.failed, true);
    assert.equal(input.destroyed, false);
  }
  const input = new PassThrough(), output = new PassThrough();
  const transport = new PipeTransport({ input, output });
  const pending = transport.request('A.b', {}, { sessionId: 'S1' });
  output.write('{"id":1,"result":{"ok":1},"sessionId":"S1"}\0');
  assert.deepEqual(await pending, { ok: 1 });
});

test('bounds: oversized outbound, invalid commands and a full queue are refused without touching the pipe', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new PipeTransport({ input, output, maxFrameBytes: 64, maxPending: 2, timeoutMs: 30 });
  await assert.rejects(transport.request('A.b', { value: 'x'.repeat(100) }), /too large/);
  await assert.rejects(transport.request('', {}), /invalid/);
  await assert.rejects(transport.request('A.b', []), /invalid/);
  await assert.rejects(transport.request('A.b', {}, { sessionId: '' }), /invalid/);
  const a = transport.request('A.b'), b = transport.request('A.c');
  await assert.rejects(transport.request('A.d'), /queue/);
  await Promise.allSettled([a, b]);
  assert.equal(input.destroyed, false);
});

test('transport methods: browser-wide and foreground commands are refused, page commands pass', () => {
  for (const method of ['Browser.close', 'Browser.crash', 'Browser.setDownloadBehavior', 'Page.bringToFront', 'Target.activateTarget', 'Target.createTarget',
    'Target.closeTarget', 'Target.sendMessageToTarget', 'Network.getAllCookies', 'Page.setDownloadBehavior', 'SystemInfo.getInfo', 'nodots', 'A.b.c', '']) {
    assert.equal(transportMethodAllowed(method), false, method);
  }
  for (const method of ['Browser.getVersion', 'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Target.attachToTarget', 'Target.setAutoAttach', 'Page.captureScreenshot']) {
    assert.equal(transportMethodAllowed(method), true, method);
  }
});

test('transportSend gates by client, epoch and method before any pipe write', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  await assert.rejects(h.broker.transportSend({ ...client }, { method: 'Runtime.evaluate' }), /unauthenticated/);
  await assert.rejects(h.broker.transportSend(client, { method: 'Browser.close' }), /CDP_COMMAND_REFUSED/);
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', params: [] }), /CDP_COMMAND_REFUSED/);
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate' , sessionId: 'S404' }), /CDP_SESSION_NOT_OWNED/);
  assert.deepEqual(methods(h), ['Browser.getVersion']);
  const sessionId = await attach(h, client);
  assert.deepEqual(await h.broker.transportSend(client, { method: 'Runtime.evaluate', params: { expression: '1' }, sessionId }), { ok: true });
  assert.equal(h.broker.state, 'ready');
});

test('a command the app answers with an error is an ordinary failure and does not park', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  const { sessionId } = await h.broker.transportSend(client, { method: 'Target.attachToTarget', params: { targetId: 'T', flatten: true } });
  await assert.rejects(h.broker.transportSend(client, { method: 'Page.fail', sessionId }), error => error.cdp === true && error.dispatched === true);
  assert.equal(h.broker.state, 'ready');
});

test('sessions: a client may only use, detach or be told about sessions its own attach created', async () => {
  const h = await ready();
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const mine = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  const theirs = (await h.broker.transportSend(b, { method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } })).sessionId;
  const before = h.frames.length;
  // The route id and every session id named inside params are checked before anything is written.
  await assert.rejects(h.broker.transportSend(a, { method: 'Runtime.evaluate', sessionId: theirs }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(h.broker.transportSend(a, { method: 'Target.detachFromTarget', params: { sessionId: theirs } }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(h.broker.transportSend(a, { method: 'Target.detachFromTarget', params: { sessionId: 'S404' } }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(h.broker.transportSend(a, { method: 'Target.detachFromTarget', params: { sessionId: 7 } }), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(h.broker.transportSend(a, { method: 'Page.enable', params: { targetSessionId: theirs }, sessionId: mine }), /CDP_SESSION_NOT_OWNED/);
  assert.equal(h.frames.length, before, 'no forged command reached the app');
  assert.equal(h.broker.routes.get(theirs).client, b, 'the other client keeps its session');
  await h.broker.transportSend(b, { method: 'Runtime.evaluate', sessionId: theirs });
  await h.broker.transportSend(a, { method: 'Target.detachFromTarget', params: { sessionId: mine } });
  assert.equal(h.broker.routes.has(mine), false);
});

test('the identity check awaited inside transportSend cannot be used to smuggle a foreign session past the check', async () => {
  const h = await ready();
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const theirs = (await h.broker.transportSend(b, { method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } })).sessionId;
  const mine = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  let release;
  h.child.inspect = () => new Promise(resolve => { release = () => resolve({ parent: { pid: 100, birth: 'one' }, descendants: [], complete: true }); });
  h.broker.verifiedAt = -Infinity;
  const params = { sessionId: mine };
  const call = h.broker.transportSend(a, { method: 'Target.detachFromTarget', params });
  await tick();
  // The caller keeps its params object; changing it while the check awaits must not matter.
  params.sessionId = theirs;
  const before = h.frames.length;
  release();
  await assert.rejects(call, /CDP_SESSION_NOT_OWNED/);
  assert.equal(h.frames.length, before);
  assert.equal(h.broker.routes.get(theirs).client, b);
});

test('events: session events go to the owner; browser-level events naming a session go to its owner only', async () => {
  const h = await ready();
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const mine = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  const theirs = (await h.broker.transportSend(b, { method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } })).sessionId;
  const seen = [];
  h.broker.on('routed', (client, frame) => seen.push([client === a ? 'a' : client === b ? 'b' : 'all', frame.method, frame.sessionId ?? frame.params?.sessionId]));
  const emit = frame => h.output.write(JSON.stringify(frame) + '\0');
  emit({ method: 'Page.loadEventFired', params: {}, sessionId: mine });
  emit({ method: 'Page.loadEventFired', params: {}, sessionId: theirs });
  emit({ method: 'Page.loadEventFired', params: {}, sessionId: 'S404' });
  emit({ method: 'Target.attachedToTarget', params: { sessionId: theirs, targetInfo: { targetId: 'T2' } } });
  emit({ method: 'Target.attachedToTarget', params: { sessionId: 'S404', targetInfo: { targetId: 'T9' } } });
  emit({ method: 'Target.attachedToTarget', params: { targetInfo: { targetId: 'T9' } } });
  emit({ method: 'Target.receivedMessageFromTarget', params: { sessionId: mine, message: '{}' } });
  emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T3' } } });
  await tick();
  assert.deepEqual(seen, [
    ['a', 'Page.loadEventFired', mine], ['b', 'Page.loadEventFired', theirs],
    ['b', 'Target.attachedToTarget', theirs], ['a', 'Target.receivedMessageFromTarget', mine],
    ['all', 'Target.targetCreated', undefined]]);
  emit({ method: 'Target.detachedFromTarget', params: { sessionId: theirs } });
  emit({ method: 'Target.detachedFromTarget', params: { sessionId: mine }, sessionId: 'S404' });
  await tick();
  assert.equal(seen.at(-1)[0], 'b', 'a detach event reaches the owner and drops the route');
  assert.equal(h.broker.routes.has(theirs), false);
  assert.equal(h.broker.routes.has(mine), true, 'a detach event for an unrelated route cannot drop a session');
});

test('child sessions announced under an owned session belong to the same client; the route bank is bounded', async () => {
  const h = await ready({ maxRoutes: 3 });
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const parent = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  h.output.write(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'child-1', targetInfo: { targetId: 'F1' } }, sessionId: parent }) + '\0');
  await tick();
  assert.equal(h.broker.routes.get('child-1').client, a);
  await assert.rejects(h.broker.transportSend(b, { method: 'Runtime.evaluate', sessionId: 'child-1' }), /CDP_SESSION_NOT_OWNED/);
  await h.broker.transportSend(a, { method: 'Runtime.evaluate', sessionId: 'child-1' });
  h.output.write(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'child-2', targetInfo: {} }, sessionId: parent }) + '\0');
  h.output.write(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'child-3', targetInfo: {} }, sessionId: parent }) + '\0');
  await tick();
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.broker.parkedBy.reason, 'route bank full');
  assert.equal(h.input.destroyed, false);
});

test('a lost worker: its sessions are detached in the app, other clients keep theirs, the writer stays open', async () => {
  const h = await ready();
  const a = h.broker.connect('a'), b = h.broker.connect('b');
  const mine = (await h.broker.transportSend(a, { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true } })).sessionId;
  const theirs = (await h.broker.transportSend(b, { method: 'Target.attachToTarget', params: { targetId: 'T2', flatten: true } })).sessionId;
  h.broker.detach(a);
  await tick();
  assert.ok(h.frames.some(frame => frame.method === 'Target.detachFromTarget' && frame.params.sessionId === mine));
  assert.ok(!h.frames.some(frame => frame.method === 'Target.detachFromTarget' && frame.params.sessionId === theirs));
  assert.equal(h.broker.routes.has(mine), false);
  assert.equal(h.broker.state, 'ready');
  assert.equal(h.input.destroyed, false);
  await assert.rejects(h.broker.transportSend(a, { method: 'Runtime.evaluate' }), /unauthenticated/);
});

test('revocation during the identity check: the delayed command is never written', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  let release;
  h.child.inspect = () => new Promise(resolve => { release = () => resolve({ parent: { pid: 100, birth: 'one' }, descendants: [], complete: true }); });
  h.broker.verifiedAt = -Infinity;
  const call = h.broker.transportSend(client, { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown' }, sessionId });
  await tick();
  h.broker.revoke('user revoked');
  release();
  await assert.rejects(call, /parked/);
  assert.ok(!h.frames.some(frame => frame.method === 'Input.dispatchKeyEvent'));
  assert.equal(h.input.destroyed, false);
  assert.equal(h.broker.status().parked.resumable, true);
});

test('PID reuse: a different birth time parks before the command is written; a stale check is not reused', async () => {
  let now = 0;
  const h = await ready({ now: () => now, identityMaxAgeMs: 1000 });
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  let inspections = 0;
  const original = h.child.inspect;
  h.child.inspect = async () => { inspections++; return original(); };
  await h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId });
  await h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId });
  assert.equal(inspections, 0, 'a fresh check is reused inside its window');
  now = 5000;
  h.child.inspect = async () => ({ parent: { pid: 100, birth: 'recycled' }, descendants: [], complete: true });
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId }), /identity/);
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.broker.status().parked.resumable, false);
  assert.deepEqual(methods(h), ['Browser.getVersion', 'Target.getTargetInfo', 'Target.attachToTarget', 'Runtime.evaluate@S1', 'Runtime.evaluate@S1']);
  await assert.rejects(h.broker.resume(async () => true), /not resumable/);
});

test('an incomplete census or a vanished parent parks; a child exit parks immediately', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  h.child.inspect = async () => ({ descendants: [], complete: true });
  h.broker.verifiedAt = -Infinity;
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId }), /census/);
  assert.equal(h.broker.state, 'parked');
  const exited = await ready();
  exited.child.events.emit('exit', 0);
  assert.equal(exited.broker.state, 'parked');
  assert.equal(exited.broker.parkedBy.reason, 'child exited');
});

test('timeouts and cancellation leave the effect unknown: park, resumable, never replayed', async () => {
  const h = await ready({ transport: { timeoutMs: 20 } });
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  h.hang.add('Input.dispatchKeyEvent');
  await assert.rejects(h.broker.transportSend(client, { method: 'Input.dispatchKeyEvent', sessionId }), error => error.dispatched === true && /effect unknown/.test(error.message));
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.frames.filter(frame => frame.method === 'Input.dispatchKeyEvent').length, 1);
  h.hang.clear();
  assert.equal((await h.broker.resume(async () => true)).event, 'resumed');
  assert.equal(h.frames.filter(frame => frame.method === 'Input.dispatchKeyEvent').length, 1, 'resume replays nothing');
  const aborted = await ready();
  aborted.hang.add('Input.dispatchKeyEvent');
  const controller = new AbortController();
  const other = aborted.broker.connect('b'), first = aborted.broker.connect('a');
  const route = await attach(aborted, first);
  const call = aborted.broker.transportSend(first, { method: 'Input.dispatchKeyEvent', sessionId: route }, { signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(call, /effect unknown/);
  assert.equal(aborted.input.destroyed, false);
  await assert.rejects(aborted.broker.transportSend(other, { method: 'Runtime.evaluate' }), /parked/);
});

test('resume needs authority, a quiescent healthy pipe, and the same app incarnation; clients must reconnect', async () => {
  const h = await ready();
  const client = h.broker.connect('a');
  h.broker.revoke('disconnect');
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate' }), /parked/);
  await assert.rejects(h.broker.resume(), /authority/);
  await assert.rejects(h.broker.resume(async () => false), /authority/);
  h.child.inspect = async () => ({ parent: { pid: 100, birth: 'other' }, descendants: [], complete: true });
  await assert.rejects(h.broker.resume(async () => true), /identity/);
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.broker.status().parked.resumable, false, 'a failed resume is final');
  const second = await ready();
  second.broker.revoke('disconnect');
  const receipt = await second.broker.resume(async () => true);
  assert.equal(receipt.event, 'resumed');
  await assert.rejects(second.broker.transportSend(client, { method: 'Runtime.evaluate' }), /unauthenticated/);
  assert.ok(second.broker.connect('again'));
  const faulted = await ready();
  faulted.broker.revoke('x');
  faulted.output.end(); await tick();
  await assert.rejects(faulted.broker.resume(async () => true), /not resumable|quiescent/);
});

test('descendants are handed to the durable journal before the next command relies on them', async () => {
  const observed = [];
  const h = await ready({ ownership: { reserve: async () => ({}), record: async () => {}, remove: async () => {}, observe: async (_o, fresh) => observed.push(...fresh) } });
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  const original = h.child.inspect;
  h.child.inspect = async () => ({ ...(await original()), descendants: [{ pid: 101, birth: 'kid' }] });
  h.broker.verifiedAt = -Infinity;
  await h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId });
  await h.broker.inspect();
  assert.deepEqual(observed, [{ pid: 101, birth: 'kid' }], 'each incarnation is journaled once');
  h.child.inspect = async () => ({ ...(await original()), descendants: [{ pid: 102, birth: 'kid2' }] });
  h.broker.ownership.observe = async () => { throw Error('journal write failed'); };
  h.broker.verifiedAt = -Infinity;
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId }), /journal/);
  assert.equal(h.broker.state, 'parked', 'an unrecorded descendant fails closed');
});

test('a full authorization queue refuses new commands without parking', async () => {
  const h = await ready({ maxTransportQueue: 1 });
  const client = h.broker.connect('a');
  const sessionId = await attach(h, client);
  let release;
  h.child.inspect = () => new Promise(resolve => { release = () => resolve({ parent: { pid: 100, birth: 'one' }, descendants: [], complete: true }); });
  h.broker.verifiedAt = -Infinity;
  const first = h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId });
  await tick();
  await assert.rejects(h.broker.transportSend(client, { method: 'Runtime.evaluate', sessionId }), /queue full/);
  release(); await first;
  assert.equal(h.broker.state, 'ready');
});
