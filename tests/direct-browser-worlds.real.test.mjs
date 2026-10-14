import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RefMap } from '../plugins/sleight/lib/direct-browser/refs.mjs';
import { WorldReader, loadPlaywrightCore } from '../plugins/sleight/lib/direct-browser/worlds.mjs';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const runtime = live ? loadPlaywrightCore({ turbo: true }) : null;
const browserInfo = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
  .browsers.find(b => b.name === 'chromium-headless-shell');
const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
const executable = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + browserInfo.revision,
  'chrome-headless-shell-' + platform, 'chrome-headless-shell');

test('owned real page: native and MAIN getter evidence stays separate and protected values stay redacted', {
  skip: !live ? 'live page qualification is reserved for sleight-arch'
    : !existsSync(executable) ? 'the pinned headless browser executable is unavailable' : false,
}, async t => {
  const { createServer } = await import('node:http');
  const server = createServer((_, response) => response.end(`<!doctype html>
    <input id="check" type="checkbox" checked><input id="secret" type="password" value="fixture-private-value">
    <x-control id="custom"></x-control><script>
      customElements.define('x-control', class extends HTMLElement {
        constructor() { super(); this.attachShadow({mode:'closed'}).innerHTML='<input type="checkbox" checked>'; }
        get checked() { return true; }
      });
    </script>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await runtime.inprocess.playwright.chromium.launch({ headless: true, executablePath: executable });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const cdp = await page.context().newCDPSession(page);
  let mainContext;
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData?.isDefault) mainContext = context.id;
  });
  await cdp.send('Runtime.enable');
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const identity = { browserIncarnation: 'owned-fixture', brokerEpoch: 1, clientSession: 'fixture', turn: 1,
    leaseGeneration: 1, target: 'owned-fixture', frame: frameTree.frame.id, document: 1,
    origin: `http://127.0.0.1:${server.address().port}` };
  const refs = new RefMap(identity), root = await cdp.send('DOM.getDocument', { depth: 1, pierce: false });
  const nodeRef = async selector => {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.root.nodeId, selector });
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    return refs.observe(identity, node.backendNodeId, selector);
  };
  const native = await nodeRef('#check'), secret = await nodeRef('#secret'), custom = await nodeRef('#custom');
  const methods = new Set(['Page.createIsolatedWorld', 'DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject']);
  const session = { sessionId: 'owned-page', on: cdp.on.bind(cdp), off: cdp.off.bind(cdp),
    send(method, params) { assert.ok(methods.has(method), 'unexpected node-state command'); return cdp.send(method, params); } };
  const reader = new WorldReader(session, refs, { current: () => identity, mainContext: () => mainContext });
  t.after(() => reader.dispose());
  assert.deepEqual(await reader.read(native, 'checked'), { state: 'value', source: 'native', value: true });
  assert.equal((await reader.read(custom, 'checked')).state, 'absent');
  assert.deepEqual(await reader.read(custom, 'checked', { semantics: 'page' }), { state: 'value', source: 'page-reported', value: true });
  const protectedValue = await reader.read(secret, 'value');
  assert.equal(protectedValue.state, 'redacted');
  assert.doesNotMatch(JSON.stringify(protectedValue), /fixture-private-value|length|hash/);
});
