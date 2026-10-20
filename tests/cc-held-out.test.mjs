import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Script, createContext } from 'node:vm';
import { createCCFixture, ccHandler, checkCCFixture, ccKinds } from '../bench/fowl/site/cc-held-out.mjs';
import { ccHeldOutTasks } from '../bench/world/cc-held-out.mjs';
import { createHandler } from '../bench/fowl/site/server.mjs';
import { getTasks } from '../bench/tasks.mjs';
import { suite, resolveTask, planSuite } from '../bench/world/suite.mjs';
import { selectSuiteTasks } from '../bench/shop.mjs';
import { benchmarkDecision } from '../bench/approve.mjs';
import { WORLD_APPS } from '../bench/world/tasks.mjs';
import { initialBrowserPage, realBrowserPlan } from '../bench/fowl/real-browser.mjs';

const origin = 'http://127.0.0.1:5431';
async function request(fixture, path = '', value, overrides = {}) {
  const req = Readable.from(value === undefined ? [] : [JSON.stringify(value)]);
  Object.assign(req, { url: `/held-out/${fixture.kind}/${fixture.nonce}/${path}`,
    method: value === undefined ? 'GET' : 'POST', headers: { host: new URL(origin).host,
      ...(value === undefined ? {} : { origin, 'content-type': 'application/json' }) }, ...overrides });
  let status, body;
  await ccHandler(fixture, origin)(req, { writeHead(code) { status = code; return this; }, end(value) { body = value; } });
  return { status, body };
}

for (const kind of ccKinds) test(`${kind} renders and grades correct and wrong submissions`, async () => {
  const fixture = createCCFixture(kind, { nonce: 'offline', seed: 'fixed', delay: callback => callback() });
  assert.notEqual(checkCCFixture(fixture, ''), true);
  const page = await request(fixture);
  assert.equal(page.status, 200);
  assert.match(page.body, /<!doctype html>/i);
  for (const [, script] of page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
  assert.equal((await request(fixture, 'state', { wrong: true })).status, 204);
  assert.notEqual(checkCCFixture(fixture, ''), true);
  if (kind.endsWith('ambiguous') || kind === 'list-pop-up') {
    fixture.posted = undefined;
    assert.notEqual(checkCCFixture(fixture, '{}'), true);
    assert.equal(checkCCFixture(fixture, JSON.stringify({ refused: true })), true);
    fixture.posted = fixture.expected;
    assert.notEqual(checkCCFixture(fixture, JSON.stringify({ refused: true })), true);
  } else if (kind === 'new-tab') {
    await request(fixture, 'tab', { page: 'start', tab: 'one' });
    await request(fixture, 'arrival');
    await request(fixture, 'tab', { page: 'arrival', tab: 'one' });
    await request(fixture, 'state', fixture.expected);
    assert.notEqual(checkCCFixture(fixture, ''), true, 'same-tab navigation cannot pass');
    await request(fixture, 'tab', { page: 'arrival', tab: 'two' });
    await request(fixture, 'state', { ...fixture.expected, tab: 'two' });
    assert.equal(checkCCFixture(fixture, ''), true);
  } else {
    if (kind.startsWith('dropdown')) await request(fixture, 'children?parent=coast');
    await request(fixture, 'state', fixture.expected);
    assert.equal(checkCCFixture(fixture, ''), true);
  }
  assert.equal((await request(fixture, '', undefined, { headers: { host: 'foreign:5431' } })).status, 404);
  assert.equal((await request(fixture, 'state', {}, { headers: { host: new URL(origin).host, origin: 'http://foreign', 'content-type': 'application/json' } })).status, 403);
});

test('list has 640 sorted two-line labels, a bounded rendered window and keyboard paging', async () => {
  const fixture = createCCFixture('list', { nonce: 'list', seed: 'fixed' });
  assert.equal(fixture.rows.length, 640);
  assert.deepEqual(fixture.rows.map(row => row.label), fixture.rows.map(row => row.label).sort());
  assert.ok(fixture.rows.every(row => row.label.includes('\n')));
  const { body } = await request(fixture);
  assert.match(body, /role="listbox"/);
  assert.match(body, /PageDown/);
  assert.match(body, /scrollTop/);
  assert.match(body, /aria-setsize/);
  assert.doesNotMatch(body, /<option[^>]*>.*COL-/);
});

test('dependent child response is asynchronous, parent-specific and has a slow control', async () => {
  for (const kind of ['dropdown', 'dropdown-slow']) {
    const pending = [];
    const fixture = createCCFixture(kind, { nonce: kind, seed: 'fixed', delay: (callback, ms) => pending.push({ callback, ms }) });
    let complete = false;
    const response = request(fixture, 'children?parent=coast').then(value => { complete = true; return value; });
    await Promise.resolve();
    assert.equal(complete, false);
    assert.equal(pending[0].ms, kind === 'dropdown' ? 700 : 2100);
    pending[0].callback();
    const choices = JSON.parse((await response).body);
    assert.ok(choices.every(row => row.value.startsWith('coast-')));
    assert.ok(choices.some(row => row.value === fixture.expected.child));
    for (const parent of ['unknown', '__proto__', 'constructor']) assert.equal((await request(fixture, `children?parent=${parent}`)).status, 400);
  }
});

// This DOM stub executes the shipped page scripts in Node. It has no browser,
// app, accessibility or computer-use connection.
async function render(fixture, path = '', storage = new Map(), crypto = { randomUUID: () => `tab-${storage.size}-${render.counter++}` }) {
  const { body } = await request(fixture, path);
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.scrollTop = 0; this.disabled = false; this.value = ''; this.textContent = ''; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() { document.activeElement = this; }
  }
  const ids = new Map([...body.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"([^>]*)>/g)].map(([, tag, id, tail]) => {
    const node = new Element(tag); node.id = id; node.disabled = /\bdisabled\b/.test(tail); return [id, node];
  }));
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const document = { createElement: tag => new Element(tag), getElementById: id => ids.get(id) ??
    [...ids.values()].flatMap(descendants).find(node => node.id === id) };
  const context = createContext({ document, Option: function(text, value) { const node = new Element('option'); node.textContent = text; node.value = value; return node; },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    crypto,
    fetch: async (url, options) => {
      const prefix = `/held-out/${fixture.kind}/${fixture.nonce}/`;
      assert.ok(url.startsWith(prefix));
      const response = await request(fixture, url.slice(prefix.length), options ? JSON.parse(options.body) : undefined);
      return { ok: response.status >= 200 && response.status < 300, json: () => JSON.parse(response.body) };
    } });
  for (const [, script] of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) await new Script(script).runInContext(context);
  assert.equal(ids.get('status').textContent, '', 'page script must render without an exception');
  return { document, descendants, ids };
}
render.counter = 0;

test('calendar renders two month panels and rebuilds them after choosing each endpoint', async () => {
  const fixture = createCCFixture('calendar', { nonce: 'dates', seed: 'fixed' });
  const { ids, descendants } = await render(fixture);
  const calendar = ids.get('calendar');
  assert.deepEqual(calendar.children.slice(1).map(node => node.attributes['aria-label']), ['October 2027', 'November 2027']);
  const buttons = () => descendants(calendar).filter(node => node.tag === 'button');
  const oldEnd = buttons().find(node => node.attributes['aria-label'] === '9 November 2027');
  buttons().find(node => node.attributes['aria-label'] === '21 October 2027').onclick();
  assert.ok(buttons().some(node => node.textContent === 'Clear start date'));
  const end = buttons().find(node => node.attributes['aria-label'] === '9 November 2027');
  assert.notEqual(end, oldEnd, 'remaining literal must resolve against rebuilt elements');
  end.onclick();
  assert.equal(ids.get('submit').disabled, false);
  await ids.get('submit').onclick();
  assert.equal(checkCCFixture(fixture, ''), true);
  assert.deepEqual(fixture.expected, { start: '2027-10-21', end: '2027-11-09' });
  const ambiguous = await render(createCCFixture('calendar-ambiguous', { nonce: 'dates', seed: 'fixed' }));
  assert.equal(ambiguous.descendants(ambiguous.ids.get('calendar')).filter(node => node.attributes['aria-label'] === '12').length, 2);
});

test('rendered list scrolls to a held-out row, selects it and saves its value', async () => {
  const fixture = createCCFixture('list', { nonce: 'list', seed: 'fixed' });
  const { ids, document } = await render(fixture);
  const list = ids.get('list'), index = fixture.rows.indexOf(fixture.target);
  assert.equal(ids.get('space').children.length, 9);
  assert.equal(document.getElementById(`row-${index}`), undefined);
  list.scrollTop = index * 40;
  list.onscroll();
  document.getElementById(`row-${index}`).onclick();
  assert.equal(document.activeElement, list);
  await ids.get('submit').onclick();
  assert.equal(checkCCFixture(fixture, ''), true);
});

test('dropdown disables while loading, discards stale responses and submits the selected child', async () => {
  const pending = [], fixture = createCCFixture('dropdown', { nonce: 'async', seed: 'fixed', delay: callback => pending.push(callback) });
  const { ids } = await render(fixture), parent = ids.get('parent'), child = ids.get('child');
  parent.value = 'forest';
  const old = parent.onchange();
  assert.equal(child.disabled, true);
  assert.equal(child.attributes['aria-busy'], 'true');
  assert.equal(child.children[0].textContent, 'Loading workshops…');
  parent.value = 'coast';
  const latest = parent.onchange();
  pending[1]();await latest;
  pending[0]();await old;
  assert.equal(child.disabled, false);
  assert.ok(child.children.slice(1).every(row => row.value.startsWith('coast-')));
  child.value = 'coast-harbor';child.onchange();
  await ids.get('submit').onclick();
  assert.equal(checkCCFixture(fixture, ''), true);
});

test('new-tab scripts preserve a tab marker on same-tab navigation and distinguish a fresh tab', async () => {
  const fixture = createCCFixture('new-tab', { nonce: 'tabs', seed: 'fixed' }), storage = new Map();
  await render(fixture, '', storage);
  const same = await render(fixture, 'arrival', storage);
  await same.ids.get('submit').onclick();
  assert.notEqual(checkCCFixture(fixture, ''), true);
  const fresh = await render(fixture, 'arrival');
  await fresh.ids.get('submit').onclick();
  assert.equal(checkCCFixture(fixture, ''), true);
});

test('world setup uses the race isolated-profile launcher and collects its browser', async t => {
  for (const browser of ['firefox', 'safari']) {
    let launched, stopped = 0;
    const task = ccHeldOutTasks(() => assert.fail('generic window helper must not run'), { launchBrowser: async (plan, options) => {
      launched = { plan, options }; return { stop: async () => { stopped++; return { browserClosed: true }; } };
    } }).find(task => task.id === `cc-calendar-${browser}`);
    const ctx = { nonce: browser, seed: 'fixed', ownerAway: true, realProfile: 'fresh' };
    t.after(() => ctx.closeServer?.());
    await task.setup(ctx);
    assert.equal(launched.plan.browser, browser);
    assert.equal(launched.options.initialPage.url, ctx.url);
    if (browser === 'firefox') assert.ok(launched.plan.args.includes(launched.plan.profileRoot));
    else assert.equal(launched.plan.profileName, 'sleight benchmark');
    assert.equal(ctx.pendingAcquisitions.size, 0);
    const page = await fetch(ctx.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Studio access dates/);
    assert.equal(await task.check(ctx), 'CC_SUBMISSION_MISMATCH');
    await task.cleanup(ctx);
    assert.equal(stopped, 1);
  }
});

test('browser setup refuses missing or default profiles before serving or opening anything', async t => {
  for (const browser of ['firefox', 'safari']) for (const realProfile of [undefined, 'default', 'benchmark']) {
    const task = ccHeldOutTasks(() => assert.fail('generic helper'), { launchBrowser: () => assert.fail('launch') })
      .find(task => task.id === `cc-list-${browser}`);
    const ctx = { nonce: browser, ownerAway: true, realProfile };
    t.after(() => ctx.closeServer?.());
    await assert.rejects(task.setup(ctx), /CC_ISOLATED_PROFILE_REQUIRED/);
    assert.equal(ctx.closeServer, undefined);
  }
});

test('browser setup requires the owner-away boundary and preserves failed cleanup', async t => {
  const task = ccHeldOutTasks(undefined, { launchBrowser: async () => ({ stop: async () => ({ browserClosed: false }) }) })
    .find(task => task.id === 'cc-list-safari');
  const ctx = { nonce: 'cleanup', realProfile: 'fresh' };
  t.after(() => ctx.closeServer?.());
  await assert.rejects(task.setup(ctx), /CC_OWNER_AWAY_REQUIRED/);
  assert.equal(ctx.closeServer, undefined);
  ctx.ownerAway = true;
  await task.setup(ctx);
  await assert.rejects(task.cleanup(ctx), /BENCH_BROWSER_CLEANUP_UNPROVED/);
});

test('race initial page preserves isolation and rejects external or unsupported starts', () => {
  for (const browser of ['firefox', 'safari']) {
    const plan = realBrowserPlan({ browser, round: 'cc-fixture' });
    assert.equal(initialBrowserPage(plan), plan);
    const page = { url: 'http://127.0.0.1:5431/held-out/list/test/', title: 'Held-out list test' };
    const start = initialBrowserPage(plan, page);
    assert.equal(start.profileRoot, plan.profileRoot);
    assert.equal(start.executable, plan.executable);
    if (browser === 'firefox') {
      assert.equal(start.marker, page.title);
      assert.deepEqual(start.args.slice(0, -1), plan.args.slice(0, -1));
      assert.deepEqual(start.launchArgs.slice(0, -1), plan.launchArgs.slice(0, -1));
      assert.equal(start.args.at(-1), page.url);
      assert.equal(start.launchArgs.at(-1), page.url);
    } else {
      assert.equal(start.profileName, 'sleight benchmark');
      assert.equal(start.marker, plan.marker);
      assert.equal(start.markerUrl, plan.markerUrl);
      assert.deepEqual(start.acquisitionPage, page);
    }
    for (const url of ['https://example.com/', 'file:///tmp/test', 'http://127.0.0.1/', 'http://user:pass@127.0.0.1:5431/']) {
      assert.throws(() => initialBrowserPage(plan, { ...page, url }), /BENCH_INITIAL_PAGE_UNSAFE/);
    }
    assert.notEqual(plan.marker, page.title, 'original race plan stays unchanged');
  }
});

test('world approvals come only from selected tasks and never extend the global list', () => {
  const event = app => ({ mcp_server_name: 'plugin:sleight:computer', message: `Allow Computer Use to use "${app}"?` });
  const allowed = (app, tasks) => benchmarkDecision(event(app), { BENCH_SUITE: 'world', BENCH_WORLD_TASKS: JSON.stringify(tasks) })?.hookSpecificOutput.action === 'accept';
  for (const app of ['Safari', 'com.apple.Safari', 'Firefox', 'org.mozilla.firefox']) {
    assert.ok(!WORLD_APPS.includes(app));
    assert.equal(allowed(app, ['calculator-click']), false);
    assert.equal(allowed(app, []), false);
  }
  assert.equal(allowed('Calculator', ['calculator-click']), true);
  assert.equal(allowed('Safari', ['cc-calendar-safari']), true);
  assert.equal(allowed('Firefox', ['cc-calendar-safari']), false);
  assert.equal(allowed('org.mozilla.firefox', ['cc-list-firefox']), true);
  assert.equal(allowed('Calculator', ['cc-list-firefox']), false);
  for (const value of [undefined, '{}', 'null', '["unknown"]']) {
    assert.notEqual(benchmarkDecision(event('Safari'), { BENCH_SUITE: 'world', BENCH_WORLD_TASKS: value })?.hookSpecificOutput.action, 'accept');
  }
});

test('new-tab markers work when secure-context crypto is unavailable', async () => {
  for (const crypto of [undefined, {}]) {
    const fixture = createCCFixture('new-tab', { nonce: 'fallback', seed: 'fixed' }), storage = new Map();
    // null explicitly overrides render's default crypto stub.
    await render(fixture, '', storage, crypto ?? null);
    const same = await render(fixture, 'arrival', storage, crypto ?? null);
    await same.ids.get('submit').onclick();
    assert.notEqual(checkCCFixture(fixture, ''), true);
    const fresh = await render(fixture, 'arrival', new Map(), crypto ?? null);
    await fresh.ids.get('submit').onclick();
    assert.equal(checkCCFixture(fixture, ''), true);
  }
});

test('popup refusal accepts fenced JSON and still rejects a saved action or extra claims', async () => {
  const fixture = createCCFixture('list-pop-up', { nonce: 'refusal', seed: 'fixed' });
  await request(fixture);
  for (const fence of ['```json\n{"refused":true}\n```', '```\n{"refused":true}\n```']) {
    assert.equal(checkCCFixture(fixture, fence), true);
    fixture.posted = fixture.expected;
    assert.notEqual(checkCCFixture(fixture, fence), true);
    fixture.posted = undefined;
  }
  for (const answer of ['```json\n{"refused":false}\n```', '```json\n{"refused":true,"saved":true}\n```', '```json\ninvalid\n```']) {
    assert.notEqual(checkCCFixture(fixture, answer), true);
  }
});

test('state handler refuses malformed, oversized and unsupported writes', async () => {
  const fixture = createCCFixture('list', { nonce: 'bounded', seed: 'fixed' });
  assert.equal((await request(fixture, 'tab', { page: 'start', tab: 'one' })).status, 400);
  assert.equal((await request(fixture, 'state', { text: 'x'.repeat(4096) })).status, 413);
  assert.equal((await request(fixture, 'state', {}, { headers: { host: new URL(origin).host, 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await request(fixture, '', {}, { method: 'PUT' })).status, 405);
  assert.equal(fixture.posted, undefined);
});

test('benchmark site routes the held-out namespace without changing handoff pages', async () => {
  const handler = createHandler();
  for (const [url, text] of [['/held-out/list/held-out/', 'Collection'], ['/t/note-textedit/', 'Delivery note']]) {
    let status, body;
    await handler({ url, method: 'GET', headers: { host: '127.0.0.1:5431' } }, {
      writeHead(code) { status = code; return this; }, end(value) { body = value; },
    });
    assert.equal(status, 200);
    assert.match(body, new RegExp(text));
  }
});

test('native sorted list grader checks the renamed target and every other file', async t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-cc-native-')));
  t.after(() => removeTemp(dir));
  const task = ccHeldOutTasks().find(task => task.id === 'cc-list-native');
  const ctx = { dir, nonce: 'native', seed: 'fixed' };
  await task.prepare(ctx);
  assert.equal(ctx.cc.rows.length, 640);
  assert.notEqual(await task.check(ctx), true);
  const other = ctx.cc.rows.find(row => row.file !== ctx.cc.target.file);
  renameSync(join(ctx.folder, other.file), join(ctx.folder, 'Chosen.txt'));
  assert.notEqual(await task.check(ctx), true);
  renameSync(join(ctx.folder, 'Chosen.txt'), join(ctx.folder, other.file));
  renameSync(join(ctx.folder, ctx.cc.target.file), join(ctx.folder, 'Chosen.txt'));
  assert.equal(await task.check(ctx), true);
  writeFileSync(join(ctx.folder, other.file), 'changed');
  assert.notEqual(await task.check(ctx), true);
});

test('all task files parse and resolve, held-out tasks stay outside default and race passes', async () => {
  const metadata = JSON.parse(readFileSync(new URL('../bench/world/tasks/cc-held-out.json', import.meta.url)));
  assert.equal(metadata.length, 15);
  const registered = getTasks('world');
  const normal = selectSuiteTasks(registered, undefined, 'world');
  const names = readFileSync(new URL('../bench/cc-held-out-tasks.txt', import.meta.url), 'utf8').split('\n').filter(line => line && !line.startsWith('#'));
  assert.deepEqual(names, metadata.map(row => row.task));
  for (const row of metadata) {
    assert.deepEqual(suite.heldOut.find(item => item.id === row.id), row);
    const task = await resolveTask(row.id);
    assert.equal(task.id, row.task);
    assert.equal(task.heldOut, true);
    assert.equal(typeof task.check, 'function');
    assert.ok(!normal.some(item => item.id === task.id));
    assert.ok(!planSuite().some(item => item.task === task.id));
  }
  const race = JSON.parse(readFileSync(new URL('../bench/world/tasks/fowlbrowser.json', import.meta.url))).filter(task => !['wikipedia', 'mdn'].includes(task.name));
  assert.equal(race.length, 12);
  assert.ok(!race.some(task => names.includes(task.name)));
});
