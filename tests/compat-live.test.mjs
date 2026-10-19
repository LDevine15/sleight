import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CALCULATOR, SAFARI, fixturePage, keypadPlan, liveGate, openSafariPage, parseIdle, quitApp, quitLaunchedSince, runBrowserRead, runCalculator } from '../bench/compat/live.mjs';

const tree = readFileSync(new URL('./fixtures/calculator-tree.txt', import.meta.url), 'utf8');
const text = value => ({ content: [{ type: 'text', text: value }] });
const display = value => tree.replace(/Edit field, Value: [^\n]*/, `Edit field, Value: ${value}`);

test('the keypad plan clicks AC, 1, 7, ×, 2, 3, = from a recorded tree', () => {
  const plan = keypadPlan(tree);
  assert.deepEqual(plan.numbers, [66, 95, 75, 78, 96, 97, 108]);
  assert.equal(plan.code, 'await app.click(66); await app.click(95); await app.click(75); await app.click(78); await app.click(96); await app.click(97); await app.click(108)');
  // A doubled line with the same text is the same button; a different line under the same name stops the plan.
  assert.deepEqual(keypadPlan(tree + '\t\t\t200 button Description: 7, ID: Seven\n').numbers, plan.numbers);
  assert.match(keypadPlan(tree.replace('108 button Equals', '108 button Equals\n\t\t\t201 button Equals, Help: other')).error, /Equals/);
  assert.match(keypadPlan('Window: "x", App: y.\n0 standard window x').error, /One, Seven, Multiply, Two, Three, Equals/);
});

test('the live gate needs owner-away, no hold and, when asked, an idle Mac', () => {
  assert.match(liveGate({ ownerAway: false }).pending, /--owner-away/);
  assert.match(liveGate({ ownerAway: true, holdPath: '/hold', exists: path => path === '/hold' }).pending, /\/hold exists/);
  assert.match(liveGate({ ownerAway: true, exists: () => false, minIdleSeconds: 300, idleSeconds: 12 }).pending, /idle 12 s, needs 300 s/);
  assert.match(liveGate({ ownerAway: true, exists: () => false, minIdleSeconds: 300 }).pending, /idle unknown/);
  assert.deepEqual(liveGate({ ownerAway: true, exists: () => false, minIdleSeconds: 300, idleSeconds: 301 }), { ok: true });
  assert.equal(parseIdle('    |   "HIDIdleTime" = 4500000000\n'), 4.5);
  assert.equal(parseIdle('nothing'), undefined);
});

function calculatorClient({ result = '391', acquire = text('Window: "Calculator", App: Calculator.\n0 standard window Calculator'), shot = true } = {}) {
  const calls = [];
  let clicked = false;
  return { calls, call: async (name, args) => {
    calls.push(args.code);
    if (args.code.includes('cua.getApp')) return acquire;
    // As the engine does: getAXState prints its own tree unless emit is false, and nodeRepl.write adds a second copy.
    if (args.code.includes('getAXState')) {
      const state = clicked ? display(result) : display('0');
      return text((args.code.includes('emit: false') ? '' : state + '\n') + (args.code.includes('nodeRepl.write') ? state : ''));
    }
    if (args.code.includes('app.click')) { clicked = true; return text('done'); }
    if (args.code.includes('getScreenshot')) return shot ? { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBOR' }] } : text('no image');
    throw new Error('unexpected ' + args.code);
  } };
}
const apps = (running = false) => {
  const log = [];
  return { log, appState: async bundle => ({ running, pids: running ? [7] : [] }), launchApp: async bundle => { log.push(['launch', bundle]); return { pid: 41 }; },
    quitApp: async (bundle, launched) => { log.push(['quit', bundle, launched?.pid]); } };
};

test('the Calculator check passes on 391 and a screenshot, and quits the Calculator it launched', async () => {
  const host = apps();
  const client = calculatorClient();
  const outcome = await runCalculator(client, host);
  assert.equal(outcome.status, 'pass', outcome.reason);
  assert.deepEqual(host.log, [['launch', CALCULATOR], ['quit', CALCULATOR, 41]]);
  assert.equal(client.calls[0], 'var app = await cua.getApp("com.apple.calculator")');
});

test('the Calculator check fails with the reason, and never touches a Calculator that was running', async () => {
  const wrong = await runCalculator(calculatorClient({ result: '17' }), apps());
  assert.deepEqual([wrong.reason, wrong.detail], ["the display didn't read 391", '17']);
  assert.match((await runCalculator(calculatorClient({ shot: false }), apps())).reason, /no image/);
  // Engine text stays in the private detail field, never the reason that gets published.
  const refused = await runCalculator(calculatorClient({ acquire: { isError: true, ...text('Invalid app') } }), apps());
  assert.deepEqual([refused.reason, refused.detail], ['getApp returned an error', 'Invalid app']);
  assert.match((await runCalculator(calculatorClient({ acquire: text('something else') }), apps())).reason, /header/);
  const running = apps(true);
  const skipped = await runCalculator(calculatorClient(), running);
  assert.equal(skipped.status, 'skip');
  assert.deepEqual(running.log, []);
  const stuck = { ...apps(), quitApp: async () => { throw new Error('quit unconfirmed'); } };
  const kept = await runCalculator(calculatorClient(), stuck);
  assert.equal(kept.status, 'fail');
  assert.equal(kept.cleanup, 'quit unconfirmed');
});

test('quitApp quits only the process this run launched', async () => {
  const quits = [];
  const run = async (cmd, args) => quits.push(args.at(-1));
  let running = true;
  const state = async () => ({ running, pids: running ? [41] : [] });
  await quitApp(CALCULATOR, { pid: 41 }, { state, run: async (...a) => { await run(...a); running = false; }, sleep: async () => {} });
  assert.equal(quits.length, 1);
  await assert.rejects(quitApp(CALCULATOR, { pid: 9 }, { state: async () => ({ running: true, pids: [41] }), run, sleep: async () => {} }), /left running/);
  await quitApp(CALCULATOR, undefined, { state: async () => ({ running: false, pids: [] }), run, sleep: async () => {} });
  assert.equal(quits.length, 1);
});

function browserClient(page, { header = `Window: "${page.marker}", App: Safari.`, body = page.body } = {}) {
  const calls = [];
  return { calls, call: async (name, args) => {
    calls.push([name, args.code ?? args]);
    if (name === 'select_window') return text('{"ok":true}');
    if (args.code.includes('cua.getApp')) return text(`${header}\n0 standard window x\n\t1 HTML content ${body}`);
    throw new Error('unexpected');
  } };
}

test('the browser read selects the fixture window by its title and finds the page text', async () => {
  const page = { ...fixturePage('abc'), window: { title: 'sleight benchmark — sleight compat abc', profile: 'sleight benchmark' }, close: async () => { page.closed = true; } };
  const client = browserClient(page);
  const outcome = await runBrowserRead(client, { appState: async () => ({ running: false }), openPage: async () => page, axTrusted: async () => true });
  assert.equal(outcome.status, 'pass', outcome.reason);
  assert.deepEqual(client.calls[0], ['select_window', { app: 'Safari', title: page.window.title }]);
  assert.equal(client.calls[1][1], `var page = await cua.getApp("${SAFARI}")`);
  assert.equal(page.closed, true);
});

test('compat selects the retained benchmark window even when native listApps has no windows', async () => {
  const p = { ...fixturePage('8f0eab068986'),
    window: { title: 'sleight benchmark — sleight compat 8f0eab068986', profile: 'sleight benchmark' }, close: async () => {} };
  const calls = [];
  const client = { call: async (name, args) => {
    calls.push([name, args]);
    if (name === 'select_window') return text('{"ok":true}');
    if (args.code.includes('listApps')) return text('sleight-compat:[]');
    return text(`Window: "${p.window.title}", App: Safari.\n0 standard window\n1 text ${p.body}`);
  } };
  const outcome = await runBrowserRead(client, { appState: async () => ({ running: false }), openPage: async () => p, sleep: async () => {}, titleWaitMs: 300 });
  assert.equal(outcome.status, 'pass', JSON.stringify(outcome));
  assert.deepEqual(calls[0], ['select_window', { app: 'Safari', title: p.window.title }]);
  assert.ok(calls.every(([, args]) => !args.code?.includes('listApps')));
});

test('compat waits for the expected profile title when the receipt and first selection are still loading', async () => {
  const p = { ...fixturePage('loading'), window: { title: 'http://127.0.0.1/loading/', profile: 'sleight benchmark' }, close: async () => {} };
  let selects = 0, reads = 0;
  const outcome = await runBrowserRead({ call: async (name, args) => {
    if (name === 'select_window') {
      assert.equal(args.title, 'sleight benchmark \u2014 sleight compat loading');
      return ++selects === 1 ? { isError: true, ...text('not ready') } : text('ok');
    }
    return text(`Window: "${++reads === 1 ? 'Start Page' : 'sleight benchmark \u2014 sleight compat loading'}", App: Safari.\n0 window\n1 text ${p.body}`);
  } }, { appState: async () => ({ running: false }), openPage: async () => p, sleep: async () => {} });
  assert.equal(outcome.status, 'pass', outcome.reason);
  assert.equal(selects, 3);
  assert.equal(reads, 2);
});

test('compat reports Escape and passes the fixture pid to its quit fallback', async () => {
  const p = { ...fixturePage('abc'), window: { profile: 'sleight benchmark', title: 'loading', pid: 41 },
    diagnostics: { pid: 41, menuCancelMethod: 'Escape', menuEscapePid: 41 }, close: async () => {} };
  let expectedPid;
  const outcome = await runBrowserRead(browserClient(p), { appState: async () => ({ running: false }), openPage: async () => p,
    quitLaunchedSince: async (_bundle, _since, options) => { expectedPid = options?.pid; return false; } });
  assert.equal(outcome.escapePosted, true);
  assert.equal(expectedPid, 41);
});

test('compat refuses the recorded Personal-profile marker and a mismatched engine header', async () => {
  for (const personalReceipt of [true, false]) {
    const p = { ...fixturePage('8f0eab068986'), window: {
      title: `${personalReceipt ? 'Personal' : 'sleight benchmark'} — sleight compat 8f0eab068986`,
      profile: personalReceipt ? 'Personal' : 'sleight benchmark' }, close: async () => {} };
    const client = browserClient(p, { header: 'Window: "Personal — sleight compat 8f0eab068986", App: Safari.' });
    const outcome = await runBrowserRead(client, { appState: async () => ({ running: false }), openPage: async () => p, sleep: async () => {}, titleWaitMs: 300 });
    assert.equal(outcome.status, 'fail');
    assert.match(outcome.reason, personalReceipt ? /no verified benchmark/ : /another window or profile/);
    if (personalReceipt) assert.equal(client.calls.length, 0, 'no engine action on Personal');
  }
});

test('the browser read fails or skips with its reason and always closes the page', async () => {
  const page = () => { const p = { ...fixturePage('abc'), window: { title: 'sleight benchmark — sleight compat abc', profile: 'sleight benchmark' }, close: async () => { p.closed = true; } }; return p; };
  const host = p => ({ appState: async () => ({ running: false }), openPage: async () => p, axTrusted: async () => true, sleep: async () => {}, titleWaitMs: 300 });
  let p = page();
  delete p.window;
  assert.match((await runBrowserRead(browserClient(p), host(p))).reason, /no verified benchmark/);
  assert.equal(p.closed, true);
  p = page();
  assert.match((await runBrowserRead(browserClient(p, { header: 'Window: "Start Page", App: Safari.' }), host(p))).reason, /another window/);
  p = page();
  assert.match((await runBrowserRead(browserClient(p, { body: 'nothing' }), host(p))).reason, /not the page's text/);
  p = page();
  const opened = [];
  assert.equal((await runBrowserRead(browserClient(p), { appState: async () => ({ running: true }), openPage: async () => opened.push(1) })).status, 'skip');
  assert.equal((await runBrowserRead(browserClient(p), { appState: async () => ({ running: false }), openPage: async () => opened.push(1), axTrusted: async () => false })).status, 'skip');
  assert.deepEqual(opened, []);
  p = { ...page(), close: async () => { throw new Error('window left open'); } };
  const kept = await runBrowserRead(browserClient(p), host(p));
  assert.equal(kept.status, 'fail');
  assert.equal(kept.cleanup, 'window left open');
});

test('openSafariPage serves the page on 127.0.0.1 and hands the fixture an owner-away context', async () => {
  const seen = [];
  const window = { title: 'sleight benchmark — sleight compat n1', profile: 'sleight benchmark' };
  const page = await openSafariPage({ nonce: 'n1', dir: '/tmp/x', open: async (ctx, request) => {
    seen.push({ ctx, request }); return { diagnostics: { fixtureWindow: window } };
  }, close: async ctx => seen.push({ closed: ctx.nonce }) });
  assert.deepEqual(page.window, window);
  assert.match(page.url, /^http:\/\/127\.0\.0\.1:\d+\/n1\/$/);
  const html = await (await fetch(page.url)).text();
  assert.ok(html.includes(`<title>${page.marker}</title>`) && html.includes(page.body));
  assert.equal((await fetch(page.url.replace('/n1/', '/other/'))).status, 404);
  assert.equal(seen[0].ctx.ownerAway, true);
  assert.equal(seen[0].request.bundle, SAFARI);
  assert.equal(seen[0].request.fixtureKind, 'web-page');
  await page.close();
  assert.deepEqual(seen[1], { closed: 'n1' });
  await assert.rejects(fetch(page.url));
  const failed = [];
  await assert.rejects(openSafariPage({ nonce: 'n2', dir: '/tmp/x', open: async () => { throw new Error('setup failed'); }, close: async () => failed.push('closed') }), /setup failed/);
  assert.deepEqual(failed, ['closed']);
});

test('the Calculator check reads one tree after the clicks, as getAXState prints its own unless emit is false', async () => {
  const client = calculatorClient();
  const outcome = await runCalculator(client, apps());
  assert.equal(outcome.status, 'pass', `${outcome.reason}: ${outcome.detail}`);
  for (const code of client.calls.filter(code => code.includes('getAXState'))) assert.match(code, /emit: false/);
});

test('quitLaunchedSince quits only the one Safari process macOS dates after the check began', async () => {
  const since = 1_792_000_000_000;
  const scripts = [];
  const run = async (cmd, args) => { scripts.push(JSON.parse(args.at(-1))); running = false; };
  let running = true;
  const state = (pids, launchDates) => async () => (running ? { running: true, pids, launchDates } : { running: false, pids: [], launchDates: [] });
  const sleep = async () => {};
  assert.equal(await quitLaunchedSince(SAFARI, since, { pid: 53150, state: state([53150], [since + 1800]), run, sleep }), true);
  assert.deepEqual(scripts, [{ op: 'quit', appId: SAFARI, pid: 53150, launchedAtMs: since }]);
  running = true;
  for (const [pids, dates] of [[[53150], [since - 1]], [[53150], [null]], [[53150, 53151], [since + 1, since + 2]]]) {
    await assert.rejects(quitLaunchedSince(SAFARI, since, { state: state(pids, dates), run, sleep }), /left running/);
  }
  assert.equal(scripts.length, 1);
  running = false;
  assert.equal(await quitLaunchedSince(SAFARI, since, { state: state([], []), run, sleep }), false);
  assert.equal(scripts.length, 1);
});

test('a browser check whose fixture setup failed still quits the Safari it launched', async () => {
  // The first live run (2026-10-19): the fixture's setup failed, its close refused to quit Safari, and Safari stayed open.
  const quits = [];
  const host = (quit = async (bundle, since) => { quits.push([bundle, since]); return true; }) => ({
    appState: async () => ({ running: false }), axTrusted: async () => true, quitLaunchedSince: quit,
    openPage: async () => { throw new Error('Fixture setup failed: Browser creation ownership unconfirmed'); } });
  const began = Date.now();
  const stopped = await runBrowserRead(browserClient(fixturePage('abc')), host());
  assert.deepEqual([stopped.status, stopped.detail, stopped.quitSafari, stopped.cleanup], ['error', 'Fixture setup failed: Browser creation ownership unconfirmed', true, undefined]);
  assert.equal(quits.length, 1);
  assert.equal(quits[0][0], SAFARI);
  assert.ok(quits[0][1] >= began);
  // A Safari it can't prove is its own stays running and keeps the live lock through the cleanup field.
  const kept = await runBrowserRead(browserClient(fixturePage('abc')), host(async () => { throw new Error('com.apple.Safari is not one process launched by this check (pids 7); left running'); }));
  assert.match(kept.cleanup, /left running/);
  // A window close the fixture refused, followed by a quit of the whole Safari it launched, leaves nothing behind.
  const p = { ...fixturePage('abc'), window: { title: 'sleight benchmark — sleight compat abc', profile: 'sleight benchmark' }, close: async () => { throw new Error('Owned Safari fixture window cleanup unconfirmed'); } };
  const closed = await runBrowserRead(browserClient(p), { ...host(), openPage: async () => p, sleep: async () => {}, titleWaitMs: 300 });
  assert.deepEqual([closed.status, closed.cleanup, closed.fixtureCleanup, closed.quitSafari], ['pass', undefined, 'Owned Safari fixture window cleanup unconfirmed', true]);
  // A normal run whose fixture already quit Safari has nothing to quit.
  const normal = await runBrowserRead(browserClient(fixturePage('abc')), { ...host(async () => false), openPage: async () => ({
    ...fixturePage('abc'), window: { title: 'sleight compat abc', profile: 'sleight benchmark' }, close: async () => {} }) });
  assert.deepEqual([normal.status, normal.quitSafari, normal.cleanup], ['pass', undefined, undefined]);
});

test('compat refuses a conflicting receipt title before reading any window', async () => {
  const p = { ...fixturePage('abc'), window: { profile: 'sleight benchmark', title: 'Personal \u2014 sleight compat abc' }, close: async () => {} };
  const client = browserClient(p);
  const outcome = await runBrowserRead(client, { appState: async () => ({ running: false }), openPage: async () => p });
  assert.equal(outcome.status, 'fail');
  assert.equal(client.calls.length, 0);
});

test('the Safari quit fallback refuses an unproved pid or an unproven window', async () => {
  const options = { state: async () => ({ running: true, pids: [41], launchDates: [2000] }), run: async () => assert.fail('must not quit') };
  for (const extra of [{}, { pid: 42 }, { pid: 41, unprovenWindow: true }]) {
    await assert.rejects(quitLaunchedSince(SAFARI, 1000, { ...options, ...extra }), /left running/);
  }
});
