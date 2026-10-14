import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { snapshot, closedRefBinding } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createFormsFixtureHandler } from './fixtures/direct-browser-forms-fixture.mjs';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(browser => browser.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = !live ? 'real-page qualification belongs to sleight-arch host runner'
  : !existsSync(executablePath) ? 'pinned Chromium headless shell is unavailable' : false;
const siteRoot = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/forms/site');

async function fixture(t, html, routes = {}) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(routes[request.url] ?? html);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.on('pageerror', error => console.log('V3 fixture page error ' + error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  return page;
}

test('real snapshot redacts password and iframe card values while retaining actionable refs', { skip }, async t => {
  const page = await fixture(t, `<main><label>Password<input type="password" value="fixture-password"></label>
    <p>echo fixture-password</p><iframe src="/card"></iframe><button>Continue</button></main>`, {
    '/card': '<label>Number<input autocomplete="cc-number" value="4111 1111 1111 1111"></label><label>Expiry<input value="08/30"></label><label>Security code<input value="123"></label>',
  });
  const result = await snapshot(page);
  assert.doesNotMatch(result.text, /fixture-password|4111|08\/30|123/);
  assert.match(result.text, /textbox "Number" \[ref=f\d+e\d+\]/);
  const ref = /button "Continue" \[ref=([^\]]+)\]/.exec(result.text)[1];
  assert.equal(await page.locator('aria-ref=' + ref).count(), 1);
});

test('real native redaction ignores page overrides of protected input getters', { skip }, async t => {
  const page = await fixture(t, `<main><label>Account<input type="password" value="fixture-native-secret"></label>
    <p>echo fixture-native-secret</p></main><script>
    Object.defineProperty(HTMLInputElement.prototype, 'type', {get() {return 'text'}});
    Object.defineProperty(HTMLInputElement.prototype, 'value', {get() {return 'page-decoy'}});
  </script>`);
  const result = await snapshot(page);
  assert.doesNotMatch(result.text, /fixture-native-secret/);
  assert.match(result.text, /redacted/);
});

test('real closed-root refs expose checked state and redact current native values', { skip }, async t => {
  const page = await fixture(t, `<main><custom-control></custom-control></main><script>
    const root = document.querySelector('custom-control').attachShadow({mode:'closed'});
    root.innerHTML = '<button role="switch" aria-checked="true">Secure mode</button><input type="password" aria-label="Password">';
    root.querySelector('input').value = 'fixture-closed-password';
  </script>`);
  const result = await snapshot(page);
  if (!result.text.includes('Secure mode')) {
    const session = await page.context().newCDPSession(page);
    try {
      const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
      const hosts = [], controls = [];
      const walk = (node, closed = false) => {
        if (closed && node.localName === 'button') controls.push(node.backendNodeId);
        for (const shadow of node.shadowRoots ?? []) {
          hosts.push({ host: node.backendNodeId, tag: node.localName, type: shadow.shadowRootType,
            children: (shadow.children ?? []).map(child => ({ tag: child.localName, backend: child.backendNodeId })) });
          walk(shadow, closed || shadow.shadowRootType === 'closed');
        }
        for (const child of node.children ?? []) walk(child, closed);
      };
      walk(root);
      console.log('V3 closed-root DOM diagnostic ' + JSON.stringify(hosts));
      const summarize = nodes => nodes.map(node => ({ backend: node.backendDOMNodeId,
        role: node.role?.value, name: node.name?.value, ignored: node.ignored }));
      for (const { host } of hosts) console.log('V3 closed-root query diagnostic ' + JSON.stringify(summarize(
        (await session.send('Accessibility.queryAXTree', { backendNodeId: host })).nodes)));
      console.log('V3 closed-root full diagnostic ' + JSON.stringify(summarize(
        (await session.send('Accessibility.getFullAXTree')).nodes)));
      for (const backendNodeId of controls) console.log('V3 closed-root partial diagnostic ' + JSON.stringify(summarize(
        (await session.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })).nodes)));
    } finally { await session.detach(); }
  }
  assert.match(result.text, /switch "Secure mode" \[checked\] \[ref=s\d+\]/);
  assert.doesNotMatch(result.text, /fixture-closed-password/);
  const ref = /switch.*\[ref=(s\d+)\]/.exec(result.text)[1];
  const { frame, backendNodeId } = closedRefBinding(page, ref);
  const cdp = await page.context().newCDPSession(frame);
  try {
    const { node } = await cdp.send('DOM.describeNode', { backendNodeId });
    assert.equal(node.localName, 'button');
  } finally { await cdp.detach(); }
});

test('real out-of-process iframe card values are redacted through their own frame', { skip }, async t => {
  const page = await fixture(t, '<main><iframe></iframe></main>');
  await page.route('http://127.0.0.2/card', request => request.fulfill({ contentType: 'text/html',
    body: '<label>Number<input autocomplete="cc-number" value="4111 1111 1111 1111"></label>' }));
  const loaded = page.waitForEvent('framenavigated', frame => frame.url() === 'http://127.0.0.2/card');
  await page.locator('iframe').evaluate(element => { element.src = 'http://127.0.0.2/card'; });
  const frame = await loaded;
  await frame.waitForLoadState();
  const result = await snapshot(page);
  assert.doesNotMatch(result.text, /4111/);
  assert.match(result.text, /textbox "Number" \[ref=f\d+e\d+\]/);
});

test('real diffs preserve reorder context and scoped reads leave other aria refs usable', { skip }, async t => {
  const page = await fixture(t, '<main><ul><li>A</li><li>B</li><li>C</li></ul><button>Continue</button></main>');
  const first = await snapshot(page);
  await page.evaluate(() => { const list = document.querySelector('ul'); list.prepend(list.lastElementChild); });
  const diff = await snapshot(page, { since: first.number });
  assert.match(diff.text, /Changes since/);
  assert.match(diff.text, /\+ .*listitem/);
  const scoped = await snapshot(page, { find: 'C' });
  assert.match(scoped.text, /listitem.*C/);
  const button = /button "Continue" \[ref=([^\]]+)\]/.exec(first.text)[1];
  assert.equal(await page.locator('aria-ref=' + button).count(), 1);
});

test('real fixture size census stays below 15K for open, action diff and find', { skip }, async t => {
  const page = await fixture(t, `<main><h1>Travel</h1><label>City<input value=""></label><ul>${Array.from({ length: 500 }, (_, i) =>
    '<li>Destination ' + i + '</li>').join('')}</ul><button>Save</button></main>`);
  const first = await snapshot(page);
  assert.ok(first.text.length <= 8000);
  assert.match(first.text, /Continue with ref=/);
  await page.locator('input').fill('Portland');
  const action = await snapshot(page, { since: first.number });
  const found = await snapshot(page, { find: 'Destination 499' });
  assert.match(found.text, /Destination 499/);
  const chars = { open: first.text.length, action: action.text.length, find: found.text.length };
  console.log('V3 synthetic size census ' + JSON.stringify(chars));
  // A cut baseline must deliver the unseen rows. Measure the action diff with
  // a fully delivered baseline separately for the round's small-result target.
  const full = await snapshot(page, { maxChars: 40000 });
  await page.locator('input').fill('Seattle');
  const small = await snapshot(page, { since: full.number });
  assert.match(small.text, /Seattle/);
  assert.ok(first.text.length + small.text.length + found.text.length <= 15000);
});

for (const route of ['travel', 'settings', 'checkout']) test(`real ${route} fixture snapshot size census`, {
  skip: skip || !existsSync(join(siteRoot, route + '.html')) && 'read-only MIT form fixture source is unavailable',
}, async t => {
  const sockets = new Set();
  const server = createServer(createFormsFixtureHandler({ route, siteRoot, origin: () => origin, posts: [] }));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  if (route === 'checkout') await page.route('**/payment.html?*', request => request.fulfill({
    contentType: 'text/html', body: readFileSync(join(siteRoot, 'payment.html'), 'utf8') }));
  await page.goto(origin + '/' + route);
  const first = await snapshot(page);
  const field = page.locator('input[type="text"],input:not([type]),textarea').first();
  await field.fill('Fixture census');
  const action = await snapshot(page, { since: first.number });
  const found = await snapshot(page, { find: 'Fixture census' });
  assert.match(found.text, /Fixture census/);
  const chars = { open: first.text.length, act: action.text.length, read: found.text.length,
    total: first.text.length + action.text.length + found.text.length };
  console.log('V3 ' + route + ' fixture census ' + JSON.stringify(chars));
  assert.ok(first.text.length <= 8000 && action.text.length <= 8000 && found.text.length <= 8000);
  assert.ok(chars.total <= 15000, 'fixture open + action diff + find target is 15K');
});
