import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { fixture, controls, skip } from './fixtures/cr4-real.mjs';

for (const stop of [false, true]) test('CR4 real 300 ms main-thread load keeps modifiers hidden and popup background, stop=' + stop,
  { skip, timeout: 60000 }, async t => {
    const f = await fixture(t, `<button type="button">Loaded command</button><script>
      document.querySelector('button').addEventListener('pointerdown', () => {
        const until = performance.now() + 300; while (performance.now() < until) {}
      });
      document.querySelector('button').addEventListener('click', event => {
        window.modifiers = [event.ctrlKey, event.metaKey, event.getModifierState('Control'), event.getModifierState('Meta')];
        if (${stop}) event.stopImmediatePropagation();
        window.opened = !!window.open('/landed', 'loaded');
      });
    </script>`);
    await backgroundClick(f.entry, f.entry.page.getByRole('button'), undefined, { timeoutMs: 5000 });
    assert.deepEqual(await f.entry.page.evaluate(() => window.modifiers), [false, false, false, false]);
    assert.equal(await f.entry.page.evaluate(() => window.opened), true);
    assert.equal(f.entry.popups.length, 1);
    const child = f.registry.tab(f.entry.popups[0].tab);
    await child.page.waitForURL('**/landed');
    assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
  });

test('CR4 real popup opened by a self-closing child is ready before backgroundClick returns', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, `<button type="button">Continue</button><script>
    document.querySelector('button').onclick = () => {
      if (window.name === 'closing-child') { window.open('/landed', 'survivor'); window.close(); }
      else window.open('/child', 'closing-child');
    };
  </script>`);
  await backgroundClick(f.entry, f.entry.page.getByRole('button'), undefined, { timeoutMs: 5000 });
  assert.equal(f.entry.popups.length, 1);
  const child = f.registry.tab(f.entry.popups[0].tab);
  await child.page.waitForLoadState('load');
  const result = await backgroundClick(child, child.page.getByRole('button'), undefined, { timeoutMs: 5000 });
  assert.equal(child.page.isClosed(), true);
  assert.equal(f.entry.popups.length, 2, 'surviving popup must be adopted against its living native opener before returning');
  const survivor = f.registry.tab(f.entry.popups[1].tab);
  assert.equal(survivor.opener, f.entry.tab);
  let ready = false; survivor.ready.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, true, 'popup preparation is already complete when backgroundClick returns');
  assert.equal(await survivor.page.evaluate(() => !!window[Symbol.for('sleight.popup3')]), true);
  assert.equal(result?.closed === true || result === undefined, true);
  assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
});

for (const kind of ['sibling', 'grandchild', 'frame-attribute', 'earlier-popup'])
  test('CR4 real named link reuses existing context: ' + kind, { skip, timeout: 60000 }, async t => {
    const link = '<a href="/landed" target="destination">Continue here</a>';
    const html = kind === 'sibling' ? '<iframe src="/source"></iframe><iframe name="destination" src="/target"></iframe>'
      : kind === 'grandchild' ? link + '<iframe src="/nested"></iframe>'
      : kind === 'frame-attribute' ? link + '<iframe name="destination" src="/target"></iframe>'
      : `<button type="button" onclick="window.open('/target', 'destination')">Open</button>` + link;
    const f = await fixture(t, html, { '/source': link, '/target': '<p>Initial target</p>',
      '/nested': '<iframe name="destination" src="/target"></iframe>' });
    await f.entry.page.waitForLoadState('load');
    let source = f.entry.page, target;
    if (kind === 'earlier-popup') {
      await backgroundClick(f.entry, source.getByRole('button'), undefined, { timeoutMs: 5000 });
      target = f.registry.tab(f.entry.popups[0].tab).page;
      await target.waitForLoadState('load');
    } else {
      target = source.frames().find(frame => frame.name() === 'destination');
      if (kind === 'sibling') source = source.frames().find(frame => frame.url().endsWith('/source'));
      if (kind === 'frame-attribute') {
        const nextURL = target.url().replace('127.0.0.1', 'localhost');
        await f.entry.page.locator('iframe').evaluate((element, url) => { element.src = url; }, nextURL);
        await target.waitForURL(nextURL);
      }
    }
    const navigated = target.waitForURL('**/landed', { timeout: 5000 });
    await backgroundClick(f.entry, source.getByRole('link', { name: 'Continue here' }), undefined, { timeoutMs: 5000 });
    await navigated;
    assert.equal(f.context.pages().length, kind === 'earlier-popup' ? 3 : 2);
  });
