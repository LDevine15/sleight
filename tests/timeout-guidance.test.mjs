import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { rewriteTabError } from '../plugins/sleight/lib/tab-errors.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const cdp = 'Error: Timed out after 2991ms waiting for CDP command Input.dispatchMouseEvent.';
const reset = 'js execution timed out; kernel reset, rerun your request';

test('a CDP timeout reports operation, deadline and unknown input before suggesting dialog inspection', () => {
  const out = rewriteTabError(cdp);
  assert.match(out, /Input.dispatchMouseEvent.*2991ms/);
  assert.match(out, /input may already have been sent/);
  assert.match(out, /dialog is not confirmed/);
  assert.match(out, /getJsDialog\(\)/);
  assert.match(out, /Read the page before retrying input/);
  assert.doesNotMatch(out, /\.dismiss\(|\.accept\(/);
});

test('a confirmed interruption retains the actual dialog type and supported response choices', () => {
  const out = rewriteTabError('Browser action "click" interrupted by JavaScript confirm: Continue?');
  assert.match(out, /interrupted by JavaScript confirm: Continue\?/);
  assert.match(out, /dialog.accept\(\).*dialog.dismiss\(\)/);
  assert.doesNotMatch(out, /dialog is not confirmed/);
});

test('a bare CDP deadline cannot claim no input was sent', () => {
  const raw = 'Error: CDP operation exceeded its deadline';
  const out = rewriteTabError(raw);
  assert.ok(out.startsWith(raw));
  assert.match(out, /input outcome is unknown/);
  assert.match(out, /duration not reported/);
  assert.doesNotMatch(out, /sent no input/);
});

test('an explicitly pre-dispatch deadline retains its stronger evidence', () => {
  const raw = 'Error: Timed out after 3000ms waiting for selector button: CDP operation exceeded its deadline before command dispatch';
  assert.match(rewriteTabError(raw), /this action sent no input/);
});

test('a reported kernel reset names handle recovery and never advises replaying unknown input', () => {
  const out = rewriteTabError(reset);
  assert.ok(out.startsWith(reset));
  assert.match(out, /JavaScript execution.*duration not reported/);
  assert.match(out, /input outcome is unknown/);
  assert.match(out, /Do not rerun the failed action/);
  assert.match(out, /cua.listTabs\(\).*cua.getTab/);
  const timed = rewriteTabError('js execution timed out after 30000ms; kernel reset');
  assert.match(timed, /JavaScript execution timed out after 30000ms/);
  assert.doesNotMatch(timed, /duration not reported/);
});

test('timeout, confirmed dialog and reset replies never cause an automatic input retry', t => {
  for (const text of [cdp, reset, 'Browser action "click" interrupted by JavaScript confirm: Continue?']) {
    const streams = Array.from({length: 4}, () => new PassThrough());
    const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
    serverIn.on('data', data => sent.push(JSON.parse(data.toString())));
    clientOut.on('data', data => replies.push(JSON.parse(data.toString())));
    const relay = createRelay({clientIn, clientOut, serverIn, serverOut, changeReview: false});
    t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
    clientIn.write(JSON.stringify({id: 1, method: 'tools/call', params: {name: 'js', arguments: {code: 'await tab.click(1)'}}}) + '\n');
    serverOut.write(JSON.stringify({id: 1, result: {isError: true, content: [{type: 'text', text}]}}) + '\n');
    assert.equal(sent.length, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].result.isError, true);
  }
});

test('caller prose mentioning a reset is unchanged', () => {
  for (const raw of ['caller output: ' + reset, 'caller output\n' + reset + '\nTypeError: unrelated']) {
    assert.equal(rewriteTabError(raw), raw);
  }
});
