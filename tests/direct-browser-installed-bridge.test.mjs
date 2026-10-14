import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const bridgeModule = await import('../plugins/sleight/lib/direct-browser/installed-bridge.mjs').catch(() => ({}));
import { installedPipeFixture as fixture, installedHello as hello } from './fixtures/direct-browser-installed-pipes.mjs';
import { createBrokerControls } from '../plugins/sleight/lib/direct-browser/host.mjs';
const workerModule = await import('../plugins/sleight/lib/direct-browser/installed-worker.mjs');
const readRequest = { name: 'browser_read', arguments: { tab: 'tfixture' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const retained = { revoked: true, cleanup: [{ resource: 'owned-target', status: 'retained', code: 'EFFECT_UNKNOWN' }] };

test('absent operator opt-in leaves ordinary launch off without creating a child', async () => {
  assert.equal(typeof bridgeModule.createInstalledBridge, 'function', 'installed bridge missing');
  const result = await bridgeModule.createInstalledBridge({}, { readConfig: () => null,
    spawnWorker() { assert.fail('off configuration spawned worker'); } });
  assert.equal(result, null);
});

test('parent launches only the package worker with private inherited descriptors', async t => {
  const f = await fixture(t);
  assert.equal(f.spawnVector.executable, process.execPath);
  assert.deepEqual(f.spawnVector.args, [fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/installed-worker.mjs', import.meta.url))]);
  assert.deepEqual(f.spawnVector.options.stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
  assert.equal(f.spawnVector.options.env.NODE_OPTIONS, undefined);
  assert.equal(bridgeModule.isInstalledBridge(f.bridge), true);
  assert.equal(bridgeModule.isInstalledBridge({ ...f.bridge }), false);
  assert.equal('send' in f.bridge, false);
});

test('authenticated turn enables exactly four browser verbs and returns no private bootstrap fields', async t => {
  const f = await fixture(t);
  assert.equal(f.bridge.browser, 'bfixture');
  assert.equal(f.bridge.tools()[0].inputSchema.properties.browser.const, 'bfixture');
  assert.equal(await f.begin(), true);
  assert.deepEqual(f.bridge.tools().map(tool => tool.name).sort(), ['browser_act', 'browser_fill', 'browser_open', 'browser_read']);
  assert.equal(f.bridge.tools()[0].inputSchema.properties.browser.const, 'bfixture');
  const result = await f.bridge.call(readRequest);
  assert.equal(result.observation.text, 'untrusted page');
  assert.equal(JSON.stringify(result).includes(hello.nonce), false);
  const invalid = await f.bridge.call({ name: 'Runtime.evaluate', arguments: { expression: '1' } });
  assert.equal(invalid.error.code, 'INVALID_ARGUMENT'); assert.equal(f.calls.length, 1);
});

test('bootstrap nonce, exact frame shape and one-use turn identity reject forged or replayed binding', async t => {
  const f = await fixture(t), frame = { ...f.bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn', text: 'Read' };
  for (const forged of [{ ...frame, nonce: 'b'.repeat(64) }, { ...frame, session: 'foreign' }, { ...frame, enabled: true }])
    await assert.rejects(f.bridge.bind(forged), /TRUSTED_TURN_REQUIRED/);
  assert.equal(f.frames.length, 0);
  assert.equal(await f.bridge.bind(frame), true);
  await assert.rejects(f.bridge.bind(frame), /TRUSTED_TURN_REQUIRED/);
  await f.bridge.endTurn();
  await assert.rejects(f.bridge.bind(frame), /TRUSTED_TURN_REQUIRED/);
});

test('delivered read acknowledgment uses original worker result and precedes later operations', async t => {
  const f = await fixture(t); await f.begin();
  const read = await f.bridge.call(readRequest);
  assert.equal(f.bridge.delivered({ ...read }), false);
  assert.equal(f.bridge.delivered(read), false); // The synchronous return never invents confirmed delivery.
  assert.equal(f.bridge.delivered(read), false);
  const next = await f.bridge.call({ name: 'browser_act', arguments: { tab: 'tfixture', op: 'click', ref: 'rfixture' } });
  assert.equal(next.observation.delivered, true);
  assert.equal(f.frames.filter(frame => frame.method === 'delivered').length, 1);
  const mutated = await f.bridge.call(readRequest); mutated.observation.text = 'tampered';
  f.bridge.delivered(mutated); await tick();
  assert.equal(f.frames.filter(frame => frame.method === 'delivered').length, 1);
});

test('endTurn fences a held response before cleanup completes and permits a distinct next turn', async t => {
  const f = await fixture(t, { held: true }); await f.begin();
  const pending = f.bridge.call(readRequest); await tick();
  const ending = f.bridge.endTurn();
  assert.equal((await f.bridge.call(readRequest)).error.code, 'LEASE_LOST');
  f.release();
  const stale = await pending;
  assert.equal(stale.error.code, 'LEASE_LOST');
  assert.equal(stale.error.completed, 1);
  assert.equal(stale.observation, undefined);
  assert.deepEqual(await ending, { revoked: true, cleanup: [] });
  assert.equal(await f.begin('next'), true);
});

test('accepted-byte changes fence new calls before worker dispatch', async t => {
  const f = await fixture(t); await f.begin(); f.invalidate();
  assert.equal((await f.bridge.call(readRequest)).error.code, 'VERSION_MISMATCH');
  assert.equal(f.calls.length, 0);
});

test('full close preserves exact retained cleanup and keeps worker ownership for later cleanup', async t => {
  const f = await fixture(t, { closeReceipt: retained }); await f.begin();
  assert.deepEqual(await f.bridge.close(), retained);
  assert.equal(f.alive(), true);
  assert.equal((await f.bridge.call(readRequest)).error.code, 'LEASE_LOST');
});

test('worker rejects unknown private RPC methods instead of forwarding generic code', async t => {
  const f = await fixture(t); await f.begin(); const replies = [];
  f.write.on('data', chunk => replies.push(JSON.parse(chunk)));
  f.read.write(JSON.stringify({ ...hello, id: 'forged', method: 'evaluate', params: { expression: '1' } }) + '\n');
  await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(replies.some(reply => reply.id === 'forged' && reply.error === 'INVALID_WORKER_REQUEST'), true);
});

test('pipe loss revokes pending requests and never claims target cleanup from child exit', async t => {
  const f = await fixture(t); await f.begin(); f.write.end(); await tick();
  assert.equal((await f.bridge.call(readRequest)).error.code, 'LEASE_LOST');
  const receipt = await f.bridge.close();
  assert.equal(receipt.revoked, false);
  assert.ok(receipt.cleanup.some(row => row.code === 'CLEANUP_UNPROVED' && row.status === 'retained'));
});

test('client detach fences its authority while the approved worker remains idle', async t => {
  const f = await fixture(t); await f.begin();
  assert.deepEqual(await f.bridge.detach(), { revoked: true, cleanup: [] });
  assert.equal(f.alive(), true);
  assert.equal((await f.bridge.call(readRequest)).error.code, 'LEASE_LOST');
});

test('forged exact-result hash cannot mark an undelivered read as observed', async t => {
  const f = await fixture(t); await f.begin(); await f.bridge.call(readRequest);
  const resultId = f.frames.find(frame => frame.method === 'call').id;
  f.read.write(JSON.stringify({ ...hello, id: 'forged-hash', method: 'delivered', params: { resultId, hash: 'b'.repeat(64) } }) + '\n');
  await tick();
  assert.equal(f.originals.size, 1);
});

test('failed startup releases parent pipe handles without claiming browser cleanup', async () => {
  const read = new PassThrough(), write = new PassThrough(), child = new EventEmitter();
  child.stdio = [null, null, null, read, write];
  await assert.rejects(bridgeModule.createInstalledBridge({ startupTimeoutMs: 10 }, {
    readConfig: () => ({ enabled: true }), acceptPackage: () => ({ current: () => true }), spawnWorker: () => child,
  }), /INSTALLED_WORKER_UNAVAILABLE/);
  assert.equal(read.writableEnded, true);
  assert.equal(write.destroyed, true);
});

test('unavailable native helpers preserve the actionable fallback reason', async () => {
  const read = new PassThrough(), write = new PassThrough(), child = new EventEmitter();
  child.stdio = [null, null, null, read, write];
  await assert.rejects(bridgeModule.createInstalledBridge({}, {
    readConfig: () => ({ enabled: true }), acceptPackage: () => ({ current: () => true }),
    spawnWorker() {
      queueMicrotask(() => write.write(JSON.stringify({ version: 1, status: 'unavailable', code: 'NATIVE_HELPERS_UNAVAILABLE' }) + '\n'));
      return child;
    },
  }), /NATIVE_HELPERS_UNAVAILABLE/);
});

test('unaccepted package bytes fail before launching any worker', async () => {
  await assert.rejects(bridgeModule.createInstalledBridge({}, {
    readConfig: () => ({ enabled: true }), acceptPackage: () => ({ current: () => false }),
    spawnWorker() { assert.fail('unaccepted installed bytes executed'); },
  }), /HOST_PACKAGE_MISMATCH/);
});

test('proved full shutdown reports cleanup before releasing its worker', async t => {
  const f = await fixture(t); await f.begin();
  assert.deepEqual(await f.bridge.close(), { revoked: true, cleanup: [] });
  assert.equal(f.alive(), false);
});

for (const mode of ['retained', 'proved', 'forged']) test('native Disconnect releases worker only with authenticated cleanup proof: ' + mode, async () => {
  assert.equal(typeof workerModule.createInstalledControlUi, 'function', 'installed native cleanup join missing');
  const cards = [], authentic = { action: 'disconnect' }; let closed = 0, attempts = 0;
  const ui = { present(id, data, choices, deliver) { cards.push({ id, data, choices, deliver }); }, authenticate: event => event === authentic };
  const runtime = { endTurn() {}, async close() { attempts++; return mode === 'retained' ? retained : { revoked: true, cleanup: [] }; } };
  const wrapped = workerModule.createInstalledControlUi({ ui, runtime, onReleased() { closed++; } });
  const broker = { status: () => ({ state: 'disconnected', clients: 0, cleanup: {} }), loseConnection: async () => true };
  const controls = createBrokerControls({ broker, ui: wrapped, revokeSessions() {} });
  controls.status({ state: 'connected', clients: 0, cleanup: {} });
  await cards[0].deliver(mode === 'forged' ? { action: 'disconnect' } : authentic);
  assert.equal(attempts, mode === 'forged' ? 0 : 1);
  assert.equal(closed, mode === 'proved' ? 1 : 0);
});

for (const loss of ['EOF', 'error']) test('parent ' + loss + ' during held initialization prevents a late native UI or worker-ready launch', async () => {
  assert.equal(typeof workerModule.createInstalledParentLifetime, 'function', 'early parent pipe observer missing');
  const read = new PassThrough(), write = new PassThrough(), frames = []; let resolveBuild, nativeLaunches = 0;
  write.on('data', chunk => frames.push(String(chunk)));
  const lifetime = workerModule.createInstalledParentLifetime({ read, write });
  const build = new Promise(resolve => { resolveBuild = resolve; });
  const initializing = (async () => {
    await build; lifetime.assertCurrent(); nativeLaunches++;
    lifetime.handoff(() => write.write('worker-ready\n'));
  })();
  if (loss === 'EOF') read.end(); else read.emit('error', Error('owned fixture pipe failure'));
  await tick(); resolveBuild();
  await assert.rejects(initializing, /PARENT_GONE/);
  assert.equal(nativeLaunches, 0); assert.deepEqual(frames, []);
  read.destroy(); write.destroy();
});

for (const status of ['proved', 'retained']) test('preapproval parent EOF collects partial runtime and releases only proved resources: ' + status, async () => {
  const read = new PassThrough(), write = new PassThrough(), controlRead = new PassThrough();
  let closes = 0, releases = 0, detaches = 0;
  const receipt = status === 'proved' ? { revoked: true, cleanup: [] } : retained;
  const runtime = { current: () => undefined, enabled: () => false, endTurn: () => ({ revoked: true, cleanup: [] }),
    async close() { closes++; return receipt; } };
  const server = workerModule.serveInstalledWorker({ read, write, runtime, control: { read: controlRead }, hello,
    browser: 'bfixture', onClose() { releases++; }, onDetach() { detaches++; } });
  read.end(); await tick();
  assert.equal(closes, 1, 'unapproved partial startup was retained as an idle approved host');
  assert.deepEqual(await server.settled(), receipt);
  assert.equal(releases, status === 'proved' ? 1 : 0);
  assert.equal(detaches, status === 'retained' ? 1 : 0);
  write.destroy(); controlRead.destroy();
});

test('already lost startup pipe cannot emit a late worker ready envelope', async () => {
  const read = new PassThrough(), write = new PassThrough(), controlRead = new PassThrough(), frames = [];
  read.resume(); read.end(); await tick(); write.on('data', chunk => frames.push(String(chunk)));
  let closed = 0;
  const runtime = { current: () => undefined, enabled: () => false, endTurn() {},
    async close() { closed++; return { revoked: true, cleanup: [] }; } };
  const server = workerModule.serveInstalledWorker({ read, write, runtime, control: { read: controlRead }, hello, browser: 'bfixture' });
  await tick();
  assert.deepEqual(frames, []); assert.equal(closed, 1);
  assert.deepEqual(await server.settled(), { revoked: true, cleanup: [] });
  write.destroy(); controlRead.destroy();
});

test('native-helper startup failure emits its typed unavailable code before actual parent-pipe EOF', async () => {
  assert.equal(typeof workerModule.completeInstalledStartupFailure, 'function', 'typed startup failure completion missing');
  const read = new PassThrough(), write = new PassThrough(), events = [];
  const parent = workerModule.createInstalledParentLifetime({ read, write });
  write.on('data', chunk => events.push(JSON.parse(chunk)));
  write.on('end', () => events.push('EOF'));
  let nativeReleased = false;
  workerModule.completeInstalledStartupFailure({ parent, read, write, receipt: { revoked: true, cleanup: [] },
    error: Error('NATIVE_HELPERS_UNAVAILABLE'),
    releaseNativeResources() { nativeReleased = true; assert.equal(write.writableEnded, false); assert.equal(read.destroyed, false); },
    retainNativeResources() { assert.fail('proved empty startup retained ownership'); } });
  await tick();
  assert.equal(nativeReleased, true);
  assert.deepEqual(events, [{ version: 1, status: 'unavailable', code: 'NATIVE_HELPERS_UNAVAILABLE' }, 'EOF']);
});
