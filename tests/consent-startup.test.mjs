import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createPaymentCard, prepareConsentHost } from '../plugins/sleight/lib/payment-card.mjs';
import { replayBridge } from '../plugins/sleight/lib/replay.mjs';
import { shellCardContext } from '../plugins/sleight/lib/launch.mjs';
import { createShellRelay } from '../plugins/sleight/lib/socket-bridge.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const test = (name, run) => nodeTest(name, { timeout: 1000 }, run);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeClock() {
  let time = 1000, next = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { at: time + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.fn(); }
      await flush();
    },
  };
}
function fixture(overrides = {}) {
  const clock = fakeClock(), build = deferred(), owner = new AbortController();
  const events = [], shown = [], calls = [];
  let buildSignal, hostCloses = 0;
  const ui = {
    present(id, data, choices, answer, options) { shown.push({ id, data, choices, answer, options }); },
    authenticate: event => event.person === true,
    close() { hostCloses++; },
  };
  const card = createPaymentCard({ clock, now: clock.now, prepareTimeoutMs: 175000,
    requestContext: () => ({ deadline: 301000, signal: owner.signal }),
    prepare({ signal }) { calls.push('build'); buildSignal = signal; return build.promise; },
    open() { calls.push('open'); return ui; },
    onStatus: status => events.push(status), ...overrides,
  });
  return { card, clock, build, owner, events, shown, calls, ui,
    buildSignal: () => buildSignal, hostCloses: () => hostCloses };
}

test('cold consent preparation beyond twenty seconds presents one card and needs its authenticated answer', async () => {
  const f = fixture();
  const answer = f.card.ask({ app: 'Chess', request: 'Allow Chess?' });
  await flush();
  await f.clock.advance(21000);
  assert.deepEqual(f.calls, ['build']);
  assert.deepEqual(f.events.map(e => e.state), ['preparing']);
  assert.equal(f.shown.length, 0);
  f.build.resolve({ status: 'ready', receipt: {} });
  await flush();
  assert.deepEqual(f.calls, ['build', 'open']);
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].options.deadline, 142000, 'the full 120-second answer window starts after preparation');
  assert.deepEqual(f.events.map(e => e.state), ['preparing', 'waiting']);
  assert.equal(f.events[0].id, f.events[1].id);
  let completed = false;
  answer.then(() => { completed = true; });
  f.shown[0].answer({ choice: 'once' }); await flush();
  assert.equal(completed, false);
  f.shown[0].answer({ choice: 'once', person: true });
  assert.equal(await answer, 'once');
  await flush();
  assert.equal(f.shown.length, 1, 'completion never retries the action or creates another consent request');
  await f.card.close();
});

test('compile-only warmup and simultaneous requests share one build but never share answers', async () => {
  const f = fixture();
  const warm = f.card.prepare();
  const first = f.card.ask({ app: 'Chess' }), second = f.card.ask({ app: 'Calculator' });
  await flush();
  assert.deepEqual(f.calls, ['build']);
  assert.equal(f.shown.length, 0);
  f.build.resolve({ status: 'ready', receipt: {} });
  await warm; await flush();
  assert.deepEqual(f.calls, ['build', 'open']);
  assert.equal(f.shown.length, 2);
  f.shown[0].answer({ person: true, choice: 'once' });
  f.shown[1].answer({ person: true, choice: 'cancel' });
  assert.deepEqual(await Promise.all([first, second]), ['once', 'cancel']);
  await f.card.close();
});

test('the original call deadline reserves the answer window and refuses a late build without UI', async () => {
  const f = fixture();
  const answer = f.card.ask({ app: 'Chess' });
  await flush();
  await f.clock.advance(175000);
  assert.equal(await answer, undefined);
  f.build.resolve({ status: 'ready', receipt: {} });
  await flush();
  assert.deepEqual(f.calls, ['build']);
  assert.equal(f.shown.length, 0);
  assert.deepEqual(f.events.map(e => e.state), ['preparing', 'unavailable']);
  await f.card.close();
});

test('request expiry wins against asynchronous host creation and closes the late host', async () => {
  const opened = deferred(), f = fixture({ open: () => opened.promise });
  f.build.resolve({ status: 'ready', receipt: {} });
  const answer = f.card.ask({ app: 'Chess' });
  await flush();
  await f.clock.advance(175000);
  assert.equal(await answer, undefined);
  opened.resolve(f.ui); await flush();
  assert.equal(f.shown.length, 0);
  assert.equal(f.hostCloses(), 1);
  await f.card.close();
});

test('session close aborts preparation immediately and waits for owned compiler close', async () => {
  const f = fixture();
  const answer = f.card.ask({ app: 'Chess' });
  await flush();
  let closed = false;
  const closing = f.card.close().then(() => { closed = true; });
  await flush();
  assert.equal(f.buildSignal().aborted, true);
  assert.equal(await answer, undefined);
  assert.equal(closed, false, 'abort is not proof that the compiler closed');
  f.build.resolve({ status: 'unavailable', code: 'ABORT_ERR' });
  await closing;
  assert.equal(closed, true);
  assert.equal(f.shown.length, 0);
  assert.equal(await f.card.ask({ app: 'Chess' }), undefined);
});

test('request cancellation during preparation prevents late presentation without aborting shared warmup', async () => {
  const f = fixture();
  const answer = f.card.ask({ app: 'Chess' });
  await flush(); f.owner.abort();
  assert.equal(await answer, undefined);
  assert.equal(f.buildSignal().aborted, false);
  f.build.resolve({ status: 'ready', receipt: {} }); await flush();
  assert.equal(f.shown.length, 0);
  await f.card.close();
});

test('a failed preparation can be retried only by a new explicit request', async () => {
  let builds = 0;
  const f = fixture({ prepare: async () => ++builds === 1 ? { status: 'unavailable' } : { status: 'ready', receipt: {} } });
  assert.equal(await f.card.ask({ app: 'Chess' }), undefined);
  await flush(); assert.equal(builds, 1);
  assert.equal(f.shown.length, 0);
  const retry = f.card.ask({ app: 'Chess' }); await flush();
  assert.equal(builds, 2);
  assert.equal(f.shown.length, 1);
  f.shown[0].answer({ person: true, choice: 'once' });
  assert.equal(await retry, 'once');
  await f.card.close();
});

test('an already-spent original call budget does not start preparation or open a host', async () => {
  const f = fixture({ requestContext: () => ({ deadline: 126000 }) });
  assert.equal(await f.card.ask({ app: 'Chess' }), undefined);
  assert.deepEqual(f.calls, []);
  assert.equal(f.shown.length, 0);
  await f.card.close();
});

test('optional replay lifecycle hooks see trusted requests and terminal replies while ordinary traffic is unchanged', async () => {
  const input = new PassThrough(), output = new PassThrough(), incoming = [], outgoing = [], events = [];
  const bridge = replayBridge({ input, output,
    onRequest: message => { events.push(['request', message.id]); delete message.params._meta; },
    onReply: message => events.push(['reply', message.id]),
    onClose: () => events.push(['close']),
  });
  bridge.clientIn.on('data', chunk => incoming.push(JSON.parse(chunk)));
  output.on('data', chunk => outgoing.push(JSON.parse(chunk)));
  input.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1' }, _meta: { private: true } } }) + '\n');
  bridge.clientOut.write(JSON.stringify({ id: 1, result: { content: [] } }) + '\n');
  input.end(); await flush();
  assert.deepEqual(events, [['request', 1], ['reply', 1], ['close']]);
  assert.equal(incoming[0].params._meta, undefined);
  assert.deepEqual(outgoing, [{ id: 1, result: { content: [] } }]);
});

test('shell deadline context strips its private envelope and ignores caller argument deadlines', async () => {
  const clock = fakeClock(), context = shellCardContext({ now: clock.now, clock });
  const request = { id: 1, method: 'tools/call', params: { name: 'js',
    arguments: { code: '1', deadline: Number.MAX_SAFE_INTEGER, _meta: { sleightShellDeadline: Number.MAX_SAFE_INTEGER } },
    _meta: { sleightShellDeadline: 301000, other: 'ordinary metadata' } } };
  context.onRequest(request);
  const active = context.current();
  assert.equal(active.deadline, 301000);
  assert.deepEqual(request.params._meta, { other: 'ordinary metadata' });
  await clock.advance(150000);
  assert.equal(context.current().deadline, 301000, 'elicitation cannot reset the call clock');
  context.onReply({ id: 1, result: {} });
  assert.equal(active.signal.aborted, true);
  assert.equal(context.current(), undefined);
  context.onRequest({ id: 2, method: 'tools/call', params: { name: 'js', arguments: request.params.arguments } });
  assert.equal(context.current().signal.aborted, true, 'arguments cannot replace missing trusted metadata');
  context.onClose();
});

test('the shell context aborts on its original deadline, cancellation, and EOF', async () => {
  for (const ending of ['deadline', 'cancel', 'close']) {
    const clock = fakeClock(), context = shellCardContext({ now: clock.now, clock });
    context.onRequest({ id: 1, method: 'tools/call', params: { _meta: { sleightShellDeadline: 301000 } } });
    const active = context.current();
    if (ending === 'deadline') await clock.advance(300000);
    else if (ending === 'cancel') context.onRequest({ method: 'notifications/cancelled', params: { requestId: 1 } });
    else context.onClose();
    assert.equal(active.signal.aborted, true, ending);
    context.onClose();
  }
});

test('late elicitation uses only the remaining original call budget', async () => {
  const f = fixture();
  await f.clock.advance(174999);
  const answer = f.card.ask({ app: 'Chess' });
  await flush();
  await f.clock.advance(1);
  assert.equal(await answer, undefined);
  f.build.resolve({ status: 'ready', receipt: {} }); await flush();
  assert.deepEqual(f.calls, ['build']);
  await f.card.close();
});

test('closing in the build completion turn cannot create late UI', async () => {
  const f = fixture();
  const answer = f.card.ask({ app: 'Chess' });
  await flush();
  f.build.resolve({ status: 'ready', receipt: {} });
  await f.card.close();
  assert.equal(await answer, undefined);
  assert.deepEqual(f.calls, ['build']);
  assert.equal(f.shown.length, 0);
});

async function fakeShellRelay() {
  const child = new EventEmitter(), clock = fakeClock(), messages = [];
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  const emit = message => child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  child.stdin.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line); messages.push(message);
      if (message.method === 'initialize') queueMicrotask(() => emit({ id: message.id, result: {} }));
    }
  });
  child.stdin.once('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
  const relay = await createShellRelay({ spawnChild: () => child, now: clock.now, requestClock: clock, env: {} });
  return { relay, clock, messages, emit };
}

test('the socket relay stamps a fixed call deadline and forwards preparing then waiting without redispatch', async () => {
  const f = await fakeShellRelay(), statuses = [];
  const result = f.relay.call('js', { code: '1', deadline: 999999999, _meta: { sleightShellDeadline: 999999999 } },
    { onApproval: status => statuses.push(status) });
  const invocation = f.messages.find(message => message.method === 'tools/call');
  assert.deepEqual(invocation.params._meta, { sleightShellDeadline: 301000 });
  const status = state => f.emit({ method: 'notifications/sleight/approval', params: { id: 'card-1', app: 'Chess', state, deadline: 301000 } });
  status('preparing');
  await f.clock.advance(21000);
  status('waiting'); status('waiting');
  assert.deepEqual(statuses.map(item => item.state), ['preparing', 'waiting']);
  status('answered');
  f.emit({ id: invocation.id, result: { content: [] } });
  assert.deepEqual(await result, { content: [] });
  assert.equal(f.messages.filter(message => message.method === 'tools/call').length, 1);
  await f.relay.close();
});

test('preparation pending at the transport deadline reports preparation failure and closes without another call', async () => {
  const f = await fakeShellRelay();
  const result = f.relay.call('js', { code: '1' });
  const rejected = assert.rejects(result, /approval preparation for Chess.*deadline.*no approval was granted.*do not retry/);
  f.emit({ method: 'notifications/sleight/approval', params: { id: 'card-1', app: 'Chess', state: 'preparing', deadline: 301000 } });
  await f.clock.advance(300000);
  await rejected; await f.relay.closed;
  assert.equal(f.messages.filter(message => message.method === 'tools/call').length, 1);
});

test('a compiled consent bank works without Apple tools and waits for full receipt validation', async () => {
  const validated = deferred();
  let tools = 0, validations = 0, shown = 0;
  const host = {
    nativeHelpersBuilt: () => true,
    appleToolsPresent: async () => { tools++; return false; },
    prepareNativeHelpers: async ({ inventory }) => {
      validations++;
      assert.equal(inventory.accepted, true);
      assert.equal(inventory.files.length, 2);
      return validated.promise;
    },
  };
  const card = createPaymentCard({ prepare: options => prepareConsentHost({ ...options, platform: 'darwin', loadHost: async () => host }),
    open: async () => ({ present(_id, _data, _choices, answer) { shown++; answer({ choice: 'once', person: true }); },
      authenticate: event => event.person === true, close() {} }) });
  const answer = card.ask({ app: 'Chess' });
  await flush();
  assert.equal(validations, 1);
  assert.equal(tools, 0);
  assert.equal(shown, 0);
  validated.resolve({ status: 'ready', receipt: {} });
  assert.equal(await answer, 'once');
  assert.equal(shown, 1);
  await card.close();
});

test('an uncached consent bank without Apple tools cannot compile or open UI', async () => {
  const tools = deferred();
  let builds = 0, opens = 0;
  const host = { nativeHelpersBuilt: () => false, appleToolsPresent: () => tools.promise,
    prepareNativeHelpers() { builds++; return { status: 'ready', receipt: {} }; } };
  const card = createPaymentCard({ prepare: options => prepareConsentHost({ ...options, platform: 'darwin', loadHost: async () => host }),
    open() { opens++; } });
  const answer = card.ask({ app: 'Chess' });
  await flush(); tools.resolve(false);
  assert.equal(await answer, undefined);
  assert.equal(builds, 0);
  assert.equal(opens, 0);
  await card.close();
});
