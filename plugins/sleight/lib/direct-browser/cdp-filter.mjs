// Turbo v3's private CDP boundary. Ownership is supplied by the trusted tab
// registry, never by a tool argument or page text. No upstream browser-wide
// auto-attach is installed: it would attach to the user's other tabs too.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const refuse = () => { throw Error('CDP_COMMAND_REFUSED'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
// Cookie jars, device-bound sessions and download configuration belong to the
// browser profile/context. A page route cannot scope their URL/domain arguments.
const forbidden = new Set(['Page.bringToFront', 'Target.activateTarget',
  'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.getAllCookies',
  'Network.deleteCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies',
  'Network.enableDeviceBoundSessions', 'Network.deleteDeviceBoundSession', 'Page.deleteCookie', 'Page.setDownloadBehavior']);
// CDP Fetch patterns use glob wildcards, with backslash escaping.
function fetchMatch(pattern, params) {
  if (pattern.resourceType && pattern.resourceType !== params.resourceType) return false;
  const stage = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined ? 'Response' : 'Request';
  if ((pattern.requestStage ?? 'Request') !== stage) return false;
  let source = '^', escaped = false;
  for (const char of pattern.urlPattern ?? '*') {
    if (!escaped && char === '\\') { escaped = true; continue; }
    source += !escaped && char === '*' ? '.*' : !escaped && char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    escaped = false;
  }
  if (escaped) source += '\\\\';
  return new RegExp(source + '$', 's').test(params.request?.url ?? '');
}
const domains = new Set(['Page', 'Runtime', 'DOM', 'DOMSnapshot', 'CSS', 'Accessibility', 'Input',
  'Network', 'Fetch', 'Log', 'Emulation', 'Inspector', 'Debugger', 'Performance']);

export function createCDPFilter({ session: upstream, ownedTargets = [], protectedPort } = {}) {
  if (!upstream || !id(upstream.sessionId) || !['send', 'on', 'off'].every(name => typeof upstream[name] === 'function') ||
      !Array.isArray(ownedTargets) || !ownedTargets.every(id)) throw Error('CDP_CONNECTION_REQUIRED');
  if (protectedPort !== undefined && (!Number.isInteger(protectedPort) || protectedPort < 1 || protectedPort > 65535)) throw Error('CDP_CONNECTION_REQUIRED');
  const guardPatterns = protectedPort === undefined ? [] : [{ urlPattern: '*://*:' + protectedPort + '/*', requestStage: 'Request' },
    ...([80,443].includes(protectedPort) ? [{ urlPattern: (protectedPort === 80 ? 'http' : 'https') + '://*/*', requestStage: 'Request' }] : [])];
  const protectedUrl = url => {
    try { const parsed = new URL(url); return Number(parsed.port || (['https:','wss:'].includes(parsed.protocol) ? 443 : 80)) === protectedPort; }
    catch { return false; }
  };
  const owned = new Set(ownedTargets), routes = new Map(), listeners = new Set(), attaching = new Map(), bridges = new Set(), browserRoutes = new Set(), attachmentParents = new Map();
  const endpointTargets = new Set();
  const attachments = new Map(), outstanding = new Set(), collectedSessions = new Set();
  let closed = false, autoAttach = false, disposal, listening = true;
  const root = upstream.sessionId;
  const live = () => { if (closed) throw Error('CDP_FILTER_CLOSED'); };
  const owns = target => owned.has(target) || [...routes.values()].some(route => route.target === target);
  const checkTarget = target => { if (!id(target) || !owns(target)) throw Error('CDP_TARGET_NOT_OWNED'); };
  const autoAttachParams = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'iframe' }, { type: 'worker' }, { exclude: true }] };
  const routed = (frame, parent) => {
    const value = { ...frame };
    if (parent === undefined) delete value.sessionId; else value.sessionId = parent;
    return value;
  };
  function emit(event) { for (const listener of listeners) try { listener(event); } catch {} }
  function finishEvents() {
    if (closed && listening && !attachments.size && !outstanding.size) {
      upstream.off('event', event); listening = false;
    }
  }
  function removeRoute(name) {
    for (const [child, route] of routes) if (route.parent === name) removeRoute(child);
    routes.delete(name);
  }
  // Input authority can disappear before a session is physically detached.
  // Keep the actual upstream parent, not the virtual browser route, for cleanup.
  function acquired(name, target, parent = root, virtualParent) {
    if (collectedSessions.has(name)) return false;
    if (!attachments.has(name)) attachments.set(name, { target, parent, virtualParent });
    return true;
  }
  function collected(name) {
    for (const [child, attachment] of attachments) if (attachment.parent === name) collected(child);
    attachments.delete(name); collectedSessions.add(name); removeRoute(name);
    finishEvents();
  }
  async function detach(name) {
    const attachment = attachments.get(name);
    if (!attachment) return true;
    if (attachment.detaching) return attachment.detaching;
    attachment.detaching = (async () => {
      try {
        await upstream.send('Target.detachFromTarget', { sessionId: name }, attachment.parent);
        collected(name); return true;
      } catch { return !attachments.has(name); }
    })();
    try { return await attachment.detaching; } finally { attachment.detaching = undefined; }
  }
  function revoke(target) {
    owned.delete(target);
    for (const [name, route] of routes) if (route.target === target || route.owner === target) removeRoute(name);
  }
  function event(frame) {
    if (!object(frame) || typeof frame.method !== 'string' || !object(frame.params) ||
        frame.sessionId !== undefined && !id(frame.sessionId)) return;
    const params = frame.params;
    // Collection proof uses the physical attachment bank even after routes are
    // revoked. Only its exact upstream parent can report this session detached.
    if (frame.method === 'Target.detachedFromTarget') {
      const detached = id(params.sessionId) && attachments.get(params.sessionId);
      if (!detached || (frame.sessionId ?? root) !== detached.parent ||
          params.targetId !== undefined && params.targetId !== detached.target) return;
      const virtualParent = detached.virtualParent;
      collected(params.sessionId);
      if (!closed && !detached.private) emit(routed({ ...frame, params: { ...params, targetId: detached.target } }, virtualParent));
      return;
    }
    if (closed && frame.method !== 'Target.attachedToTarget') return;
    const parent = frame.sessionId === undefined ? undefined : (closed ? attachments : routes).get(frame.sessionId);
    if (frame.sessionId !== undefined && !parent) return;
    if (parent && protectedPort !== undefined && frame.method === 'Fetch.requestPaused') {
      const protectedRequest = protectedUrl(params.request?.url);
      if (protectedRequest && params.resourceType === 'Document') endpointTargets.add(parent.owner);
      if (protectedRequest || !(parent.fetchPatterns ?? []).some(pattern => fetchMatch(pattern, params))) {
        upstream.send(protectedRequest ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          { requestId: params.requestId, ...(protectedRequest ? { errorReason: 'BlockedByClient' } : {}) }, frame.sessionId)
          .catch(error => {
            // Cancellation can invalidate a paused request before its reply.
            // Only that protocol error proves this interception already ended.
            if (/^Invalid InterceptionId\.?$/.test(error.message)) return;
            removeRoute(frame.sessionId); detach(frame.sessionId).catch(() => {});
          });
        return;
      }
    }
    if (frame.method === 'Target.attachedToTarget') {
      const info = params.targetInfo;
      if (!object(info) || !id(info.targetId) || !id(params.sessionId)) return;
      const allowed = parent ? ['iframe', 'worker'].includes(info.type) :
        (closed ? attachmentParents.has(info.targetId) : owned.has(info.targetId)) && info.type === 'page';
      if (!allowed) {
        // Unrelated targets never acquire a route or expose their metadata.
        if (parent && !closed) {
          if (params.waitingForDebugger) upstream.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
          upstream.send('Target.detachFromTarget', { sessionId: params.sessionId }, frame.sessionId).catch(() => {});
        }
        return;
      }
      if (routes.has(params.sessionId)) return;
      const virtualParent = parent ? info.type === 'page' ? parent.browserParent : frame.sessionId : attachmentParents.get(info.targetId);
      if (!acquired(params.sessionId, info.targetId, frame.sessionId ?? root, virtualParent)) return;
      if (closed) return; // Late attachments stay private and grant no input route.
      const route = { target: info.targetId, owner: parent?.owner ?? info.targetId, parent: virtualParent,
        browserParent: parent ? parent.browserParent : virtualParent };
      attachments.get(params.sessionId).private = route.private;
      routes.set(params.sessionId, route);
      frame = routed(frame, virtualParent);
      if (protectedPort !== undefined) {
        route.ready = (async () => {
          await upstream.send('Fetch.enable', { patterns: guardPatterns }, params.sessionId);
          // Install this independently of Playwright, including on every child.
          // A paused target cannot make its first request before the guard exists.
          await upstream.send('Target.setAutoAttach', autoAttachParams, params.sessionId);
          if (closed || routes.get(params.sessionId) !== route) return;
          if (!route.private) emit(frame);
          if (params.waitingForDebugger) await upstream.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
        })();
        route.ready.catch(() => { removeRoute(params.sessionId); detach(params.sessionId).catch(() => {}); });
        return;
      }
    } else if (frame.method.startsWith('Target.')) {
      const target = params.targetInfo?.targetId ?? params.targetId;
      if (!owns(target)) return;
      if (frame.method === 'Target.targetDestroyed') revoke(target);
    } else if (!parent) return; // No browser-global events or foreign sessions.
    if (!parent?.private) emit(frame);
  }
  upstream.on('event', event);
  async function attach(target, virtualParent) {
    checkTarget(target);
    const previous = attaching.get(target);
    const pending = (async () => {
      if (previous) await previous.catch(() => {});
      live(); checkTarget(target);
      attachmentParents.set(target, virtualParent);
      let name;
      try {
        const request = {}; outstanding.add(request);
        let result;
        try { result = await upstream.send('Target.attachToTarget', { targetId: target, flatten: true }); }
        finally { outstanding.delete(request); }
        if (!id(result?.sessionId)) throw Error('CDP_ATTACHMENT_INVALID');
        name = result.sessionId;
        if (!acquired(name, target, root, virtualParent)) throw Error('CDP_SESSION_NOT_OWNED');
        live(); checkTarget(target);
        if (virtualParent && !browserRoutes.has(virtualParent)) throw Error('CDP_SESSION_NOT_OWNED');
        if (!routes.has(result.sessionId)) {
          const { targetInfo } = await upstream.send('Target.getTargetInfo', { targetId: target });
          live(); checkTarget(target);
          if (targetInfo?.targetId !== target || targetInfo.type !== 'page') throw Error('CDP_ATTACHMENT_INVALID');
          event({ method: 'Target.attachedToTarget', params: { sessionId: result.sessionId, targetInfo, waitingForDebugger: false } });
        }
        if (routes.get(name)?.target !== target) throw Error('CDP_ATTACHMENT_INVALID');
        await routes.get(name).ready;
        live(); checkTarget(target);
        return result;
      } catch (error) {
        if (name) await detach(name);
        throw error;
      } finally { attachmentParents.delete(target); finishEvents(); }
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
    if (autoAttach && ![...routes.values()].some(route => route.target === target)) await attach(target);
  }
  const session = Object.freeze({ sessionId: root,
    async send(method, params = {}, route = root) {
      live();
      if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*$/.test(method) || !object(params) || forbidden.has(method)) refuse();
      const isRoot = route === undefined || route === root || browserRoutes.has(route);
      if (!isRoot && !routes.has(route)) throw Error('CDP_SESSION_NOT_OWNED');
      if (!isRoot) {
        const ownedRoute = routes.get(route);
        await ownedRoute.ready;
        live(); if (routes.get(route) !== ownedRoute) throw Error('CDP_SESSION_NOT_OWNED');
      }
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
          if (!isRoot) return upstream.send(method, protectedPort !== undefined ? autoAttachParams :
            { autoAttach: params.autoAttach, waitForDebuggerOnStart: true, flatten: true }, route);
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
          // Attach the port guard before the first untrusted navigation. The
          // owned registry creates blank targets and navigates after admission.
          if (protectedPort !== undefined && params.url !== 'about:blank') refuse();
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
            const children = [...attachments].filter(([, child]) => child.virtualParent === name && child.parent === root);
            for (const [child] of children) { removeRoute(child); if (!await detach(child)) throw Error('CDP_DETACH_UNCONFIRMED'); }
            emit({ method: 'Target.detachedFromTarget', params: { sessionId: name } }); return {};
          }
          const child = routes.get(params.sessionId);
          if (!child || !isRoot && child.parent !== route) throw Error('CDP_SESSION_NOT_OWNED');
          removeRoute(params.sessionId);
          if (!await detach(params.sessionId)) throw Error('CDP_DETACH_UNCONFIRMED');
          return {};
        }
        refuse();
      }
      // Page-domain commands can never run on the browser connection. Unknown
      // domains stay closed, including SystemInfo, Tethering and window APIs.
      if (isRoot || !domains.has(domain)) refuse();
      if (protectedPort !== undefined && domain === 'Fetch') {
        if (method === 'Fetch.enable' || method === 'Fetch.disable') {
          const ownedRoute = routes.get(route), previous = ownedRoute.fetchPatterns;
          const patterns = method === 'Fetch.disable' ? [] : params.patterns?.length ? params.patterns : [{ urlPattern: '*' }];
          ownedRoute.fetchPatterns = patterns;
          try { return await upstream.send('Fetch.enable', { ...(method === 'Fetch.enable' ? params : {}), patterns: [...patterns, ...guardPatterns] }, route); }
          catch (error) { if (ownedRoute.fetchPatterns === patterns) ownedRoute.fetchPatterns = previous; throw error; }
        }
        if (['Fetch.continueRequest','Fetch.continueResponse'].includes(method) && params.url && protectedUrl(params.url)) refuse();
      }
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
        session.off('event', forward);
        closing = (async () => {
          await listening;
          for (const socket of server.clients) socket.terminate();
          await new Promise(resolve => server.close(resolve));
          bridges.delete(bridge);
        })().catch(error => { closing = undefined; throw error; });
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
    if (disposal) return disposal;
    if (!closed) {
      closed = true; listeners.clear();
      routes.clear(); owned.clear(); browserRoutes.clear();
      finishEvents();
    }
    const detaching = [...attachments].filter(([, attachment]) => !attachments.has(attachment.parent))
      .map(([name]) => detach(name));
    const closing = [...bridges].map(bridge => bridge.close().then(() => true, () => false));
    disposal = Promise.all([...detaching, ...closing]).then(results => results.every(Boolean) && !outstanding.size && !attachments.size && !bridges.size)
      .finally(() => { disposal = undefined; });
    return disposal;
  }
  return Object.freeze({ session, owns, own, release: revoke, listen, dispose, endpointBlocked: target => endpointTargets.has(target) });
}
