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
for (const key of ['Shift+Enter', 'Meta+Enter', 'Control+Enter', 'Cmd+Enter', 'Alt+Space', 'Alt+Enter', 'Control+Shift+Enter', 'Shift+Space', 'Control+ '])
  test(`foreground activation chord ${key} is refused before input on a button`, () => {
    const f = fixture(), result = rules.check(f.ctx, 'press', f.target({ key, element: input({ kind: 'button', tag: 'button' }) }));
    assert.equal(result.verdict, 'refuse');
    assert.equal(result.message, 'This activation chord may open a foreground window. Only Shift+Enter and Control+Enter in a text field are allowed.'
      + (process.env.SLEIGHT_MT === '0' ? ' Use the engine browser path if needed.' : ''));
  });
for (const key of ['Meta+Enter', 'Cmd+Enter', 'Alt+Enter', 'Control+Shift+Enter', 'Shift+Space', 'Control+ ', 'Alt+Space'])
  test(`activation chord ${key} is refused even in a text field`, () => {
    const f = fixture(); assert.equal(rules.check(f.ctx, 'press', f.target({ key, element: input({}) })).verdict, 'refuse');
  });
for (const key of ['Shift+Enter', 'Control+Enter', 'Ctrl+Return']) for (const tag of ['input', 'textarea'])
  test(`chat chord ${key} is allowed in a ${tag}, and counts as a submit in a payment form`, () => {
    const f = fixture(), plain = input({ tag, form: true }), paying = input({ tag, form: true, formPayment: true });
    assert.equal(rules.check(f.ctx, 'press', f.target({ key, element: plain })).verdict, 'allow');
    assert.equal(rules.check(f.ctx, 'press', f.target({ key, element: paying })).verdict, 'confirm');
  });
test('a chat chord is allowed in a role=textbox element and refused in a link', () => {
  const f = fixture();
  assert.equal(rules.check(f.ctx, 'press', f.target({ key: 'Control+Enter', element: input({ tag: 'div', kind: 'text', role: 'textbox' }) })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'press', f.target({ key: 'Shift+Enter', element: input({ tag: 'a', kind: 'link' }) })).verdict, 'refuse');
});
test('activationKey spells Enter and Space for the page keyboard, with their modifiers', () => {
  assert.deepEqual(['Return', '\r', '\n', 'NumpadEnter', 'Shift+Return', 'Ctrl+\n', ' ', 'Space', 'Cmd+Space', 'Option+ '].map(rules.activationKey),
    ['Enter', 'Enter', 'Enter', 'Enter', 'Shift+Enter', 'Control+Enter', 'Space', 'Space', 'Meta+Space', 'Alt+Space']);
  assert.equal(rules.activationKey('Tab'), undefined); assert.equal(rules.activationKey('Control+a'), undefined);
});

for (const control of ['link', 'image']) for (const key of ['Enter', 'Return'])
  test(`payment ${control} guards keyboard activation ${key}`, () => {
    const f = fixture(), element = input({ tag: control === 'link' ? 'a' : 'input', kind: control === 'link' ? 'link' : 'button', payment: true });
    const target = f.target({ element, key });
    assert.equal(rules.check(f.ctx, 'press', target).verdict, 'confirm');
    rules.beginSubmit(f.state, 100);
    assert.equal(rules.check(f.ctx, 'press', target).verdict, 'refuse');
  });
for (const key of ['Space', ' ']) test(`payment image button guards keyboard activation ${JSON.stringify(key)}`, () => {
  const f = fixture();
  assert.equal(rules.check(f.ctx, 'press', f.target({ element: input({ kind: 'button', payment: true }), key })).verdict, 'confirm');
});
test('prior payment link risk survives changed wording for click and Enter', () => {
  for (const kind of ['click', 'press']) {
    const f = fixture(), prior = input({ tag: 'a', kind: 'link', payment: true });
    assert.equal(rules.check(f.ctx, kind, f.target({ prior, element: input({ tag: 'a', kind: 'link' }), key: 'Enter' })).verdict, 'confirm');
  }
});
test('ordinary links and payment field focus remain ordinary while submit is uncertain', () => {
  const f = fixture(); rules.beginSubmit(f.state, 100);
  const link = input({ tag: 'a', kind: 'link' });
  for (const kind of ['click', 'press']) assert.equal(rules.check(f.ctx, kind, f.target({ element: link, key: 'Enter' })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'press', f.target({ element: { ...link, payment: true }, key: 'Space' })).verdict, 'allow');
  const field = input({ form: true, payment: true, formPayment: true });
  for (const kind of ['click', 'type']) assert.equal(rules.check(f.ctx, kind, f.target({ element: field })).verdict, 'allow');
});
