import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { tabCleanupCode, cleanupTabsCode } from '../plugins/sleight/lib/browser-tab-cleanup.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture() {
  const closed = [], selected = new Map(), tabs = new Map(), listed = new Map();
  let next = 0, selectionFails = false;
  const raw = id => ({ id, playwright: { evaluate: async () => ({ loading: false, edited: false }) }, close: async () => closed.push(id), markDeliverable: async () => {}, markHandoff: async () => {} });
  const cua = {
    createBrowserTab: async (browser, url = 'about:blank') => { const tab = raw(String(++next));
      tab.goto = async url => listed.set(tab.id, { id: tab.id, url });
      tabs.set(tab.id, tab); listed.set(tab.id, { id: tab.id, url }); return tab; },
    getTab: async id => tabs.get(id) ?? raw(id),
    getBrowser: async ({ id }) => ({ browserId: id, tabs: { list: async () => [...listed.values()], new: async () => cua.createBrowserTab(id), selected: async () => {
      if (selectionFails) throw new Error('unavailable');
      return selected.has(id) ? { id: selected.get(id) } : undefined;
    } } }),
  };
  const notes = [];
  const context = createContext({ cua, setTimeout, clearTimeout, Date, URL, nodeRepl: { write: text => notes.push(text) } });
  const run = code => runInContext(`(async () => { ${code} })()`, context);
  return { closed, selected, listed, cua, run, context, notes, failSelection: () => { selectionFails = true; } };
}

test('loaded select, range and color defaults do not preserve an untouched tab', async () => {
  for (const el of [
    { tagName: 'SELECT', size: 1, selectedIndex: 1, options: [{ disabled: true }, { selected: true }] },
    { tagName: 'SELECT', size: 1, selectedIndex: 1, options: [{ parentElement: { tagName: 'OPTGROUP', disabled: true } }, { selected: true }] },
    { tagName: 'SELECT', size: 4, selectedIndex: -1, options: [{}, {}] },
    { tagName: 'SELECT', multiple: true, selectedIndex: -1, options: [{}, {}] },
    { tagName: 'INPUT', type: 'range', value: '50', defaultValue: '', checked: false, defaultChecked: false },
    { tagName: 'INPUT', type: 'color', value: '#000000', defaultValue: '', checked: false, defaultChecked: false },
  ]) {
    const f = fixture();
    await f.run(tabCleanupCode('globalThis.tab = await cua.createBrowserTab("b", "https://example.test/form");'));
    f.context.document = { readyState: 'complete', querySelectorAll: () => [el] };
    f.context.tab.playwright.evaluate = async fn => fn();
    await f.run(cleanupTabsCode);
    assert.deepEqual(f.closed, ['1'], JSON.stringify(el));
  }
});

test('a fresh listing must match the owned id and origin immediately before close', async () => {
  for (const replacement of [undefined, { id: '1', url: 'https://other.test/page' }, { id: '1' }]) {
    const f = fixture();
    await f.run(tabCleanupCode('globalThis.tab = await cua.createBrowserTab("b", "https://example.test/form");'));
    f.context.tab.playwright.evaluate = async () => {
      f.listed.clear(); if (replacement) f.listed.set('1', replacement);
      return { loading: false, edited: false };
    };
    await f.run(cleanupTabsCode);
    assert.deepEqual(f.closed, [], String(JSON.stringify(replacement)));
    assert.match(f.notes.join('\n'), /kept tab 1.*identity/);
  }
});

test('owned navigation records the new origin and same-origin navigation remains eligible', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('var tab = await cua.createBrowserTab("b"); await tab.goto("https://example.test/form");'));
  f.listed.set('1', { id: '1', url: 'https://example.test/next' });
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['1']);
});

test('edited or loading tabs survive with a turn-end note', async () => {
  for (const state of [{ loading: false, edited: true }, { loading: true, edited: false }]) {
    const f = fixture();
    await f.run(tabCleanupCode('globalThis.tab = await cua.createBrowserTab("b");'));
    f.context.tab.playwright.evaluate = async () => state;
    await f.run(cleanupTabsCode);
    assert.deepEqual(f.closed, []);
    assert.match(f.notes.join('\n'), /kept tab 1.*(?:form input|loading)/);
  }
});

test('form preservation reads input, textarea and select defaults without mutation', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('globalThis.tab = await cua.createBrowserTab("b");'));
  let read;
  f.context.tab.playwright.evaluate = async fn => { read = fn; return { loading: false, edited: true }; };
  await f.run(cleanupTabsCode);
  for (const el of [
    { tagName: 'INPUT', value: 'new', defaultValue: 'old', checked: false, defaultChecked: false },
    { tagName: 'INPUT', value: '', defaultValue: '', checked: true, defaultChecked: false },
    { tagName: 'TEXTAREA', value: 'new', defaultValue: '' },
    { tagName: 'SELECT', options: [{ selected: true, defaultSelected: false }] },
  ]) {
    f.context.document = { readyState: 'complete', querySelectorAll: selector => {
      assert.equal(selector, 'input, textarea, select'); return [el];
    } };
    assert.equal(read().edited, true);
  }
  f.context.document = { readyState: 'loading', querySelectorAll: () => [] };
  assert.equal(read().loading, true);
});

test('single selects use their selected attribute or the first option as the default', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('globalThis.tab = await cua.createBrowserTab("b");'));
  let read;
  f.context.tab.playwright.evaluate = async fn => { read = fn; return { loading: false, edited: false }; };
  await f.run(cleanupTabsCode);
  for (const [select, edited] of [
    [{ selectedIndex: 0, options: [{ selected: true, defaultSelected: false }, { selected: false, defaultSelected: false }] }, false],
    [{ selectedIndex: 1, options: [{ selected: false, defaultSelected: false }, { selected: true, defaultSelected: false }] }, true],
    [{ selectedIndex: 1, options: [{ selected: false, defaultSelected: false }, { selected: true, defaultSelected: true }] }, false],
    [{ selectedIndex: 0, options: [{ selected: true, defaultSelected: false }, { selected: false, defaultSelected: true }] }, true],
    [{ selectedIndex: -1, options: [] }, false],
    [{ multiple: true, options: [{ selected: true, defaultSelected: false }] }, true],
    [{ multiple: true, options: [{ selected: true, defaultSelected: true }] }, false],
  ]) {
    f.context.document = { readyState: 'complete', querySelectorAll: () => [{ tagName: 'SELECT', ...select }] };
    assert.equal(read().edited, edited, JSON.stringify(select));
  }
});

test('browser.tabs.new is tracked and marked tabs remain open', async () => {
  const f = fixture();
  // Bypass createBrowserTab, as the engine's browser.tabs.new does.
  const browser = { browserId: 'b', tabs: { list: async () => [{ id: 'new', url: 'about:blank' }], selected: async () => undefined, new: async () => ({
    id: 'new', playwright: { evaluate: async () => ({ loading: false, edited: false }) },
    close: async () => f.closed.push('new'), markHandoff: async () => {},
  }) } };
  f.cua.getBrowser = async () => browser;
  await f.run(tabCleanupCode('globalThis.browser = await cua.getBrowser({ id: "b" }); var tab = await browser.tabs.new();'));
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['new']);
  await f.run('var kept = await browser.tabs.new(); await kept.markHandoff();');
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['new']);
});

test('cleanup closes only tabs created by this session', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('var made = await cua.createBrowserTab("b"); var existing = await cua.getTab("user");'));
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['1']);
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['1']);
});

test('deliverables and handoffs survive cleanup, including a newly bound handle', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('var a = await cua.createBrowserTab("b"); var b = await cua.createBrowserTab("b");'));
  await f.run('await (await cua.getTab("1")).markDeliverable(); await (await cua.getTab("2")).markHandoff();');
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, []);
});

test('the selected tab in each browser survives cleanup', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('var a = await cua.createBrowserTab("one"); var b = await cua.createBrowserTab("two"); var c = await cua.createBrowserTab("two");'));
  f.selected.set('one', '1'); f.selected.set('two', '3');
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['2']);
});

test('an unavailable selection check leaves every tab in that browser open', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('await cua.createBrowserTab("b");'));
  f.failSelection();
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, []);
  assert.match(f.notes.join('\n'), /kept tab 1.*selection.*could not/);
});

test('explicit closes and missing close methods do not prevent later cleanup', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('var a = await cua.createBrowserTab("b"); await a.close(); var b = await cua.createBrowserTab("b"); delete b.close; await cua.createBrowserTab("b");'));
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['1', '3']);
});

test('setup is idempotent and does not access browsers before the caller does', async () => {
  const f = fixture();
  assert.equal(tabCleanupCode('await cua.listApps()'), 'await cua.listApps()');
  await f.run(tabCleanupCode('await cua.createBrowserTab("b");'));
  await f.run(tabCleanupCode('await cua.createBrowserTab("b");'));
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['1', '2']);
});

test('a stalled selection is bounded and cannot close a tab after its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture();
  await f.run(tabCleanupCode('await cua.createBrowserTab("b");'));
  let release;
  f.cua.getBrowser = async () => ({ tabs: { selected: () => new Promise(resolve => { release = resolve; }) } });
  let finished = false;
  const pending = f.run(cleanupTabsCode).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, true, 'cleanup must return at its deadline');
  await pending;
  release(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.closed, []);
  f.cua.getBrowser = async () => ({ tabs: { list: async () => [...f.listed.values()], selected: async () => undefined } });
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, ['1'], 'the next explicit cleanup retries deadline leftovers');
});

test('a failed form read leaves the tab open', async () => {
  const f = fixture();
  await f.run(tabCleanupCode('globalThis.tab = await cua.createBrowserTab("b");'));
  f.context.tab.playwright.evaluate = async () => { throw new Error('unavailable'); };
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, []);
  assert.match(f.notes.join('\n'), /kept tab 1.*form state.*could not/);
});

test('a hung action cannot hold an explicit turn end beyond the drain grace', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [], replies = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, stopGraceMs: 50 });
  const send = (id, name, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: code ? { code } : {} } }) + '\n');
  const answer = id => serverOut.write(JSON.stringify({ id, result: { content: [] } }) + '\n');
  try {
    send(1, 'js', 'var tab = await cua.createBrowserTab("b")'); answer(1);
    send(2, 'js', 'await tab.click(1)');
    send(3, 'turn_ended');
    assert.equal(sent.at(-1).id, 2);
    t.mock.timers.tick(51);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.at(-1).params.name, 'turn_ended');
    assert.equal(sent.at(-1).id, 3);
    assert.equal(sent.some(m => String(m.id).startsWith('sleight-tab-cleanup-')), false);
    answer(3);
    assert.match(JSON.stringify(replies.find(m => m.id === 3)), /kept tabs.*call.*deadline/);
  } finally { relay.dispose(); }
});

test('a failed mark still preserves the requested deliverable', async () => {
  const f = fixture();
  const create = f.cua.createBrowserTab;
  f.cua.createBrowserTab = async (...args) => {
    const tab = await create(...args);
    tab.markDeliverable = async () => { throw new Error('extension unavailable'); };
    return tab;
  };
  await assert.rejects(f.run(tabCleanupCode('await (await cua.createBrowserTab("b")).markDeliverable();')), /extension unavailable/);
  await f.run(cleanupTabsCode);
  assert.deepEqual(f.closed, []);
});

test('relay runs tab cleanup before forwarding the turn end and hides its reply', async () => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', bytes => { for (const line of bytes.toString().trim().split('\n')) sent.push(JSON.parse(line)); });
  clientOut.on('data', bytes => { for (const line of bytes.toString().trim().split('\n')) replies.push(JSON.parse(line)); });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
  const answer = (id, text = '') => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }) + '\n');
  try {
    send({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'var tab = await cua.createBrowserTab("b")' } } });
    assert.match(sent.at(-1).params.arguments.code, /__sleightTabs/);
    answer(1);
    send({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: {} } });
    assert.equal(sent.at(-1).params.name, 'js');
    assert.match(sent.at(-1).params.arguments.code, /^nodeRepl.write\(await globalThis\.__sleightTabs\?\.cleanup\(\d+\)\);$/);
    const cleanupId = sent.at(-1).id, before = sent.length;
    send({ id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'await tab.click(1)' } } });
    assert.equal(sent.length, before, 'new input cannot race tab cleanup');
    assert.equal(replies.at(-1).id, 3);
    assert.equal(replies.at(-1).result.isError, true);
    answer(cleanupId, 'private cleanup output');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.at(-1).params.name, 'turn_ended');
    answer(2);
    assert.equal(replies.some(r => JSON.stringify(r).includes('private cleanup output')), false);
  } finally { relay.dispose(); }
});

test('idle turn end preserves tabs and the next explicit end retries cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [], replies = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, idleTurnEndMs: 50 });
  const send = (id, name, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: code ? { code } : {} } }) + '\n');
  const answer = (id, text = '') => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }] } }) + '\n');
  try {
    send(1, 'js', 'var tab = await cua.createBrowserTab("b")'); answer(1);
    t.mock.timers.tick(51);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.at(-1).params.name, 'turn_ended');
    assert.equal(sent.some(m => String(m.id).startsWith('sleight-tab-cleanup-')), false);
    answer(sent.at(-1).id);
    send(2, 'turn_ended');
    assert.match(String(sent.at(-1).id), /^sleight-tab-cleanup-/);
    answer(sent.at(-1).id, 'sleight: kept tab 1 because it has form input.');
    await new Promise(resolve => setImmediate(resolve)); answer(2);
    assert.match(JSON.stringify(replies.find(m => m.id === 2)), /kept tab 1/);
    send(3, 'turn_ended');
    assert.match(String(sent.at(-1).id), /^sleight-tab-cleanup-/);
    answer(sent.at(-1).id);
    await new Promise(resolve => setImmediate(resolve)); answer(3);
  } finally { relay.dispose(); }
});

for (const mode of ['Stop', 'endOpenTurn', 'shutdown']) {
  test(`${mode} orders cleanup before ending the turn and bounds an unanswered cleanup`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
    const sent = [], replies = [];
    let collected = 0;
    serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
      stopEngine: async () => { collected++; return { collected: true }; }, inspectInput: async () => ({ ok: true }) });
    const answer = (id, text = '') => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }] } }) + '\n');
    const call = (id, name, args) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    try {
      call(1, 'js', { code: 'var tab = await cua.createBrowserTab("b")' }); answer(1);
      const pending = mode === 'Stop' ? call(2, 'turn_ended', { sleight_stop: true }) : relay[mode]();
      const cleanup = sent.at(-1);
      assert.match(String(cleanup.id), /^sleight-tab-cleanup-/);
      assert.equal(collected, 0);
      t.mock.timers.tick(3001);
      await new Promise(resolve => setImmediate(resolve));
      const ended = sent.at(-1);
      assert.equal(ended.params.name, 'turn_ended');
      answer(ended.id);
      await new Promise(resolve => setImmediate(resolve));
      await pending;
      answer(cleanup.id, 'late private cleanup output');
      assert.equal(replies.some(reply => JSON.stringify(reply).includes('late private')), false);
      if (mode === 'Stop') {
        assert.equal(collected, 1);
        assert.match(JSON.stringify(replies.find(reply => reply.id === 2)), /kept tabs.*cleanup.*deadline/);
      }
    } finally { relay.dispose(); }
  });
}
