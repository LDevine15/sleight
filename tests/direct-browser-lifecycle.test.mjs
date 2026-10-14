import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import * as hostModule from '../plugins/sleight/lib/direct-browser/host.mjs';
import { listenIPC, connectIPC } from '../plugins/sleight/lib/direct-browser/ipc.mjs';
import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
const hello = (session = 'one', incarnation = 'p1-v1') => ({ version: 1, secret, uid, session, incarnation });
const request = (id, operation = 'browser_act') => ({ id, operation, args: { tab: 't1' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const { createHostLifecycle, createBrokerControls, createUiChannel, createRecoverableUi } = hostModule;
function fixture({ close = () => true, mode = 'once', beforePart = () => {}, connect, verify = () => true,
  snapshot, now = () => 100, dispatch, resolve, afterSend = () => {}, ...changes } = {}) {
  const calls = [], opened = [], user = {};
  let scope = { browser: 'browser1', broker: 1, session: 'one', turn: 'turn1', target: 't1',
    lease: 1, frame: 'frame1', document: 1, ref: 'ref1', origin: 'https://fixture.test' };
  const authority = createAuthority({ current: () => scope, snapshot: () => snapshot ? snapshot(scope, { authority, user }) : { scope, time: now() },
    now, authenticate: event => event === user, classify: operation => operation });
  const grant = session => authority.user(user, 'grant', { session, origin: scope.origin, mode });
  grant('one');
  const transportAuthority = createTransportAuthority({ authority, resolveOperation(plan, context, command) {
    scope = { ...scope, session: context.session, broker: context.brokerEpoch, target: plan.target };
    const operation = { id: context.session + '-' + context.operation, kind: plan.operationName === 'browser_read' ? 'read' : 'click',
      args: {}, scope: { ...scope }, consequence: 'ordinary' };
    return resolve ? resolve(operation, command) : operation;
  } });
  const session = () => new Proxy({ sessionId: 'socket' + (opened.length + 1),
    send(method, params, route) {
      if (!['Input.dispatchMouseEvent', 'DOM.getDocument', 'DOM.describeNode'].includes(method)) throw Error('unsupported CDP command');
      calls.push({ method, params, route }); afterSend(); return Promise.resolve({});
    }, on() {}, off() {} }, { get(object, key) {
    if (key in object || typeof key === 'symbol' || key === 'then') return object[key];
    throw Error('unsupported CDP member ' + key);
  } });
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser1',
    async connect() { const socket = connect ? await connect(session) : session(); opened.push(socket); return socket; },
    disconnect: close, verifyConnection: verify, currentTurn: () => 'turn1', validateRequest: frame => frame,
    prepare: args => ({ target: args.tab }), authorize: () => true, dispatchFence: () => true,
    transportAuthority, endSession(session) { authority.user(user, 'end-session', { session }); return true; }, redact: value => value,
    async dispatch(plan, context) {
      if (dispatch) return dispatch(plan, context);
      const commands = plan.operationName === 'browser_read'
        ? [['DOM.getDocument', {}], ['DOM.describeNode', { nodeId: 1 }]]
        : [['Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 }],
          ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 }]];
      for (let i = 0; i < commands.length; i++) {
        beforePart(i, { authority, user, scope, setScope: value => { scope = value; } });
        await context.session.send(...commands[i], 'owned-session');
      }
      return { effect: 'verified', observation: {} };
    }, ...changes });
  return { broker, calls, opened, authority, grant };
}

test('a closure provider is mandatory before any connection can be owned', () => {
  assert.throws(() => fixture({ close: undefined, disconnect: undefined }), /TRUSTED_CONTRACT_REQUIRED/);
});
for (const [name, close] of [['false', () => false], ['throwing', () => { throw Error('uncertain'); }],
  ['async false', async () => false], ['rejected', async () => { throw Error('uncertain'); }]]) {
  test('unconfirmed ' + name + ' closure retains ownership and refuses reconnect', async () => {
    const f = fixture({ close }); await f.broker.connect({ userInitiated: true });
    await f.broker.loseConnection();
    assert.equal(f.broker.status().cleanup.pending, 1);
    await assert.rejects(f.broker.connect({ userInitiated: true }), /CONNECTION_CLEANUP_REQUIRED/);
    assert.equal(f.opened.length, 1);
  });
}
test('async closure proof fences reconnect until true, without another close request', async () => {
  let confirm, attempts = 0;
  const f = fixture({ close: () => { attempts++; return new Promise(resolve => { confirm = resolve; }); } });
  await f.broker.connect({ userInitiated: true });
  const closing = f.broker.loseConnection();
  await assert.rejects(f.broker.connect({ userInitiated: true }), /CONNECTION_CLEANUP_REQUIRED/);
  assert.equal(attempts, 1); confirm(true); await closing;
  assert.equal(f.broker.status().cleanup.pending, 0);
  await f.broker.connect({ userInitiated: true }); assert.equal(f.opened.length, 2);
});
test('only explicit cleanup retries an uncertain exact socket', async () => {
  const closed = []; let proven = false;
  const f = fixture({ close: socket => { closed.push(socket); return proven; } });
  await f.broker.connect({ userInitiated: true }); await f.broker.loseConnection();
  await assert.rejects(f.broker.connect({ userInitiated: true }), /CONNECTION_CLEANUP_REQUIRED/);
  assert.equal(closed.length, 1); proven = true;
  assert.equal(await f.broker.cleanup({ userInitiated: true }), true);
  assert.equal(closed.length, 2); assert.equal(closed[0], closed[1]);
  await f.broker.connect({ userInitiated: true });
});
for (const stale of [true, false]) test((stale ? 'stale' : 'cancelled late') + ' candidate remains owned until closure proof', async () => {
  let deliver;
  const f = fixture({ close: () => false, verify: () => !stale,
    connect: make => new Promise(resolve => { deliver = () => resolve(make()); }) });
  const connecting = f.broker.connect({ userInitiated: true });
  if (!stale) f.broker.loseConnection();
  deliver(); await assert.rejects(connecting, /STALE_INSTANCE|CONNECT_CANCELLED/);
  assert.equal(f.broker.status().cleanup.pending, 1);
  await assert.rejects(f.broker.connect({ userInitiated: true }), /CONNECTION_CLEANUP_REQUIRED/);
  assert.equal(f.opened.length, 1);
});
test('shutdown retains uncertain socket and never admits a new Connect', async () => {
  const f = fixture({ close: () => false }); await f.broker.connect({ userInitiated: true });
  const client = f.broker.attach(hello());
  assert.equal(await f.broker.shutdown(), false);
  assert.equal(f.broker.status().cleanup.pending, 1);
  assert.equal((await client.request(request('stopped'))).effect, 'none');
  await assert.rejects(f.broker.connect({ userInitiated: true }), /HOST_CLOSED/);
  assert.equal(f.calls.length, 0);
});
test('attach before Connect requires explicit authenticated rebind and fresh consent', async () => {
  const f = fixture(), old = f.broker.attach(hello()); await f.broker.connect({ userInitiated: true });
  assert.equal((await old.request(request('early'))).error.code, 'LEASE_LOST');
  assert.throws(() => old.rebind(hello('other')), /IPC_AUTH/);
  assert.throws(() => old.rebind(hello('one', 'p2-v1')), /IPC_AUTH/);
  const fresh = old.rebind(hello());
  assert.equal((await old.request(request('old'))).error.code, 'CLIENT_DISCONNECTED');
  assert.equal((await fresh.request(request('no-consent'))).effect, 'none');
  f.grant('one'); assert.equal((await fresh.request(request('new'))).effect, 'verified');
  assert.equal(f.calls.length, 2);
  assert.throws(() => f.broker.attach(hello()), /SESSION_IN_USE/);
});
test('reconnect rebind preserves receipts while refusing process replacement and duplicate clients', async () => {
  const f = fixture({ mode: 'session' }); await f.broker.connect({ userInitiated: true });
  const old = f.broker.attach(hello()), receipt = await old.request(request('done'));
  await f.broker.loseConnection(); await f.broker.connect({ userInitiated: true });
  const fresh = old.rebind(hello());
  assert.deepEqual(await fresh.request(request('done')), receipt); assert.equal(f.calls.length, 2);
  assert.equal((await fresh.request({ ...request('done'), operation: 'browser_read' })).error.code, 'DUPLICATE_MISMATCH');
  assert.throws(() => old.rebind(hello()), /CLIENT_DISCONNECTED/);
  fresh.disconnect();
  assert.throws(() => f.broker.attach(hello('one', 'p2-v1')), /SESSION_IN_USE/);
  assert.doesNotThrow(() => f.broker.attach(hello()));
});
for (const operation of ['browser_act', 'browser_read']) test('once consent covers one complete logical ' + operation, async () => {
  const f = fixture(); await f.broker.connect({ userInitiated: true });
  const client = f.broker.attach(hello()), receipt = await client.request(request('first', operation));
  assert.equal(receipt.effect, 'verified'); assert.equal(f.calls.length, 2);
  assert.equal(f.authority.receipt('one-first').phase, 'verified');
  assert.equal((await client.request(request('second', operation))).effect, 'none');
  assert.equal(f.calls.length, 2); assert.deepEqual(await client.request(request('first', operation)), receipt);
});
for (const reason of ['revoke', 'expiry', 'frame', 'document', 'lease', 'origin', 'terms']) {
  test('mid-operation ' + reason + ' fences the release without replay', async () => {
    let time = 100;
    const f = fixture({ now: () => time, beforePart(i, { authority, user, scope, setScope }) {
      if (!i) return;
      if (reason === 'revoke') authority.user(user, 'revoke', { session: 'one' });
      else if (reason === 'expiry') time = 5100;
      else if (reason !== 'terms') setScope({ ...scope, [reason]: reason === 'document' || reason === 'lease' ? 2 : reason === 'origin' ? 'https://changed.test' : 'changed' });
    }, resolve: reason === 'terms' ? (operation, command) => ({ ...operation, consequence: command.params.type === 'mouseReleased' ? 'delete' : 'ordinary' }) : undefined });
    await f.broker.connect({ userInitiated: true }); const client = f.broker.attach(hello());
    const receipt = await client.request(request('first'));
    assert.equal(receipt.effect, 'unknown'); assert.equal(f.calls.length, 1);
    f.grant('one'); assert.equal((await client.request(request('again'))).error.code, 'STATE_UNVERIFIABLE');
    assert.equal(f.calls.length, 1); await tick(); assert.equal(f.calls.length, 1);
  });
}
test('unknown logical effect quarantines authority and broker target after complete transport', async () => {
  const f = fixture({ mode: 'session', async dispatch(plan, context) {
    await context.session.send('DOM.getDocument', {}, 'owned-session');
    return { effect: 'unknown', observation: {} };
  } });
  await f.broker.connect({ userInitiated: true }); const client = f.broker.attach(hello());
  assert.equal((await client.request(request('unknown', 'browser_read'))).effect, 'unknown');
  assert.equal(f.authority.receipt('one-unknown').phase, 'unknown');
  assert.equal((await client.request(request('retry', 'browser_read'))).error.code, 'STATE_UNVERIFIABLE');
  assert.equal(f.calls.length, 1);
});
test('revoking another session does not spend or fence this session once operation', async () => {
  const f = fixture({ beforePart(i, { authority, user }) {
    if (i) authority.user(user, 'revoke', { session: 'two' });
  } });
  f.grant('two'); await f.broker.connect({ userInitiated: true });
  const one = f.broker.attach(hello()), two = f.broker.attach(hello('two'));
  assert.equal((await one.request(request('one'))).effect, 'verified');
  assert.equal((await two.request(request('two'))).effect, 'none');
  assert.equal(f.calls.length, 2);
});
test('coherent terminal snapshot revocation fences a continuation even after first command', async () => {
  let f, snapshots = 0;
  f = fixture({ snapshot(scope, { authority, user }) {
    if (++snapshots === 2) authority.user(user, 'revoke', { session: 'one' });
    return { scope, time: 100 };
  } });
  await f.broker.connect({ userInitiated: true });
  assert.equal((await f.broker.attach(hello()).request(request('terminal'))).effect, 'unknown');
  assert.equal(f.calls.length, 1);
});

test('IPC rebind authenticates the same OS peer and replaces only its stale handle', async t => {
  const f = fixture(), directory = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'bp2-rebind-')))));
  let peer = { uid, pid: 100, incarnation: 'p100-v1' };
  const listener = await listenIPC({ directory, broker: f.broker, uid, secret, peerIdentity: async () => peer });
  t.after(() => listener.close());
  const client = await connectIPC({ path: listener.path, hello: hello('one', 'self') }); t.after(() => client.close());
  await f.broker.connect({ userInitiated: true });
  assert.equal((await client.request(request('early'))).error.code, 'LEASE_LOST');
  assert.equal(typeof client.rebind, 'function');
  assert.equal((await client.rebind()).rebound, true); f.grant('one');
  assert.equal((await client.request(request('new'))).effect, 'verified');
  await f.broker.loseConnection(); await f.broker.connect({ userInitiated: true });
  peer = { ...peer, incarnation: 'p100-v2' };
  await assert.rejects(client.rebind(), /IPC_CLOSED/); assert.equal(f.calls.length, 2);
});
test('host cleanup control retries exact closure and never substitutes Connect', async () => {
  let proven = false;
  const f = fixture({ close: () => proven }); await f.broker.connect({ userInitiated: true });
  await f.broker.loseConnection();
  const read = new PassThrough(), write = new PassThrough(), frames = [];
  write.on('data', bytes => frames.push(JSON.parse(bytes)));
  const ui = createUiChannel({ read, write });
  assert.equal(typeof createBrokerControls, 'function');
  const controls = createBrokerControls({ broker: f.broker, ui, revokeSessions: () => {} });
  controls.status(f.broker.status());
  assert.equal(frames.at(-1).data.status, 'cleanup-required');
  assert.deepEqual(frames.at(-1).choices, ['cleanup']);
  proven = true; const frame = frames.at(-1);
  read.write(JSON.stringify({ id: frame.id, nonce: frame.nonce, choice: 'cleanup' }) + '\n'); await tick();
  assert.equal(f.broker.status().cleanup.pending, 0); assert.equal(f.opened.length, 1);
  assert.deepEqual(frames.at(-1).choices, ['connect']); ui.close();
});
test('host close returns uncertain teardown and retains explicit retry ownership', async () => {
  let proven = false, listenerClosed = 0, uiClosed = 0;
  const f = fixture({ close: () => proven }); await f.broker.connect({ userInitiated: true });
  assert.equal(typeof createHostLifecycle, 'function');
  const host = createHostLifecycle({ broker: f.broker, listener: { close: async () => { listenerClosed++; } },
    ui: { close() { uiClosed++; } }, revokeSessions: () => {} });
  const result = await host.close();
  assert.equal(result.closed, false); assert.equal(result.cleanup.pending, 1);
  assert.equal(listenerClosed, 0); assert.equal(uiClosed, 0);
  proven = true; assert.equal(await f.broker.cleanup({ userInitiated: true }), true);
  assert.equal((await host.close()).closed, true); assert.equal(listenerClosed, 1); assert.equal(uiClosed, 1);
});
for (const closure of ['false', 'throwing', 'pending']) test(`uncertain ${closure} host shutdown retains real singleton and authenticated cleanup`, async t => {
  const directory = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'bp2-shutdown-ipc-')))));
  let proven = false, confirm, attempts = 0;
  const f = fixture({ timeoutMs: 10, close: () => {
    attempts++;
    if (proven) return true;
    if (closure === 'throwing') throw Error('private fixture failure');
    return closure === 'pending' ? new Promise(resolve => { confirm = resolve; }) : false;
  } });
  await f.broker.connect({ userInitiated: true });
  const client = f.broker.attach(hello());
  const peerIdentity = async () => ({ uid, pid: 100, incarnation: 'p100-v1' });
  const options = { directory, broker: f.broker, uid, secret, peerIdentity };
  const listener = await listenIPC(options); t.after(() => listener.close());
  const read = new PassThrough(), write = new PassThrough(), frames = [];
  write.on('data', bytes => frames.push(JSON.parse(bytes)));
  let uiClosed = 0;
  const channel = createUiChannel({ read, write });
  const ui = { present: channel.present, authenticate: channel.authenticate,
    close() { uiClosed++; channel.close(); } };
  const controls = createBrokerControls({ broker: f.broker, ui, revokeSessions: () => {} });
  const host = createHostLifecycle({ broker: f.broker, listener, ui, revokeSessions: () => {} });
  t.after(() => channel.close());
  const closing = host.close();
  assert.equal((await client.request(request('stopping'))).effect, 'none');
  assert.equal((await closing).closed, false);
  assert.equal(uiClosed, 0); assert.equal(existsSync(join(directory, 'broker.lock')), true);
  await assert.rejects(listenIPC(options), /IPC_SINGLETON/);
  await assert.rejects(f.broker.connect({ userInitiated: true }), /HOST_CLOSED/);
  assert.equal((await host.close()).closed, false); assert.equal(attempts, 1);
  controls.status(f.broker.status());
  assert.equal(frames.at(-1).data.status, 'cleanup-required');
  assert.deepEqual(frames.at(-1).choices, ['cleanup']);
  if (closure === 'pending') {
    assert.equal(await f.broker.cleanup({ userInitiated: true }), false); assert.equal(attempts, 1);
    confirm(true); await tick();
  } else {
    proven = true; const frame = frames.at(-1);
    read.write(JSON.stringify({ id: frame.id, nonce: frame.nonce, choice: 'cleanup' }) + '\n');
    await tick();
    assert.equal(attempts, 2);
  }
  assert.equal((await host.close()).closed, true);
  assert.equal(uiClosed, 1); assert.equal(existsSync(join(directory, 'broker.lock')), false);
  assert.equal((await host.close()).closed, true); assert.equal(uiClosed, 1);
  const replacement = await listenIPC(options); await replacement.close();
  assert.equal(f.calls.length, 0);
});
test('late closure proof releases the host only on reconciliation and never retries the provider', async () => {
  let confirm, attempts = 0, listenerClosed = 0, uiClosed = 0;
  const f = fixture({ timeoutMs: 10, close: () => { attempts++; return new Promise(resolve => { confirm = resolve; }); } });
  await f.broker.connect({ userInitiated: true });
  const host = createHostLifecycle({ broker: f.broker, listener: { close: async () => { listenerClosed++; } },
    ui: { close() { uiClosed++; } }, revokeSessions: () => {} });
  assert.equal((await host.close()).closed, false); assert.equal(attempts, 1);
  confirm(true); await tick();
  assert.equal((await host.reconcile()).closed, true);
  assert.equal(attempts, 1); assert.equal(listenerClosed, 1); assert.equal(uiClosed, 1);
});
for (const fault of ['revoke', 'listener', 'ui']) test(`failed ${fault} host teardown is retained and can be retried`, async () => {
  let failed = true, listenerClosed = 0, uiClosed = 0;
  const f = fixture(); await f.broker.connect({ userInitiated: true });
  const host = createHostLifecycle({ broker: f.broker,
    listener: { async close() { if (fault === 'listener' && failed) throw Error('private listener failure'); listenerClosed++; } },
    ui: { close() { if (fault === 'ui' && failed) throw Error('private UI failure'); uiClosed++; } },
    revokeSessions() { if (fault === 'revoke' && failed) throw Error('private revoke failure'); } });
  const result = await host.close();
  assert.equal(result.closed, false); assert.match(result.error, /TEARDOWN_UNCONFIRMED/);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.equal(uiClosed, 0);
  failed = false;
  assert.equal((await host.close()).closed, true); assert.equal(listenerClosed, 1); assert.equal(uiClosed, 1);
});
test('IPC teardown refuses replacement lock ownership and can retry exact cleanup', async t => {
  const directory = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'bp2-shutdown-lock-')))));
  const f = fixture(), options = { directory, broker: f.broker, uid, secret,
    peerIdentity: async () => ({ uid, pid: 100, incarnation: 'p100-v1' }) };
  const listener = await listenIPC(options), lock = join(directory, 'broker.lock'), saved = join(directory, 'owned.lock');
  renameSync(lock, saved);
  const otherDirectory = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'bp2-shutdown-other-')))));
  const other = await listenIPC({ ...options, directory: otherDirectory });
  t.after(() => other.close());
  renameSync(join(otherDirectory, 'broker.lock'), lock);
  await assert.rejects(listener.close(), /IPC_RESOURCE_CHANGED/);
  assert.equal(existsSync(lock), true);
  renameSync(lock, join(otherDirectory, 'broker.lock')); renameSync(saved, lock);
  await listener.close(); await other.close();
  assert.equal(existsSync(lock), false);
});
test('lost private UI is recreated with fresh authentication and cleanup-only controls', async t => {
  let scheduled, losses = 0, ready = 0;
  const channels = [], f = fixture({ close: () => false });
  await f.broker.connect({ userInitiated: true });
  const ui = createRecoverableUi({
    createUi(onLoss) {
      const read = new PassThrough(), write = new PassThrough(), frames = [];
      write.on('data', bytes => frames.push(JSON.parse(bytes)));
      const channel = createUiChannel({ read, write, onLoss }); channels.push({ read, frames, channel });
      return channel;
    },
    onLoss() { losses++; f.broker.shutdown(); }, onReady() { ready++; },
    schedule(fn) { scheduled = fn; return 'retry'; }, cancel() { scheduled = undefined; },
  });
  t.after(() => ui.close()); ui.start();
  const controls = createBrokerControls({ broker: f.broker, ui, revokeSessions: () => {} });
  controls.status(f.broker.status()); const stale = channels[0].frames.at(-1);
  channels[0].read.end(); await tick();
  assert.equal(losses, 1); assert.equal(ready, 1); assert.equal(f.broker.status().stopping, true);
  assert.equal(typeof scheduled, 'function'); scheduled();
  assert.equal(ready, 2); assert.equal(channels.length, 2);
  controls.status(f.broker.status()); const fresh = channels[1].frames.at(-1);
  assert.notEqual(stale.nonce, fresh.nonce); assert.deepEqual(fresh.choices, ['cleanup']);
  assert.equal(ui.authenticate({ id: stale.id, nonce: stale.nonce, choice: 'connect' }), false);
  await assert.rejects(f.broker.connect({ userInitiated: true }), /HOST_CLOSED/);
  assert.equal(f.opened.length, 1);
});
test('UI recreation waits between failures and never restarts after proven teardown', () => {
  let scheduled, tries = 0, closed = 0;
  const ui = createRecoverableUi({ createUi() { tries++; if (tries < 3) throw Error('private factory failure');
    return { close() { closed++; }, present() {}, authenticate() { return false; } }; },
    onLoss() {}, onReady() {}, schedule(fn) { scheduled = () => { scheduled = undefined; fn(); }; return 'retry'; }, cancel() { scheduled = undefined; } });
  assert.throws(() => ui.start(), /TRUSTED_UI_UNAVAILABLE/);
  assert.equal(tries, 1); scheduled(); assert.equal(tries, 2); scheduled(); assert.equal(tries, 3);
  ui.close(); assert.equal(closed, 1); assert.equal(scheduled, undefined);
  assert.throws(() => ui.start(), /TRUSTED_UI_UNAVAILABLE/); assert.equal(tries, 3);
});
test('a throwing private UI close retains that exact provider for retry', () => {
  let fail = true, attempts = 0, created = 0;
  const ui = createRecoverableUi({ createUi() { created++; return {
    close() { attempts++; if (fail) throw Error('private close failure'); }, present() {}, authenticate() { return false; },
  }; }, onLoss() {}, onReady() {} });
  ui.start(); assert.throws(() => ui.close(), /private close failure/);
  assert.equal(attempts, 1); fail = false; ui.close();
  assert.equal(attempts, 2); assert.equal(created, 1);
  assert.throws(() => ui.start(), /TRUSTED_UI_UNAVAILABLE/);
});
test('host shutdown waits for late candidate and retains false closure', async () => {
  let deliver;
  const f = fixture({ close: () => false, connect: make => new Promise(resolve => { deliver = () => resolve(make()); }) });
  const connecting = f.broker.connect({ userInitiated: true });
  const stopping = f.broker.shutdown(); deliver();
  await assert.rejects(connecting, /CONNECT_CANCELLED/);
  assert.equal(await stopping, false); assert.equal(f.broker.status().cleanup.pending, 1);
  await assert.rejects(f.broker.connect({ userInitiated: true }), /HOST_CLOSED/);
});
test('unsettled closure bounds shutdown while retaining its eventual exact proof', async () => {
  let confirm, attempts = 0;
  const f = fixture({ timeoutMs: 10, close: () => { attempts++; return new Promise(resolve => { confirm = resolve; }); } });
  await f.broker.connect({ userInitiated: true });
  assert.equal(await f.broker.shutdown(), false); assert.equal(f.broker.status().cleanup.pending, 1);
  assert.equal(await f.broker.cleanup({ userInitiated: true }), false); assert.equal(attempts, 1);
  confirm(true); await tick(); assert.equal(f.broker.status().cleanup.pending, 0);
});
test('completed logical operation fences delayed transport even with new consent', async () => {
  let late;
  const f = fixture({ async dispatch(plan, context) {
    late = () => context.session.send('DOM.getDocument', {}, 'owned-session');
    await late(); return { effect: 'verified', observation: {} };
  } });
  await f.broker.connect({ userInitiated: true });
  assert.equal((await f.broker.attach(hello()).request(request('done', 'browser_read'))).effect, 'verified');
  f.grant('one'); assert.throws(late, /LEASE_LOST|TRANSPORT_SPENT/); assert.equal(f.calls.length, 1);
});
test('broker never invokes a turn provider between coherent snapshot and physical transport', async () => {
  let terminal = false, callbacks = 0;
  const f = fixture({ snapshot(scope) { terminal = true; return { scope, time: 100 }; },
    afterSend() { terminal = false; }, currentTurn() { if (terminal) callbacks++; return 'turn1'; } });
  await f.broker.connect({ userInitiated: true });
  assert.equal((await f.broker.attach(hello()).request(request('terminal'))).effect, 'verified');
  assert.equal(callbacks, 0); assert.equal(f.calls.length, 2);
});
