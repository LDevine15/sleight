import { createHash } from 'node:crypto';
import { authenticate, immutableJSON, FRAME_LIMIT } from './ipc.mjs';
import { isTransportAuthority, completeTransport, completeTransportStep, initializeTransport, completeTransportPreparation } from './authority.mjs';

const operations = new Set(['browser_open', 'browser_read', 'browser_act', 'browser_fill']);
const effects = new Set(['verified', 'unchanged', 'protected', 'unverifiable', 'unknown', 'none']);
const connectionStates = new Set(['disconnected', 'setting-off', 'unsupported', 'approval-pending', 'declined', 'stale-instance']);
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const brokers = new WeakSet();
export const isBroker = value => !!value && brokers.has(value);
const transports = new WeakSet();
export const isBrokerTransport = value => !!value && transports.has(value);
const copy = data => structuredClone(data);
function failure(code, effect = 'none', phase = 'prepared', completed = 0) {
  return { phase, effect, completed, error: { code, phase, effect, completed,
    next: { kind: effect === 'unknown' ? 'reconcile' : 'trusted-control' } } };
}
function validate(input, validateRequest) {
  const frame = immutableJSON(input);
  if (Buffer.byteLength(JSON.stringify(frame)) > FRAME_LIMIT || !frame || Object.keys(frame).length !== 3 ||
      !['id', 'operation', 'args'].every(k => Object.hasOwn(frame, k)) ||
      typeof frame.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.id) ||
      !operations.has(frame.operation) || !frame.args || typeof frame.args !== 'object' || Array.isArray(frame.args)) throw Error('INVALID_ARGUMENT');
  // BP2-1/BP2-9 supply the closed four-verb argument schemas; the broker rejects
  // unknown operation names even if a mistaken frontend validator accepts them.
  if (validateRequest(frame) !== frame) throw Error('INVALID_ARGUMENT');
  return frame;
}

// Scheduling/lifecycle ideas: FowlBrowser MIT 8b689249ba4e33d2626487aad930605c62e2c6a7,
// host/host.mjs, mcp/src/browsers.mjs, mcp/src/cdp.mjs; CDM Apache-2.0 e52c6b59b476c5e04d8dd9fd4bd017ba3b3d65df,
// src/BrowserManager.ts attached-versus-owned lifecycle. Independently authored;
// no competitor source, extension transport or Playwright initialization copied.
export function createBroker({ uid, secret, idlePolicy, browserIncarnation, connect: openConnection,
  verifyConnection, currentTurn, validateRequest, prepare, authorize, dispatchFence, transportAuthority, endSession, dispatch, redact,
  disconnect: closeConnection, onStatus = () => {}, timeoutMs = 3000, maxSession = 32, maxBroker = 128, maxReceipts = 1024 }) {
  if (!['retain', 'disconnect'].includes(idlePolicy)) throw Error('IDLE_POLICY_REQUIRED');
  if (typeof browserIncarnation !== 'string' || !browserIncarnation ||
      [openConnection, verifyConnection, currentTurn, validateRequest, prepare, authorize, dispatchFence, transportAuthority, endSession, dispatch, redact, closeConnection].some(f => typeof f !== 'function') ||
      !isTransportAuthority(transportAuthority)) throw Error('TRUSTED_CONTRACT_REQUIRED');
  authenticate({ version: 1, secret, uid, session: 'validation', incarnation: 'validation' }, { uid, secret });
  for (const [value, ceiling] of [[timeoutMs, 30000], [maxSession, 32], [maxBroker, 128], [maxReceipts, 4096]])
    if (!Number.isInteger(value) || value < 1 || value > ceiling) throw Error('BROKER_LIMIT');
  const clients = new Map(), receipts = new Map(), occupied = new Set();
  const owned = new Map();
  let state = 'disconnected', epoch = 0, socket, connecting, active = 0, paused = false, cursor = 0, revocationFault = false, closed = false;
  const cleanupStatus = () => ({ pending: [...owned.values()].filter(r => r.socket !== socket).length,
    connecting: !!connecting });
  const publish = () => onStatus({ state: paused && state === 'connected' ? 'paused' : state, stopping: closed,
    clients: [...clients.values()].filter(c => c.live).length, cleanup: cleanupStatus() });
  // Retain the exact owned object until the provider proves closure. A promise,
  // false result or thrown error is never proof, and Connect never retries it.
  function closeOwned(candidate) {
    const record = owned.get(candidate);
    if (!record) return Promise.resolve(true);
    if (record.pending) return record.pending;
    let result;
    try { result = closeConnection(candidate); } catch { result = false; }
    record.pending = Promise.resolve(result).then(proven => {
      if (proven === true) owned.delete(candidate);
      return proven === true;
    }, () => false).finally(() => { record.pending = undefined; publish(); });
    return record.pending;
  }
  async function bounded(pending) {
    let timer;
    try { return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  const safe = observation => immutableJSON(redact(observation ?? null));
  const live = (task, checkTurn = true) => !task.finished && task.client.live && state === 'connected' && !paused && task.epoch === epoch && task.client.epoch === epoch &&
    socket === task.socket && socket.sessionId === task.sessionId && (!checkTurn || currentTurn(task.client) === task.scope.turn) && !task.signal.aborted;
  function finish(task, response) {
    if (task.finished) return;
    task.finished = true; clearTimeout(task.timer); active--; task.client.pending--;
    if (task.plan) {
      const prefix = completeTransport(transportAuthority, task.plan, response.effect);
      if (prefix) {
        response = { ...response, ...prefix };
        if (prefix.unknownStep !== null || response.effect === 'verified' && prefix.untouched) {
          response.effect = 'unknown'; response.phase = 'unknown';
          response.error = { ...failure(response.error?.code ?? 'EFFECT_UNKNOWN', 'unknown', 'unknown', prefix.completed).error };
        }
        if (response.results?.length !== prefix.completed) delete response.results;
        if (response.error) response.error = { ...response.error, ...prefix };
      }
    }
    if (task.running && task.target) occupied.delete(task.target);
    task.record.receipt = immutableJSON({ operation: task.frame.id, ...response });
    task.record.resolve(task.record.receipt);
    pump();
  }
  function stopped(task, code) {
    task.controller.abort();
    finish(task, failure(code, task.dispatched ? 'unknown' : 'none', task.dispatched ? 'unknown' : 'prepared'));
  }
  async function execute(task) {
    try {
      if (!live(task)) return stopped(task, 'LEASE_LOST');
      const authority = await authorize(task.plan, task.scope);
      if (!live(task)) return stopped(task, 'LEASE_LOST');
      // A fence must be synchronous so no user callback/await interposes before
      // the internal adapter entry. Payment authority and target checks belong
      // to the trusted semantic host, never frontend arguments.
      if (authority !== true || dispatchFence(task.plan, task.scope) !== true) return finish(task, failure('PERMISSION_REQUIRED'));
      if (!live(task)) return stopped(task, 'LEASE_LOST');
      const guardedSession = Object.freeze({ sessionId: socket.sessionId,
        completeStep(index, effect) {
          if (!live(task)) throw Error('LEASE_LOST');
          return completeTransportStep(transportAuthority, task.plan, index, effect);
        },
        completePreparation(id, effect) {
          if (!live(task)) throw Error('LEASE_LOST');
          return completeTransportPreparation(transportAuthority, task.plan, id, effect);
        },
        send(method, params, route, window) {
          if (!live(task)) throw Error('LEASE_LOST');
          const command = immutableJSON({ method, params, route: route ?? null, ...(window === undefined ? {} : { window }) });
          let entered = false;
          return transportAuthority(task.plan, task.scope, command, () => {
            if (entered) throw Error('TRANSPORT_SPENT');
            // The authority has just checked turn/scope/time together. Only
            // internal broker state follows it, with no host callback interposed.
            if (!live(task, false)) throw Error('LEASE_LOST');
            entered = true; task.dispatched = true;
            return task.socket.send(command.method, command.params, command.route ?? undefined);
          });
        },
        on: task.socket.on.bind(task.socket), off: task.socket.off.bind(task.socket) });
      transports.add(guardedSession);
      const result = await dispatch(task.plan, { ...task.scope, clientSession: task.scope.session, session: guardedSession, signal: task.signal });
      if (task.finished) return;
      if (!live(task)) return stopped(task, 'LEASE_LOST');
      if (!result || !effects.has(result.effect) || !Object.hasOwn(result, 'observation')) return stopped(task, 'EFFECT_UNKNOWN');
      const observation = safe(result.observation);
      let response = { phase: ['unknown', 'none'].includes(result.effect) ? result.effect === 'unknown' ? 'unknown' : 'prepared' : result.effect === 'unverifiable' ? 'observed' : 'verified',
        effect: result.effect, completed: result.completed ?? (['verified', 'protected', 'unchanged'].includes(result.effect) ? 1 : 0), observation };
      if (!Number.isInteger(response.completed) || response.completed < 0 || response.completed > 50) return stopped(task, 'EFFECT_UNKNOWN');
      if (Object.hasOwn(result, 'untouched')) {
        if (!Number.isInteger(result.untouched) || result.untouched < 0 || result.untouched > 50) return stopped(task, 'EFFECT_UNKNOWN');
        response.untouched = result.untouched;
      }
      if (Object.hasOwn(result, 'results')) {
        if (!Array.isArray(result.results) || result.results.length !== response.completed || result.results.length > 50) return stopped(task, 'EFFECT_UNKNOWN');
        response.results = result.results.map(r => {
          if (!r || !['verified', 'protected', 'unchanged'].includes(r.effect) || !Object.hasOwn(r, 'observation')) throw Error('EFFECT_UNKNOWN');
          return { effect: r.effect, observation: safe(r.observation) };
        });
      }
      if (['unknown', 'unverifiable', 'none'].includes(result.effect)) {
        const code = result.effect === 'unknown' ? 'EFFECT_UNKNOWN' : result.effect === 'unverifiable' ? 'STATE_UNVERIFIABLE' : 'NO_EFFECT';
        response.error = failure(code, result.effect, response.phase, response.completed).error;
      }
      if (task.frame.operation === 'browser_open') {
        if (typeof result.tab !== 'string' || !/^t[A-Za-z0-9_-]{1,63}$/.test(result.tab)) return stopped(task, 'EFFECT_UNKNOWN');
        response.tab = result.tab;
      }
      if (Buffer.byteLength(JSON.stringify(response)) > 12000) {
        const omitted = { omitted: true, reason: 'output_budget' };
        response = { ...response, observation: omitted,
          ...(response.results ? { results: response.results.map(r => ({ ...r, observation: omitted })) } : {}) };
      }
      finish(task, response);
    } catch { if (!task.finished) stopped(task, task.dispatched ? 'EFFECT_UNKNOWN' : 'PERMISSION_REQUIRED'); }
  }
  function pump() {
    const sessions = [...clients.values()];
    // Round-robin among ready sessions, with one mutation owner per target.
    for (let i = 0; i < sessions.length; i++) {
      const client = sessions[(cursor + i) % sessions.length];
      for (const task of client.queue) {
        if (task.finished || task.running || !task.plan || occupied.has(task.target)) continue;
        task.running = true; occupied.add(task.target); execute(task);
        break;
      }
      client.queue = client.queue.filter(t => !t.finished);
    }
    if (sessions.length) cursor = (cursor + 1) % sessions.length;
  }
  function invalidate(nextState) {
    state = nextState; epoch++; socket = undefined; paused = false;
    for (const client of clients.values()) for (const task of client.queue) if (!task.finished) stopped(task, 'DISCONNECTED');
    publish();
  }
  const broker = {
    status: () => ({ state: paused && state === 'connected' ? 'paused' : state, epoch, stopping: closed,
      clients: [...clients.values()].filter(c => c.live).length, pending: active, cleanup: cleanupStatus() }),
    async connect({ userInitiated } = {}) {
      if (closed) throw Error('HOST_CLOSED');
      if (revocationFault) throw Error('SESSION_REVOCATION_UNCONFIRMED');
      if (userInitiated !== true) throw Error('EXPLICIT_CONNECT_REQUIRED');
      if (state === 'connected') return;
      if (owned.size) throw Error('CONNECTION_CLEANUP_REQUIRED');
      if (connecting) return connecting;
      state = 'approval-pending'; const expected = ++epoch;
      connecting = (async () => {
        let candidate;
        try {
          candidate = await openConnection();
          if (candidate) owned.set(candidate, { socket: candidate });
          if (expected !== epoch || state !== 'approval-pending' || closed) throw Error('CONNECT_CANCELLED');
          if (!candidate || typeof candidate.sessionId !== 'string' || !candidate.sessionId ||
              ['send', 'on', 'off'].some(k => typeof candidate[k] !== 'function') || await verifyConnection(candidate, browserIncarnation) !== true) throw Error('STALE_INSTANCE');
          if (expected !== epoch || state !== 'approval-pending' || closed) throw Error('CONNECT_CANCELLED');
          socket = candidate; state = 'connected'; publish();
        } catch (error) {
          if (candidate) closeOwned(candidate);
          if (expected === epoch) state = error.message === 'STALE_INSTANCE' ? 'stale-instance' : 'disconnected';
          throw error;
        } finally { connecting = undefined; publish(); }
      })();
      return connecting;
    },
    loseConnection(nextState = 'disconnected') {
      if (!connectionStates.has(nextState)) throw Error('INVALID_CONNECTION_STATE');
      const prior = socket; invalidate(nextState); return prior ? bounded(closeOwned(prior)) : Promise.resolve(!owned.size && !connecting);
    },
    async cleanup({ userInitiated } = {}) {
      if (userInitiated !== true) throw Error('EXPLICIT_CLEANUP_REQUIRED');
      await bounded(Promise.all([...owned.keys()].filter(candidate => candidate !== socket).map(closeOwned)));
      return !owned.size && !connecting;
    },
    async shutdown() {
      if (!closed) {
        closed = true;
        broker.loseConnection();
        for (const client of clients.values()) if (client.live) {
          client.live = false;
          try { if (endSession(client.session) !== true) revocationFault = true; } catch { revocationFault = true; }
        }
      }
      if (connecting) await bounded(connecting.catch(() => false));
      await bounded(Promise.all([...owned.values()].map(r => r.pending ?? Promise.resolve(false))));
      return !owned.size && !connecting && !revocationFault;
    },
    pause() { paused = true; for (const c of clients.values()) for (const task of c.queue) if (!task.finished) stopped(task, 'USER_TAKEOVER'); publish(); },
    attach(input) {
      if (closed) throw Error('HOST_CLOSED');
      const identity = authenticate(input, { uid, secret });
      const existing = clients.get(identity.session);
      if (existing && (existing.live || existing.incarnation !== identity.incarnation)) throw Error('SESSION_IN_USE');
      const client = { ...identity, epoch, live: true, pending: 0, queue: [] }; clients.set(identity.session, client);
      publish();
      return Object.freeze({
        rebind(input) {
          const fresh = authenticate(input, { uid, secret });
          if (fresh.session !== client.session || fresh.incarnation !== client.incarnation) throw Error('IPC_AUTH');
          if (!client.live || clients.get(client.session) !== client) throw Error('CLIENT_DISCONNECTED');
          if (state !== 'connected' || paused || closed || client.epoch === epoch) throw Error('REBIND_UNAVAILABLE');
          // The authenticated old channel can deliberately replace its handle;
          // another concurrent channel cannot seize a live session via attach.
          client.live = false;
          for (const task of client.queue) if (!task.finished) stopped(task, 'CLIENT_DISCONNECTED');
          try { if (endSession(client.session) !== true) throw Error(); }
          catch { revocationFault = true; broker.loseConnection(); throw Error('SESSION_REVOCATION_UNCONFIRMED'); }
          return broker.attach(input);
        },
        request(input) {
          let frame;
          try { frame = validate(input, validateRequest); } catch { return Promise.resolve(failure('INVALID_ARGUMENT')); }
          const key = client.session + ':' + frame.id, hash = digest(frame), prior = receipts.get(key);
          if (prior) return Promise.resolve(prior.hash === hash ? prior.promise.then(copy) : failure('DUPLICATE_MISMATCH'));
          if (!client.live) return Promise.resolve(failure('CLIENT_DISCONNECTED'));
          if (state !== 'connected') return Promise.resolve(failure(state === 'disconnected' ? 'DISCONNECTED' : state.toUpperCase().replaceAll('-', '_')));
          if (client.epoch !== epoch || paused) return Promise.resolve(failure('LEASE_LOST'));
          if (client.pending >= maxSession || active >= maxBroker || receipts.size >= maxReceipts) return Promise.resolve(failure('BACKPRESSURE'));
          let turn;
          try { turn = currentTurn(identity); } catch { return Promise.resolve(failure('PERMISSION_REQUIRED')); }
          if (typeof turn !== 'string' || !turn) return Promise.resolve(failure('PERMISSION_REQUIRED'));
          const scope = Object.freeze({ session: client.session, clientIncarnation: client.incarnation, turn, brokerEpoch: epoch, browserIncarnation, connectionId: socket.sessionId, operation: frame.id });
          const record = { hash }; record.promise = new Promise(r => { record.resolve = r; }); receipts.set(key, record);
          const controller = new AbortController(); const task = { frame, scope, client, record, epoch, socket, sessionId: socket.sessionId, controller, signal: controller.signal };
          active++; client.pending++; client.queue.push(task);
          task.timer = setTimeout(() => stopped(task, 'TIMEOUT'), timeoutMs);
          Promise.resolve().then(() => prepare(frame.args, scope, frame.operation)).then(plan => {
            if (task.finished) return;
            if (!plan || typeof plan.target !== 'string' || !plan.target) return stopped(task, 'PERMISSION_REQUIRED');
            const prepared = immutableJSON({ ...plan, ...scope, args: frame.args, operationName: frame.operation });
            initializeTransport(transportAuthority, prepared); task.plan = prepared;
            task.target = browserIncarnation + ':' + task.plan.target; pump();
          }).catch(() => { if (!task.finished) stopped(task, 'PERMISSION_REQUIRED'); });
          return record.promise.then(copy);
        },
        disconnect() {
          if (!client.live) return;
          client.live = false;
          try { if (endSession(client.session) !== true) throw Error('SESSION_REVOCATION_UNCONFIRMED'); }
          catch {
            revocationFault = true;
            broker.loseConnection();
          }
          publish();
          for (const task of client.queue) if (!task.finished) stopped(task, 'CLIENT_DISCONNECTED');
          // Session ids are never silently reused to access earlier receipts.
          if (idlePolicy === 'disconnect' && ![...clients.values()].some(c => c.live)) {
            broker.loseConnection();
          }
        },
      });
    },
  };
  brokers.add(broker); return broker;
}
