import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixtureSlice } from '../broker.mjs';

const secret = 'c'.repeat(64), url = 'http://127.0.0.1:45123/slice';
const hello = id => ({ version: 1, secret, uid: process.getuid(), session: id, incarnation: id + '-client' });
const call = (client, id, operation, args) => client.request({ id, operation, args });
function fake({ delayedDocument = false } = {}) {
  const sends = [], targets = new Set(['unrelated']), state = { clicked: false, value: '' };
  let frameReads = 0, reads = 0;
  const root = new Proxy({ sessionId: 'fixture-socket', on() {}, off() {}, async send(method, params, sessionId) {
    sends.push({ method, params, sessionId });
    if (method === 'Target.createTarget') { assert.equal(params.background, true); targets.add('owned'); return { targetId: 'owned' }; }
    if (method === 'Target.attachToTarget') { assert.equal(params.targetId, 'owned'); return { sessionId: 'owned-session' }; }
    if (method === 'Target.closeTarget') { targets.delete(params.targetId); return { success: true }; }
    if (method === 'Target.getTargets') return { targetInfos: [...targets].map(targetId => ({ targetId })) };
    assert.equal(sessionId, 'owned-session');
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: delayedDocument && frameReads++ === 0 ? 'about:blank' : url } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 12 };
    if (method === 'Runtime.callFunctionOn') {
      const values = params.arguments.map(arg => arg.value);
      if (!values.length) return { result: { value: { url, ready: !delayedDocument || reads++ > 0, text: state.clicked ? 'Clicked' : 'Ready',
        refs: [{ ref: 'r1', role: 'button', name: 'Change' }, { ref: 'r2', role: 'textbox', name: 'Name', value: state.value }] } } };
      return { result: { value: { x: 50, y: values[0] === 'r1' ? 20 : 70, role: values[0] === 'r1' ? 'button' : 'textbox', value: state.value } } };
    }
    if (method === 'Input.dispatchMouseEvent') { if (params.type === 'mouseReleased' && params.y === 20) state.clicked = true; return {}; }
    if (method === 'Input.insertText') { state.value = params.text; return {}; }
    if (method === 'Input.dispatchKeyEvent') return {};
    throw Error('unsupported CDP method ' + method);
  } }, { get(target, key) { if (key in target || typeof key === 'symbol' || key === 'then') return target[key]; throw Error('unsupported engine member ' + key); } });
  return { root, sends, targets, state };
}
async function runSlice(slice, id = 'slice') {
  await slice.broker.connect({ userInitiated: true }); const client = slice.broker.attach(hello(id));
  const open = await call(client, 'open', 'browser_open', { browser: 'bfixture', url: slice.url });
  assert.equal(open.effect, 'verified'); const tab = open.tab;
  const read = await call(client, 'read', 'browser_read', { tab });
  const button = read.observation.refs.find(ref => ref.role === 'button');
  const field = read.observation.refs.find(ref => ref.role === 'textbox');
  assert.ok(button && field);
  const act = await call(client, 'act', 'browser_act', { tab, op: 'click', ref: button.ref });
  assert.equal(act.effect, 'verified'); assert.match(act.observation.text, /Clicked/);
  const fill = await call(client, 'fill', 'browser_fill', { tab, fields: [{ ref: field.ref, value: 'Fixture name' }] });
  assert.equal(fill.effect, 'verified'); assert.equal(fill.observation.refs.find(ref => ref.ref === field.ref).value, 'Fixture name');
  assert.equal((await call(client, 'verify', 'browser_read', { tab })).observation.refs.find(ref => ref.ref === field.ref).value, 'Fixture name');
  assert.deepEqual(await slice.closeOwned(tab, id), { closed: true, absent: true }); client.disconnect();
  return { open, read, act, fill };
}
test('fixture four verbs use scoped protocol input and leave an unrelated target untouched', async () => {
  const f = fake(); const slice = createFixtureSlice({ url, session: f.root, uid: process.getuid(), secret, idlePolicy: 'retain' });
  await runSlice(slice);
  assert.deepEqual([...f.targets], ['unrelated']);
  assert.equal(f.sends.filter(s => s.method === 'Target.attachToTarget').length, 1);
  assert.ok(f.sends.every(s => s.params.targetId !== 'unrelated' && s.sessionId !== 'unrelated'));
  assert.ok(f.sends.every(s => !['Target.setAutoAttach', 'Browser.setDownloadBehavior', 'Browser.close', 'Target.activateTarget'].includes(s.method)));
});
test('owned background open waits for its exact document and complete state', async () => {
  const f = fake({ delayedDocument: true });
  const slice = createFixtureSlice({ url, session: f.root, uid: process.getuid(), secret, idlePolicy: 'retain' });
  await runSlice(slice);
});
test('fixture grants reject foreign URLs, cross-session handles, raw operations and non-text form fields', async () => {
  const f = fake(), slice = createFixtureSlice({ url, session: f.root, uid: process.getuid(), secret, idlePolicy: 'retain' });
  await slice.broker.connect({ userInitiated: true }); const a = slice.broker.attach(hello('a')), b = slice.broker.attach(hello('b'));
  assert.equal((await call(a, 'foreign', 'browser_open', { browser: 'bfixture', url: 'https://example.test' })).effect, 'none');
  const opened = await call(a, 'open', 'browser_open', { browser: 'bfixture', url });
  assert.equal((await call(b, 'foreign-tab', 'browser_read', { tab: opened.tab })).effect, 'none');
  assert.equal((await call(a, 'raw', 'Runtime.evaluate', { code: '1' })).effect, 'none');
  assert.equal((await call(a, 'fields', 'browser_fill', { tab: opened.tab, fields: [{ ref: 'r2', value: true }] })).effect, 'none');
  await assert.rejects(slice.closeOwned(opened.tab, 'b'), /FOREIGN_TARGET/);
  assert.equal(f.sends.filter(s => s.method === 'Target.closeTarget').length, 0);
  await slice.closeOwned(opened.tab, 'a'); a.disconnect(); b.disconnect();
});

const playwright = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const chromium = process.env.SLEIGHT_LIVE_DOM_TEST === '1' && existsSync(playwright)
  ? (await import(pathToFileURL(playwright).href)).chromium : undefined;
const shellRevision = chromium && JSON.parse(readFileSync(join(playwright, '..', 'browsers.json'))).browsers
  .find(browser => browser.name === 'chromium-headless-shell')?.revision;
const shellPlatform = process.platform === 'darwin' ? 'mac-' + (process.arch === 'arm64' ? 'arm64' : 'x64')
  : process.platform === 'linux' ? 'linux64' : 'win64';
const browserAvailable = shellRevision && existsSync(join(homedir(), 'Library/Caches/ms-playwright',
  'chromium_headless_shell-' + shellRevision, 'chrome-headless-shell-' + shellPlatform,
  process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'));
test('real local page: public four verbs prove state and exact owned cleanup', {
  skip: process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'live browser test is reserved for sleight-arch'
    : !existsSync(playwright) ? 'cached playwright-core is unavailable' : !browserAvailable && 'cached headless Chromium executable is unavailable',
}, async t => {
  const { createServer } = await import('node:http');
  const html = readFileSync(new URL('../fixtures/slice.html', import.meta.url));
  const server = createServer((_, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/slice`;
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const unrelated = await browser.newPage(); await unrelated.goto(url);
  const root = await browser.newBrowserCDPSession(), pending = new Map(); let sequence = 0;
  root.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message), entry = pending.get(message.id);
    if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(Error('CDP_ERROR')) : entry.resolve(message.result);
  });
  t.after(() => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('CLOSED')); } });
  const session = { sessionId: 'owned-headless-pipe', on() {}, off() {},
    async send(method, params, sessionId) {
      if (!sessionId) return root.send(method, method === 'Target.attachToTarget' ? { ...params, flatten: false } : params);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP_TIMEOUT')); }, 2500);
        pending.set(id, { resolve, reject, timer });
        root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
      });
    },
  };
  const slice = createFixtureSlice({ url, session, uid: process.getuid(), secret, idlePolicy: 'retain' });
  await runSlice(slice);
  assert.equal(await unrelated.locator('input').inputValue(), '');
  assert.equal(await unrelated.locator('output').innerText(), 'Ready');
  assert.equal(unrelated.isClosed(), false);
});
