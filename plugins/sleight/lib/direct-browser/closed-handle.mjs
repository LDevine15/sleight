// A control inside a closed shadow root cannot be found by any page-side query, Playwright's included. The snapshot
// already names such a control by its CDP backend node. This module turns that node into an ordinary Playwright
// ElementHandle from the Node side: DOM.resolveNode through the frame's own session, then a client handle for it.
// Every rule read, click, fill and key press then runs on the exact pinned node, like any light-DOM control.
//
// Playwright 1.64.0 is pinned and runs in-process (see trusted-dom.mjs), so the client connection can map a client
// object to its server object and back. Nothing here evaluates page JavaScript to find the element, and the one
// bootstrap evaluation below only learns a class, never trusts the element it returns.
const classes = new WeakMap(), details = new WeakMap();
const unavailable = () => Error('Closed-root actions need the in-process browser connection; use the engine browser path.');
const stale = () => Error('Closed-root ref is stale or unavailable; take a new snapshot.');
const tick = () => new Promise(resolve => setImmediate(resolve));

// What the Node side learned about a resolved handle: its backend node and whether it hosts a closed root itself.
// Absent for every handle that did not come from this module.
export const closedDetails = handle => details.get(handle);

async function dispatcherClass(connection, dispatchers, frame) {
  let found = classes.get(dispatchers);
  if (found) return found;
  // Any element handle's dispatcher is an ElementHandleDispatcher. The returned element is only used for its class.
  const seed = await frame.evaluateHandle(() => document.documentElement);
  try {
    const dispatcher = dispatchers._dispatcherByGuid.get(seed._guid);
    if (!dispatcher?._type_ElementHandle || typeof dispatcher.constructor?.fromJSOrElementHandle !== 'function') throw unavailable();
    found = dispatcher.constructor; classes.set(dispatchers, found);
    return found;
  } finally { await seed.dispose().catch(() => {}); }
}

// binding is closedRefBinding(page, ref): the Playwright frame and the CDP backend node of the control. A same-process
// child frame shares its parent's CDP session, so the binding's frame can be the parent of the frame that owns the node,
// and a cross-origin child can refuse the parent's context outright. Backend ids are unique per process only, so the
// owner is searched among frames of the same session, and the handle's own ownerFrame() must confirm the choice.
export async function resolveClosedHandle({ frame, backendNodeId }) {
  const connection = frame?._connection, toImpl = connection?.toImpl;
  if (typeof toImpl !== 'function' || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw unavailable();
  const frameImpl = toImpl.call(connection, frame), dispatchers = toImpl.call(connection, connection);
  const delegate = frameImpl?._page?.delegate;
  if (!frameImpl || !dispatchers?._dispatcherByGuid || typeof delegate?._sessionForFrame !== 'function') throw unavailable();
  const session = delegate._sessionForFrame(frameImpl);
  // A closed host is invisible to DOM evidence from inside the page, so ask the DOM agent whether this node hosts one.
  // Anything but a clear "no" counts as a host.
  const described = await session._client._sendMayFail('DOM.describeNode', { backendNodeId });
  const hostsRoot = !described?.node || (described.node.shadowRoots?.length ?? 0) > 0;
  const Dispatcher = await dispatcherClass(connection, dispatchers, frame);
  const sameSession = candidate => delegate._sessionForFrame(candidate) === session;
  const build = async candidate => {
    let impl;
    try { impl = await session._adoptBackendNodeId(backendNodeId, await candidate.mainContext()); } catch { return null; }
    try {
      const scope = candidate === frameImpl ? dispatchers._dispatcherByGuid.get(frame._guid) : dispatchers.existingDispatcher(candidate);
      const dispatcher = Dispatcher.fromJSOrElementHandle(scope, impl);
      // The in-process transport delivers the object-creation message on a later tick.
      for (let n = 0; n < 200 && !connection._objects?.has(dispatcher._guid); n++) await tick();
      const handle = connection._objects?.get(dispatcher._guid);
      if (typeof handle?.click !== 'function') throw unavailable();
      return handle;
    } catch (error) { try { await impl.dispose(); } catch { /* already gone */ } throw error; }
  };
  const order = [frameImpl, ...(frameImpl._page.frames?.() ?? []).filter(candidate => candidate !== frameImpl && sameSession(candidate))];
  const tried = new Set();
  let next = order[0];
  while (next && tried.size < 32) {
    tried.add(next);
    const handle = await build(next);
    if (handle) {
      let ownerImpl;
      try { const owner = await handle.ownerFrame(); ownerImpl = owner && toImpl.call(connection, owner); } catch { /* detached */ }
      if (ownerImpl === next) {
        details.set(handle, Object.freeze({ backendNodeId, hostsRoot }));
        return handle;
      }
      await handle.dispose().catch(() => {});
      if (ownerImpl && !tried.has(ownerImpl) && sameSession(ownerImpl)) { next = ownerImpl; continue; }
    }
    next = order.find(candidate => !tried.has(candidate));
  }
  throw stale();
}

// CDP evidence for a handle that did not come from this module: false when the DOM agent names no shadow root of any
// kind on the node, so it cannot hide a closed root's focused control behind itself. Anything else, a failed call
// included, is undefined and keeps the proof's refusal.
export async function hostsRootEvidence(handle) {
  try {
    const connection = handle?._connection, toImpl = connection?.toImpl;
    const impl = typeof toImpl === 'function' ? toImpl.call(connection, handle) : undefined;
    const owner = await handle.ownerFrame(), frameImpl = owner && toImpl.call(connection, owner);
    const session = frameImpl?._page?.delegate?._sessionForFrame?.(frameImpl);
    if (typeof impl?._objectId !== 'string' || !session?._client?._sendMayFail) return undefined;
    const described = await session._client._sendMayFail('DOM.describeNode', { objectId: impl._objectId });
    return described?.node && (described.node.shadowRoots?.length ?? 0) === 0 ? false : undefined;
  } catch { return undefined; }
}

// CDP evidence about script listeners on a link: false when DOMDebugger lists no click, mousedown, pointerdown, pointerup, auxclick or
// keydown listener on the element or inside it (depth -1 lists that subtree and nothing above it, so a framework that delegates from an
// ancestor or the document does not count), true when it lists one, undefined when the enumeration is unavailable or fails.
export async function clickListeners(handle) {
  try {
    const connection = handle?._connection, toImpl = connection?.toImpl;
    const impl = typeof toImpl === 'function' ? toImpl.call(connection, handle) : undefined;
    const owner = await handle.ownerFrame(), frameImpl = owner && toImpl.call(connection, owner);
    const session = frameImpl?._page?.delegate?._sessionForFrame?.(frameImpl);
    if (typeof impl?._objectId !== 'string' || !session?._client?._sendMayFail) return undefined;
    const found = await session._client._sendMayFail('DOMDebugger.getEventListeners', { objectId: impl._objectId, depth: -1 });
    if (!Array.isArray(found?.listeners)) return undefined;
    return found.listeners.some(listener => ['click', 'mousedown', 'pointerdown', 'pointerup', 'auxclick', 'keydown'].includes(listener?.type));
  } catch { return undefined; }
}

const unsupported = name => () => { throw Error(name + ' cannot search inside a closed shadow root; act on the refs from the page read.'); };
const direct = ['click', 'dblclick', 'fill', 'check', 'uncheck', 'setChecked', 'selectOption', 'hover', 'press', 'focus',
  'scrollIntoViewIfNeeded', 'inputValue', 'isChecked', 'isVisible', 'isEnabled', 'isDisabled', 'isEditable', 'textContent', 'innerText',
  'getAttribute', 'boundingBox', 'dispatchEvent', 'setInputFiles', 'selectText'];

// The page.getByRef(sN) result: the Locator subset the action layer uses. Each call resolves a fresh handle from the
// current binding, so a ref that went stale after a re-read fails instead of reaching some other node.
export function closedLocator(binding) {
  const open = async () => resolveClosedHandle(binding());
  const using = async use => {
    const handle = await open();
    try { return await use(handle); } finally { await handle.dispose().catch(() => {}); }
  };
  const locator = {
    elementHandle: () => open(),
    evaluate: (fn, arg) => using(handle => handle.evaluate(fn, arg)),
    evaluateHandle: async (fn, arg) => { const handle = await open(); try { return await handle.evaluateHandle(fn, arg); } finally { await handle.dispose().catch(() => {}); } },
    count: async () => { try { await using(() => {}); return 1; } catch { return 0; } },
    waitFor: ({ state = 'visible', timeout } = {}) => using(async handle => {
      if (['visible', 'hidden', 'stable', 'enabled', 'disabled', 'editable'].includes(state)) await handle.waitForElementState(state, { timeout });
    }),
  };
  for (const name of direct) locator[name] = (...args) => using(handle => handle[name](...args));
  for (const name of ['locator', 'getByRole', 'getByText', 'getByLabel', 'frameLocator', 'filter', 'first', 'last', 'nth']) locator[name] = unsupported(name);
  return Object.freeze(locator);
}
