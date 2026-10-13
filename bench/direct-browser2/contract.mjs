import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { verdict } from './policy.mjs';

export const CONTRACT_VERSION = 2;
export const SCOPE_KEYS = Object.freeze(['browser', 'broker', 'session', 'turn', 'target', 'lease',
  'frame', 'document', 'ref', 'origin']);
export const OPERATIONS = Object.freeze({ read: [], screenshot: [], network: [], console: [],
  open: ['url'], navigate: ['url'], click: [], fill: ['value'], paste: ['text'], key: ['key'],
  select: ['values'], check: ['checked'], upload: ['files'], download: [], close: [], dialog: ['action', 'text'] });
const clone = value => structuredClone(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);

// Sorted serialization and private keyed digests bind arguments without exposing
// protected data or a reusable equality oracle. Reject non-data before hashing.
export function canonical(value, depth = 0) {
  if (depth > 20) throw new Error('data depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(',')}]`;
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
  if (['upload', 'select'].includes(operation.kind)) {
    const values = a[operation.kind === 'upload' ? 'files' : 'values'];
    if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(v => typeof v !== 'string')) throw new Error('arguments');
    if (operation.kind === 'upload' && (!operation.transmission ||
      canonical(values) !== canonical(operation.transmission.files) || values.some(v => !v.startsWith('/') || v.split('/').includes('..'))))
      throw new Error('file capability');
  }
  if (operation.kind === 'dialog' && !['accept', 'dismiss'].includes(a.action)) throw new Error('arguments');
  if (operation.kind === 'navigate' || operation.kind === 'open') {
    const url = new URL(a.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('navigation');
    // Query data must be independently classified before sending it to a server.
    if (url.search && !operation.transmission) throw new Error('query transmission');
  }
  if (operation.transmission) {
    const destination = new URL(operation.transmission.destination);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password ||
      typeof operation.transmission.data !== 'string') throw new Error('transmission');
    if ((operation.kind === 'fill' && operation.transmission.data !== a.value) ||
      (operation.kind === 'paste' && operation.transmission.data !== a.text)) throw new Error('transmission payload');
  }
}

/** Offline authority core. The integration owns current/process/frame evidence,
 * classify (actual semantics, data and canonical files), authenticate (trusted UI
 * or user-message channel), and synchronous final dispatch. No model endpoint
 * may expose user(), observe(), verify(), recovery import or classify. Missing
 * authentic integration must refuse; these callbacks are not proof of a user. */
export function createAuthority({ current, classify, authenticate, now = Date.now,
  ttl = 5000, confirmPayments = process.env.SLEIGHT_CONFIRM_PAYMENTS, persistAlways, recovery = [] } = {}) {
  if (![current, classify, authenticate].every(f => typeof f === 'function') || !Number.isFinite(ttl) || ttl <= 0 || ttl > 30000)
    throw new Error('trusted boundaries required');
  const secret = randomBytes(32), grants = new Map(), confirmations = new Set(), requests = new Map(), paymentUses = new Map();
  const capabilities = new Map(), records = new Map(), quarantined = new Set();
  let fence = 0, active = true;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('capability clock invalid');
    return value;
  };
  const digest = value => createHmac('sha256', secret).update(canonical(value)).digest('hex');
  const siteKey = scope => canonical([scope.session, scope.origin]);
  const targetKey = scope => canonical([scope.session, scope.target]);
  const requestKey = (session, consequence) => canonical([session, consequence]);
  const exactTerms = (op, req) => {
    if (!req || !op.terms || !req.terms) return false;
    if (op.consequence === 'payment' && ['item', 'payee', 'amount', 'currency', 'plan', 'method'].some(k =>
      typeof op.terms[k] !== 'string' || !op.terms[k])) return false;
    return digest(op.terms) === digest(req.terms);
  };
  const decide = op => verdict(op, { site: grants.has(siteKey(op.scope)),
    confirmed: confirmations.has(digest(op)), confirmPayments,
    exactRequest: exactTerms(op, requests.get(requestKey(op.scope.session, op.consequence))) &&
      (op.consequence !== 'payment' || !paymentUses.get(requestKey(op.scope.session, 'payment'))?.has(op.kind === 'dialog' ? 'dialog' : 'pay')),
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
    fence++; capabilities.clear();
    for (const [key] of grants) if (!session || JSON.parse(key)[0] === session) grants.delete(key);
    for (const [key] of requests) if (!session || JSON.parse(key)[0] === session) { requests.delete(key); paymentUses.delete(key); }
    confirmations.clear();
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
      validateOperation(data.operation); confirmations.add(digest(data.operation));
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
  function prepare(raw) {
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
      const issued = clock(), deadline = issued + ttl;
      if (!Number.isFinite(deadline) || deadline <= issued || deadline > Number.MAX_SAFE_INTEGER) throw new Error('capability deadline invalid');
      const capability = randomUUID();
      capabilities.set(capability, { op: clone(op), hash, rawHash: digest(raw), fence, issued, deadline });
      records.set(op.id, record(op, 'prepared'));
      return { ...decision, capability, receipt: clone(records.get(op.id)) };
    } catch { return { verdict: 'deny', reason: 'invalid-operation' }; }
  }
  function dispatch(capability, raw, send) {
    validateOperation(raw);
    const cap = capabilities.get(capability);
    const started = clock();
    if (!cap || started < cap.issued || started >= cap.deadline || digest(raw) !== cap.rawHash) throw new Error('capability mismatch, expired or spent');
    try {
      const fresh = classify(clone(raw)); validateOperation(fresh);
      if (digest(fresh) !== cap.hash || decide(fresh).verdict !== 'allow') throw new Error('authority changed');
    } catch { throw new Error('dispatch fence: classification or authority changed'); }
    // Reconcile all synchronous trusted callbacks before the final state/time
    // check. current() can revoke authority or outlive the capability's expiry.
    const actual = current();
    if (!active || capabilities.get(capability) !== cap || cap.fence !== fence || digest(cap.op.scope) !== digest(actual) ||
      decide(cap.op).verdict !== 'allow' || !grants.has(siteKey(cap.op.scope)) || quarantined.has(targetKey(cap.op.scope))) throw new Error('dispatch fence');
    if (typeof send !== 'function') throw new Error('dispatch function');
    const finalTime = clock();
    if (finalTime < cap.issued || finalTime >= cap.deadline || !active || capabilities.get(capability) !== cap || cap.fence !== fence) throw new Error('dispatch fence');
    capabilities.delete(capability); confirmations.delete(cap.hash);
    if (cap.op.consequence === 'payment')
      paymentUses.get(requestKey(cap.op.scope.session, 'payment'))?.add(cap.op.kind === 'dialog' ? 'dialog' : 'pay');
    if (grants.get(siteKey(cap.op.scope)) === 'once') grants.delete(siteKey(cap.op.scope));
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
  return Object.freeze({ user, prepare, dispatch, observe, verify, timeout,
    receipt: id => records.has(id) ? clone(records.get(id)) : null,
    recovery: () => [...records.values()].map(clone) });
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
