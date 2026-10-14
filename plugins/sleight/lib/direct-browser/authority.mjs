import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { siteOrigin, verdict } from './policy.mjs';

export const CONTRACT_VERSION = 2;
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
  const keys = new Set(['id', 'kind', 'args', 'scope', 'consequence', 'terms', 'transmission']);
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
    if (operation.kind === 'upload' && (!operation.transmission ||
      canonical(values) !== canonical(operation.transmission.files) || values.some(v => !v.startsWith('/') || v.split('/').includes('..'))))
      throw new Error('file capability');
  }
  if (operation.kind === 'dialog' && !['accept', 'dismiss'].includes(a.action)) throw new Error('arguments');
  if (operation.kind === 'navigate' || operation.kind === 'open') {
    const origin = siteOrigin(operation);
    // Only literal bare origins/root URLs are exempt. URL parsing can erase
    // paths, empty delimiters and whitespace from the submitted data.
    if (a.url !== origin && a.url !== `${origin}/` && !operation.transmission) throw new Error('URL transmission');
  }
  if (operation.transmission) {
    const destination = new URL(operation.transmission.destination);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password ||
      typeof operation.transmission.data !== 'string') throw new Error('transmission');
    if ((operation.kind === 'fill' && operation.transmission.data !== a.value) ||
      (operation.kind === 'paste' && operation.transmission.data !== a.text)) throw new Error('transmission payload');
    if ((operation.kind === 'navigate' || operation.kind === 'open') &&
      (destination.origin !== siteOrigin(operation) || operation.transmission.data !== a.url)) throw new Error('transmission URL');
  }
}

/** Authority core; activation requires qualified host providers. The integration owns current/process/frame evidence,
 * classify (actual semantics, data and canonical files), authenticate (trusted UI
 * or user-message channel), and synchronous final dispatch. snapshot must return
 * {scope, time} from one coherent trusted host state at the transport boundary.
 * Separate current()/now() reads cannot implement that guarantee. This private
 * dependency has no qualified live provider yet; missing providers refuse dispatch.
 * No model endpoint may expose user(), observe(), verify(), recovery import or classify. Missing
 * authentic integration must refuse; these callbacks are not proof of a user. */
export function createAuthority({ current, classify, authenticate, snapshot, now = Date.now,
  ttl = 5000, confirmPayments = process.env.SLEIGHT_CONFIRM_PAYMENTS, persistAlways, recovery = [] } = {}) {
  if (![current, classify, authenticate].every(f => typeof f === 'function') || !Number.isFinite(ttl) || ttl <= 0 || ttl > 30000)
    throw new Error('trusted boundaries required');
  const secret = randomBytes(32), grants = new Map(), confirmations = new Map(), requests = new Map(), paymentUses = new Map();
  const capabilities = new Map(), records = new Map(), quarantined = new Set();
  let fence = 0, active = true;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('capability clock invalid');
    return value;
  };
  const digest = value => createHmac('sha256', secret).update(canonical(value)).digest('hex');
  const siteKey = scope => canonical([scope.session, scope.origin]);
  const operationSiteKey = op => siteKey({ ...op.scope, origin: siteOrigin(op) });
  const targetKey = scope => canonical([scope.session, scope.target]);
  const requestKey = (session, consequence) => canonical([session, consequence]);
  const exactTerms = (op, req) => {
    if (!req || !op.terms || !req.terms) return false;
    if (op.consequence === 'payment' && ['item', 'payee', 'amount', 'currency', 'plan', 'method'].some(k =>
      typeof op.terms[k] !== 'string' || !op.terms[k])) return false;
    return digest(op.terms) === digest(req.terms);
  };
  const decide = (op, cap) => verdict(op, { site: cap?.consumed || grants.has(operationSiteKey(op)),
    confirmed: cap?.consumed && cap.confirmed || confirmations.has(digest(op)), confirmPayments,
    exactRequest: exactTerms(op, requests.get(requestKey(op.scope.session, op.consequence))) &&
      (cap?.consumed || op.consequence !== 'payment' || !paymentUses.get(requestKey(op.scope.session, 'payment'))?.has(op.kind === 'dialog' ? 'dialog' : 'pay')),
    transmission: op.transmission && digest(op.transmission) === digest(requests.get(requestKey(op.scope.session, 'transmission'))?.transmission ?? null) });
  const record = (op, phase) => ({ id: op.id, scope: clone(op.scope), kind: op.kind, phase, effect: 'untouched' });
  const unknown = r => {
    // Independent effect proof is stronger than a late transport failure.
    if (r.phase === 'verified') return;
    r.phase = 'unknown'; r.effect = 'unknown'; delete r.result;
    quarantined.add(targetKey(r.scope));
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
    for (const [key] of grants) if (!session || JSON.parse(key)[0] === session) grants.delete(key);
    for (const [key] of requests) if (!session || JSON.parse(key)[0] === session) { requests.delete(key); paymentUses.delete(key); }
    for (const [hash, owner] of confirmations) if (!session || owner === session) confirmations.delete(hash);
    for (const r of records.values()) if ((!session || r.scope.session === session) &&
      ['dispatched', 'observed'].includes(r.phase)) unknown(r);
  };
  function user(event, action, data) {
    canonical(data);
    if (authenticate(event) !== true) throw new Error('user authority required');
    if (action === 'grant') {
      if (!identifier(data.session) || !['once', 'session'].includes(data.mode) ||
        verdict({ scope: { origin: data.origin }, consequence: 'ordinary' }, { site: true }).verdict !== 'allow') throw new Error('grant');
      grants.set(canonical([data.session, data.origin]), data.mode);
    } else if (action === 'confirm') {
      validateOperation(data.operation); confirmations.set(digest(data.operation), data.operation.scope.session);
    } else if (action === 'request') {
      if (!identifier(data.session)) throw new Error('request');
      requests.set(requestKey(data.session, data.consequence), clone(data));
      if (data.consequence === 'payment') paymentUses.set(requestKey(data.session, 'payment'), new Set());
    } else if (action === 'always') {
      if (typeof persistAlways !== 'function') throw new Error('permanent UI integration unavailable');
      if (verdict({ scope: { origin: data.origin }, consequence: 'ordinary' }, { site: true }).verdict !== 'allow') throw new Error('origin');
      persistAlways(clone(data));
    } else if (action === 'decline') {
      // Retire only matching positive authority, without caching the decline.
      const op = data.operation; validateOperation(op);
      const hash = digest(op), key = requestKey(op.scope.session, op.consequence);
      const retiredRequest = exactTerms(op, requests.get(key));
      const transmissionKey = requestKey(op.scope.session, 'transmission');
      const retiredTransmission = op.transmission && digest(op.transmission) ===
        digest(requests.get(transmissionKey)?.transmission ?? null);
      if (retiredRequest) { requests.delete(key); paymentUses.delete(key); }
      if (retiredTransmission) requests.delete(transmissionKey);
      confirmations.delete(hash);
      for (const [token, cap] of capabilities) {
        if (cap.hash === hash || cap.op.scope.session === op.scope.session &&
          (retiredRequest && cap.op.consequence === op.consequence && exactTerms(cap.op, { terms: op.terms }) ||
           retiredTransmission && cap.op.transmission && digest(cap.op.transmission) === digest(op.transmission))) capabilities.delete(token);
      }
    } else if (['revoke', 'end-session', 'pause', 'disconnect', 'detach', 'setting-off', 'takeover'].includes(action)) {
      cancel(data.session); if (action !== 'revoke' && action !== 'end-session') active = false;
    } else if (action === 'reconnect' || action === 'resume') {
      cancel(); active = true; // explicit user event; fresh scope and grants still required
    } else throw new Error('user action');
  }
  function prepare(raw, limit = Infinity) {
    try {
      validateOperation(raw);
      const op = classify(clone(raw)); validateOperation(op);
      // Classification may add semantic intent, but may not swap its route/args.
      if (digest([raw.id, raw.kind, raw.args, raw.scope]) !== digest([op.id, op.kind, op.args, op.scope])) throw new Error('classification');
      if (!active || quarantined.has(targetKey(op.scope))) return { verdict: 'deny', reason: 'fenced-or-unknown' };
      if (digest(op.scope) !== digest(current())) return { verdict: 'deny', reason: 'scope-fence' };
      const hash = digest(op), decision = decide(op);
      if (decision.verdict !== 'allow') return decision;
      if (records.has(op.id)) return { verdict: 'deny', reason: 'operation-already-prepared' };
      if (records.size >= 1024) return { verdict: 'deny', reason: 'receipt-bank-full' };
      const issued = clock(), deadline = Math.min(issued + ttl, limit);
      if (!Number.isFinite(deadline) || deadline <= issued || deadline > Number.MAX_SAFE_INTEGER) throw new Error('capability deadline invalid');
      const capability = randomUUID();
      capabilities.set(capability, { op: clone(op), hash, rawHash: digest(raw), fence, issued, deadline,
        confirmed: confirmations.has(hash), consumed: false });
      records.set(op.id, record(op, 'prepared'));
      return { ...decision, capability, receipt: clone(records.get(op.id)) };
    } catch { return { verdict: 'deny', reason: 'invalid-operation' }; }
  }
  function dispatch(capability, raw, send, retained = false, window) {
    validateOperation(raw);
    if (window !== undefined) canonical(window);
    if (window !== undefined && (Object.keys(window).length !== 2 ||
        ![window.issued, window.expires].every(v => Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER) ||
        window.expires <= window.issued)) throw Error('capability window');
    const cap = capabilities.get(capability);
    const started = clock();
    if (!cap || started < cap.issued || started >= cap.deadline || digest(raw) !== cap.rawHash) throw new Error('capability mismatch, expired or spent');
    try {
      const fresh = classify(clone(raw)); validateOperation(fresh);
      if (digest(fresh) !== cap.hash || decide(fresh, cap).verdict !== 'allow') throw new Error('authority changed');
    } catch { throw new Error('dispatch fence: classification or authority changed'); }
    // Reconcile all synchronous trusted callbacks before the final state/time
    // check. current() can revoke authority or outlive the capability's expiry.
    const actual = current();
    if (!active || capabilities.get(capability) !== cap || cap.fence !== fence || digest(cap.op.scope) !== digest(actual) ||
      decide(cap.op, cap).verdict !== 'allow' || !(cap.consumed || grants.has(operationSiteKey(cap.op))) || quarantined.has(targetKey(cap.op.scope))) throw new Error('dispatch fence');
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
      terminal.time < cap.issued || terminal.time >= cap.deadline || !active || capabilities.get(capability) !== cap || cap.fence !== fence ||
      digest(cap.op.scope) !== finalScopeHash || digest(cap.op.scope) !== digest(terminal.scope) || quarantined.has(targetKey(cap.op.scope)) ||
      window !== undefined && (terminal.time < window.issued || terminal.time >= window.expires) ||
      decide(cap.op, cap).verdict !== 'allow' || !(cap.consumed || grants.has(operationSiteKey(cap.op)))) throw new Error('dispatch fence');
    if (!retained) capabilities.delete(capability);
    if (!cap.consumed) {
      confirmations.delete(cap.hash);
      if (cap.op.consequence === 'payment')
        paymentUses.get(requestKey(cap.op.scope.session, 'payment'))?.add(cap.op.kind === 'dialog' ? 'dialog' : 'pay');
      if (grants.get(operationSiteKey(cap.op)) === 'once') grants.delete(operationSiteKey(cap.op));
      cap.consumed = true;
    }
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
    if (r.phase === 'unknown') quarantined.add(targetKey(r.scope));
    return clone(r);
  }
  function timeout(id) { const r = records.get(id); if (r && ['dispatched', 'observed'].includes(r.phase)) unknown(r); }
  const authority = Object.freeze({ user, prepare, dispatch: (capability, raw, send) => dispatch(capability, raw, send), observe, verify, timeout,
    receipt: id => records.has(id) ? clone(records.get(id)) : null,
    recovery: () => [...records.values()].map(clone) });
  authorities.add(authority);
  revocations.set(authority, cancel);
  // Kept private to the branded transport. Public dispatch remains single-use;
  // neither a model request nor an ordinary authority caller can retain a cap.
  continuations.set(authority, {
    deadline: () => clock() + ttl,
    prepare: (raw, deadline) => prepare(raw, deadline),
    dispatch: (capability, raw, send, window) => dispatch(capability, raw, send, true, window),
    complete(capability, id, effect) {
      capabilities.delete(capability);
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
  const operations = new WeakMap(), ordered = new WeakMap(), finished = new WeakSet(), internal = continuations.get(authority);
  function sequence(plan) {
    if (!Object.hasOwn(plan, 'orderedOperations')) return;
    let state = ordered.get(plan);
    if (state) {
      if (state.binding !== canonical([plan.orderedOperations, plan.preparationOperations ?? []])) throw Error('TRANSPORT_OPERATION_MISMATCH');
      return state;
    }
    const list = plan.orderedOperations, preparation = plan.preparationOperations ?? [];
    if (!Array.isArray(list) || !list.length || list.length > 50 || !Array.isArray(preparation) || preparation.length > 100)
      throw Error('TRANSPORT_ORDER_REQUIRED');
    for (const op of [...list, ...preparation]) validateOperation(op);
    if (preparation.some(op => !['read', 'screenshot', 'network', 'console', 'scroll'].includes(op.kind))) throw Error('TRANSPORT_ORDER_REQUIRED');
    if (new Set([...list, ...preparation].map(op => op.id)).size !== list.length + preparation.length) throw Error('TRANSPORT_ORDER_REQUIRED');
    state = { list: clone(list), preparation: clone(preparation), binding: canonical([list, preparation]),
      deadline: internal.deadline(), index: 0, entries: new Map(), scope: undefined };
    ordered.set(plan, state); return state;
  }
  const transport = (plan, scope, command, enter) => {
    if (finished.has(plan)) throw Error('TRANSPORT_SPENT');
    const operation = resolveOperation(plan, scope, command);
    if (!operation?.scope || operation.scope.session !== scope.session || operation.scope.turn !== scope.turn ||
        operation.scope.browser !== scope.browserIncarnation || operation.scope.broker !== scope.brokerEpoch ||
        operation.scope.target !== plan.target) throw Error('TRANSPORT_SCOPE_MISMATCH');
    // Ordered plans are trusted semantic data, not a frontend batch grant.
    // Reads/preparation use separately named operations; a field may start only
    // after the preceding field's independent effect proof completed it.
    const state = sequence(plan);
    if (state) {
      const index = state.list.findIndex(op => op.id === operation.id);
      const expected = index >= 0 ? state.list[index] : state.preparation.find(op => op.id === operation.id);
      if (!expected || canonical(expected) !== canonical(operation)) throw Error('TRANSPORT_OPERATION_MISMATCH');
      if (index >= 0 && index !== state.index) throw Error('TRANSPORT_STEP_ORDER');
      if (state.scope && state.scope !== canonical(scope)) throw Error('TRANSPORT_SCOPE_MISMATCH');
      state.scope = canonical(scope);
    }
    let prepared = state ? state.entries.get(operation.id) : operations.get(plan);
    if (prepared) {
      if (canonical(operation) !== prepared.operation || canonical(scope) !== prepared.scope ||
          canonical(command.window ?? null) !== prepared.window) throw Error('TRANSPORT_OPERATION_MISMATCH');
    } else {
      const issued = state ? internal.prepare(operation, state.deadline) : authority.prepare(operation);
      if (issued.verdict !== 'allow') throw Error('TRANSPORT_AUTHORITY_REQUIRED');
      prepared = { capability: issued.capability, operation: canonical(operation), scope: canonical(scope),
        window: canonical(command.window ?? null), id: operation.id, pending: 0 };
      if (state) state.entries.set(operation.id, prepared);
      else operations.set(plan, prepared);
    }
    let entered = false, value, error;
    internal.dispatch(prepared.capability, operation, () => {
      entered = true;
      try { value = enter(); return value; } catch (e) { error = e; throw e; }
    }, command.window ?? undefined);
    if (!entered || error) throw Error('TRANSPORT_AUTHORITY_REQUIRED');
    if (state && types.isPromise(value)) {
      prepared.pending++;
      Promise.prototype.then.call(value, () => { prepared.pending--; }, () => { prepared.pending--; });
    }
    return value;
  };
  completions.set(transport, (plan, effect) => {
    finished.add(plan);
    const state = ordered.get(plan);
    if (state) {
      const pending = state.list[state.index], receipt = pending && authority.receipt(pending.id);
      const unknownStep = receipt && ['dispatched', 'observed', 'unknown'].includes(receipt.phase) ? state.index : null;
      for (const prepared of state.entries.values()) internal.complete(prepared.capability, prepared.id, 'unknown');
      state.entries.clear();
      return { completed: state.index, unknownStep, untouched: state.list.length - state.index - (unknownStep === null ? 0 : 1) };
    }
    const prepared = operations.get(plan);
    if (prepared) internal.complete(prepared.capability, prepared.id, effect);
    operations.delete(plan);
  });
  starts.set(transport, sequence);
  steps.set(transport, (plan, index, effect) => {
    if (finished.has(plan)) throw Error('TRANSPORT_SPENT');
    const state = sequence(plan);
    if (!state || !Number.isInteger(index) || index !== state.index || index >= state.list.length ||
        !['verified', 'protected', 'unchanged'].includes(effect)) throw Error('TRANSPORT_STEP_ORDER');
    const op = state.list[index], prepared = state.entries.get(op.id);
    if (!prepared || prepared.pending || authority.receipt(op.id)?.phase !== 'dispatched') throw Error('TRANSPORT_STEP_UNPROVED');
    internal.complete(prepared.capability, prepared.id, effect); state.index++;
    state.entries.delete(op.id);
  });
  preparations.set(transport, (plan, id, effect) => {
    if (finished.has(plan)) throw Error('TRANSPORT_SPENT');
    const state = sequence(plan), prepared = state?.entries.get(id);
    if (!state?.preparation.some(op => op.id === id) || !['verified', 'protected', 'unchanged'].includes(effect) ||
        !prepared || prepared.pending || authority.receipt(id)?.phase !== 'dispatched') throw Error('TRANSPORT_STEP_UNPROVED');
    internal.complete(prepared.capability, id, effect); state.entries.delete(id);
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
