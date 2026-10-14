import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bounded } from '../../plugins/sleight/lib/direct-browser/lifecycle.mjs';
import { validateEndpoint, parseActivePort } from '../../plugins/sleight/lib/direct-browser/discovery.mjs';

// Private root wire, bound to the profile created by this one bench session.
// Semantic commands still pass through the production broker/scoped transport.
// A page CDPSession cannot forward flattened sessionId routes from the root.
export async function connectRoot(profile, { WebSocketClass = globalThis.WebSocket, timeoutMs = 10000 } = {}) {
  const path = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const hint = parseActivePort(readFileSync(path, 'utf8'));
  const endpoint = validateEndpoint('ws://127.0.0.1:' + hint.port + hint.path);
  const socket = new WebSocketClass(endpoint), pending = new Map(), listeners = new Set();
  let sequence = 0, fenced = false, closed = false, closing;
  const fence = () => {
    fenced = true;
    for (const record of pending.values()) { clearTimeout(record.timer); record.reject(Error('BENCH_CDP_CLOSED')); }
    pending.clear();
  };
  const close = () => closing ??= (async () => {
    fence();
    if (!closed) await bounded(() => new Promise((resolve, reject) => {
      socket.addEventListener('close', resolve, { once: true });
      try { socket.close(); } catch { reject(Error('SOCKET_CLEANUP_UNPROVED')); }
      if (closed) resolve();
    }), timeoutMs);
    listeners.clear(); return true;
  })();
  socket.addEventListener('close', () => { closed = true; fence(); });
  socket.addEventListener('error', () => { fence(); });
  socket.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 8 * 1024 * 1024) throw Error();
      const frame = JSON.parse(event.data);
      if (frame.id !== undefined) {
        const record = pending.get(frame.id); if (!record) return;
        pending.delete(frame.id); clearTimeout(record.timer);
        if (frame.sessionId !== record.route || frame.error) record.reject(Error('BENCH_CDP_FAILED'));
        else record.resolve(frame.result);
      } else if (!fenced) for (const listener of listeners) listener(frame);
    } catch { fence(); void close().catch(() => {}); }
  });
  try {
    await bounded(() => new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      for (const name of ['close', 'error']) socket.addEventListener(name, () => reject(Error('BENCH_CDP_CLOSED')), { once: true });
    }), timeoutMs);
    return Object.freeze({ sessionId: 'root',
      on(name, listener) { if (name !== 'event') throw Error('BENCH_EVENT_DENIED'); listeners.add(listener); },
      off(name, listener) { if (name !== 'event') throw Error('BENCH_EVENT_DENIED'); listeners.delete(listener); }, close,
      send(method, params = {}, route) {
        if (fenced || ['Page.bringToFront', 'Target.activateTarget'].includes(method)) return Promise.reject(Error('BENCH_CDP_DENIED'));
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(Error('BENCH_CDP_TIMEOUT')); }, timeoutMs);
          pending.set(id, { route, resolve, reject, timer });
          try { socket.send(JSON.stringify({ id, method, params, ...(route === undefined ? {} : { sessionId: route }) })); }
          catch { fence(); }
        });
      } });
  } catch (error) {
    try { await close(); } catch { throw Error('SOCKET_CLEANUP_UNPROVED'); }
    throw error;
  }
}
