import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ ObjC: { import() {} } });
vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
const attributed = counts => ({ length: counts.length,
  attributesAtIndexEffectiveRange: (index, range) => { assert.equal(range, null); return { count: counts[index] }; } });

test('attributed range distinguishes plain text from formatting anywhere in the selection', () => {
  assert.equal(context.attributedTextHasAttributes(attributed([0, 0, 0]), 3), false);
  assert.equal(context.attributedTextHasAttributes(attributed([0, 0, 2]), 3), true);
  assert.equal(context.attributedTextHasAttributes(attributed([1, 0, 0]), 3), true);
});

test('a missing or partial attributed range cannot permit a plain text move', () => {
  for (const value of [null, { length: 3 }, attributed([0, 0]), { length: 3, attributesAtIndexEffectiveRange: () => null }]) {
    assert.throws(() => context.attributedTextHasAttributes(value, 3));
  }
});
