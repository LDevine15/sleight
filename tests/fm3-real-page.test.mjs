import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fillFormCode } from '../plugins/sleight/lib/fill-form.mjs';
import { clickResultCode } from '../plugins/sleight/lib/tab-click-result.mjs';

// FowlBrowser's MIT fixture pages are read from the installed clone, never copied or changed.
const modulePath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const site = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/forms/site');
const executablePath = [1234, 1228].map(version => join(homedir(),
  `Library/Caches/ms-playwright/chromium_headless_shell-${version}/chrome-headless-shell-mac-arm64/chrome-headless-shell`))
  .find(path => existsSync(path));

test('FM3 real fixture isolated-world switch and checkout cover (owner only)', {
  skip: process.platform !== 'darwin' ? 'FM3 fixture adapter needs macOS Chromium' :
    !existsSync(modulePath) ? 'playwright-core is not installed' :
      !existsSync(join(site, 'settings.html')) || !existsSync(join(site, 'checkout.html')) ? 'FowlBrowser fixtures are not installed' :
        !executablePath ? 'headless Chromium is not installed' :
          process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'browser launches are reserved for sleight-arch; set SLEIGHT_LIVE_DOM_TEST=1',
}, async t => {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = createServer((req, res) => {
    if (req.url === '/nested.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<style>body{margin:0;height:800px}#panel{position:absolute;top:100px;left:10px;width:400px;height:100px;overflow:auto}#content{position:relative;height:800px}header{position:fixed;top:100px;left:10px;width:400px;height:40px;z-index:2;background:white}button{position:absolute;top:50px;left:10px;width:100px;height:40px}</style><div id="panel"><div id="content"><button id="nestedDetails" type="button">Details</button></div></div><header role="banner">Navigation</header>');
      return;
    }
    if (req.url === '/partial.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<style>body{margin:0;height:1600px}header{position:fixed;top:0;left:0;width:100%;height:40px;z-index:2;background:white}button{position:absolute;top:100px;left:10px;width:100px;height:40px}</style><header role="banner">Navigation</header><button id="details" type="button">Details</button>');
      return;
    }
    const file = join(site, (req.url ?? '/').replace(/\?.*$/, ''));
    if (!file.startsWith(site + '/') || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'text/plain' });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage(), session = await page.context().newCDPSession(page);
  const origin = `http://127.0.0.1:${server.address().port}`;
  let contextId, clicks = 0;
  const navigate = async path => {
    await page.goto(origin + path);
    const { frameTree } = await session.send('Page.getFrameTree');
    ({ executionContextId: contextId } = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'sleight-fixture-reads',
    }));
  };
  const isolated = async (fn, arg) => {
    const reply = await session.send('Runtime.evaluate', { contextId, returnByValue: true, awaitPromise: true,
      expression: `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})` });
    if (reply.exceptionDetails) throw Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  const loc = selector => {
    const target = page.locator(selector);
    const api = { count: () => target.count(),
      evaluate: (fn, arg) => isolated(({ selector, source, arg }) => {
        const element = document.querySelector(selector);
        // Match the engine's documented default getter without reaching into the page world.
        const readonly = element.tagName.includes('-') ? new Proxy(element, { get(el, key) {
          if (key === 'checked') return el.checked === true;
          const value = el[key]; return typeof value === 'function' ? value.bind(el) : value;
        }, set() { throw Error('fixture reads are read-only'); } }) : element;
        return (0, eval)('(' + source + ')')(readonly, arg);
      }, { selector, source: fn.toString(), arg }),
      click: options => { clicks++; return target.click({ timeout: options?.timeoutMs ?? 1000 }); },
      setChecked: (value, options) => target.setChecked(value, { timeout: options.timeoutMs }),
    };
    return new Proxy(api, { get(target, key) {
      if (!(key in target)) throw Error('unsupported engine locator method: ' + String(key));
      return target[key];
    } });
  };
  const notes = [], tab = { id: 'fixture', playwright: { locator: loc }, getAXState: async () => '' };
  const context = createContext({ cua: { getTab: async () => tab }, tab, setTimeout, clearTimeout,
    nodeRepl: { write: text => notes.push(text) } });
  await navigate('/settings.html');
  assert.equal(await isolated(() => document.querySelector('#twoFactor').checked), undefined);
  const out = await runInContext('(async()=>{' + fillFormCode('return await sleight.fillForm(tab,[{locator:"#twoFactor",value:true}])') + '})()', context);
  assert.match(out, /twoFactor\) unverifiable:/);
  assert.equal(clicks, 0);
  assert.equal(await page.locator('#twoFactor').evaluate(el => el.checked), false);

  await navigate('/checkout.html');
  const click = 'var tab = await cua.getTab("fixture"); await tab.playwright.locator("#pay").click();';
  await assert.rejects(runInContext('(async()=>{' + clickResultCode(click) + '})()', context), /covered by region Cookie notice/);
  assert.equal(clicks, 0);
  assert.match(notes.join('\n'), /covered by region Cookie notice/);
  await page.locator('#reject').click();
  await runInContext('(async()=>{' + clickResultCode(click) + '})()', context);
  assert.equal(clicks, 1);

  await navigate('/partial.html');
  await page.evaluate(() => window.scrollTo(0, 110));
  assert.equal(await page.locator('#details').evaluate(el => el.getBoundingClientRect().top), -10);
  notes.length = 0;
  await runInContext('(async()=>{' + clickResultCode('var tab = await cua.getTab("fixture"); await tab.playwright.locator("#details").click();') + '})()', context);
  assert.equal(clicks, 2);
  assert.deepEqual(notes, []);
  assert.ok(await page.locator('#details').evaluate(el => el.getBoundingClientRect().top) >= 40);

  await navigate('/nested.html');
  await page.locator('#panel').evaluate(el => { el.scrollTop = 60; });
  assert.equal(await page.locator('#nestedDetails').evaluate(el => el.getBoundingClientRect().top), 90);
  notes.length = 0;
  await runInContext('(async()=>{' + clickResultCode('var tab = await cua.getTab("fixture"); await tab.playwright.locator("#nestedDetails").click();') + '})()', context);
  assert.equal(clicks, 3);
  assert.deepEqual(notes, []);
  assert.ok(await page.locator('#nestedDetails').evaluate(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; }) >= 140);
});
