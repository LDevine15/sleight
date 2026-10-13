// Owned headless fixture pages only; opt in with SLEIGHT_LIVE_DOM_TEST=1.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { before, after } from 'node:test';
import { createInputController, inspectNode } from '../input.mjs';

const playwrightPath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
let skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'set SLEIGHT_LIVE_DOM_TEST=1 for owned headless input fixtures'
  : !existsSync(playwrightPath) && 'playwright-core is unavailable in the local FowlBrowser cache';
let chromium;
if (!skip) {
  ({ chromium } = await import(pathToFileURL(playwrightPath).href));
  if (!existsSync(chromium.executablePath())) skip = 'the installed playwright-core Chromium build is unavailable';
}
let browser;
let server;
let origin;
before(async () => {
  if (skip) return;
  browser = await chromium.launch({ headless: true });
  const html = readFileSync(new URL('../fixtures/input.html', import.meta.url));
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/next' ? '<button>Next fixture document</button>' : html);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  try { await browser?.close(); }
  finally { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
});

function fixtureTest(name, run) {
  test(name, { skip, timeout: 15000 }, async t => {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await run({ page, t });
  });
}

async function setup(page, selector, { observe, send, inspect } = {}) {
  await page.goto(origin);
  const raw = await page.context().newCDPSession(page);
  await raw.send('Page.enable');
  await raw.send('DOM.enable');
  const { frameTree } = await raw.send('Page.getFrameTree');
  const { executionContextId } = await raw.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'bp2-6-fixture' });
  const root = await raw.send('DOM.getDocument');
  const { nodeId } = await raw.send('DOM.querySelector', { nodeId: root.root.nodeId, selector });
  const { node } = await raw.send('DOM.describeNode', { nodeId });
  const session = { sessionId: 'owned-fixture', on: raw.on.bind(raw), off: raw.off.bind(raw),
    send: (method, params) => send ? send(raw, method, params) : raw.send(method, params) };
  const identity = { browserIncarnation: 'fixture', brokerEpoch: 1, clientSession: 'test', turn: 'test',
    targetId: 'owned-page', leaseGeneration: 1, frameId: frameTree.frame.id, documentEpoch: 1, origin };
  let epoch = 1;
  raw.on('Page.frameNavigated', e => { if (e.frame.id === identity.frameId) epoch++; });
  const resolved = { ...identity, session, backendNodeId: node.backendNodeId, executionContextId };
  const controller = createInputController({ resolve: async () => resolved,
    authorize: async () => ({ allowed: true }), fence: async () => ({ ...identity, documentEpoch: epoch }),
    inspect: inspect ?? inspectNode,
    observe: observe ?? (async () => ({ matched: await page.locator(selector).getAttribute('data-trusted') === 'true',
      complete: true, unchanged: false, documentEpoch: epoch, source: 'native' })) });
  const op = (id, extra = {}) => ({ ...identity, operationId: id, sequence: 1, ref: 'r1', op: 'click',
    expect: { kind: 'state', field: 'checked', equals: true }, timeout_ms: 1500, ...extra });
  return { controller, op, raw, resolved };
}

fixtureTest('trusted event listeners and clipped scroll control show actual effects', async ({ page, t }) => {
  const f = await setup(page, '#pay');
  assert.equal((await f.controller.act(f.op('pay'))).effect, 'verified');
  assert.equal(await page.locator('#pay').getAttribute('data-count'), '1');
  const clipped = await setup(page, '#below');
  assert.equal((await clipped.controller.act(clipped.op('below'))).effect, 'verified');
  await clipped.raw.detach();
  await f.raw.detach();
});

fixtureTest('overlay, disabled and moving targets have zero click effect', async ({ page, t }) => {
  const f = await setup(page, '#pay');
  await page.locator('#overlay').evaluate(el => { el.style.display = 'block'; });
  assert.equal((await f.controller.act(f.op('overlay'))).code, 'COVERED');
  assert.equal(await page.locator('#pay').getAttribute('data-count'), '0');
  const disabled = await setup(page, '#disabled');
  assert.equal((await disabled.controller.act(disabled.op('disabled'))).code, 'DISABLED');
  const moving = await setup(page, '#pay');
  await page.locator('#pay').evaluate(el => el.classList.add('moving'));
  assert.equal((await moving.controller.act(moving.op('moving'))).code, 'UNSTABLE');
  assert.equal(await page.locator('#pay').getAttribute('data-count'), '0');
  await Promise.all([f.raw.detach(), disabled.raw.detach(), moving.raw.detach()]);
});

fixtureTest('async page timer is proof, actual delay reported separately from input', async ({ page, t }) => {
  const f = await setup(page, '#delayed');
  const result = await f.controller.act(f.op('delayed'));
  assert.equal(result.effect, 'verified');
  assert.equal(await page.locator('#effect').textContent(), 'delayed');
  const actual = Number(await page.locator('#delayed').getAttribute('data-actual-delay'));
  assert.ok(actual >= 0);
  t.diagnostic(JSON.stringify({ fixture: 'nominal-30ms', actual_page_delay_ms: actual, timing: result.timing }));
  await f.raw.detach();
});

fixtureTest('navigation between inspection and dispatch is fenced', async ({ page, t }) => {
  let moved = false;
  const f = await setup(page, '#pay', { inspect: async (resolved, deadline) => {
    const state = await inspectNode(resolved, deadline);
    if (!moved) { moved = true; await page.goto(origin + '/next'); }
    return state;
  } });
  const result = await f.controller.act(f.op('stale'));
  assert.equal(result.effect, 'none');
  assert.equal(result.code, 'STALE_REF');
  await f.raw.detach();
});

fixtureTest('lost dispatched reply never repeats a payment, even with a fresh operation ID', async ({ page, t }) => {
  const f = await setup(page, '#pay', { send: async (raw, method, params) => {
    const reply = await raw.send(method, params);
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') return new Promise(() => {});
    return reply;
  } });
  const result = await f.controller.act(f.op('pay-once', { timeout_ms: 200 }));
  assert.equal(result.effect, 'unknown');
  assert.equal((await f.controller.act(f.op('pay-again'))).code, 'EFFECT_UNKNOWN');
  assert.equal(await page.locator('#pay').getAttribute('data-count'), '1');
  await f.raw.detach();
});

fixtureTest('iframe-local hit testing rejects a parent overlay without qualified root mapping', async ({ page, t }) => {
  const f = await setup(page, '#frame');
  const tree = await f.raw.send('Page.getFrameTree');
  const child = tree.frameTree.childFrames[0].frame;
  const world = await f.raw.send('Page.createIsolatedWorld', { frameId: child.id, worldName: 'bp2-6-frame' });
  const result = await f.raw.send('Runtime.evaluate', { contextId: world.executionContextId,
    expression: 'document.querySelector("#child")' });
  const node = await f.raw.send('DOM.describeNode', { objectId: result.result.objectId });
  const state = await inspectNode({ ...f.resolved, backendNodeId: node.node.backendNodeId,
    executionContextId: world.executionContextId }, { run: fn => fn() });
  assert.equal(state.hit, true);
  await page.locator('#overlay').evaluate(el => { el.style.display = 'block'; });
  // Main-frame elementFromPoint cannot see through the overlay. Never route an iframe-local point as root coordinates.
  assert.equal((await f.controller.act(f.op('frame-overlay'))).code, 'COVERED');
  await f.raw.detach();
});
