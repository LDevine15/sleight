// Turbo v3's private CDP boundary. Ownership is supplied by the trusted tab
// registry, never by a tool argument or page text. No upstream browser-wide
// auto-attach is installed: it would attach to the user's other tabs too.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const refuse = () => { throw Error('CDP_COMMAND_REFUSED'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const forbidden = new Set(['Page.bringToFront', 'Target.activateTarget']);
const domains = new Set(['Page', 'Runtime', 'DOM', 'DOMSnapshot', 'CSS', 'Accessibility', 'Input',
  'Network', 'Fetch', 'Log', 'Emulation', 'Inspector', 'Debugger', 'Performance']);

export function createCDPFilter({ session: upstream, ownedTargets = [] } = {}) {
  if (!upstream || !id(upstream.sessionId) || !['send', 'on', 'off'].every(name => typeof upstream[name] === 'function') ||
      !Array.isArray(ownedTargets) || !ownedTargets.every(id)) throw Error('CDP_CONNECTION_REQUIRED');
  const owned = new Set(ownedTargets), routes = new Map(), listeners = new Set(), attaching = new Map(), bridges = new Set(), browserRoutes = new Set(), attachmentParents = new Map();
  let closed = false, autoAttach = false, disposal;
  const root = upstream.sessionId;
  const live = () => { if (closed) throw Error('CDP_FILTER_CLOSED'); };
  const owns = target => owned.has(target) || [...routes.values()].some(route => route.target === target);
  const checkTarget = target => { if (!id(target) || !owns(target)) throw Error('CDP_TARGET_NOT_OWNED'); };
  function emit(event) { for (const listener of listeners) try { listener(event); } catch {} }
  function removeRoute(name) {
    for (const [child, route] of routes) if (route.parent === name) removeRoute(child);
    routes.delete(name);
  }
  function revoke(target) {
    owned.delete(target);
    for (const [name, route] of routes) if (route.target === target || route.owner === target) routes.delete(name);
  }
  function event(frame) {
    if (closed || !object(frame) || !object(frame.params)) return;
    const params = frame.params, parent = frame.sessionId === undefined ? undefined : routes.get(frame.sessionId);
    if (frame.sessionId !== undefined && !parent) return;
    if (frame.method === 'Target.attachedToTarget') {
      const info = params.targetInfo;
      if (!object(info) || !id(info.targetId) || !id(params.sessionId)) return;
      const allowed = parent ? ['iframe', 'worker'].includes(info.type) : owned.has(info.targetId) && info.type === 'page';
      if (!allowed) {
        // A shared service worker is not owned by a page. Undo its automatic
        // attachment without exposing any of its metadata to Playwright.
        if (parent) {
          if (params.waitingForDebugger) upstream.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
          upstream.send('Target.detachFromTarget', { sessionId: params.sessionId }, frame.sessionId).catch(() => {});
        }
        return;
      }
      if (routes.has(params.sessionId)) return;
      const virtualParent = parent ? frame.sessionId : attachmentParents.get(info.targetId);
      routes.set(params.sessionId, { target: info.targetId, owner: parent?.owner ?? info.targetId, parent: virtualParent });
      if (virtualParent && !parent) frame = { ...frame, sessionId: virtualParent };
    } else if (frame.method === 'Target.detachedFromTarget') {
      if (!routes.has(params.sessionId)) return;
      const detached = routes.get(params.sessionId), target = detached.target;
      if (browserRoutes.has(detached.parent)) frame = { ...frame, sessionId: detached.parent };
      removeRoute(params.sessionId);
      frame = { ...frame, params: { ...params, targetId: target } };
    } else if (frame.method.startsWith('Target.')) {
      const target = params.targetInfo?.targetId ?? params.targetId;
      if (!owns(target)) return;
      if (frame.method === 'Target.targetDestroyed') revoke(target);
    } else if (!parent) return; // No browser-global events or foreign sessions.
    emit(frame);
  }
  upstream.on('event', event);
  async function attach(target, virtualParent) {
    checkTarget(target);
    const previous = attaching.get(target);
    const pending = (async () => {
      if (previous) await previous.catch(() => {});
      live(); checkTarget(target);
      attachmentParents.set(target, virtualParent);
      try {
        const result = await upstream.send('Target.attachToTarget', { targetId: target, flatten: true });
        if (closed || !owns(target) || virtualParent && !browserRoutes.has(virtualParent)) {
          if (id(result?.sessionId)) await upstream.send('Target.detachFromTarget', { sessionId: result.sessionId }).catch(() => {});
          live(); checkTarget(target); throw Error('CDP_SESSION_NOT_OWNED');
        }
        if (!id(result?.sessionId)) throw Error('CDP_ATTACHMENT_INVALID');
        if (!routes.has(result.sessionId)) {
          const { targetInfo } = await upstream.send('Target.getTargetInfo', { targetId: target });
          live(); checkTarget(target);
          event({ method: 'Target.attachedToTarget', params: { sessionId: result.sessionId, targetInfo, waitingForDebugger: false } });
        }
        return result;
      } finally { attachmentParents.delete(target); }
    })();
    attaching.set(target, pending);
    try { return await pending; } finally { if (attaching.get(target) === pending) attaching.delete(target); }
  }
  async function own(target) {
    live(); if (!id(target)) throw Error('CDP_TARGET_NOT_OWNED');
    const { targetInfo } = await upstream.send('Target.getTargetInfo', { targetId: target });
    live();
    if (targetInfo?.targetId !== target || targetInfo.type !== 'page') throw Error('CDP_TARGET_NOT_OWNED');
    owned.add(target);
    if (autoAttach) await attach(target);
  }
  const session = Object.freeze({ sessionId: root,
    async send(method, params = {}, route = root) {
      live();
      if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*$/.test(method) || !object(params) || forbidden.has(method)) refuse();
      const isRoot = route === undefined || route === root || browserRoutes.has(route);
      if (!isRoot && !routes.has(route)) throw Error('CDP_SESSION_NOT_OWNED');
      const [domain] = method.split('.');
      if (domain === 'Browser') {
        if (!isRoot || method !== 'Browser.getVersion') refuse();
        return upstream.send(method, {});
      }
      if (domain === 'Target') {
        if (method === 'Target.attachToBrowserTarget' && isRoot) {
          const sessionId = 'sleight-browser-' + randomBytes(16).toString('hex');
          browserRoutes.add(sessionId); return { sessionId };
        }
        if (method === 'Target.setAutoAttach') {
          if (typeof params.autoAttach !== 'boolean' || params.flatten !== true) refuse();
          if (!isRoot) return upstream.send(method, { autoAttach: params.autoAttach, waitForDebuggerOnStart: true, flatten: true }, route);
          autoAttach = params.autoAttach;
          if (autoAttach) for (const target of owned) if (![...routes.values()].some(r => r.target === target)) await attach(target);
          return {};
        }
        if (method === 'Target.getTargets' && isRoot) {
          const { targetInfos } = await upstream.send(method, {});
          live(); return { targetInfos: targetInfos.filter(info => owns(info.targetId)) };
        }
        if (method === 'Target.setDiscoverTargets' && isRoot) return {}; // No global discovery side effects.
        if (method === 'Target.getTargetInfo') {
          if (isRoot && params.targetId === undefined) return { targetInfo: { targetId: 'sleight-browser', type: 'browser', title: '', url: '', attached: true } };
          const target = params.targetId ?? routes.get(route)?.target;
          checkTarget(target);
          const result = await upstream.send(method, { targetId: target }); live(); checkTarget(target); return result;
        }
        if (method === 'Target.createTarget' && isRoot) {
          if (typeof params.url !== 'string' || Object.keys(params).some(key => !['url', 'background'].includes(key)) || params.background === false) refuse();
          const result = await upstream.send(method, { url: params.url, background: true });
          await own(result.targetId); return result;
        }
        if (method === 'Target.attachToTarget' && isRoot) {
          if (params.flatten !== true) refuse();
          return attach(params.targetId, browserRoutes.has(route) ? route : undefined);
        }
        if (method === 'Target.closeTarget' && isRoot) {
          checkTarget(params.targetId); const result = await upstream.send(method, { targetId: params.targetId });
          if (result.success) revoke(params.targetId); return result;
        }
        if (method === 'Target.detachFromTarget') {
          if (browserRoutes.has(params.sessionId)) {
            const name = params.sessionId; browserRoutes.delete(name);
            const children = [...routes].filter(([, child]) => child.parent === name);
            for (const [child] of children) { removeRoute(child); await upstream.send(method, { sessionId: child }); }
            emit({ method: 'Target.detachedFromTarget', params: { sessionId: name } }); return {};
          }
          const child = routes.get(params.sessionId);
          if (!child || !isRoot && child.parent !== route) throw Error('CDP_SESSION_NOT_OWNED');
          return upstream.send(method, { sessionId: params.sessionId }, isRoot ? root : route);
        }
        refuse();
      }
      // Page-domain commands can never run on the browser connection. Unknown
      // domains stay closed, including SystemInfo, Tethering and window APIs.
      if (isRoot || !domains.has(domain)) refuse();
      return upstream.send(method, params, route);
    },
    on(name, listener) { live(); if (name !== 'event' || typeof listener !== 'function') throw Error('INVALID_CDP_EVENT'); listeners.add(listener); },
    off(name, listener) { if (name !== 'event') throw Error('INVALID_CDP_EVENT'); listeners.delete(listener); },
  });
  async function listen() {
    live();
    // The WS implementation is from the already bundled, pinned Playwright.
    // Loading the filter alone never loads Playwright or opens a listener.
    const { wsServer } = createRequire(import.meta.url)('../../vendor/playwright-core/lib/utilsBundle.js');
    const path = '/sleight/' + randomBytes(32).toString('hex');
    let client, closing;
    const server = new wsServer({ host: '127.0.0.1', port: 0, maxPayload: 1048576,
      verifyClient: ({ req }) => !closed && !client && req.url === path && !req.headers.origin });
    const listening = new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const write = frame => { if (client?.readyState === 1) client.send(JSON.stringify(frame)); };
    const forward = frame => write(frame);

    server.on('connection', socket => {
      if (client) { socket.close(); return; }
      client = socket;
      socket.on('error', () => {});
      socket.on('message', async bytes => {
        let frame;
        try {
          frame = JSON.parse(bytes.toString());
          if (!object(frame) || !Number.isSafeInteger(frame.id) || frame.id < 1) throw Error();
        } catch { socket.close(1008); return; }
        const route = frame.sessionId;
        try {
          const result = await session.send(frame.method, frame.params ?? {}, route);
          write({ id: frame.id, result, ...(route === undefined ? {} : { sessionId: route }) });
        } catch (error) {
          write({ id: frame.id, error: { code: -32000, message: /^CDP_/.test(error.message) ? error.message : 'CDP_COMMAND_FAILED' },
            ...(route === undefined ? {} : { sessionId: route }) });
        }
      });
    });
    const bridge = Object.freeze({ get endpoint() { return 'ws://127.0.0.1:' + server.address().port + path; },
      close() {
        if (closing) return closing;
        session.off('event', forward); bridges.delete(bridge);
        closing = (async () => {
          await listening;
          for (const socket of server.clients) socket.terminate();
          await new Promise(resolve => server.close(resolve));
        })();
        return closing;
      } });
    bridges.add(bridge);
    try {
      await listening;
      if (closed) { await bridge.close(); live(); }
      session.on('event', forward); return bridge;
    } catch (error) { bridges.delete(bridge); throw error; }
  }
  function dispose() {
    if (closed) return disposal;
    closed = true; upstream.off('event', event); listeners.clear();
    const detach = [...routes].filter(([, route]) => route.parent === undefined || browserRoutes.has(route.parent))
      .map(([name]) => upstream.send('Target.detachFromTarget', { sessionId: name }).then(() => true, () => false));
    routes.clear(); owned.clear(); browserRoutes.clear();
    const closing = [...bridges].map(bridge => bridge.close().then(() => true, () => false));
    disposal = Promise.all([...detach, ...closing]).then(results => results.every(Boolean));
    return disposal;
  }
  return Object.freeze({ session, owns, own, release: revoke, listen, dispose });
}
