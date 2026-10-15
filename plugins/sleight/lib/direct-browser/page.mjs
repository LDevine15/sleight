// Background popup disposition for turbo v3, independently implemented for CR1.
import { randomUUID } from 'node:crypto';

function deadline(task, ms, message = 'background preparation timed out') {
  let timer;
  return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

// MAIN world, before page scripts. Every name stays inside this function so it
// can be serialized. The hook controls disposition, never grants authority.
export function popupHook() {
  // CR2 (queue/CR2.md): derive these three from the HTML and WAI-ARIA specs and a measurement, with citations.
  const CR2_NESTED_DOCUMENT = () => { throw Error('CR2: nested-document check not derived'); };
  const CR2_OWN_ACTIVATION = () => { throw Error('CR2: own-activation check not derived'); };
  const CR2_MODIFIER_WINDOW_MS = NaN;
  const key = Symbol.for('sleight.popup3');
  if (window[key]) return true;
  const retired = new Set(), replacements = [], events = new WeakMap(), masked = new WeakMap(), listeners = new WeakMap();
  const nativeOpen = window.open, nativePrevent = Event.prototype.preventDefault;
  const prevented = Object.getOwnPropertyDescriptor(Event.prototype, 'defaultPrevented');
  const returnValue = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue');
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const pointerType = type => /^(click|mousedown|mouseup|pointerdown|pointerup)$/.test(type);
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
  const live = () => arm && Date.now() < arm.until;
  const active = () => live() && Date.now() < arm.modifierUntil;
  const matches = event => event.isTrusted && event.composedPath().includes(arm.element);
  const hide = event => {
    if (!active()) return false;
    if (masked.has(event)) return masked.get(event) === arm.token;
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
    return nativeOpen.call(this, url, target, kept.join(','));
  };
  replace(window, 'open', { configurable: true, writable: true, value: open });
  replace(EventTarget.prototype, 'addEventListener', { configurable: true, writable: true, value(type, listener, options) {
    const result = add.call(this, type, listener, options);
    if (pointerType(type) && listener) {
      if (!listeners.has(this)) listeners.set(this, new Set());
      listeners.get(this).add(listener);
    }
    return result;
  } });
  replace(EventTarget.prototype, 'removeEventListener', { configurable: true, writable: true, value(type, listener, options) {
    const result = remove.call(this, type, listener, options);
    if (pointerType(type)) listeners.get(this)?.delete(listener);
    return result;
  } });
  const keyEvent = event => {
    if (!live() || !event.isTrusted || !['Control', 'Meta'].includes(event.key)) return;
    if (event.type === 'keydown' && !arm.modifierUntil) arm.modifierUntil = Math.min(arm.until, Date.now() + CR2_MODIFIER_WINDOW_MS);
    if (!active()) return;
    event.stopImmediatePropagation();
  };
  const linkState = element => {
    if (!element || !['a', 'area'].includes(element.localName) || !element.hasAttribute('href') || element.hasAttribute('download')) return;
    let url;
    try { url = new URL(element.getAttribute('href'), document.baseURI); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const target = element.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
    const rel = element.getAttribute('rel') ?? '';
    if (target.toLowerCase() !== '_blank' && !/(?:^|\s)(noopener|noreferrer)(?:\s|$)/i.test(rel)) return;
    return { url: url.href, signature: JSON.stringify([url.href, target, rel]) };
  };
  const capture = event => {
    if (!live() || arm.clicked || !matches(event)) return;
    if (active()) masked.set(event, arm.token);
    arm.clicked = event;
    if (!arm.link) return;
    const record = { cancelled: prevented.get.call(event), event, signature: arm.link.signature, url: arm.link.url };
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
    clearTimeout(arm.timer);
    for (const { node, before, wrapper } of arm.handlers) if (wrapper !== before && node.onclick === wrapper) node.onclick = before;
    arm = undefined; return true;
  };
  const api = {
    prepare(element, token, capMs) {
      if (retired.has(token)) return false;
      if (arm) finish(arm.token);
      let focus = document.activeElement;
      while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement;
      if (CR2_NESTED_DOCUMENT(focus)) throw Error('document focus is inside a frame');
      if (!(element instanceof Element) || !element.isConnected || !Number.isFinite(capMs) || capMs <= 0) return false;
      const chain = ancestors(element);
      for (const node of chain) {
        const editable = node.getAttribute('contenteditable');
        if (node.isContentEditable || editable !== null && /^(|true|plaintext-only)$/i.test(editable)
          || CR2_OWN_ACTIVATION(node)) return false;
      }
      const linkElement = chain.find(node => ['a', 'area'].includes(node.localName) && node.hasAttribute('href'));
      const link = linkState(linkElement);
      const opens = text => /\b(?:window\s*\.\s*)?open\s*\(/.test(String(text ?? ''));
      const handlerOpens = chain.some(node => opens(node.onclick) || opens(node.getAttribute('onclick')))
        || [...chain, document, window].some(node => [...listeners.get(node) ?? []].some(listener => opens(typeof listener === 'function' ? listener : listener.handleEvent)));
      if (!link && (linkElement ? !handlerOpens : !handlerOpens && ![...document.scripts].some(script => opens(script.textContent)))) return false;
      arm = { element, token, until: Date.now() + capMs, modifierUntil: 0, link, linkElement, handlers: [] };
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
      return { url: arm.request.url };
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
      }, { token, capMs: timeoutMs }, { timeout: timeoutMs }), timeoutMs);
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
    if (prepared?.kind === 'link') {
      const request = await tab.page.evaluate(token => window[Symbol.for('sleight.popup3')]?.takeRequest(token) ??
        (window[Symbol.for('sleight.popup3')] ? undefined : { unavailable: true }), token);
      if (request?.unavailable) throw Error('link default changed or was not captured; read the page before using the engine browser path');
      if (request?.url) {
        if (typeof tab.openChild !== 'function') throw Error('background link opening needs the owned page registry');
        await tab.openChild(request.url);
      }
    }
    await tab.settlePopups?.(checkpoint);
    return result;
  } finally { await disarm().catch(() => {}); }
}

// browser is the Playwright connection through V1's CDP filter; session is the
// approved root CDP {send,on,off,sessionId}. Existing pages are never acquired.
export function createPageRegistry({ browser, session, context = browser?.contexts()[0], upstream, ownTarget, releaseTarget,
  timeoutMs = 5000, popupWaitMs = 2000 } = {}) {
  if (!context || typeof session?.send !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('approved browser connection required');
  if (ownTarget !== undefined && (typeof ownTarget !== 'function' || typeof upstream?.send !== 'function'))
    throw Error('trusted popup admission needs the upstream CDP connection');
  const records = new Map(), targets = new Map(), metadata = new WeakMap(), seen = new Map(), allocations = new Map(), tasks = new Set();
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
    entry.cdp.on('Page.windowOpen', () => {
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
  const adopt = (page, info, opener) => {
    if (targets.has(info.targetInfo.targetId)) return targets.get(info.targetInfo.targetId);
    const entry = { tab: 't' + randomUUID().replaceAll('-', ''), targetId: info.targetInfo.targetId, page, cdp: info.cdp,
      state: { snapshotNo: 0, submitUnconfirmed: false }, opener: opener?.tab, popups: [], popupWaitMs,
      closed: page.isClosed(), released: false, queue: Promise.resolve() };
    entry.windowOpenNo = 0;
    entry.parent = opener;
    entry.openChild = url => openOwned(url, entry);
    entry.popupCheckpoint = () => ({ windows: entry.windowOpenNo, popups: entry.popups.length });
    entry.settlePopups = async before => {
      if (!before || entry.windowOpenNo === before.windows && entry.popups.length === before.popups) return;
      const until = Date.now() + popupWaitMs;
      while (!ended && entry.popups.length === before.popups && Date.now() < until)
        await new Promise(resolve => setTimeout(resolve, Math.min(10, popupWaitMs)));
      for (const notice of entry.popups.slice(before.popups)) {
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
  const heard = page => track((async () => {
    // A discovery handle must not detach the persistent handle an open is using.
    const probe = await context.newCDPSession(page);
    let targetInfo;
    try { ({ targetInfo } = await probe.send('Target.getTargetInfo')); }
    finally { await probe.detach(); }
    if (targetInfo?.type === 'page') seen.set(targetInfo.targetId, page);
    const parent = targets.get(targetInfo?.openerId);
    if (parent && !parent.released && !parent.closed) adopt(page, await identify(page), parent);
  })()).catch(() => {});
  context.on('page', heard);
  const idle = async () => { while (tasks.size) await Promise.allSettled([...tasks]); };
  const closeAllocation = targetId => {
    const allocation = allocations.get(targetId);
    if (!allocation) return Promise.resolve();
    if (!allocation.closing) allocation.closing = deadline(async () => {
      const result = await session.send('Target.closeTarget', { targetId });
      if (result?.success !== true) throw Error('background target cleanup unconfirmed');
      allocations.delete(targetId);
    }, timeoutMs).finally(() => { allocation.closing = null; });
    return allocation.closing;
  };
  // V1 hides unknown targets from Playwright. A windowOpen on an owned page is
  // the wakeup; trusted upstream metadata supplies the exact opener, then the
  // registry explicitly admits that child through V1's private own() capability.
  async function discoverPopups(parent) {
    const until = Date.now() + popupWaitMs;
    while (!ended && !parent.released && !parent.closed) {
      const { targetInfos } = await deadline(() => upstream.send('Target.getTargets'), timeoutMs);
      const children = targetInfos.filter(info => info.type === 'page' && info.openerId === parent.targetId &&
        !targets.has(info.targetId) && !allocations.has(info.targetId));
      for (const child of children) {
        if (ended || parent.released || parent.closed) return;
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
  async function openOwned(url, opener) {
      if (ended) throw Error('turn ended');
      let parsed;
      try { parsed = new URL(url); } catch { throw Error('invalid browser URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('invalid browser URL');
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
        const info = await identify(page), entry = adopt(page, info, opener);
        await entry.ready;
        if (ended) throw Error('turn ended');
        await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        return { tab: entry.tab };
      })());
      return deadline(() => opening, timeoutMs, 'background open pending; do not retry before cleanup');
  }
  const api = {
    tab, idle,
    openTab: ({ url }) => openOwned(url),
    async list() {
      await deadline(idle, timeoutMs);
      return [...records.values()].filter(r => !r.closed && !r.released).map(r => ({ tab: r.tab, targetId: r.targetId,
        opener: r.opener, url: r.page.url() }));
    },
    enqueue(id, run) {
      const entry = tab(id), task = entry.queue.then(() => { tab(id); return run(entry); });
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
