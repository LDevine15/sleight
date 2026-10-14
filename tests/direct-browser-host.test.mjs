import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const directory = new URL('../plugins/sleight/lib/direct-browser/', import.meta.url);
const production = existsSync(new URL('broker.mjs', directory));
const { createBroker } = await import(production ? new URL('broker.mjs', directory) : '../bench/direct-browser2/broker.mjs');
const { createScopedAdapter } = await import(production ? new URL('scoped-adapter.mjs', directory) : '../bench/direct-browser2/scoped-adapter.mjs');
const { createAuthority, createTransportAuthority } = await import(new URL('authority.mjs', directory));
const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
const hello = (session = 'one') => ({ version: 1, secret, uid, session, incarnation: 'p1-100-0' });
const request = id => ({ id, operation: 'browser_act', args: { tab: 't1' } });
function fixture(changes = {}) {
  const calls = [], ended = [], events = new Map(); let live = true;
  let scope = { browser: 'browser1', broker: 1, session: 'one', turn: 'turn1', target: 't1',
    lease: 1, frame: 'frame1', document: 1, ref: 'ref1', origin: 'https://fixture.test' };
  const user = {};
  const authority = createAuthority({ current: () => scope, snapshot: () => ({ scope, time: Date.now() }),
    authenticate: event => event === user, classify: operation => operation });
  for (const session of ['one', 'a', 'b']) authority.user(user, 'grant', { session, origin: scope.origin, mode: 'session' });
  const transportAuthority = createTransportAuthority({ authority,
    resolveOperation(plan, brokerScope, command) {
      if (!live) throw Error('REVOKED');
      scope = { ...scope, session: brokerScope.session, broker: brokerScope.brokerEpoch, target: plan.target };
      return { id: brokerScope.session + '-' + brokerScope.operation, kind: 'fill', args: { value: command.params.text }, scope, consequence: 'ordinary' };
    } });
  const session = new Proxy({ sessionId: 'socket1',
    send(method, params, route) { calls.push({ method, params, route }); return Promise.resolve({}); },
    on(name, fn) { events.set(name, fn); }, off(name) { events.delete(name); } },
  { get(object, key) { if (key in object || typeof key === 'symbol' || key === 'then') return object[key]; throw Error('unsupported CDP member ' + key); } });
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser1',
    connect: async () => session, disconnect: () => true, verifyConnection: () => true, currentTurn: () => 'turn1',
    validateRequest: frame => frame, prepare: args => ({ target: args.tab }), authorize: () => true,
    dispatchFence: () => true, redact: observation => observation,
    endSession(session) { ended.push(session); return true; },
    // Synthetic terminal policy. Host qualification is separate.
    transportAuthority,
    async dispatch(plan, context) {
      await Promise.resolve();
      await context.session.send('Input.insertText', { text: 'fixture' }, 'owned-session');
      return { effect: 'verified', observation: {} };
    }, ...changes });
  return { broker, calls, ended, revoke() { live = false; } };
}
test('revocation during asynchronous preparation fences actual transport entry', async () => {
  let f;
  f = fixture({ async dispatch(plan, context) {
    await Promise.resolve(); f.revoke();
    await context.session.send('Input.insertText', { text: 'fixture' }, 'owned-session');
    return { effect: 'verified', observation: {} };
  } });
  await f.broker.connect({ userInitiated: true });
  const receipt = await f.broker.attach(hello()).request(request('revoked'));
  assert.equal(f.calls.length, 0);
  assert.equal(receipt.effect, 'none');
});
test('a callback that simply allows transport cannot replace the R4 authority', () => {
  assert.throws(() => fixture({ transportAuthority: (plan, scope, command, enter) => enter() }), /TRUSTED_CONTRACT_REQUIRED/);
});
test('missing terminal authority refuses broker construction', () => {
  assert.throws(() => fixture({ transportAuthority: undefined }), /TRUSTED_CONTRACT_REQUIRED/);
});
test('adapter refuses malformed or cross-frame input before any native transport', async () => {
  const calls = [];
  const session = { sessionId: 'root', send(...args) { calls.push(args); }, on() {}, off() {} };
  const lease = { target: 'owned', cdpSessionId: 'owned-session', frame: 'f1', origin: 'https://fixture.test', document: 1, epoch: 1, executionContextId: 1 };
  const adapter = createScopedAdapter({ session, checkLease: () => true, helpers: {} });
  const view = adapter.forLease(lease);
  for (const params of [{ type: 'mousePressed', x: NaN, y: 1 }, { type: 'unexpected', x: 1, y: 2 },
    { type: 'mousePressed', x: -1, y: 2 }, { type: 'mousePressed', x: 1, y: 2, frameId: 'foreign' }])
    await assert.rejects(view.input('Input.dispatchMouseEvent', params), /SCOPED_COMMAND_DENIED|INVALID_ARGUMENT/);
  assert.equal(calls.length, 0); adapter.disconnect();
});
test('connection stays approved and visibly idle after every client leaves', async () => {
  const f = fixture(); await f.broker.connect({ userInitiated: true });
  const a = f.broker.attach(hello('a')), b = f.broker.attach(hello('b'));
  await a.request(request('same')); await b.request(request('same'));
  a.disconnect(); b.disconnect();
  assert.equal(f.broker.status().state, 'connected'); assert.equal(f.broker.status().clients, 0);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.ended, ['a', 'b']);
});
test('production bank contains no prototype fixture bypass or bench imports', () => {
  for (const name of ['authority', 'policy', 'discovery', 'broker', 'ipc', 'scoped-adapter', 'consent-ui', 'setup-ui', 'indicator', 'host']) {
    const source = readFileSync(new URL(name + '.mjs', directory), 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*bench\/|createFixtureSlice|authorize:\s*\(\)\s*=>\s*true/);
  }
});
test('unconfirmed session revocation fences the retained connection and future reconnect', async () => {
  const f = fixture({ endSession: () => false });
  await f.broker.connect({ userInitiated: true });
  f.broker.attach(hello()).disconnect();
  assert.equal(f.broker.status().state, 'disconnected');
  await assert.rejects(f.broker.connect({ userInitiated: true }), /SESSION_REVOCATION_UNCONFIRMED/);
});
