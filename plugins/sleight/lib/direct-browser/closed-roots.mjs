import { RefMap } from './refs.mjs';
import { sameAuthority, bounded } from './protected-proof.mjs';

// CDP backend-node discovery idea: FowlBrowser MIT, 8b689249ba4e33d2626487aad930605c62e2c6a7,
// mcp/src/closedShadow.mjs. Independently written; no copied implementation.
// BP2-4 may supply remember/resolve for the shared r ref space at integration.
export class BackendRefs {
  #session; #current; #refs; #invalid; #generation = 0; #disposed = false;
  constructor(session, current, refs = new RefMap(current())) {
    this.#session = session; this.#current = current; this.#refs = refs;
    this.#invalid = () => this.invalidate();
    session.on('DOM.documentUpdated', this.#invalid);
    session.on('Runtime.executionContextsCleared', this.#invalid);
  }
  remember(backendNodeId, binding) {
    if (this.#disposed || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0 || !sameAuthority(binding, this.#current())) throw Error('stale ref');
    return this.#refs.existing(binding, backendNodeId) ?? this.#refs.observe(binding, backendNodeId, 'backend-only');
  }
  resolve(ref) {
    return { ...this.#refs.resolve(ref, this.#current()), sessionId: this.#session.sessionId };
  }
  async scan() {
    if (this.#disposed) return { complete: false, nodes: [], state: 'stale' };
    const binding = { ...this.#current() }, generation = this.#generation;
    const valid = () => !this.#disposed && generation === this.#generation && sameAuthority(binding, this.#current());
    try {
      const deadline = Date.now() + 1000;
      const { root } = await bounded(() => this.#session.send('DOM.getDocument', { depth: 1, pierce: false }), 1000);
      if (!valid()) return { complete: false, nodes: [], state: 'stale' };
      const nodes = []; let omitted = 0;
      const walk = async (node, closed = false, depth = 0) => {
        if (!node || depth > 64 || nodes.length >= 2048) { omitted++; return; }
        if (!valid()) throw Error('stale');
        // Never traverse contentDocument without its separate frame/origin grant.
        if (node.nodeType === 1 && node.backendNodeId) nodes.push({ ref: this.remember(node.backendNodeId, binding), closed });
        if (['iframe', 'frame', 'object', 'embed'].includes(node.localName)) { omitted++; return; }
        let expanded = node;
        if (node.backendNodeId && !node.children && [1, 9, 11].includes(node.nodeType)) {
          if (Date.now() >= deadline) { omitted++; return; }
          const result = await bounded(() => this.#session.send('DOM.describeNode', { backendNodeId: node.backendNodeId, depth: 1, pierce: false }), deadline - Date.now());
          if (!valid()) throw Error('stale');
          expanded = { ...node, ...result.node };
        }
        // A shallow container can advertise children without including them.
        // Never turn missing/partial expansion into a complete closed-root scan.
        const children = expanded?.children ?? [];
        if (expanded?.childNodeCount > children.length) omitted += expanded.childNodeCount - children.length;
        for (const child of children) await walk(child, closed, depth + 1);
        for (const shadow of expanded?.shadowRoots ?? []) await walk(shadow, closed || shadow.shadowRootType === 'closed', depth + 1);
      };
      await walk(root);
      if (!valid()) return { complete: false, nodes: [], state: 'stale' };
      return { complete: omitted === 0, omitted, nodes };
    } catch { return { complete: false, nodes: [], state: valid() ? 'unreadable' : 'stale' }; }
  }
  invalidate() { this.#generation++; this.#refs.clear(); }
  dispose() {
    this.#disposed = true; this.invalidate(); this.#session.off('DOM.documentUpdated', this.#invalid);
    this.#session.off('Runtime.executionContextsCleared', this.#invalid);
  }
}
