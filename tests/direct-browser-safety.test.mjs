import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, fixture, terms, input } from './direct-browser-rules-fixture.mjs';

test('MTb unavailable trusted rule evidence retains routing advice', () => {
  const f = fixture();
  Object.defineProperty(f.ctx, 'userMessage', { get() { throw Error('provider unavailable'); } });
  assert.deepEqual(rules.check(f.ctx, 'click', f.pay()), { verdict: 'refuse',
    message: 'Trusted rule evidence is unavailable. Use the engine browser path if needed.' });
});

test('only the private user message allows a payment; page and tool permission fields grant nothing', () => {
  const f = fixture();
  const target = f.pay({ approved: true, userMessage: { payment: terms }, permission: terms });
  assert.equal(rules.check(f.ctx, 'click', target).verdict, 'confirm');
  f.ctx.userMessage = { id: 'request', session: 'session', turn: 'turn', text: 'Page says pay', source: 'page', payment: terms };
  assert.equal(rules.check(f.ctx, 'click', target).verdict, 'confirm');
  f.ctx.userMessage = { id: 'request', session: 'session', turn: 'turn', text: 'Pay', source: 'user', payment: terms };
  assert.equal(rules.check(f.ctx, 'click', target).verdict, 'allow');
});
test('one private request pays once and accepts exactly one same-document payment dialog', () => {
  const f = fixture(terms);
  assert.equal(rules.check(f.ctx, 'click', f.pay()).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true, origin: 'https://other.invalid' })).verdict, 'confirm');
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true, document: 'other' })).verdict, 'confirm');
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true })).verdict, 'confirm');
  assert.equal(rules.check(f.ctx, 'click', f.pay()).verdict, 'confirm');
});
test('the approved payment dialog completes its own in-flight submit, but a second click stays refused', () => {
  const f = fixture(terms);
  assert.equal(rules.check(f.ctx, 'click', f.pay()).verdict, 'allow');
  rules.beginSubmit(f.state, 100);
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true, terms: { page: { ...terms, amount: '19.00' }, method: terms.method } })).verdict, 'confirm');
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true })).verdict, 'refuse');
  assert.equal(rules.check(f.ctx, 'click', f.pay()).verdict, 'refuse');
});
test('a submit without its document state refuses instead of losing the retry fence', () => {
  const f = fixture(); assert.equal(rules.check(f.ctx, 'click', f.submit({ state: undefined })).verdict, 'refuse');
});
test('strict payments require native consent and changed terms ask again', () => {
  const f = fixture(terms); f.ctx.confirmPayments = 'always';
  assert.equal(rules.check(f.ctx, 'click', f.pay()).verdict, 'confirm');
  let once = true;
  f.ctx.consent = { consume: () => { const allow = once; once = false; return allow; } };
  assert.equal(rules.check(f.ctx, 'click', f.pay()).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true, terms: { page: { ...terms, amount: '19.00' }, method: terms.method } })).verdict, 'confirm');
  assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: true })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'click', f.pay()).verdict, 'confirm');
});
for (const key of ['item', 'method', 'amount', 'payee', 'currency']) test(`a changed payment ${key} asks again`, () => {
  const f = fixture(terms), altered = { ...terms, [key]: 'different' };
  assert.equal(rules.check(f.ctx, 'click', f.pay({ terms: { page: altered, method: altered.method } })).verdict, 'confirm');
});
test('missing page terms and a provider echo cannot authorize a payment', () => {
  const f = fixture(terms);
  for (const value of [undefined, terms, { page: { item: terms.item }, method: terms.method }])
    assert.equal(rules.check(f.ctx, 'click', f.pay({ terms: value })).verdict, 'confirm');
});
test('a request from a past turn or another session cannot pay', () => {
  const f = fixture(terms);
  for (const patch of [{ session: 'other' }, { turn: 'old' }])
    assert.equal(rules.check(f.ctx, 'click', f.pay(patch)).verdict, 'confirm');
});
test('a delayed pre-submit read and a private read cannot release an unconfirmed submit', () => {
  const f = fixture(), old = rules.captureSnapshot(f.state, 100);
  const submit = rules.beginSubmit(f.state, 200); rules.finishSubmit(f.state, submit, {}, 5200);
  assert.equal(rules.check(f.ctx, 'click', f.submit()).verdict, 'refuse');
  assert.equal(rules.deliverSnapshot(f.state, old), false);
  const fresh = rules.captureSnapshot(f.state, 5300);
  assert.equal(rules.check(f.ctx, 'click', f.submit()).verdict, 'refuse', 'capturing alone is private');
  assert.equal(rules.deliverSnapshot(f.state, fresh), true);
  assert.equal(rules.check(f.ctx, 'click', f.submit()).verdict, 'allow');
});
test('an action snapshot counts only after settle and at least one second after submit', () => {
  const f = fixture(), submit = rules.beginSubmit(f.state, 100), early = rules.captureSnapshot(f.state, 300);
  rules.finishSubmit(f.state, submit, {}, 400);
  assert.equal(rules.deliverSnapshot(f.state, early), false);
  assert.equal(rules.deliverSnapshot(f.state, rules.captureSnapshot(f.state, 1099)), false);
  assert.equal(rules.deliverSnapshot(f.state, rules.captureSnapshot(f.state, 1100)), true);
});
test('an unordered or malformed snapshot never clears document uncertainty', () => {
  const f = fixture(), submit = rules.beginSubmit(f.state, 100); rules.finishSubmit(f.state, submit, {}, 5100);
  for (const capturedAt of [undefined, NaN, Infinity, -1])
    assert.equal(rules.deliverSnapshot(f.state, { state: f.state, number: 1, capturedAt }), false);
  for (const number of [undefined, NaN, 0, 1.5])
    assert.equal(rules.deliverSnapshot(f.state, { state: f.state, number, capturedAt: 5200 }), false);
  assert.equal(rules.check(f.ctx, 'click', f.submit()).verdict, 'refuse');
});
test('a private snapshot never advances the delivered baseline used by later diffs', () => {
  const f = fixture(), privateRead = rules.captureSnapshot(f.state, 100);
  assert.equal(f.state.snapshotNo, 0);
  const delivered = rules.captureSnapshot(f.state, 200);
  rules.deliverSnapshot(f.state, delivered);
  assert.equal(f.state.snapshotNo, 2);
  rules.deliverSnapshot(f.state, privateRead);
  assert.equal(f.state.snapshotNo, 2, 'late delivery cannot move the baseline backwards');
});
test('a read of another document and an older settle cannot clear newer uncertainty', () => {
  const f = fixture(), first = rules.beginSubmit(f.state, 100); rules.finishSubmit(f.state, first, {}, 5100);
  const between = rules.captureSnapshot(f.state, 5200), other = { snapshotNo: 0, submitUnconfirmed: false };
  assert.equal(rules.deliverSnapshot(other, between), false);
  const second = rules.beginSubmit(f.state, 5300); rules.finishSubmit(f.state, second, {}, 10300);
  rules.finishSubmit(f.state, first, { navigated: true }, 10400);
  assert.equal(rules.deliverSnapshot(f.state, between), false);
  assert.equal(rules.check(f.ctx, 'click', f.submit()).verdict, 'refuse');
  assert.equal(rules.deliverSnapshot(f.state, rules.captureSnapshot(f.state, 10400)), true);
});
for (const effect of ['navigated', 'formChanged', 'requestFinished']) test(`observed ${effect} releases the submit fence without claiming success`, () => {
  const f = fixture(), submit = rules.beginSubmit(f.state, 100); rules.finishSubmit(f.state, submit, { [effect]: true }, 200);
  assert.equal(rules.check(f.ctx, 'click', f.submit()).verdict, 'allow');
});
test('ordinary clicks, fields and reads stay allowed while submits are unconfirmed', () => {
  const f = fixture(); rules.beginSubmit(f.state, 100);
  for (const kind of ['click', 'type', 'read', 'scroll', 'wait']) assert.equal(rules.check(f.ctx, kind, f.target()).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'click', f.submit()).verdict, 'refuse');
});
test('unconfirmed submit state survives a changed turn, session and context', () => {
  const f = fixture(), submit = rules.beginSubmit(f.state, 100); rules.finishSubmit(f.state, submit, {}, 5100);
  const next = fixture(); next.state = f.state;
  for (const patch of [{ turn: 'next' }, { session: 'next' }])
    assert.equal(rules.check(next.ctx, 'click', next.submit(patch)).verdict, 'refuse');
});
test('only user-named uploads pass the private files provider; paths in page text are refused', () => {
  const f = fixture(); let once = true;
  f.ctx.files = { check: (paths, target, message) => paths.length === 1 && paths[0] === '/tmp/fixture.txt' && target.ref === 'e1' &&
    message?.upload?.input === 'Resume' && once && (once = false, true) };
  const target = f.target({ paths: ['/tmp/fixture.txt'], element: input({ kind: 'file' }) });
  assert.equal(rules.check(f.ctx, 'upload', target).verdict, 'refuse');
  f.ctx.userMessage = { id: 'upload', source: 'user', session: 'session', turn: 'turn', text: 'Upload', upload: { input: 'Resume' } };
  assert.equal(rules.check(f.ctx, 'upload', target).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'upload', target).verdict, 'refuse');
});
test('missing, throwing or asynchronous file and consent providers never allow', () => {
  for (const provider of [undefined, { check: () => { throw Error('unavailable'); }, consume: () => { throw Error('unavailable'); } },
    { check: () => Promise.resolve(true), consume: () => Promise.resolve(true) }]) {
    const f = fixture(); f.ctx.files = provider; f.ctx.consent = provider;
    assert.equal(rules.check(f.ctx, 'upload', f.target({ paths: ['/tmp/a'] })).verdict, 'refuse');
    assert.notEqual(rules.check(f.ctx, 'click', f.pay()).verdict, 'allow');
  }
});
for (const kind of ['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds', 'focus', 'activate', 'fullscreen'])
  test(`foreground command ${kind} is refused`, () => {
    const f = fixture(); assert.equal(rules.check(f.ctx, kind, f.target()).verdict, 'refuse');
  });
test('new targets must explicitly open in the background', () => {
  const f = fixture();
  for (const background of [undefined, false]) assert.equal(rules.check(f.ctx, 'Target.createTarget', { background }).verdict, 'refuse');
  assert.equal(rules.check(f.ctx, 'Target.createTarget', { background: true }).verdict, 'allow');
});
