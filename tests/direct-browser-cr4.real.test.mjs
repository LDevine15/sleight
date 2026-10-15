import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { createPageRegistry, backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';

const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real-page qualification belongs to sleight-arch host runner'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;

async function fixture(t, html) {
  const sockets = new Set(), requests = [];
  let browser, registry;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, method: request.method, body });
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url.startsWith('/landed') ? '<h1>Landed</h1>' : html);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    try {
      if (registry) assert.equal((await registry.endTurn()).cleanedUp, true);
      await browser?.close();
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    t.diagnostic('cleanup: owned browser and pages closed, loopback server and sockets closed; no persistent profile');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext(), sentinel = await context.newPage();
  await sentinel.goto('about:blank');
  const before = await sentinel.evaluate(() => document.visibilityState);
  const session = await browser.newBrowserCDPSession();
  registry = createPageRegistry({ browser, session, context, timeoutMs: 10000, popupWaitMs: 5000 });
  const { tab } = await registry.openTab({ url: 'http://127.0.0.1:' + server.address().port + '/start' });
  const entry = registry.tab(tab);
  return { registry, context, entry, requests, sentinel, before };
}

const controls = { button: '<button>Send</button>', submit: '<input type="submit" value="Send">',
  image: '<input type="image" alt="Send" width="30" height="30" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E">' };
for (const method of ['GET', 'POST']) for (const [kind, control] of Object.entries(controls))
  for (const blank of [false, true]) test(`CR4 real ${method} ${kind} submit ${blank ? 'opens background target blank' : 'navigates current tab'}`,
    { skip, timeout: 60000 }, async t => {
      const f = await fixture(t, `<form method="${method}" action="/landed"${blank ? ' target="_blank"' : ''}>
        <input name="fixture" value="sent">${control}</form>`);
      const page = f.entry.page, locator = page.getByRole('button', { name: 'Send' });
      await backgroundClick(f.entry, locator, undefined, { timeoutMs: 5000 });
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
  assert.equal(child.popups.length, 1, 'surviving popup must be adopted before returning');
  const survivor = f.registry.tab(child.popups[0].tab);
  assert.equal(survivor.opener, child.tab);
  assert.equal(await survivor.page.evaluate(() => !!window[Symbol.for('sleight.popup3')]), true);
  assert.equal(result?.closed === true || result === undefined, true);
  assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
});
