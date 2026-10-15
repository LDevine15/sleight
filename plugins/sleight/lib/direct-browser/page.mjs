// Background popup disposition for turbo v3, independently implemented for CR1.
import { randomUUID } from 'node:crypto';
import { trackPage } from './activity.mjs';
import { endpointURL, endpointTarget, endpointBlock, bindEndpointPage, assertEndpointRead } from './endpoint-guard.mjs';

function deadline(task, ms, message = 'background preparation timed out') {
  let timer;
  return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

// MAIN world, before page scripts. Every name stays inside this function so it
// can be serialized. The hook controls disposition, never grants authority.
export function popupHook() {
  // https://html.spec.whatwg.org/multipage/document-sequences.html#navigable-container
  // and iframe-embed-object.html, obsolete.html#frames; fenced frames:
  // https://wicg.github.io/fenced-frame/#fenced-frame-element. Do not cross documents.
  const CR2_NESTED_DOCUMENT = focus => {
    while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement;
    return /^(iframe|object|embed|frame|fencedframe)$/.test(focus?.localName);
  };
  const getAttribute = Element.prototype.getAttribute, hasAttribute = Element.prototype.hasAttribute;
  const nativeMatches = Element.prototype.matches;
  const editable = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable').get;
  const attribute = (node, name) => getAttribute.call(node, name);
  const has = (node, name) => hasAttribute.call(node, name);
  // Capture native IDL getters before page scripts. Form ownership includes
  // controls outside a form using form=id; button's missing/invalid type is submit.
  const formControls = [HTMLButtonElement, HTMLInputElement].map(constructor => ({
    constructor, form: Object.getOwnPropertyDescriptor(constructor.prototype, 'form').get,
    type: Object.getOwnPropertyDescriptor(constructor.prototype, 'type').get,
  }));
  const selectControl = { constructor: HTMLSelectElement,
    multiple: Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'multiple').get };
  const labelControl = { constructor: HTMLLabelElement,
    control: Object.getOwnPropertyDescriptor(HTMLLabelElement.prototype, 'control').get };
  // HTML forms.html#the-label-element: an interactive descendant does
  // not forward label activation. This selector limits label forwarding only;
  // it does not give any of these elements a plain-click exception.
  const interactive = 'a[href],audio[controls],button,details,embed,iframe,img[usemap],input:not([type="hidden"]),label,select,textarea,video[controls]';
  // Same-context submissions and multiple-select selection need plain input.
  // New-context submissions keep the modifier that selects a background tab.
  const submits = node => {
    for (const control of formControls) if (node instanceof control.constructor
      && /^(submit|image)$/.test(control.type.call(node))) {
      const form = control.form.call(node);
      if (form) return sameContext(form, attribute(node, 'formtarget') ?? targetOf(form));
    }
    return false;
  };
  const plainControl = node => submits(node)
    || node instanceof selectControl.constructor && selectControl.multiple.call(node);
  const key = Symbol.for('sleight.popup3');
  if (window[key]) return true;
  const retired = new Set(), replacements = [], events = new WeakMap(), masked = new WeakMap();
  const nativeOpen = window.open, nativePrevent = Event.prototype.preventDefault;
  const composedPath = Event.prototype.composedPath, now = Date.now;
  const prevented = Object.getOwnPropertyDescriptor(Event.prototype, 'defaultPrevented');
  const returnValue = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue');
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const namedWindows = new Map();
  let arm;
  const replace = (object, name, descriptor) => {
    const before = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, descriptor);
    replacements.push(() => {
      const current = Object.getOwnPropertyDescriptor(object, name);
      if (current?.value !== descriptor.value || current?.get !== descriptor.get || current?.set !== descriptor.set) return;
      if (before) Object.defineProperty(object, name, before);
      else delete object[name];
    });
  };
  const ancestors = element => {
    const result = [];
    for (let node = element; node && !result.includes(node); node = node.parentElement ?? node.getRootNode?.().host) result.push(node);
    return result;
  };
  const live = () => arm && now() < arm.until;
  const active = () => live() && arm.masking;
  const matches = event => event.isTrusted && composedPath.call(event).includes(arm.element);
  const hide = event => {
    // The token was bound while this event matched its arm. Retirement changes
    // which new events can be masked, never a retained event's modifier values.
    if (masked.has(event)) return arm?.token === masked.get(event) || retired.has(masked.get(event));
    if (!active()) return false;
    if (arm.clicked || !matches(event)) return false;
    masked.set(event, arm.token); return true;
  };
  for (const name of ['ctrlKey', 'metaKey']) {
    const descriptor = Object.getOwnPropertyDescriptor(MouseEvent.prototype, name);
    replace(MouseEvent.prototype, name, { ...descriptor, get() { return hide(this) ? false : descriptor.get.call(this); } });
  }
  const modifierState = MouseEvent.prototype.getModifierState;
  replace(MouseEvent.prototype, 'getModifierState', { configurable: true, writable: true, value(name) {
    return (name === 'Control' || name === 'Meta') && hide(this) ? false : modifierState.call(this, name);
  } });
  replace(Event.prototype, 'preventDefault', { configurable: true, writable: true, value() {
    const record = events.get(this);
    if (record && this.cancelable !== false) record.cancelled = true;
    return nativePrevent.call(this);
  } });
  replace(Event.prototype, 'defaultPrevented', { ...prevented, get() {
    return events.has(this) ? events.get(this).cancelled : prevented.get.call(this);
  } });
  replace(Event.prototype, 'returnValue', { ...returnValue, get() {
    return events.has(this) ? !events.get(this).cancelled : returnValue.get.call(this);
  }, set(value) {
    const record = events.get(this);
    if (record && !value && this.cancelable !== false) record.cancelled = true;
    return returnValue.set.call(this, value);
  } });
  const open = function(url, target, features) {
    if (/^_(self|parent|top)$/i.test(String(target))) return nativeOpen.apply(this, arguments);
    if (!active() || !navigator.userActivation?.isActive) return null;
    const kept = String(features ?? '').split(',').map(value => value.trim()).filter(value => /^(noopener|noreferrer)(?:=|$)/i.test(value));
    const opened = nativeOpen.call(this, url, target, kept.join(','));
    if (opened && target && !String(target).startsWith('_')) namedWindows.set(String(target), opened);
    return opened;
  };
  replace(window, 'open', { configurable: true, writable: true, value: open });
  const keyEvent = event => {
    if (!live() || !event.isTrusted || !['Control', 'Meta'].includes(event.key)) return;
    // Playwright restores its modifiers after dispatch; our explicit release
    // may send another keyup. Keep both hidden until this arm finishes.
    if (event.type === 'keyup' && arm.modifiers.has(event.key)) { event.stopImmediatePropagation(); return; }
    if (event.type === 'keydown' && !arm.clicked) { arm.masking = true; arm.modifiers.add(event.key); }
    if (!active()) return;
    event.stopImmediatePropagation();
  };
  const targetOf = element => attribute(element, 'target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
  const sameContext = (element, target = targetOf(element)) => {
    if (!target || /^_(self|parent|top)$/i.test(target) || target === window.name) return true;
    if (target.toLowerCase() === '_blank') return false;
    const known = namedWindows.get(target);
    if (known) {
      try { if (!known.closed) return true; } catch { /* A discarded proxy is not reusable. */ }
      namedWindows.delete(target);
    }
    // Indexed WindowProxy children remain traversable across origins, while
    // names and documents are readable only where same-origin access permits.
    const seen = new Set(), pending = [window.top ?? window];
    while (pending.length) {
      const context = pending.pop();
      if (!context || seen.has(context)) continue;
      seen.add(context);
      try { if (context.name === target) return true; } catch { /* Cross-origin name. */ }
      try {
        for (const frame of context.document?.querySelectorAll('iframe[name],frame[name]') ?? [])
          if (attribute(frame, 'name') === target) return true;
      } catch { /* Cross-origin document. */ }
      try {
        const frames = context.frames;
        let named;
        try { named = frames?.[target]; } catch { /* Cross-origin named access; indexed children remain readable. */ }
        for (let i = 0; i < (frames?.length ?? 0); i++) {
          if (frames[i] === named) return true;
          pending.push(frames[i]);
        }
      } catch { /* A navigated or detached frame can disappear during the walk. */ }
    }
    for (const frame of document.querySelectorAll?.('iframe[name],frame[name]') ?? [])
      if (attribute(frame, 'name') === target) return true;
    return false;
  };
  const linkState = element => {
    if (!element || !['a', 'area'].includes(element.localName) || !has(element, 'href') || has(element, 'download')) return;
    if (sameContext(element)) return;
    let url;
    try { url = new URL(attribute(element, 'href'), document.baseURI); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const target = targetOf(element);
    const rel = attribute(element, 'rel') ?? '';
    return { url: url.href, target, rel, signature: JSON.stringify([url.href, target, rel]) };
  };
  const capture = event => {
    if (!live() || arm.clicked || !matches(event)) return;
    if (active()) masked.set(event, arm.token);
    arm.clicked = event;
    // A task queued by the capture listener runs after synchronous dispatch,
    // even when a page stops propagation. Keep the arm for takeRequest.
    const current = arm;
    arm.dispatchTimer = setTimeout(() => { if (arm === current) arm.masking = false; }, 0);
    if (!arm.link) return;
    const record = { ...arm.link, cancelled: prevented.get.call(event), event };
    events.set(event, record); arm.request = record;
    nativePrevent.call(event);
    // Read the actual handlers at dispatch, after pointer handlers may have
    // changed them. A browser internally cancels when an inline handler returns
    // false, so observe that return without calling the handler a second time.
    for (const node of [...ancestors(arm.element), document, window]) {
      const before = node.onclick;
      let wrapper = before;
      if (typeof before === 'function') {
        wrapper = function(event) {
          const result = before.apply(this, arguments);
          if (result === false && events.has(event)) events.get(event).cancelled = true;
          return result;
        };
        node.onclick = wrapper;
      }
      arm.handlers.push({ node, before, wrapper });
    }
  };
  add.call(window, 'keydown', keyEvent, true);
  add.call(window, 'keyup', keyEvent, true);
  add.call(window, 'click', capture, true);
  const finish = token => {
    retired.add(token);
    if (arm?.token !== token) return true;
    clearTimeout(arm.timer); clearTimeout(arm.dispatchTimer);
    for (const { node, before, wrapper } of arm.handlers) if (wrapper !== before && node.onclick === wrapper) node.onclick = before;
    arm = undefined; return true;
  };
  const api = {
    prepare(element, token, capMs) {
      if (retired.has(token)) return false;
      if (arm) finish(arm.token);
      if (CR2_NESTED_DOCUMENT(document.activeElement)) throw Error('document focus is inside a frame');
      if (!(element instanceof Element) || !element.isConnected || !Number.isFinite(capMs) || capMs <= 0) return false;
      const chain = ancestors(element);
      for (const [index, node] of chain.entries()) {
        // In editable text a plain link click places the caret. The native
        // getter includes inherited contenteditable and document designMode.
        if (node instanceof HTMLElement && editable.call(node)) return false;
        if (plainControl(node)) return false;
        // A label can forward activation to a submit control outside its tree.
        if (node instanceof labelControl.constructor && !chain.slice(0, index).some(child => nativeMatches.call(child, interactive))
          && submits(labelControl.control.call(node))) return false;
      }
      const linkElement = chain.find(node => ['a', 'area'].includes(node.localName) && has(node, 'href'));
      if (linkElement && sameContext(linkElement)) return false;
      const link = linkState(linkElement);
      arm = { element, token, until: now() + capMs, masking: false, modifiers: new Set(), link, linkElement, handlers: [] };
      arm.timer = setTimeout(() => finish(token), capMs);
      return link ? { kind: 'link' } : true;
    },
    takeRequest(token) {
      if (!live() || arm.token !== token || !arm.request || arm.taken) return { unavailable: true };
      arm.taken = true;
      if (arm.request.cancelled) return;
      const current = linkState(arm.linkElement);
      if (!arm.element.isConnected || current?.signature !== arm.request.signature
        || arm.handlers.some(({ node, wrapper }) => node.onclick !== wrapper)) return { unavailable: true };
      return { url: arm.request.url, target: arm.request.target, rel: arm.request.rel };
    },
    finish,
    off() {
      if (arm) finish(arm.token);
      remove.call(window, 'keydown', keyEvent, true);
      remove.call(window, 'keyup', keyEvent, true);
      remove.call(window, 'click', capture, true);
      for (const restore of replacements.reverse()) restore();
      if (window[key] === api) delete window[key];
      return true;
    },
  };
  window[key] = api;
  return true;
}

export async function backgroundClick(tab, locator, click = options => locator.click({ ...options, timeout: timeoutMs }), { timeoutMs = 1000 } = {}) {
  const token = randomUUID();
  const disarm = () => tab.page.evaluate(token => window[Symbol.for('sleight.popup3')]?.finish(token), token);
  try {
    let prepared;
    try {
      prepared = await deadline(() => locator.evaluate((element, { token, capMs }) => {
        const hook = window[Symbol.for('sleight.popup3')];
        if (!hook) throw Error('background popup hook unavailable');
        return hook.prepare(element, token, capMs);
      }, { token, capMs: timeoutMs + 1000 }, { timeout: timeoutMs }), timeoutMs);
    } catch { throw Error('background popup preparation failed; use the engine browser path'); }
    const modified = prepared === true || prepared?.kind === 'link';
    const checkpoint = tab.popupCheckpoint?.();
    let result;
    try { result = await click(modified ? { modifiers: ['ControlOrMeta'] } : {}); }
    catch (error) {
      if ((tab.closed || tab.page.isClosed?.()) && tab.parent && !tab.parent.page.isClosed()
        && /target.*closed/i.test(error.message)) result = { closed: true, opener: tab.opener };
      else throw error;
    } finally { if (modified) await tab.page.keyboard.up('ControlOrMeta').catch(() => {}); }
    if (result?.closed !== true && !tab.closed && !tab.page.isClosed?.() && prepared?.kind === 'link') {
      const request = await tab.page.evaluate(token => window[Symbol.for('sleight.popup3')]?.takeRequest(token) ??
        (window[Symbol.for('sleight.popup3')] ? undefined : { unavailable: true }), token);
      if (request?.unavailable) throw Error('link default changed or was not captured; read the page before using the engine browser path');
      if (request?.url) {
        if (typeof tab.openChild !== 'function') throw Error('background link opening needs the owned page registry');
        await tab.openChild(request.url, { target: request.target, rel: request.rel });
      }
    }
    await tab.settlePopups?.(checkpoint);
    return result;
  } finally { await disarm().catch(() => {}); }
}

// browser is the Playwright connection through V1's CDP filter; session is the
// approved root CDP {send,on,off,sessionId}. Existing pages are never acquired.
export function createPageRegistry({ browser, session, context = browser?.contexts()[0], upstream, ownTarget, releaseTarget,
  endpoint, endpointBlocked, timeoutMs = 5000, popupWaitMs = 2000 } = {}) {
  if (!context || typeof session?.send !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('approved browser connection required');
  if (ownTarget !== undefined && (typeof ownTarget !== 'function' || typeof upstream?.send !== 'function'))
    throw Error('trusted popup admission needs the upstream CDP connection');
  const records = new Map(), targets = new Map(), metadata = new WeakMap(), seen = new Map(), allocations = new Map(), tasks = new Set(), blockedTargets = new Set();
  const namedChildren = new Map();
  const queued = new WeakMap();
  let namedQueue = Promise.resolve();
  let ended = false, cleanup;
  const track = promise => {
    tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise;
  };
  const identify = page => {
    if (!metadata.has(page)) metadata.set(page, (async () => {
      const cdp = await context.newCDPSession(page);
      try {
        const { targetInfo } = await cdp.send('Target.getTargetInfo');
        if (targetInfo?.type !== 'page' || !targetInfo.targetId) throw Error('owned page identity unavailable');
        return { cdp, targetInfo };
      } catch (error) { await cdp.detach().catch(() => {}); throw error; }
    })());
    return metadata.get(page);
  };
  const install = async entry => {
    entry.cdp.on('Page.windowOpen', event => {
      entry.windowOpenNo++;
      if (ownTarget) track(discoverPopups(entry)).catch(() => { entry.popupPending = true; });
    });
    await entry.cdp.send('Page.enable');
    await entry.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const { identifier } = await entry.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${popupHook})()` });
    if (!identifier) throw Error('background popup hook installation failed');
    entry.script = identifier;
    const result = await entry.cdp.send('Runtime.evaluate', { expression: `(${popupHook})()`, returnByValue: true });
    if (result.exceptionDetails || result.result?.value !== true) throw Error('background popup hook installation failed');
  };
  const removeHook = async entry => {
    if (entry.script) {
      await entry.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.script }); entry.script = null;
    }
    if (!entry.page.isClosed()) for (const frame of entry.page.frames()) await frame.evaluate(() => {
      return window[Symbol.for('sleight.popup3')]?.off() ?? true;
    });
  };
  const adopt = async (page, info, opener) => {
    if (blockedTargets.has(info.targetInfo.targetId)) return;
    trackPage(page, { targets: typeof upstream?.send === 'function' ? () => upstream.send('Target.getTargets') : undefined });
    bindEndpointPage(page, endpoint, info.cdp, { blocked: () => endpointBlocked?.(info.targetInfo.targetId),
      close: () => blockPage(page, info, opener) });
    let blocked = endpointTarget(info.targetInfo, endpoint) || endpointURL(page.url(), endpoint);
    if (!blocked) try { await assertEndpointRead(page); }
    catch (error) { if (error.message !== endpointBlock) throw error; blocked = true; }
    if (blocked) { await blockPage(page, info, opener); return; }
    if (targets.has(info.targetInfo.targetId)) return targets.get(info.targetInfo.targetId);
    const entry = { tab: 't' + randomUUID().replaceAll('-', ''), targetId: info.targetInfo.targetId, page, cdp: info.cdp,
      state: { snapshotNo: 0, submitUnconfirmed: false }, opener: opener?.tab, popups: [], popupWaitMs, endpoint,
      closed: page.isClosed(), released: false, queue: Promise.resolve() };
    entry.windowOpenNo = 0;
    entry.parent = opener;
    entry.openChild = (url, { target = '', rel = '' } = {}) => {
      // Never resolve a page-supplied name against arbitrary browser targets.
      // Only this registry's allocations can acquire or reuse a link name.
      const name = target && !target.startsWith('_') ? target : '';
      if (!name) return openOwned(url, entry);
      const opening = namedQueue.then(async () => {
        tab(entry.tab);
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('invalid browser URL');
        const candidate = namedChildren.get(name);
        if (candidate && !candidate.closed && !candidate.released && !candidate.releasing && !candidate.page.isClosed()) {
          // Two owned tabs may link to one another during their queued clicks.
          // Refuse a busy destination instead of making their queues circular.
          if (queued.has(candidate)) throw Error('named link target is busy; read the page before retrying');
          const reused = await api.enqueue(candidate.tab, async child => {
            let verified = false;
            try {
              const { targetInfo } = await deadline(() => child.cdp.send('Target.getTargetInfo'), timeoutMs);
              const actual = await deadline(() => child.page.evaluate(() => ({ name: window.name, origin: location.origin })), timeoutMs);
              verified = targetInfo?.targetId === child.targetId && targetInfo.type === 'page' && actual.name === name
                && actual.origin === new URL(entry.page.url()).origin && actual.origin === new URL(child.page.url()).origin;
            } catch { /* A stale name is not authority to reuse a target. */ }
            if (!verified) return;
            tab(entry.tab);
            tab(child.tab);
            await child.page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            child.link = { target: name, rel };
            return { tab: child.tab };
          });
          if (reused) return reused;
        }
        namedChildren.delete(name);
        const opened = await openOwned(url, entry, name);
        tab(opened.tab).link = { target: name, rel };
        namedChildren.set(name, tab(opened.tab));
        return opened;
      });
      namedQueue = opening.catch(() => {});
      return deadline(() => track(opening), timeoutMs, 'background named open pending; do not retry before cleanup');
    };
    entry.popupCheckpoint = () => ({ windows: entry.windowOpenNo, popups: entry.popups.length,
      ...(entry.parent ? { opener: { tab: entry.parent.tab, windows: entry.parent.windowOpenNo, popups: entry.parent.popups.length } } : {}) });
    entry.settlePopups = async before => {
      if (!before) return;
      const sources = [{ entry, before }];
      // Chromium can reparent a new popup to the living opener when the page
      // that opened it closes during dispatch. Honor that native identity.
      const parent = entry.closed && records.get(before.opener?.tab);
      if (parent && !parent.closed && !parent.released) sources.push({ entry: parent, before: before.opener });
      if (sources.every(({ entry, before }) => entry.windowOpenNo === before.windows && entry.popups.length === before.popups)) return;
      const until = Date.now() + popupWaitMs;
      while (!ended && sources.every(({ entry, before }) => entry.popups.length === before.popups) && Date.now() < until)
        await new Promise(resolve => setTimeout(resolve, Math.min(10, popupWaitMs)));
      for (const { entry, before } of sources) for (const notice of entry.popups.slice(before.popups)) {
        const child = records.get(notice.tab);
        if (child) await deadline(() => child.ready, timeoutMs).catch(() => {});
      }
    };
    records.set(entry.tab, entry); targets.set(entry.targetId, entry);
    allocations.delete(entry.targetId);
    const notice = opener && { tab: entry.tab, opener: opener.tab, closed: entry.closed };
    if (notice) opener.popups.push(notice);
    page.once('close', () => { entry.closed = true; if (notice) notice.closed = true; });
    entry.ready = track((async () => {
      if (!entry.closed && !ended) await deadline(() => install(entry), timeoutMs);
      if (ended && !entry.closed) await deadline(() => page.close({ runBeforeUnload: false }), timeoutMs);
    })());
    return entry;
  };
  const blockPage = async (page, info, opener) => {
    const targetId = info.targetInfo.targetId, entry = targets.get(targetId);
    if (entry) entry.blocked = true;
    if (!blockedTargets.has(targetId)) {
      const notice = opener && (opener.popups.find(row => row.tab === entry?.tab && row.tab) ??
        { opener: opener.tab, closed: false, blocked: true });
      if (notice) {
        delete notice.tab; notice.blocked = true;
        if (!opener.popups.includes(notice)) opener.popups.push(notice);
      }
      blockedTargets.add(targetId);
      allocations.set(targetId, { page, cdp: info.cdp, notice });
    }
    await closeAllocation(targetId);
  };
  const heard = page => track((async () => {
    // A discovery handle must not detach the persistent handle an open is using.
    const probe = await context.newCDPSession(page);
    let targetInfo;
    try { ({ targetInfo } = await probe.send('Target.getTargetInfo')); }
    finally { await probe.detach(); }
    if (targetInfo?.type === 'page') seen.set(targetInfo.targetId, page);
    const parent = targets.get(targetInfo?.openerId);
    // A closed opener adopts only a late popup that discovery never reserved (CR4);
    // otherwise discovery and this event would hand Playwright the same target twice.
    if (parent && !parent.released && (!parent.closed || !allocations.has(targetInfo.targetId)))
      await adopt(page, await identify(page), parent);
  })()).catch(() => {});
  context.on('page', heard);
  const idle = async () => { while (tasks.size) await Promise.allSettled([...tasks]); };
  const closeAllocation = targetId => {
    const allocation = allocations.get(targetId);
    if (!allocation) return Promise.resolve();
    if (!allocation.closing) allocation.closing = deadline(async () => {
      const result = allocation.page ? await allocation.page.close({ runBeforeUnload: false }).then(() => ({ success: allocation.page.isClosed() }))
        : await (allocation.blocked ? upstream : session).send('Target.closeTarget', { targetId });
      if (result?.success !== true) throw Error('background target cleanup unconfirmed');
      allocations.delete(targetId);
      if (allocation.notice) allocation.notice.closed = true;
      if (allocation.cdp) await allocation.cdp.detach().catch(() => {});
    }, timeoutMs).finally(() => { allocation.closing = null; });
    return allocation.closing;
  };
  // V1 hides unknown targets from Playwright. A windowOpen on an owned page is
  // the wakeup; trusted upstream metadata supplies the exact opener, then the
  // registry explicitly admits that child through V1's private own() capability.
  async function discoverPopups(parent) {
    const until = Date.now() + popupWaitMs;
    while (!ended && !parent.released) {
      const { targetInfos } = await deadline(() => upstream.send('Target.getTargets'), timeoutMs);
      const reparented = parent.closed && parent.parent && !parent.parent.closed && !parent.parent.released ? parent.parent.targetId : undefined;
      const children = targetInfos.filter(info => info.type === 'page' && (info.openerId === parent.targetId || reparented && info.openerId === reparented) &&
        !targets.has(info.targetId) && !allocations.has(info.targetId) && !blockedTargets.has(info.targetId));
      for (const child of children) {
        if (ended || parent.released) return;
        // The exact trusted opener proves ownership before any admission/read.
        // Close endpoint targets upstream without exposing their title or URL.
        if (endpointTarget(child, endpoint) || endpointBlocked?.(child.targetId)) {
          const notice = { opener: parent.tab, closed: false, blocked: true };
          parent.popups.push(notice);
          allocations.set(child.targetId, { blocked: true, notice });
          blockedTargets.add(child.targetId);
          await closeAllocation(child.targetId);
          continue;
        }
        allocations.set(child.targetId, {});
        await ownTarget(child.targetId);
        if (ended) await closeAllocation(child.targetId);
      }
      if (children.length || Date.now() >= until) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(10, popupWaitMs)));
    }
  }
  const tab = id => {
    const entry = records.get(id);
    if (!entry || entry.released || entry.releasing) throw Error('unknown or releasing owned tab');
    if (entry.blocked) throw Error(endpointBlock);
    if (entry.closed || entry.page.isClosed()) throw Error('owned tab closed; read its opener');
    if (ended) throw Error('turn ended');
    return entry;
  };
  const release = async (id, kind) => {
    const entry = tab(id);
    entry.releasing = true;
    const releasing = track((async () => {
      try {
        await deadline(() => entry.queue, timeoutMs);
        await deadline(() => entry.ready, timeoutMs);
        await deadline(() => removeHook(entry), timeoutMs);
        await entry.cdp.detach();
        await releaseTarget?.(entry.targetId);
        if (entry.page.isClosed()) throw Error('owned tab closed during release');
        entry.released = true; entry.release = kind;
        return { tab: id, kept: true, handoff: kind === 'handoff' };
      } finally { entry.releasing = false; }
    })());
    // A delayed detach/ownership reply remains tracked after the caller's cap.
    return deadline(() => releasing, timeoutMs, 'tab release pending; wait for cleanup before retrying');
  };
  async function openOwned(url, opener, name = '') {
      if (ended) throw Error('turn ended');
      let parsed;
      try { parsed = new URL(url); } catch { throw Error('invalid browser URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('invalid browser URL');
      if (endpointURL(parsed.href, endpoint)) {
        if (opener) { opener.popups.push({ opener: opener.tab, closed: true, blocked: true }); return { blocked: true }; }
        throw Error(endpointBlock);
      }
      const opening = track((async () => {
        const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', background: true });
        if (!targetId) throw Error('background target allocation unavailable');
        allocations.set(targetId, {});
        const until = Date.now() + timeoutMs;
        while (!seen.has(targetId) && !ended && Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (ended || !seen.has(targetId)) {
          await closeAllocation(targetId);
          throw Error(ended ? 'turn ended' : 'background page attachment timed out');
        }
        const page = seen.get(targetId);
        const info = await identify(page), entry = await adopt(page, info, opener);
        if (!entry) throw Error(endpointBlock);
        await entry.ready;
        if (ended) throw Error('turn ended');
        if (name && await deadline(() => page.evaluate(name => { window.name = name; return window.name; }, name), timeoutMs) !== name)
          throw Error('background target name unavailable');
        try { await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); }
        catch (error) { await assertEndpointRead(page); throw error; }
        await assertEndpointRead(page);
        return { tab: entry.tab };
      })());
      return deadline(() => opening, timeoutMs, 'background open pending; do not retry before cleanup');
  }
  const api = {
    tab, idle,
    openTab: ({ url }) => openOwned(url),
    async list() {
      await deadline(idle, timeoutMs);
      for (const entry of records.values()) if (!entry.closed && !entry.released && !entry.blocked) {
        try { await assertEndpointRead(entry.page); } catch (error) { if (error.message !== endpointBlock) throw error; }
      }
      return [...records.values()].filter(r => !r.closed && !r.released && !r.blocked).map(r => ({ tab: r.tab, targetId: r.targetId,
        opener: r.opener, url: r.page.url() }));
    },
    enqueue(id, run) {
      const entry = tab(id), task = entry.queue.then(async () => { tab(id); await assertEndpointRead(entry.page); return run(entry); });
      queued.set(entry, (queued.get(entry) ?? 0) + 1);
      const finished = () => { const count = queued.get(entry) - 1; if (count) queued.set(entry, count); else queued.delete(entry); };
      task.then(finished, finished);
      entry.queue = task.catch(() => {}); return track(task);
    },
    async close(id) {
      const entry = tab(id); await deadline(() => entry.page.close({ runBeforeUnload: false }), timeoutMs);
      return { tab: id, closed: entry.page.isClosed() };
    },
    keep: id => release(id, 'keep'), handoff: id => release(id, 'handoff'),
    endTurn() {
      ended = true;
      if (!cleanup) cleanup = (async () => {
        let settled = true;
        try { await deadline(idle, timeoutMs); } catch { settled = false; }
        const rows = [];
        for (const targetId of allocations.keys()) {
          try { await closeAllocation(targetId); rows.push({ targetId, closed: true }); }
          catch { rows.push({ targetId, closed: false, cleanupRequired: true }); }
        }
        for (const entry of records.values()) {
          if (entry.releasing) {
            rows.push({ tab: entry.tab, closed: entry.page.isClosed(), cleanupRequired: true }); continue;
          }
          if (entry.released || entry.page.isClosed()) { rows.push({ tab: entry.tab, kept: entry.released, closed: entry.page.isClosed() }); continue; }
          try {
            await deadline(() => entry.page.close({ runBeforeUnload: false }), timeoutMs);
            rows.push({ tab: entry.tab, closed: entry.page.isClosed() });
          } catch { rows.push({ tab: entry.tab, closed: entry.page.isClosed(), cleanupRequired: true }); }
        }
        const cleanedUp = settled && rows.every(row => row.kept || row.closed);
        if (cleanedUp) context.off('page', heard);
        return { cleanedUp, rows };
      })().finally(() => { cleanup = null; });
      return cleanup;
    },
  };
  return Object.freeze(api);
}
