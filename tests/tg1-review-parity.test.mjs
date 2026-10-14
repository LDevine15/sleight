import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { createFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';
import { directBrowserServer } from '../plugins/sleight/lib/launch.mjs';
import { tabCleanupCode, cleanupTabsCode } from '../plugins/sleight/lib/browser-tab-cleanup.mjs';
import { turboSetup } from '../bench/turbo/setup.mjs';
import { createModuleSession } from '../bench/turbo/session.mjs';
import { fixture } from './fixtures/direct-browser-open.mjs';

test('combined benchmark companion exposes the same engine surfaces as installed turbo', async t => {
  const frontend = await createFrontend({ proof: {}, verifyOptIn: () => true, packageCurrent: () => true,
    status: () => 'connected', selectedBrowser: 'bselected', redact: value => value,
    endSession: () => ({ revoked: true, cleanup: [] }), client: { request: () => ({ effect: 'none', completed: 0 }) } });
  t.after(() => frontend.end());
  const installed = directBrowserServer({ command: 'synthetic-engine', env: { CUA_REPL_ENABLED_SURFACES: 'computer' } }, frontend);
  const task = { name: 'wikipedia', browser: 'chrome', prompt: 'Read https://en.wikipedia.org/wiki/Computer', result: 'a value' };
  const setup = turboSetup({ task, repo: fileURLToPath(new URL('..', import.meta.url)),
    dir: join(tmpdir(), 'tg1-review-no-write'), prompt: task.prompt });
  t.diagnostic(JSON.stringify({ installed: installed.env.CUA_REPL_ENABLED_SURFACES,
    benchmark: setup.mcpServers['plugin:sleight:computer'].env.SLEIGHT_SURFACES, path: setup.metadata.path }));
  assert.equal(installed.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  assert.equal(setup.mcpServers['plugin:sleight:computer'].env.SLEIGHT_SURFACES, 'browser,computer');
});

test('turbo actions and each path cleanup stay within their own tab records', async t => {
  const f = await fixture(t, { rawOnly: true });
  const origin = 'http://127.0.0.1:5431';
  const raw = { sessionId: f.raw.sessionId, on: f.raw.on, off: f.raw.off, async send(method, params, route) {
    const value = await f.raw.send(method, params, route);
    if (method === 'Page.getFrameTree') value.frameTree.frame.url = origin;
    return value;
  } };
  const turbo = await createModuleSession({ raw, origins: [origin], taskMessage: 'Read the fixture.' });
  t.after(() => turbo.close());
  const opened = await turbo.call({ name: 'browser_open', arguments: { browser: 'bbench', url: origin } });
  assert.equal(opened.effect, 'verified');
  // Both paths see the same simulated physical inventory, but only their own
  // allocation calls enroll targets in their respective production journals.
  const cua = {
    async createBrowserTab() {
      f.targets.set('engine-owned', { targetId: 'engine-owned', type: 'page', url: 'https://fixture.invalid' });
      return { id: '42', playwright: { evaluate: async () => ({ loading: false, edited: false }) },
        close: async () => { f.targets.delete('engine-owned'); } };
    },
    async getBrowser() { return { browserId: 'engine', tabs: { list: async () => [...f.targets.values()]
      .map(row => ({ id: row.targetId === 'engine-owned' ? '42' : opened.tab, url: row.url })) } }; },
  };
  const context = createContext({ cua, setTimeout, clearTimeout, Date, URL, nodeRepl: { write() {} } });
  const run = code => runInContext(`(async () => { ${code} })()`, context);
  await run(tabCleanupCode('await cua.createBrowserTab("engine", "https://fixture.invalid");'));
  const before = f.calls.length;
  for (const tab of ['42', 'tengine']) {
    const refused = await turbo.call({ name: 'browser_act', arguments: { tab, op: 'click', ref: 'rengine' } });
    assert.ok(refused.error, JSON.stringify(refused));
  }
  assert.equal(f.calls.length, before, 'a foreign tab must not reach CDP');
  await run(cleanupTabsCode);
  assert.deepEqual([...f.targets.keys()], ['owned'], 'engine cleanup must leave the turbo target');
  await run(tabCleanupCode('await cua.createBrowserTab("engine", "https://fixture.invalid");'));
  const receipt = await turbo.close();
  assert.equal(receipt.revoked, true);
  assert.deepEqual([...f.targets.keys()], ['engine-owned'], 'turbo cleanup must leave the engine target');
  assert.deepEqual(f.calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId), ['owned']);
  await run(cleanupTabsCode);
  assert.equal(f.targets.size, 0);
});
