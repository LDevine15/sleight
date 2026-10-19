import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { utilityLocator } from './direct-browser-utility-fixture.mjs';

function fixture() {
  const page = new EventEmitter(), events = [], snapshots = [];
  let time = 0, number = 1, closed = false;
  const schedule = (at, fn) => events.push({ at, fn });
  const sleep = async ms => {
    const until = time + ms;
    events.sort((a, b) => a.at - b.at);
    while (events[0]?.at <= until) { const event = events.shift(); time = event.at; event.fn(); }
    time = until;
  };
  page.url = () => { if (closed) throw Error('page closed'); return 'https://fixture.invalid/'; };
  page.isClosed = () => closed;
  page.mainFrame = () => page;
  page.evaluate = async () => sleep(16);
  page.waitForLoadState = async state => { assert.equal(state, 'domcontentloaded'); await sleep(200); };
  page.context = () => ({ newCDPSession: async () => ({ send: async () => ({ result: { value: [1000, 800] } }), detach: async () => {} }) });
  page.setViewportSize = async () => {};
  page.goBack = page.goForward = async () => {};
  page.mouse = { wheel: async () => {} };
  page.getByRef = () => utilityLocator({ evaluate: async fn => fn.name === 'inspectTarget' ? {} : null,
    click: async () => { closed = true; page.emit('close'); throw Error('Target page has been closed'); } });
  const tab = { page, state: { snapshotNo: 1 } };
  const snapshot = async p => { snapshots.push([p, time]); return { text: 'snapshot', number: ++number }; };
  const run = createActionRunner({ check: () => 'allow', snapshot, now: () => time, sleep });
  return { page, tab, run, snapshot, snapshots, schedule, time: () => time };
}

for (const step of [{ do: 'viewport', width: 390, height: 844 }, { do: 'scroll', dy: 500 }, { do: 'back' }, { do: 'forward' }]) {
  test(`${step.do} without activity finishes at a frame and skips an unrequested snapshot`, async () => {
    const f = fixture();
    const result = await f.run(f.tab, [step], {}, { observe: 'none' });
    assert.equal(result.stoppedAt, null, result.lines.join('\n'));
    assert.ok(f.time() < 150, `settle took ${f.time()} ms`);
    assert.equal(result.observe, undefined);
    assert.equal(f.snapshots.length, 0);
  });
  test(`${step.do} waits for requests it starts, including one started on the next frame`, async () => {
    const f = fixture(), request = { resourceType: () => 'fetch' };
    f.schedule(10, () => f.page.emit('request', request));
    f.schedule(800, () => f.page.emit('requestfinished', request));
    const result = await f.run(f.tab, [step], {});
    assert.equal(result.stoppedAt, null, result.lines.join('\n'));
    assert.ok(f.snapshots[0][1] >= 800, `snapshot at ${f.snapshots[0][1]} ms`);
    assert.equal(f.page.listenerCount('request'), 0);
  });
}

test('wait ms ends after 150 ms of quiet instead of sleeping its whole duration', async () => {
  const f = fixture();
  await f.run(f.tab, [{ do: 'wait', ms: 3000 }], {}, { observe: 'none' });
  assert.equal(f.time(), 150);
  assert.equal(f.snapshots.length, 0);
});

test('wait ms cannot return before a pending request even past the requested duration', async () => {
  const f = fixture(), request = { resourceType: () => 'image' };
  f.schedule(50, () => f.page.emit('request', request));
  f.schedule(900, () => f.page.emit('requestfinished', request));
  const result = await f.run(f.tab, [{ do: 'wait', ms: 200 }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.ok(f.snapshots[0][1] >= 900);
});

test('wait carries a request from the preceding click instead of declaring the page quiet', async () => {
  const f = fixture(), request = { resourceType: () => 'fetch' };
  f.page.getByRef = () => utilityLocator({ evaluate: async () => ({}), click: async () => f.page.emit('request', request) });
  f.schedule(1200, () => f.page.emit('requestfinished', request));
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'wait', ms: 3000 }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.ok(f.snapshots[0][1] >= 1200);
});

test('a short step with a request that never ends reports uncertainty and stops the batch', async () => {
  const f = fixture();
  f.schedule(10, () => f.page.emit('request', { resourceType: () => 'fetch' }));
  const result = await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }, { do: 'forward' }], {});
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[0], /effect unconfirmed.*activity still pending/);
  assert.match(result.lines[1], /not reached/);
  assert.equal(f.page.listenerCount('request'), 0);
});

test('history navigation waits for its document and stops before the next step', async () => {
  const f = fixture();
  f.page.goBack = async () => f.page.emit('framenavigated', f.page);
  const result = await f.run(f.tab, [{ do: 'back' }, { do: 'forward' }], {}, { observe: 'none' });
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[1], /not reached/);
  assert.ok(f.snapshots[0][1] >= 200);
  assert.ok(result.observe, 'a boundary still delivers its read');
});

test('a wait resets its quiet clock when a same-document boundary arrives', async () => {
  const f = fixture();
  f.schedule(100, () => f.page.emit('framenavigated', f.page));
  const result = await f.run(f.tab, [{ do: 'wait', ms: 3000 }], {});
  assert.equal(result.stoppedAt, 1);
  assert.ok(f.snapshots[0][1] >= 300);
});

for (const observe of ['diff', 'none']) test(`a self-closing click returns and delivers only the opener snapshot (${observe})`, async () => {
  const f = fixture(), opener = { page: { url: () => 'https://fixture.invalid/app' }, state: { snapshotNo: 0 } };
  let admitted = false;
  const pages = { closedOpener: id => id === 't2' && f.page.isClosed() ? 't1' : undefined,
    enqueue: async (id, fn) => fn(id === 't2' ? f.tab : opener) };
  const d = createToolDispatcher({ browser: 'bfixture', pages, runSteps: f.run, snapshot: f.snapshot,
    fillFields: async () => assert.fail('no fill'),
    deliverSnapshot: (state, capture) => { assert.equal(state, opener.state); assert.equal(capture.page, opener.page); admitted = true; return true; } });
  const out = await d.call({ name: 'browser_act', arguments: { tab: 't2', steps: [{ do: 'click', ref: 'e1' }, { do: 'forward' }], observe } });
  assert.equal(out.isError, false);
  assert.match(out.text, /tab closed itself.*opener t1 below/);
  assert.match(out.text, /2 forward: not reached/);
  assert.doesNotMatch(out.text, /unconfirmed|Read unavailable/);
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.snapshots[0][0], opener.page);
  assert.equal(admitted, false);
  assert.equal(d.delivered(out), true);
  assert.equal(admitted, true);
});

test('browser_open traces its capture and total without changing its result when a tracer throws', async () => {
  const f = fixture(), phases = [];
  f.page.title = async () => 'Fixture';
  const make = tracePhase => createToolDispatcher({ browser: 'bfixture', tracePhase,
    pages: { openTab: async ({ tracePhase }) => { tracePhase?.('browser-open-create-start'); return { tab: 't1' }; }, tab: () => f.tab },
    snapshot: f.snapshot, runSteps: f.run, fillFields: async () => {} });
  const input = { name: 'browser_open', arguments: { url: 'https://fixture.invalid/' } };
  const result = await make((phase, call) => phases.push([phase, call])).call(input);
  assert.equal(result.isError, false);
  assert.deepEqual(phases, [['browser-open-start', 1], ['browser-open-create-start', 1], ['browser-open-capture-start', 1],
    ['browser-open-capture-end', 1], ['browser-open-end', 1]]);
  assert.deepEqual(await make(() => { throw Error('trace unavailable'); }).call(input), result);
});

test('the A/B control retains the old viewport settle and discarded read', async t => {
  const old = process.env.SLEIGHT_LB12;
  process.env.SLEIGHT_LB12 = '0';
  t.after(() => { if (old === undefined) delete process.env.SLEIGHT_LB12; else process.env.SLEIGHT_LB12 = old; });
  const f = fixture();
  await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }], {}, { observe: 'none' });
  assert.equal(f.time(), 600);
  assert.equal(f.snapshots.length, 1);
});

test('self-close recovery still refuses a blocked opener before reading it', async () => {
  const f = fixture(), opener = { page: { url: () => 'https://blocked.invalid/' }, state: {} };
  const d = createToolDispatcher({ browser: 'bfixture',
    pages: { closedOpener: () => 't1', enqueue: async (id, fn) => fn(id === 't2' ? f.tab : opener) },
    sites: url => url === 'https://blocked.invalid/' ? 'Blocked by the user.' : undefined,
    snapshot: async () => assert.fail('blocked opener must not be read'), runSteps: f.run, fillFields: async () => {} });
  const result = await d.call({ name: 'browser_act', arguments: { tab: 't2', steps: [{ do: 'click', ref: 'e1' }] } });
  assert.deepEqual(result, { text: 'Blocked by the user.', isError: true });
});
