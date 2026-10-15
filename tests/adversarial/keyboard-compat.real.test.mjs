import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, readOnly, skip } from './fixtures/bank.mjs';

// The hook replaces page-visible natives. A page that inspects them must see what it would see on a page the hook never ran in:
// the same length, name and Function.prototype.toString text, and no prototype property.
const probe = () => {
  const toString = Function.prototype.toString;
  const rows = {};
  const pick = (label, object, name, part = 'value') => {
    const fn = Object.getOwnPropertyDescriptor(object, name)?.[part];
    rows[label] = typeof fn !== 'function' ? 'missing' : JSON.stringify([fn.length, fn.name, toString.call(fn), Object.hasOwn(fn, 'prototype'),
      Object.keys(Object.getOwnPropertyDescriptor(fn, 'length')).join()]);
  };
  pick('addEventListener', EventTarget.prototype, 'addEventListener');
  for (const name of ['open', 'write', 'writeln']) pick('Document.' + name, Document.prototype, name);
  pick('window.open', window, 'open');
  pick('preventDefault', Event.prototype, 'preventDefault');
  pick('getModifierState', MouseEvent.prototype, 'getModifierState');
  pick('ctrlKey', MouseEvent.prototype, 'ctrlKey', 'get');
  pick('defaultPrevented', Event.prototype, 'defaultPrevented', 'get');
  pick('returnValue get', Event.prototype, 'returnValue', 'get');
  pick('returnValue set', Event.prototype, 'returnValue', 'set');
  pick('toString', Function.prototype, 'toString');
  rows.selfToString = toString.call(toString);
  rows.nativeText = [EventTarget.prototype.addEventListener, Document.prototype.open].map(fn => /\[native code\]/.test(String(fn))).join();
  return rows;
};

test('natives the hook replaces look native: same length, name and toString text as a page without the hook', { skip, timeout: 120000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<p>x</p>'), readOnly);
  const hooked = await f.page.evaluate(probe), clean = await b.foreign.evaluate(probe);
  assert.equal(await f.page.evaluate(() => !!window[Symbol.for('sleight.popup3')]), true, 'the hook must be present on the checked page');
  assert.equal(await b.foreign.evaluate(() => !!window[Symbol.for('sleight.popup3')]), false, 'the reference page must have no hook');
  assert.deepEqual(hooked, clean);
  assert.match(hooked.selfToString, /\[native code\]/);
});

test('natives look native inside a frame and after the key has been sent', { skip, timeout: 120000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<input id="a" aria-label="Search"><iframe srcdoc="<p>in</p>"></iframe>'), readOnly);
  const clean = await b.foreign.evaluate(probe);
  const result = await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(await f.page.evaluate(probe), clean);
  const frame = f.page.frames().find(x => x !== f.page.mainFrame());
  assert.ok(frame, 'srcdoc frame');
  assert.deepEqual(await frame.evaluate(probe), clean);
});
