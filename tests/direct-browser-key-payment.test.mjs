import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, fixture, terms, input } from './direct-browser-rules-fixture.mjs';

for (const mode of ['form-risk-added', 'payment-wording-added', 'prior-risk-removed', 'ordinary', 'authorized-payment'])
  test(`Enter uses final and prior payment risk: ${mode}`, () => {
    const f = fixture(mode === 'authorized-payment' ? terms : undefined);
    const prior = input({ form: true, formPayment: mode === 'prior-risk-removed' });
    const element = input({ form: true, formPayment: ['form-risk-added', 'authorized-payment'].includes(mode),
      ...(mode === 'payment-wording-added' ? { kind: 'button', tag: 'button', payment: true, submit: true } : {}) });
    const target = f.target({ key: 'Enter', element, prior });
    assert.equal(rules.check(f.ctx, 'press', target).verdict,
      ['ordinary', 'authorized-payment'].includes(mode) ? 'allow' : 'confirm');
    if (mode === 'authorized-payment') assert.equal(rules.check(f.ctx, 'press', target).verdict, 'confirm', 'one request pays once');
  });

for (const key of ['Enter', 'Return', 'Space', ' ']) test(`payment buttons guard activation with ${JSON.stringify(key)}`, () => {
  const f = fixture(), target = f.target({ key, element: input({ kind: 'button', tag: 'button', payment: true, submit: true }) });
  assert.equal(rules.check(f.ctx, 'press', target).verdict, 'confirm');
});
test('text Enter submits a payment form, while textarea Enter and typing card data stay ordinary', () => {
  const f = fixture();
  assert.equal(rules.check(f.ctx, 'press', f.target({ key: 'Enter', element: input({ form: true, formPayment: true }) })).verdict, 'confirm');
  assert.equal(rules.check(f.ctx, 'press', f.target({ key: 'Enter', element: input({ tag: 'textarea', form: true, formPayment: true }) })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'type', f.target({ element: input({ payment: true, formPayment: true }) })).verdict, 'allow');
});
for (const key of ['Shift+Enter', 'Meta+Enter', 'Control+Enter', 'Cmd+Enter', 'Alt+Space'])
  test(`foreground activation chord ${key} is refused before input`, () => {
    const f = fixture(); assert.equal(rules.check(f.ctx, 'press', f.target({ key })).verdict, 'refuse');
  });
