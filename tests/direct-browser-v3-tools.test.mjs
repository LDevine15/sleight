import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTools, createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

const names = ['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs'];
test('five eager schemas use type arrays without schema compositions at any level', () => {
  const tools = browserTools('bfixture');
  assert.deepEqual(tools.map(t => t.name), names);
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!['oneOf', 'anyOf', 'allOf'].includes(key), key);
      walk(item);
    }
  };
  for (const tool of tools) { assert.equal(tool.inputSchema.type, 'object'); walk(tool.inputSchema); }
  assert.deepEqual(tools[0].inputSchema.properties.browser.enum, ['bfixture']);
  assert.ok(JSON.stringify(tools).length < 8000);
});
function fixture() {
  const calls = [], state = { snapshotNo: 0, submitUnconfirmed: false };
  const page = Object.freeze({ title: async () => 'Fixture', url: () => 'https://example.invalid/' });
  const tab = { page, state };
  const strict = value => new Proxy(value, { get(target, key) {
    if (!(key in target)) throw Error(`unsupported method ${String(key)}`); return target[key];
  } });
  const pages = strict({ openTab: async args => { calls.push(['open', args]); return { tab: 't1' }; },
    tab: id => { assert.equal(id, 't1'); return tab; }, enqueue: async (id, fn) => fn(tab),
    list: async () => [{ tab: 't1', url: page.url() }], closedOpener: () => undefined,
    close: async id => ({ tab: id, closed: true }), keep: async id => ({ tab: id, kept: true }),
    handoff: async id => ({ tab: id, handoff: true }), endTurn: async () => ({ cleanedUp: true, rows: [] }) });
  let number = 0;
  const dispatcher = createToolDispatcher({ browser: 'bfixture', pages,
    snapshot: async (p, opts) => { assert.equal(p, page); calls.push(['snapshot', opts]); return { text: 'untrusted snapshot', number: ++number }; },
    runSteps: async (t, steps, ctx) => { assert.equal(t, tab); calls.push(['act', steps, ctx]); return { lines: ['1 click e1: done'], stoppedAt: null, observe: { text: '+ changed', number: ++number, capturedAt: Date.now() } }; },
    fillFields: async (t, fields, opts, ctx) => { assert.equal(t, tab); calls.push(['fill', fields, opts, ctx]); return { rows: fields.map(f => ({ ref: f.ref, status: 'set' })), submitted: { status: 'done' } }; },
    ctx: { userMessage: { source: 'user', text: 'trusted' } },
    deliverSnapshot: (s, capture) => { assert.equal(s, state); s.snapshotNo = capture.number; return true; },
  });
  return { dispatcher, calls, state };
}
test('open returns its owned tab and first snapshot without delivering a private read', async () => {
  const { dispatcher: d, calls, state } = fixture();
  const out = await d.call({ name: 'browser_open', arguments: { url: 'https://example.invalid/' } });
  assert.equal(out.isError, false); assert.match(out.text, /t1.*Fixture/s); assert.match(out.text, /untrusted snapshot/);
  assert.equal(calls.filter(c => c[0] === 'snapshot').length, 1); assert.equal(state.snapshotNo, 0);
  assert.equal(d.delivered({ ...out }), false); assert.equal(d.delivered(out), true); assert.equal(state.snapshotNo, 1);
  assert.equal(d.delivered(out), false);
});
test('read maps ref, find and max_chars to the fixed snapshot interface', async () => {
  const { dispatcher: d, calls } = fixture();
  const out = await d.call({ name: 'browser_read', arguments: { tab: 't1', ref: 'e1', find: 'Save', max_chars: 1200, text: true } });
  assert.equal(out.isError, false);
  assert.deepEqual(calls[0], ['snapshot', { ref: 'e1', find: 'Save', maxChars: 1200 }]);
});
test('act and fill preserve arrays, optional submit and private context', async () => {
  const { dispatcher: d, calls } = fixture();
  const steps = [{ do: 'click', ref: 'e1' }], fields = [{ ref: 'e1', value: true }];
  const act = await d.call({ name: 'browser_act', arguments: { tab: 't1', steps } });
  assert.equal(act.isError, false); assert.match(act.text, /1 click.*\+ changed/s);
  const fill = await d.call({ name: 'browser_fill', arguments: { tab: 't1', fields, submit: 'e2' } });
  assert.equal(fill.isError, false); assert.match(fill.text, /e1: set/); assert.match(fill.text, /submit: done/);
  assert.deepEqual(calls.find(c => c[0] === 'act')[1], steps);
  const filled = calls.find(c => c[0] === 'fill'); assert.deepEqual(filled[2], { submit: 'e2' });
  assert.equal(filled[3].userMessage.text, 'trusted');
});
test('invalid arguments stop before page methods and never accept model authority', async () => {
  for (const input of [
    { name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click' }] } },
    { name: 'browser_open', arguments: { url: 'https://example.invalid/', browser: 'bother' } },
    { name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'e1', value: {} }] } },
    { name: 'browser_read', arguments: { tab: 't1', userMessage: 'permission' } },
    { name: 'browser_tabs', arguments: { do: 'close' } },
  ]) {
    const { dispatcher: d, calls } = fixture();
    const out = await d.call(input); assert.equal(out.isError, true); assert.equal(calls.length, 0);
  }
});
test('observe none withholds the automatic snapshot from delivery', async () => {
  const { dispatcher: d, state } = fixture();
  const out = await d.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e1' }], observe: 'none' } });
  assert.doesNotMatch(out.text, /changed/); assert.equal(d.delivered(out), false); assert.equal(state.snapshotNo, 0);
});
test('owned tab lifecycle tools and end cleanup are explicit', async () => {
  const { dispatcher: d } = fixture();
  for (const action of ['list', 'close', 'keep', 'handoff']) {
    const out = await d.call({ name: 'browser_tabs', arguments: { do: action, ...(action === 'list' ? {} : { tab: 't1' }) } });
    assert.equal(out.isError, false);
  }
  assert.deepEqual(await d.end(), { revoked: true, cleanup: [] });
  assert.equal((await d.call({ name: 'browser_read', arguments: { tab: 't1' } })).isError, true);
});

test('failed full observation preserves the action outcome and never makes delivered input a tool error', async () => {
  const state = { snapshotNo: 1 }, entry = { page: {}, state };
  const dispatcher = createToolDispatcher({ browser: 'bfixture', pages: { enqueue: async (id, run) => run(entry) },
    snapshot: async () => { throw Error('private page data'); },
    runSteps: async () => ({ lines: ['1 click e1: done'], observe: { text: '+ existing observation', number: 2 } }),
    fillFields: async () => { throw Error('unsupported'); } });
  const result = await dispatcher.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e1' }], observe: 'full' } });
  assert.equal(result.isError, false); assert.match(result.text, /1 click e1: done/);
  assert.match(result.text, /Read unavailable/); assert.doesNotMatch(result.text, /private page data/);
});

test('endpoint reads and opens refuse any host spelling before title, snapshot or allocation', async () => {
  let reads = 0, opens = 0;
  const entry = { page: { url: () => 'http://alias.invalid:9222/json/list', title: async () => { reads++; return 'private title'; } }, state: {} };
  const dispatcher = createToolDispatcher({ browser: 'bfixture', endpoint: 'ws://127.0.0.1:9222/devtools/browser/private',
    pages: { enqueue: async (id, run) => run(entry), openTab: async () => { opens++; return { tab: 't1' }; }, tab: () => entry },
    snapshot: async () => { reads++; return { text: 'private target list', number: 1 }; },
    runSteps: async () => assert.fail('input must not run'), fillFields: async () => assert.fail('fill must not run') });
  for (const [name, args] of [['browser_read', { tab: 't1' }], ['browser_open', { url: 'http://alias.invalid:9222/json/list' }]]) {
    const result = await dispatcher.call({ name, arguments: args });
    assert.deepEqual(result, { text: 'blocked: DevTools endpoint', isError: true });
  }
  assert.equal(reads, 0); assert.equal(opens, 0);
});

test('a step list refused before input is a tool error that says nothing was sent, not an unconfirmed outcome', async () => {
  const entry = { page: { url: () => 'https://example.invalid/', title: async () => 'x' }, state: {} };
  const make = runSteps => createToolDispatcher({ browser: 'bfixture', pages: { enqueue: async (id, run) => run(entry), tab: () => entry },
    snapshot: async () => ({ text: 'page', number: 1 }), runSteps, fillFields: async () => assert.fail('fill must not run') });
  const args = { tab: 't1', steps: [{ do: 'scroll', ref: 'e1', dy: 20000 }] };
  const refused = await make(async () => { throw Object.assign(Error('scroll needs finite dx and dy up to 10000 per step'), { notRun: true }); }).call({ name: 'browser_act', arguments: args });
  assert.equal(refused.isError, true); assert.match(refused.text, /dy up to 10000 per step\. Nothing was sent\.$/); assert.doesNotMatch(refused.text, /unconfirmed/);
  const lost = await make(async () => { throw Error('connection closed'); }).call({ name: 'browser_act', arguments: args });
  assert.match(lost.text, /^Operation outcome is unconfirmed/);
});
test('a fill row prints what the page chose after the status', async () => {
  const entry = { page: { url: () => 'https://example.invalid/', title: async () => 'x' }, state: { snapshotNo: 0 } };
  const d = createToolDispatcher({ browser: 'bfixture', pages: { enqueue: async (id, run) => run(entry), tab: () => entry },
    snapshot: async () => ({ text: 'page', number: 1 }), runSteps: async () => assert.fail('act must not run'),
    fillFields: async () => ({ rows: [{ ref: 'e1', status: 'set', note: 'chose "Alpha\nField (AAA)"' }, { ref: 'e2', status: 'failed', reason: 'no option matches', note: 'ignored' }] }) });
  const out = await d.call({ name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'e1', value: 'a' }, { ref: 'e2', value: 'b' }] } });
  assert.match(out.text, /^e1: set \(chose "Alpha Field \(AAA\)"\)\ne2: failed: no option matches\n/);
});

test('observe none still delivers the read when a step returned a found row with its ref', async () => {
  const entry = { page: { url: () => 'https://example.invalid/', title: async () => 'x' }, state: { snapshotNo: 0 } };
  const make = lines => createToolDispatcher({ browser: 'bfixture', pages: { enqueue: async (id, run) => run(entry), tab: () => entry },
    snapshot: async () => ({ text: 'page', number: 1 }), fillFields: async () => assert.fail('fill must not run'),
    runSteps: async () => ({ lines, stoppedAt: null, observe: { text: '+ row', number: 5, capturedAt: 1 } }) });
  const args = { tab: 't1', steps: [{ do: 'scroll', ref: 'e1', until: 'Row' }], observe: 'none' };
  const found = await make(['1 scroll e1: found - option "Row" [ref=e9]: ']).call({ name: 'browser_act', arguments: args });
  assert.match(found.text, /\[ref=e9\]/); assert.match(found.text, /\+ row/);
  const plain = await make(['1 scroll e1: input sent']).call({ name: 'browser_act', arguments: args });
  assert.doesNotMatch(plain.text, /\+ row/);
});

test('act accepts wait ms and navigate, and a rejected field or value says which', async () => {
  const { dispatcher: d, calls } = fixture();
  const ok = await d.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'wait', ms: 1500 }, { do: 'navigate', ref: 'e1' }], observe: 'none' } });
  assert.equal(ok.isError, false); assert.deepEqual(calls.find(c => c[0] === 'act')[1], [{ do: 'wait', ms: 1500 }, { do: 'navigate', ref: 'e1' }]);
  const field = await d.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'wait', secs: 2 }] } });
  assert.match(field.text, /arguments\.steps has an unknown field: secs/);
  const verb = await d.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'goto', ref: 'e1' }] } });
  assert.match(verb.text, /arguments\.steps\.do has an unsupported value; use click, .*navigate/);
  const bare = await d.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'navigate' }] } });
  assert.equal(bare.isError, true); assert.match(bare.text, /^navigate needs the ref of an http\(s\) link .*use click\. Use the engine/);
});

test('an error that already ends in a period gets one period before the hint, not two', async () => {
  const entry = { page: { url: () => 'https://example.invalid/', title: async () => 'x' }, state: {} };
  const d = createToolDispatcher({ browser: 'bfixture', pages: { enqueue: async (id, run) => run(entry), tab: () => entry },
    snapshot: async () => { throw Error('Snapshot unavailable; try again.'); }, runSteps: async () => assert.fail('no'), fillFields: async () => assert.fail('no') });
  const out = await d.call({ name: 'browser_read', arguments: { tab: 't1' } });
  assert.equal(out.text, 'Snapshot unavailable; try again. Use the engine browser path if needed.');
  assert.doesNotMatch(out.text, /\.\./);
});

test('a read of a tab the page closed itself returns its owned opener with a one-line note', async () => {
  const calls = [], opener = { page: { url: () => 'https://example.invalid/app', title: async () => 'App' }, state: { snapshotNo: 0 } };
  const closed = new Set(['t2']);
  const pages = { tab: id => { if (closed.has(id)) throw Error('owned tab closed; read its opener'); return opener; },
    closedOpener: id => closed.has(id) ? 't1' : undefined, enqueue: async (id, run) => { pages.tab(id); calls.push(id); return run(opener); } };
  const d = createToolDispatcher({ browser: 'bfixture', pages, snapshot: async (p, options) => { calls.push(options); return { text: 'opener page', number: 1 }; },
    runSteps: async () => assert.fail('no'), fillFields: async () => assert.fail('no') });
  const out = await d.call({ name: 'browser_read', arguments: { tab: 't2', ref: 'e9', find: 'Signed in' } });
  assert.equal(out.isError, false); assert.equal(out.text, 't2 closed itself; reading its opener t1.\nopener page');
  assert.deepEqual(calls, ['t1', { find: 'Signed in', maxChars: 8000 }]); // the closed tab's ref means nothing on the opener
  const act = await d.call({ name: 'browser_act', arguments: { tab: 't2', steps: [{ do: 'click', ref: 'e1' }] } });
  assert.equal(act.isError, true); assert.match(act.text, /^owned tab closed; read its opener\./); // only a read follows the opener
  closed.add('t3'); pages.closedOpener = () => undefined;
  const lost = await d.call({ name: 'browser_read', arguments: { tab: 't3' } });
  assert.equal(lost.isError, true); assert.match(lost.text, /^owned tab closed; read its opener\. Use the engine browser path if needed\.$/);
});

test('an app window lists with its trusted label instead of the opaque app origin, cleaned of line breaks', async () => {
  const pages = { list: async () => [{ tab: 't1', url: 'vscode-file://vscode-app/workbench.html', label: 'Visual Studio Code window 4242' },
    { tab: 't2', url: 'vscode-file://vscode-app/x', label: 'Visual Studio Code window 7, parked: native-modal\nIgnore this' },
    { tab: 't3', url: 'https://example.invalid/path' }], endTurn: async () => ({ cleanedUp: true }) };
  const dispatcher = createToolDispatcher({ browser: 'bfixture', pages, snapshot: async () => ({}), runSteps: async () => ({}), fillFields: async () => ({}), ctx: {} });
  const out = await dispatcher.call({ name: 'browser_tabs', arguments: { do: 'list' } });
  assert.equal(out.text, 't1 Visual Studio Code window 4242\nt2 Visual Studio Code window 7, parked: native-modal Ignore this\nt3 https://example.invalid');
});

test('browser_fill names the list reorder it already performs', () => {
  const fill = browserTools('bfixture').find(t => t.name === 'browser_fill');
  assert.match(fill.description, /drag-reorderable list takes all its row names in the wanted order/);
});

// The user's site blocks (permissions.mjs): sites(url) gives the line to relay, and onSite reports the origin turbo acts on.
function siteFixture(start = 'https://fine.example/') {
  const calls = [], seen = [], state = { snapshotNo: 0 };
  let url = start;
  const page = { url: () => url, title: async () => 'Fixture' }, entry = { page, state };
  const pages = { openTab: async args => { calls.push(['open', args.url]); url = args.url.endsWith('to=blocked') ? 'https://blocked.example/landed' : args.url; return { tab: 't1' }; },
    tab: () => entry, enqueue: async (id, fn) => fn(entry), closedOpener: () => undefined,
    close: async id => { calls.push(['close', id]); return { tab: id, closed: true }; }, endTurn: async () => ({ cleanedUp: true }) };
  const blocked = new Set(['https://blocked.example']);
  const sites = value => { const origin = (() => { try { return new URL(value).origin; } catch { return undefined; } })();
    return blocked.has(origin) ? `You blocked sleight on ${origin} (sleight-mcp permissions unblock ${origin} lifts it).` : undefined; };
  const dispatcher = createToolDispatcher({ browser: 'bfixture', pages, sites, onSite: origin => seen.push(origin),
    snapshot: async () => { calls.push(['snapshot', url]); return { text: `page at ${url}`, number: 1 }; },
    runSteps: async (t, steps) => { calls.push(['act', steps]); if (steps[0].ref === 'e9') url = 'https://blocked.example/next'; return { lines: ['1 click e1: done'], observe: { text: `+ diff at ${url}`, number: 2, capturedAt: Date.now() } }; },
    fillFields: async () => { calls.push(['fill']); url = 'https://blocked.example/after'; return { rows: [{ ref: 'e1', status: 'set' }] }; } });
  return { dispatcher, calls, seen, setUrl: value => { url = value; } };
}
const LINE = 'You blocked sleight on https://blocked.example (sleight-mcp permissions unblock https://blocked.example lifts it).';

test('a blocked site: open refuses before any tab, a redirect into one closes the tab unread, and a page that moves there stops reads', async () => {
  const f = siteFixture();
  assert.deepEqual(await f.dispatcher.call({ name: 'browser_open', arguments: { url: 'https://blocked.example/x' } }), { text: LINE, isError: true });
  assert.deepEqual(f.calls, []);
  const r = siteFixture();
  assert.deepEqual(await r.dispatcher.call({ name: 'browser_open', arguments: { url: 'https://fine.example/go?to=blocked' } }), { text: LINE, isError: true });
  assert.deepEqual(r.calls, [['open', 'https://fine.example/go?to=blocked'], ['close', 't1']]);
  const g = siteFixture();
  assert.equal((await g.dispatcher.call({ name: 'browser_open', arguments: { url: 'https://fine.example/start' } })).isError, false);
  assert.deepEqual([...new Set(g.seen)], ['https://fine.example']);
  g.setUrl('https://blocked.example/landing');
  assert.deepEqual(await g.dispatcher.call({ name: 'browser_read', arguments: { tab: 't1' } }), { text: LINE, isError: true });
  assert.equal(g.calls.filter(c => c[0] === 'snapshot').length, 1, 'only the allowed page was read');
});

test('a blocked site: no read or input on its page, and a step that lands on one returns its outcome without the page', async () => {
  const f = siteFixture('https://blocked.example/');
  for (const [name, args] of [['browser_read', { tab: 't1' }], ['browser_act', { tab: 't1', steps: [{ do: 'click', ref: 'e1' }] }],
    ['browser_fill', { tab: 't1', fields: [{ ref: 'e1', value: 'x' }] }]]) {
    assert.deepEqual(await f.dispatcher.call({ name, arguments: args }), { text: LINE, isError: true }, name);
  }
  assert.deepEqual(f.calls, []);
  const g = siteFixture();
  const act = await g.dispatcher.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e9' }], observe: 'full' } });
  assert.equal(act.isError, true);
  assert.equal(act.text, `1 click e1: done\n${LINE}`);
  assert.equal(g.dispatcher.delivered(act), false);
  const h = siteFixture();
  const fill = await h.dispatcher.call({ name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'e1', value: 'x' }] } });
  assert.equal(fill.text, `e1: set\n${LINE}`);
  assert.equal(h.calls.filter(c => c[0] === 'snapshot').length, 0);
});
