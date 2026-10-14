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
    list: async () => [{ tab: 't1', url: page.url() }],
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
