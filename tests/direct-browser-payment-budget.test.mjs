import test from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../plugins/sleight/lib/direct-browser/rules.mjs';

// One payment activation per user request, whichever kind of control (scripted type=button or plain submit),
// and a scripted control can be approved through the same consent path as any other.
const named = { item: 'Fixture item', method: 'Fixture card' };
const ctxFor = (payment, consume = () => false, id = 'r1') => ({ userMessage: () => ({ source: 'user', id, text: 'pay', session: 's', turn: 't', ...(payment ? { payment } : {}) }), consent: { consume } });
const terms = { page: { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop' }, method: 'Fixture card' };
const target = scripted => ({ session: 's', turn: 't', document: 'd1', origin: 'http://x', state: { snapshotNo: 1 }, terms, do: 'click',
  element: { tag: 'button', kind: 'button', button: true, connected: true, visible: true, enabled: true, hit: true, name: 'x', payment: !scripted, submit: true, form: true, formPayment: true, scriptButton: scripted } });

test('scripted, scripted, plain, plain, scripted gives allow then four confirms', () => {
  const ctx = ctxFor(named);
  const got = [true, true, false, false, true].map(scripted => check(ctx, 'click', target(scripted)).verdict);
  assert.deepEqual(got, ['allow', 'confirm', 'confirm', 'confirm', 'confirm']);
});
test('plain first spends the budget a scripted control would use', () => {
  const ctx = ctxFor(named);
  assert.deepEqual([false, true].map(scripted => check(ctx, 'click', target(scripted)).verdict), ['allow', 'confirm']);
});
test('a scripted control with only a vague request is approvable through consent', () => {
  let consumed = 0;
  const ctx = ctxFor(undefined, () => { consumed++; return true; });
  assert.equal(check(ctx, 'click', target(true)).verdict, 'allow');
  assert.equal(consumed, 1);
});
test('a scripted control without approval asks', () => {
  assert.equal(check(ctxFor(undefined, () => false), 'click', target(true)).verdict, 'confirm');
});
test('a new request has a new budget', () => {
  const ctx = { userMessage: () => ({ source: 'user', id: ctx.id, text: 'pay', session: 's', turn: 't', payment: named }), consent: { consume: () => false }, id: 'a' };
  assert.equal(check(ctx, 'click', target(true)).verdict, 'allow');
  assert.equal(check(ctx, 'click', target(false)).verdict, 'confirm');
  ctx.id = 'b';
  assert.equal(check(ctx, 'click', target(false)).verdict, 'allow');
});
