// popupHook and backgroundClick are adapted from FowlBrowser's mcp/src/popups.mjs
// (MIT, Copyright (c) 2026 Fowl Labs) at 8b689249ba4e33d2626487aad930605c62e2c6a7,
// rewritten for Playwright over CDP. See THIRD-PARTY-NOTICES.md for the license.
import { randomUUID } from 'node:crypto';
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
  const key = Symbol.for('sleight.popup3');
  if (window[key]) return true;
  const apply = Reflect.apply, originalOpen = window.open;
  const listen = EventTarget.prototype.addEventListener, unlisten = EventTarget.prototype.removeEventListener;
  const path = Event.prototype.composedPath, stop = Event.prototype.stopImmediatePropagation;
  const event = Event.prototype, prevent = event.preventDefault;
  const preventedDescriptor = Object.getOwnPropertyDescriptor(event, 'defaultPrevented');
  const returnDescriptor = Object.getOwnPropertyDescriptor(event, 'returnValue');
  const mouse = MouseEvent.prototype;
  const descriptors = ['ctrlKey', 'metaKey'].map(name => [name, Object.getOwnPropertyDescriptor(mouse, name)]);
  const modifierState = mouse.getModifierState;
  const decided = new WeakMap(), retired = new Set(), requests = new Map(), clicks = new WeakMap();
  let armed, timer;
  const restoreHandlers = bindings => {
    let unchanged = true;
    for (const binding of bindings ?? []) {
      if (binding.restored) continue;
      if (binding.wrapper && binding.node.onclick === binding.wrapper) binding.node.onclick = binding.original;
      else if (!binding.called && binding.node.onclick !== binding.original) unchanged = false;
      binding.restored = true;
    }
    return unchanged;
  };
  const dropRequest = token => {
    const request = requests.get(token);
    if (request) { requests.delete(token); clicks.delete(request.event); }
    return request;
  };
  const finish = token => {
    if (token) retired.add(token);
    const request = dropRequest(token ?? armed?.token);
    restoreHandlers(request?.bindings);
    if (armed && token && armed.token !== token) return;
    restoreHandlers(armed?.bindings);
    armed = undefined; clearTimeout(timer);
  };
  const preventDefault = function () {
    const request = clicks.get(this);
    if (request) request.cancelled = true;
    return apply(prevent, this, []);
  };
  const defaultPrevented = function () {
    return clicks.get(this)?.cancelled ?? apply(preventedDescriptor.get, this, []);
  };
  const returnValue = function () {
    const request = clicks.get(this);
    return request ? !request.cancelled : apply(returnDescriptor.get, this, []);
  };
  const setReturnValue = function (value) {
    const request = clicks.get(this);
    if (request && !value) request.cancelled = true;
    return apply(returnDescriptor.set, this, [value]);
  };
  event.preventDefault = preventDefault;
  Object.defineProperty(event, 'defaultPrevented', { ...preventedDescriptor, get: defaultPrevented });
  Object.defineProperty(event, 'returnValue', { ...returnDescriptor, get: returnValue, set: setReturnValue });
  const masked = event => {
    if (!decided.has(event)) decided.set(event, !!(event.isTrusted && armed?.active &&
      Date.now() < armed.until && apply(path, event, []).includes(armed.element)));
    return decided.get(event);
  };
  const getters = descriptors.map(([name, descriptor]) => {
    const getter = function () { return apply(descriptor.get, this, []) && !masked(this); };
    Object.defineProperty(mouse, name, { ...descriptor, get: getter });
    return [name, descriptor, getter];
  });
  const getModifierState = function (name) {
    return apply(modifierState, this, [name]) && !(['Meta', 'Control'].includes(name) && masked(this));
  };
  mouse.getModifierState = getModifierState;
  const keyboard = event => {
    if (!armed || !event.isTrusted || !['Control', 'Meta'].includes(event.key)) return;
    if (event.type === 'keydown') { armed.active = true; armed.until = Date.now() + 1000; }
    if (armed.active) apply(stop, event, []);
  };
  for (const type of ['keydown', 'keyup']) apply(listen, window, [type, keyboard, true]);
  const defaultLink = link => {
    const target = link.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
    if (!/^_blank$/i.test(target) && !/\b(?:noopener|noreferrer)\b/i.test(link.getAttribute('rel') ?? '')) return;
    if (!target || /^_(?:self|parent|top)$/i.test(target) || link.hasAttribute('download')) return;
    try {
      const url = new URL(link.getAttribute('href'), document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      return { url: url.href };
    } catch { /* A page URL is never a grant to another protocol. */ }
  };
  const linkCapture = event => {
    if (!armed?.link || !event.isTrusted || !apply(path, event, []).includes(armed.element) || !defaultLink(armed.link)) return;
    const request = { event, link: armed.link, bindings: armed.bindings,
      cancelled: apply(preventedDescriptor.get, event, []) };
    clicks.set(event, request); requests.set(armed.token, request);
    // Suppress the browser default before a page can stop bubbling. Page code
    // sees its own cancellation state; its handlers still run exactly once.
    apply(prevent, event, []);
  };
  apply(listen, window, ['click', linkCapture, true]);
  const open = function (url, name, features) {
    // Same browsing context navigation keeps native semantics. New windows must
    // consume the background click's trusted activation; never create a window.
    if (/^_(?:self|parent|top)$/i.test(String(name))) return apply(originalOpen, this, arguments);
    if (!armed?.active || Date.now() >= armed.until || !navigator.userActivation?.isActive) return null;
    // Keep security features, discard popup sizing and window-position features.
    const safeFeatures = String(features ?? '').split(',').filter(value => /^\s*(?:noopener|noreferrer)(?:\s*=|\s*$)/i.test(value)).join(',');
    return apply(originalOpen, this, [url, name, safeFeatures]);
  };
  window.open = open;
  window[key] = {
    prepare(element, token, capMs) {
      if (retired.has(token) || !element.isConnected) return false;
      let node = element, link;
      const handlers = [], nodes = [];
      while (node instanceof Element) {
        nodes.push(node);
        if (['a', 'area'].includes(node.localName)) link = node;
        if (typeof node.onclick === 'function') handlers.push(Function.prototype.toString.call(node.onclick));
        if (node.isContentEditable || ['textarea', 'select', 'option', 'label'].includes(node.localName) ||
          node.localName === 'input' && node.type !== 'button' ||
          /^(checkbox|radio|switch|option|menuitemcheckbox|menuitemradio)$/.test(node.getAttribute('role') ?? '')) return false;
        node = node.parentElement ?? node.getRootNode().host;
      }
      const handlerSource = handlers.join('\n');
      const source = handlerSource + '\n' + Array.from(document.scripts, script => script.textContent).join('\n');
      const target = link?.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '';
      const opens = /\b(?:window\s*\.\s*open|open\s*\()/.test(source);
      if (link && (!target || /^_(?:self|top|parent)$/i.test(target)) && !/\bwindow\s*\.\s*open\s*\(/.test(handlerSource)) return false;
      const independent = link && !/\bwindow\s*\.\s*open\s*\(/.test(handlerSource) &&
        (/^_blank$/i.test(target) || /\b(?:noopener|noreferrer)\b/i.test(link.getAttribute('rel') ?? ''));
      if (!opens && !target && !Array.from(document.scripts).some(script => script.src)) return false;
      if (/^(iframe|frame|fencedframe|object|embed)$/.test(document.activeElement?.localName ?? ''))
        throw Error('background popup preparation needs focus outside a frame');
      finish(); armed = { element, token, active: false, until: 0, ...(independent ? { link } : {}) };
      if (independent && defaultLink(link)) {
        armed.bindings = [];
        for (const node of [...nodes, document, window]) {
          const binding = { node, original: node.onclick, called: false };
          armed.bindings.push(binding);
          if (typeof binding.original !== 'function') continue;
          binding.wrapper = function (...args) {
            binding.called = true;
            const result = apply(binding.original, this, args), request = clicks.get(args[0]);
            if (result === false && request) request.cancelled = true;
            return result;
          };
          node.onclick = binding.wrapper;
          if (node.onclick !== binding.wrapper) throw Error('background link handler could not be prepared');
        }
      }
      timer = setTimeout(() => finish(token), capMs);
      return independent ? { kind: 'link' } : true;
    },
    takeRequest(token) {
      const request = dropRequest(token);
      if (!request) return { unavailable: true };
      const unchanged = restoreHandlers(request.bindings);
      if (request.cancelled) return;
      return unchanged ? defaultLink(request.link) ?? { unavailable: true } : { unavailable: true };
    },
    finish,
    off() {
      finish();
      if (window.open === open) window.open = originalOpen;
      for (const [name, descriptor, getter] of getters)
        if (Object.getOwnPropertyDescriptor(mouse, name)?.get === getter) Object.defineProperty(mouse, name, descriptor);
      if (mouse.getModifierState === getModifierState) mouse.getModifierState = modifierState;
      if (event.preventDefault === preventDefault) event.preventDefault = prevent;
      if (Object.getOwnPropertyDescriptor(event, 'defaultPrevented')?.get === defaultPrevented)
        Object.defineProperty(event, 'defaultPrevented', preventedDescriptor);
      if (Object.getOwnPropertyDescriptor(event, 'returnValue')?.get === returnValue)
        Object.defineProperty(event, 'returnValue', returnDescriptor);
      for (const type of ['keydown', 'keyup']) apply(unlisten, window, [type, keyboard, true]);
      apply(unlisten, window, ['click', linkCapture, true]);
      delete window[key]; return true;
    },
  };
  return true;
}

export async function backgroundClick(tab, locator, click = options => locator.click({ ...options, timeout: timeoutMs }), { timeoutMs = 1000 } = {}) {
  const token = randomUUID(), page = tab.page;
  const before = tab.popupCheckpoint?.();
  const disarm = () => deadline(() => page.evaluate(token => {
    window[Symbol.for('sleight.popup3')]?.finish(token); return true;
  }, token), timeoutMs);
  let prepared;
  const clickOnce = async options => {
    try { return await click(options); }
    catch (error) {
      if (/Target page, context or browser has been closed/.test(error.message) && tab.closed && tab.parent && !tab.parent.page.isClosed())
        return { closed: true, opener: tab.opener };
      throw error;
    }
  };
  const backgroundInput = async () => {
    try { return await clickOnce({ modifiers: ['ControlOrMeta'] }); }
    finally {
      // A failed click may leave Playwright's modifier held. Never replay input.
      await deadline(() => page.keyboard.up('ControlOrMeta'), timeoutMs).catch(() => {});
    }
  };
  try {
    prepared = await deadline(() => locator.evaluate((element, { token, capMs }) => {
      const hook = window[Symbol.for('sleight.popup3')];
      if (!hook) throw Error('background popup hook is missing');
      return hook.prepare(element, token, capMs);
    }, { token, capMs: timeoutMs + 1000 }, { timeout: timeoutMs }), timeoutMs);
  } catch {
    await disarm().catch(() => {});
    throw Error('background popup preparation failed; use the engine browser path');
  }
  if (prepared?.kind === 'link') {
    try {
      // Capture suppresses the native default even if page handlers stop
      // bubbling. Open its uncancelled destination through the owned registry.
      const result = await backgroundInput();
      const request = await page.evaluate(token => window[Symbol.for('sleight.popup3')]?.takeRequest(token), token);
      if (request?.unavailable) throw Error('link default changed or was not captured; read the page before using the engine browser path');
      if (request) {
        if (typeof tab.openChild !== 'function') throw Error('background link opening needs the owned page registry');
        await tab.openChild(request.url);
      }
      await tab.settlePopups?.(before);
      return result;
    } finally { await disarm().catch(() => {}); }
  }
  if (prepared !== true) {
    const result = await clickOnce({}); await tab.settlePopups?.(before); return result;
  }
  let result;
  try { result = await backgroundInput(); }
  finally { await disarm().catch(() => {}); }
  await tab.settlePopups?.(before);
  return result;
}

// browser is the Playwright connection through V1's CDP filter; session is the
// approved root CDP {send,on,off,sessionId}. Existing pages are never acquired.
export function createPageRegistry({ browser, session, context = browser?.contexts()[0], upstream, ownTarget, releaseTarget,
  endpoint, timeoutMs = 5000, popupWaitMs = 2000 } = {}) {
  if (!context || typeof session?.send !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('approved browser connection required');
  if (ownTarget !== undefined && (typeof ownTarget !== 'function' || typeof upstream?.send !== 'function'))
    throw Error('trusted popup admission needs the upstream CDP connection');
  const records = new Map(), targets = new Map(), metadata = new WeakMap(), seen = new Map(), allocations = new Map(), tasks = new Set(), blockedTargets = new Set();
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
      if (endpointURL(event.url, endpoint)) entry.pendingEndpointPopup = true;
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
    bindEndpointPage(page, endpoint, info.cdp);
    let blocked = endpointTarget(info.targetInfo, endpoint) || endpointURL(page.url(), endpoint);
    if (!blocked) try { await assertEndpointRead(page); }
    catch (error) { if (error.message !== endpointBlock) throw error; blocked = true; }
    if (blocked) {
      const notice = opener && { opener: opener.tab, closed: false, blocked: true };
      if (notice) opener.popups.push(notice);
      blockedTargets.add(info.targetInfo.targetId);
      allocations.set(info.targetInfo.targetId, { page, cdp: info.cdp, notice });
      await closeAllocation(info.targetInfo.targetId);
      return;
    }
    if (targets.has(info.targetInfo.targetId)) return targets.get(info.targetInfo.targetId);
    const entry = { tab: 't' + randomUUID().replaceAll('-', ''), targetId: info.targetInfo.targetId, page, cdp: info.cdp,
      state: { snapshotNo: 0, submitUnconfirmed: false }, opener: opener?.tab, popups: [], popupWaitMs, endpoint,
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
    if (parent && !parent.released && !parent.closed) await adopt(page, await identify(page), parent);
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
    while (!ended && !parent.released && !parent.closed) {
      const { targetInfos } = await deadline(() => upstream.send('Target.getTargets'), timeoutMs);
      const children = targetInfos.filter(info => info.type === 'page' && info.openerId === parent.targetId &&
        !targets.has(info.targetId) && !allocations.has(info.targetId) && !blockedTargets.has(info.targetId));
      for (const child of children) {
        if (ended || parent.released || parent.closed) return;
        // The exact trusted opener proves ownership before any admission/read.
        // Close endpoint targets upstream without exposing their title or URL.
        if (endpointTarget(child, endpoint) || parent.pendingEndpointPopup && child.url === 'about:blank') {
          const notice = { opener: parent.tab, closed: false, blocked: true };
          parent.popups.push(notice);
          allocations.set(child.targetId, { blocked: true, notice });
          blockedTargets.add(child.targetId);
          parent.pendingEndpointPopup = false;
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
        await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
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
      for (const entry of records.values()) if (!entry.closed && !entry.released) await assertEndpointRead(entry.page);
      return [...records.values()].filter(r => !r.closed && !r.released).map(r => ({ tab: r.tab, targetId: r.targetId,
        opener: r.opener, url: r.page.url() }));
    },
    enqueue(id, run) {
      const entry = tab(id), task = entry.queue.then(async () => { tab(id); await assertEndpointRead(entry.page); return run(entry); });
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
