import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteTabError } from '../plugins/sleight/lib/tab-errors.mjs';

const stack = '\n    at __playwrightEvaluate (<anonymous>:8:4)';
test('TypeError: parseInt is not a function inside evaluate gets restricted-scope and documented read advice', () => {
  const raw = 'TypeError: parseInt is not a function';
  const original = raw + stack, out = rewriteTabError(original);
  assert.ok(out.startsWith(original));
  assert.match(out, /restricted read-only scope/);
  assert.match(out, /locator\.textContent\(\{\}\)/);
  assert.match(out, /locator\.getAttribute\(name, \{\}\)/);
  assert.match(out, /tab\.playwright\.domSnapshot\(\)/);
  assert.doesNotMatch(out, /globalThis\.|window\.[\w]+\s*=|eval\(|new Function|\.click\(/);
});
for (const raw of ['TypeError: getEventListeners is not a function', 'ReferenceError: getEventListeners is not defined']) {
  test(`${raw} inside evaluate says no supported read lists event listeners`, () => {
    const original = raw + stack, out = rewriteTabError(original);
    assert.ok(out.startsWith(original));
    assert.match(out, /restricted read-only scope, and no supported read lists event listeners/);
    assert.doesNotMatch(out, /globalThis\.|eval\(|new Function|\.click\(/);
  });
}
test('parseInt guidance reads a value and parses returned data outside the callback', () => {
  const out = rewriteTabError('TypeError: parseInt is not a function' + stack);
  assert.match(out, /apply parseInt to it in the REPL/);
  assert.doesNotMatch(out, /rerun|replay|transfer.*callback/);
});
test('ordinary JavaScript and unrecognized missing functions remain unchanged', () => {
  for (const raw of [
    'TypeError: parseInt is not a function',
    'ReferenceError: getEventListeners is not defined',
    'TypeError: customFunction is not a function' + stack,
    'caller output: TypeError: parseInt is not a function' + stack,
  ]) assert.equal(rewriteTabError(raw), raw);
});
