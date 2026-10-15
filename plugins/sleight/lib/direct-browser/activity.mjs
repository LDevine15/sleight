// Network activity after a click. A script-driven control that did nothing visible can give back its payment activation
// only if nothing at all left the browser afterwards, until the next payment check. The watch sits on the browser context,
// not the page: every request that was started (any resource type, including beacons, images, EventSource and requests from
// workers and service workers, failed, CORS-blocked and aborted ones too), every WebSocket created or frame sent, every new
// page, worker and service worker. A page this module never tracked, or a context without these events, is unobservable.
const trackers = new WeakMap(), flights = new WeakMap();
const WATCH_MS = 120000, MAX_FLIGHTS = 512;

// Requests that have started and not yet finished or failed on a context, kept from the moment its first page is adopted.
// One that is still open when a click happens (a streaming upload, a long poll) can carry data after the click without any new event.
// A request whose document is gone stops counting: Playwright never reports the end of a request still open when its page closes or
// its frame moves to a new document, so those are dropped when the page closes, the frame detaches, or the frame commits a navigation
// that this tracker saw start (a navigation request in the frame, or a change of origin). A same-document change (pushState, a hash,
// a download or a 204 that never commits) drops nothing: a page must not be able to forget a request it opened.
// Watches already running keep what they counted: the request event bumped them when it opened.
function trackFlights(context) {
  if (flights.has(context) || typeof context?.on !== 'function') return;
  // Past the cap a request is counted per frame but not kept, and the count drops when an unkept request ends: an entry is never
  // evicted while it is open, so a page that opens many requests first cannot hide a long-lived one.
  const state = { open: new Map(), overflow: new Map(), hooked: new WeakSet(), navs: new Map(), origins: new WeakMap(), fresh: new WeakMap(), seq: 0,
    size: () => state.open.size + [...state.overflow.values()].reduce((n, x) => n + x, 0) };
  flights.set(context, state);
  const frameOf = request => { try { return request.frame(); } catch { return null; } };
  const pageOf = frame => { try { return frame?.page?.() ?? null; } catch { return null; } };
  const originOf = url => { try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : 'null'; } catch { return 'null'; } };
  const dropWhere = (test, keepOverflow = false) => {
    for (const [request, record] of state.open) if (test(record)) state.open.delete(request);
    if (!keepOverflow) for (const frame of state.overflow.keys()) if (test({ frame, page: pageOf(frame) })) state.overflow.delete(frame);
  };
  context.on('request', request => {
    const frame = frameOf(request), seq = ++state.seq;
    let nav = false; try { nav = frame !== null && request.isNavigationRequest() === true; } catch {}
    if (nav) { const entry = state.navs.get(frame) ?? { seq, requests: new Set() }; entry.requests.add(request); state.navs.set(frame, entry); }
    if (state.open.size < MAX_FLIGHTS) state.open.set(request, { frame, page: pageOf(frame), seq, nav });
    else state.overflow.set(frame, (state.overflow.get(frame) ?? 0) + 1);
  });
  for (const event of ['requestfinished', 'requestfailed']) context.on(event, request => {
    const frame = frameOf(request);
    const entry = frame ? state.navs.get(frame) : undefined;
    if (entry) { entry.requests.delete(request); if (!entry.requests.size) state.navs.delete(frame); }
    if (state.open.delete(request)) return;
    const n = state.overflow.get(frame) ?? 0;
    if (n > 1) state.overflow.set(frame, n - 1); else state.overflow.delete(frame);
  });
  const hook = page => {
    if (state.hooked.has(page) || typeof page?.on !== 'function') return;
    state.hooked.add(page);
    page.on('close', () => { for (const frame of state.navs.keys()) if (pageOf(frame) === page) state.navs.delete(frame); dropWhere(record => record.page === page); });
    page.on('framedetached', frame => { state.navs.delete(frame); dropWhere(record => record.frame === frame); });
    // The vendored client says whether a commit loaded a new document (newDocument) on the frame's own emitter, just before the page
    // event. When that is not there (another Playwright build), the guess is: a navigation request seen in the frame, or an origin change.
    const watchFrame = frame => {
      try { frame._eventEmitter.on('navigated', event => { state.fresh.set(frame, !!event?.newDocument); }); } catch {}
      state.origins.set(frame, originOf(frame.url()));
    };
    page.on('frameattached', watchFrame);
    page.on('framenavigated', frame => {
      const origin = originOf(frame.url()), before = state.origins.get(frame), entry = state.navs.get(frame), fresh = state.fresh.get(frame);
      state.origins.set(frame, origin); state.fresh.delete(frame);
      if (!(fresh ?? (entry !== undefined || before !== undefined && before !== origin))) return;
      // Everything the frame had open, except the navigation requests that began this navigation or later (the new document's own).
      dropWhere(record => record.frame === frame && !(record.nav && entry && record.seq >= entry.seq));
    });
    try { for (const frame of page.frames?.() ?? []) watchFrame(frame); } catch {}
  };
  state.hook = hook;
  try { for (const page of context.pages?.() ?? []) hook(page); } catch {}
  context.on('page', hook);
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
  try {
    const context = typeof page.context === 'function' ? page.context() : undefined;
    trackFlights(context);
    flights.get(context)?.hook(page);
  } catch {}
}

// How many requests the context has open that count against a refund (for the tests).
export function openRequestCount(page) {
  const state = flights.get(typeof page?.context === 'function' ? page.context() : undefined);
  return state ? state.size() : 0;
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
    // A dedicated worker of any page the context holds (an earlier popup too) fetches without a report to the context.
    if (page.isClosed?.() || inflight || [...pages, page].some(other => (other.workers?.() ?? []).length)) return true;
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
    // Any worker target the watch does not see through a page it holds: one of an origin a held page shows, or of an origin it can't name.
    for (const other of pages) for (const frame of other.frames?.() ?? []) origins.add(origin(frame.url()));
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
