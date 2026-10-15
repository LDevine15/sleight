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
      await backgroundClick(f.entry, locator, undefined, { timeoutMs: 5000 });
      t.diagnostic('submit disposition ' + JSON.stringify({ method, kind, blank, urls: f.context.pages().map(page => page.url()), requests: f.requests }));
      if (blank) {
        const rows = await f.registry.list();
        assert.equal(rows.length, 2); assert.match(page.url(), /\/start$/);
        const child = f.registry.tab(rows.find(row => row.tab !== f.entry.tab).tab);
        await child.page.waitForURL('**/landed**');
      } else {
        await page.waitForURL('**/landed**', { timeout: 3000 });
        assert.equal(f.context.pages().length, 2, 'only sentinel and original tab remain');
        assert.equal((await f.registry.list()).length, 1);
      }
      assert.ok(f.requests.some(request => request.url.startsWith('/landed') && request.method === method));
      assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
    });

