import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let allocations = 0, frees = 0;
const context = vm.createContext({ ObjC: { import() {} }, $: {
  malloc: () => { allocations++; return { buffer: true }; }, free: () => { frees++; },
} });
vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
const plain = { font: 'regular', color: 'black' }, bold = { font: 'bold', color: 'black' };
const attributed = values => ({ length: values.length,
  attributesAtIndexEffectiveRange: (index, range) => {
    assert.ok(range?.buffer, 'native effective range uses an allocated output buffer');
    const attrs = values[index];
    return attrs && { count: Object.keys(attrs).length, isEqualToDictionary: other => JSON.stringify(attrs) === other.key, key: JSON.stringify(attrs) };
  } });

test('default font and color remain plain against the paragraph baseline', () => {
  assert.equal(context.attributedTextHasAttributes(attributed([plain, plain, plain]), 3, 1), false);
  assert.equal(allocations, frees);
});

test('mixed runs and uniform bold inside a plain paragraph count as formatting', () => {
  assert.equal(context.attributedTextHasAttributes(attributed([plain, plain, bold]), 3, 1), true);
  assert.equal(context.attributedTextHasAttributes(attributed([plain, bold, bold]), 3, 1), true);
  assert.equal(context.attributedTextHasAttributes(attributed([bold, plain, bold]), 3, 1), true);
  assert.equal(allocations, frees);
});

test('a missing or partial attributed range cannot permit a plain text move', () => {
  for (const value of [null, { length: 3 }, attributed([plain, plain]), { length: 3, attributesAtIndexEffectiveRange: () => null }]) {
    assert.throws(() => context.attributedTextHasAttributes(value, 3));
  }
  assert.equal(allocations, frees);
});
