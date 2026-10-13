import { readAX } from './ax-read.js';
import { isDeepStrictEqual } from 'node:util';

const keys = ['session', 'generation', 'pid', 'processStart', 'window', 'scope'];
class ReadError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

// Offline orchestration only: callers supply both paths. Each path's wall time must include its
// effective policy/identity and settled-state checks. A settled stamp is trusted harness evidence,
// not a flag accepted by read(). No title, selector, value, error text or receipt is retained.
export async function compareAXPairs({ ordinary, direct, now = () => performance.now() }) {
  const pairs = [];
  let unknown = 0, disagreements = 0;
  const measure = async fn => {
    const start = now();
    try { return { result: await fn(), ms: now() - start }; }
    catch { return { result: { status: 'unknown' }, ms: now() - start }; }
  };
  for (let i = 0; i < 30; i++) {
    let engine, ax;
    if (i % 2 === 0) { engine = await measure(ordinary); ax = await measure(direct); }
    else { ax = await measure(direct); engine = await measure(ordinary); }
    const known = [engine, ax].every(x => x.result?.status === 'ok' && x.result?.settled === true &&
      Object.hasOwn(x.result, 'value') && Number.isFinite(x.ms) && x.ms >= 0);
    const matched = known && isDeepStrictEqual(engine.result.value, ax.result.value);
    if (!known) unknown++;
    else if (!matched) disagreements++;
    pairs.push({ order: i % 2 === 0 ? 'engine-first' : 'direct-first', engineMs: engine.ms,
      directMs: ax.ms, savingMs: engine.ms - ax.ms, known, matched });
  }
  const savings = pairs.map(x => x.savingMs).sort((a, b) => a - b);
  const medianSavingMs = (savings[14] + savings[15]) / 2;
  return { pairs, unknown, disagreements, medianSavingMs,
    qualified: unknown === 0 && disagreements === 0 && medianSavingMs > 100 };
}
const fail = (status, code) => { throw new ReadError(status, code); };
const fieldsFor = operation => operation === 'metadata' ? ['title', 'minimized']
  : operation === 'state' ? ['role', 'name', 'checked'] : ['role', 'name'];
const same = (a, b) => keys.every(key => a[key] === b?.[key]);
const validTicket = t => t && typeof t.session === 'string' && t.session.length > 0 &&
  Number.isSafeInteger(t.generation) && t.generation > 0 && Number.isSafeInteger(t.pid) && t.pid > 0 &&
  Number.isFinite(t.processStart) && t.processStart > 0 && typeof t.window === 'string' && t.window.length > 0 &&
  typeof t.scope === 'string' && t.scope.length > 0 && Number.isFinite(t.expiresAt) &&
  Array.isArray(t.operations) && Array.isArray(t.fields);
function validRequest(r) {
  if (!r || !['metadata', 'state', 'exists'].includes(r.operation)) return false;
  const allowed = r.operation === 'metadata' ? ['operation'] : ['operation', 'role', 'name', ...(r.operation === 'state' ? ['attribute'] : [])];
  if (Object.keys(r).some(key => !allowed.includes(key))) return false;
  if (r.operation === 'metadata') return true;
  if (typeof r.role !== 'string' || !/^AX[A-Za-z]{1,40}$/.test(r.role) || typeof r.name !== 'string' || Buffer.byteLength(r.name) > 512) return false;
  return r.operation !== 'state' || (r.role === 'AXCheckBox' && (r.attribute === undefined || r.attribute === 'checked'));
}

// policy and AX are trusted host dependencies, never request JSON. inspect must use the ordinary
// engine's effective decision at dispatch, including protected/settings checks and revocation.
// No supported adapter currently supplies that decision. Missing policy therefore fails closed.
// fence(ticket, request, pairs) must synchronously return one coherent CURRENT effective
// app decision plus classification:'metadata' for every exact node/field pair. It must include
// current process/window identity and field protection, without another await or side effects.
// This is a required private host-adapter contract, not an engine API or a model grant.
// Tickets use the injected monotonic clock for expiry; they cannot grant or renew app permission.
export function createAXProbe({ ax, policy, now = () => performance.now() } = {}) {
  let busy = false;
  const pending = new Set();
  return Object.freeze({
    async read(ticket, request) {
      const started = now(), deadline = started + 500;
      const output = result => ({ source: 'direct-ax', actionEvidence: false, ...result, elapsedMs: Math.max(0, now() - started) });
      if (!validRequest(request)) return output({ status: 'denied', code: 'INVALID_REQUEST' });
      if (typeof policy?.inspect !== 'function' || typeof policy?.classify !== 'function' || typeof policy?.fence !== 'function')
        return output({ status: 'denied', code: 'POLICY_UNAVAILABLE' });
      if (!validTicket(ticket)) return output({ status: 'denied', code: 'DENIED' });
      if (busy || pending.size) return output({ status: 'unknown', code: 'AX_PENDING' });
      // Snapshot inputs before the first await, so a caller cannot widen the request mid-read.
      ticket = structuredClone(ticket); request = structuredClone(request);
      busy = true;
      const captured = new Map();
      const remaining = () => {
        const value = deadline - now();
        if (value <= 0) fail('incomplete', 'AX_TIMEOUT');
        return value;
      };
      const bounded = async (fn, limit = 100) => {
        const ms = Math.min(limit, remaining());
        let timer;
        const work = Promise.resolve().then(fn);
        pending.add(work);
        work.then(() => pending.delete(work), () => pending.delete(work));
        try {
          const result = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new ReadError('incomplete', 'AX_TIMEOUT')), ms); })]);
          remaining();
          return result;
        } finally { clearTimeout(timer); }
      };
      const validateDecision = current => {
        remaining();
        if (current?.forbidden === true || current?.settings === true) fail('denied', 'FORBIDDEN');
        if (!same(ticket, current) || current?.approved !== true || current?.forbidden !== false ||
            current?.settings !== false || current?.revoked !== false || !Number.isFinite(current?.expiresAt) ||
            Math.min(ticket.expiresAt, current.expiresAt) <= now() ||
            !ticket.operations.includes(request.operation) || !current.operations?.includes(request.operation) ||
            !fieldsFor(request.operation).every(field => ticket.fields.includes(field) && current.fields?.includes(field))) fail('denied', 'DENIED');
      };
      const check = async () => {
        remaining();
        validateDecision(await bounded(() => policy.inspect(ticket, request), remaining()));
      };
      const fence = pairs => {
        remaining();
        pairs = Object.freeze(pairs.map(({ node, fields }) => Object.freeze({ node, fields: Object.freeze([...fields]) })));
        const decision = policy.fence(ticket, request, pairs);
        if (decision && typeof decision.then === 'function') {
          // A misconfigured async provider cannot grant access. Keep its work owned.
          const work = Promise.resolve(decision);
          pending.add(work);
          work.then(() => pending.delete(work), () => pending.delete(work));
          fail('denied', 'POLICY_UNAVAILABLE');
        }
        validateDecision(decision);
        if (decision.classification !== 'metadata') fail('denied', 'PROTECTED');
      };
      const identity = async () => {
        const current = await bounded(() => ax.identity(ticket));
        if (!same(ticket, current)) fail('denied', 'IDENTITY_CHANGED');
      };
      const call = async (fn, node, fields) => {
        await check(); await identity();
        await check();
        const timeout = Math.min(100, remaining()) / 1000;
        const applied = await bounded(() => ax.setMessagingTimeout(node, timeout));
        if (applied?.status !== 'ok') fail('unknown', 'AX_UNSUPPORTED');
        // Earlier field decisions can change during policy, identity or timeout setup.
        if (await bounded(() => policy.classify(node, fields, ticket, request)) !== 'metadata') return null;
        await check();
        const result = await bounded(() => {
          // Fence inside bounded's scheduled callback, with no await before native dispatch.
          fence([{ node, fields }]);
          if (!captured.has(node)) captured.set(node, new Set());
          for (const field of fields) captured.get(node).add(field);
          return fn();
        });
        for (const part of [result, ...Object.values(result || {})]) {
          if (part?.status === 'denied') fail('denied', 'AX_DENIED');
          if (part?.status === 'timeout') fail('incomplete', 'AX_TIMEOUT');
          if (part?.status === 'invalid-reference') fail('unknown', 'AX_INVALID_REFERENCE');
        }
        return result;
      };
      try {
        await check();
        if (await bounded(() => ax.isProcessTrusted()) !== true) fail('denied', 'AX_DENIED');
        await identity();
        const window = await bounded(() => ax.resolveWindow(ticket));
        if (window?.matches !== 1) fail('unknown', 'TARGET_AMBIGUOUS');
        if (!window.element || typeof window.element !== 'object') fail('unknown', 'AX_INVALID_REFERENCE');
        const result = await readAX({ ax, root: window.element, request, call, check,
          classify: (node, fields) => bounded(() => policy.classify(node, fields, ticket, request)) });
        await check(); await identity(); await check();
        for (const [node, fields] of captured) {
          if (await bounded(() => policy.classify(node, [...fields], ticket, request)) !== 'metadata') fail('denied', 'PROTECTED');
          await check();
        }
        // One synchronous decision covers the whole capture set after all async checks.
        if (captured.size) fence([...captured].map(([node, fields]) => ({ node, fields })));
        remaining();
        if (ticket.expiresAt <= now()) fail('denied', 'DENIED');
        const reply = output(result);
        if (Buffer.byteLength(JSON.stringify(reply)) > 4096) return output({ status: 'incomplete', code: 'OUTPUT_LIMIT' });
        return reply;
      } catch (error) {
        // Adapter exceptions may contain protected values. Only locally generated codes escape.
        return output(error instanceof ReadError ? { status: error.status, code: error.code } : { status: 'unknown', code: 'AX_UNKNOWN' });
      } finally { busy = false; }
    },
  });
}
