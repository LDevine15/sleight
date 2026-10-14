import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createBroker } from './broker.mjs';
import { createRootTargets } from './root-targets.mjs';
import { createTransportOwner } from './transport-owner.mjs';
import { createSemanticAdapter, formInspectors } from './forms.mjs';
import { fixedReadInspectors } from './reads.mjs';
import { createAuthority, createTransportAuthority, revokeAuthoritySession } from './authority.mjs';
import { createBrokerFrontendSession, createFrontend } from './surface.mjs';
import { createBrokerSessionHost } from './session-host.mjs';
import { validateHostRequest } from './request-schema.mjs';
import { immutableJSON } from './ipc.mjs';

const runtimes = new WeakSet();
export const isInstalledRuntime = value => !!value && runtimes.has(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Fixed loader's private session channel. Production supplies inherited child
// pipes; no MCP tool, environment setting, project file or page can send frames.
// Tests supply streams solely to exercise framing and semantic joining.
export function createInstalledRuntime({ packageInventory, ui, session, selectedBrowser, browserIncarnation,
  logicalSession, control, connect, verifyConnection, disconnect, onStatus = () => {}, packageCurrent = () => true,
  onConnectionLoss = () => () => {} } = {}) {
  if (!identifier(logicalSession) || !/^b[A-Za-z0-9_-]{1,63}$/.test(selectedBrowser) ||
      !identifier(browserIncarnation) || !session || !control ||
      ['read', 'write'].some(k => typeof control[k]?.on !== 'function') || typeof control.write.write !== 'function' ||
      [connect, verifyConnection, disconnect, packageCurrent, onConnectionLoss].some(f => typeof f !== 'function')) throw Error('TRUSTED_ROUTE_REQUIRED');
  const currentPackage = () => packageInventory.current() && packageCurrent() === true;
  const uid = process.getuid?.() ?? 1000, secret = randomBytes(32).toString('hex'), nonce = randomBytes(32).toString('hex');
  const turns = new Map(), controllers = new Set(), begunTurns = new Set(), endedTurns = new Set();
  let roots, adapter, authority, broker, frontend, currentMessage = null, binding, accepted = false, closed = false, pending, queuedTurn, buffer = '';
  const raw = Object.freeze({ sessionId: session.sessionId, on: session.on.bind(session), off: session.off.bind(session),
    async send(method, params, route) {
      if (!currentPackage()) throw Error('VERSION_MISMATCH');
      const fence = roots?.captureObservation(route);
      const result = await session.send(method, params, route); roots?.observeNodes(route, method, result, fence); return result;
    } });
  roots = createRootTargets({ session: raw, current: scope => turns.get(scope.clientSession ?? scope.session) });
  const owner = createTransportOwner({ session: raw, checkLease: roots.checkLease,
    helpers: { ...formInspectors(), ...fixedReadInspectors }, nodeBinding: roots.nodeBinding,
    dialogBinding: (id, lease) => adapter.dialogBinding(id, lease) });
  adapter = createSemanticAdapter({ owner, rootTargets: roots, leaseFor: roots.leaseFor, current: roots.current });
  authority = createAuthority({ current: adapter.currentScope, classify: adapter.classify, checkTarget: adapter.checkTarget,
    authenticate: () => false, snapshot: () => ({ scope: adapter.currentScope(), time: Date.now() }) });
  adapter.bindAuthority(authority);
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: adapter.resolveOperation });
  const revoke = id => {
    revokeAuthoritySession(authority, id); roots.revokeSession(id); owner.revokeSession(id); turns.delete(id); return true;
  };
  broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation, async connect() {
      if (await connect() !== session) throw Error('STALE_INSTANCE'); return raw;
    },
    verifyConnection: () => verifyConnection(session), disconnect: () => disconnect(session), currentTurn: identity => turns.get(identity.session)?.turn,
    validateRequest: validateHostRequest, prepare: adapter.prepare, authorize: adapter.authorize,
    dispatchFence: adapter.dispatchFence, dispatch: adapter.dispatch, transportAuthority, endSession: revoke, redact: value => value, onStatus });
  const fence = () => { const old = frontend; frontend = undefined; old?.end(); if (binding) revoke(binding.session); currentMessage = null; };
  const unsubscribeLoss = onConnectionLoss(() => {
    if (closed) return;
    if (queuedTurn) endedTurns.add(queuedTurn);
    fence(); broker.loseConnection().catch(() => {});
  });
  async function begin(frame) {
    const old = frontend; fence(); if (old) await old.end();
    if (closed || endedTurns.has(frame.turn)) throw Error('LEASE_LOST');
    if (!currentPackage()) throw Error('VERSION_MISMATCH');
    if (broker.status().state !== 'connected') await broker.connect({ userInitiated: true });
    if (closed || endedTurns.has(frame.turn)) throw Error('LEASE_LOST');
    const id = 's' + randomBytes(16).toString('hex');
    binding = immutableJSON({ session: id, turn: frame.turn, browserIncarnation, brokerEpoch: broker.status().epoch });
    turns.set(id, binding);
    const message = immutableJSON({ session: id, logicalSession, turn: frame.turn, text: frame.text });
    currentMessage = message;
    const semantic = { session: id, revoke: () => revoke(id),
      cleanup: () => adapter.cleanupSession(id),
      delivered(value) {
        if (value.name !== 'browser_read') return false;
        try { return adapter.delivered(roots.leaseFor(value.tab, binding), value.observation.observation); } catch { return false; }
      },
      uncertain(value) {
        try { roots.retainTarget(roots.leaseFor(value.tab, binding).target); } catch {}
      } };
    const options = { broker, authority, transportOwner: owner, packageInventory, ui,
      selectedBrowser, turn: frame.turn, semanticLifecycle: semantic,
      identity: { version: 1, uid, secret, session: id, incarnation: logicalSession }, redact: value => value };
    let prepared;
    if (!accepted) {
      const controller = createBrokerFrontendSession(options); controllers.add(controller);
      prepared = await controller.enable(); accepted = !!prepared;
    } else {
      const host = createBrokerSessionHost(options);
      prepared = await createFrontend({ ...host, proof: message, verifyOptIn: proof => proof === message && accepted,
        selectedBrowser, ownership: { session: id, turn: frame.turn, brokerEpoch: binding.brokerEpoch },
        onDelivered: semantic.delivered, onUnknown: semantic.uncertain,
        endSession() { const hostEnd = host.endSession(); semantic.revoke();
          return Promise.all([hostEnd, semantic.cleanup()]).then(([a, b]) => ({ revoked: a.revoked, cleanup: [...a.cleanup, ...b.cleanup] })); } });
    }
    if (closed || binding.session !== id || endedTurns.has(frame.turn)) { await prepared?.end(); throw Error('LEASE_LOST'); }
    frontend = prepared; return prepared;
  }
  const lose = () => { if (!closed) { closed = true; fence(); } };
  control.read.on('data', chunk => {
    try {
      buffer += chunk; if (Buffer.byteLength(buffer) > 131072) throw Error('INVALID_HOST_FRAME');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const frame = immutableJSON(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
        if (frame.version !== 1 || frame.session !== logicalSession || !equal(frame.nonce, nonce)) continue;
        if (frame.event === 'begin' && identifier(frame.turn) && typeof frame.text === 'string' && Buffer.byteLength(frame.text) <= 65536 &&
            Object.keys(frame).length === 6 && !closed && !endedTurns.has(frame.turn) && !begunTurns.has(frame.turn)) {
          begunTurns.add(frame.turn);
          queuedTurn = frame.turn;
          // Fence synchronously, before serializing a new binding behind a held
          // earlier opt-in. Replayed turn ids cannot recreate expired authority.
          const wait = pending; fence();
          pending = Promise.resolve(wait).catch(() => {}).then(() => begin(frame)); pending.catch(() => {});
        } else if (frame.event === 'end' && identifier(frame.turn) && Object.keys(frame).length === 5) {
          endedTurns.add(frame.turn); if (currentMessage?.turn === frame.turn) fence();
        }
      }
    } catch { lose(); }
  });
  control.read.on('end', lose); control.read.on('error', lose); control.write.on('error', lose);
  const runtime = Object.freeze({
    ready() { return pending ?? Promise.reject(Error('TRUSTED_TURN_REQUIRED')); },
    current: () => frontend, enabled: () => accepted, userMessage: () => currentMessage,
    broker,
    endTurn() {
      if (queuedTurn) endedTurns.add(queuedTurn);
      const old = frontend; fence();
      return old ? old.end() : Promise.resolve({ revoked: true, cleanup: [] });
    },
    async close() {
      lose();
      const results = await Promise.all([...controllers].map(controller => controller.end()));
      const semantic = await roots.close(), remote = await owner.close();
      const brokerClosed = await broker.shutdown();
      // A connect provider may acquire a socket and reject before returning it.
      // Its independent ownership must also be collected, never inferred from
      // an empty broker journal or the worker's process exit.
      let providerClosed = false; try { providerClosed = await disconnect(session) === true; } catch {}
      if (brokerClosed && providerClosed) unsubscribeLoss?.();
      return { revoked: true, cleanup: [...results.flatMap(r => r.cleanup), ...semantic.cleanup, ...remote.cleanup,
        ...(brokerClosed && providerClosed ? [] : [{ resource: 'browser-connection', status: 'retained', code: 'CONNECTION_CLEANUP_UNPROVED' }])] };
    },
  });
  runtimes.add(runtime);
  control.write.write(JSON.stringify({ version: 1, session: logicalSession, nonce }) + '\n');
  return runtime;
}
