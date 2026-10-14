import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { connectRootCdp, executable } from './fixtures/direct-browser-root-cdp.mjs';
import { createRootTargets } from '../plugins/sleight/lib/direct-browser/root-targets.mjs';
import { createTransportOwner } from '../plugins/sleight/lib/direct-browser/transport-owner.mjs';
import { createSemanticAdapter, formInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';
import { fixedReadInspectors } from '../plugins/sleight/lib/direct-browser/reads.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { createFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';
import { validateHostRequest } from '../plugins/sleight/lib/direct-browser/request-schema.mjs';
import { loadPlaywrightCore } from '../plugins/sleight/lib/direct-browser/worlds.mjs';

const sourcePath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/demo/server.mjs');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'opt-in popup qualification belongs to sleight-arch'
  : !['darwin', 'linux'].includes(process.platform) || !existsSync(executable) ? 'the pinned Chromium executable is missing'
    : !existsSync(sourcePath) ? 'the read-only MIT demo source is missing'
      : typeof globalThis.WebSocket !== 'function' ? 'Node built-in WebSocket is missing' : false;

async function fixture(t, route, destinationHandler) {
  const source = readFileSync(sourcePath, 'utf8');
  const demo = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport {shopPage};').toString('base64'));
  const profile = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-tf2r-headless-')));
  let context, wire, roots, owner, frontend, broker, origin;
  const sockets = new Set(), events = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 65536) throw Error('fixture body limit'); }
    if (request.method === 'POST') {
      try { events.push(JSON.parse(body)); } catch { events.push({ post: request.url }); }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return;
    }
    const path = new URL(request.url, 'http://fixture.invalid').pathname;
    let html = demo.shopPage(path.replace(/^\/shop\/?/, ''), { base: '', cart: [], signedIn: null }, origin);
    if (path === '/shop/size-guide' && destinationHandler) {
      html = html.replace('<header>', `<body ${destinationHandler}><header>`);
      assert.ok(html.includes(`<body ${destinationHandler}>`), 'destination handler fixture was inserted');
    }
    response.writeHead(html ? 200 : 404, { 'content-type': 'text/html' }).end(html ?? 'missing');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    let closed = false;
    try { await frontend?.end(); await broker?.shutdown(); await roots?.close(); await owner?.close(); await wire?.close(); }
    finally {
      try { await context?.close(); closed = true; }
      finally {
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        if (closed) rmSync(profile, { recursive: true, force: true });
      }
    }
    assert.equal(existsSync(profile), false);
    t.diagnostic('cleanup: browser closed; owned profile deleted; fixture server and CDP sockets closed');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  context = await loadPlaywrightCore({ turbo: true }).inprocess.playwright.chromium.launchPersistentContext(profile, {
    headless: true, executablePath: executable, viewport: { width: 1200, height: 900 },
    args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
  const active = join(profile, 'DevToolsActivePort'), until = Date.now() + 10000;
  while (!existsSync(active) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  const [port, browserPath] = readFileSync(active, 'utf8').trim().split('\n');
  const urls = ['/shop/', '/shop/product/harbor', '/shop/account', '/shop/shipping', '/shop/size-guide'].map(p => origin + p);
  wire = await connectRootCdp('ws://127.0.0.1:' + port + browserPath, { fixtureUrls: urls });
  const raw = { sessionId: wire.sessionId, on: wire.on, off: wire.off, async send(method, params, route) {
    const fence = roots?.captureObservation(route), result = await wire.send(method, params, route);
    roots?.observeNodes(route, method, result, fence); return result;
  } };
  const binding = { session: 'tf2r', turn: 'turn', browserIncarnation: 'fixture', brokerEpoch: 1 };
  roots = createRootTargets({ session: raw, current: () => binding, timeoutMs: 10000 });
  owner = createTransportOwner({ session: raw, checkLease: roots.checkLease, nodeBinding: roots.nodeBinding,
    helpers: { ...formInspectors(), ...fixedReadInspectors } });
  const adapter = createSemanticAdapter({ owner, rootTargets: roots, leaseFor: roots.leaseFor, current: roots.current });
  const authority = createAuthority({ authenticate: () => false, current: adapter.currentScope, classify: adapter.classify,
    checkTarget: adapter.checkTarget, snapshot: () => ({ scope: adapter.currentScope(), time: Date.now() }), ttl: 30000 });
  adapter.bindAuthority(authority);
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: adapter.resolveOperation });
  const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
  broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'fixture', connect: async () => raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest, prepare: adapter.prepare,
    authorize: adapter.authorize, dispatchFence: adapter.dispatchFence, dispatch: adapter.dispatch, transportAuthority,
    endSession: () => { roots.revokeSession('tf2r'); owner.revokeSession('tf2r'); return true; }, disconnect: () => true,
    redact: value => value, timeoutMs: 30000 });
  await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'tf2r', incarnation: 'fixture' });
  frontend = await createFrontend({ proof: binding, verifyOptIn: proof => proof === binding, packageCurrent: () => true,
    status: () => 'connected', client, selectedBrowser: 'bfixture', redact: v => v,
    endSession: () => adapter.cleanupSession('tf2r'), onDelivered: value => adapter.delivered(roots.leaseFor(value.tab, binding), value.observation.observation) });
  const opened = await frontend.call({ name: 'browser_open', arguments: { browser: 'bfixture', url: origin + route } });
  assert.equal(opened.effect, 'verified', JSON.stringify(opened));
  async function read(tab) {
    const rows = []; let scope;
    for (let i = 0; i < 32; i++) {
      const result = await frontend.call({ name: 'browser_read', arguments: { tab, max_bytes: 64000, ...(scope ? { scope } : {}) } });
      assert.equal(result.effect, 'verified', JSON.stringify(result)); assert.equal(frontend.delivered(result), true);
      rows.push(...result.observation.data); scope = result.observation.cursor; if (!scope) return rows;
    }
    assert.fail('read pagination exceeded the fixture limit');
  }
  async function click(name) {
    const rows = await read(opened.tab), matches = rows.filter(r => r.name === name && ['link', 'button'].includes(r.role));
    assert.equal(matches.length, 1, 'one delivered control: ' + name);
    return frontend.call({ name: 'browser_act', arguments: { tab: opened.tab, op: 'click', ref: matches[0].ref, timeout_ms: 30000 } });
  }
  return { read, click, wire, context, events, opened };
}

test('real Shipping rates returns an owned background tab whose read contains the express price', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, '/shop/'), result = await f.click('Shipping rates');
  assert.equal(result.effect, 'verified', JSON.stringify(result)); assert.match(result.tab, /^t/);
  assert.equal(result.observation.title, 'Shipping rates · Tidewell Demo Shop');
  assert.match(JSON.stringify(await f.read(result.tab)), /12\.40/);
  assert.equal(f.wire.calls.filter(c => c.method === 'Target.createTarget').length, 2);
  assert.equal(f.context.pages().length, 3, 'one fixture starter plus two owned targets; zero native opens');
  assert.equal(f.wire.calls.some(c => ['Target.activateTarget', 'Page.bringToFront'].includes(c.method)), false);
});

test('real Size guide returns an owned named tab with 11 cm and reuses that handle', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, '/shop/product/harbor'), first = await f.click('Size guide');
  assert.equal(first.effect, 'verified', JSON.stringify(first)); assert.equal(first.observation.nullReturned, true);
  assert.match(JSON.stringify(await f.read(first.tab)), /11 cm/);
  const again = await f.click('Size guide'); assert.equal(again.tab, first.tab, JSON.stringify(again));
  assert.equal(f.wire.calls.filter(c => c.method === 'Target.createTarget').length, 2);
  assert.equal(f.context.pages().length, 3, 'one fixture starter plus two owned targets; zero native opens');
  assert.equal(f.wire.calls.some(c => ['Target.activateTarget', 'Page.bringToFront'].includes(c.method)), false);
});

test('real DemoID refuses with the engine path error before source input and native opening', { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, '/shop/account'), result = await f.click('Sign in with DemoID');
  assert.equal(result.error.effect, 'none', JSON.stringify(result)); assert.equal(result.error.code, 'OPENER_REQUIRED');
  assert.match(result.error.message, /engine browser path/);
  assert.equal(f.wire.calls.some(c => c.method.startsWith('Input.')), false);
  assert.equal(f.wire.calls.filter(c => c.method === 'Target.createTarget').length, 1);
  assert.equal(f.context.pages().length, 2); assert.equal(f.events.some(e => e.kind === 'pointer'), false);
});

for (const [name, handler] of [
  ['onload opener', `onload="if (window.opener) window.opener.postMessage('complete', location.origin)"`],
  ['onerror unknown', `onerror="finishHandshake()"`],
]) test(`real Size guide destination ${name} handler refuses before source input`, { skip, timeout: 90000 }, async t => {
  const f = await fixture(t, '/shop/product/harbor', handler), result = await f.click('Size guide');
  assert.equal(result.error?.code, 'OPENER_REQUIRED', JSON.stringify(result));
  assert.equal(result.error.effect, 'none');
  assert.equal(f.wire.calls.some(c => c.method.startsWith('Input.')), false);
  assert.equal(f.wire.calls.some(c => ['Target.activateTarget', 'Page.bringToFront'].includes(c.method)), false);
  assert.equal(f.wire.calls.filter(c => c.method === 'Target.createTarget').length, 2);
  assert.equal(f.context.pages().length, 3, 'only the starter, source and qualified-check target exist');
  assert.equal(f.events.some(e => e.kind === 'pointer'), false);
});
