import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { rewriteTabError } from '../plugins/sleight/lib/tab-errors.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const READ = 'await tab.getAXState({ disableDiffing: true })';
const DIALOG = 'await tab.getJsDialog()';

function reply(t, text, isError = true, code = 'await tab.click(29)', meta) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const output = [];
  clientOut.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => output.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'js', arguments: { code } } }) + '\n');
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text }], _meta: meta } }) + '\n');
  return output.at(-1).result;
}

// A read that met Debugger unattached is resent once after about a second (F12), so it answers twice before Claude sees it.
async function replyAfterResend(t, text, code) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const output = [];
  clientOut.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => output.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  await tick();
  const answer = () => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text }] } }) + '\n');
  answer(); await tick();
  t.mock.timers.tick(1100); await tick();
  if (!output.some(m => m.id === 1)) { answer(); await tick(); }
  return output.find(m => m.id === 1).result;
}

test('a covered element names the cover, says input was not sent, and points at a read', () => {
  const out = rewriteTabError('Accessibility element 29 is covered by DIV or otherwise not hittable');
  assert.equal(out.split('\n').length, 1);
  assert.match(out, /element 29 is covered by DIV/);
  assert.match(out, /sent no input/);
  assert.match(out, new RegExp(READ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a stale element says input was not sent and asks for a fresh read', () => {
  const out = rewriteTabError('Accessibility element 16 is stale or missing');
  assert.equal(out.split('\n').length, 1);
  assert.match(out, /element 16 is stale or missing/);
  assert.match(out, /sent no input/);
  assert.match(out, new RegExp(READ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a JavaScript confirm keeps the prompt and names getJsDialog', () => {
  const src = 'Browser action "click" interrupted by JavaScript confirm: Pay $268.00 now? The action may already have taken effect; do not retry it. Inspect or dismiss the dialog before continuing.';
  const out = rewriteTabError(src);
  assert.equal(out.split('\n').length, 1);
  assert.match(out, /Pay \$268\.00 now\?/);
  assert.match(out, /may already have been sent/);
  assert.match(out, /do not retry/);
  assert.match(out, new RegExp(DIALOG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a CDP mouse timeout says input may have been sent and names the dialog call', () => {
  const out = rewriteTabError('Error: Timed out after 2991ms waiting for CDP command Input.dispatchMouseEvent.');
  assert.equal(out.split('\n').length, 1);
  assert.match(out, /Input\.dispatchMouseEvent/);
  assert.match(out, /2991ms/);
  assert.match(out, /may already have landed|may already have been sent/);
  assert.match(out, new RegExp(DIALOG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, new RegExp(READ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a CDP focus timeout does not retry the same call', () => {
  const out = rewriteTabError('Timed out after 10000ms waiting for CDP command Emulation.setFocusEmulationEnabled.');
  assert.equal(out.split('\n').length, 1);
  assert.match(out, /Emulation\.setFocusEmulationEnabled/);
  assert.match(out, /10000ms/);
  assert.match(out, /do not retry/);
  assert.match(out, /Next:.*getJsDialog/);
  assert.doesNotMatch(out, /Next: await tab.getAXState/);
});

test('a CDP deadline before dispatch says input was not sent', () => {
  const out = rewriteTabError('Error: Timed out after 3000ms waiting for selector internal:role=button[name="Continue as guest"i]: CDP operation exceeded its deadline before command dispatch');
  assert.equal(out.split('\n').length, 1);
  assert.match(out, /sent no input/);
  assert.match(out, /Continue as guest/);
  assert.match(out, new RegExp(READ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('download timeouts give fresh-tab download advice without retrying a click', t => {
  for (const src of ['Timed out after 20000ms downloading media', 'Timed out after 10000ms waiting for download']) {
    const out = rewriteTabError(src);
    assert.equal(out.split('\n').length, 1);
    assert.match(out, /tab\.click.*stall.*downloads/);
    assert.match(out, /cua\.createBrowserTab/);
    assert.match(out, /downloadMedia/);
    const result = reply(t, src);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /cua\.createBrowserTab/);
  }
});

test('pre-dispatch errors describe the action and preserve selector diagnostics', () => {
  const selector = 'Error: Timed out after 3000ms waiting for selector internal:role=button[name="Continue as guest"i]: CDP operation exceeded its deadline before command dispatch';
  for (const src of ['Accessibility element 29 is covered by DIV or otherwise not hittable',
    'Accessibility element 16 is stale or missing', selector]) {
    const out = rewriteTabError(src);
    assert.match(out, /this action sent no input/);
    assert.doesNotMatch(out, /this call sent no input/);
    if (src === selector) assert.ok(out.startsWith(selector));
  }
});

test('caller output mentioning Debugger unattached survives unchanged', () => {
  for (const src of ['caller output: Debugger unattached happened earlier', 'The status was "Debugger unattached".']) {
    assert.equal(rewriteTabError(src), src);
  }
  assert.match(rewriteTabError('Error: Debugger unattached'), /Next:/);
});

test('multiline dialog advice replaces only the engine legacy warning lines', () => {
  const src = 'Browser action "click" interrupted by JavaScript confirm: Continue?\nPlan: monthly\n' +
    'The action may already have taken effect; do not retry it.\nInspect or dismiss the dialog before continuing.\ncaller output';
  const out = rewriteTabError(src);
  assert.match(out, /Next:.*getJsDialog/);
  assert.match(out, /Continue\?\nPlan: monthly[\s\S]*Next:[\s\S]*\ncaller output$/);
  assert.doesNotMatch(out, /may already have taken effect|Inspect or dismiss/);
  const own = 'The action may already have taken effect; do not retry it.';
  assert.equal(rewriteTabError(own), own);
});

test('Emulation timeouts state input was not sent and other CDP commands stay unknown', () => {
  const out = rewriteTabError('Timed out after 10000ms waiting for CDP command Emulation.setFocusEmulationEnabled.');
  assert.match(out, /this command sent no input/);
  const unknown = rewriteTabError('Timed out after 10000ms waiting for CDP command Page.navigate.');
  assert.match(unknown, /input.*unknown|unknown.*input/);
});

test('Debugger unattached after a docs dump keeps the docs and names re-binding', () => {
  const src = '# API Reference\n```\ninterface X {}\n```\n\nDebugger unattached';
  const out = rewriteTabError(src);
  assert.ok(out.startsWith('# API Reference\n```\ninterface X {}\n```\n\n'));
  assert.match(out, /Debugger unattached/);
  assert.match(out, /may already have been sent/);
  assert.match(out, /cua\.getTab\(id, \{ browser \}\)/);
});

test('recorded CDP suffix lines survive a timeout rewrite', () => {
  const suffix = '\nwaiting on click for selector internal:role=button[name="Pay now"i]\nfalse';
  const out = rewriteTabError('Error: Timed out after 2991ms waiting for CDP command Input.dispatchMouseEvent.' + suffix);
  assert.match(out, /^CDP command Input\.dispatchMouseEvent timed out after 2991ms/);
  assert.ok(out.endsWith(suffix));
  assert.match(out, /the input may already have been sent/);
  assert.doesNotMatch(out, /the click may already have landed/);
});

test('recorded docs and const warnings following Debugger unattached stay intact', () => {
  for (const suffix of ['\n## Computer Use\n\nControl native apps and browsers on the user’s computer by reading or operating UI.',
    '\nWarning: b was declared with const; use let for reassignable variables.']) {
    for (const prefix of ['', 'Error: ']) {
      const out = rewriteTabError(prefix + 'Debugger unattached' + suffix);
      assert.match(out, /Next:.*cua\.getTab/);
      assert.ok(out.endsWith(suffix));
    }
  }
});

test('read and binding failures say no input was sent, while mixed calls stay uncertain', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const code of ['await tab.getAXState()', 'let tab = await cua.getTab("1", { browser: "2" })',
    'tab = await cua.getTab(id, { browser: browser.browserId })', 'await cua.getTab(id, { browser })']) {
    const out = (await replyAfterResend(t, 'Debugger unattached', code)).content[0].text;
    assert.match(out, /no input was sent/);
    assert.doesNotMatch(out, /may already have been sent/);
    assert.match(out, /cua\.getTab/);
  }
  const out = reply(t, 'Debugger unattached', true, 'await tab.click(1); await tab.getAXState()').content[0].text;
  assert.match(out, /input may already have been sent/);
  const unknown = reply(t, 'Debugger unattached', true, 'await cua.getTab(await tab.click(1), { browser })').content[0].text;
  assert.match(unknown, /input may already have been sent/);
});

test('download advice is conditional and supplies required options', () => {
  const out = rewriteTabError('Timed out after 20000ms downloading media');
  assert.match(out, /if a tab\.click on the link came earlier/i);
  assert.match(out, /downloadMedia\(\{\}\)/);
});

test('dialog advice guards absence and uses the methods supported by each dialog type', () => {
  for (const kind of ['confirm', 'alert', 'prompt', 'beforeunload']) {
    const out = rewriteTabError(`Browser action "click" interrupted by JavaScript ${kind}: Continue?`);
    assert.match(out, /if \(dialog\)/);
    assert.match(out, /dialog\.dismiss\(\)/);
    if (kind === 'prompt') assert.match(out, /dialog\.accept\(text\)/);
    else if (kind === 'confirm') assert.match(out, /dialog\.accept\(\)/);
    else assert.doesNotMatch(out, /\.accept\(/);
  }
});

test('caller output mentioning a CDP deadline is not rewritten', () => {
  const src = 'caller output: CDP operation exceeded its deadline earlier';
  assert.equal(rewriteTabError(src), src);
});

test('recorded evaluate TypeErrors retain their stack and explain the page scope', t => {
  for (const value of ['null', 'undefined']) {
    const src = `TypeError: Cannot read properties of ${value} (reading 'value')\n    at __playwrightEvaluate (<anonymous>:2686:54)\n    at runUserScript (<anonymous>:2688:10)`;
    const out = reply(t, src, true, 'await tab.playwright.evaluate(() => reference.value)').content[0].text;
    assert.ok(out.includes(src));
    assert.match(out, /page scope is read-only/);
    assert.match(out, /element ids are not globals/);
    assert.match(out, /document\.querySelector.*null/);
  }
  const own = "TypeError: Cannot read properties of null (reading 'value')\n    at ownFunction";
  assert.equal(rewriteTabError(own), own);
});

test('covered, stale and page-dialog errors preserve surrounding result lines', () => {
  for (const error of ['Accessibility element 29 is covered by DIV or otherwise not hittable',
    'Accessibility element 16 is stale or missing', ...['confirm', 'alert', 'prompt'].map(kind =>
      `Browser action "click" interrupted by JavaScript ${kind}: Continue? The action may already have taken effect; do not retry it.`)]) {
    const out = rewriteTabError('Tab: 1\ncaller output\n' + error + '\nafter output');
    assert.ok(out.startsWith('Tab: 1\ncaller output\n'));
    assert.ok(out.endsWith('\nafter output'));
    assert.match(out, /Next:/);
    if (/JavaScript/.test(error)) assert.match(out, /getJsDialog/);
  }
});

test('native calls and native observations do not get tab recovery advice', t => {
  const src = 'Accessibility element 16 is stale or missing';
  assert.equal(reply(t, src, true, 'await app.click(16)').content[0].text, src);
  const observed = reply(t, src, true, 'await unknown.getAXState()', { 'codex/toolSurface': { app: { appId: 'example.editor' } } });
  assert.equal(observed.content[0].text, src);
});

test('unmatched engine text is returned unchanged', () => {
  const src = 'noWindowsAvailable';
  assert.equal(rewriteTabError(src), src);
  assert.equal(rewriteTabError('Browser Use rejected this action due to browser security policy.'),
    'Browser Use rejected this action due to browser security policy.');
});

test('the relay rewrites a covered-element error and leaves a success containing the same words alone', t => {
  const covered = reply(t, 'Accessibility element 29 is covered by DIV or otherwise not hittable');
  assert.equal(covered.isError, true);
  assert.equal(covered.content[0].text.split('\n').length, 1);
  assert.match(covered.content[0].text, /covered by DIV/);
  assert.match(covered.content[0].text, /sent no input/);
  const skill = 'If a tab is stale or missing later, obtain or create a fresh tab from this browser.';
  const ok = reply(t, skill, false);
  assert.equal(ok.isError, false);
  assert.equal(ok.content[0].text, skill);
});

test('the relay rewrites confirm, CDP, stale, and debugger errors', t => {
  const confirm = reply(t, 'Browser action "click" interrupted by JavaScript confirm: Pay $268.00 now? The action may already have taken effect; do not retry it. Inspect or dismiss the dialog before continuing.');
  assert.match(confirm.content[0].text, /getJsDialog/);
  const cdp = reply(t, 'Timed out after 10000ms waiting for CDP command Emulation.setFocusEmulationEnabled.');
  assert.match(cdp.content[0].text, /Emulation\.setFocusEmulationEnabled/);
  const stale = reply(t, 'Accessibility element 17 is stale or missing');
  assert.match(stale.content[0].text, /element 17 is stale or missing/);
  const detached = reply(t, 'Debugger unattached');
  assert.match(detached.content[0].text, /Debugger unattached/);
  assert.equal(detached.content[0].text.split('\n').length, 1);
});
