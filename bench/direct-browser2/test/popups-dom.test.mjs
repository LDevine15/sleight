// Disposable headless browser/contexts only; no owner profiles or engine.
// Headless semantic fixtures do not qualify transient native focus or Space behavior.
import { describe, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { popupHook } from '../popups.mjs';

const playwrightPath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
let skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real page test is reserved for sleight-arch' :
  !existsSync(playwrightPath) && 'playwright-core is unavailable';
let chromium;
if (!skip) {
  ({ chromium } = await import(pathToFileURL(playwrightPath).href));
  if (!existsSync(chromium.executablePath())) skip = 'disposable Chromium executable is unavailable';
}

describe('BP2-8 native popup semantics on disposable Chromium', () => {
  let browser;
  const fixture = async t => {
    const context = await browser.newContext();
    t.after(() => context.close());
    context.setDefaultTimeout(5000);
    return { context, page: await context.newPage() };
  };
  let server;
  let origin;
  before(async () => {
    if (skip) return;
    browser = await chromium.launch({ headless: true, channel: 'chromium' });
    server = http.createServer((request, response) => {
      if (request.url === '/coop') response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>popup fixture</title><p>local fixture</p>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    try { await browser?.close(); } finally {
      if (server?.listening) await new Promise(resolve => server.close(resolve));
    }
  });

  test('observe preserves about:blank document.write, opener postMessage and named reuse', { skip }, async t => {
    const { context, page } = await fixture(t);
    await context.addInitScript(`(${popupHook})('observe')`);
    await page.goto(origin);
    const opening = context.waitForEvent('page');
    await page.evaluate(() => {
      window.messages = [];
      addEventListener('message', event => window.messages.push(event.data));
      window.first = window.open('about:blank', 'reuse');
      window.first.document.write('<p id="fixture">written</p>');
      window.first.opener.postMessage('fixture-message', '*');
    });
    const child = await opening;
    assert.equal(await child.locator('#fixture').textContent(), 'written');
    await page.evaluate(() => window.second = window.open('about:blank', 'reuse'));
    assert.equal(await page.evaluate(() => first === second), true);
    await page.waitForFunction(() => messages.includes('fixture-message'));
    assert.equal(context.pages().length, 2);
  });

  test('observe preserves noreferrer and COOP opener isolation', { skip }, async t => {
    const { context, page } = await fixture(t);
    await context.addInitScript(`(${popupHook})('observe')`);
    await page.goto(origin);
    const first = context.waitForEvent('page');
    await page.evaluate(url => window.open(url, '_blank', 'noreferrer'), origin);
    const noReferrer = await first;
    await noReferrer.waitForLoadState();
    assert.deepEqual(await noReferrer.evaluate(() => ({ opener: !!opener, referrer: document.referrer })), { opener: false, referrer: '' });
    const second = context.waitForEvent('page');
    await page.evaluate(url => window.open(url), `${origin}/coop`);
    const coop = await second;
    await coop.waitForLoadState();
    assert.equal(await coop.evaluate(() => !!opener), false);
  });

  test('strict hook refuses native opening; unrelated page has no hook', { skip }, async t => {
    const { context, page } = await fixture(t);
    await page.addInitScript(`(${popupHook})('strict')`);
    await page.goto(origin);
    const other = await context.newPage();
    await other.goto(origin);
    assert.equal(await page.evaluate(() => window.open('about:blank')), null);
    assert.equal(await page.evaluate(() => window[Symbol.for('sleight.popup2')].blocked), 'BACKGROUND_UNAVAILABLE');
    assert.equal(await other.evaluate(() => !!window[Symbol.for('sleight.popup2')]), false);
    assert.equal(context.pages().length, 2);
  });
});
