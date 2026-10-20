// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
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
import { guardReason } from '../bench/codex-sleight-proxy.mjs';
import { enginePayment, namedAmount } from '../plugins/sleight/lib/payment-gate.mjs';

const demoid = { name: 'demoid', browser: 'safari', needsClicks: true, result: 'the name the shop shows after signing in',
  prompt: 'sign in to the demo shop at http://127.0.0.1:5420/t/demoid/shop/account in {browser} with DemoID and tell me the name it shows' };
const browsers = {
  safari: { browser: 'safari', profileRoot: '/tmp/profile', profileName: 'sleight benchmark', pid: 98302,
    executable: '/Applications/Safari.app/Contents/MacOS/Safari', marker: 'Sleight Gate c128a239-6d67-476f-b031-699b7b71dba6' },
  firefox: { browser: 'firefox', profileRoot: '/tmp/profile', pid: 13679,
    executable: '/Applications/Firefox.app/Contents/MacOS/firefox', marker: 'Sleight Gate 0faae6c1-c954-41c1-9dba-fd4cf0ca5189' },
};
const POPUP = /except a pop-up window of that same browser and profile, opened by a page in that window as a result of a step the task asked for \(a sign-in window, say\)\./;
const WAY_BACK = /A pop-up that a task page opened in this browser and profile, as a result of a step the task asked for, may be used; once it closes, cua\.getApp on the browser shows the dedicated window again\./;

test('every arm on Safari and Firefox is told a pop-up its page opens belongs to the task, and nothing wider', () => {
  for (const [name, realBrowser] of Object.entries(browsers)) {
    const prompt = windowPrompt(realBrowser);
    assert.match(prompt, POPUP, name);
    assert.match(prompt, /Once that pop-up closes, the dedicated window is the browser's window again\./, name);
    // The exception never reaches another browser, profile, app or a window that was open before the task (review: no
    // blanket "act in it", and an external-protocol handler or an ad pop-up the task never asked for doesn't qualify).
    assert.match(prompt, /never use any other browser window or profile, except a pop-up window/, name);
    assert.match(prompt, /Never act in a window that was already open, another profile, another browser, or another app\./, name);
    assert.doesNotMatch(prompt, /act in it/, name);
    assert.match(prompt, /If the dedicated window cannot be identified, stop\./, name);
    for (const surface of ['sleight', 'codex-sleight', 'codex-sleight-sol', 'codex', 'codex-sol']) {
      const setup = realAgentSetup({ task: { ...demoid, browser: name }, surface, dir: `${MAC_TMP}/gate-task`, realBrowser, dryRun: true });
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
      assert.match(reason, WAY_BACK);
    }
    // The gate's own title is still the only one that passes.
    assert.equal(call({ app, title: realBrowser.marker }), null);
  }
});

test('with no gate window set, select_window is refused without the pop-up sentence or "(none)" placeholders', () => {
  for (const env of [{}, { FOWL_GATE_WINDOW: 'not json' }, { FOWL_GATE_WINDOW: JSON.stringify({ apps: ['Safari'], title: 'Mozilla Firefox' }) }]) {
    const reason = gateWindowCheck({ tool_name: 'select_window', tool_input: { app: 'Safari', title: 'sleight benchmark — Sign in · Tidewell Demo Shop' } }, env);
    assert.equal(reason, "Benchmark: select_window is allowed only for the gate's own window, and this round has no gate window.");
  }
});

test('the Codex proxy refuses the race input with the same way-back reason', async () => {
  const env = { FOWL_GATE_WINDOW: JSON.stringify({ apps: ['Safari'], title: browsers.safari.marker }) };
  const input = { app: 'Safari', title: 'sleight benchmark — Sign in · Tidewell Demo Shop', windowNumber: 305953 };
  const reason = await guardReason('select_window', input, { gateWindow: true, env });
  assert.match(reason, /only for the gate's own window/);
  assert.match(reason, WAY_BACK);
  assert.equal(await guardReason('select_window', { app: 'Safari', title: browsers.safari.marker }, { gateWindow: true, env }), undefined);
  assert.equal(await guardReason('select_window', input, { gateWindow: false, env }), undefined, 'arms without the gate are untouched');
});

// The payment gate reads the tree of the window the action acts on, so a pop-up window gets the same check as the page
// (review item 5: the gate is per tree, not tied to the window the task started in).
test('a card form inside a pop-up window still stops the pay click', () => {
  const popup = [
    'Window: "sleight benchmark — Pay with DemoPay", App: Safari.',
    '0 standard window sleight benchmark — Pay with DemoPay, ID: SafariWindow?IsSecure=false&UUID=84299AA6-0000-4000-8000-000000000001, Secondary Actions: Raise',
    '\t1 split group',
    '\t\t2 tab group',
    '\t\t\t3 scroll area',
    '\t\t\t\t4 HTML content Description: Pay with DemoPay, URL: 127.0.0.1:5421/t/demoid/pay',
    '\t\t\t\t\t5 container',
    '\t\t\t\t\t\t6 text Order total $268.00',
    '\t\t\t\t\t\t7 text field Description: Card number, ID: cc-number',
    '\t\t\t\t\t\t8 text field Description: CVC, ID: cc-csc',
    '\t\t\t\t\t\t9 button Place order',
    '\t10 text Description: smart search field, Value: 127.0.0.1:5421/t/demoid/pay, ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD',
    '\t11 close button',
    'The focused UI element is 4 HTML content Description: Pay with DemoPay, URL: 127.0.0.1:5421/t/demoid/pay',
  ].join('\n');
  const gate = text => ({ setting: 'requested', message: text === null ? null : { ...namedAmount(text), afterAsk: false }, spent: null, allow: null, now: 1_000_000 });
  const stop = enginePayment('click', [9], popup, gate(null));
  assert.equal(stop?.why, 'nocopy');
  assert.equal(stop.control, 'button Place order');
  assert.equal(enginePayment('click', [9], popup, gate(demoid.prompt))?.why, 'none', 'a sign-in request names no amount');
});
