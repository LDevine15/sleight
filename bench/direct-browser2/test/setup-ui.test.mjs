import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsentUi, escapeLabel, selectedBrowser } from '../ui-contract.mjs';
import { createSetupUi, SETUP_COPY } from '../setup-ui.mjs';
import { createIndicator } from '../indicator.mjs';

const browser = { application: 'com.example.browser', name: 'Chrome', userDataRoot: '/fixture/browser', incarnation: 'pid-start-1' };
const operation = () => ({ browserIncarnation: 'pid-start-1', brokerEpoch: 1, clientSession: 's1', turn: 'turn1', leaseGeneration: 1,
  target: 't1', frame: 'f1', document: 'd1', sequence: 1, origin: 'https://shop.test',
  action: 'fill', args: { value: 'fixture' }, destination: 'https://shop.test/order',
  payment: { item: 'book', payee: 'shop', amount: '20.00', currency: 'USD', method: 'fixture-card' } });
function host() {
  const events = new WeakSet();
  const cards = [];
  return { cards, emit: fields => { const event = { ...fields }; events.add(event); return event; },
    authenticate: event => events.delete(event), present: card => cards.push(card) };
}
function consent() {
  const native = host();
  let now = 0;
  const ui = createConsentUi({ ...native, checkCurrent: () => true, now: () => now, ttlMs: 100 });
  return { native, ui, advance: ms => { now += ms; } };
}
function setup() {
  const native = host();
  const attempts = [], effects = [];
  let now = 0;
  const indicator = createIndicator({ now: () => now });
  const ui = createSetupUi({ browser, ...native, indicator,
    connect: ({ signal, selected }) => new Promise((resolve, reject) => attempts.push({ signal, selected, resolve, reject })),
    fence: reason => effects.push(['fence', reason]), cancelQueued: () => effects.push(['cancel']),
    invalidateRefs: () => effects.push(['invalidate']), revokeConfirmations: () => effects.push(['revoke']), refreshState: () => true });
  const event = action => native.emit({ action, selection: selectedBrowser(browser), freshState: action === 'resume' });
  const connection = () => {
    const listeners = new Map();
    const cdp = { sessionId: 'cdp1', send: async () => { throw Error('UI must not send CDP commands'); },
      on: (name, fn) => listeners.set(name, fn), off: name => listeners.delete(name) };
    return { selected: selectedBrowser(browser), cdp, close: () => effects.push(['close']),
      listener: () => listeners.get('disconnected'),
      lose: () => listeners.get('disconnected')?.() };
  };
  return { ui, native, attempts, effects, indicator, event, connection, advance: ms => { now += ms; } };
}
async function connected(f) {
  const pending = f.ui.control(f.event('connect'));
  f.attempts[0].resolve(f.connection());
  await pending;
}

test('first-run copy preserves the exact checkbox and Chrome prompt, with explicit instance identity', () => {
  const f = setup();
  assert.equal(f.ui.view().selection.application, browser.application);
  assert.equal(f.ui.view().selection.userDataRoot, browser.userDataRoot);
  assert.equal(SETUP_COPY.before, 'Connect sleight to Chrome for fast browser control. No extension needed.\n\nIn Chrome, open chrome://inspect/#remote-debugging and turn on Allow remote debugging for this browser instance. Then choose Connect here.\n\nChrome will ask Allow remote debugging? Choose Allow for the connection you just started. This gives sleight a browser connection; your site permissions and action confirmations still apply.');
  assert.deepEqual(f.ui.view().buttons, ['Connect', 'Use existing browser control', 'Not now']);
});
test('selection requires application, root and process incarnation; label is not identity', () => {
  for (const key of ['application', 'userDataRoot', 'incarnation']) assert.throws(() => selectedBrowser({ ...browser, [key]: '' }));
  assert.throws(() => selectedBrowser({ ...browser, userDataRoot: '/fixture/../owner' }));
  assert.notDeepEqual(selectedBrowser(browser), selectedBrowser({ ...browser, incarnation: 'restarted' }));
});
test('page markup, control characters and bidirectional labels are escaped', () => {
  assert.equal(escapeLabel('<img onerror="approve()">\u202e\n&'), '&lt;img onerror=&quot;approve()&quot;&gt;\\u202e\\u000a&amp;');
});
test('missing trusted UI cannot create authority', () => {
  const ui = createConsentUi();
  assert.throws(() => ui.request(operation()), /TRUSTED_UI_UNAVAILABLE/);
});
test('raw model or page approval booleans and copied native events are rejected', () => {
  const f = consent(), op = operation(), id = f.ui.request(op, { label: 'Approve all sites' });
  assert.throws(() => f.ui.respond({ id, choice: 'once', approved: true }), /UNAUTHENTICATED/);
  const event = f.native.emit({ id, choice: 'once' });
  assert.throws(() => f.ui.respond({ ...event }), /UNAUTHENTICATED/);
  const ticket = f.ui.respond(event);
  assert.equal(f.ui.consume(ticket, op).phase, 'prepared');
  assert.throws(() => f.ui.consume(ticket, op), /STALE_CONFIRMATION/);
});
test('confirmation presents escaped page labels and redacted values; exact arguments stay private', () => {
  const f = consent(), op = operation();
  op.args = { password: 'private-fixture', value: 'private-fixture' };
  f.ui.request(op, { label: '<script>approved=true</script>' });
  const card = JSON.stringify(f.native.cards);
  assert.match(card, /&lt;script&gt;/);
  assert.ok(!card.includes('private-fixture'));
  assert.match(card, /protected/);
});
test('operation changes invalidate affirmative choice before dispatch', () => {
  for (const key of ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn', 'leaseGeneration', 'target', 'frame', 'document', 'sequence', 'origin', 'action', 'args', 'destination', 'payment']) {
    const f = consent(), op = operation(), id = f.ui.request(op);
    const ticket = f.ui.respond(f.native.emit({ id, choice: 'once' }));
    const changed = structuredClone(op); changed[key] = typeof op[key] === 'number' ? 99 : key === 'args' ? { value: 'other' } : key === 'payment' ? { ...op.payment, amount: '21.00' } : 'other';
    assert.throws(() => f.ui.consume(ticket, changed), /STALE_CONFIRMATION/, key);
  }
});
test('every changed payment term needs a fresh confirmation, including method and plan', () => {
  for (const key of ['item', 'payee', 'amount', 'currency', 'method', 'plan']) {
    const f = consent(), op = operation(), id = f.ui.request(op);
    const ticket = f.ui.respond(f.native.emit({ id, choice: 'once' }));
    op.payment[key] = 'changed';
    assert.throws(() => f.ui.consume(ticket, op), /STALE_CONFIRMATION/, key);
  }
});
test('expiry, pause and revoked confirmations cannot dispatch', () => {
  for (const cause of ['expiry', 'revoke']) {
    const f = consent(), op = operation(), id = f.ui.request(op);
    const ticket = f.ui.respond(f.native.emit({ id, choice: 'once' }));
    if (cause === 'expiry') f.advance(101); else f.ui.revoke();
    assert.throws(() => f.ui.consume(ticket, op), /STALE_CONFIRMATION/);
  }
});
test('two sessions on one origin do not share site permission; once is one operation', () => {
  const f = consent(), op = operation(), id = f.ui.request(op, { kind: 'site' });
  const ticket = f.ui.respond(f.native.emit({ id, choice: 'session' }));
  f.ui.consume(ticket, op);
  assert.equal(f.ui.hasSiteGrant(op), true);
  assert.equal(f.ui.hasSiteGrant({ ...op, clientSession: 's2' }), false);
  assert.equal(f.ui.hasSiteGrant({ ...op, brokerEpoch: 2 }), false);
  assert.equal(f.ui.hasSiteGrant({ ...op, origin: 'https://other.test' }), false);
  f.ui.revoke(); assert.equal(f.ui.hasSiteGrant(op), false);
});
test('Cancel and close store no decline; the next request is shown', () => {
  for (const choice of ['cancel', 'close']) {
    const f = consent(), op = operation(), id = f.ui.request(op);
    assert.equal(f.ui.respond(f.native.emit({ id, choice })), null);
    assert.notEqual(f.ui.request(op), id);
    assert.equal(f.native.cards.length, 2);
  }
});
test('always allow requires a host-owned allowlist writer and cannot make action authority permanent', () => {
  const f = consent(), id = f.ui.request(operation(), { kind: 'site' });
  assert.throws(() => f.ui.respond(f.native.emit({ id, choice: 'always' })), /ALLOWLIST_UNAVAILABLE/);
  const writes = [], native = host();
  const ui = createConsentUi({ ...native, checkCurrent: () => true, writeAllowlist: scope => { writes.push(scope); return true; } });
  const op = operation(), actionId = ui.request(op);
  assert.throws(() => ui.respond(native.emit({ id: actionId, choice: 'always' })), /INVALID_CHOICE/);
  const siteId = ui.request(op, { kind: 'site' });
  const ticket = ui.respond(native.emit({ id: siteId, choice: 'always' }));
  assert.equal(writes.length, 0);
  ui.consume(ticket, op);
  assert.equal(writes.length, 1); assert.equal(writes[0].origin, op.origin);
});
test('malformed operation identity and non-web origins cannot request consent', () => {
  const f = consent();
  for (const key of Object.keys(operation())) assert.throws(() => f.ui.request({ ...operation(), [key]: undefined }), undefined, key);
  for (const origin of ['file:///owner', 'chrome://settings', 'https://shop.test/path']) assert.throws(() => f.ui.request({ ...operation(), origin }));
});
test('connection requires authenticated native intent, exact selected instance and a fresh event', async () => {
  const f = setup();
  await assert.rejects(f.ui.control({ action: 'connect', approved: true }), /UNAUTHENTICATED/);
  await assert.rejects(f.ui.control(f.native.emit({ action: 'connect', selection: { ...selectedBrowser(browser), incarnation: 'other' } })), /STALE_SELECTION/);
  assert.equal(f.attempts.length, 0);
  const event = f.event('connect'), pending = f.ui.control(event);
  await assert.rejects(f.ui.control(event), /UNAUTHENTICATED/);
  f.attempts[0].resolve(f.connection()); await pending;
});
test('approval-pending is asynchronous and never queues hidden work', async () => {
  const f = setup(), pending = f.ui.control(f.event('connect'));
  assert.equal(f.ui.view().state, 'approval-pending');
  assert.equal(f.ui.view().code, 'CONNECTION_APPROVAL_PENDING');
  assert.equal(f.ui.view().text, SETUP_COPY.waiting);
  assert.throws(() => f.ui.assertDispatch(), /CONNECTION_APPROVAL_PENDING/);
  f.attempts[0].resolve(f.connection()); await pending;
  assert.equal(f.ui.assertDispatch().phase, 'prepared');
});
test('cancellation aborts and closes a late socket with no reconnect loop or decline cache', async () => {
  const f = setup(), pending = f.ui.control(f.event('connect'));
  await f.ui.control(f.event('cancel'));
  assert.equal(f.attempts[0].signal.aborted, true);
  f.attempts[0].resolve(f.connection()); await pending;
  assert.equal(f.ui.view().state, 'disconnected');
  assert.equal(f.effects.filter(([effect]) => effect === 'close').length, 1);
  assert.equal(f.attempts.length, 1);
  const next = f.ui.control(f.event('connect')); f.attempts[1].resolve(f.connection()); await next;
});
test('decline, disabled setting, policy-blocked, unsupported and stale instance stay distinct', async () => {
  for (const code of ['CONNECTION_DECLINED', 'SETTING_OFF', 'SETTING_BLOCKED', 'UNSUPPORTED_BROWSER', 'STALE_INSTANCE']) {
    const f = setup(), pending = f.ui.control(f.event('connect'));
    f.attempts[0].reject(Object.assign(Error('private page error'), { code })); await pending;
    assert.equal(f.ui.view().code, code);
    assert.ok(!JSON.stringify(f.ui.view()).includes('private page error'));
    assert.equal(f.attempts.length, 1);
    assert.throws(() => f.ui.assertDispatch());
  }
});
test('connection with different identity is closed before status or dispatch becomes connected', async () => {
  const f = setup(), pending = f.ui.control(f.event('connect')), connection = f.connection();
  connection.selected.incarnation = 'restarted'; f.attempts[0].resolve(connection); await pending;
  assert.equal(f.ui.view().code, 'STALE_INSTANCE'); assert.throws(() => f.ui.assertDispatch());
  assert.ok(f.effects.some(([effect]) => effect === 'close'));
});
test('hookup animation runs alongside authorized work; counts and idle persist', async () => {
  const f = setup(); await connected(f);
  f.ui.addSession('s1'); assert.equal(f.indicator.view().text, 'sleight is connected to Chrome.');
  assert.doesNotThrow(() => f.ui.assertDispatch());
  f.advance(1001); assert.equal(f.indicator.view().text, 'Chrome connected · 1 session');
  f.ui.addSession('s2'); assert.equal(f.indicator.view().text, 'Chrome connected · 2 sessions');
  f.ui.removeSession('s1'); f.ui.removeSession('s2');
  assert.equal(f.indicator.view().text, 'Chrome connected · idle');
  assert.equal(f.attempts.length, 1);
});
test('Pause fences and cancels before resume; Disconnect invalidates and closes, leaving tabs and toggle alone', async () => {
  const f = setup(); await connected(f);
  await f.ui.control(f.event('pause'));
  assert.deepEqual(f.effects.slice(0, 2), [['fence', 'pause'], ['cancel']]);
  assert.throws(() => f.ui.assertDispatch(), /PAUSED/);
  await f.ui.control(f.event('resume')); assert.doesNotThrow(() => f.ui.assertDispatch());
  await f.ui.control(f.event('disconnect'));
  assert.equal(f.ui.view().state, 'disconnected');
  assert.ok(f.effects.some(([effect]) => effect === 'invalidate'));
  assert.ok(f.effects.some(([effect]) => effect === 'close'));
  assert.equal(f.attempts.length, 1);
  assert.match(SETUP_COPY.off, /turn off Allow remote debugging for this browser instance/);
});
test('socket loss, browser restart and setting-off revoke without reattaching', async () => {
  for (const reason of ['socket-loss', 'browser-restart', 'setting-off']) {
    const f = setup(); await connected(f);
    f.ui.lost(reason);
    assert.throws(() => f.ui.assertDispatch());
    assert.equal(f.indicator.view().connected, false);
    assert.equal(f.attempts.length, 1);
    assert.ok(f.effects.some(([effect]) => effect === 'invalidate'));
  }
});
test('a disconnected in-flight effect remains unknown on reconnect, with no automatic replay', async () => {
  const f = setup(); await connected(f); f.ui.dispatched('op1'); f.ui.lost('socket-loss');
  assert.equal(f.ui.receipt('op1').phase, 'dispatched'); assert.equal(f.ui.receipt('op1').effect, 'unknown');
  assert.match(f.ui.view().text, /The last action may be unfinished/);
  await connectedAgain(f);
  assert.equal(f.ui.receipt('op1').effect, 'unknown');
  assert.throws(() => f.ui.dispatched('op1'), /EFFECT_UNKNOWN/);
});
async function connectedAgain(f) { const pending = f.ui.control(f.event('connect')); f.attempts.at(-1).resolve(f.connection()); await pending; }
test('completed actions do not claim to be undone after disconnect', async () => {
  const f = setup(); await connected(f); f.ui.dispatched('op1'); f.ui.verified('op1'); f.ui.lost('socket-loss');
  assert.equal(f.ui.receipt('op1').phase, 'verified');
  assert.ok(!f.ui.view().text.includes('unfinished'));
});
test('decorative page badge cannot grant, pause, disconnect or resume anything', async () => {
  const f = setup(); await connected(f);
  for (const action of ['pause', 'disconnect', 'resume']) await assert.rejects(f.ui.control({ action, source: 'page', isTrusted: true }), /UNAUTHENTICATED/);
  assert.doesNotThrow(() => f.ui.assertDispatch());
});
test('late proof from the old connection cannot mark an unknown action verified after reconnect', async () => {
  const f = setup(); await connected(f); f.ui.dispatched('op1'); f.ui.lost('socket-loss');
  await connectedAgain(f);
  assert.throws(() => f.ui.verified('op1'), /EFFECT_UNKNOWN/);
});
test('trusted confirmation still requires the broker to check current authority', () => {
  const native = host(), ui = createConsentUi(native), op = operation();
  const id = ui.request(op), ticket = ui.respond(native.emit({ id, choice: 'once' }));
  assert.throws(() => ui.consume(ticket, op), /CURRENT_AUTHORITY_REQUIRED/);
});
test('native host receives the exact private data and destination, separately from escaped presentation', () => {
  const native = host(), op = operation();
  let details;
  const ui = createConsentUi({ ...native, present: (card, privateOperation) => { native.present(card); details = privateOperation; } });
  ui.request(op);
  assert.deepEqual(details, op);
  assert.equal(JSON.stringify(native.cards).includes(op.args.value), false);
  assert.equal(JSON.stringify(native.cards).includes(op.payment.method), false);
  details.args.value = 'mutated by host';
  assert.equal(op.args.value, 'fixture');
});
test('a late loss event from an old socket cannot disconnect the new connection', async () => {
  const f = setup(), pending = f.ui.control(f.event('connect')), old = f.connection();
  f.attempts[0].resolve(old); await pending;
  const delayedLoss = old.listener();
  await f.ui.control(f.event('disconnect'));
  await connectedAgain(f);
  delayedLoss();
  assert.equal(f.ui.view().state, 'connected');
  assert.doesNotThrow(() => f.ui.assertDispatch());
  assert.equal(f.effects.filter(([effect]) => effect === 'close').length, 1);
});

test('malformed returned connection identities are closed exactly once', async () => {
  for (const selection of [null, undefined, {}, { ...browser, userDataRoot: '' }]) {
    const f = setup(), pending = f.ui.control(f.event('connect')), connection = f.connection();
    connection.selected = selection;
    f.attempts[0].resolve(connection); await pending;
    assert.equal(f.effects.filter(([effect]) => effect === 'close').length, 1);
    assert.equal(f.ui.view().code, 'STALE_INSTANCE');
    assert.throws(() => f.ui.assertDispatch());
  }
});

test('failed rejected-connection cleanup is retained and blocks reconnect until explicit teardown succeeds', async () => {
  const f = setup(), pending = f.ui.control(f.event('connect')), connection = f.connection();
  connection.selected = null;
  let closes = 0;
  connection.close = () => { if (++closes === 1) throw Error('private fixture failure'); };
  f.attempts[0].resolve(connection); await pending;
  assert.equal(f.ui.view().code, 'SOCKET_CLOSE_UNCONFIRMED');
  assert.throws(() => f.ui.assertDispatch(), /SOCKET_CLOSE_UNCONFIRMED/);
  await assert.rejects(f.ui.control(f.event('connect')), /SOCKET_CLOSE_UNCONFIRMED/);
  assert.equal(f.attempts.length, 1);
  assert.equal(closes, 1);
  await f.ui.control(f.event('disconnect'));
  assert.equal(closes, 2);
  await connectedAgain(f);
  assert.doesNotThrow(() => f.ui.assertDispatch());
});

test('array accessors, custom methods, sparse and inherited entries are refused without execution', () => {
  let executions = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', { get() { executions++; return 'fixture'; } });
  const method = ['fixture']; method.map = () => { executions++; return ['fixture']; };
  const sparse = Array(1);
  const inherited = Array(1); Object.setPrototypeOf(inherited, { 0: 'fixture' });
  const executable = [() => { executions++; }];
  for (const values of [accessor, method, sparse, inherited, executable]) {
    const f = consent(), op = operation(); op.args = { values };
    assert.throws(() => f.ui.request(op), /INVALID_OPERATION/);
    assert.equal(f.native.cards.length, 0);
  }
  assert.equal(executions, 0);
});

test('plain nested arrays retain their exact private order and changed entries invalidate confirmation', () => {
  const native = host(); let details;
  const ui = createConsentUi({ ...native, checkCurrent: () => true,
    present: (card, privateOperation) => { native.present(card); details = privateOperation; } });
  const op = operation(); op.args = { values: ['first', ['second', false, 3], null] };
  const id = ui.request(op), ticket = ui.respond(native.emit({ id, choice: 'once' }));
  assert.deepEqual(details.args.values, op.args.values);
  details.args.values[1][0] = 'host edit';
  assert.equal(op.args.values[1][0], 'second');
  op.args.values.reverse();
  assert.throws(() => ui.consume(ticket, op), /STALE_CONFIRMATION/);
  assert.ok(!JSON.stringify(native.cards).includes('second'));
});

test('a cancelled late result closes only its own connection after a replacement connects', async () => {
  const f = setup(), first = f.ui.control(f.event('connect')), old = f.connection();
  let oldCloses = 0; old.close = () => { oldCloses++; };
  await f.ui.control(f.event('cancel'));
  const second = f.ui.control(f.event('connect')), replacement = f.connection();
  f.attempts[1].resolve(replacement); await second;
  f.attempts[0].resolve(old); await first;
  assert.equal(oldCloses, 1);
  assert.equal(f.effects.filter(([effect]) => effect === 'close').length, 0);
  assert.doesNotThrow(() => f.ui.assertDispatch());
  replacement.lose();
  assert.equal(f.effects.filter(([effect]) => effect === 'close').length, 1);
});

test('false and asynchronous close replies retain ownership until an explicit confirmed close', async () => {
  for (const result of [false, Promise.reject(Error('private async fixture failure'))]) {
    const f = setup(), pending = f.ui.control(f.event('connect')), connection = f.connection();
    connection.selected = null;
    let closes = 0;
    connection.close = () => ++closes === 1 ? result : true;
    f.attempts[0].resolve(connection); await pending;
    assert.equal(f.ui.view().code, 'SOCKET_CLOSE_UNCONFIRMED');
    assert.throws(() => f.ui.assertDispatch());
    assert.equal(closes, 1);
    await f.ui.control(f.event('disconnect'));
    assert.equal(closes, 2);
    assert.equal(f.ui.view().code, 'DISCONNECTED');
  }
});

test('listener removal failure cannot skip socket closure', async () => {
  const f = setup(), pending = f.ui.control(f.event('connect')), connection = f.connection();
  connection.cdp.off = () => { throw Error('private listener failure'); };
  f.attempts[0].resolve(connection); await pending;
  await f.ui.control(f.event('disconnect'));
  assert.equal(f.effects.filter(([effect]) => effect === 'close').length, 1);
  assert.equal(f.ui.view().code, 'DISCONNECTED');
  assert.throws(() => f.ui.assertDispatch());
});
