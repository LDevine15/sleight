import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { siteOrigin, verdict } from './policy.mjs';

export const CONTRACT_VERSION = 3;
export const SCOPE_KEYS = Object.freeze(['browser', 'broker', 'session', 'turn', 'target', 'lease',
  'frame', 'document', 'ref', 'origin']);
export const OPERATIONS = Object.freeze({ read: [], screenshot: [], network: [], console: [],
  open: ['url'], navigate: ['url'], click: [], fill: ['value'], paste: ['text'], key: ['key'],
  select: ['values'], check: ['checked'], scroll: ['deltaX', 'deltaY'], upload: ['files'], download: [], close: [], dialog: ['action', 'text'] });
const clone = value => structuredClone(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const authorities = new WeakSet(), transports = new WeakSet(), continuations = new WeakMap(), completions = new WeakMap(), steps = new WeakMap(), starts = new WeakMap(), preparations = new WeakMap();
const revocations = new WeakMap();
export const isAuthority = value => !!value && authorities.has(value);
// Fixed host lifecycle entry only; never registered as a model tool. It revokes
// local session capabilities synchronously without fabricating a user event.
export function revokeAuthoritySession(authority, session) {
  if (!authorities.has(authority) || !identifier(session)) throw Error('TRUSTED_AUTHORITY_REQUIRED');
  revocations.get(authority)(session); return true;
}

// Sorted serialization and private keyed digests bind arguments without exposing
// protected data or a reusable equality oracle. Reject non-data before hashing.
export function canonical(value, depth = 0) {
  if (depth > 20) throw new Error('data depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) throw new Error('data array');
    const entries = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !('value' in descriptor)) throw new Error('data array');
      entries.push(canonical(descriptor.value, depth + 1));
    }
    return `[${entries.join(',')}]`;
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('plain data required');
  return `{${Object.keys(value).sort().map(key => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('data key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('data getter');
    return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1)}`;
  }).join(',')}}`;
}
function validateScope(scope) {
  if (!scope || Object.keys(scope).length !== SCOPE_KEYS.length) throw new Error('scope');
  for (const key of SCOPE_KEYS) {
    if (key === 'origin') {
      if (typeof scope[key] !== 'string' || scope[key].length > 2048) throw new Error('scope');
    } else if (!identifier(scope[key]) && !(Number.isSafeInteger(scope[key]) && scope[key] >= 0)) throw new Error('scope');
  }
}
function validateOperation(operation) {
  if (Buffer.byteLength(canonical(operation)) > 65536) throw new Error('operation size');
  const keys = new Set(['id', 'kind', 'args', 'scope', 'consequence', 'terms', 'submit', 'pageComplete']);
  if (Object.keys(operation).some(key => !keys.has(key)) || !identifier(operation.id) ||
      !Object.hasOwn(OPERATIONS, operation.kind)) throw new Error('operation');
  validateScope(operation.scope);
  const allowed = OPERATIONS[operation.kind];
  if (!operation.args || Object.keys(operation.args).some(key => !allowed.includes(key))) throw new Error('arguments');
  const a = operation.args;
  if (['fill', 'paste', 'key', 'navigate', 'open'].includes(operation.kind) &&
      typeof a[{ fill: 'value', paste: 'text', key: 'key', navigate: 'url', open: 'url' }[operation.kind]] !== 'string') throw new Error('arguments');
  if (operation.kind === 'check' && typeof a.checked !== 'boolean') throw new Error('arguments');
  if (operation.kind === 'scroll' && ![a.deltaX, a.deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) throw new Error('arguments');
  if (['upload', 'select'].includes(operation.kind)) {
    const values = a[operation.kind === 'upload' ? 'files' : 'values'];
    if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(v => typeof v !== 'string')) throw new Error('arguments');
  }
  if (operation.submit !== undefined && typeof operation.submit !== 'boolean') throw Error('submit');
  if (operation.pageComplete !== undefined && typeof operation.pageComplete !== 'boolean') throw Error('page state');
  if (operation.kind === 'dialog' && !['accept', 'dismiss'].includes(a.action)) throw new Error('arguments');
  if (['navigate', 'open'].includes(operation.kind)) siteOrigin(operation);
}

/** Authority core; activation requires qualified host providers. The integration owns current/process/frame evidence,
 * classify (actual semantics and submit/payment intent), authenticate (trusted UI
 * or user-message channel), and synchronous final dispatch. snapshot must return
 * {scope, time} from one coherent trusted host state at the transport boundary.
 * Separate current()/now() reads cannot implement that guarantee. This private
 * dependency has no qualified live provider yet; missing providers refuse dispatch.
 * No model endpoint may expose user(), observe(), verify(), recovery import or classify. Missing
 * authentic integration must refuse; these callbacks are not proof of a user. */
export function createAuthority({ current, classify, authenticate, snapshot, now = Date.now,
  ttl = 5000, confirmPayments = process.env.SLEIGHT_CONFIRM_PAYMENTS, checkTarget, recovery = [] } = {}) {
  if (![current, classify, authenticate].every(f => typeof f === 'function') || !Number.isFinite(ttl) || ttl <= 0 || ttl > 30000)
    throw new Error('trusted boundaries required');
  const secret = randomBytes(32), confirmations = new Map(), requests = new Map(), revocationsBySession = new Map();
  const capabilities = new Map(), records = new Map(), quarantined = new Set();
  let fence = 0, active = true;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('capability clock invalid');
    return value;
  };
  const digest = value => createHmac('sha256', secret).update(canonical(value)).digest('hex');
  const targetKey = scope => canonical(SCOPE_KEYS.filter(key => key !== 'ref').map(key => scope[key]));
  const exactTerms = (op, req) => op.terms && req?.terms &&
    ['item', 'method'].every(k => typeof op.terms[k] === 'string' && op.terms[k]) && digest(op.terms) === digest(req.terms);
  const paymentKey = op => digest(op.terms ? [op.scope.session, op.terms] : [op.id, op.kind, op.args, op.scope]);
  const decide = op => verdict(op, { confirmed: confirmations.has(paymentKey(op)), confirmPayments,
    exactRequest: exactTerms(op, requests.get(op.scope.session)) });
  const submit = op => op.submit === true || op.consequence === 'payment' && op.args?.action !== 'dismiss';
  const checkedTarget = op => {
    if (!['click', 'fill', 'paste', 'key', 'select', 'check', 'upload'].includes(op.kind)) return true;
    if (typeof checkTarget !== 'function') return false;
    const state = checkTarget(clone(op));
    canonical(state);
    return state && ['present', 'visible', 'enabled', 'same'].every(k => state[k] === true);
  };
  const record = (op, phase) => ({ id: op.id, scope: clone(op.scope), kind: op.kind, phase, effect: 'untouched', submit: submit(op) });
  const unknown = r => {
    // Independent effect proof is stronger than a late transport failure.
    if (r.phase === 'verified') return;
    r.phase = 'unknown'; r.effect = 'unknown'; delete r.result;
    if (r.submit) quarantined.add(targetKey(r.scope));
  };
  if (!Array.isArray(recovery) || recovery.length > 1024) throw new Error('recovery size');
  for (const r of recovery) {
    validateScope(r.scope);
    if (!identifier(r.id) || !Object.hasOwn(OPERATIONS, r.kind) ||
      !['prepared', 'dispatched', 'observed', 'verified', 'unknown'].includes(r.phase)) throw new Error('recovery');
    const retained = record(r, r.phase);
    if (['unknown', 'dispatched', 'observed'].includes(r.phase)) unknown(retained);
    else if (r.phase === 'verified') { retained.effect = 'verified'; retained.result = 'verified'; }
    records.set(r.id, retained);
  }
  const cancel = session => {
    if (!session) { fence++; capabilities.clear(); }
    else for (const [token, cap] of capabilities) if (cap.op.scope.session === session) capabilities.delete(token);
    if (session) revocationsBySession.set(session, (revocationsBySession.get(session) ?? 0) + 1);
    for (const [key] of requests) if (!session || key === session) requests.delete(key);
    for (const [hash, owner] of confirmations) if (!session || owner === session) confirmations.delete(hash);
    for (const r of records.values()) if ((!session || r.scope.session === session) &&
      ['dispatched', 'observed'].includes(r.phase)) unknown(r);
  };
  function user(event, action, data) {
    canonical(data);
    if (authenticate(event) !== true) throw new Error('user authority required');
    if (action === 'confirm') {
      validateOperation(data.operation);
      if (data.operation.consequence !== 'payment') throw Error('payment confirmation only');
      confirmations.set(paymentKey(data.operation), data.operation.scope.session);
    } else if (action === 'request') {
      if (!identifier(data.session) || data.consequence !== 'payment' || !data.terms ||
          !['item', 'method'].every(k => typeof data.terms[k] === 'string' && data.terms[k])) throw Error('user payment request');
      requests.set(data.session, clone(data));
    } else if (action === 'decline') {
      const op = data.operation; validateOperation(op);
      confirmations.delete(paymentKey(op));
      if (exactTerms(op, requests.get(op.scope.session))) requests.delete(op.scope.session);
    } else if (['revoke', 'end-session', 'pause', 'disconnect', 'detach', 'setting-off', 'takeover'].includes(action)) {
      cancel(data.session); if (action !== 'revoke' && action !== 'end-session') active = false;
    } else if (action === 'reconnect' || action === 'resume') {
      cancel(); active = true; revocationsBySession.clear(); // explicit authenticated control
    } else throw new Error('user action');
  }
  function prepare(raw, limit = Infinity) {
    try {
      validateOperation(raw);
      const op = classify(clone(raw)); validateOperation(op);
      // Classification may add semantic intent, but may not swap its route/args.
      if (digest([raw.id, raw.kind, raw.args, raw.scope]) !== digest([op.id, op.kind, op.args, op.scope])) throw new Error('classification');
      if (!active || submit(op) && quarantined.has(targetKey(op.scope))) return { verdict: 'deny', reason: 'fenced-or-unknown' };
      if (digest(op.scope) !== digest(current())) return { verdict: 'deny', reason: 'scope-fence' };
      const hash = digest(op), decision = decide(op);
      if (decision.verdict !== 'allow') return decision;
      if (!checkedTarget(op)) return { verdict: 'deny', reason: 'target-check' };
      if (records.has(op.id)) return { verdict: 'deny', reason: 'operation-already-prepared' };
      if (records.size >= 1024) return { verdict: 'deny', reason: 'receipt-bank-full' };
      const issued = clock(), deadline = Math.min(issued + ttl, limit);
      if (!Number.isFinite(deadline) || deadline <= issued || deadline > Number.MAX_SAFE_INTEGER) throw new Error('capability deadline invalid');
      const capability = randomUUID();
      capabilities.set(capability, { sessionEpoch: revocationsBySession.get(op.scope.session) ?? 0, op: clone(op), hash, rawHash: digest(raw), fence, issued, deadline });
      records.set(op.id, record(op, 'prepared'));
      return { ...decision, capability, receipt: clone(records.get(op.id)) };
    } catch { return { verdict: 'deny', reason: 'invalid-operation' }; }
  }
  function dispatch(capability, raw, send, retained = false, window, owned) {
    validateOperation(raw);
    if (window !== undefined) canonical(window);
    if (window !== undefined && (Object.keys(window).length !== 2 ||
        ![window.issued, window.expires].every(v => Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) ||
        window.expires <= window.issued)) throw Error('capability window');
    const cap = owned ?? capabilities.get(capability);
    const started = clock();
    if (!cap || started < cap.issued || started >= cap.deadline || digest(raw) !== cap.rawHash) throw new Error('capability mismatch, expired or spent');
    try {
      const fresh = classify(clone(raw)); validateOperation(fresh);
      if (digest(fresh) !== cap.hash || decide(fresh).verdict !== 'allow' || !checkedTarget(fresh)) throw new Error('authority changed');
    } catch { throw new Error('dispatch fence: classification or authority changed'); }
    // Reconcile all synchronous trusted callbacks before the final state/time
    // check. current() can revoke authority or outlive the capability's expiry.
    const actual = current();
    if (!active || (!owned && capabilities.get(capability) !== cap) || cap.fence !== fence || digest(cap.op.scope) !== digest(actual) ||
      decide(cap.op).verdict !== 'allow' || (revocationsBySession.get(cap.op.scope.session) ?? 0) !== cap.sessionEpoch || submit(cap.op) && quarantined.has(targetKey(cap.op.scope))) throw new Error('dispatch fence');
    if (typeof send !== 'function') throw new Error('dispatch function');
    const finalTime = clock();
    // The clock callback may replace target/frame/document/lease identity.
    // Serialize that legacy scope before taking the joint terminal snapshot.
    const finalScope = current();
    const finalScopeHash = digest(finalScope);
    let terminal;
    try {
      if (typeof snapshot !== 'function') throw new Error('unavailable');
      terminal = snapshot();
      if (types.isPromise(terminal)) {
        Promise.prototype.then.call(terminal, undefined, () => {});
        throw new Error('asynchronous');
      }
      if (!terminal || types.isProxy(terminal)) throw new Error('non-data');
      const fields = Object.getOwnPropertyDescriptors(terminal);
      if (types.isProxy(fields.scope?.value)) throw new Error('non-data scope');
      canonical(terminal); // Reject accessor or non-data snapshots before reading fields.
      if (!terminal || Object.keys(terminal).length !== 2 || !Object.hasOwn(terminal, 'scope') || !Object.hasOwn(terminal, 'time'))
        throw new Error('shape');
      validateScope(terminal.scope);
    } catch { throw new Error('dispatch fence: coherent snapshot unavailable'); }
    // No current/clock/integration callback follows this joint snapshot.
    // The provider cannot grant authority: internal state is checked after it.
    if (!Number.isFinite(terminal.time) || terminal.time < finalTime || terminal.time < started ||
      terminal.time < cap.issued || terminal.time >= cap.deadline || !active || (!owned && capabilities.get(capability) !== cap) || cap.fence !== fence ||
      digest(cap.op.scope) !== finalScopeHash || digest(cap.op.scope) !== digest(terminal.scope) || (revocationsBySession.get(cap.op.scope.session) ?? 0) !== cap.sessionEpoch || submit(cap.op) && quarantined.has(targetKey(cap.op.scope)) ||
      window !== undefined && (terminal.time < window.issued || terminal.time >= window.expires) ||
      decide(cap.op).verdict !== 'allow') throw new Error('dispatch fence');
    if (!retained) capabilities.delete(capability);
    const r = records.get(cap.op.id); r.phase = 'dispatched'; r.effect = 'unknown';
    // No await or preparation between the final check and transport dispatch.
    // A promise represents a sent request, never evidence it took effect.
    try { const pending = send(clone(cap.op));
      if (pending && typeof pending.then === 'function') pending.catch(() => unknown(r));
    } catch { unknown(r); }
    return clone(r);
  }
  function observe(id) {
    const r = records.get(id);
    if (!r || r.phase !== 'dispatched') throw new Error('receipt phase');
    r.phase = 'observed'; return clone(r);
  }
  function verify(id, proof) {
    if (!['verified', 'protected', 'unverifiable', 'unchanged'].includes(proof)) throw new Error('proof');
    const r = records.get(id);
    if (!r || r.phase !== 'observed') throw new Error('receipt phase');
    r.phase = proof === 'unverifiable' ? 'unknown' : 'verified';
    r.effect = r.phase === 'verified' ? 'verified' : 'unknown'; r.result = proof;
    if (r.phase === 'unknown' && r.submit) quarantined.add(targetKey(r.scope));
    if (r.phase === 'verified' && r.kind === 'read') quarantined.delete(targetKey(r.scope));
    return clone(r);
  }
  function timeout(id) { const r = records.get(id); if (r && ['dispatched', 'observed'].includes(r.phase)) unknown(r); }
  const authority = Object.freeze({ user, prepare, dispatch: (capability, raw, send) => dispatch(capability, raw, send), observe, verify, timeout,
    receipt: id => records.has(id) ? clone(records.get(id)) : null,
    recovery: () => [...records.values()].map(clone) });
  authorities.add(authority);
  revocations.set(authority, cancel);
  // Physical commands share a request deadline and revocation fence. No field
  // permission token is issued or consumed. Trusted resolution checks each target.
  continuations.set(authority, {
    deadline: () => clock() + ttl,
    sessionEpoch: session => revocationsBySession.get(session) ?? 0,
    fence: () => fence,
    enter(raw, deadline, send, window, sessionEpoch, requestFence) {
      validateOperation(raw);
      const op = classify(clone(raw)); validateOperation(op);
      if (digest([raw.id, raw.kind, raw.args, raw.scope]) !== digest([op.id, op.kind, op.args, op.scope])) throw Error('classification');
      const issued = clock();
      const prior = records.get(op.id);
      if (prior && ['verified', 'unknown'].includes(prior.phase)) throw Error('TRANSPORT_SPENT');
      if (!prior) {
        if (records.size >= 1024) throw Error('receipt-bank-full');
        records.set(op.id, record(op, 'prepared'));
      }
      return dispatch(undefined, raw, send, true, window, { op, hash: digest(op), rawHash: digest(raw), fence: requestFence, issued, deadline, sessionEpoch });
    },
    complete(id, effect) {
      const r = records.get(id);
      if (!r || r.phase !== 'dispatched') return;
      if (['verified', 'protected', 'unchanged'].includes(effect)) { observe(id); verify(id, effect); }
      else timeout(id);
    },
  });
  return authority;
}

// Trusted semantic joining code resolves a closed classified operation before
// the R4 fence. The transport closure is invoked inside that fence, with no
// asynchronous adapter work or host callbacks after its coherent snapshot.
export function createTransportAuthority({ authority, resolveOperation }) {
  if (!authorities.has(authority) || typeof resolveOperation !== 'function') throw Error('TRUSTED_AUTHORITY_REQUIRED');
  const plans = new WeakMap(), finished = new WeakSet(), internal = continuations.get(authority);
  function journal(plan) {
    let state = plans.get(plan);
    if (!state) {
      const list = plan.orderedOperations, preparation = plan.preparationOperations ?? [];
      if (list !== undefined) {
        if (!Array.isArray(list) || !list.length || list.length > 50 || !Array.isArray(preparation) || preparation.length > 100) throw Error('TRANSPORT_ORDER_REQUIRED');
        for (const op of [...list, ...preparation]) validateOperation(op);
        if (preparation.some(op => !['read', 'screenshot', 'network', 'console', 'scroll'].includes(op.kind)) ||
            new Set([...list, ...preparation].map(op => op.id)).size !== list.length + preparation.length) throw Error('TRANSPORT_ORDER_REQUIRED');
      }
      state = { list, preparation, fence: internal.fence(), deadline: internal.deadline(), entries: new Map(), index: 0,
        sessionEpoch: plan.session ? internal.sessionEpoch(plan.session) : undefined };
      plans.set(plan, state);
    }
    return state;
  }
  const transport = (plan, scope, command, enter) => {
    if (finished.has(plan)) throw Error('TRANSPORT_SPENT');
    const operation = resolveOperation(plan, scope, command);
    if (!operation?.scope || operation.scope.session !== scope.session || operation.scope.turn !== scope.turn ||
        operation.scope.browser !== scope.browserIncarnation || operation.scope.broker !== scope.brokerEpoch ||
        operation.scope.target !== plan.target) throw Error('TRANSPORT_SCOPE_MISMATCH');
    const state = journal(plan);
    if (state.scope && state.scope !== canonical(scope)) throw Error('TRANSPORT_SCOPE_MISMATCH');
    state.scope = canonical(scope);
    state.sessionEpoch ??= internal.sessionEpoch(scope.session);
    if (state.list) {
      const index = state.list.findIndex(op => op.id === operation.id);
      const expected = index >= 0 ? state.list[index] : state.preparation.find(op => op.id === operation.id);
      if (!expected || canonical(expected) !== canonical(operation)) throw Error('TRANSPORT_OPERATION_MISMATCH');
      // Ordinary steps need no effect proof to continue. An uncertain submit is
      // fenced inside authority.enter until a delivered fresh read completes.
      if (index >= 0 && index !== state.index) {
        if (index !== state.index + 1) throw Error('TRANSPORT_STEP_ORDER');
        const previous = state.entries.get(state.list[state.index].id);
        if (!previous || previous.pending) throw Error('TRANSPORT_STEP_ORDER');
        if (authority.receipt(previous.id)?.submit) internal.complete(previous.id, 'unknown');
        state.index++;
      }
    }
    let entry = state.entries.get(operation.id);
    if (entry && entry.operation !== canonical(operation)) throw Error('TRANSPORT_OPERATION_MISMATCH');
    if (!entry) { entry = { id: operation.id, operation: canonical(operation), pending: 0 }; state.entries.set(operation.id, entry); }
    let entered = false, value, error;
    internal.enter(operation, state.deadline, () => {
      entered = true;
      try { value = enter(); return value; } catch (e) { error = e; throw e; }
    }, command.window, state.sessionEpoch, state.fence);
    if (!entered || error) throw Error('TRANSPORT_AUTHORITY_REQUIRED');
    if (types.isPromise(value)) {
      entry.pending++;
      Promise.prototype.then.call(value, () => { entry.pending--; }, () => { entry.pending--; });
    }
    return value;
  };
  completions.set(transport, (plan, effect) => {
    finished.add(plan);
    const state = plans.get(plan);
    if (!state) return;
    for (const entry of state.entries.values()) internal.complete(entry.id, effect);
    if (state.list) {
      let completed = 0;
      while (completed < state.list.length && authority.receipt(state.list[completed].id)?.phase === 'verified') completed++;
      const next = authority.receipt(state.list[completed]?.id), unknownStep = next?.effect === 'unknown' ? completed : null;
      return { completed, unknownStep, untouched: state.list.length - completed - (unknownStep === null ? 0 : 1) };
    }
  });
  starts.set(transport, journal);
  steps.set(transport, (plan, index, effect) => {
    if (finished.has(plan)) throw Error('TRANSPORT_SPENT');
    const state = journal(plan), op = state.list?.[index], entry = op && state.entries.get(op.id);
    if (!op || index !== state.index || !['verified', 'protected', 'unchanged'].includes(effect)) throw Error('TRANSPORT_STEP_ORDER');
    if (!entry || entry.pending || authority.receipt(op.id)?.phase !== 'dispatched') throw Error('TRANSPORT_STEP_UNPROVED');
    internal.complete(op.id, effect); state.index++;
  });
  preparations.set(transport, (plan, id, effect) => {
    const state = journal(plan), entry = state.entries.get(id);
    if (finished.has(plan) || !state.preparation.some(op => op.id === id) || !entry || entry.pending ||
        !['verified', 'protected', 'unchanged'].includes(effect)) throw Error('TRANSPORT_STEP_UNPROVED');
    internal.complete(id, effect);
  });
  transports.add(transport); return transport;
}

export const isTransportAuthority = transport => transports.has(transport);
export function completeTransport(transport, plan, effect) {
  if (!transports.has(transport)) throw Error('TRUSTED_AUTHORITY_REQUIRED');
  return completions.get(transport)(plan, effect);
}
export function completeTransportStep(transport, plan, index, effect) {
  if (!transports.has(transport)) throw Error('TRUSTED_AUTHORITY_REQUIRED');
  return steps.get(transport)(plan, index, effect);
}
export function initializeTransport(transport, plan) {
  if (!transports.has(transport)) throw Error('TRUSTED_AUTHORITY_REQUIRED');
  starts.get(transport)(plan);
}
export function completeTransportPreparation(transport, plan, id, effect) {
  if (!transports.has(transport)) throw Error('TRUSTED_AUTHORITY_REQUIRED');
  return preparations.get(transport)(plan, id, effect);
}

export function receiptPrefix(receipts, orderedIds) {
  const completed = [], pending = [];
  let stopped = false;
  receipts.forEach((r, i) => {
    if (r.id !== orderedIds[i]) throw new Error('receipt prefix');
    if (r.phase === 'verified' && !stopped) completed.push(r.id);
    else { stopped = true; pending.push(r.id); }
  });
  return { completed, pending, untouched: orderedIds.slice(receipts.length) };
}
