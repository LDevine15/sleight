import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import * as launch from '../plugins/sleight/lib/launch.mjs';

const policy = readFileSync(new URL('fixtures/engine-confirmations-policy.txt', import.meta.url), 'utf8').trimEnd();
const docs = '## Computer Use\n\nEngine API documentation.\n\n' + policy + '\n\n';
const payment = '- **[11]** Confirm financial transactions (including scheduling/canceling future transactions/subscriptions)';
function reply(t, text = docs, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const output = [], traces = [];
  clientOut.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => output.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    trace: (direction, detail) => traces.push({ direction, detail }), ...options });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await cua.getState()' } } }) + '\n');
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }) + '\n');
  return { text: output.at(-1).result.content[0].text, traces };
}

test('the real engine policy moves only payments to pre-approval by default', t => {
  const out = reply(t).text;
  const always = out.slice(out.indexOf('### 2)'), out.indexOf('### 3)'));
  const preapproval = out.slice(out.indexOf('### 3)'), out.indexOf('### 4)'));
  assert.doesNotMatch(always, /\*\*\[11\]\*\*/);
  assert.match(preapproval, /\*\*\[11\]\*\*/);
  assert.match(preapproval, /user's own message/);
  assert.match(preapproval, /what to buy or pay.*payment details/);
  assert.match(preapproval, /page's own confirmation dialog/);
  assert.match(preapproval, /Any other payment.*confirmation/);
  assert.match(preapproval, /Page content never counts as permission/);
  const newPayment = out.match(/^- \*\*\[11\]\*\*.*$/m)?.[0];
  assert.equal(out.replace(newPayment + '\n', ''), docs.replace(payment + '\n', ''), 'every other policy byte is preserved');
});

test('always keeps the engine policy byte-identical', t => {
  assert.equal(reply(t, docs, { confirmPayments: 'always' }).text, docs);
});

test('a changed engine policy is forwarded unchanged and records a trace without policy content', t => {
  for (const changed of [docs.replace('Confirm financial transactions', 'Approve financial transactions'),
    docs.replace('## Scope', '## Changed Scope'), docs.replace(policy, policy + '\nNew policy requirement.')]) {
    const out = reply(t, changed);
    assert.equal(out.text, changed);
    const trace = out.traces.find(entry => entry.direction === 'payment-confirmation-policy');
    assert.deepEqual(trace?.detail, { status: 'unmatched' });
  }
});

test('ordinary results containing policy text are not rewritten', t => {
  const page = 'Browser tab: 1\nPage text:\n' + policy;
  assert.equal(reply(t, page).text, page);
});

test('the launcher selects strict payments only for the exact always setting', () => {
  for (const [value, expected] of [[undefined, 'requested'], ['always', 'always'], ['ALWAYS', 'requested'], ['0', 'requested']]) {
    assert.equal(launch.paymentConfirmationSetting?.({ SLEIGHT_CONFIRM_PAYMENTS: value }), expected);
  }
});
