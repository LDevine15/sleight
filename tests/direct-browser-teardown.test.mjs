// Regression tests for BP2-P1R2's review findings (claims/V-BP2-P1R2): host teardown must not delete a replacement socket,
// and an authenticated Cleanup must settle without a rejected UI callback. Skips by name off Darwin (Unix-socket peer tests).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, renameSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
const lib = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
// A short base: Unix socket paths are limited to about 104 bytes.
const bank = realpathSync(mkdtempSync('/tmp/dbt-'));
after(() => rmSync(bank, { recursive: true, force: true }));
const { listenIPC } = await import(new URL('ipc.mjs', lib));

test('IPC close preserves a replacement socket and reports changed ownership', async t => {
  const uid = process.getuid(), secret = 'a'.repeat(64);
  const directory = join(bank, 'first'), otherDirectory = join(bank, 'other');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(directory, { mode: 0o700 }); mkdirSync(otherDirectory, { mode: 0o700 });
  const options = { uid, secret, broker: {}, peerIdentity: async () => ({ uid, pid: 100, incarnation: 'p100-v1' }) };
  const first = await listenIPC({ ...options, directory });
  const other = await listenIPC({ ...options, directory: otherDirectory });
  t.after(async () => { await first.close().catch(() => {}); await other.close().catch(() => {}); });
  const socket = join(directory, 'broker.sock'), otherSocket = join(otherDirectory, 'broker.sock');
  renameSync(socket, join(directory, 'owned.sock'));
  renameSync(otherSocket, socket);
  const replacementInode = lstatSync(socket).ino;
  let failure;
  try { await first.close(); } catch (error) { failure = error.message; }
  const retained = existsSync(socket);
  console.log(JSON.stringify({ failure: failure ?? null, replacementRetained: retained,
    sameReplacement: retained && lstatSync(socket).ino === replacementInode,
    singletonRetained: existsSync(join(directory, 'broker.lock')) }));
  assert.equal(retained, true, 'closing the old listener must preserve the replacement socket');
  assert.equal(failure, 'IPC_RESOURCE_CHANGED');
});

const { createBroker } = await import(new URL('broker.mjs', lib));
const { createAuthority, createTransportAuthority } = await import(new URL('authority.mjs', lib));
const { createHostLifecycle, createBrokerControls, createUiChannel } = await import(new URL('host.mjs', lib));
test('authenticated Cleanup settles without presenting controls after host teardown', async () => {
  let controls, host, broker, proven = false, uiClosed = false, response, callbackResult;
  const user = {}, authority = createAuthority({ current: () => ({}), snapshot: () => ({}),
    authenticate: e => e === user, classify: x => x });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation() { throw Error('unused'); } });
  const socket = new Proxy({ sessionId: 'fixture', send() { throw Error('no input expected'); }, on() {}, off() {} },
    { get(o, k) { if (k in o || typeof k === 'symbol' || k === 'then') return o[k]; throw Error('unsupported member'); } });
  const read = new PassThrough(), write = new PassThrough();
  write.on('data', bytes => { response = JSON.parse(bytes); });
  const channel = createUiChannel({ read, write });
  const ui = { present(id, data, choices, deliver, options) {
    channel.present(id, data, choices, event => {
      callbackResult = deliver(event);
      // Observe the otherwise ignored rejection without crashing the review runner.
      callbackResult.catch(() => {});
    }, options);
  }, authenticate: channel.authenticate, close() { uiClosed = true; channel.close(); } };
  const status = value => {
    try { controls?.status(value); } catch { controls = undefined; broker?.loseConnection(); }
    if (value.stopping && !value.cleanup?.pending && !value.cleanup?.connecting)
      Promise.resolve().then(() => host?.reconcile());
  };
  broker = createBroker({ uid: process.getuid(), secret: 'a'.repeat(64), idlePolicy: 'retain', browserIncarnation: 'fixture',
    connect: async () => socket, verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: x => x,
    prepare() { throw Error('unused'); }, authorize: () => false, dispatchFence: () => false, transportAuthority,
    endSession: () => true, dispatch() { throw Error('unused'); }, redact: x => x,
    disconnect: () => proven, onStatus: status, timeoutMs: 10 });
  await broker.connect({ userInitiated: true });
  controls = createBrokerControls({ broker, ui, revokeSessions() {} });
  host = createHostLifecycle({ broker, ui, listener: { async close() {} }, revokeSessions() {} });
  assert.equal((await host.close()).closed, false);
  proven = true;
  let failure;
  read.write(JSON.stringify({ id: response.id, nonce: response.nonce, choice: 'cleanup' }) + '\n');
  try { await callbackResult; } catch (error) { failure = error.message; }
  await new Promise(resolve => setImmediate(resolve));
  console.log(JSON.stringify({ cleanupCallbackError: failure ?? null, uiClosed, pending: broker.status().cleanup.pending }));
  assert.equal(uiClosed, true);
  assert.equal(failure, undefined, 'a private UI response must not reject after successful cleanup');
});
