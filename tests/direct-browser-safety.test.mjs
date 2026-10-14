import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthority, createTransportAuthority, completeTransport } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { createConsentUi } from '../plugins/sleight/lib/direct-browser/consent-ui.mjs';
const scope = ref => ({ browser: 'browser', broker: 1, session: 'client', turn: 'turn', target: 'target',
  lease: 1, frame: 'frame', document: 1, ref, origin: 'https://fixture.invalid' });
const operation = (extra = {}) => ({ id: 'op', kind: 'fill', args: { value: 'fixture' }, scope: scope('rfirst'), consequence: 'ordinary', ...extra });
function fixture(options = {}) {
  let current = scope('rfirst'), time = 100;
  const user = {}, authority = createAuthority({ current: () => current, now: () => time,
    snapshot: () => ({ scope: current, time }), authenticate: event => event === user, classify: op => op,
    checkTarget: () => ({ present: true, visible: true, enabled: true, same: true }), ...options });
  return { authority, user, current: op => { current = op.scope; }, clock: value => { time = value; } };
}
test('ordinary fields, URLs and nonpayment actions need no site or transmission permission', () => {
  for (const op of [operation(), operation({ kind: 'navigate', args: { url: 'https://other.invalid/path?q=fixture' } }),
    operation({ kind: 'click', args: {}, consequence: 'deletion' })]) {
    const f = fixture(); assert.equal(f.authority.prepare(op).verdict, 'allow');
  }
});
test('one form operation carries ordered fields without per-field tokens or effect proofs', () => {
  const f = fixture(), plan = { target: 'target' }, sent = [];
  const transport = createTransportAuthority({ authority: f.authority, resolveOperation: (plan, ctx, command) =>
    operation({ id: command.params.text, scope: scope(command.params.text), args: { value: command.params.text } }) });
  const ctx = { session: 'client', turn: 'turn', browserIncarnation: 'browser', brokerEpoch: 1 };
  for (const ref of ['rfirst', 'rsecond']) {
    f.current(operation({ scope: scope(ref) }));
    transport(plan, ctx, { method: 'Input.insertText', params: { text: ref } }, () => sent.push(ref));
  }
  assert.deepEqual(sent, ['rfirst', 'rsecond']); completeTransport(transport, plan, 'verified');
});
for (const key of ['present', 'visible', 'enabled', 'same']) test('target check refuses ' + key + ' alone', () => {
  const f = fixture({ checkTarget: () => ({ present: true, visible: true, enabled: true, same: true, [key]: false }) });
  assert.equal(f.authority.prepare(operation()).verdict, 'deny');
});
test('an incomplete page does not block a checked target, but dispatch repeats the target check', () => {
  let same = true;
  const f = fixture({ checkTarget: () => ({ present: true, visible: true, enabled: true, same }),
    classify: op => ({ ...op, pageComplete: false }) });
  const op = operation(), prepared = f.authority.prepare(op); assert.equal(prepared.verdict, 'allow');
  same = false; assert.throws(() => f.authority.dispatch(prepared.capability, op, () => assert.fail('sent')));
});
const terms = { item: 'fixture', method: 'user card', payee: 'shop', amount: '12', currency: 'USD' };
for (const always of [false, true]) test('only authenticated user payment intent allows payment and its own dialog; always=' + always, () => {
  const f = fixture({ confirmPayments: always ? 'always' : undefined });
  assert.throws(() => f.authority.user({ approved: true }, 'request', { session: 'client', consequence: 'payment', terms }));
  f.authority.user(f.user, 'request', { session: 'client', consequence: 'payment', terms });
  for (const kind of ['click', 'dialog']) {
    const op = operation({ id: kind, kind, args: kind === 'dialog' ? { action: 'accept' } : {}, consequence: 'payment', terms });
    assert.equal(f.authority.prepare(op).verdict, always ? 'confirm' : 'allow');
  }
  assert.equal(f.authority.prepare(operation({ consequence: 'payment', terms: { ...terms, amount: '13' } })).verdict, 'confirm');
});
test('one payment confirmation covers the same payment dialog, without site grants', () => {
  const f = fixture(), op = operation({ kind: 'click', args: {}, consequence: 'payment', terms });
  assert.equal(f.authority.prepare(op).verdict, 'confirm'); f.authority.user(f.user, 'confirm', { operation: op });
  const p = f.authority.prepare(op); f.authority.dispatch(p.capability, op, () => {});
  assert.equal(f.authority.prepare(operation({ id: 'dialog', kind: 'dialog', args: { action: 'accept' }, consequence: 'payment', terms })).verdict, 'allow');
});
for (const submit of [false, true]) test('unknown submit needs a fresh read; ordinary unknown click continues; submit=' + submit, () => {
  const f = fixture(), op = operation({ kind: 'click', args: {}, submit });
  const p = f.authority.prepare(op); f.authority.dispatch(p.capability, op, () => { throw Error('uncertain'); });
  assert.equal(f.authority.prepare({ ...op, id: 'retry' }).verdict, submit ? 'deny' : 'allow');
  const read = operation({ id: 'read', kind: 'read', args: {} }), r = f.authority.prepare(read);
  assert.equal(r.verdict, 'allow'); f.authority.dispatch(r.capability, read, () => {});
  f.authority.observe(read.id); f.authority.verify(read.id, 'verified');
  assert.equal(f.authority.prepare({ ...op, id: 'after-read' }).verdict, 'allow');
});
test('Disconnect revokes even an ordinary request prepared without site grants', () => {
  const f = fixture(), op = operation(), p = f.authority.prepare(op);
  f.authority.user(f.user, 'disconnect', {});
  assert.throws(() => f.authority.dispatch(p.capability, op, () => assert.fail('sent')));
});
test('consent UI refuses site prompts and nonpayment action prompts', () => {
  const ui = createConsentUi({ authenticate: () => true, present: () => {}, checkCurrent: () => true });
  assert.throws(() => ui.request({}, { kind: 'site' }));
  assert.throws(() => ui.request({}, { kind: 'action' }));
});

test('missing or asynchronous target evidence refuses input', () => {
  for (const checkTarget of [undefined, () => Promise.resolve({ present: true, visible: true, enabled: true, same: true })])
    assert.equal(fixture({ checkTarget }).authority.prepare(operation()).verdict, 'deny');
});
test('a failed read or a read of another frame cannot release an uncertain submit', () => {
  const f = fixture(), op = operation({ kind: 'click', args: {}, submit: true });
  const p = f.authority.prepare(op); f.authority.dispatch(p.capability, op, () => { throw Error('unknown'); });
  const read = operation({ id: 'read', kind: 'read', args: {}, scope: { ...op.scope, frame: 'other' } }); f.current(read);
  const r = f.authority.prepare(read); f.authority.dispatch(r.capability, read, () => {});
  f.authority.observe(read.id); f.authority.verify(read.id, 'verified'); f.current(op);
  assert.equal(f.authority.prepare({ ...op, id: 'retry' }).verdict, 'deny');
  const failed = operation({ id: 'failed-read', kind: 'read', args: {} }), q = f.authority.prepare(failed);
  f.authority.dispatch(q.capability, failed, () => { throw Error('no state'); });
  assert.equal(f.authority.prepare({ ...op, id: 'again' }).verdict, 'deny');
  const recovered = fixture({ recovery: f.authority.recovery() });
  assert.equal(recovered.authority.prepare({ ...op, id: 'after-restart' }).verdict, 'deny');
});
test('the closed adapter refuses foreground commands and target activation', async () => {
  const { createScopedAdapter } = await import('../plugins/sleight/lib/direct-browser/scoped-adapter.mjs');
  const adapter = createScopedAdapter({ helpers: {}, checkLease: () => true,
    session: { sessionId: 'root', on() {}, off() {}, send() { assert.fail('foreground command reached transport'); } } });
  try {
    const view = adapter.forLease({ target: 'target', cdpSessionId: 'page', frame: 'frame', origin: 'https://fixture.invalid', document: 1, epoch: 1 });
    for (const method of ['Page.bringToFront', 'Target.activateTarget', 'Target.createTarget'])
      await assert.rejects(view.send(method, { targetId: 'target' }), /SCOPED_COMMAND_DENIED/);
  } finally { adapter.disconnect(); }
});

test('a request journal cannot survive Disconnect and Resume even with the same scope', () => {
  const f = fixture(), plan = { target: 'target' }, ctx = { session: 'client', turn: 'turn', browserIncarnation: 'browser', brokerEpoch: 1 };
  const transport = createTransportAuthority({ authority: f.authority, resolveOperation: (plan, ctx, command) => operation({ id: command.params.text }) });
  let sends = 0;
  transport(plan, ctx, { method: 'Input.insertText', params: { text: 'fixture' } }, () => { sends++; });
  f.authority.user(f.user, 'disconnect', {}); f.authority.user(f.user, 'resume', {});
  assert.throws(() => transport(plan, ctx, { method: 'Input.insertText', params: { text: 'second' } }, () => { sends++; }));
  assert.equal(sends, 1);
});
