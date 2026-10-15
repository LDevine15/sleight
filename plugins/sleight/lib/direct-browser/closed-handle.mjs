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

// binding is closedRefBinding(page, ref): the Playwright frame and the CDP backend node of the control.
export async function resolveClosedHandle({ frame, backendNodeId }) {
  const connection = frame?._connection, toImpl = connection?.toImpl;
  if (typeof toImpl !== 'function' || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw unavailable();
  const frameImpl = toImpl.call(connection, frame), dispatchers = toImpl.call(connection, connection);
  const delegate = frameImpl?._page?.delegate;
  if (!frameImpl || !dispatchers?._dispatcherByGuid || typeof delegate?._sessionForFrame !== 'function') throw unavailable();
  const session = delegate._sessionForFrame(frameImpl);
  let impl;
  try { impl = await session._adoptBackendNodeId(backendNodeId, await frameImpl.mainContext()); }
  catch { throw stale(); }
  let handle;
  try {
    // A closed host is invisible to DOM evidence from inside the page, so ask the DOM agent whether this node hosts one.
    // Anything but a clear "no" counts as a host.
    const described = await session._client._sendMayFail('DOM.describeNode', { backendNodeId });
    const hostsRoot = !described?.node || (described.node.shadowRoots?.length ?? 0) > 0;
    const Dispatcher = await dispatcherClass(connection, dispatchers, frame);
    const scope = dispatchers._dispatcherByGuid.get(frame._guid);
    const dispatcher = Dispatcher.fromJSOrElementHandle(scope, impl);
    // The in-process transport delivers the object-creation message on a later tick.
    for (let n = 0; n < 200 && !connection._objects?.has(dispatcher._guid); n++) await tick();
    handle = connection._objects?.get(dispatcher._guid);
    if (typeof handle?.click !== 'function') throw unavailable();
    details.set(handle, Object.freeze({ backendNodeId, hostsRoot }));
    return handle;
  } catch (error) {
    try { await impl.dispose(); } catch { /* already gone */ }
    throw error;
  }
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
