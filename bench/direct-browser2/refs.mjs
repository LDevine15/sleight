import { randomBytes } from 'node:crypto';

const fields = ['browser', 'epoch', 'broker', 'session', 'lease', 'target'];
const key = scope => JSON.stringify([scope.frame, scope.document, scope.target]);

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
    if (!scope.frame || !scope.document || !Number.isSafeInteger(backendNode) || backendNode <= 0) throw Error('Invalid node identity');
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
    return Object.freeze(binding);
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
