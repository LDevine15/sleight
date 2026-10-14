import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as popups from '../plugins/sleight/lib/direct-browser/popups.mjs';
import { browserError, BrowserFailure } from '../plugins/sleight/lib/direct-browser/errors.mjs';

function page({ tag = 'button', attrs = {}, handler, scripts = [] } = {}) {
  const listeners = new Map(); let nativeOpens = 0;
  class Element {
    constructor() { this.attrs = attrs; this.localName = tag; this.parentElement = null; this.isConnected = true; this.onclick = handler ?? null; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    closest() { return null; }
  }
  const node = new Element(), document = { scripts, querySelector: () => null, baseURI: 'https://fixture.invalid/shop/' };
  const window = { document, location: new URL(document.baseURI), open() { nativeOpens++; },
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  window.top = window;
  const context = vm.createContext({ window, document, Element, URL, Reflect, Symbol, Function, FormData, URLSearchParams });
  assert.equal(vm.runInContext(`(${popups.popupHook})('strict', 'fixture:turn')`, context), true);
  return { window, node, context, listeners, nativeOpens: () => nativeOpens,
    prepare() {
      assert.equal(typeof popups.popupIntent, 'function', 'checked popup preflight is missing');
      context.node = node;
      return JSON.parse(JSON.stringify(vm.runInContext(`(${popups.popupIntent}).call(node)`, context)));
    } };
}

test('target blank link prepares its exact GET destination and captures no native open', () => {
  const f = page({ tag: 'a', attrs: { href: '/shop/shipping', target: '_blank' } });
  assert.deepEqual(f.prepare(), { kind: 'link', url: 'https://fixture.invalid/shop/shipping', name: '', nullReturned: false });
  let prevented = false;
  f.listeners.get('click')({ type: 'click', composedPath: () => [f.node], preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.nativeOpens(), 0);
  assert.equal(f.window[Symbol.for('sleight.popup2')].request.url, 'https://fixture.invalid/shop/shipping');
});

test('literal same origin window open captures its named destination and returns null', () => {
  const f = page({ handler: function onclick() { window.open('/shop/size-guide', 'sizeguide', 'popup,width=420'); } });
  assert.deepEqual(f.prepare(), { kind: 'window', url: 'https://fixture.invalid/shop/size-guide', name: 'sizeguide', nullReturned: true });
  assert.equal(f.window.open('/shop/size-guide', 'sizeguide', 'popup,width=420'), null);
  assert.equal(f.nativeOpens(), 0); assert.equal(f.window[Symbol.for('sleight.popup2')].request.name, 'sizeguide');
});

for (const [name, options, reason] of [
  ['cross origin sign in', { handler: () => window.open('https://identity.invalid/authorize', 'signin', 'popup') }, 'cross-origin'],
  ['opener read later', { handler: () => window.open('/popup', 'named'), scripts: [{ textContent: 'setTimeout(() => window.opener.postMessage({}), 50)' }] }, 'opener'],
  ['returned window dependency', { handler: function() { const popup = window.open('/popup'); popup.postMessage({}); } }, 'uncertain'],
  ['dynamic destination', { handler: () => window.open(destination, 'named') }, 'uncertain'],
  ['external popup script', { handler: () => window.open('/popup'), scripts: [{ src: 'https://fixture.invalid/app.js', textContent: '' }] }, 'uncertain'],
  ['cross origin blank link', { tag: 'a', attrs: { href: 'https://other.invalid/', target: '_blank' } }, 'cross-origin'],
]) test('popup preflight refuses ' + name + ' before the handler or input runs', () => {
  const f = page(options), result = f.prepare();
  assert.equal(result.code, 'OPENER_REQUIRED'); assert.equal(result.reason, reason);
  assert.equal(f.nativeOpens(), 0); assert.equal(f.window[Symbol.for('sleight.popup2')].request, null);
});

test('same page ordinary control has no popup request', () => {
  const f = page({ handler: function onclick() { document.querySelector('dialog').showModal(); } });
  assert.deepEqual(f.prepare(), { kind: 'none' });
});

test('unarmed and mismatched opens remain cancelled and cannot queue a destination', () => {
  const f = page({ handler: () => window.open('/popup', 'named') });
  f.window.open('/unarmed'); assert.equal(f.window[Symbol.for('sleight.popup2')].request, null);
  f.prepare(); f.window.open('/different', 'named');
  assert.equal(f.window[Symbol.for('sleight.popup2')].request, null); assert.equal(f.nativeOpens(), 0);
});

test('opener refusal names the engine browser path and keeps no-input effect', () => {
  const result = browserError(new BrowserFailure('OPENER_REQUIRED', { effect: 'none' }), {
    tab: 'tfixture', observation: { code: 'OPENER_REQUIRED', reason: 'cross-origin' } });
  assert.equal(result.effect, 'none'); assert.equal(result.code, 'OPENER_REQUIRED');
  assert.match(result.message, /opener|uncertain/); assert.match(result.message, /engine browser path/);
});

test('a targeted GET form captures the serialized query without any POST replay', () => {
  const f = page({ tag: 'form', attrs: { target: 'results', method: 'get', action: '/search?old=discarded' } });
  f.context.FormData = class { constructor() { return new URLSearchParams([['query', 'stone mug'], ['sort', 'price']]); } };
  assert.deepEqual(f.prepare(), { kind: 'form', url: 'https://fixture.invalid/search?query=stone+mug&sort=price', name: 'results', nullReturned: false });
  let prevented = false;
  f.listeners.get('submit')({ type: 'submit', target: f.node, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.nativeOpens(), 0);
  assert.equal(f.window[Symbol.for('sleight.popup2')].request.url, 'https://fixture.invalid/search?query=stone+mug&sort=price');
});

test('a targeted POST form refuses without creating a replacement GET request', () => {
  const f = page({ tag: 'form', attrs: { target: '_blank', method: 'post', action: '/submit' } });
  assert.deepEqual(f.prepare(), { code: 'OPENER_REQUIRED', reason: 'post' });
  assert.equal(f.window[Symbol.for('sleight.popup2')].armed, null);
  assert.equal(f.nativeOpens(), 0);
});
