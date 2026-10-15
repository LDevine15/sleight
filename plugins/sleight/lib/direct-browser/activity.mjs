// Network activity after a click. A script-driven control that did nothing visible can give back its payment activation
// only if nothing at all left the browser afterwards, until the next payment check. The watch sits on the browser context,
// not the page: every request that was started (any resource type, including beacons, images, EventSource and requests from
// workers and service workers, failed, CORS-blocked and aborted ones too), every WebSocket created or frame sent, every new
// page, worker and service worker. A page this module never tracked, or a context without these events, is unobservable.
const trackers = new WeakMap(), flights = new WeakMap();
const WATCH_MS = 120000, MAX_FLIGHTS = 512;

// Requests that have started and not yet finished or failed on a context, kept from the moment its first page is adopted.
// One that is still open when a click happens (a streaming upload, a long poll) can carry data after the click without any new event.
function trackFlights(context) {
  if (flights.has(context) || typeof context?.on !== 'function') return;
  // Past the cap a request is counted but not kept, and the count drops when an unkept request ends: an entry is never evicted
  // while it is open, so a page that opens many requests first cannot hide a long-lived one.
  const state = { open: new Set(), overflow: 0, size: () => state.open.size + state.overflow };
  flights.set(context, state);
  context.on('request', request => { if (state.open.size < MAX_FLIGHTS) state.open.add(request); else state.overflow++; });
  for (const event of ['requestfinished', 'requestfailed']) context.on(event, request => {
    if (!state.open.delete(request) && state.overflow > 0) state.overflow--;
  });
}

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
  try { trackFlights(typeof page.context === 'function' ? page.context() : undefined); } catch {}
}

// maxMs caps how long the listeners stay on the browser context: a refund that is never settled (the turn moves on, no further
// payment check) must not keep them for good. Past the cap the watch detaches and counts as not quiet.
export function observeActivity(page, { maxMs = WATCH_MS } = {}) {
  const context = typeof page?.context === 'function' ? page.context() : undefined, seen = trackers.get(page), open = flights.get(context);
  if (!seen || !open || typeof context?.on !== 'function' || typeof context.off !== 'function') return { observable: false, quiet: () => false, stop() {} };
  let events = 0, stopped = false, expired = false, final, timer;
  const inflight = open.size(), bases = new Map(), listeners = [], pages = new Set();
  const bump = () => { if (!stopped) events++; };
  const listen = (emitter, event, fn = bump) => { emitter.on(event, fn); listeners.push(() => emitter.off(event, fn)); };
  const hook = other => {
    if (pages.has(other) || typeof other?.on !== 'function') return;
    pages.add(other);
    const own = trackers.get(other);
    bases.set(other, own ? { sockets: own.sockets, frames: own.frames } : { sockets: 0, frames: 0 });
    for (const event of ['websocket', 'worker', 'popup', 'close', 'download', 'filechooser']) listen(other, event);
  };
  for (const event of ['request', 'requestfailed', 'requestfinished', 'serviceworker', 'weberror']) listen(context, event);
  listen(context, 'page', other => { bump(); hook(other); });
  for (const other of context.pages?.() ?? []) hook(other);
  hook(page);
  // Sockets created and frames sent on every page the watch holds, not only the page that was clicked.
  const count = () => {
    let n = events;
    for (const [other, base] of bases) { const now = trackers.get(other); if (now) n += now.sockets - base.sockets + now.frames - base.frames; }
    return n;
  };
  const origin = url => { try { const u = new URL(url); return u.protocol === 'blob:' ? new URL(u.pathname).origin : u.origin; } catch { return 'null'; } };
  // Same site, approximately: scheme plus the last two host labels (the whole host for an address or a single label).
  const site = url => {
    try { const u = new URL(url); const h = u.hostname, labels = h.split('.');
      return u.protocol + '//' + (labels.length < 2 || /^[\d.]+$|:/.test(h) ? h : labels.slice(-2).join('.')); } catch { return 'null'; }
  };
  // A target whose requests this connection can't see: a dedicated worker (attached, but its network events aren't reported),
  // a service or shared worker of this page's origins (never attached), a frame of another origin (its process isn't attached),
  // a tab of the page's own site that the context doesn't hold (a BroadcastChannel or storage event reaches it, nothing here watches it),
  // a page the watch holds that was never tracked (its open sockets are unknown).
  const hidden = async () => {
    if (page.isClosed?.() || (page.workers?.() ?? []).length || inflight) return true;
    const mine = origin(page.mainFrame().url()), origins = new Set();
    for (const frame of page.frames()) {
      const url = frame.url(), here = /^(?:about:blank|about:srcdoc)$/.test(url) ? mine : origin(url);
      if (here !== mine) return true;
      origins.add(here);
    }
    if ([...pages].some(other => !trackers.has(other))) return true;
    if (typeof seen.targets !== 'function') return true;
    const infos = (await seen.targets())?.targetInfos;
    if (!Array.isArray(infos)) return true;
    const mineSite = site(mine), owned = [...(context.pages?.() ?? [])].filter(other => site(other.mainFrame().url()) === mineSite).length;
    if (infos.filter(info => info.type === 'page' && site(info.url) === mineSite).length > owned) return true;
    return infos.some(info => ['service_worker', 'shared_worker', 'worker'].includes(info.type) && (origin(info.url) === 'null' || origins.has(origin(info.url))));
  };
  const stop = () => { if (stopped) return; clearTimeout(timer); final = count(); stopped = true; for (const off of listeners) off(); };
  if (maxMs > 0) { timer = setTimeout(() => { expired = true; stop(); }, maxMs); timer.unref?.(); }
  return {
    observable: true,
    // Settle-time proof that nothing sits outside the watch, then the count itself stays checked until the next payment check.
    async verify() { try { return !await hidden(); } catch { return false; } },
    quiet: () => !expired && !inflight && (final === undefined ? count() === 0 : final === 0),
    stop,
  };
}
