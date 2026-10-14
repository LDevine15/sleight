import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { createFormSession, formInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';
import { BrowserReads, fixedReadInspectors } from '../plugins/sleight/lib/direct-browser/reads.mjs';
import { RefMap } from '../plugins/sleight/lib/direct-browser/refs.mjs';
import { loadPlaywrightCore } from '../plugins/sleight/lib/direct-browser/worlds.mjs';
import { createFormsFixtureHandler, finishTravelFixture } from './fixtures/direct-browser-forms-fixture.mjs';

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
  const server = createServer(createFormsFixtureHandler({ route, siteRoot: join(cache, 'test/forms/site'),
    renderShop: shop?.renderFixture, origin: () => origin, posts }));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const runtime = loadPlaywrightCore({ turbo: true });
  const browser = await runtime.inprocess.playwright.chromium.launch({ headless: true, executablePath: executable });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  if (route === 'checkout') await page.route('**/payment.html?*', request => request.fulfill({
    contentType: 'text/html', body: readFileSync(join(cache, 'test/forms/site/payment.html'), 'utf8') }));
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
  const adapter = createScopedAdapter({ session: raw, helpers: { ...formInspectors(), ...fixedReadInspectors }, checkLease: () => true,
    nodeBinding: id => nodes.has(id) ? { ...lease, backendNodeId: id } : null,
    dialogBinding: () => form.dialogBinding() });
  form = createFormSession({ session: adapter.forLease(lease), identity, current: () => identity,
    resolveRef: ref => refs.resolve(ref, identity), onOperation: op => { active = op; } });
  t.after(() => { form.dispose(); adapter.disconnect(); });
  let serial = 0; const issued = new Set();
  const ref = async selector => {
    // Selector acquisition is read-only setup for this owned local fixture, not
    // a production arbitrary selector or root API exposed to a model.
    const { root } = await cdp.send('DOM.getDocument', { depth: 1, pierce: false }); collect(root);
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw Error('fixture target missing: ' + selector);
    const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: 2, pierce: false }); collect(node);
    const tree = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
    const ax = tree.nodes.find(n => n.backendDOMNodeId === node.backendNodeId);
    const handle = refs.observe(identity, node.backendNodeId, JSON.stringify([ax.role?.value ?? 'group', ax.name?.value ?? '', null]));
    issued.add(handle); return handle;
  };
  const fill = async fields => {
    const values = []; for (const [selector, value] of fields) values.push({ ref: await ref(selector), value });
    const result = await form.fill(values, { operation: 'fields' + (++serial), timeoutMs: 15000 });
    assert.equal(result.completed, fields.length, JSON.stringify(result)); return result;
  };
  const click = async selector => form.act({ op: 'click', ref: await ref(selector) }, { operation: 'click' + (++serial), timeoutMs: 10000 });
  const reconcile = async () => {
    const covered = [];
    for (const handle of issued) {
      const node = refs.resolve(handle, identity);
      const result = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
      if (result.nodes.some(row => row.backendDOMNodeId === node.backendNodeId)) covered.push(handle);
    }
    assert.ok(covered.length); const id = 'delivered' + (++serial);
    form.pendingRead(id, identity, covered); assert.equal(form.deliveredRead(id, identity), true);
  };
  let submissionObserved = false;
  const posted = async () => {
    for (let i = 0; i < 100 && !posts.length; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(posts.length, 1, 'exactly one submission must reach the fixture endpoint'); submissionObserved = true; return posts[0];
  };
  t.after(() => { if (submissionObserved) assert.equal(posts.length, 1, 'no later duplicate submission'); });
  const reader = new BrowserReads({ identity, authorize: () => true });
  reader.addFrame({ session: adapter.forLease(lease), frameId: identity.frame, target: identity.target, document: 1 });
  t.after(() => reader.dispose());
  return { form, reader, ref, fill, click, reconcile, posted, calls, page, current: () => active };
}

test('real demo /travel fills ordinary and dependent fields, chooses readonly dates, and submits', { skip }, async t => {
  const f = await fixture(t, 'travel');
  await f.fill([['#reference', 'P2-TRAVEL'], ['#fullName', 'Example Traveler'], ['#email', 'traveler@example.invalid']]);
  const readonly = await f.form.fill([{ ref: await f.ref('#dates'), value: 'unproved date' }], { operation: 'readonly' });
  assert.equal(readonly.effect, 'none'); assert.equal(readonly.observation.code, 'READONLY_PICKER');
  await f.click('#dates');
  const dates = [];
  for (const offset of [2, 5]) {
    const date = new Date(); date.setDate(date.getDate() + offset);
    const iso = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    dates.push(iso);
    const selector = `button[data-date="${iso}"]`;
    for (let attempt = 0; attempt < 3; attempt++) { try { await f.ref(selector); break; } catch { await f.click('#next'); } }
    await f.click(selector);
  }
  const post = await finishTravelFixture(f); assert.equal(post.path, '/submit/travel');
  const firstAirport = JSON.parse(readFileSync(join(cache, 'test/forms/site/airports.json'), 'utf8'))[0].code;
  assert.deepEqual(post.data, { reference: 'P2-TRAVEL', fullName: 'Example Traveler', email: 'traveler@example.invalid',
    checkIn: dates[0], checkOut: dates[1], adults: 1, children: 0, country: 'Japan', city: 'Osaka', airport: firstAirport, seat: '1A' });
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
  assert.equal(post.path, '/shop/checkout/order');
  assert.equal(post.data.number, '4242424242424242'); assert.equal(post.data.expiry, '12/30'); assert.equal(post.data.cvc, '123');
});

// TF1 qualifies against the exact MIT form fixtures that produced the saved errors.
test('real settings priority order fills through exposed drag operations and submits exact order', { skip }, async t => {
  const f = await fixture(t, 'settings');
  const order = ['Security', 'Mentions', 'Billing', 'Reminders', 'Product updates'];
  await f.fill([['#reference', 'TF1-ORDER'], ['#languages', ['Japanese']], ['#prio', order]]);
  assert.deepEqual(await f.page.locator('#prio li').allTextContents(), order.map(v => '⋮⋮' + v));
  await f.click('button[type="submit"]'); await f.reconcile(); await f.click('#do-save');
  const post = await f.posted(); assert.deepEqual(post.data.priorities, order);
});
test('real checkout read exposes only parent controls across the cross-origin payment frame', { skip }, async t => {
  const f = await fixture(t, 'checkout');
  const result = await f.reader.read({ maxBytes: 64000 });
  assert.ok(result.data.some(row => row.name === 'Full name'));
  assert.ok(result.data.some(row => row.name === 'Cookie notice'));
  assert.equal(result.coverage.sensing, 'incomplete');
  assert.equal(result.data.some(row => /Card number|Expiry|CVC/.test(row.name)), false);
  assert.equal(f.calls.includes('Page.bringToFront'), false);
});
