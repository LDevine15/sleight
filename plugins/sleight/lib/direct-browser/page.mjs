// Background popup disposition for turbo v3, independently implemented for CR1.
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
  // https://html.spec.whatwg.org/multipage/document-sequences.html#navigable-container
  // and iframe-embed-object.html, obsolete.html#frames; fenced frames:
  // https://wicg.github.io/fenced-frame/#fenced-frame-element. Do not cross documents.
  const CR2_NESTED_DOCUMENT = focus => {
    while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement;
    return /^(iframe|object|embed|frame|fencedframe)$/.test(focus?.localName);
  };
  const getAttribute = Element.prototype.getAttribute, hasAttribute = Element.prototype.hasAttribute;
  const nativeMatches = Element.prototype.matches;
  // Target decisions read only natives captured here, before any page script: a page can
  // redefine document.querySelector, window.name or window.frames, never these references.
  const getOwn = Object.getOwnPropertyDescriptor;
  const nativeQuery = globalThis.Document?.prototype.querySelector, nativeQueryAll = globalThis.Document?.prototype.querySelectorAll;
  const query = (root, selector) => (nativeQuery ?? root.querySelector).call(root, selector);
  const queryAll = (root, selector) => (nativeQueryAll ?? root.querySelectorAll).call(root, selector);
  const nameGetter = getOwn(window, 'name')?.get, openerGetter = getOwn(window, 'opener')?.get, framesGetter = getOwn(window, 'frames')?.get;
  const nameOf = context => nameGetter ? nameGetter.call(context) : context.name;
  const framesOf = context => framesGetter ? framesGetter.call(context) : context.frames;
  const editable = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'isContentEditable').get;
  const attribute = (node, name) => getAttribute.call(node, name);
  const has = (node, name) => hasAttribute.call(node, name);
  // Brand-checked natives: a node, form or window from another realm (an iframe, a window.open handle) is
  // never an `instanceof` of this realm's constructors, but these getters accept it and reject anything else.
  const nodeProto = globalThis.Node?.prototype ?? {};
  const nodeGetter = name => getOwn(nodeProto, name)?.get;
  const nodeTypeOf = nodeGetter('nodeType'), parentNodeOf = nodeGetter('parentNode'), ownerDocumentOf = nodeGetter('ownerDocument');
  const rootNodeOf = nodeProto.getRootNode;
  const shadowHostOf = getOwn(globalThis.ShadowRoot?.prototype ?? {}, 'host')?.get;
  const localNameOf = getOwn(Element.prototype, 'localName')?.get;
  const defaultViewOf = getOwn(globalThis.Document?.prototype ?? {}, 'defaultView')?.get;
  const formElementsOf = getOwn(globalThis.HTMLFormElement?.prototype ?? {}, 'elements')?.get;
  const collectionLength = getOwn(globalThis.HTMLCollection?.prototype ?? {}, 'length')?.get;
  const fnToString = Function.prototype.toString;
  const postTask = globalThis.scheduler?.postTask?.bind(globalThis.scheduler);
  const NativeObserver = globalThis.MutationObserver, nativeObserve = NativeObserver?.prototype.observe, nativeDisconnect = NativeObserver?.prototype.disconnect;
  const isElement = node => {
    if (!nodeTypeOf) return node instanceof Element; // A test double has no Node interface to brand-check.
    try { return nodeTypeOf.call(node) === 1; } catch { return false; }
  };
  const nameOfElement = node => { try { return localNameOf ? localNameOf.call(node) : node.localName; } catch { return ''; } };
  const isLinkTag = node => { const name = nameOfElement(node); return name === 'a' || name === 'area'; };
  const docOf = node => {
    try { return nodeTypeOf.call(node) === 9 ? node : ownerDocumentOf.call(node) ?? document; } catch { return document; }
  };
  const viewOf = node => { try { return defaultViewOf.call(docOf(node)) ?? window; } catch { return window; } };
  const parentOf = node => {
    if (!parentNodeOf) return node.parentElement ?? node.getRootNode?.().host;
    try { const parent = parentNodeOf.call(node); if (parent) return parent; } catch { return null; }
    try { return shadowHostOf?.call(node) ?? null; } catch { return null; }
  };
  // The shadow-including ancestors that are elements, innermost first.
  const ancestors = element => {
    const result = [], seen = new Set();
    for (let node = element; node && !seen.has(node); node = parentOf(node)) { seen.add(node); if (isElement(node)) result.push(node); }
    return result;
  };
  // True for a node in the document's own light tree, where the window-level guard sees its events.
  const inDocument = node => {
    if (!isConnected(node)) return false;
    try { return rootNodeOf ? nodeTypeOf.call(rootNodeOf.call(node)) === 9 : true; } catch { return false; }
  };
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
  const controlOf = node => {
    for (const control of formControls) {
      if (!nodeTypeOf && !(node instanceof control.constructor)) continue;
      try { return { control, type: control.type.call(node) }; } catch { /* Not this kind of control. */ }
    }
  };
  const isSubmitType = type => /^(submit|image)$/.test(type);
  const labelTarget = node => {
    if (!nodeTypeOf && !(node instanceof labelControl.constructor)) return node;
    try { return labelControl.control.call(node) ?? node; } catch { return node; }
  };
  const isMultiSelect = node => {
    if (!nodeTypeOf && !(node instanceof selectControl.constructor)) return false;
    try { return selectControl.multiple.call(node); } catch { return false; }
  };
  const isEditable = node => { try { return editable.call(node); } catch { return false; } };
  const elementsOf = form => {
    const list = [];
    try {
      const collection = formElementsOf ? formElementsOf.call(form) : form.elements;
      const length = collection ? (collectionLength ? collectionLength.call(collection) : collection.length) : 0;
      for (let i = 0; i < length && i < 4096; i++) list.push(collection[i]);
    } catch { /* No readable controls. */ }
    return list;
  };
  // HTML forms.html#the-label-element: an interactive descendant does
  // not forward label activation. This selector limits label forwarding only;
  // it does not give any of these elements a plain-click exception.
  const interactive = 'a[href],audio[controls],button,details,embed,iframe,img[usemap],input:not([type="hidden"]),label,select,textarea,video[controls]';
  // The form and submit control a click or Enter on this node would submit, if any. Enter in another field
  // submits through the form's default button, the first submit control among form.elements.
  const submission = (node, implicit) => {
    const own = controlOf(node);
    if (!own) return;
    const form = own.control.form.call(node);
    if (!form) return;
    if (isSubmitType(own.type)) return { form, submitter: node };
    if (!implicit || /^(button|reset)$/.test(own.type)) return;
    for (const candidate of elementsOf(form)) {
      const other = controlOf(candidate);
      if (other && isSubmitType(other.type)) return { form, submitter: candidate };
    }
    return { form, submitter: undefined };
  };
  // Same-context submissions and multiple-select selection need plain input.
  // New-context submissions keep the modifier that selects a background tab.
  const submits = node => {
    const found = submission(node, false);
    return !!found && sameContext(found.form, submitTarget(found.form, found.submitter));
  };
  const submitTarget = (form, submitter) => {
    const own = submitter && has(submitter, 'formtarget') ? attribute(submitter, 'formtarget') : null;
    return own ?? targetOf(form); // An empty formtarget still overrides: it names the current context.
  };
  const plainControl = node => submits(node) || isMultiSelect(node);
  const key = Symbol.for('sleight.popup3');
  if (window[key]) return true;
  const retired = new Set(), replacements = [], events = new WeakMap(), masked = new WeakMap();
  const nativeOpen = window.open, nativePrevent = Event.prototype.preventDefault;
  const composedPath = Event.prototype.composedPath, now = Date.now;
  const prevented = Object.getOwnPropertyDescriptor(Event.prototype, 'defaultPrevented');
  const returnValue = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue');
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const openedWindows = [];
  const dispatch = EventTarget.prototype.dispatchEvent, elementQueryAll = Element.prototype.querySelectorAll;
  const typeGetter = getOwn(Event.prototype, 'type')?.get, connectedGetter = getOwn(globalThis.Node?.prototype ?? {}, 'isConnected')?.get;
  const eventType = event => typeGetter ? typeGetter.call(event) : event.type;
  const isConnected = node => connectedGetter ? connectedGetter.call(node) : node.isConnected;
  // Script-started openings held since the last agent step, so the result can say so.
  let held = 0, arm;
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
  const live = () => arm && now() < arm.until;
  const active = () => live() && arm.masking;
  const matches = event => event.isTrusted && composedPath.call(event).includes(arm.element);
  // A form watch follows its submit control too: Enter in a field clicks the form's default button.
  const matchesWatch = event => event.isTrusted && (composedPath.call(event).includes(arm.element)
    || !!arm.watch?.submitter && composedPath.call(event).includes(arm.watch.submitter));
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
  // Enter pressed with the modifier held (a keyboard-started link or form) hides it the same way.
  if (globalThis.KeyboardEvent) {
    for (const name of ['ctrlKey', 'metaKey']) {
      const descriptor = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, name);
      replace(KeyboardEvent.prototype, name, { ...descriptor, get() { return hide(this) ? false : descriptor.get.call(this); } });
    }
    const keyModifierState = KeyboardEvent.prototype.getModifierState;
    replace(KeyboardEvent.prototype, 'getModifierState', { configurable: true, writable: true, value(name) {
      return (name === 'Control' || name === 'Meta') && hide(this) ? false : keyModifierState.call(this, name);
    } });
  }
  replace(Event.prototype, 'preventDefault', { configurable: true, writable: true, value() {
    const record = events.get(this);
    if (record && this.cancelable !== false) record.cancelled = true;
    const result = nativePrevent.call(this);
    if (!record && (this.isTrusted || eventType(this) === probeType)) forward(this);
    return result;
  } });
  replace(Event.prototype, 'defaultPrevented', { ...prevented, get() {
    return events.has(this) ? events.get(this).cancelled : prevented.get.call(this);
  } });
  replace(Event.prototype, 'returnValue', { ...returnValue, get() {
    return events.has(this) ? !events.get(this).cancelled : returnValue.get.call(this);
  }, set(value) {
    const record = events.get(this);
    if (record && !value && this.cancelable !== false) record.cancelled = true;
    const result = returnValue.set.call(this, value);
    // Setting it false cancels like preventDefault: a hooked realm's setter tells every hook that can reach the event.
    if (!record && !value && (this.isTrusted || eventType(this) === probeType)) forward(this);
    return result;
  } });
  const cancelEvent = event => { const record = events.get(event); if (record && event.cancelable !== false) record.cancelled = true; };
  // A new window's first document runs no hook yet, and a function the page takes from it now stays native.
  // Run the whole hook in it before the handle reaches the page; if that realm cannot be reached or its
  // policy forbids eval, at least forward its preventDefault.
  const coverInitialDocument = opened => {
    try {
      const prototype = opened.Event.prototype, original = prototype.preventDefault;
      Object.defineProperty(prototype, 'preventDefault', { configurable: true, writable: true, value() {
        const result = original.apply(this, arguments);
        cancelEvent(this);
        return result;
      } });
    } catch { /* Cross-origin: nothing readable to cancel with. */ }
  };
  const hookSource = '(' + fnToString.call(popupHook) + ')()';
  const installInto = opened => {
    if (hooked(opened)) return;
    try { opened.eval(hookSource); } catch { /* Cross-origin, or a policy that forbids eval. */ }
    if (!hooked(opened)) coverInitialDocument(opened);
  };
  const open = function(url, target, features) {
    if (/^_(self|parent|top)$/i.test(String(target))) return nativeOpen.apply(this, arguments);
    if (!active() || !navigator.userActivation?.isActive) { held++; return null; }
    const kept = String(features ?? '').split(',').map(value => value.trim()).filter(value => /^(noopener|noreferrer)(?:=|$)/i.test(value));
    const opened = nativeOpen.call(this, url, target, kept.join(','));
    if (opened) { openedWindows.push(opened); installInto(opened); }
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
  const baseTarget = (doc = document) => {
    const base = query(doc, 'base[target]');
    return base ? attribute(base, 'target') : '';
  };
  const targetOf = element => attribute(element, 'target') ?? baseTarget(docOf(element));
  // Child windows by index: WindowProxy indexed properties cannot be redefined by a page.
  const childWindows = context => {
    const list = [];
    for (let i = 0, frames; i < 256; i++) {
      let child;
      try { child = (frames ??= framesOf(context))[i]; } catch { break; }
      if (!child) break;
      list.push(child);
    }
    return list;
  };
  const readable = context => { try { return !!context.document; } catch { return false; } };
  // Resolved from the element's own window, so a native taken from another realm decides the same way.
  const sameContext = (element, target = targetOf(element)) => {
    // The HTML spec checks `_blank` before names, so window.name = '_blank' cannot make it current.
    if (/^_blank$/i.test(target)) return false;
    const view = viewOf(element);
    if (!target || /^_(self|parent|top)$/i.test(target) || target === nameOf(view)) return true;
    // A window the page opened by name is not the current context: navigating it by link raises it.
    // Indexed WindowProxy children remain traversable across origins, while
    // names and documents are readable only where same-origin access permits.
    const seen = new Set(), pending = [view.top ?? view];
    while (pending.length) {
      const context = pending.pop();
      if (!context || seen.has(context)) continue;
      seen.add(context);
      try { if (nameOf(context) === target) return true; } catch { /* Cross-origin name. */ }
      try {
        for (const frame of queryAll(context.document, 'iframe[name],frame[name]'))
          if (attribute(frame, 'name') === target) return true;
      } catch { /* Cross-origin document. */ }
      // A same-origin page can shadow named access with its own property; a cross-origin one cannot.
      let named;
      try { if (!readable(context) || !getOwn(context, target)) named = framesOf(context)[target]; } catch { /* Cross-origin named access. */ }
      for (const child of childWindows(context)) {
        if (named && child === named) return true;
        pending.push(child);
      }
    }
    try {
      for (const frame of queryAll(docOf(element), 'iframe[name],frame[name]'))
        if (attribute(frame, 'name') === target) return true;
    } catch { /* No document to search. */ }
    return false;
  };
  // preventDefault from another realm sets the same native flag, so it is invisible here unless that
  // realm is hooked too: a hooked realm forwards the call to every hook it can reach (forward/cancel).
  // Every same-origin window this page reaches counts, including handles from window.open and the opener.
  const probeType = 'sleight.probe';
  // A frame the page later removes keeps its way back to the owner that was its parent when it was hooked.
  const home = [window.parent, window.top];
  const realms = () => {
    const seen = new Set([window]), found = [], pending = [window.top, window.parent, ...home, ...childWindows(window), ...openedWindows];
    try { const opener = openerGetter?.call(window); if (opener) pending.push(opener); } catch { /* No opener. */ }
    for (let steps = 0; pending.length && steps < 512; steps++) {
      const context = pending.pop();
      if (!context || seen.has(context)) continue;
      seen.add(context);
      if (readable(context)) {
        found.push(context);
        try { pending.push(context.top, context.parent, openerGetter?.call(context)); } catch { /* Unreadable. */ }
      }
      pending.push(...childWindows(context));
    }
    return found;
  };
  const forward = event => { for (const context of realms()) try { context[key]?.cancel(event); } catch { /* Not a hook. */ } };
  // A realm is hooked when its preventDefault reaches this hook. A page cannot fake that without the native
  // function, which only an unhooked realm still holds.
  const hooked = context => {
    try {
      const canary = new Event(probeType, { cancelable: true }), record = { cancelled: false };
      events.set(canary, record);
      context.Event.prototype.preventDefault.call(canary);
      return record.cancelled;
    } catch { return false; }
  };
  const otherRealm = () => realms().some(context => !hooked(context));
  // Script-initiated openings (a timer, a later event) carry no agent modifier, so the browser
  // would raise the new tab. Refuse them unless an agent click is being dispatched.
  const holdsNewContext = node => {
    try {
      node = labelTarget(node);
      if (nativeMatches.call(node, 'a[href],area[href]')) return !has(node, 'download') && !sameContext(node);
      const found = submission(node, false);
      if (found) return !sameContext(found.form, submitTarget(found.form, found.submitter));
    } catch { return isElement(node); /* Undecidable for an element: hold it. */ }
    return false;
  };
  // The node itself or the nearest link or control above it (shadow trees included) decides.
  const holdsChain = node => {
    for (const candidate of ancestors(node)) {
      let hit = false;
      try { hit = nativeMatches.call(candidate, 'a[href],area[href],button,input,label'); } catch { /* Not an element. */ }
      if (hit) return holdsNewContext(candidate);
    }
    return false;
  };
  const holdsForm = (form, submitter) => {
    try { return !sameContext(form, submitTarget(form, submitter)); }
    catch { return true; }
  };
  // Enter in this control submits a form into a new context (the form's, or its default button's formtarget).
  // A form whose target cannot be decided counts as new-context.
  const opensForm = node => {
    try {
      const found = submission(node, true);
      return !!found && !sameContext(found.form, submitTarget(found.form, found.submitter));
    } catch { return true; }
  };
  // Script entry points that open a context without an agent click. Held outside agent dispatch.
  const hold = (constructor, name, holds) => {
    const native = constructor?.prototype?.[name];
    if (typeof native === 'function') replace(constructor.prototype, name, { configurable: true, writable: true, value() {
      if (active() || !holds.apply(this, arguments)) return native.apply(this, arguments);
      held++;
    } });
  };
  hold(globalThis.HTMLElement, 'click', function() { return holdsChain(this); });
  hold(globalThis.HTMLFormElement, 'submit', function() { return holdsForm(this); });
  hold(globalThis.HTMLFormElement, 'requestSubmit', function(submitter) { return holdsForm(this, submitter); });
  // The window-level guard below never sees a click dispatched on a detached element, or one inside a shadow
  // tree (a closed root hides its inside from composedPath). Refuse those here instead of dispatching: a
  // listener registered first could otherwise stop a cancel. Realm-independent: brand checks, no instanceof.
  if (typeof dispatch === 'function') replace(EventTarget.prototype, 'dispatchEvent', { configurable: true, writable: true, value(event) {
    try {
      if (!active() && event && !event.isTrusted && eventType(event) === 'click' && isElement(this) && !inDocument(this)
        && holdsChain(this)) { held++; return false; }
    } catch { /* Not an event or element: the native call reports it. */ }
    return dispatch.apply(this, arguments);
  } });
  // A top-level window the page opened is raised by focus(); a frame is not. Nothing here needs the page to take focus.
  const focusOwner = getOwn(window, 'focus') ? window : globalThis.Window?.prototype;
  const nativeFocus = focusOwner?.focus;
  if (focusOwner && typeof nativeFocus === 'function') replace(focusOwner, 'focus', { configurable: true, writable: true, value() {
    let topLevel = true;
    try { const subject = this ?? window; topLevel = subject.top === subject; } catch { /* Unreadable: treat as raisable. */ }
    return topLevel ? undefined : nativeFocus.apply(this, arguments);
  } });
  // A dispatched click (not a user's) on a connected link or submit control.
  const guard = event => {
    if (event.isTrusted || active()) return;
    for (const node of composedPath.call(event)) {
      let hit = false;
      try { hit = isElement(node) && nativeMatches.call(node, 'a[href],area[href],button,input,label'); } catch { /* Not an element. */ }
      if (hit) { if (holdsNewContext(node)) { held++; nativePrevent.call(event); } return; }
    }
  };
  const linkState = element => {
    if (!element || !isLinkTag(element) || !has(element, 'href') || has(element, 'download')) return;
    if (sameContext(element)) return;
    let url;
    try { url = new URL(attribute(element, 'href'), document.baseURI); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const target = targetOf(element);
    const rel = attribute(element, 'rel') ?? '';
    return { url: url.href, target, rel, signature: JSON.stringify([url.href, target, rel]) };
  };
  // A link that would open a new context, whether or not sleight can decide where.
  const opensLink = element => isLinkTag(element) && has(element, 'href') && !has(element, 'download') && !sameContext(element);
  // Cancel the browser's own open and keep the request for the background tab. Inline handlers that return false
  // are read at dispatch, after pointer handlers may have changed them; a browser cancels internally when one
  // does, so observe that return without calling the handler a second time.
  const engage = (event, link) => {
    const record = { ...link, cancelled: prevented.get.call(event), event };
    events.set(event, record); arm.request = record;
    nativePrevent.call(event);
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
  // The event is still being dispatched: stop the browser acting on it, and tell the agent.
  const block = reason => {
    arm.blocked = reason;
    for (const event of [arm.clicked, arm.submit]) if (event) try { nativePrevent.call(event); } catch { /* Not an event. */ }
  };
  // A listener can change a same-context link's or form's target after the agent decided it was plain
  // (including a flip in the link's own click handler). Decide again from what the page has now.
  const recheck = () => {
    if (!arm?.watch || arm.done || arm.blocked || !arm.clicked) return;
    const { kind, element, form, submitter } = arm.watch;
    try {
      if (kind === 'form') { if (holdsForm(form, submitter)) block('form'); return; }
      if (arm.link) return;
      const link = linkState(element);
      if (link) { arm.link = link; engage(arm.clicked, link); }
      else if (opensLink(element)) block('link');
    } catch { block(kind); }
  };
  const capture = event => {
    if (!live() || !arm.watch && arm.clicked || !(arm.watch ? matchesWatch(event) : matches(event))) return;
    if (active()) masked.set(event, arm.token);
    arm.clicked = event;
    // A task queued by the capture listener runs after synchronous dispatch,
    // even when a page stops propagation. Keep the arm for takeRequest.
    const current = arm, endDispatch = () => { if (arm === current) { arm.masking = false; arm.done = true; } };
    clearTimeout(arm.dispatchTimer);
    arm.dispatchTimer = setTimeout(endDispatch, 0);
    // A page task at the highest priority (scheduler.postTask 'user-blocking') can run before a timer. This one is
    // queued first, so it ends the dispatch before any such page task.
    try { postTask?.(endDispatch, { priority: 'user-blocking' }); } catch { /* The timer ends it. */ }
    if (arm.watch) { arm.done = false; recheck(); return; }
    if (!arm.link) return;
    engage(event, arm.link);
  };
  const submitted = event => {
    if (!live() || arm.watch?.kind !== 'form' || arm.done) return;
    try { if (composedPath.call(event).includes(arm.watch.form)) { arm.submit = event; recheck(); } } catch { /* Not an event. */ }
  };
  const changed = () => recheck();
  const watchChanges = () => {
    if (!NativeObserver) return;
    // Attributes anywhere (a link, a form, its submit control) and nodes added or removed (a <base>): any change
    // makes the watch decide again, in the microtask after the listener that made it.
    arm.observer = new NativeObserver(changed);
    nativeObserve.call(arm.observer, document, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['target', 'href', 'rel', 'download', 'formtarget', 'form'] });
  };
  add.call(window, 'keydown', keyEvent, true);
  add.call(window, 'keyup', keyEvent, true);
  add.call(window, 'click', capture, true);
  add.call(window, 'click', guard, true);
  add.call(window, 'submit', submitted, true);
  const finish = token => {
    retired.add(token);
    if (arm?.token !== token) return true;
    clearTimeout(arm.timer); clearTimeout(arm.dispatchTimer);
    if (arm.observer) try { nativeDisconnect.call(arm.observer); } catch { /* Already gone. */ }
    for (const { node, before, wrapper } of arm.handlers) if (wrapper !== before && node.onclick === wrapper) node.onclick = before;
    arm = undefined; return true;
  };
  const api = {
    prepare(element, token, capMs, press) {
      if (retired.has(token)) return false;
      held = 0;
      if (arm) finish(arm.token);
      if (CR2_NESTED_DOCUMENT(document.activeElement)) throw Error('document focus is inside a frame');
      if (!isElement(element) || !isConnected(element) || !Number.isFinite(capMs) || capMs <= 0) return false;
      const space = press === 'space';
      const chain = ancestors(element);
      let watch;
      for (const [index, node] of chain.entries()) {
        // In editable text a plain link click places the caret. The native
        // getter includes inherited contenteditable and document designMode.
        if (isEditable(node) || isMultiSelect(node)) return false;
        if (press) continue;
        const found = submission(node, false);
        if (found && sameContext(found.form, submitTarget(found.form, found.submitter))) { watch = { kind: 'form', ...found }; break; }
        // A label can forward activation to a submit control outside its tree.
        const control = labelTarget(node);
        if (control !== node && !chain.slice(0, index).some(child => nativeMatches.call(child, interactive))) {
          const forwarded = submission(control, false);
          if (forwarded && sameContext(forwarded.form, submitTarget(forwarded.form, forwarded.submitter))) { watch = { kind: 'form', ...forwarded }; break; }
        }
      }
      let link, linkElement;
      if (press) {
        // Keyboard activation acts on the focused element only. Enter follows a link and, in a field, submits the
        // form through its default button; Space presses a button and does nothing to a link or a field.
        if (isLinkTag(element) && has(element, 'href') && !space) {
          if (has(element, 'download')) return false;
          linkElement = element;
          if (sameContext(element)) watch = { kind: 'link', element };
          else {
            link = linkState(element);
            // Ctrl+Enter follows a decidable link into a background tab. One sleight cannot decide (credentials,
            // about:blank) would open in the foreground on a plain Enter, so the press is refused.
            if (!link) return { kind: 'refuse', reason: 'link' };
          }
        } else {
          const found = submission(element, !space);
          if (!found) return false;
          if (holdsForm(found.form, found.submitter)) return { kind: 'refuse', reason: 'form' };
          watch = { kind: 'form', ...found };
        }
      } else if (!watch) {
        linkElement = chain.find(node => isLinkTag(node) && has(node, 'href'));
        if (linkElement && sameContext(linkElement)) {
          if (has(linkElement, 'download')) return false;
          watch = { kind: 'link', element: linkElement };
        } else link = linkState(linkElement);
      }
      arm = { element, token, until: now() + capMs, masking: false, modifiers: new Set(), link, linkElement, watch, handlers: [] };
      arm.timer = setTimeout(() => finish(token), capMs);
      if (watch) { watchChanges(); return { kind: 'watch' }; }
      return link ? { kind: 'link' } : true;
    },
    takeRequest(token) {
      if (!live() || arm.token !== token || arm.taken) return { unavailable: true, lost: true };
      arm.taken = true;
      if (arm.blocked) return { blocked: arm.blocked };
      if (!arm.request) return arm.watch ? undefined : { unavailable: true };
      if (arm.request.cancelled) return;
      if (otherRealm()) return { unavailable: true };
      const current = linkState(arm.linkElement ?? arm.watch?.element);
      if (!arm.element.isConnected || current?.signature !== arm.request.signature
        || arm.handlers.some(({ node, wrapper }) => node.onclick !== wrapper)) return { unavailable: true };
      return { url: arm.request.url, target: arm.request.target, rel: arm.request.rel };
    },
    finish,
    cancel: cancelEvent,
    take() { const count = held; held = 0; return count; },
    off() {
      if (arm) finish(arm.token);
      remove.call(window, 'keydown', keyEvent, true);
      remove.call(window, 'keyup', keyEvent, true);
      remove.call(window, 'click', capture, true);
      remove.call(window, 'click', guard, true);
      remove.call(window, 'submit', submitted, true);
      for (const restore of replacements.reverse()) restore();
      if (window[key] === api) delete window[key];
      return true;
    },
  };
  window[key] = api;
  return true;
}

export async function backgroundClick(tab, locator, click = options => locator.click({ ...options, timeout: timeoutMs }), { timeoutMs = 1000, press = false } = {}) {
  const token = randomUUID();
  const disarm = () => tab.page.evaluate(token => window[Symbol.for('sleight.popup3')]?.finish(token), token);
  try {
    let prepared;
    try {
      prepared = await deadline(() => locator.evaluate((element, { token, capMs, press }) => {
        const hook = window[Symbol.for('sleight.popup3')];
        if (!hook) throw Error('background popup hook unavailable');
        return hook.prepare(element, token, capMs, press);
      }, { token, capMs: timeoutMs + 1000, press }, { timeout: timeoutMs }), timeoutMs);
    } catch { throw Error('background popup preparation failed; use the engine browser path'); }
    if (prepared?.kind === 'refuse') throw Error(prepared.reason === 'link'
      ? 'Enter would open this link in a new tab, and sleight cannot check where it goes; click the link instead'
      : 'Enter would submit this form into a new tab; click its submit button instead');
    const modified = prepared === true || prepared?.kind === 'link';
    const checkpoint = tab.popupCheckpoint?.();
    tab.background = modified; // Read by the result: a popup after an unmodified click probably took the foreground.
    let result;
    try { result = await click(modified ? { modifiers: ['ControlOrMeta'] } : {}); }
    catch (error) {
      if ((tab.closed || tab.page.isClosed?.()) && tab.parent && !tab.parent.page.isClosed()
        && /target.*closed/i.test(error.message)) result = { closed: true, opener: tab.opener };
      else throw error;
    } finally { if (modified) await tab.page.keyboard.up('ControlOrMeta').catch(() => {}); }
    if (result?.closed !== true && !tab.closed && !tab.page.isClosed?.() && (prepared?.kind === 'link' || prepared?.kind === 'watch')) {
      // A plain click on a watched link or form often navigates, which destroys the arm with the document: that
      // is the click working, not a default that changed.
      const request = await tab.page.evaluate(token => window[Symbol.for('sleight.popup3')]?.takeRequest(token) ??
        (window[Symbol.for('sleight.popup3')] ? undefined : { unavailable: true, lost: true }), token)
        .catch(error => { if (prepared.kind === 'watch') return undefined; throw error; });
      if (request?.unavailable && !(prepared.kind === 'watch' && request.lost))
        throw Error('link default changed or was not captured; read the page before using the engine browser path');
      if (request?.blocked) throw Error(request.blocked === 'form'
        ? 'the page changed this form to submit into a new tab while it was being submitted; nothing was sent, read the page before retrying'
        : 'the page changed this link to open somewhere sleight cannot check; nothing was opened, read the page before retrying');
      if (request?.url) {
        if (typeof tab.openChild !== 'function') throw Error('background link opening needs the owned page registry');
        await tab.openChild(request.url, { target: request.target, rel: request.rel });
      }
    }
    await tab.settlePopups?.(checkpoint, { background: modified });
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
    // A window the page itself opened by that name (window.open) is reused like one this registry named.
    const namedPopup = async (opener, name) => {
      for (const notice of [...opener.popups].reverse()) {
        const child = notice.tab && records.get(notice.tab);
        if (!child || child.closed || child.released || child.releasing || child.page.isClosed()) continue;
        try { if (await deadline(() => child.page.evaluate(() => window.name), timeoutMs) === name) return child; } catch { /* Unreadable popup. */ }
      }
    };
    entry.openChild = (url, { target = '', rel = '' } = {}) => {
      // Never resolve a page-supplied name against arbitrary browser targets.
      // Only this registry's allocations can acquire or reuse a link name.
      const name = target && !target.startsWith('_') ? target : '';
      if (!name) return openOwned(url, entry);
      const opening = namedQueue.then(async () => {
        tab(entry.tab);
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('invalid browser URL');
        const candidate = namedChildren.get(name) ?? await namedPopup(entry, name);
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
    // Script-started openings the hook held since the last agent step (a count, never page text).
    entry.takeHeld = () => deadline(() => page.evaluate(() => window[Symbol.for('sleight.popup3')]?.take?.() ?? 0), timeoutMs);
    entry.popupCheckpoint = () => ({ windows: entry.windowOpenNo, popups: entry.popups.length,
      ...(entry.parent ? { opener: { tab: entry.parent.tab, windows: entry.parent.windowOpenNo, popups: entry.parent.popups.length } } : {}) });
    // Backstop for a popup the hook did not shape: a tab the page opened during a click that carried no background
    // modifier is probably in the foreground, because the browser opens it that way. CDP does not say which tab is
    // active, so sleight cannot put the previous one back; it tells the agent instead (takeForeground).
    entry.pageOpened = popup => { for (const row of records.values()) if (row.page === popup) return !row.openedBySleight; return true; };
    entry.foregroundPopups = 0;
    entry.takeForeground = () => { const count = entry.foregroundPopups; entry.foregroundPopups = 0; return count; };
    entry.settlePopups = async (before, { background = true } = {}) => {
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
      for (const { entry: source, before } of sources) for (const notice of source.popups.slice(before.popups)) {
        const child = records.get(notice.tab);
        if (child) await deadline(() => child.ready, timeoutMs).catch(() => {});
        if (child && !background && !child.openedBySleight) entry.foregroundPopups++;
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
        entry.openedBySleight = true;
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
