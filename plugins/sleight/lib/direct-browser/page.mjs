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
  // A hook already on this window may have lost its listeners (a document that reused the window); put them back.
  if (window[key]) { try { window[key].reattach?.(); } catch { /* A stale hook has no listeners to restore. */ } return true; }
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
  //   lock(token, capMs) vetoes every trusted key in a frame that does not hold the checked element.
  //   verdict(token) returns the veto reason, or undefined if every guarded event matched the seal.
  //   finish(token) disarms and returns the veto reason, or true.
  const uncurry = Function.prototype.bind.bind(Function.prototype.call);
  const getter = (type, name) => {
    const get = Object.getOwnPropertyDescriptor(type?.prototype ?? {}, name)?.get;
    return get ? uncurry(get) : () => { throw Error('native ' + name + ' unavailable'); };
  };
  const textOf = getter(globalThis.Node, 'textContent'), nameOf = getter(Element, 'localName'), connected = getter(globalThis.Node, 'isConnected');
  const parentElementOf = getter(globalThis.Node, 'parentElement'), listLength = getter(globalThis.NodeList, 'length'), typeOf = getter(Event, 'type');
  const shadowMode = getter(globalThis.ShadowRoot, 'mode'), shadowHost = getter(globalThis.ShadowRoot, 'host');
  const labelOf = getter(HTMLLabelElement, 'control');
  const controlGetters = [HTMLButtonElement, HTMLInputElement, globalThis.HTMLTextAreaElement, HTMLSelectElement].map(type => [getter(type, 'form'), getter(type, 'type')]);
  const rootOf = uncurry(globalThis.Node?.prototype.getRootNode), queryAll = uncurry(Element.prototype.querySelectorAll);
  const queryDocAll = uncurry(globalThis.Document?.prototype.querySelectorAll), queryFragAll = uncurry(globalThis.DocumentFragment?.prototype.querySelectorAll);
  const attr = uncurry(getAttribute), matchesNode = uncurry(nativeMatches), slice = uncurry(String.prototype.slice), charCodeAt = uncurry(String.prototype.charCodeAt);
  const stopNow = uncurry(Event.prototype.stopImmediatePropagation), cancel = uncurry(nativePrevent), pathOf = uncurry(composedPath);
  const scrollInto = uncurry(Element.prototype.scrollIntoView), nativeTimeout = setTimeout, nativeFrame = window.requestAnimationFrame?.bind(window);
  const imul = Math.imul, ids = new WeakMap(), idsHas = uncurry(WeakMap.prototype.has), idsGet = uncurry(WeakMap.prototype.get), idsSet = uncurry(WeakMap.prototype.set);
  let serial = 0, shield;
  const ident = node => { if (!idsHas(ids, node)) idsSet(ids, node, ++serial); return idsGet(ids, node); };
  const hash = value => { let h = 2166136261; for (let i = 0; i < value.length; i++) h = imul(h ^ charCodeAt(value, i), 16777619); return h + ':' + value.length; };
  const attributes = ['role', 'aria-label', 'aria-disabled', 'disabled', 'value', 'alt', 'title', 'href', 'target', 'type', 'name', 'form', 'formaction', 'formtarget', 'formmethod', 'formenctype', 'formnovalidate', 'for', 'usemap'];
  // After the first keydown the key seal keeps only what decides where activation goes: words, values and disabled state are
  // what a handler legitimately changes (a login button that disables itself, a chat box synced by a framework), so they drop out.
  const routingAttributes = ['href', 'target', 'type', 'form', 'formaction', 'formtarget', 'formmethod', 'formenctype', 'formnovalidate', 'for', 'usemap'];
  const formAttributes = ['action', 'method', 'target', 'enctype', 'novalidate'];
  const rowAttributes = ['type', 'autocomplete', 'name', 'id', 'aria-label', 'value', 'form', 'formaction', 'formtarget', 'formmethod', 'formenctype', 'formnovalidate'];
  const isElement = node => { try { nameOf(node); return true; } catch { return false; } };
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
    const nodes = queryAll(form, 'input,button,iframe,select,textarea');
    for (let i = 0; i < listLength(nodes); i++) {
      const node = nodes[i];
      parts += '\u0002' + nameOf(node) + '\u0001' + textOf(node);
      for (let j = 0; j < rowAttributes.length; j++) parts += '\u0001' + (attr(node, rowAttributes[j]) ?? '');
    }
    return hash(parts);
  };
  // Everything the rules read to classify a control: words, type, form owner and that form's controls.
  const describe = (node, withSubmitter) => {
    const control = controlOf(node), form = control?.form;
    let row = ident(node) + '\u0001' + nameOf(node) + '\u0001' + connected(node) + '\u0001' + hash(textOf(node)) + '\u0001' + (control ? control.type : '')
      + '\u0001' + (form ? ident(form) + '|' + formSignature(form, withSubmitter) : '');
    for (let i = 0; i < attributes.length; i++) row += '\u0001' + (attr(node, attributes[i]) ?? '');
    return row;
  };
  // The routing facts of a control: its identity, form owner, the form's action, method, target, enctype and default submitter
  // (with that submitter's own formaction and formtarget), and the attributes that point a link or button somewhere else.
  const routing = node => {
    const control = controlOf(node), form = control?.form;
    let row = ident(node) + '\u0001' + nameOf(node) + '\u0001' + connected(node) + '\u0001' + (control ? control.type : '');
    if (form) {
      const submitter = submitterOf(form);
      row += '\u0001' + ident(form) + '|' + (submitter ? ident(submitter) : '');
      for (let i = 0; i < formAttributes.length; i++) row += '\u0001' + (attr(form, formAttributes[i]) ?? '');
      for (let i = 0; submitter && i < routingAttributes.length; i++) row += '\u0001' + (attr(submitter, routingAttributes[i]) ?? '');
    }
    for (let i = 0; i < routingAttributes.length; i++) row += '\u0001' + (attr(node, routingAttributes[i]) ?? '');
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
    for (let i = 0; i < listLength(maps); i++) if (attr(maps[i], 'name') === name) return queryAll(maps[i], 'area');
    return null;
  };
  const sealed = (element, forwarded, areas, withSubmitter) => {
    let value = describe(element, withSubmitter) + '\u0003' + (forwarded ? describe(forwarded, withSubmitter) : '');
    for (let i = 0; areas && i < listLength(areas); i++) value += '\u0003' + describe(areas[i], withSubmitter);
    return value;
  };
  const routed = (element, forwarded, areas) => {
    let value = routing(element) + '\u0003' + (forwarded ? routing(forwarded) : '');
    for (let i = 0; areas && i < listLength(areas); i++) value += '\u0003' + routing(areas[i]);
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
  const keyOf = getter(globalThis.KeyboardEvent, 'key'), bodyOf = getter(globalThis.Document, 'body'), rootElementOf = getter(globalThis.Document, 'documentElement');
  const modifierKey = event => { const key = keyOf(event); return key === 'Control' || key === 'Shift' || key === 'Meta' || key === 'Alt' || key === 'AltGraph'; };
  // A locked frame lets no key through. A key release alone is reported separately: a page that navigates on the key leaves the
  // release to its new document, which is blocked there without anything having activated, so the caller may ignore it.
  const DENIED = 'the key landed in a frame that was not checked', RELEASED = 'the key was released in a document that was not checked';
  const DIFFERENT = 'the input landed on a different element';
  const inspect = event => {
    const { element, anchor, forwarded, areas, keys, form, submitter, deny } = shield;
    if (deny) return typeOf(event) === 'keyup' ? RELEASED : DENIED;
    if (!connected(element)) return 'target left the page';
    // The browser's own click on a label's control is trusted too, and its path skips the label; an area's click skips the image.
    const path = pathOf(event), at = pathIndex(path, anchor), type = typeOf(event);
    if (at < 0) {
      // Keyboard activation lands on the form's default submitter (click) or submits the form itself (submit).
      // A key event itself must land on the checked element, never merely somewhere inside its form.
      const resulting = keys && (type === 'submit' ? !!form && path[0] === form : type === 'click' && !!submitter && pathIndex(path, submitter) >= 0);
      const elsewhere = !(forwarded && pathIndex(path, forwarded) >= 0) && !listHas(areas, path[0]) && !resulting;
      if (elsewhere) return DIFFERENT;
    } else if (anchor === element && interactiveBetween(path, at, forwarded)) return DIFFERENT;
    // Until the activation key goes down the whole seal must match. From then on only the routing facts must: what a handler
    // changes about itself while it works (words, value, disabled) is not a change of where the key's effect goes.
    const next = keys && shield.down;
    return (next ? routed(element, forwardedOf(element), areasOf(element)) : sealed(element, forwardedOf(element), areasOf(element), keys))
      === (next ? shield.routing : shield.signature) ? undefined : 'the checked element changed';
  };
  // A key released on the empty page (the checked button disabled itself, so focus fell to body) is cancelled without a report:
  // nothing was released on anything that could act, and the earlier events passed the seal.
  const onEmptyPage = event => { const target = pathOf(event)[0]; return target === bodyOf(document) || target === rootElementOf(document); };
  // Fail closed: if the check cannot run on this DOM, the input is cancelled.
  const guardEvent = event => {
    const current = shield;
    if (!current || !event.isTrusted || now() >= current.until) return;
    let bad, quiet = false;
    try {
      const type = typeOf(event);
      if (!(pointerType(type) || current.keys && keyType(type))) return;
      bad = current.violation && current.violation !== RELEASED ? current.violation : inspect(event);
      if (bad === DIFFERENT && !current.violation && type === 'keyup' && current.down && onEmptyPage(event)) quiet = true;
      else if (!bad && current.keys && type === 'keydown' && !modifierKey(event)) current.down = true;
    } catch { bad = 'the checked element changed'; }
    if (!bad) return;
    if (!quiet && (!current.violation || current.violation === RELEASED && bad !== RELEASED)) current.violation = bad;
    try { stopNow(event); } catch { /* The prevent below still cancels the default. */ }
    try { cancel(event); } catch { /* Nothing further can be done to this event. */ }
  };
  const guarded = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu', 'keydown', 'keypress', 'keyup', 'submit'];
  // Two ways a window loses its listeners while the hook stays: document.open() (and write() or writeln() on a loaded document,
  // which open it first) erases them, and a script-created frame whose first navigation is same-origin reuses the window of its
  // initial empty document, so the start-of-document script ran once, on the empty document, and the commit left the listeners
  // registered but dead. Only removing and adding a listener again makes it fire in that window; adding one already registered
  // does nothing. The document the listeners were added for tells a reused window (a new document) from a settled one, whose
  // listeners must keep their place ahead of the page's.
  const lengthOf = uncurry(Object.getOwnPropertyDescriptor(window, 'length')?.get ?? (() => 0));
  let closed = false, attachedTo;
  const attach = () => {
    if (closed) return;
    for (let i = 0; i < guarded.length; i++) { remove.call(window, guarded[i], guardEvent, true); add.call(window, guarded[i], guardEvent, true); }
    remove.call(window, 'keydown', keyEvent, true); add.call(window, 'keydown', keyEvent, true);
    remove.call(window, 'keyup', keyEvent, true); add.call(window, 'keyup', keyEvent, true);
    remove.call(window, 'click', capture, true); add.call(window, 'click', capture, true);
    attachedTo = document;
  };
  const reattach = force => { if (force || attachedTo !== document) attach(); };
  attach();
  // A page could rewrite itself in a keydown handler and take the key unguarded, and the other frame's document may be the one opened.
  const reflectApply = Reflect.apply, viewOf = getter(globalThis.Document, 'defaultView'), readyOf = getter(globalThis.Document, 'readyState');
  for (const name of ['open', 'write', 'writeln']) {
    const native = globalThis.Document?.prototype?.[name];
    if (typeof native !== 'function') continue;
    replace(Document.prototype, name, { configurable: true, writable: true, value: function() {
      // write() on a document still being parsed appends to it; on a loaded one it opens it first, which erases the listeners.
      let opens = name === 'open';
      try { opens ||= readyOf(this) !== 'loading'; } catch { /* Not a document: the native call throws below. */ }
      const result = reflectApply(native, this, arguments);
      if (opens) {
        try {
          const view = viewOf(this);
          if (view === window) reattach(true); else view?.[key]?.reattach?.(true);
        } catch { /* A document without a window has no listeners to restore. */ }
      }
      return result;
    } });
  }
  // A page that registers a capture listener on a reused window before anything restores ours would run first, so a
  // registration on the window while a guard is armed restores ours before it is recorded.
  replace(EventTarget.prototype, 'addEventListener', { configurable: true, writable: true, value: function() {
    if (this === window && shield) reattach();
    return reflectApply(add, this, arguments);
  } });
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
        signature: sealed(element, forwarded, areas, withKeys), routing: withKeys ? routed(element, forwarded, areas) : undefined, down: false, until: now() + capMs };
      return true;
    },
    // Veto every trusted key in this frame until finish(token) or capMs: for a frame other than the one holding the checked
    // element, which a page script could move focus into. Registered at document start like guard(), so no page listener is earlier.
    lock(token, capMs) {
      if (retired.has(token) || !Number.isFinite(capMs) || capMs <= 0) return false;
      shield = { token, element: document.documentElement, keys: true, deny: true, until: now() + capMs };
      return true;
    },
    // After a key goes down: restore the listeners a reused window lost, and lock any document that is not the checked one (a frame
    // the key's handler created or navigated). The checked document keeps its seal while the checked element is still in it.
    resync(token, capMs) {
      if (retired.has(token) || !Number.isFinite(capMs) || capMs <= 0) return false;
      reattach();
      if (shield?.token === token && !shield.deny && connected(shield.element)) return true;
      shield = { token, element: document.documentElement, keys: true, deny: true, until: now() + capMs };
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
      if (shield?.token === token && shield.violation) return { violation: shield.violation };
      if (!live() || arm.token !== token || !arm.request || arm.taken) return { unavailable: true };
      arm.taken = true;
      if (arm.request.cancelled) return;
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
    // How many child frames this window has, in any process, from the native getter captured before page scripts (the page can
    // replace window.length). Playwright may not know a frame in another process yet.
    childFrames() { return lengthOf(window); },
    reattach,
    off() {
      closed = true;
      if (arm) finish(arm.token);
      remove.call(window, 'keydown', keyEvent, true);
      remove.call(window, 'keyup', keyEvent, true);
      remove.call(window, 'click', capture, true);
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

export async function backgroundClick(tab, locator, click = options => locator.click({ ...options, timeout: timeoutMs }), { timeoutMs = 1000 } = {}) {
  const token = randomUUID();
  const disarm = () => tab.page.evaluate(token => window[Symbol.for('sleight.popup3')]?.finish(token), token);
  let cancelled;
  try {
    let prepared;
    try {
      prepared = await deadline(() => locator.evaluate((element, { token, capMs }) => {
        const hook = window[Symbol.for('sleight.popup3')];
        if (!hook) throw Error('background popup hook unavailable');
        const result = hook.prepare(element, token, capMs);
        hook.reveal(element);
        return result;
      }, { token, capMs: timeoutMs + 1000 }, { timeout: timeoutMs }), timeoutMs);
    } catch { throw Error('background popup preparation failed; use the engine browser path'); }
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

const keyMessage = reason => reason + '. The key may have activated; read the page before deciding, and do not resend it';
const keyReleased = 'the key was released in a document that was not checked';

// Arms the key shield around a trusted Enter or Space (with Shift or Control in a text field) and then calls send({ between }).
// The hook is registered at document start, so no page listener runs before it, and the seal is taken before the key
// is sent: every keydown, keypress, keyup, click and submit is checked against the sealed element and its form (action,
// method, target, enctype, default submitter). Any other frame is locked, so a page script cannot move focus into it
// to take the key. A document that does not exist yet (a frame the key's handler inserts, re-points or navigates, a cross-site
// frame that starts in another process) is locked too: an init script that Playwright applies to every new document in every
// frame, before the page's own scripts, installs a deny lock that expires with the key. It is removed when the key is done.
// send() presses the key in two halves and calls between() after the key goes down and before it is released. A script-created
// frame that navigates to a same-origin address reuses the window of its initial empty document, and the commit erases the
// listeners the start-of-document script put there, so between() waits for such a navigation to commit, restores the listeners
// and locks every frame again; only then is the key released.
// The verdict is read after send(); a veto means events after it were stopped, earlier ones may not have been.
export async function backgroundKey(tab, locator, send, { timeoutMs = 1000, settleMs = 400 } = {}) {
  const token = randomUUID(), capMs = timeoutMs + 3000, until = Date.now() + capMs;
  const arg = { token, capMs };
  const settle = (work, ms = timeoutMs) => deadline(work, ms);
  let owner, lockScript, unguarded = false;
  const cdp = tab.cdp, track = { dirty: false, pending: new Set(), wake: undefined };
  const wake = () => { const resolve = track.wake; track.wake = undefined; resolve?.(); };
  const events = {
    'Page.frameAttached': () => { track.dirty = true; },
    'Page.frameDetached': () => wake(),
    'Page.frameNavigated': event => { track.dirty = true; track.pending.delete(event.frame?.id); wake(); },
    'Page.frameStoppedLoading': event => { track.pending.delete(event.frameId); wake(); },
    // A frame's first navigation, to an address other than about:blank, is the one that reuses the empty document's window.
    'Page.frameRequestedNavigation': event => {
      track.dirty = true;
      if (event.reason === 'initialFrameNavigation' && event.url !== 'about:blank') track.pending.add(event.frameId);
    },
  };
  const finishAll = () => Promise.all(tab.page.frames().map(frame => settle(() => frame.evaluate(arg => {
    const result = window[Symbol.for('sleight.popup3')]?.finish(arg.token);
    return typeof result === 'string' ? result : undefined;
    // The frame holding the checked element may have been navigated by the key (a search form): its new document blocks the
    // release of the key, which is not an activation.
  }, arg)).then(reason => reason === keyReleased && frame === owner ? undefined : reason).catch(() => undefined)));
  const resync = () => Promise.all(tab.page.frames().map(async frame => {
    try {
      if (!await settle(() => frame.evaluate(arg => window[Symbol.for('sleight.popup3')]?.resync(arg.token, arg.capMs) === true, arg))) throw Error('no hook at document start');
    } catch { if (!frame.isDetached() && frame !== owner) unguarded = true; }
  }));
  // A frame in another process is known to the page before Playwright has its session. One Playwright cannot reach cannot be locked.
  const sameFrames = async ms => {
    for (const waitUntil = Date.now() + ms; ; await new Promise(resolve => setTimeout(resolve, 25))) {
      try {
        const frames = tab.page.frames();
        const counts = await Promise.all(frames.map(frame => settle(() => frame.evaluate(() => window[Symbol.for('sleight.popup3')]?.childFrames() ?? -1))));
        if (counts.every(count => count >= 0) && 1 + counts.reduce((sum, count) => sum + count, 0) <= frames.length) return true;
      } catch { return false; }
      if (Date.now() >= waitUntil) return false;
    }
  };
  // Called with the key down. A round trip to the page first, so every frame event its handlers caused has arrived.
  const between = async () => {
    for (let round = 0; round < 4; round++) {
      await settle(() => tab.page.mainFrame().evaluate(() => 0)).catch(() => {});
      const waitUntil = Date.now() + settleMs;
      while (track.pending.size && Date.now() < waitUntil) await new Promise(resolve => { track.wake = resolve; setTimeout(wake, Math.max(1, waitUntil - Date.now())); });
      if (!track.dirty) return;
      track.dirty = false;
      if (!await sameFrames(settleMs)) unguarded = true;
      await resync();
    }
  };
  try {
    try {
      await settle(() => locator.evaluate((element, { token, capMs }) => {
        const hook = window[Symbol.for('sleight.popup3')];
        if (!hook?.guard(element, token, capMs, { keys: true })) throw Error('key guard unavailable');
        return true;
      }, arg, { timeout: timeoutMs }));
    } catch { throw Error('background key guard unavailable; use the engine browser path'); }
    owner = typeof locator.ownerFrame === 'function' ? await locator.ownerFrame() : undefined;
    if (typeof tab.page.addInitScript === 'function') {
      try {
        lockScript = await settle(() => tab.page.addInitScript(`(${popupHook})();{const hook=window[Symbol.for('sleight.popup3')];` +
          `hook?.lock(${JSON.stringify(token)},${until}-Date.now());}`));
      } catch { throw Error('a document created by the key could not be guarded; use the engine browser path'); }
    }
    if (!await sameFrames(timeoutMs)) throw Error('a frame could not be guarded before the key; use the engine browser path');
    await Promise.all(tab.page.frames().filter(frame => frame !== owner).map(async frame => {
      try {
        // A hook that was not there at the start of the document sits behind the page's own listeners, so such a frame is not guarded.
        if (!await settle(() => frame.evaluate(() => !!window[Symbol.for('sleight.popup3')]))) throw Error('no hook at document start');
        if (!await settle(() => frame.evaluate(({ token, capMs }) => window[Symbol.for('sleight.popup3')]?.lock(token, capMs) === true, arg))) throw Error('not lockable');
      } catch {
        if (frame.isDetached()) return;
        throw Error('a frame could not be guarded before the key; use the engine browser path');
      }
    }));
    if (cdp?.on) for (const [name, handler] of Object.entries(events)) cdp.on(name, handler);
    const result = await send({ between: cdp?.on ? between : undefined });
    if (unguarded) throw Error('a frame created by the key could not be guarded; use the engine browser path');
    return result;
  } finally {
    if (cdp?.off) for (const [name, handler] of Object.entries(events)) cdp.off(name, handler);
    if (lockScript) await settle(() => lockScript.dispose()).catch(() => {});
    const verdicts = await finishAll().catch(() => []);
    const reason = verdicts.find(value => typeof value === 'string');
    if (reason) throw Error(keyMessage(reason));
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
    // The page session's script does not reach a frame in another process (a cross-site iframe); Playwright's init script
    // does, before that frame's own scripts, so the key lock finds the hook at the start of every document.
    if (typeof entry.page.addInitScript === 'function') entry.frameScript = await entry.page.addInitScript(popupHook);
  };
  const removeHook = async entry => {
    if (entry.script) {
      await entry.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.script }); entry.script = null;
    }
    if (entry.frameScript) { await entry.frameScript.dispose(); entry.frameScript = null; }
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
