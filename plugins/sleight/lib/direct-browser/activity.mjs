// Network activity after a click. A script-driven control that did nothing visible can give back its payment activation
// only if nothing at all left the browser afterwards, until the next payment check. The watch sits on the browser context,
// not the page: every request that was started (any resource type, including beacons, images, EventSource and requests from
// workers and service workers, failed, CORS-blocked and aborted ones too), every WebSocket created or frame sent, every new
// page, worker and service worker. A page this module never tracked, or a context without these events, is unobservable.
const trackers = new WeakMap();

// Call once when the page is adopted, before the page runs anything: a WebSocket opened earlier can only be seen from its start.
// targets() lists the browser's targets (Target.getTargets on the approved connection): service and shared workers are not attached
// through the CDP filter, so only this list shows that one exists.
export function trackPage(page, { targets } = {}) {
  if (trackers.has(page) || typeof page?.on !== 'function') return;
  const seen = { sockets: 0, frames: 0, targets };
  trackers.set(page, seen);
  page.on('websocket', socket => {
    seen.sockets++;
    socket.on('framesent', () => { seen.frames++; });
  });
}

export function observeActivity(page) {
  const context = typeof page?.context === 'function' ? page.context() : undefined, seen = trackers.get(page);
  if (!seen || typeof context?.on !== 'function' || typeof context.off !== 'function') return { observable: false, quiet: () => false, stop() {} };
  let events = 0, stopped = false, final;
  const base = { ...seen }, listeners = [], pages = new Set();
  const bump = () => { if (!stopped) events++; };
  const listen = (emitter, event, fn = bump) => { emitter.on(event, fn); listeners.push(() => emitter.off(event, fn)); };
  const hook = other => {
    if (pages.has(other) || typeof other?.on !== 'function') return;
    pages.add(other);
    for (const event of ['websocket', 'worker', 'popup', 'close', 'download', 'filechooser']) listen(other, event);
  };
  for (const event of ['request', 'requestfailed', 'requestfinished', 'serviceworker', 'weberror']) listen(context, event);
  listen(context, 'page', other => { bump(); hook(other); });
  for (const other of context.pages?.() ?? []) hook(other);
  hook(page);
  const count = () => events + (seen.sockets - base.sockets) + (seen.frames - base.frames);
  const origin = url => { try { const u = new URL(url); return u.protocol === 'blob:' ? new URL(u.pathname).origin : u.origin; } catch { return 'null'; } };
  // A target whose requests this connection can't see: a dedicated worker (attached, but its network events aren't reported),
  // a service or shared worker of this page's origins (never attached), a frame of another origin (its process isn't attached).
  const hidden = async () => {
    if (page.isClosed?.() || (page.workers?.() ?? []).length) return true;
    const mine = origin(page.mainFrame().url()), origins = new Set();
    for (const frame of page.frames()) {
      const url = frame.url(), here = /^(?:about:blank|about:srcdoc)$/.test(url) ? mine : origin(url);
      if (here !== mine) return true;
      origins.add(here);
    }
    if (typeof seen.targets !== 'function') return true;
    const infos = (await seen.targets())?.targetInfos;
    if (!Array.isArray(infos)) return true;
    return infos.some(info => ['service_worker', 'shared_worker', 'worker'].includes(info.type) && (origin(info.url) === 'null' || origins.has(origin(info.url))));
  };
  return {
    observable: true,
    // Settle-time proof that nothing sits outside the watch, then the count itself stays checked until the next payment check.
    async verify() { try { return !await hidden(); } catch { return false; } },
    quiet: () => final === undefined ? count() === 0 : final === 0,
    stop() { if (stopped) return; final = count(); stopped = true; for (const off of listeners) off(); },
  };
}
