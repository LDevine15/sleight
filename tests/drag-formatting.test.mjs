import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { macCommandSkip } from './requirements.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8');
const context = vm.createContext({ ObjC: { import() {} }, $: {} });
vm.runInContext(source, context);
const plain = { font: 'regular', color: 'black' }, bold = { font: 'bold', color: 'black' };
const attributed = values => ({ length: values.length,
  attributesAtIndexEffectiveRange: (index, range) => {
    // JXA refuses a malloc'd buffer here ("Ref has incompatible type"); the optional range is passed as null.
    assert.equal(range, null, 'the effective range is not requested');
    const attrs = values[index];
    return attrs && { count: Object.keys(attrs).length, isEqualToDictionary: other => JSON.stringify(attrs) === other.key, key: JSON.stringify(attrs) };
  } });

test('default font and color remain plain against the paragraph baseline', () => {
  assert.equal(context.attributedTextHasAttributes(attributed([plain, plain, plain]), 3, 1), false);
});

test('mixed runs and uniform bold inside a plain paragraph count as formatting', () => {
  assert.equal(context.attributedTextHasAttributes(attributed([plain, plain, bold]), 3, 1), true);
  assert.equal(context.attributedTextHasAttributes(attributed([plain, bold, bold]), 3, 1), true);
  assert.equal(context.attributedTextHasAttributes(attributed([bold, plain, bold]), 3, 1), true);
});

test('a missing or partial attributed range cannot permit a plain text move', () => {
  for (const value of [null, { length: 3 }, attributed([plain, plain]), { length: 3, attributesAtIndexEffectiveRange: () => null }]) {
    assert.throws(() => context.attributedTextHasAttributes(value, 3));
  }
});

// The mock above can't catch a bridging fault, so the production function also runs in JXA on real
// attributed strings. No app, window or Accessibility call is involved.
test('production JXA reads attributes of real attributed strings without a bridging error', { skip: macCommandSkip('osascript') }, () => {
  const probe = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source + `
    function run() {
      const make = boldFrom => {
        const s = $.NSMutableAttributedString.alloc.init;
        s.mutableString.appendString('ab cd');
        const plainFont = $.NSDictionary.dictionaryWithObjectForKey($.NSFont.systemFontOfSize(12), $.NSFontAttributeName);
        s.setAttributesRange(plainFont, $.NSMakeRange(0, 5));
        if (boldFrom !== null) s.setAttributesRange($.NSDictionary.dictionaryWithObjectForKey($.NSFont.boldSystemFontOfSize(12), $.NSFontAttributeName), $.NSMakeRange(boldFrom, 5 - boldFrom));
        return s;
      };
      return JSON.stringify([attributedTextHasAttributes(make(null), 5, 3), attributedTextHasAttributes(make(3), 5, 3), attributedTextHasAttributes(make(4), 5, 3)]);
    }`], { encoding: 'utf8', timeout: 15000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [false, true, true]);
});
