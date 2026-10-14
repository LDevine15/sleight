// Original sleight policy, not a model tool. Integration must supply trusted BP2-1
// authorization and the scoped adapter; no clipboard/native fallback is granted here.
export const authorityKeys = ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn',
  'leaseGeneration', 'target', 'frame', 'document', 'origin'];
const operationKeys = [...authorityKeys, 'operation', 'field', 'dispatchFence'];
export const sameAuthority = (a, b) => authorityKeys.every(k => a?.[k] !== undefined && a[k] === b?.[k]);
const sameOperation = (a, b) => operationKeys.every(k => a?.[k] !== undefined && a[k] === b?.[k]);

export async function bounded(work, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), ms);
  })]); } finally { clearTimeout(timer); }
}

// This boundary intentionally accepts JSON data only. It does not invoke getters,
// toJSON or error formatters supplied by a page. Values/URLs/text can contain secrets.
export class Redactor {
  // Fail closed for untrusted text, rather than retaining expired plaintext for
  // substring matching. A later BP2-4 projection may explicitly whitelist labels.
  protect() {}
  clean(value, depth = 0) {
    if (depth > 16) return '[omitted]';
    if (typeof value === 'string') {
      return '[protected]';
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return '[protected]';
    if (!value || typeof value !== 'object') return '[unreadable]';
    if (value instanceof Error) return { error: 'unreadable' };
    const output = Array.isArray(value) ? [] : Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 256)) {
      if (key === 'length' && Array.isArray(value)) continue;
      const safeKey = ['state', 'source', 'value', 'protected', 'log', 'error', 'delta', 'present', 'matched'].includes(key) ? key : `protected-key-${Object.keys(output).length}`;
      output[safeKey] = !('value' in descriptor) ? '[unreadable]' :
        /^(password|secret|token|otp|cardNumber)$/i.test(key) ? { protected: true } : this.clean(descriptor.value, depth + 1);
    }
    return output;
  }
  serialize(value) {
    try { return JSON.stringify(this.clean(value)); } catch { return '{"error":"unreadable"}'; }
  }
}

export class ProtectedProof {
  #current; #authorize; #now; #records = new Map(); #used = new Set();
  #active = new Set(); #generation = 0; #disposed = false;
  constructor({ current, authorize = async () => false, redactor = new Redactor(), now = Date.now,
    lifetimeMs = 3000, timeoutMs = 1000 }) {
    this.#current = current; this.#authorize = authorize; this.#now = now;
    this.redactor = redactor; this.lifetimeMs = Math.min(3000, Math.max(1, lifetimeMs));
    this.timeoutMs = Math.min(3000, Math.max(1, timeoutMs));
  }
  #valid(record, operation) {
    return record && !this.#disposed && record.generation === this.#generation &&
      this.#now() < record.expires && sameOperation(record.operation, operation) &&
      sameAuthority(operation, this.#current());
  }
  #expire() {
    for (const [cap, record] of this.#records) if (!this.#valid(record, record.operation)) {
      record.value = undefined; clearTimeout(record.timer); this.#records.delete(cap);
    }
  }
  async prepare(operation, value) {
    this.#expire();
    if (this.#disposed || typeof value !== 'string' || !sameAuthority(operation, this.#current()) ||
      !operationKeys.every(k => ['string', 'number'].includes(typeof operation[k]))) return null;
    const binding = Object.freeze(Object.fromEntries(operationKeys.map(k => [k, operation[k]])));
    const key = JSON.stringify(binding);
    // No second write/proof for the same operation, even after a mismatched attempt.
    if (this.#used.has(key) || this.#used.size >= 4096) return null;
    this.#used.add(key);
    this.redactor.protect(value);
    const record = { operation: binding, value, generation: this.#generation };
    value = undefined;
    this.#active.add(record);
    let published = false;
    try {
      const allowed = await bounded(() => record.generation === this.#generation && !this.#disposed
        ? this.#authorize(binding, record.value) : false, this.timeoutMs);
      if (allowed !== true || this.#disposed || record.generation !== this.#generation ||
        !sameAuthority(binding, this.#current())) return null;
      const cap = Object.freeze({});
      record.expires = this.#now() + this.lifetimeMs;
      record.timer = setTimeout(() => { record.value = undefined; this.#records.delete(cap); }, this.lifetimeMs);
      record.timer.unref?.(); this.#records.set(cap, record); published = true; return cap;
    } catch { return null; }
    finally { this.#active.delete(record); if (!published) record.value = undefined; }
  }
  async execute(cap, operation, { dispatch, observe } = {}) {
    this.#expire();
    const record = this.#records.get(cap);
    this.#records.delete(cap);
    if (record) clearTimeout(record.timer);
    const receipt = { phase: 'prepared', status: 'blocked', effect: 'none', completed: [], untouched: ['field'], value: { protected: true } };
    if (!this.#valid(record, operation) || typeof dispatch !== 'function' || typeof observe !== 'function') {
      if (record) record.value = undefined; return receipt;
    }
    let dispatched = false;
    this.#active.add(record);
    try {
      const allowed = await bounded(() => this.#valid(record, operation)
        ? this.#authorize(record.operation, record.value) : false, this.timeoutMs);
      if (allowed !== true || !this.#valid(record, operation)) return receipt;
      await bounded(() => {
        if (!this.#valid(record, operation)) return;
        // bounded schedules work on a microtask. Repeat the fence inside it,
        // with no await between the check and the actual adapter invocation.
        dispatched = true; receipt.phase = 'dispatched'; receipt.effect = 'unknown'; receipt.untouched = [];
        return dispatch(record.value);
      }, this.timeoutMs);
      if (!dispatched) return receipt;
      if (!this.#valid(record, operation)) return { ...receipt, status: 'unverifiable' };
      const observed = await bounded(() => this.#valid(record, operation) ? observe() : undefined, this.timeoutMs);
      if (!this.#valid(record, operation)) return { ...receipt, status: 'unverifiable' };
      receipt.phase = 'observed';
      if (observed?.source === 'native' && typeof observed.value === 'string' && observed.value === record.value) {
        receipt.phase = 'verified'; receipt.status = 'verified'; receipt.effect = 'verified'; receipt.completed = ['field'];
      } else receipt.status = observed?.source === 'page-reported' ? 'protected' : 'unverifiable';
      return receipt;
    } catch { return { ...receipt, status: dispatched ? 'unverifiable' : 'blocked' }; }
    finally { this.#active.delete(record); record.value = undefined; }
  }
  invalidate() {
    this.#generation++;
    for (const record of [...this.#records.values(), ...this.#active]) {
      record.value = undefined; clearTimeout(record.timer);
    }
    this.#records.clear();
    this.#active.clear();
  }
  dispose() { this.#disposed = true; this.invalidate(); this.#used.clear(); }
}
