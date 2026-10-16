import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { fixture, skip } from './fixtures/cr4-real.mjs';

test('CR8 real deferred pointer handlers first read plain modifiers after dispatch', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, `<button type="button"><span>Command</span></button><script>
    window.reads = [];
    for (const type of ['pointerdown','mousedown','pointerup','mouseup','click'])
      document.querySelector('button').addEventListener(type, event => {
        setTimeout(() => reads.push({ type, trusted: event.isTrusted, path: event.composedPath().length,
          modifiers: [event.ctrlKey,event.metaKey,event.getModifierState('Control'),event.getModifierState('Meta')] }),100);
      });
  </script>`);
  await backgroundClick(f.entry, f.entry.page.locator('button span'), undefined, { timeoutMs: 5000 });
  await f.entry.page.waitForFunction(() => reads.length === 5);
  const reads = await f.entry.page.evaluate(() => reads);
  assert.deepEqual(reads.map(read => read.type), ['pointerdown','mousedown','pointerup','mouseup','click']);
  assert.equal(reads.find(read => read.type === 'mouseup').modifiers[1], false, 'deferred mouseup.metaKey');
  for (const read of reads) {
    assert.equal(read.trusted, true, read.type);
    assert.equal(read.path, 0, read.type + ' has finished dispatch');
    assert.deepEqual(read.modifiers, [false,false,false,false], read.type);
  }
  assert.equal(f.context.pages().length, 2);
  assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
});
