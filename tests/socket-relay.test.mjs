import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as tick } from 'node:timers/promises';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { shellRelayOptions } from '../plugins/sleight/lib/launch.mjs';
import { hostLabel } from '../plugins/sleight/lib/host-label.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { createPaymentCard } from '../plugins/sleight/lib/payment-card.mjs';

function fixture(t, { answer = 'accept', ...relayOptions } = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], panels = [], writes = [];
  for (const [stream, list] of [[serverIn, sent], [clientOut, received]]) stream.on('data', chunk => list.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  const { wording, ...options } = shellRelayOptions(async (...args) => { panels.push(args); return answer; });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: false,
    alwaysAllow: (...args) => writes.push(args), ...options, ...relayOptions });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const client = msg => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const engine = msg => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  client({ id: 0, method: 'initialize', params: { clientInfo: { name: 'Grok Bot', version: '1' }, capabilities: {} } });
  return { client, engine, sent, received, panels, writes, wording };
}
const card = (id, message, meta = {}) => ({ id, method: 'elicitation/create', params: {
  message, requestedSchema: { type: 'object', properties: {} }, _meta: meta,
} });

test('the production shell prompt accepts only the native consent channel answer', async t => {
  let shown, deliver, closed = 0;
  const panel = createPaymentCard({ open: async () => ({
    present: (id, data, choices, callback) => { shown = { data, choices }; deliver = callback; },
    authenticate: event => event.person === true,
    close: () => { closed++; },
  }) });
  t.after(() => panel.close());
  const options = shellRelayOptions(undefined, panel);
  let answered = false;
  const pending = options.ask('Allow Grok Bot to use Calculator?', true).then(value => { answered = true; return value; });
  await tick(0);
  assert.deepEqual(shown.choices, ['once', 'cancel']);
  assert.deepEqual(shown.data.operation, { request: 'Allow Grok Bot to use Calculator?', scope: 'Allow for this Grok Bot session only' });
  assert.equal(shown.data.view.scope, 'Allow for this Grok Bot session only');
  deliver({ choice: 'once', person: false }); await tick(0);
  assert.equal(answered, false);
  deliver({ choice: 'once', person: true });
  assert.equal(await pending, 'accept');
  await panel.close();
  assert.equal(closed, 1);
});

for (const message of ['Pay $268?', 'Book this trip?', 'Submit this form?', 'Save these settings?']) {
  test(`a Grok Bot engine confirmation uses sleight's panel every time: ${message}`, async t => {
    const f = fixture(t);
    for (const id of ['first', 'second']) {
      f.engine(card(id, message, { connector_id: 'computer-use', riskLevel: 'high' }));
      await tick(0);
      assert.equal(f.sent.at(-1).result.action, 'accept');
      assert.equal(f.sent.at(-1).result._meta, undefined);
    }
    assert.equal(f.panels.length, 2);
    assert.equal(f.panels[0][2].host, 'Grok Bot');
    assert.equal(f.panels[0][2].always, false);
    assert.equal(f.received.some(m => m.method === 'elicitation/create'), false);
  });
}

test('unknown connector cards also reach the panel without a host form', async t => {
  const f = fixture(t);
  f.engine(card('unknown', 'Confirm this action?'));
  await tick(0);
  assert.equal(f.panels.length, 1);
  assert.equal(f.sent.at(-1).result.action, 'accept');
});

test('an app pre-approval never answers a shell action confirmation', async t => {
  const preapproved = new PreapprovedApps({ version: 1, apps: [{ app: 'Firefox', riskLevel: 'high' }] });
  const f = fixture(t, { preapproved });
  for (const id of ['payment', 'booking', 'submit']) {
    f.engine(card(id, `Confirm ${id}?`, { connector_id: 'computer-use', persist: [], riskLevel: 'high',
      tool_params: { app: 'Firefox' } }));
    await tick(0);
    assert.equal(f.sent.at(-1).result.action, 'accept');
    assert.equal(f.sent.at(-1).result._meta, undefined);
  }
  assert.equal(f.panels.length, 3);
});

for (const grant of ['session', 'preapproved']) test(`${grant} app grant cannot answer payment or action cards with persist session`, async t => {
  const preapproved = grant === 'preapproved'
    ? new PreapprovedApps({ version: 1, apps: [{ app: 'Firefox', riskLevel: 'high' }] }) : undefined;
  const f = fixture(t, { preapproved });
  const meta = { connector_id: 'computer-use', persist: ['session'], riskLevel: 'high', tool_params: { app: 'Firefox' } };
  f.engine(card('app', 'Allow Computer Use to use "Firefox"?', meta));
  await tick(0);
  const initial = f.panels.length;
  for (const [index, message] of ['Pay $268?', 'Confirm this action?', 'Book this trip?', 'Save these settings?', 'Submit this form?'].entries()) {
    f.engine(card(`action-${index}`, message, meta));
    await tick(0);
    assert.equal(f.panels.length, initial + index + 1);
    assert.equal(f.panels.at(-1)[1], false);
    assert.equal(f.sent.at(-1).result._meta, undefined);
  }
  f.engine(card('app-again', 'Allow Computer Use to use "Firefox"?', meta));
  await tick(0);
  assert.equal(f.panels.length, initial + 5);
});

test('shell panel bounds the request while keeping the session scope visible', async t => {
  let shown;
  const panel = createPaymentCard({ open: async () => ({
    present: (id, data, choices, answer) => { shown = { data, choices }; answer({ choice: 'once' }); },
    authenticate: () => true,
  }) });
  t.after(() => panel.close());
  for (const request of ['x'.repeat(65536), '🧾'.repeat(16384)]) {
    assert.equal(await shellRelayOptions(undefined, panel).ask(request, true), 'accept');
    assert.ok(Buffer.byteLength(shown.data.operation.request) <= 2048);
    assert.match(shown.data.operation.request, /\[request truncated\]$/);
    assert.equal(shown.data.view.scope, 'Allow for this Grok Bot session only');
  }
});

test('shell panel distinguishes a declined card from an unavailable host', async () => {
  const unavailable = shellRelayOptions(undefined, { ask: async () => undefined });
  await assert.rejects(unavailable.ask('Pay?', false), error => error.code === 'SLEIGHT_PROMPT_UNAVAILABLE' && /unavailable/i.test(error.message));
  assert.equal(await shellRelayOptions(undefined, { ask: async () => 'cancel' }).ask('Pay?', false), 'cancel');
});

test('unavailable shell consent returns an explicit error to the engine', async t => {
  const options = shellRelayOptions(undefined, { ask: async () => undefined });
  const f = fixture(t, { ask: options.ask });
  f.engine(card('payment', 'Pay $268?', { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'Firefox' } }));
  await tick(0);
  assert.equal(f.sent.at(-1).error.code, -32603);
  assert.match(f.sent.at(-1).error.message, /panel unavailable; no approval was granted/);
});

test('shell consent cannot write pre-approvals even if a panel returns Always', async t => {
  const f = fixture(t, { answer: 'always' });
  f.engine(card('app', 'Allow Computer Use to use "Calculator"?', { connector_id: 'computer-use', persist: ['session', 'always'],
    riskLevel: 'low', tool_params: { app: 'Calculator' } }));
  await tick(0);
  assert.deepEqual(f.writes, []);
  assert.equal(f.sent.at(-1).result.action, 'cancel');
  assert.equal(f.panels[0][2].always, false);
});

test('app Allow has no lasting grant across shell sessions', async t => {
  for (let n = 0; n < 2; n++) {
    const f = fixture(t);
    f.engine(card('app', 'Allow Computer Use to use "Calculator"?', { connector_id: 'computer-use', persist: ['session', 'always'],
      riskLevel: 'low', tool_params: { app: 'Calculator' } }));
    await tick(0);
    assert.equal(f.panels.length, 1);
    assert.equal(f.sent.at(-1).result._meta.persist, 'session');
    assert.deepEqual(f.writes, []);
  }
});

test('the native payment guard still opens a payment card without a bound user message', async t => {
  const asked = [];
  let answer;
  const directory = mkdtempSync(join(tmpdir(), 'sleight-shell-payment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, { inputLease: new InputLease({ directory, holder: 'shell-payment-test' }),
    paymentCard: { ask: value => { asked.push(value); return new Promise(resolve => { answer = resolve; }); }, close() {} } });
  const before = readFileSync(new URL('fixtures/payment-gate/firefox-checkout-sol.txt', import.meta.url), 'utf8')
    .split('\n').filter(line => !/^\t*(?:89|9[0-7]) /.test(line)).join('\n');
  const call = (id, code) => f.client({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
  const reply = (id, text, isError = false) => f.engine({ id, result: { isError, content: [{ type: 'text', text }],
    _meta: { 'codex/toolSurface': { app: { appId: 'org.mozilla.firefox' } } } } });
  call('read', 'let app = await cua.getApp("Firefox")'); reply('read', before);
  call('pay', 'await app.click(88)');
  const sent = f.sent.find(m => m.id === 'pay');
  const setup = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(sent.params.arguments.code)[1]);
  assert.deepEqual(setup.payment, { setting: 'always', message: null, spent: null, allow: null });
  const payment = { why: 'nocopy', site: '127.0.0.1:5413', shown: '$268.00', control: 'button Pay now' };
  const error = 'sleight stopped this payment: no copy of the user message';
  reply('pay', `Error: ${error}\n${before}\n${setup.guardStopMark}${JSON.stringify({ index: 0, attempts: 1, completed: 0,
    name: 'click', shown: 'click(88)', ran: [], error, payment })}`, true);
  await tick(0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].session, 'Grok Bot');
  assert.equal(asked[0].shown, '$268.00');
  answer('cancel'); await tick(0);
  assert.equal(f.received.find(m => m.id === 'pay').result.isError, true);
});

test('shell policy preserves all engine confirmations and turbo stays unavailable', t => {
  const f = fixture(t);
  const policy = readFileSync(new URL('fixtures/engine-confirmations-policy.txt', import.meta.url), 'utf8').trimEnd();
  f.client({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(4)' } } });
  f.engine({ id: 1, result: { content: [{ type: 'text', text: '## Computer Use\nNative reference.\n\n' + policy }] } });
  assert.ok(JSON.stringify(f.received.at(-1)).includes(JSON.stringify(policy).slice(1, -1)));
  f.client({ id: 2, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } });
  assert.match(JSON.stringify(f.received.at(-1)), /Turbo is off.*Grok Bot shell has no trusted user-turn binding/);
  assert.equal(f.sent.some(msg => msg.params?.name === 'browser_tabs'), false);
  assert.equal(f.wording().claudeCode, false);
  assert.equal(hostLabel({ name: 'Grok Bot', version: '1' }), 'Grok Bot');
});
