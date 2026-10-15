import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide } from '../bench/turbo/engine-browser-guard.mjs';
import { benchBrowser } from '../bench/turbo/v3-protocol.mjs';

const js = code => ({ tool_name: 'mcp__plugin_sleight_computer__js', tool_input: { code } });
test('engine calls that reach a real browser are refused and pointed at turbo', () => {
  for (const code of ['await cua.listBrowsers()', 'const chrome = await cua.getApp("com.google.Chrome")', 'cua.getApp("net.imput.helium")',
    'await cua.getBrowser({})', 'cua.getApp("Safari")', 'cua.createBrowserTab(b, u)']) {
    const out = decide(js(code), 'chrome');
    assert.equal(out?.hookSpecificOutput.permissionDecision, 'deny', code);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /chrome is the sleight-turbo browser/);
  }
});
test('other engine and turbo calls pass', () => {
  for (const input of [js('await cua.getApp("com.apple.TextEdit")'), js('// knowledge of edges'), js('await cua.getState()'),
    { tool_name: 'mcp__sleight-turbo__browser_open', tool_input: { url: 'http://127.0.0.1:5420/', browser: 'chrome' } }])
    assert.equal(decide(input), null, JSON.stringify(input));
});
test('the bench browser takes only a plain task browser name', () => {
  assert.equal(benchBrowser({}), 'bbench');
  assert.equal(benchBrowser({ SLEIGHT_TURBO_BROWSER: 'chrome' }), 'chrome');
  assert.equal(benchBrowser({ SLEIGHT_TURBO_BROWSER: 'Chrome; rm' }), 'bbench');
});
test('the turbo arm names its browser after the task and installs the guard beside its own settings', async () => {
  const { turboSetup } = await import('../bench/turbo/setup.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'turbo-guard-'));
  let setup;
  try { setup = turboSetup({ task: { name: 'demoid', browser: 'helium', prompt: 'Open http://127.0.0.1:5420/x' }, repo: process.cwd(), dir, prompt: 'p' }); }
  catch (error) { if (/outside|git/i.test(error.message)) return; throw error; }
  assert.equal(setup.mcpServers['sleight-turbo'].env.SLEIGHT_TURBO_BROWSER, 'helium');
  assert.match(setup.promptPrefix, /Turbo selects `helium`/);
  assert.match(setup.settings.hooks.PreToolUse[0].hooks[0].command, /engine-browser-guard\.mjs" helium$/);
  assert.equal(setup.settings.hooks.PreToolUse[0].matcher, 'mcp__plugin_sleight_computer__js');
});
