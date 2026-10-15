import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { fixture, controls, skip } from './fixtures/cr4-real.mjs';

test('CR6 real delayed handlers see a plain click and no modifier keyboard events', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, `<button type="button">Command</button><script>
    window.keys = []; window.reads = [];
    for (const type of ['keydown','keyup']) addEventListener(type, e => keys.push([type,e.key]));
    document.querySelector('button').onclick = e => {
      const read = () => reads.push([e.ctrlKey,e.metaKey,e.getModifierState('Control'),e.getModifierState('Meta')]);
      read(); Promise.resolve().then(read); setTimeout(read,100);
    };
  </script>`);
  await backgroundClick(f.entry, f.entry.page.getByRole('button'), undefined, { timeoutMs: 5000 });
  await f.entry.page.waitForFunction(() => reads.length === 3);
  assert.deepEqual(await f.entry.page.evaluate(() => reads), Array.from({ length: 3 }, () => [false,false,false,false]));
  assert.deepEqual(await f.entry.page.evaluate(() => keys), []);
});

for (const [kind, control] of Object.entries(controls)) test('CR6 real empty formtarget inherits blank form: ' + kind,
  { skip, timeout: 60000 }, async t => {
    const f = await fixture(t, '<form action="/landed" target="_blank">' + control.replace('<', '<').replace(/<(button|input)/, '<$1 formtarget=""') + '</form>');
    const next = f.context.waitForEvent('page');
    await backgroundClick(f.entry, f.entry.page.getByRole('button', { name: 'Send' }), undefined, { timeoutMs: 5000 });
    const child = await next; await child.waitForURL('**/landed*');
    assert.match(f.entry.page.url(), /\/start$/);
    assert.equal(f.context.pages().length, 3);
  });

for (const rel of ['', 'noopener', 'noreferrer']) test('CR6 real named link preserves a session-owned name across clicks: ' + (rel || 'default'),
  { skip, timeout: 60000 }, async t => {
    const f = await fixture(t, `<a href="/landed" target="atlas-child" rel="${rel}">Open</a>`);
    const source = f.entry.page, link = source.getByRole('link');
    await backgroundClick(f.entry, link, undefined, { timeoutMs: 5000 });
    const rows = await f.registry.list(), child = f.registry.tab(rows.find(row => row.tab !== f.entry.tab).tab);
    await child.page.waitForURL('**/landed');
    assert.equal(await child.page.evaluate(() => window.name), 'atlas-child');
    // Links keep the no-opener disposition of a modified link. Native window.open
    // has separate coverage and keeps its own opener semantics.
    assert.equal(await child.page.evaluate(() => window.opener === null), true);
    await source.locator('a').evaluate(el => { el.href = '/landed?second'; });
    await backgroundClick(f.entry, link, undefined, { timeoutMs: 5000 });
    await child.page.waitForURL('**/landed?second');
    assert.equal(f.context.pages().length, 3);
    assert.equal((await f.registry.list()).length, 2);
    assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
  });
