import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { fixture, controls, skip } from './fixtures/cr4-real.mjs';

for (const method of ['GET', 'POST']) for (const [kind, control] of Object.entries(controls))
  for (const blank of [true]) test(`CR4 real ${method} ${kind} submit ${blank ? 'opens background target blank' : 'navigates current tab'}`,
    { skip, timeout: 60000 }, async t => {
      const f = await fixture(t, `<form method="${method}" action="/landed"${blank ? ' target="_blank"' : ''}>
        <input name="fixture" value="sent">${control}</form>`);
      const page = f.entry.page, locator = page.getByRole('button', { name: 'Send' });
      const nextPage = f.context.waitForEvent('page', { timeout: 5000 }), clicks = [];
      await backgroundClick(f.entry, locator, options => {
        clicks.push(options); return locator.click({ ...options, timeout: 5000 });
      }, { timeoutMs: 5000 });
      const child = await nextPage;
      await child.waitForURL('**/landed**');
      assert.deepEqual(clicks, [{ modifiers: ['ControlOrMeta'] }], 'CR7 new-context form submission keeps background disposition');
      assert.match(page.url(), /\/start$/);
      assert.equal(f.context.pages().length, 3, 'sentinel, original tab and background form destination');
      t.diagnostic('submit disposition ' + JSON.stringify({ method, kind, blank, urls: f.context.pages().map(page => page.url()), requests: f.requests }));
      assert.ok(f.requests.some(request => request.url.startsWith('/landed') && request.method === method));
      assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
    });
