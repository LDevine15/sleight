// SOL-L2 (2026-10-19): sleight inside Codex on gpt-6.1-sol failed the race's demoid task 6 of 6 (race-1017,
// {safari,firefox}-codex-sleight-sol-b16-r{1,2,3}). "Sign in with DemoID" opens a separate pop-up window. sleight showed it
// and acted in it; the model stopped, citing "your window restriction". That restriction is the race's own prompt
// (windowPrompt, "never use any other browser window"), and the race's select_window guard refused the way back to the
// renamed shop window without saying how else to return. Both are harness text, and every arm gets the same prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowPrompt } from '../bench/fowl/native-setup.mjs';
import { realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';
import { gateWindowCheck } from '../bench/fowl/origin-hook.mjs';

const demoid = { name: 'demoid', browser: 'safari', needsClicks: true, result: 'the name the shop shows after signing in',
  prompt: 'sign in to the demo shop at http://127.0.0.1:5420/t/demoid/shop/account in {browser} with DemoID and tell me the name it shows' };
const browsers = {
  safari: { browser: 'safari', profileRoot: '/tmp/profile', profileName: 'sleight benchmark', pid: 98302,
    executable: '/Applications/Safari.app/Contents/MacOS/Safari', marker: 'Sleight Gate c128a239-6d67-476f-b031-699b7b71dba6' },
  firefox: { browser: 'firefox', profileRoot: '/tmp/profile', pid: 13679,
    executable: '/Applications/Firefox.app/Contents/MacOS/firefox', marker: 'Sleight Gate 0faae6c1-c954-41c1-9dba-fd4cf0ca5189' },
};
const POPUP = /except a pop-up that a page in that window opens during the task/;

test('every arm on Safari and Firefox is told a pop-up its page opens belongs to the task, and nothing wider', () => {
  for (const [name, realBrowser] of Object.entries(browsers)) {
    const prompt = windowPrompt(realBrowser);
    assert.match(prompt, POPUP, name);
    assert.match(prompt, /once it closes, that window is the browser's window again/, name);
    // The exception never reaches another browser, profile or a window that was open before the task.
    assert.match(prompt, /never use any other browser window or profile, except a pop-up/, name);
    assert.match(prompt, /Never act in a window that was already open, another profile or another browser\./, name);
    assert.match(prompt, /If the dedicated window cannot be identified, stop\./, name);
    for (const surface of ['sleight', 'codex-sleight', 'codex-sleight-sol', 'codex', 'codex-sol']) {
      const setup = realAgentSetup({ task: { ...demoid, browser: name }, surface, dir: '/private/tmp/gate-task', realBrowser, dryRun: true });
      assert.ok(setup.prompt.includes(prompt), `${surface} on ${name} gets the same window text`);
      assert.match(setup.prompt, /sign in to the demo shop .* with DemoID/);
    }
  }
});

test("the race's refused select_window calls still refuse, and the reason names the way back from a pop-up", () => {
  for (const [name, realBrowser] of Object.entries(browsers)) {
    const app = name === 'safari' ? 'Safari' : 'Firefox';
    const env = { FOWL_GATE_WINDOW: JSON.stringify({ apps: [app], title: realBrowser.marker }) };
    const call = input => gateWindowCheck({ tool_name: 'select_window', tool_input: input }, env);
    // The exact inputs from the six runs: the loaded shop title, with and without the window number select_window returned.
    const shop = name === 'safari' ? 'sleight benchmark — Sign in · Tidewell Demo Shop' : 'Sign in · Tidewell Demo Shop';
    for (const input of [{ app, title: shop }, { app, title: shop, windowNumber: realBrowser.pid === 98302 ? 305953 : 307223 },
      { app, title: realBrowser.marker, windowNumber: 307223 }, { app, title: 'DemoID' }]) {
      const reason = call(input);
      assert.match(reason, /only for the gate's own window/, JSON.stringify(input));
      assert.match(reason, /A pop-up a task page opened is part of the task: act in it, and once it closes, cua\.getApp on the browser shows the dedicated window again\./);
    }
    // The gate's own title is still the only one that passes.
    assert.equal(call({ app, title: realBrowser.marker }), null);
  }
});
