// Exact P2 inspector at 575560023903f1379436e4cd58fd1655c6aecf2a, host join regression data.
import { createHash } from 'node:crypto';
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

// Registration data for the host's closed helper boundary. The host must bind
// this template to a resolved object in the same leased frame/document; calling
// it on an execution context's global object is not a node-state observation.
export const fixedWorldInspectors = Object.freeze({
  'world-state': Object.freeze({ version: 1, source: String(inspect),
    sha256: createHash('sha256').update(String(inspect)).digest('hex') }),
});

