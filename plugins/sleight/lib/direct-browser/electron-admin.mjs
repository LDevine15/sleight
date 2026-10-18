// The trusted parent's client for a resident Electron host's admin channel (electron-host.mjs). The admin key is the
// parent's per-start secret: ensureHost makes it, hands it to the host on an inherited descriptor and returns it, and
// nothing writes it to disk. A process without it (the model's shell included) cannot administer the host, and a
// parent that lost it cannot either: such a host is ELECTRON_HOST_FOREIGN until it exits.
import net from 'node:net';
import { spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_VERSION, DEFAULT_MAX_FRAME_BYTES, FrameReader, HANDSHAKE_MAX_BYTES, bare, deriveChannel, macEqual, opener, plainJson, randomToken,
  sealer, validToken } from './electron-channel.mjs';

const fail = code => { throw Error(code); };
const HOST_RUN = fileURLToPath(new URL('./electron-host-run.mjs', import.meta.url));

/** Opens the admin channel. Resolves to { hostId, status, start, issue, revoke, revokeAll, resume, reconcile, quit, collect, close }. */
export async function connectAdmin({ stateDir, secret, hostId, socketPath = join(String(stateDir), 'host.sock'), connect = path => net.connect(path),
  timeoutMs = 10000 } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) fail('ADMIN_SECRET_INVALID');
  if (hostId !== undefined && !validToken(hostId)) fail('ELECTRON_HOST_MISMATCH');
  const socket = connect(socketPath), reader = new FrameReader(HANDSHAKE_MAX_BYTES), pending = new Map();
  let stage = 'hello', derived, clientNonce, send, receive, host, closed = false, sequence = 0;
  const shut = code => {
    if (closed) return; closed = true;
    for (const entry of pending.values()) entry.reject(Error(code));
    pending.clear(); socket.destroy();
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(Error('ELECTRON_HOST_TIMEOUT')); shut('ELECTRON_HOST_CLOSED'); }, timeoutMs);
    const finish = error => { clearTimeout(timer); if (error) reject(error); else resolve(); };
    socket.on('error', () => { finish(Error(stage === 'hello' ? 'ELECTRON_HOST_UNREACHABLE' : 'ADMIN_AUTH_FAILED')); shut('ELECTRON_HOST_CLOSED'); });
    socket.on('close', () => { finish(Error(stage === 'hello' ? 'ELECTRON_HOST_UNREACHABLE' : 'ADMIN_AUTH_FAILED')); shut('ELECTRON_HOST_CLOSED'); });
    socket.on('data', chunk => {
      try {
        for (const frame of reader.push(chunk)) {
          if (stage === 'hello') {
            const hello = plainJson(frame);
            if (Object.keys(hello).sort().join() !== 'host,nonce,t,v' || hello.t !== 'hello' || hello.v !== CHANNEL_VERSION || !validToken(hello.host) ||
                !validToken(hello.nonce) || hostId !== undefined && hello.host !== hostId) fail('ELECTRON_HOST_MISMATCH');
            host = hello.host; clientNonce = randomToken();
            derived = deriveChannel(secret, { host, hostNonce: hello.nonce, clientNonce, ticket: 'admin', role: 'admin' });
            socket.write(bare({ t: 'auth', ticket: 'admin', role: 'admin', cn: clientNonce, proof: derived.clientProof }));
            stage = 'ready';
          } else if (stage === 'ready') {
            const ready = plainJson(frame);
            if (Object.keys(ready).sort().join() !== 'proof,t' || ready.t !== 'ready' || !macEqual(ready.proof, derived.hostProof)) fail('ELECTRON_HOST_MISMATCH');
            send = sealer(derived.clientKey); receive = opener(derived.hostKey); reader.max = DEFAULT_MAX_FRAME_BYTES; stage = 'open';
          } else if (stage === 'open') {
            const message = receive(frame);
            if (message.op !== 'open' || message.admin !== true) fail('ELECTRON_PROTOCOL');
            stage = 'live'; finish();
          } else {
            const message = receive(frame);
            const entry = message.op === 'reply' ? pending.get(message.id) : undefined;
            if (!entry) continue;
            pending.delete(message.id);
            if (message.error) entry.reject(Error(typeof message.error.code === 'string' ? message.error.code : 'FAILED'));
            else entry.resolve(message.result);
          }
        }
      } catch (error) { if (stage !== 'live') finish(error); shut('ELECTRON_PROTOCOL'); }
    });
  });
  const request = (op, args) => {
    if (closed) return Promise.reject(Error('ELECTRON_HOST_CLOSED'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { socket.write(send({ op, id, ...(args === undefined ? {} : { args }) })); } catch { shut('ELECTRON_HOST_CLOSED'); }
    });
  };
  return Object.freeze({
    hostId: host,
    status: () => request('status'),
    start: ({ build } = {}) => request('start', { build }),
    issue: ({ session } = {}) => request('issue', { session }),
    revoke: ({ session } = {}) => request('revoke', { session }),
    revokeAll: () => request('revokeAll'),
    resume: () => request('resume'),
    reconcile: ({ acceptDiskEvidence = false } = {}) => request('reconcile', { acceptDiskEvidence }),
    quit: () => request('quit'),
    collect: () => request('collect'),
    close: () => { try { socket.end(); } catch { /* closed */ } closed = true; },
  });
}

const alive = (socketPath, connect) => new Promise(resolve => {
  const probe = connect(socketPath);
  probe.once('connect', () => { probe.destroy(); resolve(true); });
  probe.once('error', () => resolve(false));
});

/** Connects to the host for stateDir with the secret this parent holds, or spawns `node electron-host-run.mjs ...` detached
 * and waits for its ready line (timeoutMs, 10 s). Resolves the admin client (connectAdmin's methods) plus secret, spawned and
 * pid, so the caller can keep the secret for its next connection. A running host this
 * parent holds no secret for is ELECTRON_HOST_FOREIGN; it exits on its own once its app is gone (exit rule). */
export async function ensureHost({ stateDir, registryPath, tempRoot, build, builds = [build], secret, python, spawn = spawnProcess,
  connect = path => net.connect(path), node = process.execPath, script = HOST_RUN, timeoutMs = 10000 } = {}) {
  const socketPath = join(stateDir, 'host.sock');
  if (secret !== undefined) {
    try { return Object.freeze({ ...await connectAdmin({ stateDir, secret, socketPath, connect }), secret, spawned: false }); }
    catch (error) { if (error.message !== 'ELECTRON_HOST_UNREACHABLE') fail('ELECTRON_HOST_FOREIGN'); }
  } else if (await alive(socketPath, connect)) fail('ELECTRON_HOST_FOREIGN');
  mkdirSync(dirname(stateDir), { recursive: true, mode: 0o700 });
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const fresh = randomBytes(32);
  const args = [script, '--state-dir', stateDir, '--registry', registryPath, '--temp-root', tempRoot, '--builds', builds.join(','), '--admin-fd', '3',
    ...(python ? ['--python', python] : [])];
  const child = spawn(node, args, { detached: true, cwd: '/', stdio: ['ignore', 'pipe', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
  child.stdio[3].on('error', () => {});
  child.stdio[3].end(fresh.toString('base64url') + '\n');
  let ready;
  try {
    ready = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(Error('ELECTRON_HOST_START_FAILED')), timeoutMs);
      child.on('exit', () => { clearTimeout(timer); reject(Error('ELECTRON_HOST_START_FAILED')); });
      child.on('error', () => { clearTimeout(timer); reject(Error('ELECTRON_HOST_START_FAILED')); });
      child.stdout.on('data', chunk => {
        text += chunk;
        if (text.length > 4096) { clearTimeout(timer); reject(Error('ELECTRON_HOST_START_FAILED')); return; }
        const line = text.split('\n')[0];
        if (!text.includes('\n')) return;
        clearTimeout(timer);
        try { const parsed = JSON.parse(line); if (parsed.ready === true && validToken(parsed.hostId)) resolve(parsed); else reject(Error('ELECTRON_HOST_START_FAILED')); }
        catch { reject(Error('ELECTRON_HOST_START_FAILED')); }
      });
    });
  } catch (error) {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    throw error;
  } finally { child.stdout.destroy(); }
  child.unref();
  const admin = await connectAdmin({ stateDir, secret: fresh, hostId: ready.hostId, socketPath, connect });
  return Object.freeze({ ...admin, secret: fresh, pid: child.pid, spawned: true });
}
