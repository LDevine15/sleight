import { sameAuthority, bounded } from './protected-proof.mjs';

// CDP backend-node discovery idea: FowlBrowser MIT, 8b689249ba4e33d2626487aad930605c62e2c6a7,
// mcp/src/closedShadow.mjs. Independently written; no copied implementation.
// BP2-4 may supply remember/resolve for the shared r ref space at integration.
export class BackendRefs {
  #session; #current; #refs = new Map(); #next = 0; #invalid;
  constructor(session, current) {
    this.#session = session; this.#current = current;
    this.#invalid = () => this.invalidate();
    session.on('DOM.documentUpdated', this.#invalid);
    session.on('Runtime.executionContextsCleared', this.#invalid);
  }
  remember(backendNodeId, binding) {
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0 || !sameAuthority(binding, this.#current())) throw Error('stale ref');
    for (const [ref, record] of this.#refs) if (record.backendNodeId === backendNodeId && sameAuthority(record.binding, binding)) return ref;
    const ref = `r${++this.#next}`;
    this.#refs.set(ref, { backendNodeId, binding: Object.freeze({ ...binding }), sessionId: this.#session.sessionId }); return ref;
  }
  resolve(ref) {
    const record = this.#refs.get(ref);
    if (!record || record.sessionId !== this.#session.sessionId || !sameAuthority(record.binding, this.#current())) throw Error('stale ref');
    return record;
  }
  async scan() {
    const binding = { ...this.#current() };
    try {
      const deadline = Date.now() + 1000;
      const { root } = await bounded(() => this.#session.send('DOM.getDocument', { depth: 1, pierce: false }), 1000);
      if (!sameAuthority(binding, this.#current())) return { complete: false, nodes: [], state: 'stale' };
      const nodes = []; let omitted = 0;
      const walk = async (node, closed = false, depth = 0) => {
        if (!node || depth > 64 || nodes.length >= 2048) { omitted++; return; }
        if (!sameAuthority(binding, this.#current())) throw Error('stale');
        // Never traverse contentDocument without its separate frame/origin grant.
        if (node.nodeType === 1 && node.backendNodeId) nodes.push({ ref: this.remember(node.backendNodeId, binding), closed });
        if (['iframe', 'frame', 'object', 'embed'].includes(node.localName)) { omitted++; return; }
        let expanded = node;
        if (node.backendNodeId && !node.children && [1, 9, 11].includes(node.nodeType)) {
          if (Date.now() >= deadline) { omitted++; return; }
          const result = await bounded(() => this.#session.send('DOM.describeNode', { backendNodeId: node.backendNodeId, depth: 1, pierce: false }), deadline - Date.now());
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
      if (!sameAuthority(binding, this.#current())) return { complete: false, nodes: [], state: 'stale' };
      return { complete: omitted === 0, omitted, nodes };
    } catch { return { complete: false, nodes: [], state: 'unreadable' }; }
  }
  invalidate() { this.#refs.clear(); }
  dispose() {
    this.invalidate(); this.#session.off('DOM.documentUpdated', this.#invalid);
    this.#session.off('Runtime.executionContextsCleared', this.#invalid);
  }
}
