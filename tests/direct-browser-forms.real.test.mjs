import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { createFormSession, formInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';
import { RefMap } from '../plugins/sleight/lib/direct-browser/refs.mjs';
import { loadPlaywrightCore } from '../plugins/sleight/lib/direct-browser/worlds.mjs';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const spec = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(b => b.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executable = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');
const skip = !live ? 'opt-in real-page qualification belongs to sleight-arch' : !existsSync(executable)
  ? 'the pinned Chromium build is missing' : !existsSync(join(cache, 'test/forms/site/travel.html'))
    ? 'the read-only demo fixture source is missing' : false;

async function fixture(t, route) {
  const posts = [], sockets = new Set();
  // Test scaffolding renders the exact MIT demo shop source in memory. It never
  // starts FowlBrowser's runner or edits its cache. Source attribution is retained.
  let shop;
  if (route === 'shop') {
    const source = readFileSync(join(cache, 'test/demo/server.mjs'), 'utf8');
    shop = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport {shopPage as renderFixture};').toString('base64'));
  }
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const data = request.headers['content-type']?.includes('json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      posts.push({ path: request.url, data });
      if (route === 'shop') response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Order placed</h1>');
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'P2-FIXTURE' }));
      return;
    }
    if (route === 'shop') { response.writeHead(200, { 'content-type': 'text/html' }).end(shop.renderFixture('checkout/payment', { base: '', cart: ['harbor'] }, origin)); return; }
    const names = { '/travel': 'travel.html', '/settings': 'settings.html', '/common.js': 'common.js', '/airports.json': 'airports.json' };
    const name = names[new URL(request.url, 'http://fixture.invalid').pathname];
    if (!name) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.json') ? 'application/json' : 'text/html' })
      .end(readFileSync(join(cache, 'test/forms/site', name)));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const runtime = loadPlaywrightCore({ turbo: true });
  const browser = await runtime.inprocess.playwright.chromium.launch({ headless: true, executablePath: executable });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(origin + (route === 'shop' ? '/shop/checkout/payment' : '/' + route));
  const cdp = await page.context().newCDPSession(page), { frameTree } = await cdp.send('Page.getFrameTree');
  const identity = { browserIncarnation: 'owned-fixture', brokerEpoch: 1, clientSession: 'fixture', turn: 'turn', leaseGeneration: 1,
    target: 'owned-fixture', frame: frameTree.frame.id, document: 1, origin };
  const lease = { ...identity, epoch: 1, cdpSessionId: 'page' }, refs = new RefMap(identity), nodes = new Set(), listeners = new Set(), calls = [];
  const collect = raw => { if (!raw) return; if (raw.backendNodeId) nodes.add(raw.backendNodeId);
    for (const child of [...raw.children ?? [], ...raw.shadowRoots ?? []]) collect(child); };
  const eventNames = ['Page.javascriptDialogOpening', 'Page.javascriptDialogClosed', 'Page.frameNavigated', 'Runtime.executionContextsCleared', 'DOM.documentUpdated'];
  for (const method of eventNames) cdp.on(method, params => { for (const fn of listeners) fn({ sessionId: 'page', method, params }); });
  const raw = { sessionId: 'root', on: (event, fn) => { assert.equal(event, 'event'); listeners.add(fn); },
    off: (event, fn) => { assert.equal(event, 'event'); listeners.delete(fn); },
    async send(method, params, route) {
      assert.equal(route, 'page'); assert.ok(!['Page.bringToFront', 'Target.activateTarget'].includes(method)); calls.push(method);
      const result = await cdp.send(method, params); collect(result.root ?? result.node); return result;
    } };
  let form, active;
  const adapter = createScopedAdapter({ session: raw, helpers: formInspectors(), checkLease: () => true,
    nodeBinding: id => nodes.has(id) ? { ...lease, backendNodeId: id } : null,
    dialogBinding: () => form.dialogBinding() });
  form = createFormSession({ session: adapter.forLease(lease), identity, current: () => identity,
    resolveRef: ref => refs.resolve(ref, identity), onOperation: op => { active = op; } });
  t.after(() => { form.dispose(); adapter.disconnect(); });
  let serial = 0;
  const ref = async selector => {
    // Selector acquisition is read-only setup for this owned local fixture, not
    // a production arbitrary selector or root API exposed to a model.
    const { root } = await cdp.send('DOM.getDocument', { depth: 1, pierce: false }); collect(root);
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw Error('fixture target missing: ' + selector);
    const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: 2, pierce: false }); collect(node);
    const tree = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
    const ax = tree.nodes.find(n => n.backendDOMNodeId === node.backendNodeId);
    return refs.observe(identity, node.backendNodeId, JSON.stringify([ax.role?.value ?? 'group', ax.name?.value ?? '', null]));
  };
  const fill = async fields => {
    const values = []; for (const [selector, value] of fields) values.push({ ref: await ref(selector), value });
    const result = await form.fill(values, { operation: 'fields' + (++serial), timeoutMs: 15000 });
    assert.equal(result.completed, fields.length, JSON.stringify(result)); return result;
  };
  const click = async selector => form.act({ op: 'click', ref: await ref(selector) }, { operation: 'click' + (++serial), timeoutMs: 10000 });
  const reconcile = async () => {
    const result = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: (await cdp.send('DOM.getDocument', { depth: 1, pierce: false })).root.backendNodeId, fetchRelatives: false });
    assert.ok(result.nodes.length); const id = 'delivered' + (++serial); form.pendingRead(id, identity); assert.equal(form.deliveredRead(id, identity), true);
  };
  const posted = async () => { for (let i = 0; i < 100 && !posts.length; i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(posts.length, 1); return posts[0]; };
  return { form, ref, fill, click, reconcile, posted, calls, page, current: () => active };
}

test('real demo /travel fills ordinary and dependent fields, chooses readonly dates, and submits', { skip }, async t => {
  const f = await fixture(t, 'travel');
  await f.fill([['#reference', 'P2-TRAVEL'], ['#fullName', 'Example Traveler'], ['#email', 'traveler@example.invalid']]);
  const readonly = await f.form.fill([{ ref: await f.ref('#dates'), value: 'unproved date' }], { operation: 'readonly' });
  assert.equal(readonly.effect, 'none'); assert.equal(readonly.observation.code, 'READONLY_PICKER');
  await f.click('#dates');
  for (const offset of [2, 5]) {
    const date = new Date(); date.setDate(date.getDate() + offset);
    const iso = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    const selector = `button[data-date="${iso}"]`;
    for (let attempt = 0; attempt < 3; attempt++) { try { await f.ref(selector); break; } catch { await f.click('#next'); } }
    await f.click(selector);
  }
  await f.click('#next1');
  await f.fill([['#country', 'Japan'], ['#city', 'Osaka']]);
  await f.click('#airports [role="option"]');
  await f.click('#next2'); await f.click('#seatmap button:not(:disabled)'); await f.click('button[type="submit"]');
  const post = await f.posted(); assert.equal(post.path, '/submit/travel');
  assert.equal(post.data.fullName, 'Example Traveler'); assert.equal(post.data.country, 'Japan'); assert.equal(post.data.city, 'Osaka');
  assert.ok(post.data.checkIn && post.data.checkOut && post.data.airport && post.data.seat);
});
test('real demo /settings fills a closed-shadow switch, grouped multi-select and slider, then confirms submission', { skip }, async t => {
  const f = await fixture(t, 'settings');
  await f.fill([['#reference', 'P2-SETTINGS'], ['#twoFactor', true], ['#languages', ['Japanese', 'Korean']], ['#volume', 72]]);
  await f.click('button[type="submit"]'); await f.reconcile(); await f.click('#do-save');
  const post = await f.posted(); assert.equal(post.path, '/submit/settings');
  assert.equal(post.data.twoFactor, true); assert.equal(post.data.volume, 72); assert.ok(post.data.languages.length === 2);
});
test('real demo shop checkout fills protected fields and sends an explicit submit', { skip }, async t => {
  const f = await fixture(t, 'shop');
  const filled = await f.fill([['input[name="number"]', '4242424242424242'], ['input[name="expiry"]', '12/30'], ['input[name="cvc"]', '123']]);
  assert.doesNotMatch(JSON.stringify(filled), /4242424242424242/);
  await f.click('form button'); const post = await f.posted();
  assert.equal(post.path, '/shop/checkout/order'); assert.equal(post.data.number, '4242424242424242'); assert.equal(post.data.cvc, '123');
});
