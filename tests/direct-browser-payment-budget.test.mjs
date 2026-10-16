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

// SLEIGHT_CONFIRM_PAYMENTS=never: the user's opt-out of the one confirmation for a payment their own message asked for. The figure check blanks the
// page amount when a checkout shows a larger figure; terms.unchecked is the amount as the page states it. It stands in only for a named payment.
const blanked = (extra = {}) => ({ ...target(false), terms: { page: { ...terms.page, amount: undefined }, unchecked: { ...terms.page }, method: 'Fixture card', ...extra } });
const neverCtx = (payment, mode = 'never', consume = () => false, id = 'r1') => ({ ...ctxFor(payment, consume, id), confirmPayments: mode });
const amounted = { ...named, amount: '18.00', payee: 'Fixture shop' };
test('never: a requested payment whose checkout shows a larger figure is allowed', () => {
  assert.equal(check(neverCtx(amounted), 'click', blanked()).verdict, 'allow');
});
test('never: that allow spends the request budget, so a second activation asks', () => {
  const ctx = neverCtx(amounted);
  assert.deepEqual([blanked(), blanked(), target(false)].map(t => check(ctx, 'click', t).verdict), ['allow', 'confirm', 'confirm']);
});
test('never: a payment the user did not request still asks, with or without a figure conflict', () => {
  for (const payment of [undefined, { item: 'Other item', method: 'Fixture card', amount: '18.00' }, { item: 'Fixture item', method: 'Other card', amount: '18.00' }]) {
    assert.equal(check(neverCtx(payment), 'click', blanked()).verdict, 'confirm');
    assert.equal(check(neverCtx(payment), 'click', target(false)).verdict, 'confirm');
  }
});
test('never: the amount, payee or currency the user named must match the page', () => {
  for (const wrong of [{ amount: '17.00' }, { payee: 'Other shop' }, { currency: 'EUR' }]) {
    assert.equal(check(neverCtx({ ...amounted, ...wrong }), 'click', blanked()).verdict, 'confirm', JSON.stringify(wrong));
  }
});
test('never: a user message that names no amount cannot use the unchecked amount', () => {
  assert.equal(check(neverCtx(named), 'click', blanked()).verdict, 'confirm');
});
test('never: unreadable terms still ask, and an unchecked read cannot fill a missing item', () => {
  const t = blanked(); t.terms.unchecked.item = undefined; t.terms.page.item = undefined;
  assert.equal(check(neverCtx(amounted), 'click', t).verdict, 'confirm');
});
test('never: without the unchecked read a blanked amount still asks', () => {
  const t = blanked(); delete t.terms.unchecked;
  assert.equal(check(neverCtx(amounted), 'click', t).verdict, 'confirm');
});
test('never: a page that merely carries unchecked terms cannot unlock the figure check under another setting', () => {
  for (const mode of ['always', 'requested']) assert.equal(check(neverCtx(amounted, mode), 'click', blanked()).verdict, 'confirm', mode);
});
test('always still asks for a requested payment, never or not', () => {
  assert.equal(check(neverCtx(amounted, 'always'), 'click', target(false)).verdict, 'confirm');
  assert.equal(check(neverCtx(amounted, 'requested'), 'click', target(false)).verdict, 'allow');
  assert.equal(check(neverCtx(amounted, 'never'), 'click', target(false)).verdict, 'allow');
});
test('never: consent still approves a payment the user did not request', () => {
  let consumed = 0;
  const ctx = neverCtx(undefined, 'never', () => { consumed++; return true; });
  assert.equal(check(ctx, 'click', target(false)).verdict, 'allow');
  assert.equal(consumed, 1);
});
