import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { immutableJSON, listenIPC } from './ipc.mjs';
import { createBroker } from './broker.mjs';
import { createConsentUi } from './consent-ui.mjs';

// Fixed entry. P3 must supply the operator-accepted package receipt from outside
// model/project input. This source bank distributes no executable or dependency.
const sources = new URL('./native/', import.meta.url);
const trustedUi = new WeakSet();
export const isTrustedUi = value => !!value && trustedUi.has(value);
function executable(name, receipt) {
  if (process.platform !== 'darwin' || receipt?.accepted !== true || receipt?.protocol !== 1 ||
      receipt.node !== process.version || !/^[a-f0-9]{64}$/.test(receipt[name] ?? '')) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  const path = fileURLToPath(new URL(name, sources)), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      stat.mode & 0o022 || stat.uid !== process.getuid() && stat.uid !== 0 ||
      createHash('sha256').update(readFileSync(path)).digest('hex') !== receipt[name]) throw Error('HOST_PACKAGE_MISMATCH');
  return path;
}
const environment = () => ({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });

export function createNativePeerProvider(receipt) {
  const path = executable('peer-host', receipt);
  return socket => new Promise((resolve, reject) => {
    // Node duplicates the connected UDS into fd 3. JSON never supplies an fd,
    // PID, UID or incarnation to the native observer.
    const child = spawn(path, ['--peer-fd', '3'], { env: environment(), stdio: ['ignore', 'pipe', 'ignore', socket] });
    let bytes = '';
    child.stdout.on('data', chunk => { bytes += chunk; if (bytes.length > 1024) child.stdout.destroy(); });
    child.on('error', () => reject(Error('IPC_PEER_UNAVAILABLE')));
    child.on('close', code => {
      try {
        const peer = immutableJSON(JSON.parse(bytes));
        if (code !== 0 || peer.uid !== process.getuid() || !Number.isSafeInteger(peer.pid) || peer.pid < 1 ||
            typeof peer.incarnation !== 'string' || !/^p[1-9]\d*-v\d+$/.test(peer.incarnation)) throw Error();
        resolve(peer);
      } catch { reject(Error('IPC_PEER_UNAVAILABLE')); }
    });
  });
}

// Pure private channel parser. read/write are inherited pipes of the selected
// child, never a local socket, page bridge or model endpoint. Tests inject streams
// solely to test framing/replay logic, not to claim native-user authentication.
export function createUiChannel({ read, write, onLoss = () => {} }) {
  const nonce = randomBytes(32).toString('hex'), pending = new Map(), events = new WeakSet();
  let buffer = '', closed = false;
  const lose = () => { if (closed) return; closed = true; pending.clear(); onLoss(); };
  read.on('data', chunk => {
    try {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 131072) throw Error();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const raw = immutableJSON(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        const record = pending.get(raw.id);
        if (!record || raw.nonce !== nonce || Object.keys(raw).length !== 3 ||
            !record.choices.includes(raw.choice) || Date.now() >= record.deadline) throw Error();
        pending.delete(raw.id);
        const event = Object.freeze({ id: raw.id, choice: raw.choice, action: raw.choice,
          selection: record.selection });
        events.add(event); Promise.resolve(record.deliver(event)).catch(lose);
      }
    } catch { lose(); }
  });
  read.on('end', lose); read.on('error', lose); write.on('error', lose);
  const channel = Object.freeze({
    present(id, data, choices, deliver, { selection, deadline = Date.now() + 30000 } = {}) {
      for (const [key, record] of pending) if (Date.now() >= record.deadline || data?.status && record.status) pending.delete(key);
      if (closed || pending.has(id) || pending.size >= 32 || typeof id !== 'string' ||
          !Array.isArray(choices) || !choices.length || typeof deliver !== 'function' ||
          !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 300000) throw Error('TRUSTED_UI_UNAVAILABLE');
      const frame = immutableJSON({ id, nonce, data, choices, deadline });
      if (Buffer.byteLength(JSON.stringify(frame)) > 65536) throw Error('TRUSTED_UI_UNAVAILABLE');
      pending.set(id, { choices: [...choices], deliver, status: data?.status,
        selection: selection && immutableJSON(selection), deadline });
      write.write(JSON.stringify(frame) + '\n');
    },
    authenticate(event) { if (!event || !events.has(event)) return false; events.delete(event); return !closed; },
    revoke() { pending.clear(); },
    close() { lose(); write.end(); },
  });
  trustedUi.add(channel); return channel;
}

export function createNativeUi(receipt, onLoss) {
  const path = executable('consent-host', receipt);
  const child = spawn(path, [], { env: environment(), stdio: ['pipe', 'pipe', 'ignore'] });
  const channel = createUiChannel({ read: child.stdout, write: child.stdin, onLoss });
  child.on('error', () => channel.close()); child.on('close', () => channel.close());
  return channel;
}

// The factory is the fixed accepted native UI provider, never a page/IPC value.
// Loss retires its private authentication channel. A replacement gets a fresh
// nonce and only the stopping broker's Cleanup control; it cannot reconnect.
export function createRecoverableUi({ createUi, onLoss, onReady, schedule = setTimeout, cancel = clearTimeout }) {
  if ([createUi, onLoss, onReady, schedule, cancel].some(fn => typeof fn !== 'function')) throw Error('TRUSTED_UI_UNAVAILABLE');
  let entry, retry, stopped = false;
  function later() {
    if (stopped || retry !== undefined) return;
    retry = schedule(() => { retry = undefined; try { start(); } catch {} }, 1000);
  }
  function lose(token) {
    if (stopped || entry?.token !== token) return;
    const old = entry; entry = undefined;
    try { old.channel?.close(); } catch {}
    try { onLoss(); } catch {}
    later();
  }
  function start() {
    if (stopped) throw Error('TRUSTED_UI_UNAVAILABLE');
    if (entry) return;
    const token = {}; entry = { token };
    try {
      const channel = createUi(() => lose(token));
      if (entry?.token !== token) { channel.close(); throw Error('TRUSTED_UI_UNAVAILABLE'); }
      entry.channel = channel;
      onReady();
      if (entry?.token !== token) throw Error('TRUSTED_UI_UNAVAILABLE');
    } catch { lose(token); throw Error('TRUSTED_UI_UNAVAILABLE'); }
  }
  const ui = Object.freeze({ start,
    present(...args) {
      if (!entry?.channel || stopped) throw Error('TRUSTED_UI_UNAVAILABLE');
      const current = entry;
      try { return current.channel.present(...args); }
      catch { lose(current.token); throw Error('TRUSTED_UI_UNAVAILABLE'); }
    },
    authenticate(event) {
      if (!entry?.channel || stopped) return false;
      const current = entry;
      try { return current.channel.authenticate(event); } catch { lose(current.token); return false; }
    },
    revoke() { entry?.channel?.revoke(); },
    close() {
      stopped = true; if (retry !== undefined) { cancel(retry); retry = undefined; }
      const current = entry; current?.channel?.close(); entry = undefined;
    },
  });
  trustedUi.add(ui); return ui;
}

export function createNativeConsent({ ui, checkCurrent, writeAllowlist, onDecision }) {
  if (!ui || typeof checkCurrent !== 'function' || typeof onDecision !== 'function') throw Error('TRUSTED_CONTRACT_REQUIRED');
  const consent = createConsentUi({ authenticate: event => ui.authenticate(event), checkCurrent, writeAllowlist,
    present(view, operation) {
      ui.present(view.id, { view, operation }, view.choices, event => {
        const ticket = consent.respond(event);
        if (ticket) {
          const receipt = consent.consume(ticket, operation);
          // P2 binds this trusted decision to its operation-specific authority.
          // No ticket or private operation is returned on a model endpoint.
          onDecision(Object.freeze({ kind: view.kind, choice: event.choice, operation, receipt }));
        }
      });
    } });
  return Object.freeze({ request: consent.request, hasSiteGrant: consent.hasSiteGrant,
    revoke() { consent.revoke(); ui.revoke(); } });
}

export function createBrokerControls({ broker, ui, revokeSessions }) {
  let sequence = 0;
  function status(value) {
    const state = value.cleanup?.pending || value.stopping ? 'cleanup-required' : value.state === 'connected' ? value.clients ? 'connected' : 'connected-idle'
      : value.state === 'paused' ? 'paused' : 'disconnected';
    const choices = state === 'cleanup-required' ? ['cleanup'] : state.startsWith('connected') ? ['pause', 'disconnect']
      : state === 'paused' ? ['disconnect'] : value.cleanup?.connecting ? ['cancel'] : ['connect'];
    ui.present('control-' + (++sequence), { status: state }, choices, async event => {
      if (!ui.authenticate(event)) return;
      try {
        if (event.action === 'connect') await broker.connect({ userInitiated: true });
        else if (event.action === 'cleanup') await broker.cleanup({ userInitiated: true });
        else if (event.action === 'pause') { broker.pause(); revokeSessions(); }
        else { const closing = broker.loseConnection(); revokeSessions(); await closing; }
      } catch { broker.loseConnection(); revokeSessions(); }
      // A completed Cleanup can retire the host and close this UI before the refresh; UI loss has its own onLoss path.
      try { status(broker.status()); } catch {}
    }, { deadline: Date.now() + 300000 });
  }
  return Object.freeze({ status });
}

export function createHostLifecycle({ broker, listener, ui, revokeSessions, timer }) {
  let stopping = false, busy, revoked = false, listenerClosed = false, uiClosed = false, released = false;
  const receipt = (closed, error) => ({ closed, cleanup: broker.status().cleanup, ...(error ? { error } : {}) });
  function close() {
    if (released) return Promise.resolve(receipt(true));
    if (busy) return busy;
    stopping = true;
    // shutdown fences requests synchronously, before any await or teardown.
    // It observes a pending close without issuing another physical close.
    const closure = broker.shutdown();
    busy = (async () => {
      try {
        if (!revoked) {
          const result = revokeSessions();
          if (result && typeof result.then === 'function') {
            result.catch(() => {}); throw Error('TEARDOWN_UNCONFIRMED');
          }
          revoked = true;
        }
        if (await closure !== true) return receipt(false);
        // Keep exclusion and the authenticated status/cleanup channel alive
        // while the exact browser connection or revocation is unconfirmed.
        if (!listenerClosed) { await listener.close(); listenerClosed = true; }
        if (!uiClosed) { await ui?.close(); uiClosed = true; }
        clearInterval(timer); released = true;
        return receipt(true);
      } catch { await closure.catch(() => {}); return receipt(false, 'TEARDOWN_UNCONFIRMED'); }
    })().finally(() => { busy = undefined; });
    return busy;
  }
  return Object.freeze({ broker, listener, ui, close,
    reconcile() { return stopping ? close() : Promise.resolve(receipt(false)); } });
}

export async function startBrokerHost({ inventory, directory, contract, revokeSessions }) {
  // Validate both fixed binaries before creating any socket or native UI.
  executable('consent-host', inventory);
  const peerIdentity = createNativePeerProvider(inventory);
  if (typeof revokeSessions !== 'function') throw Error('TRUSTED_CONTRACT_REQUIRED');
  let ui, broker, controls, host, lastStatus = { state: 'disconnected', clients: 0 };
  const status = value => {
    lastStatus = value;
    try { controls?.status(value); } catch { controls = undefined; broker?.loseConnection(); }
    // A late closure or authenticated Cleanup can finish a previously refused
    // shutdown. The heartbeat/status callback never retries physical closure.
    if (value.stopping && !value.cleanup?.pending && !value.cleanup?.connecting)
      Promise.resolve().then(() => host?.reconcile());
  };
  const data = { ...contract, idlePolicy: 'retain', onStatus: status };
  broker = createBroker(data);
  const listener = await listenIPC({ directory, broker, uid: data.uid, secret: data.secret, peerIdentity });
  try {
    ui = createRecoverableUi({ createUi: onLoss => createNativeUi(inventory, onLoss),
      onLoss() {
        controls = undefined;
        // Permanently stop the broker rather than letting an absent UI approve
        // more work. Host close retains singleton/cleanup ownership on failure.
        if (host) host.close(); else { broker.shutdown(); try { revokeSessions(); } catch {} }
      },
      onReady() { controls = createBrokerControls({ broker, ui, revokeSessions }); status(broker.status()); } });
    ui.start();
  } catch {
    // No connection is offered before the initial private UI is ready.
    // Cancel any UI factory retry before releasing a proven-empty host.
    if (await broker.shutdown() === true) { ui?.close(); await listener.close(); }
    throw Error('TRUSTED_UI_UNAVAILABLE');
  }
  // Reissue status controls before their authenticated envelope expires. Session
  // authority is never renewed by this timer, and a disconnected UI fences work.
  const timer = setInterval(() => status(broker.status()), 60000);
  host = createHostLifecycle({ broker, listener, ui, revokeSessions, timer });
  return host;
}
