import { createHash } from 'node:crypto';
import { authenticate, immutableJSON, FRAME_LIMIT } from './ipc.mjs';
import { createScopedAdapter } from './scoped-adapter.mjs';

const operations = new Set(['browser_open', 'browser_read', 'browser_act', 'browser_fill']);
const effects = new Set(['verified', 'unchanged', 'protected', 'unverifiable', 'unknown', 'none']);
const connectionStates = new Set(['disconnected', 'setting-off', 'unsupported', 'approval-pending', 'declined', 'stale-instance']);
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
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
  verifyConnection, currentTurn, validateRequest, prepare, authorize, dispatchFence, dispatch, redact,
  disconnect: closeConnection = () => {}, timeoutMs = 3000, maxSession = 32, maxBroker = 128, maxReceipts = 1024 }) {
  if (!['retain', 'disconnect'].includes(idlePolicy)) throw Error('IDLE_POLICY_REQUIRED');
  if (typeof browserIncarnation !== 'string' || !browserIncarnation ||
      [openConnection, verifyConnection, currentTurn, validateRequest, prepare, authorize, dispatchFence, dispatch, redact, closeConnection].some(f => typeof f !== 'function')) throw Error('TRUSTED_CONTRACT_REQUIRED');
  authenticate({ version: 1, secret, uid, session: 'validation', incarnation: 'validation' }, { uid, secret });
  for (const [value, ceiling] of [[timeoutMs, 30000], [maxSession, 32], [maxBroker, 128], [maxReceipts, 4096]])
    if (!Number.isInteger(value) || value < 1 || value > ceiling) throw Error('BROKER_LIMIT');
  const clients = new Map(), receipts = new Map(), occupied = new Set(), quarantined = new Set();
  let state = 'disconnected', epoch = 0, socket, connecting, active = 0, paused = false, cursor = 0;
  const safe = observation => immutableJSON(redact(observation ?? null));
  const live = task => task.client.live && state === 'connected' && !paused && task.epoch === epoch && task.client.epoch === epoch &&
    socket === task.socket && socket.sessionId === task.sessionId && currentTurn(task.client) === task.scope.turn && !task.signal.aborted;
  function finish(task, response) {
    if (task.finished) return;
    task.finished = true; clearTimeout(task.timer); active--; task.client.pending--;
    if (task.running && task.target) occupied.delete(task.target);
    task.record.receipt = immutableJSON({ operation: task.frame.id, ...response });
    task.record.resolve(task.record.receipt);
    pump();
  }
  function stopped(task, code) {
    if (task.dispatched && task.target) quarantined.add(task.target);
    task.controller.abort();
    finish(task, failure(code, task.dispatched ? 'unknown' : 'none', task.dispatched ? 'unknown' : 'prepared'));
  }
  async function execute(task) {
    try {
      if (!live(task)) return stopped(task, 'LEASE_LOST');
      if (quarantined.has(task.target)) return stopped(task, 'STATE_UNVERIFIABLE');
      const authority = await authorize(task.plan, task.scope);
      if (!live(task)) return stopped(task, 'LEASE_LOST');
      // A fence must be synchronous so no user callback/await interposes before
      // the internal adapter entry. One-operation capability consumption belongs
      // here in the injected trusted BP2-1 policy, never in frontend arguments.
      if (authority !== true || dispatchFence(task.plan, task.scope) !== true) return finish(task, failure('PERMISSION_REQUIRED'));
      if (!live(task)) return stopped(task, 'LEASE_LOST');
      task.dispatched = true;
      const guardedSession = Object.freeze({ sessionId: socket.sessionId,
        send(...args) { if (!live(task)) throw Error('LEASE_LOST'); return task.socket.send(...args); },
        on: task.socket.on.bind(task.socket), off: task.socket.off.bind(task.socket) });
      const result = await dispatch(task.plan, { ...task.scope, session: guardedSession, signal: task.signal });
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
      if (result.effect === 'unknown') quarantined.add(task.target);
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
  }
  return {
    status: () => ({ state: paused && state === 'connected' ? 'paused' : state, epoch, clients: [...clients.values()].filter(c => c.live).length, pending: active }),
    async connect({ userInitiated } = {}) {
      if (userInitiated !== true) throw Error('EXPLICIT_CONNECT_REQUIRED');
      if (state === 'connected') return;
      if (connecting) return connecting;
      state = 'approval-pending'; const expected = ++epoch;
      connecting = (async () => {
        let candidate;
        try {
          candidate = await openConnection();
          if (expected !== epoch || state !== 'approval-pending') { closeConnection(candidate); throw Error('CONNECT_CANCELLED'); }
          if (!candidate || typeof candidate.sessionId !== 'string' || !candidate.sessionId ||
              ['send', 'on', 'off'].some(k => typeof candidate[k] !== 'function') || await verifyConnection(candidate, browserIncarnation) !== true) throw Error('STALE_INSTANCE');
          if (expected !== epoch || state !== 'approval-pending') { closeConnection(candidate); throw Error('CONNECT_CANCELLED'); }
          socket = candidate; state = 'connected';
        } catch (error) {
          if (expected === epoch) { if (candidate) closeConnection(candidate); state = error.message === 'STALE_INSTANCE' ? 'stale-instance' : 'disconnected'; }
          throw error;
        } finally { connecting = undefined; }
      })();
      return connecting;
    },
    loseConnection(nextState = 'disconnected') {
      if (!connectionStates.has(nextState)) throw Error('INVALID_CONNECTION_STATE');
      const prior = socket; invalidate(nextState); if (prior) closeConnection(prior);
    },
    pause() { paused = true; for (const c of clients.values()) for (const task of c.queue) if (!task.finished) stopped(task, 'USER_TAKEOVER'); },
    attach(input) {
      const identity = authenticate(input, { uid, secret });
      const existing = clients.get(identity.session);
      if (existing && (existing.live || existing.incarnation !== identity.incarnation || existing.epoch !== epoch)) throw Error('SESSION_IN_USE');
      const client = { ...identity, epoch, live: true, pending: 0, queue: [] }; clients.set(identity.session, client);
      return Object.freeze({
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
            task.plan = immutableJSON({ ...plan, ...scope, args: frame.args, operationName: frame.operation });
            task.target = browserIncarnation + ':' + task.plan.target; pump();
          }).catch(() => { if (!task.finished) stopped(task, 'PERMISSION_REQUIRED'); });
          return record.promise.then(copy);
        },
        disconnect() {
          if (!client.live) return;
          client.live = false;
          for (const task of client.queue) if (!task.finished) stopped(task, 'CLIENT_DISCONNECTED');
          // Session ids are never silently reused to access earlier receipts.
          if (idlePolicy === 'disconnect' && ![...clients.values()].some(c => c.live)) {
            const prior = socket; invalidate('disconnected'); if (prior) closeConnection(prior);
          }
        },
      });
    },
  };
}

// An explicitly TEST-ONLY vertical slice, restricted to one local fixture URL.
// BP2-1/3/4/6/7 supply production policy, refs, actionability and form semantics.
// No plugin imports this entry and no missing trusted UI becomes an allow.
export function createFixtureSlice({ url, session, uid, secret, idlePolicy }) {
  const selected = new URL(url);
  if (selected.protocol !== 'http:' || selected.hostname !== '127.0.0.1' || selected.username || selected.password || selected.search || selected.hash) throw Error('FIXTURE_URL_REQUIRED');
  const tabs = new Map(); let sequence = 0;
  const helpers = {
    read: { version: 1, source: function () {
      const nodes = [...document.querySelectorAll('button,input[type="text"]')];
      if (nodes.length > 50) throw Error('FIXTURE_LIMIT');
      const prior = globalThis.__sleightFixtureRefs;
      // Object identity persists only within this isolated document; new nodes
      // never inherit old refs, even if they have the same text/position.
      const refs = prior || { next: 0, nodes: new Map() }; globalThis.__sleightFixtureRefs = refs;
      return { url: location.href, ready: document.readyState === 'complete',
        text: [...document.querySelectorAll('output')].map(el => el.textContent.slice(0, 2000)).join('\n'),
        refs: nodes.map(el => {
          let ref = [...refs.nodes].find(([, record]) => record.el === el)?.[0];
          if (!ref) { ref = 'r' + (++refs.next); refs.nodes.set(ref, { el, name: el.getAttribute('aria-label') || el.textContent, type: el.type }); }
          const record = refs.nodes.get(ref), name = el.getAttribute('aria-label') || el.textContent;
          if (record.name !== name || record.type !== el.type) throw Error('STALE_REF');
          return { ref, role: el.tagName === 'BUTTON' ? 'button' : 'textbox', name: name.slice(0, 120),
            ...(el.tagName === 'INPUT' ? { value: el.value.slice(0, 2000) } : {}) };
        }) };
    }.toString() },
    point: { version: 1, source: function (ref) {
      const record = globalThis.__sleightFixtureRefs?.nodes.get(ref), el = record?.el;
      if (!el?.isConnected || record.name !== (el.getAttribute('aria-label') || el.textContent) || record.type !== el.type || el.disabled || el.readOnly) throw Error('STALE_REF');
      if (el.tagName !== 'BUTTON' && (el.tagName !== 'INPUT' || el.type !== 'text')) throw Error('FIXTURE_CONTROL');
      const rect = el.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!rect.width || !rect.height || (hit !== el && !el.contains(hit))) throw Error('NOT_ACTIONABLE');
      return { x, y, role: el.tagName === 'BUTTON' ? 'button' : 'textbox', value: el.tagName === 'INPUT' ? el.value : null };
    }.toString() },
  };
  const keys = (object, expected) => {
    if (!object || Array.isArray(object) || Object.keys(object).length !== expected.length || expected.some(k => !Object.hasOwn(object, k))) throw Error('INVALID_ARGUMENT');
  };
  const broker = createBroker({ uid, secret, idlePolicy, browserIncarnation: 'test-only-fixture-browser',
    connect: async () => session, verifyConnection: candidate => candidate === session, currentTurn: () => 'fixture-turn', redact: value => value,
    validateRequest(frame) {
      const args = frame.args;
      if (frame.operation === 'browser_open') { keys(args, ['browser', 'url']); if (args.browser !== 'bfixture' || args.url !== url) throw Error('INVALID_ARGUMENT'); }
      else if (frame.operation === 'browser_read') keys(args, ['tab']);
      else if (frame.operation === 'browser_act') { keys(args, ['tab', 'op', 'ref']); if (args.op !== 'click' || !/^r[1-9]\d*$/.test(args.ref)) throw Error('INVALID_ARGUMENT'); }
      else {
        keys(args, ['tab', 'fields']);
        if (!Array.isArray(args.fields) || args.fields.length !== 1) throw Error('INVALID_ARGUMENT');
        keys(args.fields[0], ['ref', 'value']);
        if (!/^r[1-9]\d*$/.test(args.fields[0].ref) || typeof args.fields[0].value !== 'string' || args.fields[0].value.length > 2000) throw Error('INVALID_ARGUMENT');
      }
      if (frame.operation !== 'browser_open' && (typeof args.tab !== 'string' || !/^t[1-9]\d*$/.test(args.tab))) throw Error('INVALID_ARGUMENT');
      return frame;
    },
    prepare(args, scope, operation) {
      if (operation === 'browser_open') return { target: 'create-' + scope.session };
      const record = tabs.get(args.tab);
      if (!record || record.closed || record.owner !== scope.session || record.epoch !== scope.brokerEpoch) throw Error('FOREIGN_TARGET');
      return { target: record.target };
    },
    authorize: () => true, dispatchFence: () => true, // explicit local fixture grant only
    async dispatch(plan, context) {
      const send = context.session.send;
      let record = tabs.get(plan.args.tab), tab = plan.args.tab;
      if (plan.operationName === 'browser_open') {
        const { targetId } = await send('Target.createTarget', { url, background: true });
        // Bank ownership immediately so a later attach/read error cannot erase it.
        tab = 't' + (++sequence); record = { target: targetId, owner: plan.session, epoch: plan.brokerEpoch, closed: false };
        tabs.set(tab, record);
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }); record.cdpSessionId = sessionId;
      }
      let { frameTree } = await send('Page.getFrameTree', {}, record.cdpSessionId);
      // Target creation acknowledges ownership before its initial navigation is
      // complete. Observe that owned blank document under the broker's existing
      // deadline; never attach any other target or wait out a foreign redirect.
      while (plan.operationName === 'browser_open' && frameTree.frame.url === 'about:blank') {
        await new Promise(resolve => setImmediate(resolve));
        ({ frameTree } = await send('Page.getFrameTree', {}, record.cdpSessionId));
      }
      if (frameTree.frame.url !== url || frameTree.childFrames?.length) throw Error('FIXTURE_DOCUMENT_CHANGED');
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'sleight-fixture-v1' }, record.cdpSessionId);
      const lease = { target: record.target, cdpSessionId: record.cdpSessionId, frame: frameTree.frame.id,
        origin: selected.origin, document: 1, epoch: plan.brokerEpoch, executionContextId };
      const adapter = createScopedAdapter({ session: context.session, helpers,
        checkLease: () => !record.closed && record.epoch === broker.status().epoch && broker.status().state === 'connected' });
      try {
        const view = adapter.forLease(lease);
        const fixed = async (name, args) => {
          const result = await view.callFixed(name, args);
          if (result.exceptionDetails || !result.result || !Object.hasOwn(result.result, 'value')) throw Error('FIXTURE_PROOF');
          return result.result.value;
        };
        let before = await fixed('read', []);
        while (plan.operationName === 'browser_open' && before.url === url && !before.ready) {
          await new Promise(resolve => setImmediate(resolve)); before = await fixed('read', []);
        }
        if (before.url !== url || !before.ready) throw Error('FIXTURE_NOT_READY');
        if (['browser_act', 'browser_fill'].includes(plan.operationName)) {
          const ref = plan.args.ref ?? plan.args.fields[0].ref;
          const point = await fixed('point', [ref]);
          if (plan.operationName === 'browser_fill' && point.role !== 'textbox') throw Error('FIXTURE_CONTROL');
          if (plan.operationName === 'browser_act' && point.role !== 'button') throw Error('FIXTURE_CONTROL');
          for (const type of ['mousePressed', 'mouseReleased']) await view.input('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
          if (plan.operationName === 'browser_fill') {
            for (const type of ['keyDown', 'keyUp']) await view.input('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2 });
            await view.input('Input.insertText', { text: plan.args.fields[0].value });
          }
        }
        const after = await fixed('read', []);
        if (after.url !== url || !after.ready) throw Error('FIXTURE_DOCUMENT_CHANGED');
        const proved = plan.operationName === 'browser_fill' ? after.refs.some(r => r.ref === plan.args.fields[0].ref && r.value === plan.args.fields[0].value)
          : plan.operationName === 'browser_act' ? after.text !== before.text : true;
        return { effect: proved ? 'verified' : 'unverifiable', observation: after, ...(plan.operationName === 'browser_open' ? { tab } : {}) };
      } finally { adapter.disconnect(); }
    },
  });
  return Object.freeze({ broker, url,
    async closeOwned(tab, owner) {
      const record = tabs.get(tab);
      if (!record || record.closed || record.owner !== owner || record.epoch !== broker.status().epoch || broker.status().state !== 'connected') throw Error('FOREIGN_TARGET');
      const result = await session.send('Target.closeTarget', { targetId: record.target });
      const inventory = await session.send('Target.getTargets', {});
      if (result.success !== true || inventory.targetInfos.some(t => t.targetId === record.target)) throw Error('CLEANUP_UNCONFIRMED');
      record.closed = true; return { closed: true, absent: true };
    },
  });
}
