import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { trackTemp } from '../../../scripts/temp-leftovers.mjs';
import { Lifecycle } from '../lifecycle.mjs';

// The ledger's REAL-PAGE TESTS rule uses node:test and the pinned cache dependency.
// No install, owner profile, visible browser or production engine access.
const corePath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const skip = !live ? 'SLEIGHT_LIVE_DOM_TEST=1 is required; no browser launched'
  : !existsSync(corePath) ? 'cached playwright-core is unavailable; no browser launched' : false;
let chromium;
if (!skip) ({ chromium } = await import(pathToFileURL(corePath).href));
const options = { skip, timeout: 30_000 };

const endpoint = async (profile) => {
  const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  assert.match(port, /^\d+$/);
  assert.match(path, /^\/devtools\/browser\/[A-Za-z0-9-]+$/);
  return `http://127.0.0.1:${port}`.replace('http:', 'ws:') + path;
};
const launch = (profile) => chromium.launchPersistentContext(profile, {
  headless: true, args: ['--remote-debugging-port=0'], timeout: 10_000,
});
const transport = (browser, session) => {
  const result = new EventEmitter();
  result.sessionId = 'owned-disposable-browser-session';
  result.send = (method, args) => session.send(method, args);
  browser.once('disconnected', () => result.emit('disconnected'));
  return result;
};

test('actual socket loss revokes old leases, without closing the owned browser', options, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('cached Chromium executable is unavailable'); return; }
  const profile = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-bp2-10-')));
  let context;
  let attached;
  try {
    context = await launch(profile);
    const ws = await endpoint(profile);
    attached = await chromium.connectOverCDP(ws);
    const session = await attached.newBrowserCDPSession();
    const cdp = transport(attached, session);
    const selected = { incarnation: 'owned-process-1', brokerEpoch: 'broker-1', endpoint: ws };
    const target = await session.send('Target.createTarget', { url: 'about:blank', background: true });
    const identity = { ...selected, session: 'fixture', turn: 'turn-1', targetId: target.targetId,
      targetGeneration: 1, leaseGeneration: 1, frame: 'owned-frame', document: 'owned-document', origin: 'https://example.test' };
    let dispatches = 0;
    const proof = {};
    const lane = new Lifecycle({ verifyConnection: (p) => p === proof, verifyAuthority: (p) => p === proof,
      saveJournal: () => true, observeTarget: () => identity,
      dispatch: async () => { dispatches++; await session.send('Browser.getVersion'); return { phase: 'observed', effect: 'observed', completed: [0] }; } });
    await lane.connect(cdp, selected, proof);
    lane.beginTurn('fixture', 'turn-1', 'frontend-1');
    const lease = lane.track(identity, { owned: true, ephemeral: true });
    const token = lane.prepare(lease, { operation: 'unstarted', op: 'read', args: {} });
    await attached.close();
    assert.equal(lane.state.needsChromeConsent, true);
    assert.equal((await lane.dispatch(token, proof)).effect, 'none');
    assert.equal(dispatches, 0);
    // The owner of this disposable browser, rather than the attached client,
    // remains responsible for final process/profile cleanup.
    assert.ok(context.pages().length > 0);
  } finally {
    await attached?.close().catch(() => {});
    try { await context?.close(); }
    finally { await rm(profile, { recursive: true, force: true }); }
  }
});

test('browser restart changes endpoint; stale discovery never dispatches on the replacement', options, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('cached Chromium executable is unavailable'); return; }
  const profile = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-bp2-10-')));
  let context;
  let attached;
  try {
    context = await launch(profile);
    const oldEndpoint = await endpoint(profile);
    await context.close();
    // Simulates retained/stale file discovery. The old endpoint is data only.
    context = await launch(profile);
    const freshEndpoint = await endpoint(profile);
    assert.notEqual(freshEndpoint, oldEndpoint);
    attached = await chromium.connectOverCDP(freshEndpoint);
    const session = await attached.newBrowserCDPSession();
    const cdp = transport(attached, session);
    let sends = 0;
    const send = cdp.send;
    cdp.send = (...args) => { sends++; return send(...args); };
    const fresh = { incarnation: 'owned-process-2', brokerEpoch: 'broker-2', endpoint: freshEndpoint };
    const proof = {};
    const lane = new Lifecycle({ verifyConnection: (p, b) => p === proof &&
      b.incarnation === fresh.incarnation && b.endpoint === freshEndpoint });
    await assert.rejects(lane.connect(cdp, { ...fresh, incarnation: 'owned-process-1', endpoint: oldEndpoint }, proof), /CONNECTION_APPROVAL_REQUIRED/);
    assert.equal(sends, 0);
    await lane.connect(cdp, fresh, proof);
    assert.equal(sends, 0);
    lane.loseConnection('fixture-finished');
  } finally {
    await attached?.close().catch(() => {});
    try { await context?.close(); }
    finally { await rm(profile, { recursive: true, force: true }); }
  }
});
