import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { fixture, skip } from './fixtures/cr4-real.mjs';

for (const target of ['_blank', 'new-destination']) for (const island of ['link', 'wrapper', 'chip'])
  test(`CR9 real non-editable ${island} opens in background: ${target}`, { skip, timeout: 60000 }, async t => {
    const control = island === 'chip'
      ? `<button type="button" onclick="window.open('/landed','${target}')"><span id="go">Mention</span></button>`
      : `<a href="/landed" target="${target}"${island === 'link' ? ' contenteditable="false"' : ''}><span id="go">Island link</span></a>`;
    const html = '<div contenteditable>' + (island === 'link' ? control : `<span contenteditable="false">${control}</span>`) + '</div>';
    const f = await fixture(t, html, {}, { observeTabs: true }), page = f.entry.page, choices = [];
    const before = await f.tabState(), next = f.context.waitForEvent('page', { timeout: 5000 });
    assert.equal(await page.locator('#go').evaluate(el => el.isContentEditable), false);
    await page.evaluate(() => {
      window.clicks = 0;
      document.querySelector('#go').addEventListener('click', event => {
        window.clicks++; window.flags = [event.ctrlKey, event.metaKey, event.getModifierState('Control'), event.getModifierState('Meta')];
      });
    });
    const locator = page.locator('#go');
    await backgroundClick(f.entry, locator, options => {
      choices.push(options); return locator.click({ ...options, timeout: 5000 });
    }, { timeoutMs: 5000 });
    const child = await next; await child.waitForURL('**/landed**'); await f.registry.idle();
    const after = await f.tabState(), opened = after.filter(tab => !before.some(old => old.id === tab.id));
    t.diagnostic('island disposition ' + JSON.stringify({ island, target, choices, opened }));
    assert.deepEqual(choices, [{ modifiers: ['ControlOrMeta'] }]);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, child.url());
    assert.equal(opened[0].active, false);
    assert.deepEqual(after.filter(tab => tab.active).map(tab => tab.id), before.filter(tab => tab.active).map(tab => tab.id));
    assert.deepEqual(await page.evaluate(() => [window.clicks, window.flags]), [1, [false, false, false, false]]);
    assert.match(page.url(), /\/start$/);
    assert.equal(f.context.pages().length, 3);
    assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
  });

test('CR9 tab observer detects a foreground plain island link', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<div contenteditable><a id="go" contenteditable="false" href="/landed" target="_blank">Island</a></div>',
    {}, { observeTabs: true });
  const before = await f.tabState(), next = f.context.waitForEvent('page', { timeout: 5000 });
  await f.entry.page.locator('#go').click();
  const child = await next; await child.waitForURL('**/landed**');
  const opened = (await f.tabState()).filter(tab => !before.some(old => old.id === tab.id));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].active, true);
});
