import test from 'node:test';
import assert from 'node:assert/strict';
import { check, deferRefund, refundableName, endDeferredRefund } from '../plugins/sleight/lib/direct-browser/rules.mjs';

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

// A scripted activation that settled with no effect (Apply, a quantity stepper, Remove) gives its budget back at the next payment
// check, but only when its own name is on the closed list and nothing at all went out on the network until that check.
const quiet = () => { const a = { observable: true, stopped: false, noise: false, quiet: () => !a.noise, stop() { a.stopped = true; } }; return a; };
const named_ = (name, scripted = true) => { const t = target(scripted); t.element.accName = name; return t; };
test('the closed name list holds the non-payment verbs and their symbols, nothing else', () => {
  for (const ok of ['Apply', 'Apply coupon', 'Update', 'Update cart', 'Remove', 'Remove item', 'Delete', 'Increase', 'Increase quantity', 'Decrease', 'Plus', 'Minus',
    'Show order summary', 'Hide details', 'Edit', 'Edit address', 'Change', 'More', 'Less', '+', '\u2212', '-', '\u2013', '\uFF0B', ' apply '])
    assert.equal(refundableName(ok), true, ok);
  for (const bad of ['', 'Continue', 'Next', 'Pay', 'Apply and pay', 'Apply now', 'Update payment method', 'Confirm', 'Submit', 'Add', 'Add to cart', 'Donate', 'x', 'Buy',
    'Remove all and place order', 'Show me the money in five easy steps', 'Complete'])
    assert.equal(refundableName(bad), false, bad);
});
test('a quiet closed-list activation gives the budget back at the next payment check, not before', () => {
  const ctx = ctxFor(named), apply = named_('Apply'), watch = quiet();
  assert.equal(check(ctx, 'click', apply).verdict, 'allow');
  assert.equal(deferRefund(ctx, apply, watch), true);
  assert.equal(watch.stopped, false);
  assert.equal(deferRefund(ctx, apply, watch), false);
  assert.deepEqual([false, false].map(scripted => check(ctx, 'click', target(scripted)).verdict), ['allow', 'confirm']);
  assert.equal(watch.stopped, true);
});
test('F1: ending the turn stops a deferred watch that no payment check settled, and keeps the budget spent', () => {
  const ctx = ctxFor(named), apply = named_('Apply'), watch = quiet();
  assert.equal(check(ctx, 'click', apply).verdict, 'allow');
  assert.equal(deferRefund(ctx, apply, watch), true);
  endDeferredRefund(ctx);
  assert.equal(watch.stopped, true);
  endDeferredRefund(ctx); endDeferredRefund({});
  assert.equal(check(ctx, 'click', target(false)).verdict, 'confirm');
});
test('network activity before the next payment check keeps the budget spent', () => {
  const ctx = ctxFor(named), apply = named_('Apply'), watch = quiet();
  assert.equal(check(ctx, 'click', apply).verdict, 'allow');
  assert.equal(deferRefund(ctx, apply, watch), true);
  watch.noise = true;
  assert.equal(check(ctx, 'click', target(false)).verdict, 'confirm');
  assert.equal(watch.stopped, true);
});
test('a control off the closed list, or whose network could not be watched, is never refunded', () => {
  for (const [name, watch] of [['Continue', quiet()], ['Next', quiet()], ['', quiet()], ['Apply', { observable: false, quiet: () => false, stop() {} }], ['Apply', undefined]]) {
    const ctx = ctxFor(named), control = named_(name);
    assert.equal(check(ctx, 'click', control).verdict, 'allow');
    assert.equal(deferRefund(ctx, control, watch), false, name);
    assert.equal(check(ctx, 'click', target(false)).verdict, 'confirm', name);
  }
});
test('a plain submit and an activation that did not spend the budget cannot refund it', () => {
  const ctx = ctxFor(named, () => true), first = named_('Apply', false), second = named_('Apply');
  assert.equal(check(ctx, 'click', first).verdict, 'allow');
  assert.equal(check(ctx, 'click', second).verdict, 'allow');
  assert.equal(deferRefund(ctx, second, quiet()), false);
  assert.equal(deferRefund(ctx, first, quiet()), false); // a plain submit keeps what it spent
});
test('a refund never reaches another request', () => {
  const ctx = { userMessage: () => ({ source: 'user', id: ctx.id, text: 'pay', session: 's', turn: 't', payment: named }), consent: { consume: () => false }, id: 'a' };
  const one = named_('Apply'); assert.equal(check(ctx, 'click', one).verdict, 'allow');
  assert.equal(deferRefund(ctx, one, quiet()), true);
  ctx.id = 'b'; assert.equal(check(ctx, 'click', target(false)).verdict, 'allow');
  assert.equal(check(ctx, 'click', target(false)).verdict, 'confirm');
});
