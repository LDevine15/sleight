import { bounded, sameAuthority, Redactor } from './protected-proof.mjs';

// Fixed, narrowly typed templates only. MAIN getter execution may have side effects;
// a timeout limits the wait, not the page's execution. Never terminate a user context.
function inspect(property, semantics) {
  try {
    let value;
    if (semantics === 'page') {
      if (!(property in this)) return { state: 'absent' };
      value = this[property];
    } else {
      const native = this instanceof HTMLInputElement ? HTMLInputElement.prototype :
        this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
          this instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
            this instanceof HTMLOptionElement ? HTMLOptionElement.prototype : null;
      const getter = native && Object.getOwnPropertyDescriptor(native, property)?.get;
      if (!getter) return { state: 'absent' };
      value = getter.call(this);
    }
    // All text value reads stay protected here, including hostile custom getters.
    if (property === 'value') return { state: 'redacted', protected: true };
    if (typeof value !== 'boolean') return { state: 'unreadable' };
    return { state: 'value', value };
  } catch { return { state: 'throwing' }; }
}

export class WorldReader {
  #session; #refs; #current; #mainContext; #contexts = new Map(); #invalid;
  constructor(session, refs, { current, mainContext = () => undefined, redactor = new Redactor(), timeoutMs = 1000 }) {
    this.#session = session; this.#refs = refs; this.#current = current; this.#mainContext = mainContext;
    this.redactor = redactor; this.timeoutMs = Math.min(1000, Math.max(1, timeoutMs));
    this.#invalid = () => this.#contexts.clear();
    session.on('Runtime.executionContextDestroyed', this.#invalid);
    session.on('Page.frameNavigated', this.#invalid);
  }
  async read(ref, property, { semantics = 'native' } = {}) {
    const source = semantics === 'page' ? 'page-reported' : 'native';
    if (!['checked', 'selected', 'disabled', 'expanded', 'value'].includes(property) || !['native', 'page'].includes(semantics)) return { state: 'unreadable', source };
    let record;
    try { record = this.#refs.resolve(ref); } catch { return { state: 'stale', source }; }
    let objectId, active = true;
    try {
      const result = await bounded(async () => {
        const key = JSON.stringify(record.binding);
        let executionContextId;
        if (semantics === 'page') executionContextId = this.#mainContext(record.binding);
        else {
          executionContextId = this.#contexts.get(key);
          if (!executionContextId) {
            const context = await this.#session.send('Page.createIsolatedWorld', { frameId: record.binding.frame, worldName: 'sleight-state', grantUniveralAccess: false });
            executionContextId = context.executionContextId; this.#contexts.set(key, executionContextId);
          }
        }
        if (!active || !Number.isSafeInteger(executionContextId) || !sameAuthority(record.binding, this.#current())) return { state: 'stale' };
        const resolved = await this.#session.send('DOM.resolveNode', { backendNodeId: record.backendNodeId, executionContextId });
        objectId = resolved.object?.objectId;
        try {
          if (!active || !objectId || !sameAuthority(record.binding, this.#current())) return { state: 'stale' };
          const reply = await this.#session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: String(inspect),
            arguments: [{ value: property }, { value: semantics }], returnByValue: true, awaitPromise: false });
          if (!sameAuthority(record.binding, this.#current())) return { state: 'stale' };
          if (reply.exceptionDetails) return { state: 'throwing' };
          return reply.result?.value;
        } finally { if (objectId) this.#session.send('Runtime.releaseObject', { objectId }).catch(() => {}); }
      }, this.timeoutMs);
      // Closed output grammar: no raw CDP errors, custom objects, strings or lengths.
      const state = ['value', 'absent', 'throwing', 'unreadable', 'redacted', 'stale'].includes(result?.state) ? result.state : 'unreadable';
      if (property === 'value' && state === 'value') return { state: 'redacted', protected: true, source };
      if (state === 'value' && typeof result.value !== 'boolean') return { state: 'unreadable', source };
      return { state, source, ...(state === 'value' ? { value: result.value } : {}), ...(state === 'redacted' ? { protected: true } : {}) };
    } catch (error) { return { state: error?.message === 'deadline' ? 'timeout' : 'unreadable', source }; }
    finally { active = false; }
  }
  dispose() {
    this.#contexts.clear(); this.#session.off('Runtime.executionContextDestroyed', this.#invalid);
    this.#session.off('Page.frameNavigated', this.#invalid);
  }
}
