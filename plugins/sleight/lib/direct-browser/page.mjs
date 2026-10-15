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
    return returnValue.set.call(this, value);
  } });
  const cancelEvent = event => { const record = events.get(event); if (record && event.cancelable !== false) record.cancelled = true; };
  // A new window's first document runs no hook yet, and a function the page takes from it now stays native.
  // Cover it before the handle reaches the page.
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
  const open = function(url, target, features) {
    if (/^_(self|parent|top)$/i.test(String(target))) return nativeOpen.apply(this, arguments);
    if (!active() || !navigator.userActivation?.isActive) { held++; return null; }
    const kept = String(features ?? '').split(',').map(value => value.trim()).filter(value => /^(noopener|noreferrer)(?:=|$)/i.test(value));
    const opened = nativeOpen.call(this, url, target, kept.join(','));
    if (opened) { openedWindows.push(opened); coverInitialDocument(opened); }
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
  const baseTarget = () => {
    const base = query(document, 'base[target]');
    return base ? attribute(base, 'target') : '';
  };
  const targetOf = element => attribute(element, 'target') ?? baseTarget();
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
  const sameContext = (element, target = targetOf(element)) => {
    // The HTML spec checks `_blank` before names, so window.name = '_blank' cannot make it current.
    if (/^_blank$/i.test(target)) return false;
    if (!target || /^_(self|parent|top)$/i.test(target) || target === nameOf(window)) return true;
    // A window the page opened by name is not the current context: navigating it by link raises it.
    // Indexed WindowProxy children remain traversable across origins, while
    // names and documents are readable only where same-origin access permits.
    const seen = new Set(), pending = [window.top ?? window];
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
      for (const frame of queryAll(document, 'iframe[name],frame[name]'))
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
      if (node instanceof labelControl.constructor) node = labelControl.control.call(node) ?? node;
      if (nativeMatches.call(node, 'a[href],area[href]')) return !has(node, 'download') && !sameContext(node);
      for (const control of formControls) if (node instanceof control.constructor && /^(submit|image)$/.test(control.type.call(node))) {
        const form = control.form.call(node);
        return !!form && !sameContext(form, attribute(node, 'formtarget') ?? targetOf(form));
      }
    } catch { return node instanceof Element; /* Undecidable for an element: hold it. */ }
    return false;
  };
  const holdsForm = (form, submitter) => {
    try { return !sameContext(form, (submitter && has(submitter, 'formtarget') ? attribute(submitter, 'formtarget') : null) ?? targetOf(form)); }
    catch { return true; }
  };
  // Enter in this control submits a form into a new context (the form's, or a submit control's formtarget).
  const opensForm = node => {
    try {
      for (const control of formControls) if (node instanceof control.constructor) {
        const form = control.form.call(node);
        if (!form) return false;
        const targets = [targetOf(form), ...[...elementQueryAll.call(form, '[formtarget]')].map(button => attribute(button, 'formtarget'))];
        return targets.some(target => !sameContext(form, target));
      }
    } catch { return true; }
    return false;
  };
  // Script entry points that open a context without an agent click. Held outside agent dispatch.
  const hold = (constructor, name, holds) => {
    const native = constructor?.prototype?.[name];
    if (typeof native === 'function') replace(constructor.prototype, name, { configurable: true, writable: true, value() {
      if (active() || !holds.apply(this, arguments)) return native.apply(this, arguments);
      held++;
    } });
  };
  hold(globalThis.HTMLElement, 'click', function() { return holdsNewContext(this); });
  hold(globalThis.HTMLFormElement, 'submit', function() { return holdsForm(this); });
  hold(globalThis.HTMLFormElement, 'requestSubmit', function(submitter) { return holdsForm(this, submitter); });
  // The window-level guard below never sees a click dispatched on a detached element (html or svg), so
  // refuse it here instead of dispatching: a listener registered first could otherwise stop a cancel.
  if (typeof dispatch === 'function') replace(EventTarget.prototype, 'dispatchEvent', { configurable: true, writable: true, value(event) {
    try {
      if (!active() && this instanceof Element && !isConnected(this) && event && !event.isTrusted && eventType(event) === 'click') {
        const node = ancestors(this).find(candidate => nativeMatches.call(candidate, 'a[href],area[href],button,input,label'));
        if (node && holdsNewContext(node)) { held++; return false; }
      }
    } catch { /* Not an event or element: the native call reports it. */ }
    return dispatch.apply(this, arguments);
  } });
  // A page-opened window raised by focus() is a foreground tab; nothing here needs the page to take focus.
  const focusOwner = getOwn(window, 'focus') ? window : globalThis.Window?.prototype;
  if (focusOwner) replace(focusOwner, 'focus', { configurable: true, writable: true, value() {} });
  // A dispatched click (not a user's) on a connected link or submit control.
  const guard = event => {
    if (event.isTrusted || active()) return;
    for (const node of composedPath.call(event)) {
      let link = false;
      try { link = node instanceof Element && (nativeMatches.call(node, 'a[href],area[href]') || nativeMatches.call(node, 'button,input,label')); } catch { /* Not an element. */ }
      if (link) { if (holdsNewContext(node)) { held++; nativePrevent.call(event); } return; }
    }
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
  const pointerEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const capture = event => {
    if (!live() || arm.clicked || !matches(event)) return;
    if (active()) masked.set(event, arm.token);
    // Bind the mask during dispatch, while composedPath still identifies the
    // prepared element. A deferred handler may first read modifiers much later.
    if (event.type !== 'click') return;
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
  // Key-shield API (window[Symbol.for('sleight.popup3')]), for callers that send trusted input:
  //   guard(element, token, capMs, { keys }) seals what activating `element` touches and arms the shield for
  //     capMs; { keys: true } also vetoes keydown, keypress, keyup and submit events (the form's action, method,
  //     target, enctype, novalidate and default submitter are in the seal). Returns false if it cannot arm.
  //   verdict(token) returns the veto reason, or undefined if every guarded event matched the seal.
  //   finish(token) disarms and returns the veto reason, or true.
  const uncurry = Function.prototype.bind.bind(Function.prototype.call);
  const getter = (type, name) => {
    const get = Object.getOwnPropertyDescriptor(type?.prototype ?? {}, name)?.get;
    return get ? uncurry(get) : () => { throw Error('native ' + name + ' unavailable'); };
  };
  const textOf = getter(globalThis.Node, 'textContent'), localNameOf = getter(Element, 'localName'), connected = getter(globalThis.Node, 'isConnected');
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
  let serial = 0, shield;
  const ident = node => { if (!idsHas(ids, node)) idsSet(ids, node, ++serial); return idsGet(ids, node); };
  const hash = value => { let h = 2166136261; for (let i = 0; i < value.length; i++) h = imul(h ^ charCodeAt(value, i), 16777619); return h + ':' + value.length; };
  const attributes = ['role', 'aria-label', 'aria-disabled', 'disabled', 'value', 'alt', 'title', 'href', 'target', 'type', 'name', 'form', 'formaction', 'formtarget', 'for', 'usemap'];
  const formAttributes = ['action', 'method', 'target', 'enctype', 'novalidate'];
  const rowAttributes = ['type', 'autocomplete', 'name', 'id', 'aria-label', 'value', 'form'];
  const isElement = node => { try { localNameOf(node); return true; } catch { return false; } };
  // { form, type } for a form-associated button, input, textarea or select; a brand mismatch throws and falls to the next, so no instanceof.
  const controlOf = node => {
    for (let i = 0; i < controlGetters.length; i++) { try { return { form: controlGetters[i][0](node), type: controlGetters[i][1](node) }; } catch { /* Not this class. */ } }
    return null;
  };
  const hostOf = node => { try { return shadowHost(rootOf(node)); } catch { return null; } };
  const parentOf = node => parentElementOf(node) ?? hostOf(node);
  // A form's default submitter is its first submit button in tree order among the controls it owns (what Enter in a field presses).
  const submitterOf = form => {
    let nodes;
    try { nodes = queryDocAll(rootOf(form), 'button,input'); } catch { nodes = queryFragAll(rootOf(form), 'button,input'); }
    for (let i = 0; i < listLength(nodes); i++) {
      const control = controlOf(nodes[i]);
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
      parts += '\u0002' + localNameOf(node) + '\u0001' + textOf(node);
      for (let j = 0; j < rowAttributes.length; j++) parts += '\u0001' + (attr(node, rowAttributes[j]) ?? '');
    }
    return hash(parts);
  };
  // Everything the rules read to classify a control: words, type, form owner and that form's controls.
  const describe = (node, withSubmitter) => {
    const control = controlOf(node), form = control?.form;
    let row = ident(node) + '\u0001' + localNameOf(node) + '\u0001' + connected(node) + '\u0001' + hash(textOf(node)) + '\u0001' + (control ? control.type : '')
      + '\u0001' + (form ? ident(form) + '|' + formSignature(form, withSubmitter) : '');
    for (let i = 0; i < attributes.length; i++) row += '\u0001' + (attr(node, attributes[i]) ?? '');
    return row;
  };
  // HTML label activation: the first label at or above the element forwards to its control unless interactive content sits between.
  const forwardedOf = element => {
    let node = element;
    for (let depth = 0; node && depth < 100000; depth++, node = parentOf(node)) {
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
    for (let i = 0; i < at; i++) if (path[i] !== forwarded && isElement(path[i]) && matchesNode(path[i], interactive)) return true;
    return false;
  };
  const inspect = event => {
    const { element, anchor, forwarded, areas, keys, form, submitter } = shield;
    if (!connected(element)) return 'target left the page';
    // The browser's own click on a label's control is trusted too, and its path skips the label; an area's click skips the image.
    const path = pathOf(event), at = pathIndex(path, anchor);
    if (at < 0) {
      // Keyboard activation (keys) lands on the form's default submitter or submits the form itself.
      const elsewhere = !(forwarded && pathIndex(path, forwarded) >= 0) && !listHas(areas, path[0])
        && !(keys && (form && pathIndex(path, form) >= 0 || submitter && pathIndex(path, submitter) >= 0));
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
  const finish = token => {
    retired.add(token);
    if (arm?.token !== token) return true;
    clearTimeout(arm.timer); clearTimeout(arm.dispatchTimer);
    for (const { node, before, wrapper } of arm.handlers) if (wrapper !== before && node.onclick === wrapper) node.onclick = before;
    arm = undefined; return true;
  };
  const api = {
    // See the key-shield API above. Any throw here reaches the caller as a rejected call, which reads as "page changed".
    guard(element, token, capMs, { keys = false } = {}) {
      if (retired.has(token) || !Number.isFinite(capMs) || capMs <= 0 || !isElement(element) || !connected(element)) return false;
      const withKeys = keys === true, control = controlOf(element), form = withKeys ? control?.form ?? null : null;
      const forwarded = forwardedOf(element), areas = areasOf(element);
      shield = { token, element, anchor: anchorOf(element), forwarded, areas, keys: withKeys, form, submitter: form ? submitterOf(form) : null,
        signature: sealed(element, forwarded, areas, withKeys), until: now() + capMs };
      return true;
    },
    // Scroll the element into view without animation, so the pointer can be moved onto it (the click would scroll anyway).
    reveal(element) { scrollInto(element, { block: 'nearest', inline: 'nearest', behavior: 'instant' }); },
    // Resolves after the next frame (or 40 ms if frames are throttled) and one more task, so swaps scheduled by the
    // pointer's arrival (events, observers, timers, animation frames) land before the seal is taken.
    settle() {
      return new Promise(resolve => {
        let waiting = true;
        const next = () => { if (waiting) { waiting = false; nativeTimeout(resolve, 0); } };
        nativeFrame?.(next); nativeTimeout(next, 40);
      });
    },
    verdict(token) { return shield?.token === token ? shield.violation : undefined; },
    prepare(element, token, capMs, press) {
      if (retired.has(token)) return false;
      held = 0;
      if (arm) finish(arm.token);
      if (CR2_NESTED_DOCUMENT(document.activeElement)) throw Error('document focus is inside a frame');
      if (!(element instanceof Element) || !element.isConnected || !Number.isFinite(capMs) || capMs <= 0) return false;
      // The native getter inherits editability, including false islands inside
      // editors. Checking ancestors would discard that non-editable boundary.
      if (document.designMode === 'on' || element instanceof HTMLElement && editable.call(element)) return false;
      const chain = ancestors(element);
      for (const [index, node] of chain.entries()) {
        if (plainControl(node)) return false;
        // A label can forward activation to a submit control outside its tree.
        if (node instanceof labelControl.constructor && !chain.slice(0, index).some(child => nativeMatches.call(child, interactive))
          && submits(labelControl.control.call(node))) return false;
      }
      const linkElement = chain.find(node => ['a', 'area'].includes(node.localName) && has(node, 'href'));
      if (linkElement instanceof HTMLElement && editable.call(linkElement)) return false;
      if (linkElement && sameContext(linkElement)) return false;
      const link = linkState(linkElement);
      // Ctrl+Enter follows a link into a background tab but does not submit a form, and a plain Enter into a
      // new-context form would raise the tab. Elsewhere Ctrl+Enter would change the key's meaning.
      if (press && !link) return opensForm(element) ? { kind: 'form' } : false;
      arm = { element, token, until: now() + capMs, masking: false, modifiers: new Set(), link, linkElement, handlers: [] };
      arm.timer = setTimeout(() => finish(token), capMs);
      return link ? { kind: 'link' } : true;
    },
    takeRequest(token) {
      if (shield?.token === token && shield.violation) return { violation: shield.violation };
      if (!live() || arm.token !== token || !arm.request || arm.taken) return { unavailable: true };
      arm.taken = true;
      if (arm.request.cancelled) return;
      if (otherRealm()) return { unavailable: true };
      const current = linkState(arm.linkElement);
      if (!arm.element.isConnected || current?.signature !== arm.request.signature
        || arm.handlers.some(({ node, wrapper }) => node.onclick !== wrapper)) return { unavailable: true };
      return { url: arm.request.url, target: arm.request.target, rel: arm.request.rel };
    },
    // A blocked input reports why, so the caller never mistakes a cancelled click for a delivered one.
    finish(token) {
      const bad = shield?.token === token ? shield.violation : undefined;
      if (shield?.token === token) shield = undefined;
      finish(token); return bad ?? true;
    },
    cancel: cancelEvent,
    take() { const count = held; held = 0; return count; },
    off() {
      if (arm) finish(arm.token);
      remove.call(window, 'keydown', keyEvent, true);
      remove.call(window, 'keyup', keyEvent, true);
      for (const type of pointerEvents) remove.call(window, type, capture, true);
      remove.call(window, 'click', guard, true);
      for (let i = 0; i < guarded.length; i++) remove.call(window, guarded[i], guardEvent, true);
      shield = undefined;
      for (const restore of replacements.reverse()) restore();
      if (window[key] === api) delete window[key];
      return true;
    },
  };
  window[key] = api;
  return true;
}

const changedMidClick = 'page changed during the click; read again';

export async function backgroundClick(tab, locator, click = options => locator.click({ ...options, timeout: timeoutMs }), { timeoutMs = 1000, press = false } = {}) {
  const token = randomUUID();
  const disarm = () => tab.page.evaluate(token => window[Symbol.for('sleight.popup3')]?.finish(token), token);
  let cancelled;
  try {
    let prepared;
    try {
      prepared = await deadline(() => locator.evaluate((element, { token, capMs, press }) => {
        const hook = window[Symbol.for('sleight.popup3')];
        if (!hook) throw Error('background popup hook unavailable');
        const result = hook.prepare(element, token, capMs, press);
        hook.reveal(element);
        return result;
      }, { token, capMs: timeoutMs + 1000, press }, { timeout: timeoutMs }), timeoutMs);
    } catch { throw Error('background popup preparation failed; use the engine browser path'); }
    if (prepared?.kind === 'form') throw Error('Enter would submit this form into a new tab; click its submit button instead');
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
      await deadline(() => locator.evaluate(async (element, { token, capMs }) => {
        const hook = window[Symbol.for('sleight.popup3')];
        await hook.settle();
        if (!hook.guard(element, token, capMs)) throw Error('click guard unavailable');
        return true;
      }, { token, capMs: timeoutMs + 1000 }, { timeout: timeoutMs }), timeoutMs);
    } catch { throw Error(changedMidClick); }
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
      if (request?.violation) { cancelled = request.violation; return result; }
      if (request?.unavailable) throw Error('link default changed or was not captured; read the page before using the engine browser path');
      if (request?.url) {
        if (typeof tab.openChild !== 'function') throw Error('background link opening needs the owned page registry');
        await tab.openChild(request.url, { target: request.target, rel: request.rel });
      }
    }
    await tab.settlePopups?.(checkpoint);
    return result;
  } finally {
    const verdict = await disarm().catch(() => {});
    cancelled ??= typeof verdict === 'string' ? verdict : undefined;
    // The guard cancelled the input: say so instead of reporting a delivered click.
    if (cancelled) throw Error(changedMidClick);
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
