// Opt-in node:test fixtures use the existing Playwright Core cache.
// No screenshots, owner profile, engine, input, or native application access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, mkdirSync, rmdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { BrowserReads } from '../reads.mjs';

const fixture = readFileSync(new URL('../fixtures/reads.html', import.meta.url));
const core = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'live browser test is reserved for sleight-arch'
  : !existsSync(core) && 'existing Playwright Core cache unavailable';
async function serve(servers) {
  const server = createServer((request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(fixture); });
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t) {
  if (existsSync('/tmp/sleight-hold')) throw Error('Timed window active; stop before browser acquisition');
  mkdirSync('/tmp/sleight-live.lock');
  // One cleanup callback awaits the owned browser before releasing the live lock.
  let browser;
  const servers = [];
  t.after(async () => {
    if (browser) await browser.close();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    rmdirSync('/tmp/sleight-live.lock');
  });
  const { chromium } = await import(pathToFileURL(core).href);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  return { page: await context.newPage(), origin: await serve(servers), crossOrigin: await serve(servers) };
}
async function readerFor(page, maxNodes = 1000) {
  const session = await page.context().newCDPSession(page);
  const { frameTree } = await session.send('Page.getFrameTree');
  const reader = new BrowserReads({ identity: { browser: 'fixture', epoch: 1, broker: 1, session: 'fixture-session', lease: 1, target: 'owned-target' }, authorize: () => true, maxNodes });
  const adapter = { sessionId: 'fixture-cdp', send: session.send.bind(session), on: session.on.bind(session), off: session.off.bind(session) };
  reader.addFrame({ session: adapter, frameId: frameTree.frame.id, document: frameTree.frame.loaderId, target: 'owned-target' });
  return { reader, session };
}
test('real DOM delivered refs, recycled rows, Unicode, property refresh and navigation', { skip }, async t => {
  const { page, origin } = await setup(t);
  await page.goto(origin);
  const { reader, session } = await readerFor(page);
  try {
    const first = await reader.read({ maxBytes: 64000 });
    assert.equal(JSON.stringify(first).includes('synthetic-secret'), false);
    const buttons = first.data.filter(r => r.role === 'button' && r.name === 'Duplicate');
    assert.equal(buttons.length, 2); assert.notEqual(buttons[0].ref, buttons[1].ref);
    assert.throws(() => reader.resolve(buttons[0].ref), /stale/);
    reader.acknowledge(first.observation);
    await page.evaluate(() => { document.querySelector('#field').value = 'property-only'; document.querySelector('#recycled').setAttribute('aria-label', 'Recycled meaning'); });
    const delta = await reader.read({ since: first.observation });
    assert.equal(delta.data.some(r => r.state?.value === 'property-only'), true);
    const lost = await reader.read(); await reader.read({ private: true });
    assert.equal(reader.acknowledge(lost.observation), true);
    const scope = await reader.read({ ref: buttons[0].ref }); assert.equal(scope.data.some(r => r.ref === buttons[0].ref), true);
    await page.evaluate(() => document.querySelector('#first').replaceWith(document.querySelector('#first').cloneNode(true)));
    await reader.read(); assert.throws(() => reader.resolve(buttons[0].ref), /stale/);
    await page.goto(`${origin}?items=3000`);
    const bounded = await reader.read({ maxBytes: 1200 });
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 1200); assert.equal(bounded.complete, false);
    assert.throws(() => reader.resolve(buttons[1].ref), /stale/);
  } finally { reader.dispose(); await session.detach(); }
});
test('cross-origin frame is acquired through its own authorized binding', { skip }, async t => {
  const { page, origin, crossOrigin } = await setup(t);
  await page.goto(origin);
  await page.evaluate(url => new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.addEventListener('load', resolve, { once: true });
    frame.src = url; document.body.append(frame);
  }), crossOrigin);
  const frame = page.frames().find(f => f.url().startsWith(crossOrigin));
  // Different ports are distinct origins but can share a renderer target.
  const session = await page.context().newCDPSession(page);
  const { frameTree } = await session.send('Page.getFrameTree');
  const child = frameTree.childFrames.find(entry => entry.frame.url.startsWith(crossOrigin)).frame;
  assert.notEqual(new URL(frame.url()).origin, new URL(origin).origin);
  const reader = new BrowserReads({ identity: { browser: 'fixture', epoch: 1, broker: 1, session: 'child-session', lease: 1, target: 'child' }, authorize: () => true });
  try {
    reader.addFrame({ session: { sessionId: 'child', send: session.send.bind(session), on: session.on.bind(session), off: session.off.bind(session) }, frameId: child.id, document: child.loaderId, target: 'child' });
    const result = await reader.read(); assert.equal(result.data.some(r => r.name === 'Duplicate'), true);
  } finally { reader.dispose(); await session.detach(); }
});
