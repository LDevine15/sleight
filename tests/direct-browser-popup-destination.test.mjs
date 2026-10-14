import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { popupDestination } from '../plugins/sleight/lib/direct-browser/popups.mjs';

function destination({ attrs = {}, scripts = [], shadow = false } = {}) {
  class Element {
    getAttributeNames() { return Object.keys(attrs); }
    getAttribute(name) { return attrs[name] ?? null; }
  }
  const node = new Element();
  if (shadow) {
    node.getAttributeNames = () => { throw Error('page override called'); };
    node.getAttribute = () => { throw Error('page override called'); };
  }
  const document = { scripts, readyState: 'complete', title: 'Static destination',
    querySelectorAll(selector) {
      assert.ok(['*', '[onclick]'].includes(selector), 'unexpected destination selector');
      return selector === '*' || Object.hasOwn(attrs, 'onclick') ? [node] : [];
    } };
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${popupDestination})()`, {
    Element, document, window: { location: { href: 'https://fixture.invalid/popup' } },
  })));
}

for (const [name, code] of [
  ['onload', "if (window.opener) window.opener.postMessage('complete', location.origin)"],
  ['onerror', "window.opener.postMessage('complete', location.origin)"],
  ['onpageshow', 'parent.postMessage("complete", "*")'],
  ['onfocus', 'finishHandshake()'],
  ['onanimationstart', 'window[decodeURIComponent("opener")].postMessage("complete", "*")'],
  ['onclick', 'unknownHandler()'],
  ['ONLOAD', 'finishHandshake()'],
]) test(`destination ${name} handler cannot prove opener independence`, () => {
  assert.equal(destination({ attrs: { [name]: code } }).independent, false);
});

test('static destination metadata and empty event attributes stay readable', () => {
  const result = destination({ attrs: { id: 'rates', 'data-onload': 'page text', onload: '  ' } });
  assert.equal(result.independent, true);
  assert.equal(result.ready, true);
  assert.equal(result.url, 'https://fixture.invalid/popup');
  assert.equal(result.title, 'Static destination');
});

test('external scripts and inline opener source still refuse independently of attributes', () => {
  assert.equal(destination({ scripts: [{ src: '/app.js', textContent: '' }] }).independent, false);
  assert.equal(destination({ scripts: [{ textContent: 'window.opener.postMessage("complete", "*")' }] }).independent, false);
});

test('element property overrides cannot hide destination event attributes', () => {
  assert.equal(destination({ attrs: { onload: 'finishHandshake()' }, shadow: true }).independent, false);
});

test('a literal click handler that only closes its own window remains independent', () => {
  for (const onclick of ['window.close()', ' window . close ( ) ; '])
    assert.equal(destination({ attrs: { onclick } }).independent, true);
  for (const onclick of ['window.close(other)', 'window.close(); finishHandshake()', 'return window.close()', 'close()'])
    assert.equal(destination({ attrs: { onclick } }).independent, false);
  assert.equal(destination({ attrs: { onload: 'window.close()' } }).independent, false);
});
