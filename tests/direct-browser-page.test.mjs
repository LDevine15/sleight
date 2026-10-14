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
  assert.equal(value, 'landed'); assert.deepEqual(f.calls, [['click', {}]]);
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

function hookFixture() {
  class Event { composedPath() { return this.nodes; } stopImmediatePropagation() { this.stopped = true; } }
  class MouseEvent extends Event {
    get ctrlKey() { return this.control; }
    get metaKey() { return this.meta; }
    getModifierState(name) { return name === 'Control' ? this.control : this.meta; }
  }
  class Element {
    constructor(localName = 'button', attrs = {}) { Object.assign(this, { localName, attrs, isConnected: true }); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    getRootNode() { return {}; }
  }
  class EventTarget {
    addEventListener(name, fn) { (this.listeners[name] ??= new Set()).add(fn); }
    removeEventListener(name, fn) { this.listeners[name]?.delete(fn); }
  }
  const opens = [], window = { listeners: {}, open(...args) { opens.push(args); return { real: true }; } };
  const document = { baseURI: 'https://fixture.invalid/', scripts: [{ textContent: "window.open('/identity')" }], querySelector: () => null };
  vm.runInNewContext(`(${popupHook})()`, { window, document, navigator: { userActivation: { isActive: true } },
    MouseEvent, Element, Event, EventTarget, URL, setTimeout, clearTimeout });
  const hook = window[Symbol.for('sleight.popup3')];
  return { window, document, hook, Element, MouseEvent, opens };
}

test('serialized popup hook hides only the prepared trusted click and strips window sizing', () => {
  const f = hookFixture(), button = new f.Element();
  try {
    assert.equal(f.hook.prepare(button, 'click', 1000), true);
    const key = { key: 'Control', type: 'keydown', isTrusted: true };
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
    ['click', {}], ['openChild', 'https://fixture.invalid/shipping'],
  ]);
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
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link], defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; } });
    for (const listener of f.window.listeners.click) listener(click);
    assert.equal(click.defaultPrevented, true);
    assert.equal(f.hook.takeRequest('link').url, 'https://fixture.invalid/shipping');
    assert.equal(f.hook.takeRequest('link'), undefined);
    f.hook.finish('link'); f.hook.prepare(link, 'cancelled', 1000);
    const cancelled = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link], defaultPrevented: true });
    for (const listener of f.window.listeners.click) listener(cancelled);
    assert.equal(f.hook.takeRequest('cancelled'), undefined);
    assert.deepEqual(f.opens, []);
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
