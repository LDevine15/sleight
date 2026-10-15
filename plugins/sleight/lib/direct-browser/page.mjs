// Background popup disposition for turbo v3, independently implemented for CR1.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { endpointURL, endpointTarget, endpointBlock, bindEndpointPage, assertEndpointRead } from './endpoint-guard.mjs';

function deadline(task, ms, message = 'background preparation timed out') {
  let timer;
  return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

// MAIN world, before page scripts. Every name stays inside this function so it
// can be serialized. The hook controls disposition, never grants authority.
//
// popupHook({ key, secret }): the controller picks a random property name and a random secret per page registry
// and writes both into the install source (secret as an array of byte values, built by hookSource), so a page can find neither before the hook runs. The api lives at
// window[key] as a frozen, non-configurable, non-writable, non-enumerable value, so a page cannot replace, delete or
// redefine it. A page can still list the property and call the methods, so every method takes a proof as its first
// argument: HMAC-SHA-256(secret, method + ':' + nonce) as 'nonce.tag', checked against the secret held in this
// closure, valid once, and good for that one method. A page that reads the proof off a call (Playwright hands its
// arguments through page-reachable code) can burn it, which fails that call closed, and can do nothing more with it.
// If the property already exists the install returns false and changes nothing (a page or a stale install got there
// first), and the controller must treat that document as having no hook.
export function popupHook(options) {
  const { key, secret } = options !== null && typeof options === 'object' ? options : {};
  if (typeof key !== 'string' || key.length === 0 || typeof secret !== 'object' || secret === null) return false;
  // Every global this hook reads after install is captured here, before page scripts, so a page that replaces or
  // deletes window.Element, window.Object, window.Set and the rest cannot change what the hook sees. These locals
  // shadow the page-visible names for everything below.
  const { Object, Function, Symbol, Math, Number, String, Error, Set, WeakMap, Promise, URL, JSON, Date, RegExp, Array,
    Element, WeakSet, HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLLabelElement, HTMLTextAreaElement,
    HTMLFormElement, Event, EventTarget, MouseEvent, KeyboardEvent, Node, Document, DocumentFragment, ShadowRoot, NodeList,
    Window, Uint8Array, Uint32Array, setTimeout, clearTimeout, navigator } = globalThis;
  const { defineProperty, getOwnPropertyDescriptor: getOwn, freeze } = Object, isFinite = Number.isFinite, stringify = JSON.stringify;
  const uncurry = Function.prototype.bind.bind(Function.prototype.call);
  const randomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto), nativeRandom = Math.random;
  // The secret arrives as an array of 16 to 64 byte values written into the install source (hookSource builds it), so
  // nothing here converts a string in the page. It is copied once, now, into a typed array nothing outside this closure
  // can reach; after install the hook never reads secret again, and never reads a length off a typed array (a page can
  // redefine %TypedArray%.prototype.length): every loop below runs to a count held in a local number.
  const secretLength = Array.isArray(secret) ? secret.length : 0;
  if (secretLength < 16 || secretLength > 64) return false;
  const secretBytes = new Uint8Array(64);
  for (let i = 0; i < secretLength; i++) {
    const value = secret[i];
    if (typeof value !== 'number' || !(value >= 0 && value <= 255) || value % 1 !== 0) return false;
    secretBytes[i] = value;
  }
  if (getOwn(window, key)) return false;
  // The source a window.open handle's first document runs to get this same hook (see installInto). It is built now, at
  // install, from the key and the secret bytes by string concatenation and String(number) only, and held in this
  // closure: nothing a page can redefine touches it afterwards, and the page never holds it. The key must be plain
  // identifier characters so it can stand inside quotes.
  const keyCharCode = uncurry(String.prototype.charCodeAt);
  for (let i = 0; i < key.length; i++) {
    const code = keyCharCode(key, i);
    if (!(code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95)) return false;
  }
  let secretText = '';
  for (let i = 0; i < secretLength; i++) secretText += (i === 0 ? '' : ',') + String(secretBytes[i]);
  const installSource = '(' + uncurry(Function.prototype.toString)(popupHook) + ')({"key":"' + key + '","secret":[' + secretText + ']})';
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
  const nativeQuery = globalThis.Document?.prototype.querySelector, nativeQueryAll = globalThis.Document?.prototype.querySelectorAll;
  const query = (root, selector) => (nativeQuery ?? root.querySelector).call(root, selector);
  const queryAll = (root, selector) => (nativeQueryAll ?? root.querySelectorAll).call(root, selector);
  const nameGetter = getOwn(window, 'name')?.get, openerGetter = getOwn(window, 'opener')?.get, framesGetter = getOwn(window, 'frames')?.get;
  const nameOf = context => nameGetter ? nameGetter.call(context) : context.name;
  const framesOf = context => framesGetter ? framesGetter.call(context) : context.frames;
  const editable = getOwn(HTMLElement.prototype, 'isContentEditable').get;
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
    constructor, form: getOwn(constructor.prototype, 'form').get,
    type: getOwn(constructor.prototype, 'type').get,
  }));
  const selectControl = { constructor: HTMLSelectElement,
    multiple: getOwn(HTMLSelectElement.prototype, 'multiple').get };
  const labelControl = { constructor: HTMLLabelElement,
    control: getOwn(HTMLLabelElement.prototype, 'control').get };
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
  const designModeGetter = getOwn(globalThis.Document?.prototype ?? {}, 'designMode')?.get;
  const inDesignMode = () => { try { return (designModeGetter ? designModeGetter.call(document) : document.designMode) === 'on'; } catch { return false; } };
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
  const retired = new Set(), replacements = [], events = new WeakMap(), masked = new WeakMap();
  const nativeOpen = window.open, nativePrevent = Event.prototype.preventDefault;
  const composedPath = Event.prototype.composedPath, now = Date.now;
  const prevented = getOwn(Event.prototype, 'defaultPrevented');
  const returnValue = getOwn(Event.prototype, 'returnValue');
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const openedWindows = [];
  const dispatch = EventTarget.prototype.dispatchEvent, elementQueryAll = Element.prototype.querySelectorAll;
  const typeGetter = getOwn(Event.prototype, 'type')?.get, connectedGetter = getOwn(globalThis.Node?.prototype ?? {}, 'isConnected')?.get;
  const eventType = event => typeGetter ? typeGetter.call(event) : event.type;
  const isConnected = node => connectedGetter ? connectedGetter.call(node) : node.isConnected;
  // Script-started openings held since the last agent step, so the result can say so.
  let held = 0, arm;
  const replace = (object, name, descriptor) => {
    const before = getOwn(object, name);
    defineProperty(object, name, descriptor);
    replacements.push(() => {
      const current = getOwn(object, name);
      if (current?.value !== descriptor.value || current?.get !== descriptor.get || current?.set !== descriptor.set) return;
      if (before) defineProperty(object, name, before);
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
  // Read before the masking getters below replace ctrlKey and metaKey. A script-made click picks its disposition (a new
  // window with Shift, a background tab with Ctrl or Meta or the middle button, a download with Alt) from the event itself.
  const mouseGetter = name => getOwn(MouseEvent.prototype, name)?.get;
  const mouseGetters = ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'].map(name => [name, mouseGetter(name)]), buttonGetter = mouseGetter('button');
  const cancelableGetter = getOwn(Event.prototype, 'cancelable')?.get;
  const modifiedClick = event => {
    try {
      if (eventType(event) === 'auxclick') return true;
      for (let i = 0; i < mouseGetters.length; i++) if ((mouseGetters[i][1] ? mouseGetters[i][1].call(event) : event[mouseGetters[i][0]]) === true) return true;
      const button = buttonGetter ? buttonGetter.call(event) : event.button;
      return typeof button === 'number' && button !== 0;
    } catch { return false; /* Not a mouse event: the browser reads no modifier from it. */ }
  };
  const isCancelable = event => { try { return (cancelableGetter ? cancelableGetter.call(event) : event.cancelable) !== false; } catch { return true; } };
  for (const name of ['ctrlKey', 'metaKey']) {
    const descriptor = getOwn(MouseEvent.prototype, name);
    replace(MouseEvent.prototype, name, { ...descriptor, get() { return hide(this) ? false : descriptor.get.call(this); } });
  }
  const modifierState = MouseEvent.prototype.getModifierState;
  replace(MouseEvent.prototype, 'getModifierState', { configurable: true, writable: true, value(name) {
    return (name === 'Control' || name === 'Meta') && hide(this) ? false : modifierState.call(this, name);
  } });
  // Enter pressed with the modifier held (a keyboard-started link or form) hides it the same way.
  if (globalThis.KeyboardEvent) {
    for (const name of ['ctrlKey', 'metaKey']) {
      const descriptor = getOwn(KeyboardEvent.prototype, name);
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
      defineProperty(prototype, 'preventDefault', { configurable: true, writable: true, value() {
        const result = original.apply(this, arguments);
        cancelEvent(this);
        return result;
      } });
    } catch { /* Cross-origin: nothing readable to cancel with. */ }
  };
  // The install source carries the key and the secret, so it goes to a window's eval once, and only for a window not
  // already hooked. A window offered it before (the page got another handle to it by name) is never offered it again:
  // by then page scripts may have replaced its eval, which would read the secret.
  const offered = new WeakSet(), wasOffered = uncurry(WeakSet.prototype.has), offer = uncurry(WeakSet.prototype.add);
  const installInto = opened => {
    if (hooked(opened)) return;
    let fresh = false;
    try { fresh = !wasOffered(offered, opened); if (fresh) offer(offered, opened); } catch { /* Not an object a set can hold. */ }
    if (fresh) try { opened.eval(installSource); } catch { /* Cross-origin, or a policy that forbids eval. */ }
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
  // A frame element's name attribute names its window only while the window still carries that name: script can rename the
  // window (frame.contentWindow.name = 'x') without touching the attribute, and then a link to the old name opens a new
  // window. An unreadable (cross-origin) frame keeps the name the attribute gave it.
  const frameWindowGetters = [globalThis.HTMLIFrameElement, globalThis.HTMLFrameElement].map(type => getOwn(type?.prototype ?? {}, 'contentWindow')?.get).filter(Boolean);
  const namesFrame = (frame, target) => {
    try {
      for (let i = 0; i < frameWindowGetters.length; i++) {
        let child;
        try { child = frameWindowGetters[i].call(frame); } catch { continue; /* Not this class of frame. */ }
        if (child && readable(child)) return nameOf(child) === target;
        break;
      }
    } catch { /* Cross-origin: the attribute stands. */ }
    return true;
  };
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
          if (attribute(frame, 'name') === target && namesFrame(frame, target)) return true;
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
        if (attribute(frame, 'name') === target && namesFrame(frame, target)) return true;
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
  const forward = event => { for (const context of realms()) try { context[key]?.cancel(proofFor('cancel'), event); } catch { /* Not a hook. */ } };
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
  // A modified or non-primary synthetic click (Shift, Ctrl, Meta, Alt, the middle button, auxclick) on a link, an image-map
  // area or a submit control: the browser opens it in a new window or tab, or downloads it, whatever the link's own target says.
  const activates = node => {
    try {
      node = labelTarget(node);
      if (nativeMatches.call(node, 'a[href],area[href]')) return true;
      return !!submission(node, false);
    } catch { return isElement(node); /* Undecidable for an element: hold it. */ }
  };
  const activatesChain = node => {
    for (const candidate of ancestors(node)) {
      let hit = false;
      try { hit = nativeMatches.call(candidate, 'a[href],area[href],button,input,label'); } catch { /* Not an element. */ }
      if (hit) return activates(candidate);
    }
    return false;
  };
  // A script-started click or submit the hook let through because it looked like it stays in this context (outside an agent
  // click). A listener can still change where it goes before the browser acts, and no microtask runs in between, so the
  // setters a page uses to do that (window.name, target, formtarget, setAttribute) check again at once and cancel the event
  // that is still being dispatched. { node } for a link, { form, submitter } for a submit; events fills in as they are seen.
  let scripted;
  const pushEvent = uncurry(Array.prototype.push);
  const flipped = () => {
    const current = scripted;
    if (!current || current.cancelled || active()) return;
    try {
      if (!current.events.length || !(current.form ? holdsForm(current.form, current.submitter) : holdsNewContext(current.node))) return;
      // Only an event that can be cancelled can be stopped; the backstop reports a tab that opens anyway.
      let stopped = false;
      for (let i = 0; i < current.events.length; i++) if (isCancelable(current.events[i])) { nativePrevent.call(current.events[i]); stopped = true; }
      if (stopped) { current.cancelled = true; held++; }
    } catch { /* Undecided: the backstop reports a tab that opened. */ }
  };
  const trackable = node => {
    for (const candidate of ancestors(node)) {
      let hit = false;
      try { hit = nativeMatches.call(candidate, 'a[href],area[href],button,input,label'); } catch { /* Not an element. */ }
      if (!hit) continue;
      const target = labelTarget(candidate);
      if (nativeMatches.call(target, 'a[href],area[href]')) return { node: target };
      const found = submission(target, false);
      return found ? { form: found.form, submitter: found.submitter } : undefined;
    }
  };
  // The setters of another window or frame that runs this hook can re-aim this window's link too (Element.prototype.setAttribute
  // taken from an iframe's realm). While a script click is in flight here, every other hook is told, and tells this one when it sees such a change.
  let outer = false;
  const tellRealms = (method, argument) => {
    try { for (const context of realms()) try { context[key]?.[method](proofFor(method), argument); } catch { /* Not a hook. */ } } catch { /* No other windows. */ }
  };
  const scriptStarted = (tracked, events, run) => {
    if (!tracked || active()) return run();
    const before = scripted;
    scripted = { ...tracked, events };
    tellRealms('watching', true);
    try { return run(); } finally { scripted = before; tellRealms('watching', false); }
  };
  const flip = () => { if (scripted) flipped(); else if (outer) tellRealms('changed'); };
  const trackNode = node => { try { return trackable(node); } catch { return undefined; } };
  // Script entry points that open a context without an agent click. Held outside agent dispatch.
  const hold = (constructor, name, holds, track) => {
    const native = constructor?.prototype?.[name];
    if (typeof native === 'function') replace(constructor.prototype, name, { configurable: true, writable: true, value() {
      if (active() || !holds.apply(this, arguments)) return scriptStarted(track?.apply(this, arguments), [], () => native.apply(this, arguments));
      held++;
    } });
  };
  hold(globalThis.HTMLElement, 'click', function() { return holdsChain(this); }, function() { return trackNode(this); });
  hold(globalThis.HTMLFormElement, 'submit', function() { return holdsForm(this); });
  hold(globalThis.HTMLFormElement, 'requestSubmit', function(submitter) { return holdsForm(this, submitter); }, function(submitter) { return { form: this, submitter }; });
  // The window-level guard below never sees a click dispatched on a detached element, or one inside a shadow
  // tree (a closed root hides its inside from composedPath). Refuse those here instead of dispatching: a
  // listener registered first could otherwise stop a cancel. A click that cannot be cancelled is held here too: the
  // guard's preventDefault would do nothing to it. A modified or auxiliary click on a link or submit control is held
  // wherever it is, even inside an agent click's own handler. Realm-independent: brand checks, no instanceof.
  if (typeof dispatch === 'function') replace(EventTarget.prototype, 'dispatchEvent', { configurable: true, writable: true, value(event) {
    let tracked;
    try {
      if (event && !event.isTrusted && isElement(this)) {
        const type = eventType(event);
        if (type === 'click' || type === 'auxclick') {
          if (modifiedClick(event) ? activatesChain(this)
            : !active() && type === 'click' && (!inDocument(this) || !isCancelable(event)) && holdsChain(this)) { held++; return false; }
          if (!active() && type === 'click') tracked = trackNode(this);
        }
      }
    } catch { /* Not an event or element: the native call reports it. */ }
    return tracked ? scriptStarted(tracked, [event], () => dispatch.apply(this, arguments)) : dispatch.apply(this, arguments);
  } });
  // The setters a page uses to change where a link or form goes. After each, a script-started click or submit that is still
  // being dispatched is checked again (flipped); the agent's own click is watched by the observer and the name setter below.
  for (const [constructor, name] of [[globalThis.HTMLAnchorElement, 'target'], [globalThis.HTMLAreaElement, 'target'], [globalThis.HTMLFormElement, 'target'],
    [globalThis.HTMLBaseElement, 'target'], [globalThis.HTMLButtonElement, 'formTarget'], [globalThis.HTMLInputElement, 'formTarget'], [globalThis.Attr, 'value']]) {
    const descriptor = getOwn(constructor?.prototype ?? {}, name);
    if (descriptor?.set && descriptor.configurable) replace(constructor.prototype, name, { ...descriptor, set(value) {
      const result = descriptor.set.call(this, value);
      flip();
      return result;
    } });
  }
  for (const [owner, name] of [[Element.prototype, 'setAttribute'], [Element.prototype, 'removeAttribute'], [Element.prototype, 'toggleAttribute'],
    [Element.prototype, 'setAttributeNS'], [Element.prototype, 'setAttributeNode'], [Element.prototype, 'setAttributeNodeNS'],
    [globalThis.NamedNodeMap?.prototype, 'setNamedItem'], [globalThis.NamedNodeMap?.prototype, 'setNamedItemNS'],
    [globalThis.NamedNodeMap?.prototype, 'removeNamedItem'], [globalThis.NamedNodeMap?.prototype, 'removeNamedItemNS']]) {
    const native = owner?.[name];
    if (typeof native === 'function') replace(owner, name, { configurable: true, writable: true, value() {
      const result = native.apply(this, arguments);
      flip();
      return result;
    } });
  }
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
    if (event.isTrusted) return;
    if (scripted) pushEvent(scripted.events, event);
    const modified = modifiedClick(event);
    if (!modified && active()) return;
    for (const node of composedPath.call(event)) {
      let hit = false;
      try { hit = isElement(node) && nativeMatches.call(node, 'a[href],area[href],button,input,label'); } catch { /* Not an element. */ }
      if (hit) { if (modified ? activates(node) : holdsNewContext(node)) { held++; nativePrevent.call(event); } return; }
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
    return { url: url.href, target, rel, signature: stringify([url.href, target, rel]) };
  };
  const pointerEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  // A link that would open a new context, whether or not sleight can decide where.
  const opensLink = element => isLinkTag(element) && has(element, 'href') && !has(element, 'download') && !sameContext(element);
  // Cancel the browser's own open and keep the request for the background tab. Inline handlers that return false
  // are read at dispatch, after pointer handlers may have changed them; a browser cancels internally when one
  // does, so observe that return without calling the handler a second time.
  const engage = (event, link) => {
    const record = { ...link, cancelled: prevented.get.call(event), event };
    events.set(event, record); arm.request = record;
    nativePrevent.call(event);
    // Every node on the event's path, so an inline handler on a descendant of the checked element (a span inside the
    // link) counts too, beside the checked element's own ancestors, the document and the window.
    const seen = new Set();
    let path = [];
    try { path = composedPath.call(event); } catch { /* Not dispatching. */ }
    for (const node of [...path, ...ancestors(arm.element), document, window]) {
      if (!node || typeof node !== 'object' && typeof node !== 'function' || seen.has(node)) continue;
      seen.add(node);
      let before;
      try { before = node.onclick; } catch { continue; }
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
    // Bind the mask during dispatch, while composedPath still identifies the prepared element. A deferred
    // handler may first read modifiers much later. Only the click starts the dispatch window.
    if (eventType(event) !== 'click') return;
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
    if (scripted?.form) try {
      const path = composedPath.call(event);
      for (let i = 0; i < path.length; i++) if (path[i] === scripted.form) { pushEvent(scripted.events, event); break; }
    } catch { /* Not an event. */ }
    if (!live() || arm.watch?.kind !== 'form' || arm.done) return;
    try { if (composedPath.call(event).includes(arm.watch.form)) { arm.submit = event; recheck(); } } catch { /* Not an event. */ }
  };
  // A change that can re-aim a link or form: what the agent's click is watching, and a script click still in flight.
  const changed = () => { recheck(); flipped(); };
  // window.name decides which window a named target means, and a name has no attribute for the observer to see. Setting it
  // (in this window or a frame or window the page reached that runs this hook) checks again at once, in every hook that can
  // reach this one, because a listener can rename a window while the browser is still about to follow the link.
  const nameDescriptor = getOwn(window, 'name');
  if (nameDescriptor?.set && nameDescriptor.configurable) replace(window, 'name', { ...nameDescriptor, set(value) {
    const result = nameDescriptor.set.call(this, value);
    changed();
    tellRealms('changed');
    return result;
  } });
  const watchChanges = () => {
    if (!NativeObserver) return;
    // Attributes anywhere (a link, a form, its submit control) and nodes added or removed (a <base>): any change
    // makes the watch decide again, in the microtask after the listener that made it.
    arm.observer = new NativeObserver(changed);
    nativeObserve.call(arm.observer, document, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['target', 'href', 'rel', 'download', 'formtarget', 'form', 'name'] });
  };
  // AD1 dispatch guard. The click that lands must be the click that was classified. backgroundClick seals
  // what the checked element activates (itself, its label's control, its image map's areas) once hover has
  // settled; every trusted press, release and click is then cancelled if that changed or landed elsewhere.
  // Natives are captured here, before page scripts, and registered first so no page listener runs earlier.
  //
  // The check fails closed. It calls only natives captured here, uncurried so no page-visible lookup happens
  // (no Function.prototype.call, Array, String, RegExp or Math method, no Symbol.hasInstance, no own property
  // on an element or event). Classes are told apart by a native getter's brand check, not by instanceof, and
  // no page value ever builds a selector. If anything in the check throws, the input is cancelled.
  //
  // Key-shield API (window[key], the key the controller passed to popupHook), for callers that send trusted input.
  // Every method takes a proof from hookProof(hook, method) as its first argument, one proof per call; the rest follow:
  //   guard(proof, element, token, capMs, { keys, press }) seals what activating `element` touches and arms the shield for
  //     capMs; { keys: true } also vetoes keydown, keypress, keyup and submit events (the form's action, method,
  //     target, enctype, novalidate and default submitter are in the seal). { press: true } lets the click the browser makes on the
  //     form's default button, or the form's submit, count as landing on `element` without checking key events. Returns false if it cannot arm.
  //   verdict(proof, token) returns the veto reason, or undefined if every guarded event matched the seal.
  //   finish(proof, token) disarms and returns the veto reason, or true.
  //   changed(proof) and watching(proof, on) are the hook's calls to the hooks of other windows and frames it can reach (a
  //     window.name or attribute change in one can re-aim a link another is watching); they return nothing.
  const getter = (type, name) => {
    const get = getOwn(type?.prototype ?? {}, name)?.get;
    return get ? uncurry(get) : () => { throw Error('native ' + name + ' unavailable'); };
  };
  const textOf = getter(globalThis.Node, 'textContent'), shieldNameOf = getter(Element, 'localName'), connected = getter(globalThis.Node, 'isConnected');
  const parentElementOf = getter(globalThis.Node, 'parentElement'), listLength = getter(globalThis.NodeList, 'length'), typeOf = getter(Event, 'type');
  const shadowMode = getter(globalThis.ShadowRoot, 'mode'), shadowHost = getter(globalThis.ShadowRoot, 'host');
  const labelOf = getter(HTMLLabelElement, 'control');
  const controlGetters = [HTMLButtonElement, HTMLInputElement, globalThis.HTMLTextAreaElement, HTMLSelectElement].map(type => [getter(type, 'form'), getter(type, 'type')]);
  const rootOf = uncurry(globalThis.Node?.prototype.getRootNode), queryElementAll = uncurry(Element.prototype.querySelectorAll);
  const queryDocAll = uncurry(globalThis.Document?.prototype.querySelectorAll), queryFragAll = uncurry(globalThis.DocumentFragment?.prototype.querySelectorAll);
  const attr = uncurry(getAttribute), matchesNode = uncurry(nativeMatches), slice = uncurry(String.prototype.slice), charCodeAt = uncurry(String.prototype.charCodeAt);
  const stopNow = uncurry(Event.prototype.stopImmediatePropagation), cancel = uncurry(nativePrevent), pathOf = uncurry(composedPath);
  const scrollInto = uncurry(Element.prototype.scrollIntoView), nativeTimeout = setTimeout, nativeFrame = window.requestAnimationFrame?.bind(window);
  const imul = Math.imul, ids = new WeakMap(), idsHas = uncurry(WeakMap.prototype.has), idsGet = uncurry(WeakMap.prototype.get), idsSet = uncurry(WeakMap.prototype.set);
  // Proofs. SHA-256 and HMAC written with typed arrays and operators only: a page cannot reach any step of them.
  // The constants come from the cube roots of the first 64 primes, the start state from the square roots of the first 8.
  const sha = (() => {
    const K = new Uint32Array(64), IV = new Uint32Array(8), floor = Math.floor, pow = Math.pow;
    for (let n = 2, found = 0; found < 64; n++) {
      let prime = true;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (!prime) continue;
      const fraction = (value) => (value - floor(value)) * 4294967296;
      K[found] = floor(fraction(pow(n, 1 / 3)));
      if (found < 8) IV[found] = floor(fraction(pow(n, 1 / 2)));
      found++;
    }
    const w = new Uint32Array(64), h = new Uint32Array(8);
    // bytes holds `length` message bytes (a typed array with room to spare); only the count passed in is used.
    return (bytes, length) => {
      const total = ((length + 9 + 63) >> 6) << 6, data = new Uint8Array(total);
      for (let i = 0; i < length; i++) data[i] = bytes[i];
      data[length] = 0x80;
      const bits = length * 8;
      data[total - 4] = bits >>> 24; data[total - 3] = bits >>> 16; data[total - 2] = bits >>> 8; data[total - 1] = bits;
      for (let i = 0; i < 8; i++) h[i] = IV[i];
      for (let offset = 0; offset < total; offset += 64) {
        for (let i = 0; i < 16; i++) w[i] = (data[offset + 4 * i] << 24) | (data[offset + 4 * i + 1] << 16) | (data[offset + 4 * i + 2] << 8) | data[offset + 4 * i + 3];
        for (let i = 16; i < 64; i++) {
          const x = w[i - 15], y = w[i - 2];
          w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], q = h[7];
        for (let i = 0; i < 64; i++) {
          const t1 = (q + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
          const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
          q = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += q;
      }
      const digest = new Uint8Array(32);
      for (let i = 0; i < 32; i++) digest[i] = h[i >> 2] >>> (24 - 8 * (i & 3));
      return digest;
    };
  })();
  const hexDigits = '0123456789abcdef';
  // HMAC-SHA-256 over the UTF-8 bytes of text (a lone surrogate becomes U+FFFD, as in Node), written with charCodeAt
  // (uncurried above), typed array writes and operators. Lengths come from the string (a primitive's length cannot be
  // redefined) and from counters; no typed array length is read.
  const hmacHex = text => {
    const count = text.length, inner = new Uint8Array(64 + 3 * count), outer = new Uint8Array(96);
    let used = 64;
    for (let i = 0; i < count; i++) {
      let unit = charCodeAt(text, i);
      if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < count) {
        const next = charCodeAt(text, i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { unit = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00); i++; }
      }
      if (unit >= 0xd800 && unit <= 0xdfff) unit = 0xfffd;
      if (unit < 0x80) inner[used++] = unit;
      else if (unit < 0x800) { inner[used++] = 0xc0 | (unit >> 6); inner[used++] = 0x80 | (unit & 63); }
      else if (unit < 0x10000) { inner[used++] = 0xe0 | (unit >> 12); inner[used++] = 0x80 | ((unit >> 6) & 63); inner[used++] = 0x80 | (unit & 63); }
      else { inner[used++] = 0xf0 | (unit >> 18); inner[used++] = 0x80 | ((unit >> 12) & 63); inner[used++] = 0x80 | ((unit >> 6) & 63); inner[used++] = 0x80 | (unit & 63); }
    }
    for (let i = 0; i < 64; i++) { const k = secretBytes[i]; inner[i] = k ^ 0x36; outer[i] = k ^ 0x5c; }
    const digest = sha(inner, used);
    for (let i = 0; i < 32; i++) outer[64 + i] = digest[i];
    const tag = sha(outer, 96);
    let hex = '';
    for (let i = 0; i < 32; i++) hex += hexDigits[tag[i] >> 4] + hexDigits[tag[i] & 15];
    return hex;
  };
  const indexOf = uncurry(String.prototype.indexOf), usedNonces = new Set(), setHas = uncurry(Set.prototype.has), setAdd = uncurry(Set.prototype.add);
  // A nonce only has to be unique among the proofs this realm has accepted; the tag is what cannot be forged.
  let instance = '';
  if (randomValues) { const bytes = new Uint8Array(12); randomValues(bytes); for (let i = 0; i < 12; i++) instance += hexDigits[bytes[i] >> 4] + hexDigits[bytes[i] & 15]; }
  else instance = String(nativeRandom()).slice(2, 14);
  let proofs = 0;
  const proofFor = method => { const nonce = instance + '-' + ++proofs; return nonce + '.' + hmacHex(method + ':' + nonce); };
  const verify = (method, proof) => {
    if (dead && method !== 'off') throw Error('background popup hook is off');
    const dot = typeof proof === 'string' ? indexOf(proof, '.') : -1;
    if (dot < 1 || proof.length > 256) throw Error('background popup hook refused the call');
    const nonce = slice(proof, 0, dot), expected = hmacHex(method + ':' + nonce), given = slice(proof, dot + 1);
    let difference = expected.length ^ given.length;
    for (let i = 0; i < expected.length && i < given.length; i++) difference |= charCodeAt(expected, i) ^ charCodeAt(given, i);
    if (difference !== 0 || setHas(usedNonces, nonce)) throw Error('background popup hook refused the call');
    setAdd(usedNonces, nonce);
    return nonce;
  };
  let dead = false;
  let serial = 0, shield;
  const ident = node => { if (!idsHas(ids, node)) idsSet(ids, node, ++serial); return idsGet(ids, node); };
  const hash = value => { let h = 2166136261; for (let i = 0; i < value.length; i++) h = imul(h ^ charCodeAt(value, i), 16777619); return h + ':' + value.length; };
  const attributes = ['role', 'aria-label', 'aria-disabled', 'disabled', 'value', 'alt', 'title', 'href', 'target', 'type', 'name', 'form', 'formaction', 'formtarget', 'for', 'usemap'];
  const formAttributes = ['action', 'method', 'target', 'enctype', 'novalidate'];
  const rowAttributes = ['type', 'autocomplete', 'name', 'id', 'aria-label', 'value', 'form'];
  const shieldIsElement = node => { try { shieldNameOf(node); return true; } catch { return false; } };
  // { form, type } for a form-associated button, input, textarea or select; a brand mismatch throws and falls to the next, so no instanceof.
  const shieldControlOf = node => {
    for (let i = 0; i < controlGetters.length; i++) { try { return { form: controlGetters[i][0](node), type: controlGetters[i][1](node) }; } catch { /* Not this class. */ } }
    return null;
  };
  const hostOf = node => { try { return shadowHost(rootOf(node)); } catch { return null; } };
  const shieldParentOf = node => parentElementOf(node) ?? hostOf(node);
  // A form's default submitter is its first submit button in tree order among the controls it owns (what Enter in a field presses).
  const submitterOf = form => {
    let nodes;
    try { nodes = queryDocAll(rootOf(form), 'button,input'); } catch { nodes = queryFragAll(rootOf(form), 'button,input'); }
    for (let i = 0; i < listLength(nodes); i++) {
      const control = shieldControlOf(nodes[i]);
      if (control?.form === form && (control.type === 'submit' || control.type === 'image')) return nodes[i];
    }
    return null;
  };
  const formSignature = (form, withSubmitter) => {
    const submitter = withSubmitter ? submitterOf(form) : null;
    let parts = (submitter ? ident(submitter) : '') + '\u0002';
    for (let i = 0; i < formAttributes.length; i++) parts += (attr(form, formAttributes[i]) ?? '') + '\u0001';
    const nodes = queryElementAll(form, 'input,button,iframe,select,textarea');
    for (let i = 0; i < listLength(nodes); i++) {
      const node = nodes[i];
      parts += '\u0002' + shieldNameOf(node) + '\u0001' + textOf(node);
      for (let j = 0; j < rowAttributes.length; j++) parts += '\u0001' + (attr(node, rowAttributes[j]) ?? '');
    }
    return hash(parts);
  };
  // Everything the rules read to classify a control: words, type, form owner and that form's controls.
  const describe = (node, withSubmitter) => {
    const control = shieldControlOf(node), form = control?.form;
    let row = ident(node) + '\u0001' + shieldNameOf(node) + '\u0001' + connected(node) + '\u0001' + hash(textOf(node)) + '\u0001' + (control ? control.type : '')
      + '\u0001' + (form ? ident(form) + '|' + formSignature(form, withSubmitter) : '');
    for (let i = 0; i < attributes.length; i++) row += '\u0001' + (attr(node, attributes[i]) ?? '');
    return row;
  };
  // HTML label activation: the first label at or above the element forwards to its control unless interactive content sits between.
  const forwardedOf = element => {
    let node = element;
    for (let depth = 0; node && depth < 100000; depth++, node = shieldParentOf(node)) {
      let label = false, control;
      try { control = labelOf(node); label = true; } catch { /* Not a label. */ }
      if (label) return control;
      if (matchesNode(node, interactive)) return null;
    }
    return null;
  };
  // The image map's areas, as the static list the browser returns. The map name is page data, compared as a string.
  const areasOf = element => {
    let name = attr(element, 'usemap') ?? '';
    if (name.length > 0 && charCodeAt(name, 0) === 35) name = slice(name, 1);
    if (name.length === 0) return null;
    const maps = queryDocAll(document, 'map');
    for (let i = 0; i < listLength(maps); i++) if (attr(maps[i], 'name') === name) return queryElementAll(maps[i], 'area');
    return null;
  };
  const sealed = (element, forwarded, areas, withSubmitter) => {
    let value = describe(element, withSubmitter) + '\u0003' + (forwarded ? describe(forwarded, withSubmitter) : '');
    for (let i = 0; areas && i < listLength(areas); i++) value += '\u0003' + describe(areas[i], withSubmitter);
    return value;
  };
  const listHas = (list, node) => { for (let i = 0; list && i < listLength(list); i++) if (list[i] === node) return true; return false; };
  const pathIndex = (path, node) => { for (let i = 0; i < path.length; i++) if (path[i] === node) return i; return -1; };
  // composedPath() from window omits nodes inside a closed shadow root; the outermost closed host stands for them.
  const anchorOf = element => {
    let anchor = element;
    for (let node = element, depth = 0; node && depth < 100000; depth++) {
      const root = rootOf(node);
      let host;
      try { host = shadowHost(root); } catch { break; }
      node = host;
      if (shadowMode(root) === 'closed') anchor = node;
    }
    return anchor;
  };
  const pointerType = type => type === 'pointerdown' || type === 'mousedown' || type === 'pointerup' || type === 'mouseup' || type === 'click' || type === 'auxclick' || type === 'dblclick' || type === 'contextmenu';
  const keyType = type => type === 'keydown' || type === 'keypress' || type === 'keyup' || type === 'submit';
  const interactiveBetween = (path, at, forwarded) => {
    for (let i = 0; i < at; i++) if (path[i] !== forwarded && shieldIsElement(path[i]) && matchesNode(path[i], interactive)) return true;
    return false;
  };
  const inspect = event => {
    const { element, anchor, forwarded, areas, keys, activation, form, submitter } = shield;
    if (!connected(element)) return 'target left the page';
    // The browser's own click on a label's control is trusted too, and its path skips the label; an area's click skips the image.
    const path = pathOf(event), at = pathIndex(path, anchor);
    if (at < 0) {
      // Keyboard activation (keys, or a press the caller made: activation) lands on the form's default submitter or submits the form itself.
      const elsewhere = !(forwarded && pathIndex(path, forwarded) >= 0) && !listHas(areas, path[0])
        && !((keys || activation) && (form && pathIndex(path, form) >= 0 || submitter && pathIndex(path, submitter) >= 0));
      if (elsewhere) return 'the input landed on a different element';
    } else if (anchor === element && interactiveBetween(path, at, forwarded)) return 'the input landed on a different element';
    return sealed(element, forwardedOf(element), areasOf(element), keys) === shield.signature ? undefined : 'the checked element changed';
  };
  // Fail closed: if the check cannot run on this DOM, the input is cancelled.
  const guardEvent = event => {
    const current = shield;
    if (!current || !event.isTrusted || now() >= current.until) return;
    let bad;
    try {
      const type = typeOf(event);
      if (!(pointerType(type) || current.keys && keyType(type))) return;
      bad = current.violation ?? inspect(event);
    } catch { bad = 'the checked element changed'; }
    if (!bad) return;
    current.violation ??= bad;
    try { stopNow(event); } catch { /* The prevent below still cancels the default. */ }
    try { cancel(event); } catch { /* Nothing further can be done to this event. */ }
  };
  const guarded = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu', 'keydown', 'keypress', 'keyup', 'submit'];
  for (let i = 0; i < guarded.length; i++) add.call(window, guarded[i], guardEvent, true);
  add.call(window, 'keydown', keyEvent, true);
  add.call(window, 'keyup', keyEvent, true);
  for (const type of pointerEvents) add.call(window, type, capture, true);
  add.call(window, 'click', guard, true);
  add.call(window, 'auxclick', guard, true);
  add.call(window, 'submit', submitted, true);
  const finish = token => {
    retired.add(token);
    if (arm?.token !== token) return true;
    clearTimeout(arm.timer); clearTimeout(arm.dispatchTimer);
    if (arm.observer) try { nativeDisconnect.call(arm.observer); } catch { /* Already gone. */ }
    for (const { node, before, wrapper } of arm.handlers) if (wrapper !== before && node.onclick === wrapper) node.onclick = before;
    arm = undefined; return true;
  };
  const impl = {
    // See the key-shield API above. Any throw here reaches the caller as a rejected call, which reads as "page changed".
    guard(element, token, capMs, { keys = false, press = false } = {}) {
      if (retired.has(token) || !isFinite(capMs) || capMs <= 0 || !shieldIsElement(element) || !connected(element)) return false;
      const withKeys = keys === true, activation = press === true, control = shieldControlOf(element), form = withKeys || activation ? control?.form ?? null : null;
      const forwarded = forwardedOf(element), areas = areasOf(element);
      shield = { token, element, anchor: anchorOf(element), forwarded, areas, keys: withKeys, activation, form, submitter: form ? submitterOf(form) : null,
        signature: sealed(element, forwarded, areas, withKeys), until: now() + capMs };
      return true;
    },
    // Scroll the element into view without animation, so the pointer can be moved onto it (the click would scroll anyway).
    reveal(element) { scrollInto(element, { block: 'nearest', inline: 'nearest', behavior: 'instant' }); },
    // Resolves after the next frame (or 40 ms if frames are throttled) and one more task, so swaps scheduled by the
    // pointer's arrival (events, observers, timers, animation frames) land before the seal is taken.
    settle(done) {
      let waiting = true;
      const next = () => { if (waiting) { waiting = false; nativeTimeout(done, 0); } };
      nativeFrame?.(next); nativeTimeout(next, 40);
    },
    verdict(token) { return shield && shield.token === token ? shield.violation : undefined; },
    prepare(element, token, capMs, press) {
      if (retired.has(token)) return false;
      held = 0;
      if (arm) finish(arm.token);
      if (CR2_NESTED_DOCUMENT(document.activeElement)) throw Error('document focus is inside a frame');
      if (!isElement(element) || !isConnected(element) || !isFinite(capMs) || capMs <= 0) return false;
      // The native getter inherits editability and keeps a non-editable island inside an editor non-editable, so
      // only the element itself is asked, beside document.designMode (read through its captured getter).
      if (inDesignMode() || isEditable(element)) return false;
      const space = press === 'space';
      const chain = ancestors(element);
      let watch;
      for (const [index, node] of chain.entries()) {
        // A multiple select needs plain input to select.
        if (isMultiSelect(node)) return false;
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
        if (linkElement && isEditable(linkElement)) return false;
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
      // A flip the watch caught says what changed; the shield's veto, which the same flip also trips, says only that something did.
      if (live() && arm.token === token && !arm.taken && arm.blocked) { arm.taken = true; return { blocked: arm.blocked }; }
      if (shield?.token === token && shield.violation) return { violation: shield.violation };
      if (!live() || arm.token !== token || arm.taken) return { unavailable: true, lost: true };
      arm.taken = true;
      if (!arm.request) return arm.watch ? undefined : { unavailable: true };
      if (arm.request.cancelled) return;
      if (otherRealm()) return { unavailable: true };
      const current = linkState(arm.linkElement ?? arm.watch?.element);
      if (!arm.element.isConnected || current?.signature !== arm.request.signature
        || arm.handlers.some(({ node, wrapper }) => node.onclick !== wrapper)) return { unavailable: true };
      return { url: arm.request.url, target: arm.request.target, rel: arm.request.rel };
    },
    // A blocked input reports why, so the caller never mistakes a cancelled click for a delivered one.
    finish(token) {
      const bad = shield && shield.token === token ? shield.violation : undefined;
      if (shield && shield.token === token) shield = undefined;
      finish(token); return bad ?? true;
    },
    cancel(event) { cancelEvent(event); },
    // Another hook (a frame's, a window's) saw something that can re-aim a link or form this hook is watching.
    changed() { changed(); },
    watching(on) { outer = on === true; },
    take() { const count = held; held = 0; return count; },
    off() {
      dead = true;
      if (arm) finish(arm.token);
      remove.call(window, 'keydown', keyEvent, true);
      remove.call(window, 'keyup', keyEvent, true);
      for (const type of pointerEvents) remove.call(window, type, capture, true);
      remove.call(window, 'click', guard, true);
      remove.call(window, 'auxclick', guard, true);
      for (let i = 0; i < guarded.length; i++) remove.call(window, guarded[i], guardEvent, true);
      shield = undefined;
      remove.call(window, 'submit', submitted, true);
      for (const restore of replacements.reverse()) restore();
      return true;
    },
  };
  // What a caller gets back is signed too: 'nonce.tag.text', the tag an HMAC of method, the call's nonce and the text
  // under the secret, so a page that forges or replays a return value (Playwright carries returns through code the page
  // can replace) cannot pass for the hook. The text is built here from fixed shapes, never by JSON.stringify, which a
  // page can steer through Object.prototype.toJSON. hookOpen in the controller checks the tag and decodes the text.
  const NUL = String.fromCharCode(0);
  const sign = (method, nonce, text) => nonce + '.' + hmacHex(method + ':' + nonce + ':' + text) + '.' + text;
  const booleanText = value => value === true ? 't' : 'f';
  const preparedText = value => value === true ? 't' : value === false ? 'f' : value.kind === 'link' ? 'link' : value.kind === 'watch' ? 'watch'
    : value.kind === 'refuse' ? (value.reason === 'link' ? 'refuse-link' : 'refuse-form') : 'form';
  const requestText = value => {
    if (value === undefined) return 'u';
    if (getOwn(value, 'violation')) return 's' + value.violation;
    if (getOwn(value, 'blocked')) return value.blocked === 'form' ? 'bform' : 'blink';
    if (getOwn(value, 'unavailable')) return getOwn(value, 'lost') ? 'l' : 'n';
    return 'q' + value.url + NUL + value.target + NUL + value.rel;
  };
  const stringText = value => typeof value === 'string' ? 's' + value : value === undefined ? 'u' : 't';
  const seal = (method, proof, run, text) => { const nonce = verify(method, proof); return sign(method, nonce, text(run())); };
  const nothing = () => 'u';
  const api = {
    guard: (proof, element, token, capMs, options) => seal('guard', proof, () => impl.guard(element, token, capMs, options), booleanText),
    reveal: (proof, element) => seal('reveal', proof, () => impl.reveal(element), nothing),
    settle: proof => { const nonce = verify('settle', proof); return new Promise(resolve => impl.settle(() => resolve(sign('settle', nonce, 'u')))); },
    verdict: (proof, token) => seal('verdict', proof, () => impl.verdict(token), stringText),
    prepare: (proof, element, token, capMs, press) => seal('prepare', proof, () => impl.prepare(element, token, capMs, press), preparedText),
    takeRequest: (proof, token) => seal('takeRequest', proof, () => impl.takeRequest(token), requestText),
    finish: (proof, token) => seal('finish', proof, () => impl.finish(token), stringText),
    cancel: (proof, event) => { verify('cancel', proof); impl.cancel(event); },
    changed: proof => { verify('changed', proof); impl.changed(); },
    watching: (proof, on) => { verify('watching', proof); impl.watching(on); },
    take: (proof) => seal('take', proof, () => impl.take(), count => 'd' + count),
    off: proof => seal('off', proof, () => impl.off(), booleanText),
  };
  try { defineProperty(window, key, { value: freeze(api), configurable: false, writable: false, enumerable: false }); }
  catch { for (const restore of replacements.reverse()) restore(); return false; }
  return true;
}

// The controller's side of the hook's proof. hook is { key, secret } as popupHook received it (build the pair with
// newHook()). hookProof(hook, method) returns the first argument for one call of that method, for example
//   window[hook.key].guard(proof, element, token, capMs, { keys: true })
// Make a proof per call, never reuse one, and send it only to the method it names. The hook answers with a signed string;
// hookOpen(hook, answer) checks the signature, which proves the answer came from the hook for that very call and not from a
// page that replaced the evaluate machinery, and returns the decoded value (what the method returned before answers were
// signed): guard and off a boolean, reveal and settle undefined, verdict and finish a string or undefined or true, prepare
// false, true, { kind: 'link' }, { kind: 'watch' }, { kind: 'form' } or { kind: 'refuse', reason: 'link' | 'form' }, takeRequest undefined,
// { unavailable: true }, { unavailable: true, lost: true }, { blocked: 'link' | 'form' }, { violation } or { url, target, rel }, take a number. It throws an Error with code HOOK_ANSWER_REFUSED for anything it cannot vouch for.
export const newHook = () => Object.freeze({ key: 'k' + randomBytes(16).toString('hex'), secret: randomUUID() });
// The install expression for a hook: popupHook called with { key, secret } where secret is the secret's bytes as numeric
// literals (an array of 16 to 64 byte values). The page never holds a string it must convert, and an array or object
// literal runs no page code.
export function hookSource(hook) {
  if (typeof hook?.key !== 'string' || typeof hook?.secret !== 'string') throw Error('background popup hook unavailable');
  return `(${popupHook})(${JSON.stringify({ key: hook.key, secret: Array.from(Buffer.from(hook.secret, 'latin1')) })})`;
}
const issued = new WeakMap();
export function hookProof(hook, method) {
  if (typeof hook?.key !== 'string' || typeof hook?.secret !== 'string' || typeof method !== 'string') throw Error('background popup hook unavailable');
  const nonce = randomBytes(12).toString('hex');
  if (!issued.has(hook)) issued.set(hook, new Map());
  const calls = issued.get(hook);
  calls.set(nonce, method);
  if (calls.size > 4096) calls.delete(calls.keys().next().value);
  return nonce + '.' + createHmac('sha256', hook.secret).update(method + ':' + nonce).digest('hex');
}
export function hookOpen(hook, answer) {
  const refused = () => Object.assign(Error('background popup hook answer refused'), { code: 'HOOK_ANSWER_REFUSED' });
  const first = typeof answer === 'string' ? answer.indexOf('.') : -1, second = first < 0 ? -1 : answer.indexOf('.', first + 1);
  if (second < 0) throw refused();
  const nonce = answer.slice(0, first), tag = answer.slice(first + 1, second), text = answer.slice(second + 1);
  const method = issued.get(hook)?.get(nonce);
  if (method === undefined) throw refused();
  const expected = createHmac('sha256', hook.secret).update(method + ':' + nonce + ':' + text).digest('hex');
  if (tag.length !== expected.length || !timingSafeEqual(Buffer.from(tag), Buffer.from(expected))) throw refused();
  issued.get(hook).delete(nonce);
  if (text === 'u') return undefined;
  if (text === 't' || text === 'f') return text === 't';
  if (text === 'link' || text === 'form' || text === 'watch') return { kind: text };
  if (text === 'refuse-link' || text === 'refuse-form') return { kind: 'refuse', reason: text.slice(7) };
  if (text === 'n') return { unavailable: true };
  if (text === 'l') return { unavailable: true, lost: true };
  if (text === 'bform' || text === 'blink') return { blocked: text.slice(1) };
  if (/^d\d+$/.test(text)) return Number(text.slice(1));
  if (text[0] === 's') return method === 'takeRequest' ? { violation: text.slice(1) } : text.slice(1);
  if (text[0] === 'q') { const [url, target, rel, ...extra] = text.slice(1).split('\0'); if (extra.length || rel === undefined) throw refused(); return { url, target, rel }; }
  throw refused();
}
const hookOf = tab => {
  const hook = tab?.hook;
  if (typeof hook?.key !== 'string' || typeof hook?.secret !== 'string') throw Error('background popup hook unavailable');
  return hook;
};

const changedMidClick = 'page changed during the click; read again';
const hookUnavailable = 'background popup hook did not answer; use the engine browser path';
// A refused proof, an answer the controller cannot verify, a missing or switched-off hook: the page may be hostile or the
// hook gone, and reading the page again will not help, so the model is sent to the engine browser path.
const hookFailed = error => error?.code === 'HOOK_ANSWER_REFUSED'
  || /background popup hook (refused the call|unavailable|is off|answer refused)/.test(String(error?.message));

export async function backgroundClick(tab, locator, click = options => locator.click({ ...options, timeout: timeoutMs }), { timeoutMs = 1000, press = false } = {}) {
  const token = randomUUID(), hook = hookOf(tab), { key } = hook;
  // 'absent' stands for no hook in the document the click left behind; a page can fake it, which only fails the call.
  const disarm = async () => {
    const answer = await tab.page.evaluate(({ key, proof, token }) => window[key] ? window[key].finish(proof, token) : 'absent', { key, proof: hookProof(hook, 'finish'), token });
    return answer === 'absent' ? undefined : hookOpen(hook, answer);
  };
  let cancelled, failure, reported;
  try {
    let prepared;
    try {
      prepared = hookOpen(hook, await deadline(() => locator.evaluate((element, { key, prepare, reveal, token, capMs, press }) => {
        const hook = window[key];
        if (!hook) throw Error('background popup hook unavailable');
        const result = hook.prepare(prepare, element, token, capMs, press);
        hook.reveal(reveal, element);
        return result;
      }, { key, prepare: hookProof(hook, 'prepare'), reveal: hookProof(hook, 'reveal'), token, capMs: timeoutMs + 1000, press }, { timeout: timeoutMs }), timeoutMs));
    } catch { throw failure = Error('background popup preparation failed; use the engine browser path'); }
    if (prepared?.kind === 'refuse') throw Error(prepared.reason === 'link'
      ? 'Enter would open this link in a new tab, and sleight cannot check where it goes; click the link instead'
      : 'Enter would submit this form into a new tab; click its submit button instead');
    const modified = prepared === true || prepared?.kind === 'link';
    // Move the pointer onto the element first, so a swap the pointer's arrival triggers lands before the seal is
    // taken, then wait one frame in the page and seal what this click activates. The click callback classifies
    // after this; the hook cancels any input that no longer matches. An element with no box (an image-map area)
    // gets no move; the seal still covers it.
    if (typeof locator.boundingBox === 'function' && tab.page.mouse) {
      const box = await locator.boundingBox({ timeout: timeoutMs });
      if (box) await tab.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    }
    try {
      // Enter in a field makes the browser click the form's default button: for a press that click is the press working.
      const armed = await deadline(() => locator.evaluate(async (element, { key, settle, guard, token, capMs, press }) => {
        const hook = window[key];
        await hook.settle(settle);
        return hook.guard(guard, element, token, capMs, { press });
      }, { key, settle: hookProof(hook, 'settle'), guard: hookProof(hook, 'guard'), token, capMs: timeoutMs + 1000, press: !!press }, { timeout: timeoutMs }), timeoutMs);
      if (hookOpen(hook, armed) !== true) throw Error('click guard unavailable');
    } catch (error) { throw hookFailed(error) ? failure = Error(hookUnavailable) : Error(changedMidClick); }
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
      // is the click working, not a default that changed. Only the evaluate may fail that way; a refused or forged
      // answer still throws.
      let answer;
      try { answer = await tab.page.evaluate(({ key, proof, token }) => window[key] ? window[key].takeRequest(proof, token) : 'absent',
        { key, proof: hookProof(hook, 'takeRequest'), token }); }
      catch (error) { if (prepared.kind !== 'watch') throw error; }
      const request = answer === undefined ? undefined : answer === 'absent' ? { unavailable: true, lost: true } : hookOpen(hook, answer);
      if (request?.violation) { cancelled = request.violation; return result; }
      if (request?.unavailable && !(prepared.kind === 'watch' && request.lost))
        throw Error('link default changed or was not captured; read the page before using the engine browser path');
      if (request?.blocked) throw reported = Error(request.blocked === 'form'
        ? 'the page changed this form to submit into a new tab while it was being submitted; nothing was sent, read the page before retrying'
        : 'the page changed this link to open somewhere sleight cannot check; nothing was opened, read the page before retrying');
      if (request?.url) {
        if (typeof tab.openChild !== 'function') throw Error('background link opening needs the owned page registry');
        await tab.openChild(request.url, { target: request.target, rel: request.rel });
      }
    }
    await tab.settlePopups?.(checkpoint, { background: modified });
    return result;
  } catch (error) {
    if (failure || !hookFailed(error)) throw error;
    throw failure = Error(hookUnavailable);
  } finally {
    // A hook that cannot vouch for its own answer, or refused the call, may have vetoed the input: say so rather than
    // report a click delivered. A page that navigated away or closed just ends the evaluate, which is not a veto.
    let verdict;
    try { verdict = await disarm(); }
    catch (error) { if (error?.code === 'HOOK_ANSWER_REFUSED' || /background popup hook refused/.test(error?.message)) cancelled ??= 'the page hook did not answer'; }
    cancelled ??= typeof verdict === 'string' ? verdict : undefined;
    // The guard cancelled the input: say so instead of reporting a delivered click. An error already on its way out
    // that names the hook (refused proof, unavailable hook) or the change the page made (a flipped link or form) is clearer than
    // this and stays.
    if (cancelled && !failure && !reported) throw Error(changedMidClick);
  }
}

// browser is the Playwright connection through V1's CDP filter; session is the
// approved root CDP {send,on,off,sessionId}. Existing pages are never acquired.
export function createPageRegistry({ browser, session, context = browser?.contexts()[0], upstream, ownTarget, releaseTarget,
  endpoint, endpointBlocked, timeoutMs = 5000, popupWaitMs = 2000 } = {}) {
  if (!context || typeof session?.send !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('approved browser connection required');
  if (ownTarget !== undefined && (typeof ownTarget !== 'function' || typeof upstream?.send !== 'function'))
    throw Error('trusted popup admission needs the upstream CDP connection');
  const hook = newHook();
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
    const source = hookSource(entry.hook);
    const { identifier } = await entry.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
    if (!identifier) throw Error('background popup hook installation failed');
    entry.script = identifier;
    const result = await entry.cdp.send('Runtime.evaluate', { expression: source, returnByValue: true });
    if (result.exceptionDetails) throw Error('background popup hook installation failed');
    if (result.result?.value === true) return;
    // The install refused because the property is taken. That is fine when the occupant is this registry's own hook,
    // which a window.open handle's first document runs before the handle reaches the page; it must prove it by signing
    // an answer with the secret. Anything else (a stale or planted object) leaves the tab without a hook.
    const probe = await entry.cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { try { return window[${JSON.stringify(entry.hook.key)}].verdict(${JSON.stringify(hookProof(entry.hook, 'verdict'))}, '') } catch { return 'absent' } })()` });
    let genuine = false;
    try { genuine = !probe.exceptionDetails && typeof probe.result?.value === 'string' && probe.result.value !== 'absent' && hookOpen(entry.hook, probe.result.value) === undefined; } catch { /* Not the hook's answer. */ }
    if (!genuine) throw Error('background popup hook installation failed');
  };
  const removeHook = async entry => {
    if (entry.script) {
      await entry.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.script }); entry.script = null;
    }
    if (!entry.page.isClosed()) for (const frame of entry.page.frames()) {
      // One proof per frame: each document keeps its own record of the proofs it has accepted.
      const answer = await frame.evaluate(({ key, proof }) => window[key] ? window[key].off(proof) : 'absent', { key: entry.hook.key, proof: hookProof(entry.hook, 'off') });
      if (answer !== 'absent' && hookOpen(entry.hook, answer) !== true) throw Error('background popup hook would not switch off');
    }
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
      closed: page.isClosed(), released: false, queue: Promise.resolve(), openedBySleight: allocations.get(info.targetInfo.targetId)?.bySleight === true,
      canAccessOpener: info.targetInfo.canAccessOpener };
    entry.windowOpenNo = 0;
    // The hook's key and secret stay off enumeration, so a tab object that is logged or copied never carries them.
    Object.defineProperty(entry, 'hook', { value: hook, enumerable: false });
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
    entry.takeHeld = async () => {
      const answer = await deadline(() => page.evaluate(({ key, proof }) => window[key] ? window[key].take(proof) : 'absent', { key: hook.key, proof: hookProof(hook, 'take') }), timeoutMs);
      return answer === 'absent' ? 0 : hookOpen(hook, answer);
    };
    entry.popupCheckpoint = () => ({ windows: entry.windowOpenNo, popups: entry.popups.length,
      ...(entry.parent ? { opener: { tab: entry.parent.tab, windows: entry.parent.windowOpenNo, popups: entry.parent.popups.length } } : {}) });
    // Backstop for a popup the hook did not shape: a tab the page opened during a click that carried no background
    // modifier is probably in the foreground, because the browser opens it that way. CDP does not say which tab is
    // active, so sleight cannot put the previous one back; it tells the agent instead (takeForeground).
    entry.pageOpened = popup => { for (const row of records.values()) if (row.page === popup) return !row.openedBySleight; return true; };
    // True only for a popup sleight opened, or one a modified click's settling saw and classified as background.
    entry.popupIsBackground = popup => {
      for (const row of records.values()) if (row.page === popup) return row.openedBySleight || entry.popups.some(notice => notice.tab === row.tab && notice.background === true);
      return false;
    };
    entry.foregroundPopups = 0;
    // A tab the page opened that no click's settling has accounted for (a script that opens a tab after the click's
    // dispatch ended, so it carried no background modifier) is probably in the foreground too.
    entry.takeForeground = () => {
      let count = entry.foregroundPopups; entry.foregroundPopups = 0;
      for (const notice of entry.popups) {
        if (notice.counted || notice.blocked || !notice.tab) continue;
        notice.counted = true;
        const child = records.get(notice.tab);
        if (child && !child.openedBySleight) count++;
      }
      return count;
    };
    // Tabs this page opened that it can still raise to the foreground. A cross-origin window cannot be reached by any patch
    // in the page, the raise runs in the opener's process and the popup's own document sees nothing, and CDP reports no
    // active tab. Same-origin windows run the hook, which makes their focus() do nothing. A window opened with noopener, or
    // one that dropped its opener, gives the page no handle to call focus() on (canAccessOpener is false), so it is not listed.
    entry.raisablePopups = async () => {
      const found = [];
      let origin;
      try { origin = new URL(page.url()).origin; } catch { return found; }
      for (const notice of entry.popups) {
        const child = notice.tab && records.get(notice.tab);
        if (!child || child.openedBySleight || child.closed || child.released || child.releasing || child.page.isClosed()) continue;
        try {
          const url = child.page.url();
          if (url === 'about:blank' || new URL(url).origin === origin) continue;
        } catch { continue; /* No address yet. */ }
        let access = child.canAccessOpener;
        try { access = (await deadline(() => child.cdp.send('Target.getTargetInfo'), timeoutMs)).targetInfo?.canAccessOpener ?? access; } catch { /* Keep what adoption saw. */ }
        if (access !== false) found.push(child.tab);
      }
      return found;
    };
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
        notice.counted = true; if (background) notice.background = true;
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
        allocations.set(targetId, { bySleight: true });
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
