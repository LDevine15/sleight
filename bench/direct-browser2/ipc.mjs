import { timingSafeEqual } from 'node:crypto';
import { lstatSync, realpathSync, openSync, closeSync, unlinkSync, chmodSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

export const IPC_VERSION = 1;
export const FRAME_LIMIT = 4 * 1024 * 1024;
// Independently authored framing, inspired by FowlBrowser MIT 8b689249ba4e33d2626487aad930605c62e2c6a7,
// host/host.mjs and mcp/src/hostClient.mjs. No upstream implementation copied.
export function immutableJSON(input, depth = 0) {
  if (depth > 16) throw Error('INVALID_ARGUMENT');
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (!input || typeof input !== 'object') throw Error('INVALID_ARGUMENT');
  if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('INVALID_ARGUMENT');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]))) throw Error('INVALID_ARGUMENT');
  if (Array.isArray(input)) {
    if (input.length > 4096 || Object.keys(descriptors).length !== input.length + 1) throw Error('INVALID_ARGUMENT');
    return Object.freeze(Array.from({ length: input.length }, (_, i) => immutableJSON(descriptors[i].value, depth + 1)));
  }
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, immutableJSON(d.value, depth + 1)])));
}
export function encodeFrame(data) {
  const body = Buffer.from(JSON.stringify(immutableJSON(data)));
  if (!body.length || body.length > FRAME_LIMIT) throw Error('FRAME_LIMIT');
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export function createFrameDecoder() {
  let pending = Buffer.alloc(0), failed = false;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  return { push(chunk) {
    if (failed) throw Error('FRAME_CLOSED');
    try {
      if (!Buffer.isBuffer(chunk) || pending.length + chunk.length > FRAME_LIMIT + 4) throw Error('FRAME_LIMIT');
      pending = Buffer.concat([pending, chunk]); const messages = [];
      while (pending.length >= 4) {
        const length = pending.readUInt32BE();
        if (!length || length > FRAME_LIMIT) throw Error('FRAME_LIMIT');
        if (pending.length < length + 4) break;
        let message;
        try { message = immutableJSON(JSON.parse(utf8.decode(pending.subarray(4, length + 4)))); }
        catch { throw Error('FRAME_JSON'); }
        messages.push(message); pending = pending.subarray(length + 4);
      }
      return messages;
    } catch (error) { failed = true; pending = Buffer.alloc(0); throw error; }
  } };
}
export function authenticate(input, { uid, secret }) {
  let data;
  try { data = immutableJSON(input); } catch { throw Error('IPC_AUTH'); }
  const keys = ['version', 'secret', 'uid', 'session', 'incarnation'];
  if (!data || Object.keys(data).length !== keys.length || keys.some(k => !Object.hasOwn(data, k)) ||
      data.version !== IPC_VERSION || !Number.isInteger(uid) || data.uid !== uid ||
      !/^[a-f0-9]{64}$/.test(secret) || typeof data.secret !== 'string' || !/^[a-f0-9]{64}$/.test(data.secret) ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(data.secret)) ||
      ['session', 'incarnation'].some(k => typeof data[k] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data[k]))) throw Error('IPC_AUTH');
  return Object.freeze({ session: data.session, incarnation: data.incarnation });
}
// The listener calls this after binding and requires a trusted peer provider.
// A JSON uid claim alone is not an OS peer credential; host qualification remains
// separate from the test provider and private socket filesystem checks.
export function assertPrivateIPC(directory, socket, uid = process.getuid()) {
  if (resolve(directory) !== directory || resolve(socket) !== socket || dirname(socket) !== directory) throw Error('IPC_PATH');
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory) throw Error('IPC_DIRECTORY');
  const file = lstatSync(socket);
  if (!file.isSocket() || file.isSymbolicLink() || file.uid !== uid || (file.mode & 0o777) !== 0o600) throw Error('IPC_SOCKET');
  return true;
}

// The selected per-user directory is trusted configuration, not an IPC argument.
// Node does not expose portable getpeereid: require an authenticated host peer
// provider. Tests label their fixture provider; there is no JSON-uid fallback.
export async function listenIPC({ directory, broker, uid, secret, peerIdentity, maxClients = 128 }) {
  if (typeof peerIdentity !== 'function' || !broker || !Number.isInteger(maxClients) || maxClients < 1 || maxClients > 128) throw Error('IPC_PEER_REQUIRED');
  const stat = lstatSync(directory);
  if (resolve(directory) !== directory || realpathSync(directory) !== directory || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw Error('IPC_DIRECTORY');
  const lock = resolve(directory, 'broker.lock'), path = resolve(directory, 'broker.sock');
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch { throw Error('IPC_SINGLETON'); }
  const lockStat = lstatSync(lock), sockets = new Set(); let socketStat;
  const removeOwned = (file, expected) => {
    try { const now = lstatSync(file); if (expected && now.dev === expected.dev && now.ino === expected.ino) unlinkSync(file); } catch {}
  };
  const server = createServer(socket => {
    if (sockets.size >= maxClients) { socket.destroy(); return; }
    sockets.add(socket); const decoder = createFrameDecoder(); let client, ready = false, pending = 0;
    const timer = setTimeout(() => socket.destroy(), 3000);
    const write = data => {
      if (socket.destroyed) return;
      const bytes = encodeFrame(data);
      if (socket.writableLength + bytes.length > FRAME_LIMIT + 4) { socket.destroy(); return; }
      socket.write(bytes);
    };
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); client?.disconnect(); sockets.delete(socket); });
    socket.on('data', chunk => {
      try {
        for (const message of decoder.push(chunk)) {
          if (!ready) {
            const peer = peerIdentity(socket);
            if (!peer || peer.uid !== uid) throw Error('IPC_AUTH');
            authenticate(message, { uid: peer.uid, secret });
            client = broker.attach(message); ready = true; clearTimeout(timer);
            write({ ready: true, version: IPC_VERSION }); continue;
          }
          if (!message || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.id)) throw Error('IPC_REQUEST');
          if (++pending > 32) throw Error('IPC_BACKPRESSURE');
          client.request(message).then(receipt => write({ id: message.id, receipt }))
            .catch(() => socket.destroy()).finally(() => pending--);
        }
      } catch { socket.destroy(); }
    });
  });
  try {
    // Refuse any stale socket; takeover/removal is an operator decision.
    try { lstatSync(path); throw Error('IPC_SOCKET_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    socketStat = lstatSync(path); chmodSync(path, 0o600); assertPrivateIPC(directory, path, uid);
  } catch (e) {
    server.close(); removeOwned(path, socketStat); closeSync(fd); removeOwned(lock, lockStat); throw e;
  }
  let closed;
  return Object.freeze({ path,
    close() {
      if (!closed) closed = new Promise(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => { removeOwned(path, socketStat); closeSync(fd); removeOwned(lock, lockStat); resolve(); });
      });
      return closed;
    },
  });
}

export async function connectIPC({ path, hello, timeoutMs = 3000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('IPC_TIMEOUT');
  // Validate private filesystem before the connection sends its secret.
  assertPrivateIPC(dirname(path), path, hello.uid);
  const socket = createConnection(path), decoder = createFrameDecoder(), pending = new Map();
  let ready;
  const handshake = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  socket.on('error', () => {});
  socket.on('close', () => {
    clearTimeout(timer); ready.reject(Error('IPC_CLOSED'));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('IPC_CLOSED')); }
    pending.clear();
  });
  socket.on('connect', () => { try { socket.write(encodeFrame(hello)); } catch { socket.destroy(); } });
  socket.on('data', bytes => {
    try { for (const message of decoder.push(bytes)) {
      if (message.ready === true && message.version === IPC_VERSION) { clearTimeout(timer); ready.resolve(); continue; }
      const entries = pending.get(message.id);
      if (!entries) throw Error('IPC_RESPONSE');
      pending.delete(message.id); clearTimeout(entries.timer); entries.resolve(message.receipt);
    } } catch { socket.destroy(); }
  });
  await handshake;
  return Object.freeze({
    request(input) {
      const frame = immutableJSON(input);
      if (socket.destroyed || pending.size >= 32 || pending.has(frame.id) || typeof frame.id !== 'string') return Promise.reject(Error('IPC_BACKPRESSURE'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(frame.id); reject(Error('IPC_TIMEOUT')); socket.destroy(); }, timeoutMs);
        pending.set(frame.id, { resolve, reject, timer });
        try { socket.write(encodeFrame(frame)); } catch (e) { pending.delete(frame.id); clearTimeout(timer); reject(e); }
      });
    },
    close() { socket.destroy(); },
  });
}
