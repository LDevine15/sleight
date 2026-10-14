// Port of sleight's merged BP2-8R3/T ownership bank. No third-party source copied.
import { ScopedAttachment, bounded, granted, receipt, validScope } from './attachment.mjs';
import { randomUUID } from 'node:crypto';

// Semantic reference only: FowlBrowser MIT, 8b689249ba4e33d2626487aad930605c62e2c6a7,
// mcp/src/popups.mjs. Original implementation; no extension APIs or modifier masking.
// The strict subset refuses native opens; observe preserves all native arguments/WindowProxy.
export function popupHook(mode, owner = 'standalone') {
  const key = Symbol.for('sleight.popup2');
  if (window[key]) {
    if (window[key].mode !== mode) return false;
    window[key].owners.add(owner);
    return true;
  }
  const native = window.open;
  const apply = Reflect.apply;
  const state = { blocked: null, mode, owners: new Set([owner]), armed: null, request: null };
  const capture = (kind, url, name) => {
    const intent = state.armed;
    state.armed = null;
    try {
      const destination = new URL(url, window.document.baseURI).href;
      if (intent?.kind === kind && intent.url === destination && intent.name === name) {
        state.request = intent; return true;
      }
    } catch { /* Unknown page intent never allocates a target. */ }
    state.blocked = 'BACKGROUND_UNAVAILABLE'; return false;
  };
  const wrapper = function (...args) {
    if (mode === 'strict') {
      const name = args[1] == null || /^_blank$/i.test(args[1]) ? '' : String(args[1]);
      capture('window', args[0], name); return null;
    }
    return apply(native, this, args);
  };
  const block = event => {
    if (mode !== 'strict') return;
    const node = event.type === 'submit' ? event.target : event.composedPath().find(item => /^(a|area)$/.test(item?.localName));
    const target = event.submitter?.getAttribute('formtarget') ?? node?.getAttribute('target') ??
      window.document.querySelector('base[target]')?.getAttribute('target') ?? '';
    if (target && !/^_self$/i.test(target)) {
      event.preventDefault();
      const kind = event.type === 'submit' ? 'form' : 'link';
      const name = /^_blank$/i.test(target) ? '' : target;
      const intent = state.armed;
      // Form serialization was checked immediately before this action. Only
      // that exact form can consume it; POSTs are never replayed as a GET.
      if (kind === 'form' && intent?.kind === 'form' && intent.form === node) {
        state.request = { kind, url: intent.url, name, nullReturned: false }; state.armed = null;
      } else capture(kind, node?.getAttribute('href'), name);
    }
  };
  window.open = wrapper;
  window.addEventListener('click', block, true);
  window.addEventListener('auxclick', block, true);
  window.addEventListener('submit', block, true);
  state.off = (releasingOwner = owner) => {
    if (!state.owners.delete(releasingOwner) || state.owners.size) return;
    if (window.open === wrapper) window.open = native;
    window.removeEventListener('click', block, true);
    window.removeEventListener('auxclick', block, true);
    window.removeEventListener('submit', block, true);
    delete window[key];
  };
  window[key] = state;
  return true;
}

// Fixed MAIN-world metadata preflight for one owned node. It is intentionally
// narrow: a literal open with no returned-window use, or a GET link/form. Page
// data may veto a flow but cannot grant a different origin or a native open.
export function popupIntent() {
  const state = window[Symbol.for('sleight.popup2')];
  if (!state || state.mode !== 'strict' || !(this instanceof Element) || !this.isConnected)
    return { code: 'OPENER_REQUIRED', reason: 'uncertain' };
  state.armed = state.request = null;
  const deny = reason => ({ code: 'OPENER_REQUIRED', reason });
  const get = (node, name) => Element.prototype.getAttribute.call(node, name);
  const scripts = Array.from(document.scripts ?? []);
  const source = scripts.map(s => s.textContent ?? '').join('\n');
  const handlers = [];
  let link, form, submitter;
  for (let node = this, depth = 0; node instanceof Element && depth < 32; node = node.parentElement, depth++) {
    if (!link && ['a', 'area'].includes(node.localName)) link = node;
    for (const name of ['onclick', 'onauxclick', 'onsubmit']) {
      const handler = node[name];
      if (typeof handler === 'function') handlers.push(Function.prototype.toString.call(handler));
    }
  }
  if (this.localName === 'form') form = this;
  else if (this.form && ['button', 'input'].includes(this.localName) && (this.type ?? 'submit') === 'submit') {
    form = this.form; submitter = this;
  }
  const target = (submitter && get(submitter, 'formtarget')) ?? get(form ?? link ?? this, 'target') ??
    document.querySelector('base[target]')?.getAttribute('target') ?? '';
  const opening = handlers.filter(text => /\bwindow\s*(?:\.\s*open|\[)/.test(text));
  let intent;
  if (opening.length) {
    if (opening.length !== 1 || handlers.length !== 1) return deny('uncertain');
    const text = opening[0];
    const body = text.includes('{') ? text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')).trim()
      : text.slice(text.indexOf('=>') + 2).trim();
    const match = /^(?:return\s+)?window\.open\(\s*(['"])([^'"\\]*)\1\s*(?:,\s*(['"])([^'"\\]*)\3\s*(?:,\s*(['"])([^'"\\]*)\5\s*)?)?\)\s*;?$/.exec(body);
    if (!match) return deny('uncertain');
    intent = { kind: 'window', url: match[2], name: match[4] ?? '', nullReturned: true };
    if (scripts.some(s => s.src)) return deny('uncertain');
  } else if (target && !/^_self$/i.test(target) && (form || link)) {
    if (handlers.length) return deny('uncertain');
    if (form) {
      const method = ((submitter && get(submitter, 'formmethod')) ?? get(form, 'method') ?? 'get').toLowerCase();
      if (method !== 'get') return deny('post');
      const url = new URL((submitter && get(submitter, 'formaction')) ?? get(form, 'action') ?? window.location.href, document.baseURI);
      const data = new FormData(form, submitter);
      if (Array.from(data.values()).some(value => typeof value !== 'string')) return deny('uncertain');
      url.search = new URLSearchParams(data).toString();
      intent = { kind: 'form', url: url.href, name: target, nullReturned: false };
    } else {
      if (get(link, 'download') !== null) return deny('uncertain');
      intent = { kind: 'link', url: get(link, 'href'), name: target, nullReturned: false };
    }
  } else {
    if (/\bwindow\s*(?:\.\s*open|\[)/.test(source)) return deny('uncertain');
    return { kind: 'none' };
  }
  if (/\b(?:opener|postMessage)\b/.test(source + '\n' + handlers.join('\n'))) return deny('opener');
  if (/^_(?:parent|top|self)$/i.test(intent.name) || intent.name.length > 128) return deny('uncertain');
  if (/^_blank$/i.test(intent.name)) intent.name = '';
  try {
    const url = new URL(intent.url, document.baseURI);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return deny('uncertain');
    if (url.origin !== window.location.origin) return deny('cross-origin');
    intent.url = url.href;
  } catch { return deny('uncertain'); }
  state.armed = { ...intent, ...(form ? { form } : {}) };
  return intent;
}

export function popupResult() {
  const state = window[Symbol.for('sleight.popup2')];
  if (!state || state.mode !== 'strict') return { code: 'BACKGROUND_UNAVAILABLE' };
  const request = state.request;
  state.armed = state.request = null;
  return request ?? { kind: 'none' };
}

// External or dynamically loaded scripts cannot prove independence. This
// private fixed read inspects only the new owned destination document.
export function popupDestination() {
  const scripts = Array.from(document.scripts);
  const handlers = Array.from(document.querySelectorAll('*')).flatMap(node =>
    Element.prototype.getAttributeNames.call(node).filter(name => /^on/i.test(name))
      .map(name => Element.prototype.getAttribute.call(node, name) ?? ''));
  const source = scripts.map(s => s.textContent ?? '').join('\n');
  return { ready: document.readyState !== 'loading', url: window.location.href, title: document.title.slice(0, 512),
    independent: !handlers.some(text => text.trim()) && !scripts.some(s => s.src) &&
      !/\b(?:opener|postMessage|eval|Function|import|createElement|innerHTML|write|Reflect|Proxy)\b|\b[A-Za-z_$][\w$]*\s*\[/.test(source) };
}

export const popupSupport = Object.freeze([
  { path: 'independent-navigation', result: 'background-safe', caveat: 'owned target only; native focus qualification pending' },
  { path: 'window.open / links / forms in observe mode', result: 'focus-unqualified', caveat: 'native semantics unchanged' },
  { path: 'native opening in strict mode', result: 'BACKGROUND_UNAVAILABLE', caveat: 'explicit incomplete handoff' },
  { path: 'opener / named-window / POST / noreferrer / sandbox / OAuth / COOP / document.write substitution', result: 'needs-opener-unqualified' },
  { path: 'late install / OOPIF / hostile page replacing hook', result: 'BACKGROUND_UNAVAILABLE' },
]);

export class PopupController {
  constructor({ session, authorize, timeoutMs = 1000, ...options }) {
    this.session = session;
    this.authorize = authorize;
    this.timeoutMs = timeoutMs;
    this.hooks = new Map();
    this.installs = new Set();
    this.attachment = new ScopedAttachment({ session, authorize, timeoutMs, ...options,
      setup: (scope, adapter) => this.hook(scope, adapter.send, 'observe', adapter.sessionId),
    });
  }
  async hook(scope, send, mode, sessionId) {
    const owner = randomUUID();
    const source = `(${popupHook})(${JSON.stringify(mode)}, ${JSON.stringify(owner)})`;
    await send('Page.enable', {});
    if (this.attachment.closing || this.attachment.closed) throw Error('CANCELLED');
    // A lost add-script response may leave a future hook without a known CDP identifier.
    const hook = { scope: Object.freeze({ ...scope }), identifier: null, sessionId, owner, pending: 0, futureDispatched: false };
    this.hooks.set(owner, hook);
    try {
      const script = await send('Page.addScriptToEvaluateOnNewDocument', { source }, hook);
      if (!script.identifier) throw Error('HOOK_UNPROVED');
      // Keep removal information even when the current-document install fails.
      hook.identifier = script.identifier;
      const current = await send('Runtime.evaluate', { expression: source, returnByValue: true }, hook);
      if (current.exceptionDetails || current.result?.value !== true) throw Error('HOOK_UNPROVED');
    } catch (error) {
      if (!hook.futureDispatched) this.hooks.delete(owner);
      throw error;
    }
  }
  install(scope, options) {
    const task = this.installScope(scope, options);
    this.installs.add(task);
    task.then(() => this.installs.delete(task), () => this.installs.delete(task));
    return task;
  }
  async installScope(scope, { beforeScripts = false, mode = 'strict', sessionId = this.session.sessionId } = {}) {
    if (this.attachment.closing || this.attachment.closed) return receipt(scope, 'prepared', 'none', 'cleanup-required');
    if (!beforeScripts || !['strict', 'observe'].includes(mode)) return receipt(scope, 'prepared', 'none', 'BACKGROUND_UNAVAILABLE');
    if (!validScope(scope) || !await granted(this.authorize, scope, 'popup-parent', this.timeoutMs)) return receipt(scope, 'prepared', 'none', 'permission-required');
    if (this.attachment.closing || this.attachment.closed) return receipt(scope, 'prepared', 'none', 'cleanup-required');
    const send = async (method, params, hook) => {
      if (this.attachment.closing || this.attachment.closed) throw Error('CANCELLED');
      if (!await granted(this.authorize, scope, 'popup-parent', this.timeoutMs)) throw Error('PERMISSION_REQUIRED');
      if (this.attachment.closing || this.attachment.closed) throw Error('CANCELLED');
      return bounded(() => this.attachment.sendOwned(scope, method, params, sessionId, hook), this.timeoutMs);
    };
    try {
      await this.hook(scope, send, mode, sessionId);
      await this.attachment.watch(scope);
      if (this.attachment.closing || this.attachment.closed) return receipt(scope, 'dispatched', 'unknown', 'cleanup-required');
      return receipt(scope, 'observed', 'unknown', mode === 'strict' ? 'BACKGROUND_UNAVAILABLE' : 'focus-unqualified');
    } catch { return receipt(scope, 'dispatched', 'unknown', 'BACKGROUND_UNAVAILABLE'); }
  }
  async openOwned(scope, { url, semantics } = {}) {
    if (semantics !== 'independent-navigation') return receipt(scope, 'prepared', 'none', 'needs-opener-unqualified');
    let origin;
    try { origin = new URL(url).origin; } catch {}
    if (!validScope(scope) || origin !== scope.origin || !await granted(this.authorize, scope, 'open', this.timeoutMs, { url })) return receipt(scope, 'prepared', 'none', 'permission-required');
    // Final dispatch fence: connection approval and earlier authorization never replace it.
    if (!await granted(this.authorize, scope, 'open-dispatch', this.timeoutMs, { url })) return receipt(scope, 'prepared', 'none', 'permission-required');
    try {
      const created = await bounded(() => this.session.send('Target.createTarget', { url, background: true }), this.timeoutMs);
      if (!created.targetId) throw Error('TARGET_UNKNOWN');
      return { ...receipt(scope, 'observed', 'unknown', 'focus-unqualified'), targetId: created.targetId };
    } catch { return receipt(scope, 'dispatched', 'unknown', 'reconcile-before-retry'); }
  }
  dispose() {
    // Fence new setup synchronously, before attachment or hook cleanup awaits.
    this.attachment.closing = true;
    if (!this.disposal) this.disposal = this.cleanup().finally(() => { this.disposal = null; });
    return this.disposal;
  }
  async cleanup() {
    const cleanup = await this.attachment.dispose();
    for (const [owner, hook] of this.hooks) {
      try {
        if (!hook.futureDispatched) { this.hooks.delete(owner); continue; }
        if (hook.pending) throw Error('CLEANUP_UNPROVED');
        if (!await granted(this.authorize, hook.scope, 'popup-cleanup', this.timeoutMs)) throw Error('IDENTITY_UNPROVED');
        if (!hook.futureRemoved && hook.identifier) {
          try {
            await bounded(() => this.session.send('Page.removeScriptToEvaluateOnNewDocument', {
              identifier: hook.identifier,
            }, hook.sessionId), this.timeoutMs);
            hook.futureRemoved = true;
          } catch { /* Current-document cleanup is independent of future registration removal. */ }
        }
        // A still-registered future hook can run again between cleanup attempts.
        const result = await bounded(() => this.session.send('Runtime.evaluate', {
          expression: `(() => { window[Symbol.for('sleight.popup2')]?.off(${JSON.stringify(owner)}); return true; })()`, returnByValue: true,
        }, hook.sessionId), this.timeoutMs);
        hook.currentRemoved = !result.exceptionDetails && result.result?.value === true;
        if (!hook.futureRemoved || !hook.currentRemoved) throw Error('CLEANUP_UNPROVED');
        this.hooks.delete(owner);
        cleanup.push(receipt(hook.scope, 'verified', 'observed', null));
      } catch { cleanup.push(receipt(hook.scope, 'dispatched', 'unknown', 'cleanup-required')); }
    }
    return cleanup;
  }
}
