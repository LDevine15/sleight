import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import { authorityKeys, sameAuthority } from './protected-proof.mjs';

const fields = authorityKeys;
const key = scope => JSON.stringify([scope.frame, scope.document, scope.target]);

// P1's authority vocabulary has one explicit conversion at the trusted join.
// This maps identity only; it grants neither content access nor input authority.
export function refScopeFromAuthority(scope) {
  const names = { browserIncarnation: 'browser', brokerEpoch: 'broker', clientSession: 'session',
    turn: 'turn', leaseGeneration: 'lease', target: 'target', frame: 'frame', document: 'document', origin: 'origin' };
  if (!scope || types.isProxy(scope) || Object.getPrototypeOf(scope) !== Object.prototype) throw Error('Invalid ref authority');
  const values = Object.getOwnPropertyDescriptors(scope), result = {};
  for (const [key, name] of Object.entries(names)) {
    const descriptor = values[name];
    if (!descriptor || !('value' in descriptor)) throw Error('Invalid ref authority');
    const value = descriptor.value;
    if (!(typeof value === 'string' && value.length > 0 && value.length <= 512) &&
        !(Number.isSafeInteger(value) && value >= 0)) throw Error('Invalid ref authority');
    result[key] = value;
  }
  if (typeof result.origin !== 'string') throw Error('Invalid ref authority');
  const origin = new URL(result.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== result.origin) throw Error('Invalid ref authority');
  return Object.freeze(result);
}

// Original implementation. FowlBrowser snapshots.mjs (8b68924) informed the
// monotonic, document-bound ref design; here each frame has independent lifetime.
export class RefMap {
  #identity;
  #prefix = `r${randomBytes(4).toString('hex')}`;
  #sequence = 0;
  #nodes = new Map();
  #refs = new Map();

  constructor(identity) {
    if (fields.some(f => identity?.[f] === undefined)) throw Error('Missing ref authority');
    this.#identity = Object.freeze({ ...identity });
  }

  observe(scope, backendNode, semantic) {
    if (!sameAuthority(scope, this.#identity) || !scope.frame || !scope.document || !Number.isSafeInteger(backendNode) || backendNode <= 0) throw Error('Invalid node identity');
    const binding = { ...scope, target: scope.target ?? this.#identity.target };
    const nodeKey = `${key(binding)}:${backendNode}`;
    const old = this.#nodes.get(nodeKey);
    if (old && old.semantic === semantic) return old.ref;
    if (old) this.#refs.delete(old.ref);
    const ref = `${this.#prefix}${(++this.#sequence).toString(36)}`;
    const record = { ...binding, backendNode, semantic, ref, nodeKey };
    this.#nodes.set(nodeKey, record);
    this.#refs.set(ref, record);
    return ref;
  }

  resolve(ref, identity) {
    if (fields.some(f => identity?.[f] !== this.#identity[f]) || !this.#refs.has(ref)) throw Error('Ref is stale or unavailable');
    const { nodeKey, ...binding } = this.#refs.get(ref);
    return Object.freeze({ ...binding, binding: Object.freeze(Object.fromEntries(fields.map(k => [k, binding[k]]))), backendNodeId: binding.backendNode });
  }

  existing(scope, backendNode) {
    if (!sameAuthority(scope, this.#identity)) throw Error('Ref is stale or unavailable');
    return this.#nodes.get(`${key(scope)}:${backendNode}`)?.ref;
  }

  retain(scope, backendNodes) {
    const scopeKey = key({ ...scope, target: scope.target ?? this.#identity.target });
    for (const [ref, row] of this.#refs) {
      if (key(row) === scopeKey && !backendNodes.has(row.backendNode)) {
        this.#refs.delete(ref); this.#nodes.delete(row.nodeKey);
      }
    }
  }

  invalidateRef(ref) {
    const row = this.#refs.get(ref);
    if (!row) return;
    this.#refs.delete(ref); this.#nodes.delete(row.nodeKey);
  }

  invalidateFrame(frame) {
    for (const [ref, row] of this.#refs) {
      if (row.frame === frame) { this.#refs.delete(ref); this.#nodes.delete(row.nodeKey); }
    }
  }

  clear() { this.#nodes.clear(); this.#refs.clear(); }
}
