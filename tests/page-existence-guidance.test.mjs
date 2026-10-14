import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { rewriteTabError } from '../plugins/sleight/lib/tab-errors.mjs';

const stack = '\n    at __playwrightEvaluate (<anonymous>:8:4)';
for (const reason of [
  "Cannot read properties of null (reading 'children')",
  "Cannot read properties of undefined (reading 'length')",
  "Cannot read properties of null (reading 'textContent')",
]) test(`${reason} gets a guarded read without a guessed selector`, () => {
  const raw = 'TypeError: ' + reason + stack, out = rewriteTabError(raw);
  assert.ok(out.startsWith(raw));
  assert.match(out, /document\.querySelector\(selector\) !== null/);
  assert.match(out, /observedSelector/);
  assert.match(out, /Use the selector already observed/);
  assert.doesNotMatch(out, /querySelector\(["']|\.click\(|\.fill\(|\.children\b/);
});
test('the suggested read returns existence without dereferencing a missing element', async () => {
  const out = rewriteTabError("TypeError: Cannot read properties of null (reading 'children')" + stack);
  const code = /Next read: `([^`]+)`/.exec(out)?.[1];
  assert.ok(code);
  for (const element of [null, Object.freeze({})]) {
    let queries = 0, reads = 0;
    const document = new Proxy({ querySelector(selector) { assert.equal(selector, '#observed'); queries++; return element; } }, {
      get(target, key) { if (!(key in target)) throw new Error(`unsupported document method ${String(key)}`); return target[key]; },
    });
    const playwright = new Proxy({ async evaluate(fn, arg) { reads++; return fn(arg); } }, {
      get(target, key) { if (!(key in target)) throw new Error(`unsupported method ${String(key)}`); return target[key]; },
    });
    assert.equal(await runInNewContext(`(async () => ${code})()`, { tab: { playwright }, document, observedSelector: '#observed' }), element !== null);
    assert.equal(reads, 1); assert.equal(queries, 1);
  }
});
test('unrelated and ordinary JavaScript exceptions are unchanged', () => {
  for (const raw of [
    "TypeError: Cannot read properties of null (reading 'children')",
    'TypeError: other is not a function' + stack,
    "caller output: TypeError: Cannot read properties of null (reading 'children')" + stack,
  ]) assert.equal(rewriteTabError(raw), raw);
});
