import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { rewriteBrowserInstructions, isNativeGetState, TAB_URL_SENTENCE, WINDOWS_LINE } from '../plugins/sleight/lib/engine-app-docs.mjs';
import { traceEnv, realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';

const INSTRUCTIONS = '<app_specific_instructions>\n## Browser Computer Use\n\nWhen navigating to a new website or starting a separate web task, prefer opening a new tab instead of reusing the current tab; reuse the current tab only when the user explicitly asks to continue there or when the current page is clearly the right place to continue the existing workflow.\n</app_specific_instructions>\n';
const TREE = 'Window: "Start Page", App: Browser.\n0 standard window Start Page';

function harness(t) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  return {
    call(id, code) { clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'); },
    reply(id, text, extra = {}) {
      serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }], ...extra } }) + '\n');
      return replies.find(row => row.id === id).result.content.map(item => item.text ?? '');
    },
  };
}

test('the engine browser instructions gain one sentence, once, at the end of their block', () => {
  const out = rewriteBrowserInstructions(INSTRUCTIONS + TREE);
  assert.ok(out.includes(`workflow. ${TAB_URL_SENTENCE}\n</app_specific_instructions>\n${TREE}`));
  assert.equal(TAB_URL_SENTENCE, 'Open the tab and send its URL in the same call.');
  assert.equal(rewriteBrowserInstructions(out), out);
  const other = '<app_specific_instructions>\n## Spreadsheet Computer Use\n\nKeep formulas.\n</app_specific_instructions>\n' + TREE;
  assert.equal(rewriteBrowserInstructions(other), other);
  assert.equal(rewriteBrowserInstructions(TREE), TREE);
});

test('a native getApp result carries the sentence; a browser-surface result is left alone', t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Browser")');
  const first = h.reply(1, INSTRUCTIONS + TREE).join('\n');
  assert.match(first, /workflow\. Open the tab and send its URL in the same call\.\n<\/app_specific_instructions>/);
  assert.equal(first.split(TAB_URL_SENTENCE).length, 2);
  h.call(2, 'let tab = await cua.getTab("1")');
  const browser = h.reply(2, INSTRUCTIONS + TREE, { _meta: { 'codex/toolSurface': { kind: 'browserUse' } } }).join('\n');
  assert.ok(!browser.includes(TAB_URL_SENTENCE));
});

test('a native getState result ends with the windows line', t => {
  const h = harness(t);
  h.call(1, 'await cua.getState()');
  const state = h.reply(1, '{"apps":[{"displayName":"Browser","id":"x.browser"}],"browsers":[]}');
  assert.equal(state.at(-1), WINDOWS_LINE);
  assert.equal(WINDOWS_LINE, "Windows: a window's title is the `Window:` header of `cua.getApp(...)`'s tree; there is no listWindows or listBrowsers here.");
  assert.equal(state.filter(text => text.includes('listWindows')).length, 1);
  h.call(2, 'let app = await cua.getApp("Browser")');
  assert.ok(!h.reply(2, TREE).join('\n').includes('listWindows'));
  h.call(3, 'await cua.getState()');
  assert.ok(!h.reply(3, '{"apps":[],"browsers":[]}', { isError: true }).join('\n').includes('listWindows'));
  h.call(4, 'await cua.getState()');
  assert.ok(!h.reply(4, '{"apps":[],"browsers":[]}', { _meta: { 'codex/toolSurface': { kind: 'browserUse' } } }).join('\n').includes('listWindows'));
});

test('getState detection needs a cua.getState call and an apps payload', () => {
  const ok = { content: [{ type: 'text', text: '{"apps":[]}' }] };
  assert.equal(isNativeGetState('await cua.getState()', ok), true);
  assert.equal(isNativeGetState('await app.getState()', ok), false);
  assert.equal(isNativeGetState('await cua.getApp("X")', ok), false);
  assert.equal(isNativeGetState('await cua.getState()', { content: [{ type: 'text', text: TREE }] }), false);
});

test('the sleight arm gets SLEIGHT_TRACE and no other host variable', () => {
  assert.deepEqual(traceEnv({ SLEIGHT_TRACE: '1', SLEIGHT_PROMPT: 'lean', CLAUDE_CODE_X: '1', HOME: '/h' }), { SLEIGHT_TRACE: '1' });
  assert.deepEqual(traceEnv({ SLEIGHT_TRACE: '', HOME: '/h' }), {});
  assert.deepEqual(traceEnv({}), {});
  const browser = { browser: 'firefox', profileRoot: '/tmp/profile', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', marker: 'Sleight Gate fixture', pid: 1 };
  const task = { name: 'mdn', prompt: 'Open {browser}.', result: 'the answer' };
  const saved = process.env.SLEIGHT_TRACE;
  try {
    process.env.SLEIGHT_TRACE = '/tmp/trace-dir';
    const traced = realAgentSetup({ task, surface: 'sleight', dir: '/private/tmp/gate-task', realBrowser: browser, dryRun: true });
    assert.deepEqual(traced.mcpConfig.mcpServers['plugin:sleight:computer'].env,
      { SLEIGHT_SURFACES: 'computer', SLEIGHT_TURBO: '0', SLEIGHT_TRACE: '/tmp/trace-dir' });
    delete process.env.SLEIGHT_TRACE;
    const plain = realAgentSetup({ task, surface: 'sleight', dir: '/private/tmp/gate-task', realBrowser: browser, dryRun: true });
    assert.deepEqual(plain.mcpConfig.mcpServers['plugin:sleight:computer'].env, { SLEIGHT_SURFACES: 'computer', SLEIGHT_TURBO: '0' });
  } finally { if (saved === undefined) delete process.env.SLEIGHT_TRACE; else process.env.SLEIGHT_TRACE = saved; }
});

test('rounds.sh passes SLEIGHT_TRACE through its real-browser env -i branch', () => {
  const script = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  const branch = script.slice(script.indexOf('if [ -n "$REAL" ]; then'), script.indexOf('fi\n', script.indexOf('if [ -n "$REAL" ]; then')));
  assert.match(branch, /env -i[\s\S]*\$\{SLEIGHT_TRACE:\+SLEIGHT_TRACE="\$SLEIGHT_TRACE"\}[\s\S]*node tools\/rounds\.mjs/);
  assert.ok(!/SLEIGHT_PROMPT|ANTHROPIC_API_KEY|CLAUDE_/.test(branch));
});
