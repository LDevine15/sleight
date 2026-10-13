import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorldReader } from '../worlds.mjs';
import { BackendRefs } from '../closed-roots.mjs';
import { ProtectedProof } from '../protected-proof.mjs';

// No download/install, screenshot, owner endpoint, profile or engine access.
const playwrightPath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const qualification = { skip: process.env.SLEIGHT_LIVE_DOM_TEST !== '1'
  ? 'live browser test is reserved for sleight-arch'
  : !existsSync(playwrightPath) && 'cached playwright-core unavailable; no npm install' };
async function ownedPage(t) {
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  // Match tests/pick-from-list.test.mjs: use an installed disposable shell, no download.
  const shells = [1234, 1228].map(build => join(homedir(),
    `Library/Caches/ms-playwright/chromium_headless_shell-${build}/chrome-headless-shell-mac-arm64/chrome-headless-shell`));
  const executablePath = shells.find(path => existsSync(path));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext();
  return context.newPage();
}
const fixture = readFileSync(new URL('../fixtures/worlds.html', import.meta.url), 'utf8');
async function setup(page, timeoutMs = 1000) {
  await page.setContent(fixture);
  const session = await page.context().newCDPSession(page);
  const contexts = new Map();
  session.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id);
  });
  await session.send('Page.enable'); await session.send('Runtime.enable');
  const { frameTree } = await session.send('Page.getFrameTree');
  let current = { browserIncarnation: 'fixture', brokerEpoch: 1, clientSession: 'fixture-client', turn: 'fixture-turn',
    leaseGeneration: 1, target: 'fixture-target', frame: frameTree.frame.id, document: 1, origin: 'https://fixture.invalid' };
  // The owned page is about:blank, bound to the fixture creator, not an origin grant.
  const refs = new BackendRefs(session, () => current);
  const read = new WorldReader(session, refs, { current: () => current, mainContext: b => contexts.get(b.frame), timeoutMs });
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const byId = new Map();
  const visit = node => {
    const attrs = node.attributes ?? []; const i = attrs.indexOf('id');
    if (i >= 0) byId.set(attrs[i + 1], refs.remember(node.backendNodeId, current));
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child);
  };
  visit(root);
  return { session, refs, read, byId, current: () => current, change: patch => { current = { ...current, ...patch }; },
    close: async () => { read.dispose(); refs.dispose(); await session.detach(); } };
}
test('isolated absent versus MAIN true, closed root and property redefinition', qualification, async t => {
  const page = await ownedPage(t);
  const f = await setup(page);
  try {
    assert.equal((await f.read.read(f.byId.get('custom'), 'checked')).state, 'absent');
    assert.equal((await f.read.read(f.byId.get('custom'), 'checked', { semantics: 'page' })).value, true);
    assert.equal((await f.read.read(f.byId.get('closed-switch'), 'checked')).value, true);
    await page.evaluate(() => Object.defineProperty(document.querySelector('#custom'), 'checked', { get: () => false }));
    assert.equal((await f.read.read(f.byId.get('custom'), 'checked', { semantics: 'page' })).value, false);
    assert.equal((await f.refs.scan()).nodes.some(node => node.closed), true);
  } finally { await f.close(); }
});
test('absent, throwing, hostile and timed-out getter states never leak', qualification, async t => {
  const page = await ownedPage(t);
  const f = await setup(page, 50);
  try {
    for (const [id, state] of [['absent', 'absent'], ['throwing', 'throwing'], ['hostile', 'unreadable']]) {
      const output = await f.read.read(f.byId.get(id), 'checked', { semantics: 'page' });
      assert.equal(output.state, state); assert.ok(!JSON.stringify(output).includes('fixture-secret'));
    }
    assert.equal((await f.read.read(f.byId.get('slow'), 'checked', { semantics: 'page' })).state, 'timeout');
  } finally { await f.close(); }
});
test('protected write proof is operation bound and old refs refuse document/origin change', qualification, async t => {
  const page = await ownedPage(t);
  const f = await setup(page); const proof = new ProtectedProof({ current: f.current, authorize: async () => true });
  const secret = 'fixture-protected-write-seed';
  try {
    const op = { ...f.current(), operation: 'fixture-write', field: f.byId.get('secret'), dispatchFence: 1 };
    const cap = await proof.prepare(op, secret);
    const receipt = await proof.execute(cap, op, { dispatch: value => page.locator('#secret').fill(value), observe: async () => {
      const { executionContextId } = await f.session.send('Page.createIsolatedWorld', { frameId: op.frame, worldName: 'fixture-private-proof' });
      const record = f.refs.resolve(op.field);
      const { object } = await f.session.send('DOM.resolveNode', { backendNodeId: record.backendNodeId, executionContextId });
      try {
        const { result } = await f.session.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true,
          functionDeclaration: 'function () { return Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").get.call(this); }' });
        return { source: 'native', value: result.value };
      } finally { await f.session.send('Runtime.releaseObject', { objectId: object.objectId }); }
    } });
    assert.equal(receipt.status, 'verified'); assert.ok(!JSON.stringify(receipt).includes(secret));
    assert.equal((await proof.execute(cap, op, {})).status, 'blocked');
    assert.equal((await f.read.read(op.field, 'value')).state, 'redacted');
    f.change({ document: 2, origin: 'https://changed.invalid' });
    assert.equal((await f.read.read(op.field, 'value')).state, 'stale');
  } finally { proof.dispose(); await f.close(); }
});
