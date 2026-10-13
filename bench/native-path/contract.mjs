// Offline contract only. Trusted engine adapters supply observations and current
// identity. These aliases never grant approval, refresh a lease or execute input.
// Original sleight code. Cua/Peekaboo snapshot lifetime ideas are design references
// in ledger/native-path-design.md, not copied source or an adopted actuator.
const identityKeys = ['session', 'runtimeEpoch', 'pid', 'processStart', 'windowEpoch',
  'windowId', 'appId', 'title', 'url', 'document', 'leaseGeneration'];
const sources = ['engine-full', 'engine-partial', 'direct-ax'];
const coverage = ['scope-complete', 'rendered-partial', 'unknown'];
const roles = new Set(['button','checkbox','text field','text','switch','row','cell','menu item','window',
  'dialog','sheet','group','container','slider','radio button','link','list','outline','combo box','pop up button','tab','table','image']);
const next = {
  TARGET_STALE: { kind: 'native_read', scope: 'same' },
  TARGET_AMBIGUOUS: { kind: 'native_read', scope: 'narrower' },
  VIEW_INCOMPLETE: { kind: 'native_read', scope: 'expand' },
  WINDOW_CHANGED: { kind: 'native_read', scope: 'window' },
  BUDGET_TOO_SMALL: { kind: 'native_read', scope: 'narrower' },
  APPROVAL_REQUIRED: { kind: 'handoff' }, DENIED: { kind: 'stop' }, FORBIDDEN: { kind: 'stop' },
  LEASE_BUSY: { kind: 'native_wait', condition: 'ownership' }, USER_TAKEOVER: { kind: 'handoff' },
  WAIT_TIMEOUT: { kind: 'native_read', scope: 'pending' },
  AX_UNSUPPORTED: { kind: 'native_read', source: 'engine' }, AX_TIMEOUT: { kind: 'native_read', source: 'engine' },
  ENGINE_UNAVAILABLE: { kind: 'stop' }, EFFECT_UNKNOWN: { kind: 'stop' },
};
export function nextFor(code) {
  if (!Object.hasOwn(next, code)) throw new TypeError('Unknown native error code');
  return Object.freeze({ ...next[code] });
}
export class NativeError extends Error {
  constructor(code) { nextFor(code); super(code); this.code = code; }
  toJSON() {
    const unknown = this.code === 'EFFECT_UNKNOWN';
    return { code: this.code, phase: unknown ? 'unknown' : 'prepared', effect: unknown ? 'unknown' : 'none',
      completedSteps: [], failedStep: null, remainingSteps: [], next: nextFor(this.code) };
  }
}
const fail = code => { throw new NativeError(code); };
const sameIdentity = (a, b) => identityKeys.every(k => a?.[k] !== undefined && a[k] === b?.[k]);
const bytes = data => Buffer.byteLength(JSON.stringify(data));
const selector = row => row.id && row.ancestor && row.nodeIdentity ?
  JSON.stringify([row.id, row.role, row.name, row.ancestor, row.nodeIdentity]) : null;
const uniqueId = (row, rows) => rows.filter(r => r.id === row.id).length === 1;
const identityValid = value => value && identityKeys.every(k => ['string','number'].includes(typeof value[k])) &&
  ['pid','windowId','leaseGeneration'].every(k => Number.isSafeInteger(value[k]) && value[k] > 0) &&
  Number.isFinite(value.processStart) && value.processStart > 0 && Number.isFinite(value.leaseExpires) &&
  typeof value.revoked === 'boolean' && ['session','runtimeEpoch','windowEpoch','document','appId'].every(k => typeof value[k] === 'string' && value[k]);

export class NativeRefs {
  #current; #now; #snapshot; #refs = new Map(); #counter = 0; #bytes = 0;
  #app = 0; #window = 0; #maxBytes; #maxAge;
  constructor({ current, now = Date.now, maxBytes = 8 * 1024 * 1024, maxAgeMs = 10000 }) {
    if (typeof current !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new TypeError('Invalid native reference configuration');
    }
    this.#current = current; this.#now = now;
    this.#maxBytes = Math.min(8 * 1024 * 1024, maxBytes); this.#maxAge = Math.min(10000, maxAgeMs);
  }
  #lease(identity) {
    if (!identityValid(identity)) fail('WINDOW_CHANGED');
    if (identity.revoked) fail('USER_TAKEOVER');
    if (identity.leaseExpires <= this.#now()) fail('LEASE_BUSY');
  }
  observe(input) {
    try { return this.#observe(input); }
    catch (error) {
      // A delayed valid older generation cannot contradict newer evidence. Any
      // other failed observation requires fresh evidence before resolving input.
      if (!(error instanceof NativeError) || error.code !== 'TARGET_STALE') this.invalidate();
      if (error instanceof NativeError) throw error;
      fail('VIEW_INCOMPLETE');
    }
  }
  #observe(input) {
    // A trusted adapter, not a model, supplies this input. JSON cloning separates
    // caller-owned data. No tree/body is persisted or returned in an error.
    let data;
    try { data = structuredClone(input); } catch { fail('VIEW_INCOMPLETE'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !identityValid(data.identity)) fail('VIEW_INCOMPLETE');
    this.#lease(this.#current());
    if (!sameIdentity(data.identity, this.#current())) fail('WINDOW_CHANGED');
    if (!sources.includes(data.source) || !coverage.includes(data.coverage) || !['window','sheet','region'].includes(data.scope) ||
      !Number.isFinite(data.observedAt) || data.observedAt > this.#now() ||
      !Number.isSafeInteger(data.fullGeneration) || data.fullGeneration <= 0 ||
      !Number.isSafeInteger(data.viewGeneration) || data.viewGeneration <= 0 || !Array.isArray(data.rows) || data.rows.length > 20000 ||
      !(data.delivered === null || Array.isArray(data.delivered))) fail('VIEW_INCOMPLETE');
    const numbers = new Set();
    for (const row of data.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !Number.isSafeInteger(row.number) || row.number < 0 || numbers.has(row.number) ||
        !['role','name','id','ancestor','nodeIdentity'].every(k => typeof row[k] === 'string' && row[k].length <= 4096)) fail('TARGET_AMBIGUOUS');
      numbers.add(row.number);
    }
    if (data.delivered?.some(n => !numbers.has(n)) || data.delivered && new Set(data.delivered).size !== data.delivered.length) fail('VIEW_INCOMPLETE');
    if (bytes(data) > this.#maxBytes) { this.invalidate(); fail('BUDGET_TOO_SMALL'); }
    const previous = this.#snapshot;
    const same = previous && sameIdentity(previous.identity, data.identity);
    if (same && (data.fullGeneration <= previous.fullGeneration || data.viewGeneration < previous.viewGeneration)) fail('TARGET_STALE');
    if (!same) { this.invalidate(); this.#app++; this.#window++; }
    const eligible = data.source === 'engine-full' && data.coverage === 'scope-complete';
    const delivered = data.delivered === null ? null : new Set(data.delivered);
    const elements = [], kept = new Map();
    if (eligible) {
      for (const [ref, record] of this.#refs) {
        const match = data.rows.filter(row => selector(row) && selector(row) === record.selector && uniqueId(row, data.rows));
        if (!record.selector || match.length !== 1 || delivered && !delivered.has(match[0].number)) continue;
        kept.set(ref, { ...record, row: match[0] });
      }
      if (delivered) for (const row of data.rows) {
        if (!delivered.has(row.number) || row.id && !uniqueId(row, data.rows)) continue;
        let ref = [...kept].find(([, record]) => record.row.number === row.number)?.[0];
        if (!ref) { ref = `e${++this.#counter}`; kept.set(ref, { selector: selector(row), row }); }
        // Values/IDs/document paths remain internal. Upstream redaction applies to
        // any later labels; this contract returns aliases and safe role metadata.
        elements.push({ ref, role: roles.has(row.role) ? row.role : 'unknown' });
      }
    }
    this.#refs = kept;
    this.#snapshot = { ...data, viewGeneration: delivered === null && same ? previous.viewGeneration : data.viewGeneration };
    this.#bytes = bytes(this.#snapshot) + bytes([...this.#refs]);
    if (this.#bytes > this.#maxBytes) { this.invalidate(); fail('BUDGET_TOO_SMALL'); }
    return Object.freeze({ app: `a${this.#app}`, window: `w${this.#window}`, source: data.source, scope: data.scope,
      coverage: data.coverage, observedAt: data.observedAt, fullGeneration: data.fullGeneration,
      viewGeneration: this.#snapshot.viewGeneration, omittedRows: data.rows.length - elements.length,
      absence: data.coverage === 'scope-complete' && delivered?.size === data.rows.length ? 'scoped' : 'unknown', elements });
  }
  resolve(session, ref) {
    this.#lease(this.#current());
    if (session !== this.#current().session) fail('TARGET_STALE');
    if (!this.#snapshot) fail('TARGET_STALE');
    if (!sameIdentity(this.#snapshot.identity, this.#current())) fail('WINDOW_CHANGED');
    if (this.#now() - this.#snapshot.observedAt > this.#maxAge) fail('TARGET_STALE');
    const record = this.#refs.get(ref);
    if (!record || this.#snapshot.source !== 'engine-full' || this.#snapshot.coverage !== 'scope-complete') fail('TARGET_STALE');
    return Object.freeze({ number: record.row.number, source: 'engine-full', fullGeneration: this.#snapshot.fullGeneration,
      viewGeneration: this.#snapshot.viewGeneration, identity: Object.freeze({ ...this.#snapshot.identity }) });
  }
  stats() { return { refs: this.#refs.size, bytes: this.#bytes, evidenceGenerations: this.#snapshot ? 1 : 0, deliveredViews: this.#snapshot ? 1 : 0 }; }
  invalidate() { this.#refs.clear(); this.#snapshot = undefined; this.#bytes = 0; }
}

// A journal records trusted executor transitions, never dispatches itself. In-flight
// dispatched effects remain unknown until exact observed verification arrives.
export class OperationJournal {
  #records = new Map();
  prepare(id, count) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !Number.isSafeInteger(count) || count < 1 || count > 32 ||
      this.#records.size >= 128 || this.#records.has(id)) fail('EFFECT_UNKNOWN');
    this.#records.set(id, { phase: 'prepared', effect: 'none', completedSteps: [], failedStep: null, count });
    return this.receipt(id);
  }
  #record(id) { const record = this.#records.get(id); if (!record) fail('EFFECT_UNKNOWN'); return record; }
  dispatch(id, index) {
    const record = this.#record(id);
    if (!['prepared','verified'].includes(record.phase) || index !== record.completedSteps.length || index >= record.count) fail('EFFECT_UNKNOWN');
    record.phase = 'dispatched'; record.effect = 'unknown'; record.failedStep = index;
  }
  observe(id, index) {
    const record = this.#record(id);
    if (record.phase !== 'dispatched' || record.failedStep !== index) fail('EFFECT_UNKNOWN');
    record.phase = 'observed';
  }
  verify(id, index) {
    const record = this.#record(id);
    if (record.phase !== 'observed' || record.failedStep !== index) fail('EFFECT_UNKNOWN');
    record.phase = 'verified'; record.effect = 'verified'; record.completedSteps.push(index); record.failedStep = null;
  }
  unknown(id) {
    const record = this.#record(id);
    if (!['dispatched','observed'].includes(record.phase)) fail('EFFECT_UNKNOWN');
    record.phase = 'unknown'; record.effect = 'unknown';
  }
  receipt(id) {
    const record = this.#record(id);
    const start = record.failedStep === null ? record.completedSteps.length : record.failedStep + 1;
    return { phase: record.phase, effect: record.effect, completedSteps: [...record.completedSteps], failedStep: record.failedStep,
      remainingSteps: Array.from({ length: record.count - start }, (_, i) => start + i),
      ...(record.phase === 'unknown' ? { code: 'EFFECT_UNKNOWN', next: nextFor('EFFECT_UNKNOWN') } : {}) };
  }
}
