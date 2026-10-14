import { canonical } from './authority.mjs';
import { immutableJSON } from './ipc.mjs';
import { createScopedAdapter } from './scoped-adapter.mjs';
import { createRemoteResources } from './remote-resources.mjs';
const owners = new WeakSet();
export const isTransportOwner = value => !!value && owners.has(value);

// One instance per accepted browser connection, retained by the host. Reader
// factories are trusted P2 code, never permission callbacks or IPC parameters.
export function createTransportOwner({ session, checkLease, resourceTimeoutMs = 1000, ...options }) {
  if (!session || ['send', 'on', 'off'].some(k => typeof session[k] !== 'function') || typeof checkLease !== 'function')
    throw Error('TRANSPORT_OWNER_REQUIRED');
  const entries = new Map(), revoked = new Set(), resources = createRemoteResources({ session, timeoutMs: resourceTimeoutMs });
  let closed = false;
  const dispose = entry => {
    if (entry.retired) return;
    entry.retired = true; entry.adapter.disconnect();
    for (const reader of entry.readers.values()) try { reader.dispose(); } catch {}
    entry.readers.clear();
  };
  function event(raw) {
    for (const entry of entries.values()) {
      if (raw.sessionId !== entry.lease.cdpSessionId) continue;
      if (['DOM.documentUpdated', 'Runtime.executionContextsCleared', 'Runtime.executionContextDestroyed'].includes(raw.method) ||
          raw.method === 'Page.frameNavigated' && raw.params?.frame?.id === entry.lease.frame ||
          raw.method === 'Page.frameDetached' && raw.params?.frameId === entry.lease.frame) dispose(entry);
    }
  }
  session.on('event', event);
  function entryFor(input) {
    if (closed) throw Error('TRANSPORT_CLOSED');
    const lease = immutableJSON(input), key = canonical(lease);
    if (revoked.has(lease.clientSession)) throw Error('LEASE_LOST');
    if (checkLease(lease) !== true) throw Error('LEASE_LOST');
    let entry = entries.get(key);
    if (entry?.retired) throw Error('LEASE_LOST');
    if (!entry) {
      if (entries.size >= 128) throw Error('TRANSPORT_LIMIT');
      entry = { lease, readers: new Map() };
      const bridge = Object.freeze({ sessionId: session.sessionId, on: session.on.bind(session), off: session.off.bind(session),
        send(method, params, route, window) {
          if (!entry.active) throw Error('TRANSPORT_INACTIVE');
          // The broker-provided terminal transport owns the coherent final
          // authority check for this operation. Raw root sends never act/read.
          return entry.active.session.send(method, params, route, window);
        } });
      entry.adapter = createScopedAdapter({ ...options, session: bridge, resources,
        checkLease: value => !closed && !entry.retired && !entry.active?.signal?.aborted && checkLease(value) === true });
      entry.view = entry.adapter.forLease(lease); entries.set(key, entry);
    }
    return entry;
  }
  const owner = Object.freeze({
    async run(lease, context, dispatch) {
      const entry = entryFor(lease);
      if (entry.active) throw Error('TRANSPORT_BUSY');
      if (!context?.session || context.session.sessionId !== session.sessionId || typeof context.session.send !== 'function' ||
          typeof context.operation !== 'string' || !context.operation || typeof dispatch !== 'function') throw Error('TRANSPORT_CONTEXT_REQUIRED');
      for (const [key, value] of [['clientSession', lease.clientSession], ['turn', lease.turn],
        ['browserIncarnation', lease.browserIncarnation], ['brokerEpoch', lease.brokerEpoch]]) {
        if (value === undefined || context[key] !== value) throw Error('TRANSPORT_CONTEXT_REQUIRED');
      }
      entry.active = context;
      try {
        const result = await dispatch(entry.view);
        if (closed || entry.retired || context.signal?.aborted || checkLease(entry.lease) !== true) throw Error('LEASE_LOST');
        return result;
      } finally { entry.active = undefined; }
    },
    reader(lease, name, factory) {
      const entry = entryFor(lease);
      if (!entry.active || typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || typeof factory !== 'function')
        throw Error('TRANSPORT_INACTIVE');
      if (!entry.readers.has(name)) {
        const reader = factory(entry.view);
        if (!reader || typeof reader.dispose !== 'function') throw Error('READER_CONTRACT_REQUIRED');
        entry.readers.set(name, reader);
      }
      return entry.readers.get(name);
    },
    revokeSession(id) {
      revoked.add(id);
      for (const entry of entries.values()) if (entry.lease.clientSession === id) dispose(entry);
      return true;
    },
    cleanup: cleanupReceipt,
    cleanupSession: id => cleanupReceipt(id),
    close() {
      if (!closed) { closed = true; session.off('event', event); for (const entry of entries.values()) dispose(entry); }
      return cleanupReceipt();
    },
  });
  owners.add(owner); return owner;
  async function cleanupReceipt(id) {
    const result = await resources.cleanup(id);
    const pending = [...entries.values()].filter(entry => entry.active && (id === undefined || entry.lease.clientSession === id)).map(entry => ({ target: entry.lease.target,
      frame: entry.lease.frame, document: entry.lease.document, status: 'retained', resource: 'in-flight-operation' }));
    return { closed: result.closed && pending.length === 0, cleanup: [...result.cleanup, ...pending] };
  }
}
