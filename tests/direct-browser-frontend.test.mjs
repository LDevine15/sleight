import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontend, isFrontend } from '../plugins/sleight/lib/direct-browser/surface.mjs';

const click = { name: 'browser_act', arguments: { tab: 't1', op: 'click', ref: 'r1' } };
const read = { name: 'browser_read', arguments: { tab: 't1' } };
const good = (count = 1) => ({ phase: 'verified', effect: 'verified', completed: count,
  results: Array.from({ length: count }, () => ({ effect: 'verified', observation: { complete: true } })),
  observation: { complete: true }, untouched: 0 });
async function fixture(options = {}) {
  const proof = Object.freeze({}), calls = [], ended = [];
  let state = 'connected', current = true;
  const client = new Proxy({ async request(frame) { calls.push(frame); return options.reply?.(frame) ?? good(); } },
    { get(target, key) { if (key in target || typeof key === 'symbol' || key === 'then') return target[key]; throw Error('unsupported broker client method ' + key); } });
  const frontend = await createFrontend({ proof, verifyOptIn: token => token === proof,
    packageCurrent: () => current, status: () => state, client,
    redact: value => value, endSession: async () => { ended.push('end'); return { revoked: true, cleanup: [] }; },
    ...options });
  return { frontend, calls, ended, state: value => { state = value; }, update: () => { current = false; } };
}
test('no model flag can opt into the trusted frontend', async () => {
  await assert.rejects(createFrontend({ proof: { approved: true } }), /TRUSTED_ROUTE_REQUIRED/);
  assert.equal(isFrontend({ tools() {}, call() {} }), false);
});
test('four tools use the broker request interface and return the session tab', async () => {
  const f = await fixture({ reply: frame => ({ ...good(frame.operation === 'browser_fill' ? 2 : 1),
    ...(frame.operation === 'browser_open' ? { tab: 't1' } : {}) }) });
  assert.equal(isFrontend(f.frontend), true);
  assert.deepEqual(f.frontend.tools().map(t => t.name), ['browser_open', 'browser_read', 'browser_act', 'browser_fill']);
  const opened = await f.frontend.call({ name: 'browser_open', arguments: { browser: 'b1', url: 'https://example.test' } });
  assert.equal(opened.results[0].tab, 't1');
  await f.frontend.call(read); await f.frontend.call(click);
  const filled = await f.frontend.call({ name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'r1', value: 'x' }, { ref: 'r2', value: true }] } });
  assert.equal(filled.receipt.completed, 2);
  assert.equal(f.calls.length, 4, 'whole form is one logical broker operation');
  assert.equal(f.calls[3].args.fields.length, 2);
  assert.equal(new Set(f.calls.map(c => c.id)).size, 4);
});
for (const [state, code] of Object.entries({ unsupported: 'CONNECTION_UNSUPPORTED', 'setting-off': 'SETTING_OFF',
  'approval-pending': 'CONNECTION_APPROVAL_PENDING', declined: 'CONNECTION_DECLINED',
  'stale-instance': 'STALE_INSTANCE', disconnected: 'DISCONNECTED', paused: 'USER_TAKEOVER' })) {
  test('state ' + state + ' never queues input or invokes fallback', async () => {
    const f = await fixture(); f.state(state);
    assert.equal((await f.frontend.call(click)).error.code, code);
    assert.equal(f.calls.length, 0);
    f.state('connected'); await f.frontend.call(read);
    assert.equal(f.calls.length, 1);
  });
}
test('unknown input requires a later complete delivered read and retains the old receipt', async () => {
  let mode = 'unknown';
  const f = await fixture({ reply: () => mode === 'unknown' ? { phase: 'unknown', effect: 'unknown', completed: 0,
    untouched: 0, error: { code: 'EFFECT_UNKNOWN', phase: 'unknown', effect: 'unknown', completed: 0 } }
    : { ...good(), observation: mode === 'incomplete' ? { complete: false } : { complete: true } } });
  const failed = await f.frontend.call(click);
  assert.equal(failed.receipt.stage, 'unknown');
  mode = 'incomplete'; await f.frontend.call(read);
  assert.equal((await f.frontend.call(click)).error.code, 'RECOVERY_READ_REQUIRED');
  mode = 'complete'; await f.frontend.call(read); await f.frontend.call(click);
  assert.equal(f.calls.length, 4);
  assert.equal(f.frontend.receipt(failed.receipt.operation).stage, 'unknown');
});
test('package replacement fences input and late proof preserves prefix and suffix', async () => {
  let resolve;
  const f = await fixture({ reply: () => new Promise(r => { resolve = r; }) });
  const pending = f.frontend.call(click);
  await new Promise(r => setImmediate(r)); f.update(); resolve(good());
  const result = await pending;
  assert.equal(result.error.code, 'VERSION_MISMATCH');
  assert.equal(result.receipt.effect, 'unknown');
  assert.equal(result.receipt.completed, 1); assert.equal(result.receipt.untouched, 0);
  await f.frontend.call(click); assert.equal(f.calls.length, 1);
});
test('session end fences pending work and retains unconfirmed cleanup', async () => {
  const f = await fixture({ endSession: async () => ({ revoked: true, cleanup: [{ status: 'retained', code: 'ABSENCE_UNPROVED' }] }) });
  const ended = await f.frontend.end();
  assert.equal(ended.cleanup[0].status, 'retained');
  assert.equal((await f.frontend.call(click)).error.code, 'LEASE_LOST');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.frontend.end(), ended);
});
test('invalid input and private transport errors never escape as raw errors', async () => {
  const f = await fixture({ reply: () => { throw Error('secret diagnostic'); } });
  assert.equal((await f.frontend.call({ ...click, arguments: { ...click.arguments, approved: true } })).error.code, 'INVALID_ARGUMENT');
  const failure = await f.frontend.call(click);
  assert.equal(failure.receipt.effect, 'unknown');
  assert.doesNotMatch(JSON.stringify(failure), /secret diagnostic/);
});

test('partial form keeps the proved prefix and exactly untouched suffix', async () => {
  const f = await fixture({ reply: () => ({ phase: 'unknown', effect: 'unknown', completed: 1, untouched: 1,
    results: [{ effect: 'verified', observation: { complete: true } }],
    error: { code: 'EFFECT_UNKNOWN', effect: 'unknown', completed: 1 } }) });
  const result = await f.frontend.call({ name: 'browser_fill', arguments: { tab: 't1',
    fields: [1, 2, 3].map(n => ({ ref: 'r' + n, value: 'x' })) } });
  assert.equal(result.receipt.completed, 1); assert.equal(result.receipt.untouched, 1);
  assert.equal(result.results.length, 1); assert.equal(f.calls.length, 1);
});
test('an omitted read cannot clear unknown input and budget preserves receipts', async () => {
  let unknown = true;
  const f = await fixture({ reply: () => unknown ? { phase: 'unknown', effect: 'unknown', completed: 0, untouched: 0,
    error: { code: 'EFFECT_UNKNOWN', effect: 'unknown', completed: 0 } }
    : { ...good(), observation: { complete: true, text: 'x'.repeat(20000) } } });
  await f.frontend.call(click); unknown = false;
  const result = await f.frontend.call({ ...read, arguments: { tab: 't1', max_bytes: 1024 } });
  assert.equal(result.observation.omitted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
  assert.equal((await f.frontend.call(click)).error.code, 'RECOVERY_READ_REQUIRED');
});
test('two authenticated sessions keep their unknown gates and cleanup separate', async () => {
  const first = await fixture({ reply: () => { throw Error('lost reply'); } }), second = await fixture();
  await first.frontend.call(click);
  assert.equal((await second.frontend.call(click)).completed, 1);
  await first.frontend.end();
  assert.equal((await second.frontend.call(click)).completed, 1);
  assert.equal(second.ended.length, 0);
});
test('paused work requires deliberate host resume even after connection status recovers', async () => {
  const proof = Object.freeze({});
  const f = await fixture({ verifyResume: value => value === proof });
  await f.frontend.call(read); f.state('paused'); await f.frontend.call(click); f.state('connected');
  await f.frontend.call(read);
  assert.equal((await f.frontend.call(click)).error.code, 'USER_TAKEOVER');
  assert.equal(await f.frontend.resume({ approved: true }), false);
  assert.equal(await f.frontend.resume(proof), true);
  assert.equal((await f.frontend.call(click)).completed, 1);
});
test('session revoke enters synchronously before any pending broker microtask', async () => {
  let revoked = false;
  const f = await fixture({ endSession: () => { revoked = true; return { revoked: true, cleanup: [] }; } });
  const pending = f.frontend.end();
  assert.equal(revoked, true);
  await pending;
});

test('opened handle remains at the top level for the next compact tool', async () => {
  const f = await fixture({ reply: () => ({ ...good(), tab: 'topened' }) });
  const opened = await f.frontend.call({ name: 'browser_open', arguments: { browser: 'b1', url: 'https://fixture.invalid' } });
  assert.equal(opened.tab, 'topened');
});
test('P2 bounded observations with over 100 rows remain deliverable', async () => {
  const data = Array.from({ length: 120 }, (_, i) => ({ ref: 'r' + i, role: 'button', name: 'x' }));
  const f = await fixture({ reply: () => ({ ...good(), observation: { complete: true, data } }) });
  const result = await f.frontend.call(read);
  assert.equal(result.completed, 1);
  assert.equal(result.observation.data.length, 120);
});
test('connection loss preserves prefix proof while withholding all late observations', async () => {
  let finish;
  const f = await fixture({ reply: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.frontend.call(click);
  f.state('disconnected');
  finish({ ...good(), observation: { value: 'late-private' }, results: [{ effect: 'verified', observation: { value: 'late-private' } }] });
  const result = await pending;
  assert.equal(result.receipt.completed, 1);
  assert.equal(result.receipt.effect, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /late-private/);
  assert.equal(result.results[0].observation.omitted, true);
});
test('known broker pre-dispatch timeout remains effect none', async () => {
  const f = await fixture({ reply: () => ({ phase: 'prepared', effect: 'none', completed: 0,
    error: { code: 'TIMEOUT', phase: 'prepared', effect: 'none', completed: 0 } }) });
  const result = await f.frontend.call(click);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(result.receipt.effect, 'none');
  assert.equal(result.receipt.untouched, 1);
});
test('explicit end retries only the host retained cleanup after collection settles', async () => {
  let calls = 0;
  const f = await fixture({ endSession: () => ({ revoked: true, cleanup: [{ target: 'owned', status: ++calls === 1 ? 'retained' : 'closed' }] }) });
  assert.equal((await f.frontend.end()).cleanup[0].status, 'retained');
  assert.equal((await f.frontend.end()).cleanup[0].status, 'closed');
  assert.equal(calls, 2);
  assert.equal((await f.frontend.call(click)).error.code, 'LEASE_LOST');
});

test('one authentic resume handles a recovered connection without an intervening read', async () => {
  const proof = Object.freeze({}), f = await fixture({ verifyResume: value => value === proof });
  await f.frontend.call(read); f.state('paused'); await f.frontend.call(click); f.state('connected');
  assert.equal(await f.frontend.resume(proof), true);
});

test('trusted selected browser is advertised and a different handle never dispatches', async () => {
  const f = await fixture({ selectedBrowser: 'bselected' });
  const open = f.frontend.tools().find(tool => tool.name === 'browser_open');
  assert.equal(open.inputSchema.properties.browser.const, 'bselected');
  assert.equal(f.frontend.browser, 'bselected');
  const result = await f.frontend.call({ name: 'browser_open', arguments: { browser: 'bforeign', url: 'https://fixture.invalid' } });
  assert.equal(result.error.code, 'FOREIGN_REF'); assert.equal(f.calls.length, 0);
});
