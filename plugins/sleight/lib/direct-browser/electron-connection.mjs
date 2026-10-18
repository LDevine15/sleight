// Fixed app connection provider for an opted-in Electron app, the Electron counterpart of
// selected-connection.mjs. It gives the worker the same private surface (session, connect,
// verifyConnection, createFilter, onConnectionLoss, disconnect) over an authenticated channel to the
// resident host, which alone holds the app's pipe. Nothing imports this file in the installed path
// yet (EPV3-7 wires it).
//
// There is no app debugging port, no WebSocket and no local Playwright listener on this path:
// Playwright connects through an in-process transport object that feeds the same CDP filter the
// Chrome provider uses. Tool arguments, page text and config never reach `handle`: it is issued by
// the trusted host admin and passed to the worker over its inherited IPC.
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createCDPFilter } from './cdp-filter.mjs';
import { CHANNEL_VERSION, DEFAULT_MAX_FRAME_BYTES, FrameReader, HANDSHAKE_MAX_BYTES, bare, deriveChannel, macEqual, opener, plainJson,
  randomToken, sealer, validToken } from './electron-channel.mjs';

const fail = code => { throw Error(code); };
const ordinaryObject = value => value && typeof value === 'object' && !Array.isArray(value);
const methodName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(value);
const canonicalHandle = ['expiresAt', 'host', 'secret', 'session', 'socket', 'ticket'];

function checkHandle(handle) {
  if (!ordinaryObject(handle) || Object.keys(handle).sort().join() !== canonicalHandle.join() || !validToken(handle.host) || !validToken(handle.ticket) ||
      !validToken(handle.secret) || typeof handle.socket !== 'string' || !handle.socket.startsWith('/') || handle.socket.includes('\0') ||
      typeof handle.session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(handle.session) || !Number.isFinite(handle.expiresAt)) fail('ELECTRON_HANDLE_INVALID');
  return Object.freeze({ ...handle, secretBytes: Buffer.from(handle.secret, 'base64url') });
}

/** Wraps a CDP filter's session as the transport object Playwright's connectOverCDP accepts.
 * close() detaches this transport only. The filter, the channel and the app stay as they are. */
export function createFilterTransport(filter) {
  let closed = false;
  const write = frame => { if (!closed) queueMicrotask(() => { if (!closed) transport.onmessage?.(frame); }); };
  const forward = frame => { if (!closed) transport.onmessage?.(frame); };
  const transport = {
    onmessage: undefined, onclose: undefined,
    send(message) {
      if (closed) return;
      if (!ordinaryObject(message) || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.method !== 'string') { transport.close(); return; }
      const route = message.sessionId;
      filter.session.send(message.method, message.params ?? {}, route).then(
        result => write({ id: message.id, result, ...(route === undefined ? {} : { sessionId: route }) }),
        error => write({ id: message.id, error: { code: -32000, message: /^CDP_/.test(error.message) ? error.message : 'CDP_COMMAND_FAILED' },
          ...(route === undefined ? {} : { sessionId: route }) }));
    },
    close() {
      if (closed) return;
      closed = true;
      try { filter.session.off('event', forward); } catch { /* filter already disposed */ }
      queueMicrotask(() => transport.onclose?.('closed'));
    },
  };
  filter.session.on('event', forward);
  return transport;
}

export async function createElectronConnection({ handle: rawHandle, connect = path => net.connect(path), openTimeoutMs = 10000, closeTimeoutMs = 3000,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, maxPending = 1024 } = {}) {
  const handle = checkHandle(rawHandle);
  if (![openTimeoutMs, closeTimeoutMs, maxFrameBytes, maxPending].every(value => Number.isSafeInteger(value) && value > 0 && value <= 30000000)) fail('ELECTRON_HANDLE_INVALID');
  let socket, send, receive, opened = false, fenced = false, attempted = false, opening, closing, confirmed = false, app;
  let sequence = 0;
  const losses = new Set(), callbacks = new Set(), pending = new Map();
  let lossNotified = false;
  const sessionId = 'r' + randomBytes(24).toString('hex');

  function notifyLoss() {
    if (lossNotified) return;
    lossNotified = true;
    for (const callback of losses) try { callback(); } catch { /* a loss callback cannot stop the others */ }
  }
  function rejectAll(code) { for (const entry of pending.values()) entry.reject(Object.assign(Error(code), { dispatched: entry.sent })); pending.clear(); }
  function fence() {
    fenced = true; opened = false; notifyLoss();
    rejectAll('ELECTRON_CONNECTION_CLOSED');
    if (socket && !socket.destroyed) socket.destroy();
  }

  function onFrame(message) {
    if (message.op === 'reply') {
      const entry = pending.get(message.id);
      if (!entry || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) fail('ELECTRON_PROTOCOL');
      pending.delete(message.id);
      if (Object.hasOwn(message, 'error')) {
        const code = ordinaryObject(message.error) && typeof message.error.code === 'string' ? message.error.code : 'FAILED';
        entry.reject(Object.assign(Error(code === 'CDP_ERROR' ? 'CDP_COMMAND_FAILED' : code), { hostCode: code, dispatched: message.error.dispatched === true }));
      } else entry.resolve(message.result);
    } else if (message.op === 'event') {
      const frame = message.frame;
      if (!ordinaryObject(frame) || !methodName(frame.method) || !ordinaryObject(frame.params ?? {}) ||
          frame.sessionId !== undefined && (typeof frame.sessionId !== 'string' || !frame.sessionId || frame.sessionId.length > 512)) fail('ELECTRON_PROTOCOL');
      if (!fenced) for (const callback of callbacks) {
        try { callback(Object.freeze({ method: frame.method, params: frame.params ?? {}, ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }) })); } catch { /* listener error */ }
      }
    } else if (message.op === 'parked') {
      // Revoked, or the app connection parked: stop at once. The host keeps the app's pipe.
      fence();
    } else fail('ELECTRON_PROTOCOL');
  }

  const session = Object.freeze({ sessionId,
    send(method, params = {}, route = sessionId) {
      if (fenced || !opened) return Promise.reject(Error('ELECTRON_CONNECTION_CLOSED'));
      const target = route === sessionId ? undefined : route;
      if (!methodName(method) || !ordinaryObject(params) || target !== undefined && (typeof target !== 'string' || !target || target.length > 512) ||
          pending.size >= maxPending || sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(Error('INVALID_CDP_COMMAND'));
      const id = ++sequence;
      let bytes;
      try {
        bytes = send({ op: 'send', id, method, params, ...(target === undefined ? {} : { sessionId: target }) });
        if (bytes.length > maxFrameBytes + 256) throw Error();
      } catch { return Promise.reject(Error('INVALID_CDP_COMMAND')); }
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, sent: false };
        pending.set(id, entry);
        try { socket.write(bytes, error => { if (error) fence(); else entry.sent = true; }); } catch { fence(); }
      });
    },
    on(name, callback) { if (name !== 'event' || typeof callback !== 'function') fail('INVALID_CDP_EVENT'); callbacks.add(callback); },
    off(name, callback) { if (name !== 'event' || typeof callback !== 'function') fail('INVALID_CDP_EVENT'); callbacks.delete(callback); },
  });

  async function open() {
    socket = connect(handle.socket);
    socket.on('error', () => fence());
    socket.on('close', () => { confirmed = true; fence(); });
    const reader = new FrameReader(HANDSHAKE_MAX_BYTES);
    let stage = 'hello', derived, clientNonce;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(Error('ELECTRON_CONNECTION_TIMEOUT')); fence(); }, openTimeoutMs);
      const finish = error => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      socket.on('close', () => finish(Error('ELECTRON_CONNECTION_CLOSED')));
      socket.on('data', chunk => {
        try {
          for (const frame of reader.push(chunk)) {
            if (stage === 'hello') {
              const hello = plainJson(frame);
              // Only the exact host this handle was issued by can continue the exchange.
              if (Object.keys(hello).sort().join() !== 'host,nonce,t,v' || hello.t !== 'hello' || hello.v !== CHANNEL_VERSION ||
                  hello.host !== handle.host || !validToken(hello.nonce)) fail('ELECTRON_HOST_MISMATCH');
              clientNonce = randomToken();
              derived = deriveChannel(handle.secretBytes, { host: handle.host, hostNonce: hello.nonce, clientNonce, ticket: handle.ticket, role: 'worker' });
              socket.write(bare({ t: 'auth', ticket: handle.ticket, role: 'worker', cn: clientNonce, proof: derived.clientProof }));
              stage = 'ready';
            } else if (stage === 'ready') {
              const ready = plainJson(frame);
              if (Object.keys(ready).sort().join() !== 'proof,t' || ready.t !== 'ready' || !macEqual(ready.proof, derived.hostProof)) fail('ELECTRON_HOST_MISMATCH');
              send = sealer(derived.clientKey); const openFrame = opener(derived.hostKey);
              receive = openFrame; reader.max = maxFrameBytes; stage = 'open';
            } else if (stage === 'open') {
              const message = receive(frame);
              if (message.op === 'open') {
                if (!ordinaryObject(message.incarnation) || !Number.isSafeInteger(message.incarnation.pid) || typeof message.incarnation.birth !== 'string' ||
                    !Number.isSafeInteger(message.epoch) || !validToken(message.instance)) fail('ELECTRON_PROTOCOL');
                app = Object.freeze({ pid: message.incarnation.pid, birth: message.incarnation.birth, epoch: message.epoch, instance: message.instance });
                stage = 'live'; finish();
              } else if (message.op === 'refused') fail('ELECTRON_APP_PARKED');
              else fail('ELECTRON_PROTOCOL');
            } else onFrame(receive(frame));
          }
        } catch (error) {
          if (stage !== 'live') finish(error); // before open the caller gets the reason
          fence();
        }
      });
    });
  }

  async function connectChannel() {
    if (fenced || attempted && !opening) fail('ELECTRON_CONNECTION_CLOSED');
    if (opening) return opening;
    attempted = true;
    opening = (async () => {
      try { await open(); if (fenced) fail('ELECTRON_CONNECTION_CLOSED'); opened = true; return session; }
      catch (error) { await disconnect(); throw error; }
    })();
    return opening;
  }

  function disconnect(candidate = session) {
    if (candidate !== session) return Promise.resolve(false);
    if (socket && !socket.destroyed && opened && send) { try { socket.write(send({ op: 'bye' })); } catch { /* closing anyway */ } }
    fence();
    if (!socket || confirmed || socket.destroyed) return Promise.resolve(true);
    if (closing) return closing;
    closing = new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => resolve(confirmed), closeTimeoutMs);
      socket.once('close', done);
    }).finally(() => { closing = undefined; });
    return closing;
  }

  async function verifyConnection(candidate, expectedIncarnation) {
    if (candidate !== session || expectedIncarnation !== undefined && expectedIncarnation !== browserIncarnation || !opened || fenced) return false;
    try {
      const id = ++sequence;
      const reply = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, sent: false });
        socket.write(send({ op: 'verify', id }));
      });
      if (reply?.ok !== true || reply.instance !== app.instance || reply.epoch !== app.epoch) { fence(); return false; }
      return opened && !fenced;
    } catch { fence(); return false; }
  }

  // The connection is not usable until connectChannel() has run, so these derive from the first
  // handshake. They are filled in once, then frozen.
  let browserIncarnation, selectedBrowser, identity;
  const provider = {
    kind: 'electron-app', session, endpoint: undefined,
    async connect() {
      const result = await connectChannel();
      browserIncarnation = 'e' + createHash('sha256').update(JSON.stringify([handle.host, app.instance, app.epoch, app.pid, app.birth])).digest('hex');
      selectedBrowser = 'b' + createHash('sha256').update(handle.host + '\0' + app.instance).digest('hex').slice(0, 32);
      identity = Object.freeze({ host: handle.host, ...app });
      return result;
    },
    verifyConnection, disconnect,
    get browserIncarnation() { return browserIncarnation; },
    get selectedBrowser() { return selectedBrowser; },
    get identity() { return identity; },
    createFilter(ownedTargets = []) {
      if (!opened || fenced) fail('ELECTRON_CONNECTION_CLOSED');
      const filter = createCDPFilter({ session, ownedTargets });
      const lost = () => { filter.dispose(); losses.delete(lost); };
      losses.add(lost);
      return Object.freeze({ ...filter,
        // The Chrome provider hands Playwright a loopback WebSocket. This path has no listener at all.
        listen() { fail('ELECTRON_NO_LISTENER'); },
        async connectPlaywright(playwright, { timeout = 10000 } = {}) {
          if (typeof playwright?.chromium?.connectOverCDP !== 'function') fail('PLAYWRIGHT_REQUIRED');
          return playwright.chromium.connectOverCDP(createFilterTransport(filter), { noDefaults: true, timeout });
        },
        dispose() { losses.delete(lost); return filter.dispose(); } });
    },
    onConnectionLoss(callback) {
      if (typeof callback !== 'function') fail('TRUSTED_ROUTE_REQUIRED');
      losses.add(callback); if (lossNotified) callback();
      return () => losses.delete(callback);
    },
  };
  return Object.freeze(provider);
}
