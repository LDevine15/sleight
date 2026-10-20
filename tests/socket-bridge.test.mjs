import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, mkdirSync, openSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as tick } from 'node:timers/promises';
import { createConnection, Server } from 'node:net';
import { callSocket, createShellRelay, preparePeerCheck, printSocketResult, socketCommand, startSocketSession } from '../plugins/sleight/lib/socket-bridge.mjs';

function fixture(t) {
  const root = mkdtempSync(join('/private/tmp', 'sleight-socket-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [], signals = new EventEmitter();
  let collected = 0;
  return { root, directory: join(root, 'session'), calls, signals, get collected() { return collected; },
    startRelay: async () => ({ call: async (tool, args) => { calls.push({ tool, args }); return { content: [{ type: 'text', text: 'answer' }] }; },
      close: async () => { collected++; } }), peerUid: async () => process.getuid() };
}

test('socket and folder are private and one relay serves consecutive calls', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal(lstatSync(f.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(session.socketPath).mode & 0o777, 0o600);
  for (const code of ['nodeRepl.write(1)', 'nodeRepl.write(2)']) {
    assert.equal((await callSocket({ tool: 'js', args: { code } }, f)).content[0].text, 'answer');
  }
  assert.equal(f.calls.length, 2);
  await session.close();
  assert.equal(f.collected, 1);
  assert.equal(existsSync(session.socketPath), false);
});

test('another uid and unavailable peer credentials are refused before dispatch', async t => {
  for (const peerUid of [async () => process.getuid() + 1, async () => { throw new Error('unavailable'); }]) {
    const f = fixture(t), session = await startSocketSession({ ...f, peerUid });
    t.after(() => session.close());
    await assert.rejects(callSocket({ tool: 'js', args: { code: '1' } }, f), /peer|closed/i);
    assert.equal(f.calls.length, 0);
  }
});

test('the native peer check authenticates an actual Unix connection', async t => {
  const f = fixture(t);
  delete f.peerUid;
  const session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal((await callSocket({ tool: 'js_reset', args: {} }, f)).content[0].text, 'answer');
});

test('missing Apple tools fail before a compiler can open an installation dialog', async () => {
  await assert.rejects(preparePeerCheck({ tools: async () => false }), /needs Xcode Command Line Tools/);
});

test('folder ownership is checked against the operating system uid', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  await session.close();
  const uid = process.getuid();
  t.mock.method(process, 'getuid', () => uid + 1);
  await assert.rejects(startSocketSession(f), /owned/);
});

test('unsafe folders and occupied socket paths are refused without removal', async t => {
  const f = fixture(t);
  symlinkSync(f.root, f.directory);
  await assert.rejects(startSocketSession(f), /owned|private/);
  rmSync(f.directory);
  const session = await startSocketSession(f);
  t.after(() => session.close());
  await assert.rejects(startSocketSession(f), /exists|occupied/);
  await session.close();
  chmodSync(f.directory, 0o777);
  await assert.rejects(startSocketSession(f), /private/);
  chmodSync(f.directory, 0o700);
  writeFileSync(session.socketPath, 'do not delete');
  await assert.rejects(startSocketSession(f), /owned|socket|occupied/);
  assert.equal(readFileSync(session.socketPath, 'utf8'), 'do not delete');
});

test('idle exit collects the engine and removes only the owned socket', async t => {
  const f = fixture(t), session = await startSocketSession({ ...f, idleMs: 30 });
  await session.closed;
  assert.equal(f.collected, 1);
  assert.equal(existsSync(session.socketPath), false);
});

test('SIGTERM waits for engine collection and is idempotent', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  f.signals.emit('SIGTERM');
  await session.closed;
  await session.close();
  assert.equal(f.collected, 1);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('SIGTERM during relay startup still collects the relay before returning', async t => {
  const f = fixture(t);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const starting = startSocketSession({ ...f, startRelay: async () => { started(); await gate; return f.startRelay(); } });
  await ready;
  f.signals.emit('SIGTERM'); release();
  await assert.rejects(starting, /stopped during startup/);
  assert.equal(f.collected, 1);
});

test('SIGTERM while binding the socket closes it without starting an engine', async t => {
  const f = fixture(t);
  let starts = 0;
  const starting = startSocketSession({ ...f, startRelay: async () => { starts++; return f.startRelay(); } });
  f.signals.emit('SIGTERM');
  await assert.rejects(starting, /stopped during startup/);
  assert.equal(starts, 0);
  assert.equal(existsSync(join(f.directory, 'session.sock')), false);
});

test('an active call does not expire as idle', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const relay = await f.startRelay();
  const session = await startSocketSession({ ...f, idleMs: 40, startRelay: async () => ({ ...relay, call: async () => gate }) });
  t.after(() => session.close());
  const result = callSocket({ tool: 'js', args: { code: '1' } }, f);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(f.collected, 0);
  release({ content: [{ type: 'text', text: 'done' }] });
  assert.equal((await result).content[0].text, 'done');
  await session.closed;
  assert.equal(f.collected, 1);
});

test('shell calls cannot inject turn binding, approvals or arbitrary RPC', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  for (const request of [
    { tool: 'turn_ended', args: { sleight_turbo: {} } },
    { tool: 'js', args: { code: '1' }, _meta: { userPrompt: 'pay' } },
    { id: 'card', result: { action: 'accept' } },
  ]) await assert.rejects(callSocket(request, f), /request|tool/);
  assert.equal(f.calls.length, 0);
});

test('raw socket requests are validated even when the shell client is bypassed', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  for (const request of ['{"tool":"turn_ended","args":{}}\n', '{"id":"card","result":{"action":"accept"}}\n',
    '{"tool":"js","args":{"code":"1"},"_meta":{"prompt":"pay"}}\n']) {
    const reply = await new Promise((resolve, reject) => {
      const socket = createConnection(session.socketPath);
      let output = '';
      socket.once('connect', () => socket.write(request));
      socket.on('data', data => { output += data; });
      socket.once('end', () => resolve(JSON.parse(output)));
      socket.once('error', reject);
    });
    assert.match(reply.error, /request|tool/);
  }
  assert.equal(f.calls.length, 0);
});

test('local subcommand help exposes the MCP argument schemas without a session', async () => {
  for (const tool of ['open_file', 'select_window', 'drag']) {
    let output = '';
    assert.equal(await socketCommand([tool, '--help'], { out: text => { output += text; } }), 0);
    const definition = JSON.parse(output);
    assert.equal(definition.name, tool);
    assert.equal(definition.inputSchema.type, 'object');
  }
});

test('images become private cache files and error results return failure status', async t => {
  const f = fixture(t);
  let output = '';
  const code = await printSocketResult({ isError: true, content: [
    { type: 'text', text: 'stopped' }, { type: 'image', mimeType: 'image/png', data: Buffer.from('image').toString('base64') },
  ] }, { directory: f.root, out: text => { output += text; } });
  const path = output.trim().split('\n')[1];
  assert.equal(code, 1);
  assert.equal(output.split('\n')[0], 'stopped');
  assert.equal(readFileSync(path, 'utf8'), 'image');
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.doesNotMatch(output, /aW1hZ2U=/);
});

function rawRequest(path, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let output = '';
    socket.on('error', err => { if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') reject(err); });
    socket.on('data', data => { output += data; });
    socket.once('connect', () => socket.end(request));
    socket.once('close', () => resolve(output));
  });
}

test('the native peer helper refuses a regular file at fd 3 without output', async t => {
  const f = fixture(t), binary = join(f.root, 'peer');
  const built = spawnSync('/usr/bin/clang', ['-Wall', '-Werror',
    fileURLToPath(new URL('../plugins/sleight/lib/socket-peer.c', import.meta.url)), '-o', binary],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
  assert.equal(built.status, 0, built.stderr);
  const path = join(f.root, 'not-a-socket');
  writeFileSync(path, '');
  const fd = openSync(path, 'r');
  t.after(() => closeSync(fd));
  const result = spawnSync(binary, [], { encoding: 'utf8', env: {}, stdio: ['ignore', 'pipe', 'pipe', fd] });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
});

test('peer compilation ignores inherited compiler search paths', async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'sys'));
  writeFileSync(join(f.root, 'sys/socket.h'), '#error inherited CPATH reached the compiler\n');
  const previous = process.env.CPATH;
  process.env.CPATH = f.root;
  t.after(() => { if (previous === undefined) delete process.env.CPATH; else process.env.CPATH = previous; });
  const peer = await preparePeerCheck();
  peer.close();
});

test('the ninth live peer is refused before peer authentication', async t => {
  const f = fixture(t), sockets = [];
  let checks = 0;
  const session = await startSocketSession({ ...f, peerUid: async () => { checks++; return process.getuid(); } });
  t.after(async () => { sockets.forEach(socket => socket.destroy()); await session.close(); });
  for (let i = 0; i < 8; i++) {
    const socket = createConnection(session.socketPath); sockets.push(socket);
    await new Promise(resolve => socket.once('connect', resolve));
  }
  await tick(20);
  assert.equal(checks, 8);
  assert.equal(await rawRequest(session.socketPath, '{'), '');
  assert.equal(checks, 8);
});

test('an absolute request deadline closes a peer that keeps dripping partial JSON', async t => {
  const f = fixture(t), session = await startSocketSession({ ...f, requestTimeoutMs: 60 });
  t.after(() => session.close());
  const socket = createConnection(session.socketPath);
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  const interval = setInterval(() => socket.write(' '), 10);
  const closed = new Promise(resolve => socket.once('close', resolve));
  try { await Promise.race([closed, tick(400).then(() => { throw new Error('dripping peer outlived deadline'); })]); }
  finally { clearInterval(interval); socket.destroy(); }
  assert.equal(f.calls.length, 0);
});

test('oversize frames and a trailing second request never dispatch', async t => {
  const f = fixture(t), session = await startSocketSession(f);
  t.after(() => session.close());
  assert.equal(await rawRequest(session.socketPath, 'x'.repeat(1024 * 1024 + 1)), '');
  const reply = await rawRequest(session.socketPath, '{"tool":"js_reset","args":{}}\n{"tool":"js_reset","args":{}}\n');
  assert.match(JSON.parse(reply).error, /One shell request/);
  assert.equal(f.calls.length, 0);
});

test('a concurrent call is refused until the active engine reply', async t => {
  const f = fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const session = await startSocketSession({ ...f, startRelay: async () => ({
    call: () => { entered(); return gate; }, close: async () => {},
  }) });
  t.after(() => session.close());
  const first = callSocket({ tool: 'js', args: { code: '1' } }, f);
  await started;
  await assert.rejects(callSocket({ tool: 'js_reset', args: {} }, f), /busy/);
  release({ content: [] }); await first;
});

test('a timed-out relay call stays busy until its late engine reply', async t => {
  const f = fixture(t);
  const session = await startSocketSession({ ...f, idleMs: 60, startRelay: options => createShellRelay({ ...options,
    args: [fileURLToPath(new URL('fixtures/socket-stall.mjs', import.meta.url))], timeoutMs: 80,
  }) });
  t.after(() => session.close());
  await assert.rejects(callSocket({ tool: 'js', args: { code: '1', delay: 300 } }, f), /timed out/);
  await assert.rejects(callSocket({ tool: 'js_reset', args: {} }, f), /busy/);
  await tick(90);
  assert.equal(existsSync(session.socketPath), true);
  await assert.rejects(callSocket({ tool: 'js_reset', args: {} }, f), /busy/);
  await tick(150);
  assert.equal((await callSocket({ tool: 'js_reset', args: {} }, f)).content[0].text, 'done');
});

test('shutdown escalates a relay that ignores EOF and SIGTERM', async () => {
  const relay = await createShellRelay({ args: [fileURLToPath(new URL('fixtures/socket-stall.mjs', import.meta.url)), 'stubborn'],
    termMs: 30, killMs: 30 });
  assert.equal((await relay.close()).signal, 'SIGKILL');
});

test('a signal cancels initialization and stays handled through relay collection', async t => {
  const f = fixture(t);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const starting = startSocketSession({ ...f, startRelay: options => {
    entered();
    return createShellRelay({ ...options, args: [fileURLToPath(new URL('fixtures/socket-stall.mjs', import.meta.url)), 'no-init'], timeoutMs: 5000 });
  } });
  await started;
  const stoppedAt = Date.now();
  f.signals.emit('SIGTERM');
  assert.equal(f.signals.listenerCount('SIGTERM'), 1);
  f.signals.emit('SIGTERM');
  await assert.rejects(starting, /closed|exited|stopped|abort/i);
  assert.ok(Date.now() - stoppedAt < 1000, 'shutdown waited for the initialization timeout');
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('image output refuses a directory with broader permissions', async t => {
  const f = fixture(t);
  chmodSync(f.root, 0o755);
  await assert.rejects(printSocketResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'aQ==' }] },
    { directory: f.root, out() {} }), /private/);
});

test('a missing session names the session command', async t => {
  const f = fixture(t);
  await assert.rejects(callSocket({ tool: 'js_reset', args: {} }, f), err => err.code === 'ENOENT' && /sleight-mcp session/.test(err.message));
});

test('long socket paths fail with the macOS limit before binding', async t => {
  const f = fixture(t);
  await assert.rejects(startSocketSession({ ...f, directory: join(f.root, 'x'.repeat(104)) }), /104.*bytes|103.*bytes/);
  assert.equal(f.collected, 0);
});

test('post-listen ownership failure removes the socket bound by this startup', async t => {
  const f = fixture(t), listen = Server.prototype.listen, uid = process.getuid();
  t.mock.method(Server.prototype, 'listen', function(path, callback) {
    return listen.call(this, path, () => {
      t.mock.method(process, 'getuid', () => uid + 1);
      callback();
    });
  });
  await assert.rejects(startSocketSession(f), /owned/);
  assert.equal(existsSync(join(f.directory, 'session.sock')), false);
});
