import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrowserTools, browserTools, validateCall } from '../tools.mjs';
import { BrowserFailure } from '../errors.mjs';
import { measureShapes, TOKENIZER } from '../measure-shapes.mjs';

const call = (name, args) => ({ name, arguments: args });
const click = call('browser_act', { tab: 't1', op: 'click', ref: 'r7' });
const fixture = JSON.parse(readFileSync(new URL('../fixtures/transcripts/failures.json', import.meta.url)));
function harness({ failAt, deniedAt, result, failure, redact } = {}) {
  const sent = [], checked = [];
  // Deliberately closed CDP-session fake, with no browser or engine dependency.
  const session = new Proxy({ sessionId: 'fixture-session', send: async (...args) => { sent.push(args); },
    on() {}, off() {} }, { get(target, key) {
    if (key in target || typeof key === 'symbol' || key === 'then') return target[key];
    throw new Error('unsupported CDP-session member: ' + key);
  } });
  const operation = async (args, context) => {
    assert.equal(context.session, session);
    await context.session.send('Fixture.operation', args);
    if (sent.length === failAt) throw failure ?? new Error('private adapter failure');
    return result ?? { effect: 'verified', observation: { text: 'fixture state', untrusted: true } };
  };
  const tools = createBrowserTools({ session,
    operations: { open: operation, read: operation, act: operation, fill: operation },
    authorize: async (name, args) => { checked.push([name, args]); return checked.length !== deniedAt; },
    redact: redact ?? (value => value) });
  return { tools, sent, checked };
}
test('only four routine tools load; advanced capabilities are explicitly discovered', () => {
  assert.deepEqual(browserTools().map(t => t.name), ['browser_open', 'browser_read', 'browser_act', 'browser_fill']);
  for (const tool of browserTools()) assert.equal(tool.inputSchema.additionalProperties, false);
  const h = harness();
  assert.deepEqual(h.tools.discover(), []);
  assert.equal(browserTools().some(t => /javascript|evaluate/i.test(t.name)), false);
});
test('single action and read preserve small explicit handles', () => {
  assert.deepEqual(validateCall(click), click);
  assert.deepEqual(validateCall(call('browser_read', { tab: 't1', scope: 'r2' })), call('browser_read', { tab: 't1', scope: 'r2' }));
});
test('all discriminated actions validate without a competing JavaScript entry point', () => {
  for (const action of [{ op: 'click', ref: 'r1' }, { op: 'hover', ref: 'r1' },
    { op: 'key', ref: 'r1', key: 'Enter' }, { op: 'select', ref: 'r1', value: ['A', 'B'] },
    { op: 'scroll', ref: 'r1', dy: 100 }, { op: 'drag', ref: 'r1', to: 'r2' },
    { op: 'wait', ref: 'r1', state: 'visible' }, { op: 'dialog', dialog: 'd1', action: 'dismiss' }])
    assert.deepEqual(validateCall(call('browser_act', { tab: 't1', ...action })), call('browser_act', { tab: 't1', ...action }));
});
test('fill accepts exact typed intent, including empty multi-select, dates and file capabilities', () => {
  const values = ['Ada', false, 2.5, ['A', 'B'], [], { date: '2026-10-13' }, { files: ['f1'] }];
  const request = call('browser_fill', { tab: 't1', fields: values.map((value, i) => ({ ref: 'r' + i, value })) });
  assert.deepEqual(validateCall(request), request);
});
for (const [label, request] of Object.entries({
  'missing ref': call('browser_act', { tab: 't1', op: 'click' }),
  'guessed selector': call('browser_act', { tab: 't1', op: 'click', selector: '#pay' }),
  'invented API': call('browser_act', { tab: 't1', op: 'evaluate', code: 'pay()' }),
  'unawaited program': call('js', { code: 'tab.click(7);' }),
  'ambiguous value': call('browser_fill', { tab: 't1', fields: [{ ref: 'r1', value: { checked: 'yes' } }] }),
  'mixed shortcut and steps': call('browser_act', { tab: 't1', op: 'click', ref: 'r1', steps: [{ op: 'click', ref: 'r2' }] }),
  'unobserved numeric ref': call('browser_act', { tab: 't1', op: 'click', ref: 7 }),
  'unbounded batch': call('browser_act', { tab: 't1', steps: Array.from({ length: 17 }, () => ({ op: 'click', ref: 'r1' })) }),
  'duplicate field': call('browser_fill', { tab: 't1', fields: [{ ref: 'r1', value: true }, { ref: 'r1', value: false }] }),
  'bad date': call('browser_fill', { tab: 't1', fields: [{ ref: 'r1', value: { date: '2026-02-30' } }] }),
  'plain file path': call('browser_fill', { tab: 't1', fields: [{ ref: 'r1', value: { files: ['/tmp/file'] } }] }),
  'implicit submit': call('browser_fill', { tab: 't1', fields: [{ ref: 'r1', value: 'Ada' }], submit: true }),
  'model approval': call('browser_act', { tab: 't1', op: 'click', ref: 'r1', approved: true }),
  'internal scheme': call('browser_open', { browser: 'b1', url: 'file:///tmp/data' }),
  'nonfinite number': call('browser_fill', { tab: 't1', fields: [{ ref: 'r1', value: NaN }] }),
})) test('rejects ' + label + ' before policy or dispatch', async () => {
  const h = harness(); const response = await h.tools.call(request);
  assert.equal(response.error.code, 'INVALID_ARGUMENT'); assert.equal(response.error.effect, 'none');
  assert.equal(h.sent.length, 0); assert.equal(h.checked.length, 0);
});
test('validation does not execute accessors or accept inherited intent', () => {
  let getters = 0;
  const args = { tab: 't1', op: 'click' };
  Object.defineProperty(args, 'ref', { enumerable: true, get() { getters++; return 'r1'; } });
  assert.throws(() => validateCall(call('browser_act', args)), /INVALID_ARGUMENT/);
  assert.equal(getters, 0);
  assert.throws(() => validateCall(call('browser_act', Object.create({ tab: 't1', op: 'click', ref: 'r1' }))), /INVALID_ARGUMENT/);
});
test('automatic proof is required; a missing receipt after dispatch is unknown', async () => {
  const h = harness({ result: {} }); const response = await h.tools.call(click);
  assert.equal(response.error.code, 'EFFECT_UNKNOWN'); assert.equal(response.error.effect, 'unknown');
  assert.equal(h.sent.length, 1);
});
test('trusted per-step authorization stops before the first unapproved action', async () => {
  const h = harness({ deniedAt: 2 });
  const response = await h.tools.call(call('browser_act', { tab: 't1', steps: [
    { op: 'click', ref: 'r1' }, { op: 'click', ref: 'r2' }, { op: 'click', ref: 'r3' }] }));
  assert.equal(response.error.code, 'PERMISSION_REQUIRED'); assert.equal(response.error.completed, 1);
  assert.equal(response.error.effect, 'none'); assert.equal(h.sent.length, 1);
});
test('a form stops at unknown input and never submits, rolls back or replays its suffix', async () => {
  const h = harness({ failAt: 2 });
  const response = await h.tools.call(call('browser_fill', { tab: 't1', fields: [
    { ref: 'r1', value: 'Ada' }, { ref: 'r2', value: true }, { ref: 'r3', value: ['A'] }] }));
  assert.equal(response.error.completed, 1); assert.equal(response.error.effect, 'unknown');
  assert.equal(response.untouched, 1); assert.equal(h.sent.length, 2);
  assert.doesNotMatch(JSON.stringify(response), /private adapter failure/);
});
test('protected proof is a completed field and never causes a refill', async () => {
  const h = harness({ result: { effect: 'protected', observation: { text: 'value protected', untrusted: true } } });
  const response = await h.tools.call(call('browser_fill', { tab: 't1', fields: [{ ref: 'r1', value: 'secret' }] }));
  assert.equal(response.completed, 1); assert.equal(response.results[0].effect, 'protected');
  assert.equal(h.sent.length, 1); assert.doesNotMatch(JSON.stringify(response), /secret/);
});
test('redaction runs before observation serialization; its failure cannot leak adapter output', async () => {
  const h = harness({ result: { effect: 'verified', observation: { text: 'secret' } },
    redact: observation => ({ ...observation, text: '[protected]' }) });
  assert.doesNotMatch(JSON.stringify(await h.tools.call(click)), /secret/);
  const failed = harness({ redact: () => { throw Error('secret'); } });
  const response = await failed.tools.call(click);
  assert.equal(response.error.code, 'EFFECT_UNKNOWN'); assert.doesNotMatch(JSON.stringify(response), /secret/);
});
test('policy errors are not approvals and no default grant exists', async () => {
  assert.throws(() => createBrowserTools({ session: { sessionId: 's1', send() {}, on() {}, off() {} }, operations: {} }), /trusted/);
  const h = harness({ deniedAt: 1 }); const response = await h.tools.call(click);
  assert.equal(response.error.next.kind, 'user'); assert.equal(h.sent.length, 0);
});
test('policy cannot mutate the frozen validated intent', async () => {
  const session = { sessionId: 's1', send() {}, on() {}, off() {} };
  let dispatched = 0;
  const tools = createBrowserTools({ session, operations: { act: async () => { dispatched++; } },
    authorize: async (name, args) => { args.ref = 'r99'; return true; }, redact: x => x });
  const response = await tools.call(click);
  assert.equal(response.error.code, 'PERMISSION_REQUIRED'); assert.equal(dispatched, 0);
});
for (const sample of fixture) test('saved failure-class regression: ' + sample.id, async () => {
  const h = harness({ failAt: 1, failure: new BrowserFailure(sample.code, { effect: sample.effect, observation: sample.observation }) });
  const response = await h.tools.call(click), error = response.error;
  assert.equal(error.code, sample.code); assert.equal(error.effect, sample.effect);
  assert.equal(h.sent.length, 1, 'no automatic retry');
  if (error.next.tool) assert.doesNotThrow(() => validateCall(call(error.next.tool, error.next.arguments)));
  assert.doesNotMatch(JSON.stringify(error), /selector|evaluate|js_reset/);
});
test('connection refusals use trusted user recovery, never a weaker transport or native JS', async () => {
  for (const code of ['SETTING_OFF', 'CONNECTION_APPROVAL_PENDING', 'CONNECTION_DECLINED', 'STALE_INSTANCE', 'DISCONNECTED']) {
    const h = harness({ failAt: 1, failure: new BrowserFailure(code, { effect: 'none' }) });
    const response = await h.tools.call(click);
    assert.equal(response.error.next.kind, 'user'); assert.equal(h.sent.length, 1);
  }
});
test('unverifiable state ends an observed batch without blind input to the suffix', async () => {
  const h = harness({ result: { effect: 'unverifiable', observation: { text: 'state unknown' } } });
  const response = await h.tools.call(call('browser_act', { tab: 't1', steps: [
    { op: 'click', ref: 'r1' }, { op: 'click', ref: 'r2' }] }));
  assert.equal(response.error.code, 'STATE_UNVERIFIABLE'); assert.equal(response.error.completed, 0);
  assert.equal(response.untouched, 1); assert.equal(h.sent.length, 1);
});
test('late caller mutation cannot change the policy-approved operation', async () => {
  const h = harness(); const request = structuredClone(click);
  const pending = h.tools.call(request); request.arguments.ref = 'r99';
  await pending; assert.equal(h.sent[0][1].ref, 'r7');
});
test('open returns the explicit tab; a malformed post-dispatch handle stays unknown', async () => {
  const request = call('browser_open', { browser: 'b1', url: 'https://example.test' });
  const h = harness({ result: { effect: 'verified', tab: 't2', observation: {} } });
  assert.equal((await h.tools.call(request)).results[0].tab, 't2');
  const bad = harness({ result: { effect: 'verified', tab: 'foreign', observation: {} } });
  const response = await bad.tools.call(request);
  assert.equal(response.error.code, 'EFFECT_UNKNOWN'); assert.equal(response.error.effect, 'unknown');
});
test('the whole UTF-8 envelope stays bounded without losing completed proof counts', async () => {
  const h = harness({ result: { effect: 'verified', observation: { text: '🙂'.repeat(1500) } } });
  const response = await h.tools.call(call('browser_fill', { tab: 't1', fields: Array.from({ length: 50 }, (_, i) => ({ ref: 'r' + i, value: 'x' })) }));
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 12000);
  assert.equal(response.completed, 50); assert.equal(response.results.length, 50);
  assert.equal(response.observation.omitted, true);
});
test('error observations are bounded and raw error details remain private', async () => {
  const h = harness({ failAt: 1, failure: new BrowserFailure('DIALOG_OPEN', { observation: { text: 'x'.repeat(20000) } }) });
  const response = await h.tools.call(click);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 12000);
  assert.equal(response.error.observation.omitted, true);
});
test('shape measurements include the full exchange, schema and recovery overhead with named proxies', () => {
  const result = measureShapes();
  assert.equal(result.tokenizer, TOKENIZER); assert.match(result.tokenizer, /proxy/);
  assert.ok(result.schema.bytes > 0); assert.equal(result.rows.length, 3);
  for (const row of result.rows) {
    assert.ok(row.exchange.bytes > row.call.bytes); assert.ok(row.exchange.bytes > row.response.bytes);
    assert.ok(row.extra_recovery_read.bytes > 0); assert.equal(row.actual_model_tokens, null);
    assert.equal(row.thinking_tokens, null);
  }
  assert.equal(result.historical_projection_is_measured_saving, false);
});
test('a changed CDP session is fenced before dispatch and uncertain after dispatch', async () => {
  for (const during of ['policy', 'dispatch']) {
    const session = { sessionId: 's1', send() {}, on() {}, off() {} };
    let calls = 0;
    const tools = createBrowserTools({ session, redact: x => x,
      authorize: async () => { if (during === 'policy') session.sessionId = 's2'; return true; },
      operations: { act: async () => { calls++; session.sessionId = 's2'; return { effect: 'verified', observation: {} }; } } });
    const response = await tools.call(click);
    assert.equal(response.error.code, 'LEASE_LOST');
    assert.equal(response.error.effect, during === 'policy' ? 'none' : 'unknown');
    assert.equal(calls, during === 'policy' ? 0 : 1);
  }
});
test('long valid intent is preserved even when it exceeds the model token target', async () => {
  const value = 'word '.repeat(10000);
  const h = harness();
  const response = await h.tools.call(call('browser_fill', { tab: 't1', fields: [{ ref: 'r1', value }] }));
  assert.equal(response.completed, 1); assert.equal(h.sent[0][1].value, value);
});
