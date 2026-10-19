import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { clickResultCode, isDiffTree, TabClickResults } from '../plugins/sleight/lib/tab-click-result.mjs';
import { browserAliasesCode } from '../plugins/sleight/lib/browser-aliases.mjs';

function fixture({ change, fail, unread, hang, noId, type, role, inForm = true, popup, tag = 'BUTTON', readMs = 0, clickMs = 0, row = 'Pay' } = {}) {
  const notes = [], calls = [], reads = [];
  let state = 'form with Pay button', url = 'https://example.test/form';
  const delay = (value, ms) => ms ? new Promise(resolve => setTimeout(() => resolve(value), ms)) : value;
  const act = name => async () => { calls.push(name); if (fail) throw new Error('target missing');
    await delay(undefined, clickMs);
    if (change === 'url') url = 'https://example.test/done';
    if (change === 'tree') state = 'receipt 123';
  };
  const click = act('click');
  const element = { tagName: tag, type: type ?? (tag === 'BUTTON' ? 'submit' : undefined), getAttribute: key => ({ role, 'aria-haspopup': popup })[key] ?? null,
    closest: selector => selector === 'form' && inForm ? {} : null };
  const locator = { click, press: act('press'), count: async () => 1, first: () => locator, all: async () => [locator],
    evaluate: async (fn, arg) => { reads.push('metadata'); return hang === 'metadata' ? new Promise(() => {}) : fn(element, arg); } };
  const tab = { id: '1', click, pressKey: act('key'),
    getAXState: async () => { reads.push('ax'); return 'Browser tab: 1, Title: "Form", URL: "https://example.test/form".\n\t12 button ' + row + (noId ? '' : ', ID: pay'); },
    url: async () => { reads.push('url'); if (unread) throw new Error('unavailable'); if (hang === 'url') return new Promise(() => {}); return delay(url, readMs); },
    playwright: { domSnapshot: async () => { reads.push('dom'); return delay(state, readMs); }, locator: () => locator, evaluate: async (fn, arg) => { reads.push('metadata'); return fn(arg); },
      getByRole: () => locator, frameLocator: () => ({ locator: () => locator }) } };
  const browser = { tabs: { get: async () => tab, new: async () => tab } };
  const cua = { getTab: async () => tab, createBrowserTab: async () => tab,
    getBrowser: async () => browser, getApp: async () => ({ click }) };
  const agent = { browsers: { get: async () => browser } };
  const context = createContext({ cua, agent, document: { activeElement: element }, setTimeout, clearTimeout,
    nodeRepl: { write: text => notes.push(text) } });
  const seen = { '1': '\t12 button ' + row + (noId ? '' : ', ID: pay') };
  const run = code => runInContext(`(async () => { ${clickResultCode(code, seen)} })()`, context);
  return { notes, calls, reads, run, tab, context };
}

for (const code of [
  'var tab = await cua.getTab("1"); await tab.click(12);',
  'var tab = await cua.createBrowserTab("b"); await tab.playwright.locator("#pay").click();',
  'var b = await cua.getBrowser({id:"b"}); var tab = await b.tabs.get("1"); await tab.playwright.getByRole("button", {name:"Pay"}).first().click();',
  'var b = await agent.browsers.get("1"); var tab = await b.tabs.get("1"); await tab.playwright.locator("button[type=submit]").click();',
  'var b = await cua.getBrowser({id:"b"}); var tab = await b.tabs.new(); await (await tab.playwright.locator("button[type=submit]").all())[0].click();',
  'var tab = await cua.getTab("1"); await tab.playwright.frameLocator("iframe").locator("button[type=submit]").click();',
]) test(`unchanged click reports uncertainty: ${code}`, async () => {
  const f = fixture(); await f.run(code);
  assert.deepEqual(f.calls, ['click']);
  assert.match(f.notes.join('\n'), /page showed no change yet/i);
  assert.match(f.notes.join('\n'), /network.*unknown/i);
  assert.match(f.notes.join('\n'), /retry may submit twice/i);
});

for (const change of ['url', 'tree']) test(`${change} change never gets a no-change notice`, async () => {
  const f = fixture({ change }); await f.run('var tab = await cua.getTab("1"); await tab.click(12);');
  assert.deepEqual(f.notes, []);
});

test('an unreadable state adds no note and never prevents or replays input', async () => {
  const f = fixture({ unread: true }); await f.run('var tab = await cua.getTab("1"); await tab.click(12);');
  assert.deepEqual(f.calls, ['click']);
  assert.deepEqual(f.notes, []);
});

test('a swallowed click failure is still visible, while the original exception survives', async () => {
  const f = fixture({ fail: true });
  await f.run('var tab = await cua.getTab("1"); try { await tab.playwright.locator("button[type=submit]").click(); } catch {}');
  assert.match(f.notes.join('\n'), /click failed.*target missing/);
  await assert.rejects(f.run('var tab = await cua.getTab("1"); await tab.click(12);'), /target missing/);
});

test('native clicks and read-only tab calls are unchanged', async () => {
  const f = fixture();
  await f.run('var app = await cua.getApp("generic"); await app.click(12);');
  assert.deepEqual(f.notes, []);
  assert.equal(clickResultCode('await cua.listTabs()'), 'await cua.listTabs()');
});

test('a handle acquired on an earlier read reports a later click without another acquisition', async () => {
  const f = fixture(); await f.run('globalThis.tab = await cua.getTab("1");');
  assert.deepEqual(f.notes, []);
  await f.run('await tab.click(12);');
  assert.equal(f.notes.length, 1);
});

test('two acquisition paths and repeated setup report one result per click', async () => {
  const f = fixture();
  await f.run('var b = await cua.getBrowser({id:"b"}); await b.tabs.get("1");');
  await f.run('var tab = await cua.getTab("1"); await tab.playwright.locator("button[type=submit]").click();');
  assert.deepEqual(f.calls, ['click']); assert.equal(f.notes.length, 1);
});

test('locator arguments retain their engine identity after wrapping', async () => {
  const f = fixture();
  let raw, passed;
  raw = { click: async () => {}, filter: args => { passed = args.has; return raw; } };
  f.tab.playwright.locator = () => raw;
  await f.run('var tab = await cua.getTab("1"); var loc = tab.playwright.locator("button[type=submit]"); loc.filter({has:loc});');
  assert.equal(passed, raw);
});

test('normalized recorded checkout and travel submit attempts gain evidence without caller output', async () => {
  const checkout = fixture();
  await checkout.run('var tab = await cua.getTab("1"); await tab.playwright.locator("#pay").click();');
  assert.match(checkout.notes.join('\n'), /retry may submit twice/);
  const travel = fixture({ fail: true });
  await travel.run('var tab = await cua.getTab("1"); let submitBtn = tab.playwright.locator(\'button:has-text("Submit"), button[type="submit"]\').first(); try { await submitBtn.click(); } catch {} "Form submission attempted";');
  assert.match(travel.notes.join('\n'), /click failed/);
});

for (const spec of [{ role: 'switch' }, { role: 'menuitem' }, { popup: 'menu' }, { tag: 'INPUT', type: 'checkbox' },
  { tag: 'CUSTOM-SWITCH', type: undefined }, { tag: 'SPAN', type: undefined },
  { tag: 'INPUT', type: 'text' }, { type: 'button', inForm: false }]) test(`non-submit controls do not get a submit notice: ${JSON.stringify(spec)}`, async () => {
  const f = fixture(spec); await f.run('var tab = await cua.getTab("1"); await tab.playwright.locator("#pay").click();');
  assert.ok(f.reads.includes('metadata'), 'the local submit candidate must reach submitControl');
  assert.deepEqual(f.notes, []);
});

test('numbered submit buttons without an ID use their exact visible role and name', async () => {
  const f = fixture({ noId: true }); await f.run('var tab = await cua.getTab("1"); await tab.click(12);');
  assert.match(f.notes.join('\n'), /retry may submit twice/);
});

test('unreadable target metadata stays silent after the bounded pre-click hit test', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ hang: 'metadata' });
  const pending = f.run('var tab = await cua.getTab("1"); await tab.playwright.locator("button[type=submit]").click();');
  await tick(); assert.deepEqual(f.calls, []);
  t.mock.timers.tick(1001); await tick(); assert.deepEqual(f.calls, ['click']);
  t.mock.timers.tick(1501); await pending;
  assert.deepEqual(f.notes, []);
});

for (const code of ['await tab.playwright.locator("form input").press("Enter");']) test(`Enter submits are observed: ${code}`, async () => {
  const f = fixture({ tag: 'INPUT', type: 'text' });
  await f.run('var tab = await cua.getTab("1");' + code);
  assert.match(f.notes.join('\n'), /retry may submit twice/);
  assert.equal(f.calls.length, 1);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
test('a hanging before read never delays dispatch and each unreadable result stays silent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ hang: 'url' });
  const pending = f.run('var tab = await cua.getTab("1"); await tab.playwright.locator("button[type=submit]").click();');
  await tick(); assert.deepEqual(f.calls, ['click']);
  t.mock.timers.tick(1501); await pending;
  assert.deepEqual(f.notes, []);
});

test('before and after reads run in parallel pairs, adding only the after-read delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture({ readMs: 40, clickMs: 10 });
  const pending = f.run('var tab = await cua.getTab("1"); await tab.playwright.locator("button[type=submit]").click();');
  await tick(); assert.deepEqual(f.calls, ['click']);
  t.mock.timers.tick(10); await tick();
  t.mock.timers.tick(40); await pending;
  assert.equal(Date.now(), 50);
  assert.match(f.notes.join('\n'), /page showed no change yet/);
});

test('click reporting composes with the alias prelude without duplicate input', async () => {
  const f = fixture();
  const code = 'var tab = await cua.getTab("1"); await tab.playwright.locator("form input").press("Enter");';
  await runInContext('(async()=>{' + clickResultCode(browserAliasesCode(code)) + '})()', f.context);
  assert.deepEqual(f.calls, ['press']);
  assert.equal(f.notes.filter(note => /page showed no change yet/.test(note)).length, 1);
});

for (const code of ['await tab.playwright.getByRole("button", { name: "Expand details" }).click();',
  'await tab.playwright.getByRole("link", { name: "Pay" }).click();',
  'await tab.playwright.locator("#details").click();', 'await tab.click(12);']) {
  test(`an ordinary click reads only the locator hit test, with no submit observations: ${code}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const f = fixture({ row: 'Expand details', readMs: 100 });
    const pending = f.run('var tab = await cua.getTab("1");' + code);
    await tick();
    assert.deepEqual(f.reads, code.includes('playwright') ? ['metadata'] : []);
    await pending;
    assert.deepEqual(f.calls, ['click']);
    assert.deepEqual(f.notes, []);
    assert.equal(Date.now(), 0);
  });
}

for (const key of ['Control+Enter', 'Meta+Enter']) test(`${key} remains a submit-like action`, async () => {
  const f = fixture({ tag: 'INPUT', type: 'text' });
  await f.run(`var tab = await cua.getTab("1"); await tab.playwright.locator("form input").press(${JSON.stringify(key)});`);
  assert.match(f.notes.join('\n'), /retry may submit twice/);
  assert.deepEqual(f.calls, ['press']);
});

test('a failure before dispatch does not warn about a double submit', async () => {
  const f = fixture({ fail: true });
  await assert.rejects(f.run('var tab = await cua.getTab("1"); await tab.playwright.getByRole("button", {name:"Pay"}).click();'), /target missing/);
  assert.ok(!f.notes.join('\n').includes('submit twice'));
});

test('the relay observation cache supplies AX rows without another tab read', async () => {
  const { TabClickResults } = await import('../plugins/sleight/lib/tab-click-result.mjs');
  const observer = new TabClickResults();
  observer.observe({ content: [{type:'text', text:'Browser tab: 1, Title: "Form", URL: "https://example.test/form".\n\t12 button Pay, ID: pay'}] });
  const f = fixture();
  await runInContext('(async()=>{' + observer.code('var tab = await cua.getTab("1"); await tab.click(12);') + '})()', f.context);
  assert.ok(!f.reads.includes('ax'));
  assert.match(f.notes.join('\n'), /retry may submit twice/);
});

for (const code of ['await tab.playwright.locator("input").press("Enter");', 'await tab.pressKey(null,"Return");',
  'await tab.playwright.press("Enter");', 'await tab.playwright.locator("form + input").press("Enter");']) {
  test(`Enter without known form ancestry adds zero reads: ${code}`, async () => {
    const f = fixture({ tag: 'INPUT', type: 'text', inForm: false });
    await f.run('var tab = await cua.getTab("1");' + code);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.notes, []);
    assert.equal(f.calls.length, 1);
  });
}

test('diff replies preserve cached Pay buttons in the relay and caller-read paths', async () => {
  const { TabClickResults } = await import('../plugins/sleight/lib/tab-click-result.mjs');
  const header = 'Browser tab: 1, Title: "Form", URL: "https://example.test/form".\n';
  for (const diff of ['Accessibility tree diff:\n~\t13 text Changed\n+\t14 text Added', 'Accessibility tree diff: no changes']) {
    const observer = new TabClickResults();
    observer.observe({ content: [{ type: 'text', text: header + '\t12 button Pay, ID: pay' }] });
    observer.observe({ content: [{ type: 'text', text: header + diff }] });
    const f = fixture();
    await runInContext('(async()=>{' + observer.code('var tab = await cua.getTab("1"); await tab.click(12);') + '})()', f.context);
    assert.match(f.notes.join('\n'), /retry may submit twice/);
    const caller = fixture();
    caller.tab.getAXState = async () => header + diff;
    await caller.run('var tab = await cua.getTab("1"); await tab.getAXState(); await tab.click(12);');
    assert.match(caller.notes.join('\n'), /retry may submit twice/);
  }
});

test('a recorded demoid full tree with "- main:" after the rows is not a diff', () => {
  const demoid = `Browser tab: 1, Title: "Account", URL: "http://127.0.0.1:5420/t/demoid/shop/account".
0 AXWebArea Account
	1 button Home
	2 heading Account
- main:
	3 link Orders`;
  assert.equal(isDiffTree(demoid), false);
  const observer = new TabClickResults();
  observer.observe({ content: [{ type: 'text', text: 'Browser tab: 1, Title: "Form", URL: "https://example.test/form".\n\t12 button Pay, ID: pay' }] });
  observer.observe({ content: [{ type: 'text', text: demoid }] });
  assert.equal([...observer.trees.values()].join('\n').includes('Pay'), false);
  assert.equal(isDiffTree('The following is a diff from the previous accessibility tree for Browser tab: 1\n+\t80 button X'), true);
});

test('a full reply with no buttons clears the previous submit classification', async () => {
  const { TabClickResults } = await import('../plugins/sleight/lib/tab-click-result.mjs');
  const observer = new TabClickResults();
  observer.observe({ content: [{ type: 'text', text: 'Browser tab: 1, Title: "Form", URL: "https://example.test/form".\n\t12 button Pay' }] });
  observer.observe({ content: [{ type: 'text', text: 'Browser tab: 1, Title: "Receipt", URL: "https://example.test/done".\nThe focused UI element is 13 text Diff\n\t13 text Receipt' }] });
  const f = fixture();
  await runInContext('(async()=>{' + observer.code('var tab = await cua.getTab("1"); await tab.click(12);') + '})()', f.context);
  assert.deepEqual(f.reads, []);
});

// The engine scrolls the target to the center (resolvePointerActionTarget) and inputs at its box center,
// with no in-page hit test. `before` is the box before that scroll, `after` the box once it ran.
const CENTER = { block: 'center', inline: 'nearest', behavior: 'instant' };
function coveredFixture({ coverAt = () => true, descendant = false, shadowHost = false, shadowRoot = false, unread = false, hang = false,
  before = { left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }, after = before, labelled = false, control = false,
  hitLabels = false, nested = false } = {}) {
  const f = fixture();
  let clicks = 0, rect = before;
  const scrolls = [], evaluates = [], points = [];
  const region = { tagName: 'DIV', textContent: 'Fixture notice Accept all', parentElement: undefined,
    getAttribute: name => ({ role: 'region', 'aria-label': 'Fixture notice' })[name] ?? null,
    closest: () => region, contains: node => node === region || node === accept };
  const accept = { tagName: 'BUTTON', textContent: 'Accept all', parentElement: region,
    getAttribute: () => null, contains: node => node === accept };
  accept.closest = () => region;
  const element = { tagName: 'BUTTON', type: 'submit',
    labels: labelled ? [{ contains: node => node === region }] : undefined,
    control: control ? region : undefined,
    getAttribute: () => null, closest: name => name === 'form' ? {} : null,
    scrollIntoView: options => { scrolls.push(options); rect = after; },
    getBoundingClientRect: () => ({ ...rect }),
    contains: node => node === element || descendant,
    getRootNode: () => shadowRoot ? root : { host: shadowHost ? region : undefined },
  };
  if (hitLabels) region.labels = [element];
  const doc = { documentElement: { clientWidth: 800, clientHeight: 600 },
    defaultView: { requestAnimationFrame: callback => queueMicrotask(callback) },
    elementFromPoint: (x, y) => { points.push([x, y]); return coverAt(x, y) ? (nested ? accept : region) : element; } };
  // An open shadow root answers hit tests inside its own tree.
  const root = { host: undefined, elementFromPoint: (x, y) => { points.push(['root', x, y]); return element; } };
  element.ownerDocument = doc;
  const raw = { count: async () => 1, click: async () => { clicks++; },
    evaluate: async (fn, arg, options) => {
      evaluates.push(arg);
      if (unread) throw Error('hit test unavailable');
      if (hang) return new Promise(() => {});
      if (options) assert.equal(options.timeoutMs, 1000);
      return fn(element, arg);
    }, first: () => loc };
  const loc = new Proxy(raw, { get(target, key) {
    if (!(key in target)) throw Error('unsupported engine locator method: ' + String(key));
    return target[key];
  } });
  f.tab.playwright.locator = () => loc;
  return { ...f, clicks: () => clicks, scrolls, evaluates, points };
}
const clickDetails = (options = '') => `var tab = await cua.getTab("1"); await tab.playwright.locator("#details").click(${options});`;

test('a locator click covered after the engine center scroll is refused once, with no input', async () => {
  const f = coveredFixture();
  await assert.rejects(f.run(clickDetails()), /sleight: click target is covered by region Fixture notice\. Dismiss or move the cover before clicking\./);
  assert.equal(f.clicks(), 0);
  assert.equal(JSON.stringify(f.scrolls), JSON.stringify([CENTER]));
  assert.deepEqual(f.points, [[60, 40]]);
  // The refusal is the thrown error alone, not also a written note.
  assert.deepEqual(f.notes, []);
});

test('a cover is named by the element hit and its labelled container', async () => {
  const f = coveredFixture({ nested: true });
  await assert.rejects(f.run(clickDetails()), /covered by button Accept all in region Fixture notice\./);
  assert.equal(f.clicks(), 0);
});

// A fixed header covers the target before the scroll; the center scroll moves it clear.
test('a target covered only before the engine center scroll reaches the engine', async () => {
  const f = coveredFixture({ before: { left: 10, top: -10, right: 110, bottom: 30, width: 100, height: 40 },
    after: { left: 10, top: 280, right: 110, bottom: 320, width: 100, height: 40 }, coverAt: (x, y) => y < 40 });
  await f.run(clickDetails());
  assert.equal(f.clicks(), 1); assert.deepEqual(f.notes, []);
  assert.deepEqual(f.points, [[60, 300]]);
});

// An in-viewport target is clear where it sits, but the center scroll puts it under a fixed band.
test('an in-viewport target that the center scroll moves under a fixed overlay is refused', async () => {
  const f = coveredFixture({ before: { left: 10, top: 500, right: 110, bottom: 540, width: 100, height: 40 },
    after: { left: 10, top: 280, right: 110, bottom: 320, width: 100, height: 40 }, coverAt: (x, y) => y > 250 && y < 350 });
  await assert.rejects(f.run(clickDetails()), /covered by region Fixture notice/);
  assert.equal(f.clicks(), 0);
});

test('a box center outside the viewport after the scroll defers to the engine', async () => {
  const f = coveredFixture({ after: { left: 900, top: 280, right: 1000, bottom: 320, width: 100, height: 40 } });
  await f.run(clickDetails());
  assert.equal(f.clicks(), 1); assert.deepEqual(f.points, []);
});

for (const options of ['{ force: true }', '{ trial: true }']) {
  test(`a ${options} locator click skips the cover check`, async () => {
    const f = coveredFixture();
    await f.run(clickDetails(options));
    assert.equal(f.clicks(), 1); assert.deepEqual(f.evaluates, []); assert.deepEqual(f.scrolls, []);
  });
}

test('a target in a shadow root is hit-tested by its own root', async () => {
  const f = coveredFixture({ shadowRoot: true });
  await f.run(clickDetails());
  assert.equal(f.clicks(), 1); assert.deepEqual(f.points, [['root', 60, 40]]);
});

for (const spec of [{ coverAt: () => false }, { descendant: true }, { shadowHost: true }, { unread: true }, { labelled: true },
  { control: true }, { hitLabels: true }]) {
  test(`an unobstructed, own-label or unreadable hit test preserves one locator click: ${JSON.stringify(spec)}`, async () => {
    const f = coveredFixture(spec);
    await f.run('var tab = await cua.getTab("1"); await tab.playwright.locator("#details").first().click();');
    assert.equal(f.clicks(), 1);
    assert.deepEqual(f.notes, []);
  });
}

test('a hanging hit test expires and never stalls or repeats an ordinary locator click', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = coveredFixture({ hang: true });
  const pending = f.run(clickDetails());
  await tick(); assert.equal(f.clicks(), 0);
  t.mock.timers.tick(1001); await pending;
  assert.equal(f.clicks(), 1);
  assert.deepEqual(f.notes, []);
});
