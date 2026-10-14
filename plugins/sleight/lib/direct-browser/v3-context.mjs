import { randomUUID } from 'node:crypto';
import { canonical } from './authority.mjs';
import { check, inspectElement, intent, expirePaymentDialog } from './rules.mjs';
import { createUserFileProvider, stageUserUploads } from './files.mjs';
import { createConsentUi } from './consent-ui.mjs';

const bindings = new WeakMap(), contexts = new WeakSet();
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const refused = () => ({ verdict: 'refuse', message: 'Trusted turn or target evidence is unavailable. Use the engine browser path.' });
const equal = (a, b) => canonical(a) === canonical(b);
export const isV3Context = ctx => !!ctx && contexts.has(ctx);

// Called only by the inherited worker's begin handler. No model-facing endpoint
// accepts a binding, parsed permission or payment method. Copy the exact message.
export function createV3TurnBinding(message, current) {
  if (message?.source !== 'user' || !['session', 'turn', 'id'].every(key => text(message[key])) ||
      typeof message.text !== 'string' || Buffer.byteLength(message.text) > 65536 || typeof current !== 'function')
    throw Error('TRUSTED_TURN_REQUIRED');
  const binding = Object.freeze({});
  bindings.set(binding, { message: Object.freeze({ source: 'user', session: message.session, turn: message.turn, id: message.id, text: message.text }), current });
  return binding;
}

// A closed request grammar: ambiguous prose, negations and mentions ask the
// native UI. JSON here is text from the authenticated user message, not tool JSON.
// The quoted prose form has the same exact terms. Never infer omitted terms.
export function requestedPayment(message) {
  const source = message.trim(); let value;
  const json = /^(?:Please\s+)?(?:Pay|Buy|Purchase)\s+(\{[^\n]*\})\.?$/i.exec(source);
  const prose = /^(?:Please\s+)?Pay\s+"([^"\n]+)"\s+for\s+"([^"\n]+)"\s+to\s+"([^"\n]+)"\s+with\s+"([^"\n]+)"(?:\s+in\s+"([A-Z]{3})")?\.?$/.exec(source);
  try {
    if (json) value = JSON.parse(json[1]);
    else if (prose) value = { amount: prose[1], item: prose[2], payee: prose[3], method: prose[4], ...(prose[5] ? { currency: prose[5] } : {}) };
    else return;
    if (!value || Array.isArray(value) || Object.keys(value).some(key => !['item', 'amount', 'payee', 'method', 'currency'].includes(key)) ||
        !['item', 'amount', 'payee', 'method'].every(key => text(value[key])) || value.currency !== undefined && !/^[A-Z]{3}$/.test(value.currency)) return;
    return Object.freeze({ ...value });
  } catch { return; }
}

// Focus and its synchronous page handlers run in the same evaluation. Never
// let a failed focus silently send a key to the previously active control.
export function focusCheckedNode(el, focus) {
  if (!el.isConnected) return false;
  if (focus) HTMLElement.prototype.focus.call(el, { preventScroll: true });
  let active = el.ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active === el;
}

export function ownDocument(el) { return el.ownerDocument; }
export function samePageDocument(el, doc) { return el.isConnected && el.ownerDocument === doc; }

// All names are local so Playwright can serialize this read into the target's
// frame. Page metadata is an observation only; it can never supply the method.
// Require one visible exact labeled value per term in the target form/dialog.
export function readPaymentPage(el) {
  const doc = el.ownerDocument, view = doc.defaultView;
  const root = ('form' in el ? el.form : el.closest('form')) ?? el.closest('dialog,[role="dialog"]');
  const visible = node => {
    const r = node.getBoundingClientRect(), style = view.getComputedStyle(node);
    return r.width > 0 && r.height > 0 && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      style.visibility !== 'hidden' && style.display !== 'none';
  };
  const visibleText = (node, separator = ' ') => {
    const walker = doc.createTreeWalker(node, 4), parts = []; let part;
    while ((part = walker.nextNode())) if (part.parentElement && visible(part.parentElement)) parts.push(part.textContent);
    return parts.join(separator);
  };
  const field = key => {
    if (!root) return;
    const values = [];
    for (const node of root.querySelectorAll('[data-payment-' + key + '],[itemprop="' + key + '"],[name="' + key + '"],[aria-label="' + key + '" i]')) {
      if (!visible(node)) continue;
      const value = ['input', 'select', 'textarea'].includes(node.localName) ? node.value : visibleText(node);
      const shown = typeof value === 'string' ? value.trim().replace(new RegExp('^' + key + ':\\s*', 'i'), '') : '';
      const attribute = node.getAttribute('data-payment-' + key);
      if (attribute !== null && attribute.trim() !== shown) return;
      if (shown) values.push(shown);
    }
    if (!values.length) {
      const label = new RegExp('^' + key + ':\\s*(.+)$', 'i');
      for (const line of visibleText(root, '\n').split('\n')) { const match = label.exec(line.trim()); if (match) values.push(match[1].trim()); }
    }
    return values.length === 1 && values[0].length <= 4096 ? values[0] : undefined;
  };
  const page = Object.fromEntries(['item', 'amount', 'payee', 'currency'].map(key => [key, field(key)]).filter(([,value]) => value !== undefined));
  const labels = el.labels ? [...el.labels].map(label => label.innerText.trim()).filter(Boolean) : [];
  const name = el.getAttribute('aria-label') || (labels.length === 1 ? labels[0] : '');
  return { origin: view.location.origin, page, name };
}

function dialogTerms(message) {
  // Dialog text must independently name all page terms. An amount-only dialog
  // is insufficient evidence for the initiating item/payee and asks/refuses.
  const match = /^Pay\s+(\{[^\n]*\})\??$/i.exec(message ?? '');
  try {
    const value = match && JSON.parse(match[1]);
    if (!value || Object.keys(value).some(key => !['item', 'amount', 'payee', 'currency'].includes(key)) ||
        !['item', 'amount', 'payee'].every(key => text(value[key]))) return;
    return value;
  } catch { return; }
}

export function createV3Context({ binding, browser, ui, confirmPayments, now = Date.now } = {}) {
  const bound = bindings.get(binding);
  if (!bound || !text(browser)) throw Error('TRUSTED_TURN_REQUIRED');
  const requested = requestedPayment(bound.message.text), documents = new Map(), targets = new WeakMap(), held = new Set();
  const watched = new Map();
  const uploads = new WeakMap(), offered = new Map(), tickets = new Map(), pending = new Map();
  let closed = false, live, sequence = 0, dialogOwner;
  const current = () => { try { return !closed && bound.current() === true; } catch { return false; } };
  const fileProvider = createUserFileProvider({ now,
    readUserMessage: event => current() && event === binding ? { session: bound.message.session, text: bound.message.text } : undefined,
    resolveInput: ref => current() ? offered.get(ref) : undefined,
    current: () => current() ? live : undefined });
  // checkCurrent compares private data, never caller object identity or a page's
  // approval flag. The consumed ticket still binds every native operation field.
  let consuming;
  const native = ui && createConsentUi({ now, authenticate: event => current() && ui.authenticate(event) === true,
    checkCurrent: operation => current() && consuming === canonical(operation),
    present(view, operation) {
      const key = canonical(operation), record = pending.get(key);
      ui.present(view.id, { view, operation }, view.choices, event => {
        try { const ticket = native.respond(event); if (ticket && current() && pending.get(key) === record) tickets.set(key, ticket);
          else pending.delete(key); }
        catch { pending.delete(key); }
      });
    } });
  const files = Object.freeze({ check(paths, target) {
    try {
      const record = targets.get(target);
      if (!current() || !record || !text(record.name)) return false;
      const input = { ...record.identity, ref: target.ref, name: record.name };
      live = record.identity; offered.set(target.ref, input);
      const handle = fileProvider.offer(binding, paths, target.ref);
      uploads.set(target, { handle, paths: [...paths], record }); return true;
    } catch { return false; }
  } });
  let ruleTarget;
  const consent = Object.freeze({ consume(terms, target) {
    const record = targets.get(target) ?? dialogOwner;
    if (!record || !native || !['item','amount','payee','method'].every(key => text(terms[key]))) return false;
    const action = { type: 'fill', press: 'key', submit: 'click', check: 'click', uncheck: 'click' }[target.do] ?? target.do ?? 'click';
    const base = { ...record.identity, action, args: { ref: target.ref ?? record.ref ?? 'focused', key: target.key ?? null, accept: target.accept ?? null },
      destination: record.origin + '/', payment: { ...terms } };
    const keyBase = canonical(base);
    for (const [key, value] of pending) if (now() >= value.expires) { pending.delete(key); tickets.delete(key); }
    let entry = [...pending.values()].find(value => value.keyBase === keyBase);
    if (!entry) {
      if (pending.size >= 32) return false;
      const operation = { ...base, sequence: ++sequence }; entry = { operation, keyBase, expires: now() + 30000 };
      const key = canonical(operation); pending.set(key, entry);
      try { native.request(operation); } catch { pending.delete(key); }
      return false;
    }
    const key = canonical(entry.operation), ticket = tickets.get(key); tickets.delete(key);
    if (!ticket) return false;
    pending.delete(key); consuming = key;
    try { native.consume(ticket, entry.operation); return true; } catch { return false; }
    finally { consuming = undefined; }
  } });
  const ruleContext = { now, dialogContinuation: target => dialogOwner?.dialog === target.state?.dialog &&
      !!dialogOwner?.dialog && now() < dialogOwner.expires,
    session: bound.message.session, turn: bound.message.turn, userMessage: () => {
    if (!current()) return;
    const page = ruleTarget?.terms?.page;
    const observed = page && { ...page, method: requested?.method };
    // TS1 exactTerms equality: the whole observed terms object must match the
    // authenticated request, including optional currency. No provider echo.
    return { ...bound.message, ...(requested && observed && equal(observed, requested) ? { payment: requested } : {}) };
  }, consent, files, confirmPayments };
  async function prepare(target) {
    if (!current() || !target.locator || !target.state) throw Error('TRUSTED_TARGET_REQUIRED');
    const old = targets.get(target);
    const handle = old?.handle ?? (typeof target.locator.elementHandle === 'function' ? await target.locator.elementHandle({ timeout: 1000 }) : target.locator);
    if (!handle) throw Error('TRUSTED_TARGET_REQUIRED');
    held.add(handle);
    try {
      const frame = await handle.ownerFrame();
      if (!frame || !current() || old && (!old.doc.valid || !await handle.evaluate(samePageDocument, old.doc.handle))) throw Error('TRUSTED_TARGET_REQUIRED');
      let doc = documents.get(frame);
      if (!doc || !doc.valid || !await handle.evaluate(samePageDocument, doc.handle)) {
        const documentHandle = await handle.evaluateHandle(ownDocument);
        doc = { valid: true, handle: documentHandle, id: 'd' + randomUUID().replaceAll('-', '') }; documents.set(frame, doc); held.add(documentHandle);
      }
      if (typeof target.page?.on === 'function' && !watched.has(target.page)) {
        const navigate = frame => { const document = documents.get(frame); if (document) document.valid = false; };
        const dialog = value => {
          if (!dialogOwner?.active || dialogOwner.page !== target.page || now() >= dialogOwner.expires || dialogOwner.dialog) {
            dialogOwner = undefined; expirePaymentDialog(ruleContext); return;
          }
          dialogOwner.dialog = value;
        };
        target.page.on('framenavigated', navigate); target.page.on('dialog', dialog);
        watched.set(target.page, { navigate, dialog });
      }
      if (target.do === 'press' && !await handle.evaluate(focusCheckedNode, true)) throw Error('CHECKED_FOCUS_REQUIRED');
      const observed = await handle.evaluate(readPaymentPage);
      const parsed = new URL(frame.url());
      if (!['http:', 'https:'].includes(parsed.protocol) || observed.origin !== parsed.origin || !current()) throw Error('TRUSTED_TARGET_REQUIRED');
      const identity = { browserIncarnation: browser, brokerEpoch: 1, clientSession: bound.message.session, turn: bound.message.turn,
        leaseGeneration: 1, target: doc.id, frame: doc.id, document: doc.id, origin: observed.origin };
      const record = { handle, doc, frame, page: target.page, identity, origin: observed.origin, name: observed.name, ref: target.ref };
      targets.set(target, record); live = identity;
      // Last inspection is on the exact pinned element, after all page terms.
      const element = await handle.evaluate(inspectElement);
      if (!current()) throw Error('TRUSTED_TARGET_REQUIRED');
      Object.assign(target, { session: bound.message.session, turn: bound.message.turn, document: doc.id, origin: observed.origin,
        element, prior: target.prior ?? target.element, locator: handle, terms: { page: observed.page, method: requested?.method },
        submit: intent(target.do ?? 'click', { ...target, element }).submit });
      return record;
    } catch (error) { held.delete(handle); await handle.dispose().catch(() => {}); throw error; }
  }
  const ctx = Object.freeze({ session: bound.message.session, turn: bound.message.turn, userMessage: ruleContext.userMessage,
    consent, files, prepareTarget: prepare, paymentTerms: target => targets.get(target) ? target.terms : undefined,
    async check(kind, target, { fieldOnly = false } = {}) {
      try {
        if (!current()) return refused();
        target.do = kind;
        if (kind !== 'dialog') { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
        if (kind === 'dialog') {
          if (target.accept === false) { dialogOwner = undefined; expirePaymentDialog(ruleContext); return { verdict: 'allow' }; }
          if (!dialogOwner?.dialog || target.state?.dialog !== dialogOwner.dialog || now() >= dialogOwner.expires || !dialogOwner.doc.valid || !current()) return refused();
          if (target.page && dialogOwner.page !== target.page) return refused();
          if (new URL(dialogOwner.frame.url()).origin !== dialogOwner.origin) return refused();
          const page = dialogTerms(target.message), record = dialogOwner;
          Object.assign(target, { session: bound.message.session, turn: bound.message.turn, document: record.doc.id, origin: record.origin,
            terms: { page, method: requested?.method }, element: { payment: !!page || /\bpay|payment|buy|purchase|charge\b/i.test(target.message ?? '') } });
          targets.set(target, record);
        } else if (target.locator) await prepare(target);
        else if (!['wait','back','forward','reload','viewport'].includes(kind)) return refused();
        else Object.assign(target, { session: bound.message.session, turn: bound.message.turn });
        if (fieldOnly && intent(kind, target).submit) return refused();
        ruleTarget = target;
        const result = check(ruleContext, kind, target);
        if (result.verdict === 'allow' && ['click', 'press', 'submit'].includes(kind))
          dialogOwner = { ...targets.get(target), target, active: false, expires: now() + 5000 };
        if (kind === 'dialog' && result.verdict === 'allow') { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
        return result;
      } catch { return refused(); }
      finally { ruleTarget = undefined; }
    },
    beginInput(target) { if (dialogOwner?.target === target && current()) dialogOwner.active = true; },
    finishInput(target) {
      if (dialogOwner?.target !== target) return;
      dialogOwner.active = false;
      if (!dialogOwner.dialog) { dialogOwner = undefined; expirePaymentDialog(ruleContext); }
    },
    async pressTarget(target, key, options) {
      const record = targets.get(target);
      if (!current() || !record?.doc.valid || !await record.handle.evaluate(samePageDocument, record.doc.handle) ||
          !await record.handle.evaluate(focusCheckedNode, false) || !current()) throw Error('CHECKED_FOCUS_REQUIRED');
      // ElementHandle.press focuses again without verifying its recipient.
      // Use only the owned page keyboard after the checked ref retained focus.
      return target.page.keyboard.press(key, options);
    },
    async stageUploads(target, paths) {
      const entry = uploads.get(target); uploads.delete(target);
      if (!entry || !current() || !entry.record.doc.valid || !equal(paths, entry.paths) || !await entry.record.handle.evaluate(samePageDocument, entry.record.doc.handle))
        throw Error('USER_NAMED_FILE_REQUIRED');
      const observed = await entry.record.handle.evaluate(readPaymentPage);
      if (observed.origin !== entry.record.origin || observed.name !== entry.record.name || !current()) throw Error('USER_NAMED_FILE_REQUIRED');
      live = entry.record.identity;
      const bindingData = { ...entry.record.identity, ref: target.ref, operation: 'upload' };
      return stageUserUploads({ event: binding, binding: bindingData, provider: {
        offer(event, exactPaths, ref) {
          if (event !== binding || ref !== target.ref || !equal(exactPaths, entry.paths)) throw Error('USER_NAMED_FILE_REQUIRED');
          return entry.handle;
        }, stage: fileProvider.stage,
      } }, paths, target.ref);
    },
    async dragTo(target, destination) {
      const source = targets.get(target);
      if (!source || !current() || !source.doc.valid) throw Error('TRUSTED_TARGET_REQUIRED');
      const endpoint = { page: target.page, locator: destination, ref: target.ref, state: target.state, do: 'drag' };
      let down = false;
      try {
        const verdict = await ctx.check('drag', endpoint);
        if (verdict.verdict !== 'allow') throw Error('TRUSTED_TARGET_REQUIRED');
        const end = targets.get(endpoint);
        if (end.frame !== source.frame || end.doc !== source.doc) throw Error('TRUSTED_TARGET_REQUIRED');
        // ElementHandle has no dragTo. Its hover uses Playwright actionability
        // on the pinned node, and the mouse belongs only to this owned page.
        await end.handle.hover({ timeout: 1000 }); await source.handle.hover({ timeout: 1000 });
        if (!current() || !source.doc.valid) throw Error('TRUSTED_TARGET_REQUIRED');
        await target.page.mouse.down(); down = true;
        await end.handle.hover({ timeout: 1000 }); await end.handle.hover({ timeout: 1000 });
      } finally {
        if (down) await target.page.mouse.up();
        await ctx.releaseTarget(endpoint);
      }
    },
    async releaseTarget(target) {
      const handle = targets.get(target)?.handle;
      if (handle && held.delete(handle)) await handle.dispose().catch(() => {});
    },
    async dispose() {
      closed = true; native?.revoke();
      for (const [page, handlers] of watched) { page.off('framenavigated', handlers.navigate); page.off('dialog', handlers.dialog); } watched.clear(); tickets.clear(); pending.clear(); offered.clear();
      const receipt = fileProvider.dispose();
      await Promise.allSettled([...held].map(handle => handle.dispose?.())); held.clear(); documents.clear();
      return receipt;
    },
  });
  contexts.add(ctx); return ctx;
}
