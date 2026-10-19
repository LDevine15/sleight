import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CALCULATOR, SAFARI, fixturePage, keypadPlan, liveGate, openSafariPage, parseIdle, quitApp, runBrowserRead, runCalculator } from '../bench/compat/live.mjs';

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
    if (args.code.includes('getAXState')) return text(clicked ? display(result) : display('0'));
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

function browserClient(page, { titles, header = `Window: "${page.marker}", App: Safari.`, body = page.body } = {}) {
  const calls = [];
  return { calls, call: async (name, args) => {
    calls.push([name, args.code ?? args]);
    if (name === 'select_window') return text('{"ok":true}');
    if (args.code.includes('listApps')) return text('sleight-compat:' + JSON.stringify(titles ?? [`Work — ${page.marker}`]));
    if (args.code.includes('cua.getApp')) return text(`${header}\n0 standard window x\n\t1 HTML content ${body}`);
    throw new Error('unexpected');
  } };
}

test('the browser read selects the fixture window by its title and finds the page text', async () => {
  const page = { ...fixturePage('abc'), close: async () => { page.closed = true; } };
  const client = browserClient(page);
  const outcome = await runBrowserRead(client, { appState: async () => ({ running: false }), openPage: async () => page, axTrusted: async () => true });
  assert.equal(outcome.status, 'pass', outcome.reason);
  assert.deepEqual(client.calls[1], ['select_window', { app: 'Safari', title: 'Work — sleight compat abc' }]);
  assert.equal(client.calls[2][1], `var page = await cua.getApp("${SAFARI}")`);
  assert.equal(page.closed, true);
});

test('the browser read fails or skips with its reason and always closes the page', async () => {
  const page = () => { const p = { ...fixturePage('abc'), close: async () => { p.closed = true; } }; return p; };
  const host = p => ({ appState: async () => ({ running: false }), openPage: async () => p, axTrusted: async () => true });
  let p = page();
  assert.match((await runBrowserRead(browserClient(p, { titles: [] }), host(p))).reason, /found 0/);
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
  const page = await openSafariPage({ nonce: 'n1', dir: '/tmp/x', open: async (ctx, request) => seen.push({ ctx, request }), close: async ctx => seen.push({ closed: ctx.nonce }) });
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
