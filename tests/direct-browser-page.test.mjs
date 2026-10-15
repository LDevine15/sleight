import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createPageRegistry, backgroundClick, popupHook } from '../plugins/sleight/lib/direct-browser/page.mjs';

function fixture(options = {}) {
  const calls = [], pages = [], context = new EventEmitter();
  context.pages = () => pages;
  context.newCDPSession = async page => page.cdp;
  const browser = { contexts: () => [context] };
  let sequence = 0;
  function page(targetId, openerId) {
    const p = new EventEmitter();
    p.info = { targetId, type: 'page', ...(openerId ? { openerId } : {}) };
    p.closed = false;
    p.isClosed = () => p.closed;
    p.url = () => 'https://fixture.invalid/' + targetId;
    p.title = async () => targetId;
    p.frames = () => [{ evaluate: async () => true }];
    p.keyboard = { up: async key => calls.push(['up', key]) };
    p.cdp = Object.assign(new EventEmitter(), { async send(method, params) {
      calls.push([method, params, targetId]);
      if (method === 'Target.getTargetInfo') return { targetInfo: p.info };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-' + targetId };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    }, detach: async () => calls.push(['detach', targetId]) });
    p.goto = async url => { calls.push(['goto', url, targetId]); };
    p.evaluate = async (_fn, name) => {
      if (name !== undefined) { p.windowName = name; return name; }
      return { name: p.windowName ?? '', origin: new URL(p.url()).origin };
    };
    p.close = async () => { calls.push(['close', targetId]); p.closed = true; p.emit('close'); };
    pages.push(p); context.emit('page', p); return p;
  }
  const session = { async send(method, params) {
    calls.push([method, params]);
    assert.equal(method, 'Target.createTarget');
    const targetId = 'target-' + ++sequence;
    page(targetId); return { targetId };
  } };
  const registry = createPageRegistry({ browser, session, timeoutMs: 100, popupWaitMs: 5, ...options });
  return { registry, calls, page, pages, session, context };
}

test('opens blank in the background, installs the hook before navigation, exposes fixed state', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' });
  assert.match(tab, /^t/);
  assert.deepEqual(f.registry.tab(tab).state, { snapshotNo: 0, submitUnconfirmed: false });
  assert.deepEqual(f.calls[0], ['Target.createTarget', { url: 'about:blank', background: true }]);
  const install = f.calls.findIndex(c => c[0] === 'Page.addScriptToEvaluateOnNewDocument');
  assert.ok(install >= 0 && install < f.calls.findIndex(c => c[0] === 'goto'));
  assert.ok(f.calls.some(c => c[0] === 'Emulation.setFocusEmulationEnabled' && c[1].enabled));
  await f.registry.endTurn();
});

test('never exposes an existing user page or a popup with a foreign opener', async () => {
  const f = fixture(); f.page('user'); f.page('foreign', 'user');
  await f.registry.idle();
  assert.deepEqual(await f.registry.list(), []);
  assert.throws(() => f.registry.tab('user'), /unknown|owned/i);
  await f.registry.endTurn();
  assert.equal(f.pages.some(p => p.closed), false);
});

test('adopts only a popup whose CDP opener is owned, retaining opener through self-close', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const popup = f.page('popup', 'target-1'); await f.registry.idle();
  const rows = await f.registry.list(), child = rows.find(r => r.targetId === 'popup');
  assert.equal(child.opener, tab);
  assert.equal(f.registry.tab(child.tab).page, popup);
  await popup.close();
  assert.equal(f.registry.tab(tab).popups.at(-1).closed, true);
  assert.equal(f.registry.tab(tab).popups.at(-1).opener, tab);
  assert.throws(() => f.registry.tab(child.tab), /closed/i);
  await f.registry.endTurn();
});

test('adopts popup descendants and does not duplicate a named popup', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const popup = f.page('popup', 'target-1'); await f.registry.idle();
  const child = (await f.registry.list()).find(r => r.targetId === 'popup');
  f.page('grandchild', 'popup'); await f.registry.idle();
  assert.equal((await f.registry.list()).find(r => r.targetId === 'grandchild').opener, child.tab);
  popup.emit('domcontentloaded'); await f.registry.idle();
  assert.equal(f.registry.tab(tab).popups.length, 1);
  await f.registry.endTurn();
});

test('turn end closes owned pages, preserves keep and handoff, and removes their hooks', async () => {
  const f = fixture(); f.page('user');
  const a = await f.registry.openTab({ url: 'https://fixture.invalid/a' });
  const b = await f.registry.openTab({ url: 'https://fixture.invalid/b' });
  const c = await f.registry.openTab({ url: 'https://fixture.invalid/c' });
  await f.registry.keep(b.tab); await f.registry.handoff(c.tab);
  const result = await f.registry.endTurn();
  assert.equal(result.cleanedUp, true);
  assert.equal(f.pages.find(p => p.info.targetId === 'target-1').closed, true);
  for (const id of ['user', 'target-2', 'target-3']) assert.equal(f.pages.find(p => p.info.targetId === id).closed, false);
  assert.equal(f.calls.filter(c => c[0] === 'Page.removeScriptToEvaluateOnNewDocument').length, 2);
  assert.throws(() => f.registry.tab(a.tab), /closed|ended/i);
  await assert.rejects(f.registry.openTab({ url: 'https://fixture.invalid/' }), /ended/i);
});

test('failed cleanup stays retryable and never claims closure', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const p = f.registry.tab(tab).page, close = p.close;
  p.close = async () => { throw Error('busy'); };
  assert.equal((await f.registry.endTurn()).cleanedUp, false);
  p.close = close;
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
});

test('per-tab queues serialize mutations and recover after a failed task', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const order = [];
  const a = f.registry.enqueue(tab, async () => { order.push(1); await new Promise(r => setTimeout(r, 5)); order.push(2); throw Error('failure'); });
  const b = f.registry.enqueue(tab, async () => { order.push(3); return 4; });
  await assert.rejects(a, /failure/); assert.equal(await b, 4); assert.deepEqual(order, [1, 2, 3]);
  await f.registry.endTurn();
});

test('invalid URLs allocate nothing', async () => {
  const f = fixture();
  for (const url of ['javascript:alert(1)', 'file:///tmp/fixture', 'https://user:password@fixture.invalid/'])
    await assert.rejects(f.registry.openTab({ url }), /URL/i);
  assert.deepEqual(f.calls, []); await f.registry.endTurn();
});

function clickFixture(probe) {
  const calls = [], entry = { page: { keyboard: { up: async key => calls.push(['up', key]) },
    evaluate: async () => { calls.push(['disarm']); return true; } }, popups: [], popupWaitMs: 1 };
  const locator = { evaluate: async () => probe };
  return { calls, entry, locator };
}

test('same-tab links receive an ordinary Playwright click', async () => {
  const f = clickFixture(false);
  const value = await backgroundClick(f.entry, f.locator, async options => { f.calls.push(['click', options]); return 'landed'; });
  assert.equal(value, 'landed'); assert.deepEqual(f.calls, [['click', {}], ['disarm']]);
});

test('popup-intent click carries background modifier, then always releases and disarms', async () => {
  const f = clickFixture(true);
  await backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options]));
  assert.deepEqual(f.calls, [['click', { modifiers: ['ControlOrMeta'] }], ['up', 'ControlOrMeta'], ['disarm']]);
});

test('throwing popup click is never replayed and still releases its modifier', async () => {
  const f = clickFixture(true);
  await assert.rejects(backgroundClick(f.entry, f.locator, async options => { f.calls.push(['click', options]); throw Error('dispatch uncertain'); }), /dispatch uncertain/);
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 1);
  assert.deepEqual(f.calls.slice(-2), [['up', 'ControlOrMeta'], ['disarm']]);
});

test('unproved popup preparation refuses before input and disarms a possible late probe', async () => {
  const f = clickFixture(false); f.locator.evaluate = async () => { throw Error('probe timed out'); };
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => f.calls.push(['click'])), /background|prepare/i);
  assert.deepEqual(f.calls, [['disarm']]);
});

function hookFixture({ clock = Date } = {}) {
  class Event {
    get defaultPrevented() { return !!this.nativePrevented; }
    get returnValue() { return !this.nativePrevented; }
    set returnValue(value) { if (!value) this.nativePrevented = true; }
    preventDefault() { this.nativePrevented = true; }
    composedPath() { return this.nodes; }
    stopPropagation() { this.propagationStopped = true; }
    stopImmediatePropagation() { this.stopped = this.propagationStopped = true; }
  }
  class MouseEvent extends Event {
    constructor(type = 'click') { super(); this.type = type; }
    get ctrlKey() { return this.control; }
    get metaKey() { return this.meta; }
    getModifierState(name) { return name === 'Control' ? this.control : this.meta; }
  }
  class Element {
    constructor(localName = 'button', attrs = {}) { Object.assign(this, { localName, attrs, isConnected: true }); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    matches() { return !!this.interactive; }
    getRootNode() { return {}; }
    get isContentEditable() {
      for (let node = this; node; node = node.parentElement ?? node.getRootNode().host) {
        if (node.attrs.contenteditable === 'false') return false;
        if (Object.hasOwn(node.attrs, 'contenteditable')) return true;
      }
      return document.designMode === 'on';
    }
  }
  class HTMLButtonElement extends Element {
    constructor(attrs = {}, form) { super('button', attrs); this.nativeForm = form; }
    get form() { return this.nativeForm ?? null; }
    get type() { const type = (this.attrs.type ?? '').toLowerCase(); return ['button', 'reset'].includes(type) ? type : 'submit'; }
  }
  class HTMLInputElement extends Element {
    constructor(attrs = {}, form) { super('input', attrs); this.nativeForm = form; }
    get form() { return this.nativeForm ?? null; }
    get type() { return (this.attrs.type ?? 'text').toLowerCase(); }
  }
  class HTMLSelectElement extends Element {
    constructor(attrs = {}) { super('select', attrs); }
    get multiple() { return Object.hasOwn(this.attrs, 'multiple'); }
  }
  class HTMLLabelElement extends Element {
    constructor(control) { super('label'); this.nativeControl = control; }
    get control() { return this.nativeControl ?? null; }
  }
  class EventTarget {
    addEventListener(name, fn, capture) {
      (this.listeners[name] ??= new Set()).add(fn);
      if (capture) (this.captureListeners[name] ??= new Set()).add(fn);
    }
    removeEventListener(name, fn) { this.listeners[name]?.delete(fn); this.captureListeners[name]?.delete(fn); }
  }
  const opens = [], window = { listeners: {}, captureListeners: {}, open(...args) { opens.push(args); return { real: true }; } };
  const navigator = { userActivation: { isActive: true } };
  const document = { baseURI: 'https://fixture.invalid/', scripts: [{ textContent: "window.open('/identity')" }], querySelector: () => null };
  vm.runInNewContext(`(${popupHook})()`, { window, document, navigator,
    MouseEvent, Element, HTMLElement: Element, HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLLabelElement,
    Event, EventTarget, URL, Date: clock, setTimeout, clearTimeout, queueMicrotask });
  const hook = window[Symbol.for('sleight.popup3')];
  return { window, document, navigator, hook, Element, HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLLabelElement,
    MouseEvent, Event, EventTarget, opens };
}

test('CR8 pointer events stay plain when their first modifier read is after dispatch', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element(), retained = [];
  const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const read = event => [event.ctrlKey, event.metaKey, event.getModifierState('Control'), event.getModifierState('Meta')];
  try {
    f.hook.prepare(button, 'pointer', 1000);
    for (const fn of f.window.listeners.keydown) fn(Object.assign(new f.Event(), { key: 'Meta', type: 'keydown', isTrusted: true }));
    for (const type of types) {
      const event = Object.assign(new f.MouseEvent(), { type, nodes: [button], isTrusted: true, control: true, meta: true });
      for (const fn of f.window.captureListeners[type] ?? []) fn(event);
      // Native composedPath is empty once dispatch has finished. No modifier
      // getter ran in the page's synchronous handler.
      event.nodes = []; retained.push(event);
    }
    t.mock.timers.tick(0);
    assert.equal(retained.find(event => event.type === 'mouseup').metaKey, false, 'deferred mouseup.metaKey');
    for (const event of retained) assert.deepEqual(read(event), [false, false, false, false], event.type);
    f.hook.finish('pointer');
    f.hook.prepare(button, 'next', 1000);
    for (const event of retained) assert.deepEqual(read(event), [false, false, false, false], event.type + ' after retirement');
  } finally { f.hook.off(); }
  for (const type of types) assert.equal(f.window.captureListeners[type]?.size ?? 0, 0, type + ' listener removed');
});

test('CR8 pointer capture masks only trusted events on the prepared element during its click', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element(), other = new f.Element(), retained = [];
  const dispatch = (type, nodes, isTrusted = true) => {
    const event = Object.assign(new f.MouseEvent(), { type, nodes, isTrusted, control: true, meta: true });
    for (const fn of f.window.captureListeners[type] ?? []) fn(event);
    event.nodes = []; retained.push(event);
  };
  try {
    dispatch('mouseup', [button]);
    f.hook.prepare(button, 'scoped', 1000);
    for (const fn of f.window.listeners.keydown) fn(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      dispatch(type, [button], false); dispatch(type, [other]);
    }
    dispatch('click', [button]); retained.pop();
    dispatch('mouseup', [button]);
    t.mock.timers.tick(0);
    dispatch('pointerup', [button]);
    f.hook.finish('scoped');
    for (const event of retained) assert.deepEqual([event.ctrlKey, event.metaKey], [true, true], event.type);
  } finally { f.hook.off(); }
});

test('CR6 masked events stay plain after dispatch, finish, and another arm', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element();
  try {
    f.hook.prepare(button, 'first', 1000);
    for (const fn of f.window.listeners.keydown) fn(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    const event = Object.assign(new f.MouseEvent(), { nodes: [button], isTrusted: true, control: true, meta: true });
    for (const fn of f.window.listeners.click) fn(event);
    t.mock.timers.tick(0);
    const read = () => [event.ctrlKey, event.metaKey, event.getModifierState('Control'), event.getModifierState('Meta')];
    assert.deepEqual(read(), [false, false, false, false]);
    f.hook.finish('first');
    assert.deepEqual(read(), [false, false, false, false]);
    f.hook.prepare(button, 'second', 1000);
    assert.deepEqual(read(), [false, false, false, false]);
  } finally { f.hook.off(); }
});

for (const key of ['Control', 'Meta']) test('CR6 swallows the matching trusted keyup after dispatch: ' + key, t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element();
  const keyEvent = (type, isTrusted = true) => {
    const event = Object.assign(new f.Event(), { key, type, isTrusted });
    for (const fn of f.window.listeners[type]) fn(event);
    return event;
  };
  try {
    f.hook.prepare(button, 'keys', 1000);
    assert.equal(keyEvent('keydown').stopped, true);
    const event = Object.assign(new f.MouseEvent(), { nodes: [button], isTrusted: true, control: true });
    for (const fn of f.window.listeners.click) fn(event);
    t.mock.timers.tick(0);
    assert.equal(keyEvent('keyup', false).stopped, undefined);
    assert.equal(keyEvent('keyup').stopped, true);
    assert.equal(keyEvent('keyup').stopped, true, 'the explicit cleanup keyup is also hidden until finish');
    f.hook.finish('keys');
    assert.equal(keyEvent('keyup').stopped, undefined, 'later unrelated keyups are visible after finish');
  } finally { f.hook.off(); }
});

test('CR6 captured link requests retain exact target and rel', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/landed', target: 'child', rel: 'noopener noreferrer' });
  try {
    f.hook.prepare(link, 'link', 1000);
    for (const fn of f.window.listeners.click) fn(Object.assign(new f.MouseEvent(), { nodes: [link], isTrusted: true }));
    assert.deepEqual(JSON.parse(JSON.stringify(f.hook.takeRequest('link'))),
      { url: 'https://fixture.invalid/landed', target: 'child', rel: 'noopener noreferrer' });
  } finally { f.hook.off(); }
});

test('CR6 named links reuse only an unchanged owned target and replace released or renamed targets', async () => {
  const f = fixture();
  try {
    const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), parent = f.registry.tab(tab);
    const first = await parent.openChild('https://fixture.invalid/first', { target: 'destination', rel: 'noopener' });
    const again = await parent.openChild('https://fixture.invalid/second', { target: 'destination', rel: 'noopener' });
    assert.equal(again.tab, first.tab);
    assert.equal(f.registry.tab(first.tab).page.windowName, 'destination');
    f.registry.tab(first.tab).page.windowName = 'page-renamed';
    const replacement = await parent.openChild('https://fixture.invalid/third', { target: 'destination' });
    assert.notEqual(replacement.tab, first.tab);
    const kept = f.registry.tab(replacement.tab);
    await f.registry.keep(replacement.tab);
    const afterKeep = await parent.openChild('https://fixture.invalid/fourth', { target: 'destination' });
    assert.notEqual(afterKeep.tab, replacement.tab);
    assert.equal(kept.released, true);
    assert.equal(f.calls.filter(call => call[0] === 'Target.createTarget').length, 4);
  } finally { await f.registry.endTurn(); }
});

for (const changed of ['origin', 'identity', 'closed']) test('CR6 named link rejects a stale reuse proof: ' + changed, async () => {
  const f = fixture();
  try {
    const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), parent = f.registry.tab(tab);
    const first = await parent.openChild('https://fixture.invalid/first', { target: 'destination' });
    const child = f.registry.tab(first.tab);
    if (changed === 'origin') child.page.url = () => 'https://other.invalid/';
    if (changed === 'identity') child.page.info.targetId = 'replaced-target';
    if (changed === 'closed') await child.page.close();
    const next = await parent.openChild('https://fixture.invalid/second', { target: 'destination' });
    assert.notEqual(next.tab, first.tab);
    assert.equal(f.registry.tab(next.tab).page.windowName, 'destination');
  } finally { await f.registry.endTurn(); }
});

test('CR6 a busy named destination refuses before joining its input queue', async () => {
  const f = fixture(); let release;
  try {
    const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), parent = f.registry.tab(tab);
    const child = await parent.openChild('https://fixture.invalid/first', { target: 'destination' });
    const hold = f.registry.enqueue(child.tab, () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    const before = f.calls.filter(call => call[0] === 'goto').length;
    await assert.rejects(parent.openChild('https://fixture.invalid/second', { target: 'destination' }), /named link target is busy/);
    assert.equal(f.calls.filter(call => call[0] === 'goto').length, before);
    release(); await hold; release = undefined;
    assert.equal((await parent.openChild('https://fixture.invalid/second', { target: 'destination' })).tab, child.tab);
  } finally { release?.(); await f.registry.endTurn(); }
});

test('CR3 arms every command without inspecting script or listener source', () => {
  const f = hookFixture();
  try {
    Object.defineProperty(f.document, 'scripts', { get() { throw Error('source inspection is forbidden'); } });
    assert.equal(f.hook.prepare(new f.Element(), 'external-handler', 1000), true);
  } finally { f.hook.off(); }
});

for (const attrs of [{ rel: 'noopener' }, { target: '_self', rel: 'noreferrer' },
  { target: 'content', rel: 'noopener' }, { target: '_parent' }, { target: '_top' }])
test('CR3 same-context link stays plain: ' + JSON.stringify(attrs), () => {
  const f = hookFixture(), child = {}; f.window.frames = Object.assign([child], { content: child });
  try { assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', ...attrs }), 'same', 1000), false); }
  finally { f.hook.off(); }
});

for (const target of ['_blank', 'new-context']) test('CR3 independent link target is captured: ' + target, () => {
  const f = hookFixture();
  try { assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target }), 'new', 1000)?.kind, 'link'); }
  finally { f.hook.off(); }
});

test('CR3 base target selects an existing context without treating rel as a new window', () => {
  const f = hookFixture(), child = {}; f.window.frames = Object.assign([child], { content: child });
  f.document.querySelector = () => new f.Element('base', { target: 'content' });
  try { assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', rel: 'noopener' }), 'base', 1000), false); }
  finally { f.hook.off(); }
});

test('CR3 built-in Window properties are not existing named frame contexts', () => {
  const f = hookFixture(); f.window.frames = Object.assign([], { top: f.window });
  try { assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'top' }), 'builtin', 1000)?.kind, 'link'); }
  finally { f.hook.off(); }
});

test('CR3 captures composedPath and Date.now before page wrappers can change masking', () => {
  let now = 10;
  const clock = { now: () => now }, f = hookFixture({ clock }), button = new f.Element();
  try {
    f.hook.prepare(button, 'native', 1000);
    f.Event.prototype.composedPath = () => [];
    clock.now = () => 1e9;
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    now += 5;
    const event = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true });
    assert.equal(event.ctrlKey, false);
  } finally { f.hook.off(); }
});

test('CR3 preparation arm outlasts the actionability timeout by one second', async () => {
  const f = clickFixture(true); let cap;
  f.locator.evaluate = async (_fn, args) => { cap = args.capMs; return true; };
  await backgroundClick(f.entry, f.locator, async () => {}, { timeoutMs: 2000 });
  assert.equal(cap, 3000);
});

test('CR3 a link-kind self-close returns closure without evaluating takeRequest', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.opener = 'parent'; f.entry.parent = { page: { isClosed: () => false } };
  let requestReads = 0;
  f.entry.page.evaluate = async fn => {
    if (String(fn).includes('takeRequest')) { requestReads++; throw Error('page closed'); }
  };
  const result = await backgroundClick(f.entry, f.locator, async () => {
    f.entry.closed = true; throw Error('Target page has been closed');
  });
  assert.deepEqual(result, { closed: true, opener: 'parent' });
  assert.equal(requestReads, 0);
});

test('CR2 HTML navigable containers and plugin elements reject focus through open shadow roots', () => {
  // HTML document-sequences.html#navigable-container and iframe-embed-object.html;
  // obsolete.html#frames and WICG fenced-frame/#fenced-frame-element extend the set.
  const f = hookFixture();
  try {
    for (const tag of ['iframe', 'object', 'embed', 'frame', 'fencedframe']) {
      const focused = new f.Element(tag);
      f.document.activeElement = { shadowRoot: { activeElement: { shadowRoot: { activeElement: focused } } } };
      assert.throws(() => f.hook.prepare(new f.Element(), tag, 1000), /frame|focus/i);
    }
    f.document.activeElement = { shadowRoot: { activeElement: new f.Element('input') } };
    assert.equal(f.hook.prepare(new f.Element(), 'ordinary-focus', 1000), true);
  } finally { f.hook.off(); }
});

test('CR5 native controls and ARIA roles without a measured modifier default use masking', () => {
  const f = hookFixture();
  try {
    for (const type of ['', 'invalid', 'hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date',
      'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file']) {
      assert.equal(f.hook.prepare(new f.Element('input', { type }), 'input-' + type, 1000), true, type);
      f.hook.finish('input-' + type);
    }
    for (const type of ['button', 'submit', 'reset', 'image', 'SUBMIT']) {
      assert.equal(f.hook.prepare(new f.Element('input', { type }), 'button-' + type, 1000), true, type);
      f.hook.finish('button-' + type);
    }
    for (const tag of ['select', 'option', 'textarea', 'label', 'summary']) {
      assert.equal(f.hook.prepare(new f.Element(tag), tag, 1000), true, tag); f.hook.finish(tag);
    }
    for (const role of ['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio', 'tab',
      'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'scrollbar']) {
      assert.equal(f.hook.prepare(new f.Element('div', { role }), 'role-' + role, 1000), true, role); f.hook.finish('role-' + role);
    }
    for (const [role, attribute] of [['button', 'aria-pressed'], ['gridcell', 'aria-selected'], ['row', 'aria-selected']]) {
      assert.equal(f.hook.prepare(new f.Element('div', { role, [attribute]: 'false' }), role, 1000), true, role); f.hook.finish(role);
    }
    for (const tag of ['button', 'input']) {
      assert.equal(f.hook.prepare(new f.Element(tag, { type: 'button', 'aria-pressed': 'false' }), 'toggle-' + tag, 1000), true, tag); f.hook.finish('toggle-' + tag);
    }
    assert.equal(f.hook.prepare(new f.Element('button'), 'popup-button', 1000), true);
  } finally { f.hook.off(); }
});

test('CR4 masking survives 300 ms load until click dispatch completes and respects arm cap', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element();
  const mouse = () => Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true });
  try {
    f.hook.prepare(button, 'loaded', 1000);
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    t.mock.timers.tick(300);
    const click = mouse();
    for (const listener of f.window.listeners.click) listener(click);
    assert.equal(click.ctrlKey, false);
    assert.equal(f.window.open('/loaded', 'loaded').real, true);
    t.mock.timers.tick(0);
    assert.equal(mouse().ctrlKey, true);
    assert.equal(f.window.open('/too-late', 'late'), null);
    f.hook.prepare(button, 'cap', 1000);
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    t.mock.timers.tick(1000);
    assert.equal(mouse().ctrlKey, true);
  } finally { f.hook.off(); }
});

test('serialized popup hook hides only the prepared trusted click and strips window sizing', () => {
  const f = hookFixture(), button = new f.Element();
  try {
    assert.equal(f.hook.prepare(button, 'click', 1000), true);
    const key = Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true });
    for (const listener of f.window.listeners.keydown) listener(key);
    assert.equal(key.stopped, true);
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true, meta: false });
    assert.equal(click.ctrlKey, false); assert.equal(click.getModifierState('Control'), false);
    const other = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [new f.Element()], control: true });
    assert.equal(other.ctrlKey, true);
    const untrusted = Object.assign(new f.MouseEvent(), { isTrusted: false, nodes: [button], control: true });
    assert.equal(untrusted.ctrlKey, true);
    assert.equal(f.window.open('/identity', 'identity', 'popup,width=420,noopener=yes').real, true);
    assert.deepEqual(f.opens[0], ['/identity', 'identity', 'noopener=yes']);
    f.hook.finish('click');
    assert.equal(f.window.open('/unarmed', '_blank'), null);
    assert.equal(f.hook.prepare(button, 'click', 1000), false, 'a timed-out token cannot rearm late');
  } finally { f.hook.off(); }
});

test('serialized popup hook leaves same-tab links plain and restores native methods on release', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/checkout' });
  const nativeOpen = f.window.open;
  assert.equal(f.hook.prepare(link, 'same-tab', 1000), false);
  assert.equal(f.window.open('/self', '_self').real, true);
  assert.equal(f.hook.off(), true);
  assert.notEqual(f.window.open, nativeOpen);
  assert.equal(f.window[Symbol.for('sleight.popup3')], undefined);
  const event = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link], control: true });
  assert.equal(event.ctrlKey, true);
  assert.equal(f.window.listeners.keydown.size, 0);
});

test('opening does not attach persistent sessions to existing user pages', async () => {
  const f = fixture(); f.page('user'); await f.registry.idle();
  const before = f.calls.filter(c => c[0] === 'Target.getTargetInfo' && c[2] === 'user').length;
  await f.registry.openTab({ url: 'https://fixture.invalid/' });
  assert.equal(f.calls.filter(c => c[0] === 'Target.getTargetInfo' && c[2] === 'user').length, before);
  await f.registry.endTurn();
});

test('turn end closes an allocated target even when Playwright never produces its page', async t => {
  const calls = [], f = fixture({ timeoutMs: 20, session: { async send(method, params) {
    calls.push([method, params]);
    return method === 'Target.createTarget' ? { targetId: 'unseen' } : { success: true };
  } } });
  const opening = f.registry.openTab({ url: 'https://fixture.invalid/' });
  opening.catch(() => {});
  t.after(async () => { f.page('unseen'); await f.registry.idle(); await f.registry.endTurn(); });
  await new Promise(resolve => setTimeout(resolve, 1));
  const result = await f.registry.endTurn();
  assert.equal(result.cleanedUp, true);
  assert.deepEqual(calls.at(-1), ['Target.closeTarget', { targetId: 'unseen' }]);
  await assert.rejects(opening, /ended|pending/i);
});

test('popup click waits for delayed owned adoption after windowOpen without delaying ordinary clicks', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const entry = f.registry.tab(tab);
  entry.page.evaluate = async () => true;
  await backgroundClick(entry, { evaluate: async () => true }, async () => {
    entry.cdp.emit('Page.windowOpen', { url: 'https://fixture.invalid/popup' });
    setTimeout(() => f.page('delayed-popup', 'target-1'), 2);
  });
  assert.equal(entry.popups.length, 1);
  assert.equal(f.registry.tab(entry.popups[0].tab).page.info.targetId, 'delayed-popup');
  await f.registry.endTurn();
});

test('filtered popup is admitted from trusted CDP opener metadata before Playwright can see it', async () => {
  const owned = [], f = fixture({
    upstream: { async send(method) {
      assert.equal(method, 'Target.getTargets');
      return { targetInfos: [{ type: 'page', targetId: 'child', openerId: 'target-1' },
        { type: 'page', targetId: 'foreign', openerId: 'user' }, { type: 'worker', targetId: 'worker', openerId: 'target-1' }] };
    } },
    ownTarget: async targetId => { owned.push(targetId); f.page(targetId, 'target-1'); },
  });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  f.registry.tab(tab).cdp.emit('Page.windowOpen', {});
  await f.registry.idle();
  assert.deepEqual(owned, ['child']);
  assert.equal(f.registry.tab(tab).popups.length, 1);
  await f.registry.endTurn();
});

test('a noopener link dispatches once and opens its captured default destination in the background', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.page.evaluate = async () => ({ url: 'https://fixture.invalid/shipping' });
  f.entry.openChild = async url => f.calls.push(['openChild', url]);
  await backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options]));
  assert.deepEqual(f.calls.filter(c => ['click', 'openChild'].includes(c[0])), [
    ['click', { modifiers: ['ControlOrMeta'] }], ['openChild', 'https://fixture.invalid/shipping'],
  ]);
});

test('a prepared new-tab link carries background disposition even if page handlers stop bubbling', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.page.evaluate = async () => undefined;
  await backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options]));
  assert.deepEqual(f.calls.find(call => call[0] === 'click'), ['click', { modifiers: ['ControlOrMeta'] }]);
  assert.equal(f.calls.filter(call => call[0] === 'click').length, 1);
  assert.ok(f.calls.some(call => call[0] === 'up'));
});

test('a popup closing during its click returns the observed closure and its living opener', async () => {
  const f = clickFixture(false);
  f.entry.opener = 'parent'; f.entry.parent = { page: { isClosed: () => false } };
  f.entry.closed = true;
  const click = async () => { throw Error('locator.click: Target page, context or browser has been closed'); };
  const result = await backgroundClick(f.entry, f.locator, click);
  assert.deepEqual(result, { closed: true, opener: 'parent' });
  f.entry.parent.page.isClosed = () => true;
  await assert.rejects(backgroundClick(f.entry, f.locator, click), /Target page/);
});

test('serialized link hook replaces only an uncancelled trusted default open', () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  try {
    assert.equal(f.hook.prepare(link, 'link', 1000).kind, 'link');
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.listeners.click) listener(click);
    assert.equal(click.nativePrevented, true);
    assert.equal(click.defaultPrevented, false);
    assert.equal(f.hook.takeRequest('link').url, 'https://fixture.invalid/shipping');
    assert.equal(f.hook.takeRequest('link').unavailable, true);
    f.hook.finish('link'); f.hook.prepare(link, 'cancelled', 1000);
    const cancelled = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    cancelled.preventDefault();
    for (const listener of f.window.listeners.click) listener(cancelled);
    assert.equal(f.hook.takeRequest('cancelled'), undefined);
    assert.deepEqual(f.opens, []);
  } finally { f.hook.off(); }
});

for (const stop of ['stopPropagation', 'stopImmediatePropagation']) for (const cancel of [false, true])
test(`capture suppresses the native default before ${stop}, preserving page cancellation=${cancel}`, () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  try {
    f.hook.prepare(link, 'link', 1000);
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    assert.equal(click.nativePrevented, true, 'the native open must be suppressed before page handlers');
    assert.equal(click.defaultPrevented, false, 'the page has not cancelled its own default');
    click[stop]();
    if (cancel) click.preventDefault();
    assert.equal(click.defaultPrevented, cancel);
    const request = f.hook.takeRequest('link');
    assert.equal(request?.url, cancel ? undefined : 'https://fixture.invalid/shipping');
  } finally { f.hook.off(); }
});

for (const cancel of ['returnFalse', 'returnValue']) test(`captured link respects ${cancel} cancellation without a bubble listener`, () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  link.onclick = event => {
    event.stopImmediatePropagation();
    if (cancel === 'returnValue') event.returnValue = false;
    return false;
  };
  try {
    f.hook.prepare(link, 'link', 1000);
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    assert.equal(click.nativePrevented, true);
    link.onclick(click);
    assert.equal(f.hook.takeRequest('link'), undefined);
  } finally { f.hook.off(); }
});

test('keep waits for queued input, fences new input, then releases filter ownership', async () => {
  const released = [], f = fixture({ releaseTarget: target => released.push(target) });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  let finish, started;
  const begun = new Promise(resolve => { started = resolve; });
  const pending = f.registry.enqueue(tab, async () => { started(); await new Promise(resolve => { finish = resolve; }); });
  await begun;
  const keeping = f.registry.keep(tab);
  assert.throws(() => f.registry.enqueue(tab, async () => {}), /owned|releas/i);
  assert.deepEqual(released, []);
  finish(); await pending; await keeping;
  assert.deepEqual(released, ['target-1']);
  assert.equal(f.pages[0].isClosed(), false);
  await f.registry.endTurn();
});

for (const kind of ['keep', 'handoff']) test(`${kind} accepted before turn end preserves the page during hook removal`, async t => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = f.registry.tab(tab).page, send = page.cdp.send.bind(page.cdp);
  let releaseHook, entered;
  const begun = new Promise(resolve => { entered = resolve; });
  page.cdp.send = (method, params) => {
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
      entered(); return new Promise(resolve => { releaseHook = resolve; });
    }
    return send(method, params);
  };
  const releasing = f.registry[kind](tab);
  await begun;
  const ending = f.registry.endTurn();
  await new Promise(resolve => setImmediate(resolve));
  const closedDuringRelease = page.isClosed();
  releaseHook({});
  assert.equal((await releasing).kept, true);
  const result = await ending;
  assert.equal(closedDuringRelease, false);
  assert.equal(result.cleanedUp, true);
  assert.equal(result.rows.find(row => row.tab === tab).kept, true);
  assert.equal(page.isClosed(), false);
});

for (const kind of ['keep', 'handoff']) test(`${kind} pending detach has bounded cleanup and can settle without closing the page`, async t => {
  const f = fixture({ timeoutMs: 1000 }), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const page = f.registry.tab(tab).page;
  let detach, entered;
  const begun = new Promise(resolve => { entered = resolve; });
  page.cdp.detach = () => { entered(); return new Promise(resolve => { detach = resolve; }); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const releasing = f.registry[kind](tab);
  let rejection;
  releasing.catch(error => { rejection = error; });
  t.after(async () => { detach?.(); await releasing.catch(() => {}); await f.registry.endTurn(); });
  await begun;
  t.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(rejection?.message ?? 'no rejection', /pending|timed out/i);
  assert.throws(() => f.registry.enqueue(tab, async () => {}), /owned|releas/i);
  const ending = f.registry.endTurn();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const result = await ending;
  assert.equal(result.cleanedUp, false);
  assert.equal(page.isClosed(), false);
  assert.equal(result.rows.find(row => row.tab === tab).cleanupRequired, true);
  detach(); await f.registry.idle();
  const retried = await f.registry.endTurn();
  assert.equal(retried.cleanedUp, true);
  assert.equal(retried.rows.find(row => row.tab === tab).kept, true);
  assert.equal(page.isClosed(), false);
});

test('a page closing during release is refused instead of acknowledged as kept', async () => {
  const f = fixture({ releaseTarget: () => f.pages[0].close() });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  await assert.rejects(f.registry.keep(tab), /closed during release/);
  const result = await f.registry.endTurn();
  assert.equal(result.cleanedUp, true);
  assert.equal(result.rows.find(row => row.tab === tab).kept, false);
});

for (const tag of ['textarea', 'select', 'option', 'label', 'input'])
  test('CR5 does not infer a modifier default from an arbitrary ancestor: ' + tag, () => {
    const f = hookFixture(), button = new f.Element();
    button.parentElement = new f.Element(tag);
    try { assert.equal(f.hook.prepare(button, tag, 1000), true); } finally { f.hook.off(); }
  });
for (const role of ['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio'])
  test('CR5 custom shadow widget handlers receive masking: ' + role, () => {
    const f = hookFixture(), button = new f.Element();
    button.getRootNode = () => ({ host: new f.Element('custom-control', { role }) });
    try { assert.equal(f.hook.prepare(button, role, 1000), true); } finally { f.hook.off(); }
  });

test('CR7 leaves editable content plain and refuses detached nodes, frame focus and retired tokens', () => {
  const f = hookFixture();
  try {
    assert.equal(f.hook.prepare(new f.Element('div', { contenteditable: '' }), 'editable', 1000), false);
    const detached = new f.Element(); detached.isConnected = false;
    assert.equal(f.hook.prepare(detached, 'detached', 1000), false);
    f.hook.finish('late');
    assert.equal(f.hook.prepare(new f.Element(), 'late', 1000), false);
    for (const localName of ['iframe', 'frame', 'fencedframe', 'object', 'embed']) {
      f.document.activeElement = new f.Element(localName);
      assert.throws(() => f.hook.prepare(new f.Element(), localName, 1000), /frame|focus/i);
    }
  } finally { f.hook.off(); }
});

test('CR1 preparation and modifier masking expire independently', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element();
  const mouse = () => Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true, meta: true });
  try {
    f.hook.prepare(button, 'expire', 3000);
    assert.equal(mouse().ctrlKey, true);
    for (const listener of f.window.listeners.keydown) listener(Object.assign(new f.Event(), { key: 'Meta', type: 'keydown', isTrusted: true }));
    const captured = mouse();
    assert.equal(captured.metaKey, false);
    t.mock.timers.tick(1001);
    assert.equal(captured.metaKey, false, 'masking follows dispatch rather than a fixed clock window');
    assert.equal(mouse().metaKey, false);
    t.mock.timers.tick(2000);
    assert.equal(f.hook.prepare(button, 'expire', 1000), false);
  } finally { f.hook.off(); }
});

test('CR1 window opening needs an arm while same-context names remain native', () => {
  const f = hookFixture();
  try {
    for (const target of ['_self', '_parent', '_top']) assert.equal(f.window.open('/same', target).real, true);
    assert.equal(f.window.open('/popup', '_blank'), null);
    f.hook.prepare(new f.Element(), 'active', 1000);
    for (const listener of f.window.listeners.keydown) listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    f.window.open('/popup', 'named', 'left=10,noreferrer,top=20,noopener=yes,width=100');
    assert.deepEqual(f.opens.at(-1), ['/popup', 'named', 'noreferrer,noopener=yes']);
  } finally { f.hook.off(); }
});

test('CR1 changed link destinations refuse a stale captured default', () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/first' });
  try {
    f.hook.prepare(link, 'changed', 1000);
    const event = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(event);
    link.attrs.href = '/second';
    assert.equal(f.hook.takeRequest('changed').unavailable, true);
    assert.equal(event.returnValue, true);
    event.returnValue = false;
    assert.equal(event.defaultPrevented, true);
  } finally { f.hook.off(); }
});

test('CR1 teardown preserves a later replacement of window.open', () => {
  const f = hookFixture(), replacement = () => 'page replacement';
  f.window.open = replacement;
  f.hook.off();
  assert.equal(f.window.open, replacement);
});

test('CR1 preparation timeout sends no input, retires the late token and disarms', async () => {
  const f = clickFixture(false);
  f.locator.evaluate = () => new Promise(() => {});
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => f.calls.push(['click']), { timeoutMs: 5 }),
    /background popup preparation failed; use the engine browser path/);
  assert.deepEqual(f.calls, [['disarm']]);
});

test('CR1 unavailable link default and missing registry never replay input', async () => {
  for (const request of [{ unavailable: true }, { url: 'https://fixture.invalid/' }]) {
    const f = clickFixture({ kind: 'link' });
    f.entry.page.evaluate = async () => request;
    await assert.rejects(backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options])),
      request.url ? /owned page registry/ : /link default changed or was not captured/);
    assert.equal(f.calls.filter(call => call[0] === 'click').length, 1);
    assert.equal(f.calls.filter(call => call[0] === 'up').length, 1);
  }
});

test('CR3 same-context links stay plain without source inspection even with registered handlers', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/checkout' });
  link.listeners = {}; link.captureListeners = {};
  try {
    f.EventTarget.prototype.addEventListener.call(link, 'click', () => window.open('/popup'));
    assert.equal(f.hook.prepare(link, 'registered', 1000), false);
  } finally { f.hook.off(); }
});

test('CR1 no live user activation means no window, including during an armed click', () => {
  const f = hookFixture(), button = new f.Element();
  try {
    f.hook.prepare(button, 'activation', 1000);
    for (const listener of f.window.listeners.keydown) listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    f.navigator.userActivation.isActive = false;
    assert.equal(f.window.open('/popup', '_blank'), null);
    assert.deepEqual(f.opens, []);
  } finally { f.hook.off(); }
});

test('CR1 observes an inline cancellation installed after preparation and before dispatch', () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  try {
    f.hook.prepare(link, 'late-handler', 1000);
    link.onclick = () => false;
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    link.onclick(click);
    assert.equal(f.hook.takeRequest('late-handler'), undefined);
  } finally { f.hook.off(); }
});

test('CR1 a handler installed during dispatch makes an uncancelled default unavailable', () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  try {
    f.hook.prepare(link, 'during-dispatch', 1000);
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    link.onclick = () => {};
    assert.equal(f.hook.takeRequest('during-dispatch').unavailable, true);
  } finally { f.hook.off(); }
});

test('CR6 a new arm keeps a retired event masked under its original token', () => {
  const f = hookFixture(), button = new f.Element();
  const keydown = () => {
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
  };
  try {
    f.hook.prepare(button, 'first', 1000); keydown();
    const first = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true });
    for (const listener of f.window.captureListeners.click) listener(first);
    assert.equal(first.ctrlKey, false);
    const second = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true });
    assert.equal(second.ctrlKey, true, 'only the first click belongs to the arm');
    f.hook.finish('first');
    f.hook.prepare(button, 'second', 1000); keydown();
    assert.equal(first.ctrlKey, false, 'an old event retains its original mask');
    assert.equal(second.ctrlKey, false);
  } finally { f.hook.off(); }
});
test('endpoint popup adoption closes before hook installation, for any host spelling or pending URL', async () => {
  for (const info of [{ url: 'http://alias.invalid:9222/json/list' }, { url: 'about:blank', pendingUrl: 'http://localhost:9222/json/list' }]) {
    const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private' });
    const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
    const popup = f.page('endpoint-child', 'target-1'); Object.assign(popup.info, info);
    await f.registry.idle();
    assert.equal(popup.closed, true);
    assert.equal(f.calls.some(c => c[0] === 'Runtime.evaluate' && c[2] === 'endpoint-child'), false);
    assert.equal(f.registry.tab(tab).popups.at(-1).blocked, true);
    assert.equal((await f.registry.list()).length, 1);
    assert.equal((await f.registry.endTurn()).cleanedUp, true);
  }
});

test('background link allocation refuses the endpoint port before creating a page', async () => {
  const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private' });
  await assert.rejects(f.registry.openTab({ url: 'http://alias.invalid:9222/json/list' }), /blocked: DevTools endpoint/);
  assert.equal(f.pages.length, 0);
  await f.registry.endTurn();
});

test('failed endpoint popup closure stays owned for cleanup without filter admission', async () => {
  const admitted = [], closes = [], f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private',
    upstream: { async send(method, params) {
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'blocked-child', openerId: 'target-1', url: 'http://alias.invalid:9222/json/list' }] };
      assert.equal(method, 'Target.closeTarget'); closes.push(params.targetId);
      return { success: false };
    } }, ownTarget: async targetId => admitted.push(targetId) });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  f.registry.tab(tab).cdp.emit('Page.windowOpen', { url: 'http://alias.invalid:9222/json/list' });
  await f.registry.idle();
  assert.deepEqual(admitted, []);
  const result = await f.registry.endTurn();
  assert.equal(result.cleanedUp, false);
  assert.deepEqual(result.rows.find(row => row.targetId === 'blocked-child'), { targetId: 'blocked-child', closed: false, cleanupRequired: true });
  assert.equal(closes.length, 2,'turn end retries the exact owned closure');
});

test('the default endpoint port does not classify about:blank as an endpoint page', async () => {
  const f = fixture({ endpoint: 'ws://127.0.0.1/devtools/browser/private' });
  // Fresh browser targets begin at about:blank, which has no network port.
  f.context.newCDPSession = async page => {
    page.url = () => 'about:blank';
    return page.cdp;
  };
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  assert.equal(f.registry.tab(tab).closed, false);
  await f.registry.endTurn();
});

test('REVIEW endpoint navigation closes the owned page', async t => {
  const f = fixture({endpoint:'ws://127.0.0.1:9222/devtools/browser/private'});
  t.after(() => f.registry.endTurn());
  const {tab} = await f.registry.openTab({url:'https://fixture.invalid/'}), entry=f.registry.tab(tab);
  entry.page.url=()=> 'http://localhost:9222/json/list';
  await assert.rejects(f.registry.enqueue(tab, async()=>assert.fail('no read')), /blocked: DevTools endpoint/);
  assert.equal(entry.page.isClosed(), true);
});
test('REVIEW listing preserves unrelated owned tabs', async t => {
  const f = fixture({endpoint:'ws://127.0.0.1:9222/devtools/browser/private'});
  t.after(() => f.registry.endTurn());
  const a=await f.registry.openTab({url:'https://fixture.invalid/'});
  await f.registry.openTab({url:'https://fixture.invalid/other'});
  f.registry.tab(a.tab).page.url=()=> 'http://localhost:9222/json/list';
  assert.ok((await f.registry.list()).some(row=>row.url.includes('target-2')));
});

test('simultaneous blank popups close only the exact blocked target', async t => {
  const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private', endpointBlocked: id => id === 'blocked-child' });
  t.after(() => f.registry.endTurn());
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const parent = f.registry.tab(tab);
  parent.cdp.emit('Page.windowOpen', { url: 'http://localhost:9222/json/list' });
  const safe = f.page('safe-child', 'target-1'), blocked = f.page('blocked-child', 'target-1');
  safe.url = blocked.url = () => 'about:blank';
  await f.registry.idle();
  assert.equal(safe.isClosed(), false);
  assert.equal(blocked.isClosed(), true);
  assert.equal((await f.registry.list()).length, 2);
  assert.deepEqual(parent.popups.find(row => row.blocked), { opener: tab, blocked: true, closed: true });
});

test('a blocked later navigation with failed closure stays private and cleanup retries it', async t => {
  const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private' });
  t.after(() => f.registry.endTurn());
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' }), entry = f.registry.tab(tab);
  const close = entry.page.close;
  entry.page.close = async () => { throw Error('busy'); };
  entry.page.url = () => 'http://localhost:9222/json/list';
  await assert.rejects(f.registry.enqueue(tab, async () => assert.fail('no read')), { message: 'blocked: DevTools endpoint' });
  assert.deepEqual(await f.registry.list(), []);
  assert.throws(() => f.registry.tab(tab), { message: 'blocked: DevTools endpoint' });
  assert.equal((await f.registry.endTurn()).cleanedUp, false);
  entry.page.close = close;
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
});

test('an endpoint redirect rejected by goto still closes and reports only the block', async t => {
  const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private' });
  t.after(() => f.registry.endTurn());
  f.context.on('page', page => { page.goto = async () => {
    page.info.pendingUrl = 'http://localhost:9222/json/list';
    throw Error('net::ERR_BLOCKED_BY_CLIENT at private URL');
  }; });
  await assert.rejects(f.registry.openTab({ url: 'https://fixture.invalid/redirect' }), { message: 'blocked: DevTools endpoint' });
  assert.equal(f.pages[0].isClosed(), true);
});


for (const probe of [false, true, { kind: 'link' }]) test('CR4 self-closing click still waits for its popup: ' + JSON.stringify(probe), async () => {
  const f = clickFixture(probe), checkpoint = {};
  f.entry.opener = 'parent'; f.entry.parent = { page: { isClosed: () => false } };
  f.entry.popupCheckpoint = () => checkpoint;
  let settled = false;
  f.entry.settlePopups = async before => { assert.equal(before, checkpoint); settled = true; };
  await backgroundClick(f.entry, f.locator, async () => {
    f.entry.closed = true; throw Error('Target page has been closed');
  });
  assert.equal(settled, true);
});

for (const kind of ['sibling', 'grandchild', 'frame-attribute'])
test('CR4 existing named context stays plain: ' + kind, () => {
  const f = hookFixture(), child = { name: 'destination', frames: [] };
  const top = { name: '', frames: [] }; f.window.top = top;
  if (kind === 'sibling') top.frames.push(f.window, child);
  if (kind === 'grandchild') top.frames.push({ name: '', frames: [child] });
  if (kind === 'frame-attribute') f.document.querySelectorAll = () => [new f.Element('iframe', { name: 'destination' })];
  try {
    assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'destination' }), 'named', 1000), false);
  } finally { f.hook.off(); }
});

// Navigating a window the page opened by name raises it, so a link to it is a new-context link that sleight
// opens in the background (AD1 A3). Only frames and the page's own names stay plain.
test('CR4 a link to an earlier popup by name is captured, not left plain', () => {
  const f = hookFixture();
  try {
    const button = new f.Element(); f.hook.prepare(button, 'first', 1000);
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    f.window.open('/first', 'destination'); f.hook.finish('first');
    assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'destination' }), 'named', 1000).kind, 'link');
  } finally { f.hook.off(); }
});

test('AD1 A6 window.open without an agent click is counted as held until taken', () => {
  const f = hookFixture();
  try {
    assert.equal(f.hook.take(), 0);
    assert.equal(f.window.open('/late', '_blank'), null);
    assert.equal(f.window.open('/late2', 'named'), null);
    assert.equal(f.hook.take(), 2);
    assert.equal(f.hook.take(), 0);
  } finally { f.hook.off(); }
});

test('AD1 A4 press mode refuses a new-context form and leaves a plain control unarmed', () => {
  const f = hookFixture();
  const form = new f.Element('form', { target: '_blank' });
  try {
    assert.equal(f.hook.prepare(new f.HTMLInputElement({}, form), 'press-form', 1000, true).kind, 'form');
    assert.equal(f.hook.prepare(new f.Element('div'), 'press-div', 1000, true), false);
  } finally { f.hook.off(); }
});

test('CR4 late popup adoption retains the closed owned opener', async () => {
  const f = fixture(), root = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const parent = f.registry.tab(root.tab), page = f.page('closing-child', parent.targetId);
  await f.registry.idle();
  const child = f.registry.tab(parent.popups[0].tab);
  child.page.evaluate = async () => true;
  await backgroundClick(child, { evaluate: async () => true }, async () => {
    child.cdp.emit('Page.windowOpen', {});
    await page.close();
    setTimeout(() => f.page('survivor', 'closing-child'), 2);
    throw Error('Target page has been closed');
  });
  assert.equal(child.popups.length, 1);
  assert.equal(f.registry.tab(child.popups[0].tab).opener, child.tab);
  await f.registry.endTurn();
});

test('CR4 frame walk passes inaccessible names and documents without inventing a target', () => {
  const f = hookFixture(), child = { name: 'destination', frames: [] };
  const opaque = { frames: new Proxy([child], { get(array, key) {
    if (typeof key === 'string' && !/^(length|\d+)$/.test(key)) throw Error('cross-origin named access');
    return Reflect.get(array, key);
  } }) };
  Object.defineProperties(opaque, { name: { get() { throw Error('cross-origin'); } },
    document: { get() { throw Error('cross-origin'); } } });
  f.window.top = { frames: [opaque] };
  try {
    assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'destination' }), 'found', 1000), false);
    assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'unknown' }), 'missing', 1000).kind, 'link');
  } finally { f.hook.off(); }
});

for (const [kind, type] of [['button', undefined], ['button', 'invalid'], ['button', 'submit'], ['input', 'submit'], ['input', 'image']])
  for (const target of ['', '_self', '_blank']) test('CR4 native form owner and type decide submit disposition: ' + [kind, type, target], () => {
    const f = hookFixture(), form = new f.Element('form', { target });
    const control = kind === 'button' ? new f.HTMLButtonElement({ type }, form) : new f.HTMLInputElement({ type }, form);
    const span = new f.Element('span'); span.parentElement = control;
    // Captured IDL getters and attribute methods must survive later page overrides.
    Object.defineProperties(control, { form: { get() { throw Error('page form getter'); } },
      type: { get() { throw Error('page type getter'); } } });
    control.getAttribute = () => { throw Error('page attribute getter'); };
    try { assert.equal(f.hook.prepare(span, 'submit', 1000), target === '_blank'); }
    finally { f.hook.off(); }
  });

test('CR4 native submit formtarget overrides its form target and non-submit buttons remain commands', () => {
  const f = hookFixture(), form = new f.Element('form', { target: '_blank' });
  try {
    assert.equal(f.hook.prepare(new f.HTMLButtonElement({ formtarget: '_self' }, form), 'self', 1000), false);
    assert.equal(f.hook.prepare(new f.HTMLButtonElement({ type: 'button' }, form), 'button', 1000), true);
    f.hook.finish('button');
    assert.equal(f.hook.prepare(new f.HTMLInputElement({ type: 'reset' }, form), 'reset', 1000), true);
  } finally { f.hook.off(); }
});

for (const labelled of [false, true]) for (const row of [
  { form: '_blank', expected: true },
  { form: 'new-context', expected: true },
  { form: '_self', control: '_blank', expected: true },
  { form: '_blank', control: '', base: '_blank', expected: false },
  { form: '_blank', control: '_self', expected: false },
  { base: '_blank', expected: true },
  { base: 'new-context', expected: true },
  { form: 'existing-frame', expected: false },
  { form: 'own-window', expected: false },
  { base: '_blank', form: '', expected: false },
]) test('CR7 submit destination precedence, label=' + labelled + ': ' + JSON.stringify(row), () => {
  const f = hookFixture(), child = {};
  f.window.name = 'own-window'; f.window.frames = Object.assign([child], { 'existing-frame': child });
  f.document.querySelector = () => row.base === undefined ? null : new f.Element('base', { target: row.base });
  const form = new f.Element('form', row.form === undefined ? {} : { target: row.form });
  const submit = new f.HTMLInputElement({ type: 'submit', ...(row.control === undefined ? {} : { formtarget: row.control }) }, form);
  const node = labelled ? new f.HTMLLabelElement(submit) : submit;
  try { assert.equal(f.hook.prepare(node, 'target', 1000), row.expected); }
  finally { f.hook.off(); }
});

for (const mode of ['contenteditable', 'shadow', 'designMode']) for (const target of ['_self', '_blank', 'new-context'])
  test('CR7 link in editable ancestors stays plain: ' + mode + ' ' + target, () => {
    const f = hookFixture(), editor = new f.Element('div', { contenteditable: '' });
    const link = new f.Element('a', { href: '/landed', target }), text = new f.Element('span'); text.parentElement = link;
    if (mode === 'designMode') f.document.designMode = 'on';
    else if (mode === 'shadow') link.getRootNode = () => ({ host: editor });
    else link.parentElement = editor;
    try { assert.equal(f.hook.prepare(text, 'editable-link', 1000), false); }
    finally { f.hook.off(); }
  });

for (const target of ['_blank', 'new-context']) for (const island of ['link', 'wrapper', 'chip'])
  test('CR9 non-editable island keeps background input: ' + island + ' ' + target, () => {
    const f = hookFixture(), editor = new f.Element('div', { contenteditable: '' });
    const link = new f.Element(island === 'chip' ? 'button' : 'a', island === 'chip' ? {} : { href: '/landed', target });
    const barrier = island === 'wrapper' ? new f.Element('span', { contenteditable: 'false' }) : link;
    barrier.attrs.contenteditable = 'false'; barrier.parentElement = editor;
    if (barrier !== link) link.parentElement = barrier;
    const text = new f.Element('span'); text.parentElement = link;
    // A page override must not change the native inherited editability result.
    Object.defineProperty(text, 'isContentEditable', { get() { throw Error('page editable getter'); } });
    try {
      const result = f.hook.prepare(text, 'island', 1000);
      assert.equal(island === 'chip' ? result : result?.kind, island === 'chip' ? true : 'link');
    } finally { f.hook.off(); }
  });

test('CR9 re-enabled text and an editable link containing a non-editable child stay plain', () => {
  const f = hookFixture(), editor = new f.Element('div', { contenteditable: '' });
  const link = new f.Element('a', { href: '/landed', target: '_blank' }); link.parentElement = editor;
  const text = new f.Element('span', { contenteditable: 'false' }); text.parentElement = link;
  try {
    assert.equal(f.hook.prepare(text, 'editable-link', 1000), false);
    link.attrs.contenteditable = 'false'; text.attrs.contenteditable = 'true';
    assert.equal(f.hook.prepare(text, 'editable-text', 1000), false);
    text.attrs.contenteditable = 'false'; f.document.designMode = 'on';
    assert.equal(f.hook.prepare(text, 'design-mode', 1000), false);
  } finally { f.hook.off(); }
});

for (const multiple of [false, true]) test('CR5 select multiplicity comes from the captured native getter: ' + multiple, () => {
  const f = hookFixture(), select = new f.HTMLSelectElement(multiple ? { multiple: '' } : {}), option = new f.Element('option');
  option.parentElement = select;
  Object.defineProperty(select, 'multiple', { get() { throw Error('page multiple getter'); } });
  select.getAttribute = () => { throw Error('page attribute getter'); };
  try {
    assert.equal(f.hook.prepare(select, 'select', 1000), !multiple); f.hook.finish('select');
    assert.equal(f.hook.prepare(option, 'option', 1000), !multiple);
  } finally { f.hook.off(); }
});

test('CR5 label forwarding uses the captured native control and submit ownership getters', () => {
  const f = hookFixture(), control = new f.HTMLInputElement({ type: 'submit' }, new f.Element('form'));
  const label = new f.HTMLLabelElement(control), text = new f.Element('span'); text.parentElement = label;
  Object.defineProperty(label, 'control', { get() { throw Error('page control getter'); } });
  try { assert.equal(f.hook.prepare(text, 'label', 1000), false); }
  finally { f.hook.off(); }
});

test('CR5 a label does not forward a click on an interactive descendant to its submit control', () => {
  const f = hookFixture(), submit = new f.HTMLInputElement({ type: 'submit' }, new f.Element('form'));
  const label = new f.HTMLLabelElement(submit), button = new f.HTMLButtonElement({ type: 'button' });
  button.parentElement = label; button.interactive = true;
  button.matches = () => false;
  try { assert.equal(f.hook.prepare(button, 'nested-command', 1000), true); }
  finally { f.hook.off(); }
});

test('CR5 labels for selects do not inherit an option-selection exception', () => {
  const f = hookFixture(), select = new f.HTMLSelectElement({ multiple: '' }), label = new f.HTMLLabelElement(select);
  try { assert.equal(f.hook.prepare(label, 'select-label', 1000), true); }
  finally { f.hook.off(); }
});

test('CR4 successful link dispatch that observes closure skips takeRequest and still settles', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.opener = 'parent'; f.entry.parent = { page: { isClosed: () => false } };
  let settled = false;
  f.entry.settlePopups = async () => { settled = true; };
  f.entry.page.evaluate = async fn => {
    if (String(fn).includes('takeRequest')) throw Error('must not read a closed page');
  };
  await backgroundClick(f.entry, f.locator, async () => { f.entry.closed = true; });
  assert.equal(settled, true);
});

test('CR4 self-close settles popup readiness against the living opener after native reparenting', async () => {
  const f = fixture(), root = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const parent = f.registry.tab(root.tab), closing = f.page('closing', parent.targetId);
  await f.registry.idle();
  const child = f.registry.tab(parent.popups[0].tab);
  child.page.evaluate = async () => true;
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), installing = new Promise(resolve => { entered = resolve; });
  let finished = false;
  const clicking = backgroundClick(child, { evaluate: async () => true }, async () => {
    child.cdp.emit('Page.windowOpen', {}); await closing.close();
    const survivor = f.page('reparented', parent.targetId), send = survivor.cdp.send;
    survivor.cdp.send = async (method, params) => {
      if (method === 'Runtime.evaluate') { entered(); await held; }
      return send(method, params);
    };
    throw Error('Target page has been closed');
  }).then(result => { finished = true; return result; });
  try {
    await installing;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(finished, false, 'backgroundClick must await the reparented popup installation');
  } finally { release(); await clicking; await f.registry.endTurn(); }
  assert.equal(parent.popups.length, 2);
});
