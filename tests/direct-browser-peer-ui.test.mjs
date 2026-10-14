import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, createConnection } from 'node:net';
import { mkdtempSync, realpathSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { createUiChannel, createNativePeerProvider, startBrokerHost } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { listenIPC, connectIPC } from '../plugins/sleight/lib/direct-browser/ipc.mjs';

function channel() {
  const read = new PassThrough(), write = new PassThrough(), outbound = [], delivered = [];
  let losses = 0;
  write.on('data', bytes => outbound.push(JSON.parse(bytes)));
  const ui = createUiChannel({ read, write, onLoss: () => losses++ });
  const present = id => ui.present(id, { operation: { secret: 'private fixture' } }, ['once', 'cancel'], event => delivered.push(event));
  const respond = (id, extra = {}) => read.write(JSON.stringify({ id, choice: 'once', nonce: outbound.at(-1).nonce, ...extra }) + '\n');
  return { ui, read, write, outbound, delivered, present, respond, losses: () => losses };
}
test('UI authentication is an unforgeable one-use object from a private channel', () => {
  const f = channel(); f.present('s1-op1');
  assert.equal(f.ui.authenticate({ id: 's1-op1', approved: true }), false);
  f.respond('s1-op1'); const event = f.delivered[0];
  assert.equal(f.ui.authenticate({ ...event }), false);
  assert.equal(f.ui.authenticate(event), true); assert.equal(f.ui.authenticate(event), false);
  assert.doesNotMatch(JSON.stringify(event), /private fixture|nonce/); f.ui.close();
});
for (const [label, extra] of Object.entries({ nonce: { nonce: 'b'.repeat(64) }, choice: { choice: 'always' }, session: { id: 's2-op1' }, extra: { approved: true } }))
  test('forged UI response refuses ' + label, () => {
    const f = channel(); f.present('s1-op1'); f.respond('s1-op1', extra);
    assert.equal(f.delivered.length, 0); assert.equal(f.losses(), 1); f.ui.close();
  });
test('revoked and replayed UI responses never grant another operation', () => {
  for (const revoke of [false, true]) {
    const f = channel(); f.present('op1');
    if (revoke) f.ui.revoke();
    f.respond('op1'); f.respond('op1');
    assert.equal(f.delivered.length, revoke ? 0 : 1);
    assert.equal(f.losses(), 1); f.ui.close();
  }
});
test('UI expiry and malformed frames fail closed without reflecting private errors', () => {
  const f = channel();
  assert.throws(() => f.ui.present('bad', {}, ['once'], () => {}, { deadline: 0 }), /TRUSTED_UI_UNAVAILABLE/);
  f.present('op'); f.read.write('{invalid private fixture\n');
  assert.equal(f.delivered.length, 0); assert.equal(f.losses(), 1); f.ui.close();
});
test('unaccepted distribution never starts native host, socket or user UI', async () => {
  assert.throws(() => createNativePeerProvider({ accepted: false }), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
  await assert.rejects(startBrokerHost({ inventory: {}, directory: '/missing', contract: {} }), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
});
test('JSON incarnation cannot override OS peer identity, and singleton never takes over', async t => {
  const directory = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'bp2-host-ipc-')))));
  chmodSync(directory, 0o700);
  const uid = process.getuid?.() ?? 1000, secret = 'a'.repeat(64); let attached = 0;
  const broker = { attach(identity) { attached++; assert.equal(identity.incarnation, 'p100-v200'); return { disconnect() {}, request: async () => ({ effect: 'none' }) }; } };
  const options = { directory, uid, secret, broker,
    peerIdentity: async () => ({ uid, pid: 100, incarnation: 'p100-v200' }) };
  const listener = await listenIPC(options); t.after(() => listener.close());
  await assert.rejects(listenIPC(options), /IPC_SINGLETON/);
  await assert.rejects(connectIPC({ path: listener.path, hello: { version: 1, uid, secret, session: 's1', incarnation: 'p999-1-0' } }), /IPC_CLOSED/);
  assert.equal(attached, 0);
  const good = await connectIPC({ path: listener.path, hello: { version: 1, uid, secret, session: 's1', incarnation: 'self' } });
  assert.equal(attached, 1); good.close();
});
const native = process.platform === 'darwin' && existsSync('/usr/bin/xcrun');
test('Darwin native peer source compiles and reads inherited UDS peer UID/PID/incarnation', { skip: !native && 'Darwin compiler and peer APIs unavailable' }, async t => {
  const directory = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'bp2-peer-native-')))));
  const binary = join(directory, 'peer-host');
  const source = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/peer-host.c', import.meta.url));
  const built = spawnSync('/usr/bin/xcrun', ['clang', '-Wall', '-Werror', source, '-lbsm', '-o', binary], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const server = createServer(); server.listen(join(directory, 'fixture.sock')); await once(server, 'listening');
  const accepted = once(server, 'connection'), client = createConnection(join(directory, 'fixture.sock'));
  const [socket] = await accepted;
  t.after(() => { socket.destroy(); client.destroy(); return new Promise(resolve => server.close(resolve)); });
  const child = spawn(binary, ['--peer-fd', '3'], { stdio: ['ignore', 'pipe', 'pipe', socket] });
  let output = '', errors = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => errors += bytes);
  const [code] = await once(child, 'close'); assert.equal(code, 0, errors);
  const peer = JSON.parse(output); assert.equal(peer.uid, process.getuid()); assert.equal(peer.pid, process.pid);
  assert.match(peer.incarnation, new RegExp('^p' + process.pid + '-v\\d+$'));
});
test('Darwin consent helper compiles without launching UI or acquiring permissions', { skip: !native && 'Darwin AppKit compiler unavailable' }, t => {
  const directory = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'bp2-ui-native-')))));
  const source = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url));
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'cache'), source, '-o', join(directory, 'consent-host')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  assert.doesNotMatch(readFileSync(source, 'utf8'), /AXUIElement|CGEvent|activate\(ignoringOtherApps|performClick/);
});
