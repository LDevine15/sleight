import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, fixture, terms, input, classify } from './direct-browser-rules-fixture.mjs';

test('TS1: visible Pay text cannot be hidden behind an aria-label of Continue', () => {
  const s = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', { 'aria-label': 'Continue' }, 'Pay $500 now', new Element('form')));
  const f = fixture(); assert.equal(rules.check(f.ctx, 'click', f.target({ element: s })).verdict, 'confirm');
});
test('TS1: input submit value Place order raises payment risk', () => {
  const s = classify(({ Element, HTMLInputElement }) => new HTMLInputElement('input', { type: 'submit', value: 'Place order' }, '', new Element('form')));
  const f = fixture(); assert.equal(rules.check(f.ctx, 'click', f.target({ element: s })).verdict, 'confirm');
});
test('TS1: Enter in a neutral field inherits the owning form payment risk', () => {
  const s = classify(({ Element, HTMLInputElement, HTMLButtonElement }) => {
    const form = new Element('form'); new HTMLButtonElement('button', {}, 'Pay $500', form); return new HTMLInputElement('input', {}, '', form);
  });
  const f = fixture(); assert.equal(rules.check(f.ctx, 'press', f.target({ key: 'Enter', element: s })).verdict, 'confirm');
});
for (const structure of ['card', 'iframe']) test(`TS1: neutral Continue in a ${structure} form is payment`, () => {
  const s = classify(({ Element, HTMLInputElement, HTMLButtonElement }) => {
    const form = new Element('form');
    if (structure === 'card') new HTMLInputElement('input', { autocomplete: 'cc-number' }, '', form);
    else new Element('iframe', { src: 'https://payment.invalid/' }, '', form);
    return new HTMLButtonElement('button', {}, 'Continue', form);
  });
  const f = fixture(); assert.equal(rules.check(f.ctx, 'click', f.target({ element: s })).verdict, 'confirm');
});
test('TS1: a neutral same-origin card iframe still makes the parent form payment-sensitive', () => {
  const s = classify(({ Element, HTMLButtonElement }) => {
    const form = new Element('form'); new Element('iframe', { src: '/card', title: 'Card number' }, '', form);
    return new HTMLButtonElement('button', {}, 'Continue', form);
  });
  const f = fixture(); assert.equal(rules.check(f.ctx, 'click', f.target({ element: s })).verdict, 'confirm');
});
test('TS1: an SPA Send outside a form is a submit and no blind retry is allowed', () => {
  const s = classify(({ Element }) => new Element('div', { role: 'button' }, 'Send', new Element('main')));
  const f = fixture(), target = f.target({ element: s });
  assert.equal(rules.check(f.ctx, 'click', target).verdict, 'allow');
  const submit = rules.beginSubmit(f.state, 100); rules.finishSubmit(f.state, submit, {}, 5100);
  assert.equal(rules.check(f.ctx, 'click', target).verdict, 'refuse');
});
test('TS1: dismissing a payment dialog never pays or needs a payment approval', () => {
  const f = fixture(); assert.equal(rules.check(f.ctx, 'dialog', f.pay({ accept: false })).verdict, 'allow');
});
for (const flag of ['connected', 'visible', 'enabled', 'hit']) test(`TS1: final target ${flag}=false refuses input`, () => {
  const f = fixture(terms); assert.equal(rules.check(f.ctx, 'click', f.pay({ element: input({ submit: true, payment: true, [flag]: false }) })).verdict, 'refuse');
});
for (const flag of ['payment', 'submit', 'form', 'formPayment']) test(`missing ${flag} classification refuses activation`, () => {
  const f = fixture(); assert.equal(rules.check(f.ctx, 'click', f.target({ element: input({ [flag]: undefined }) })).verdict, 'refuse');
});
for (const tag of ['iframe', 'frame', 'object', 'embed']) for (const kind of ['click', 'press', 'scroll'])
  test(`TF1R: a ${tag} host cannot confer child control authority to ${kind}`, () => {
    const f = fixture(); assert.equal(rules.check(f.ctx, kind, f.target({ key: 'Enter', element: input({ tag }) })).verdict, 'refuse');
  });
test('v3: qualified child-frame controls are checked by their own metadata and payment terms', () => {
  const f = fixture();
  assert.equal(rules.check(f.ctx, 'type', f.target({ element: input({ frameLocal: true, payment: true }) })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'press', f.target({ key: 'Enter', element: input({ frameLocal: true, form: true, formPayment: true }) })).verdict, 'confirm');
});
for (const kind of ['file', 'color', 'select']) test(`TS1: clicks cannot open native ${kind} panels`, () => {
  const f = fixture(); const result = rules.check(f.ctx, 'click', f.target({ element: input({ kind }) }));
  assert.equal(result.verdict, 'refuse'); assert.match(result.message, /browser_fill|upload/);
});
test('TS1: filling payment-labelled text never pays or submits', () => {
  const f = fixture(); assert.equal(rules.check(f.ctx, 'type', f.target({ element: input({ payment: true, form: true, formPayment: true }) })).verdict, 'allow');
});
test('clicking a payment-labelled text field only focuses that field', () => {
  const f = fixture(); assert.equal(rules.check(f.ctx, 'click', f.target({ element: input({ payment: true, form: true, formPayment: true }) })).verdict, 'allow');
});
test('page-opened payment dialogs raise risk independently of the prior click', () => {
  const f = fixture(); assert.equal(rules.check(f.ctx, 'dialog', f.target({ accept: true, message: 'Pay $18.00 now?' })).verdict, 'confirm');
});

for (const control of ['link', 'image']) for (const pending of [false, true])
  test(`payment ${control} click requires authority and respects pending=${pending}`, () => {
    const element = classify(({ Element, HTMLInputElement }) => control === 'link'
      ? new Element('a', { href: '/charge' }, 'Pay $18 now')
      : new HTMLInputElement('input', { type: 'image', value: 'Pay $18 now' }, '', new Element('form')));
    assert.equal(element.payment, true);
    const f = fixture(), target = f.target({ element });
    if (pending) { const submit = rules.beginSubmit(f.state, 100); rules.finishSubmit(f.state, submit, {}, 5100); }
    assert.equal(rules.check(f.ctx, 'click', target).verdict, pending ? 'refuse' : 'confirm');
  });

for (const control of ['link', 'image']) test(`one private request activates the payment ${control} once`, () => {
  const element = classify(({ Element, HTMLInputElement }) => control === 'link'
    ? new Element('a', { href: '/charge' }, 'Pay $18 now')
    : new HTMLInputElement('input', { type: 'image', value: 'Pay $18 now' }, '', new Element('form')));
  const f = fixture(terms), target = f.target({ element });
  assert.equal(rules.check(f.ctx, 'click', target).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'click', target).verdict, 'confirm');
});

test('payment anchor metadata from the v3 action inspector cannot be treated as editable text', () => {
  const f = fixture(), element = input({ tag: 'a', kind: 'text', payment: true });
  assert.equal(rules.check(f.ctx, 'click', f.target({ element })).verdict, 'confirm');
});

for (const control of ['file', 'color', 'select']) for (const key of ['Space', ' ', 'Enter', 'Return'])
  test(`native ${control} picker refuses ${JSON.stringify(key)} before input`, () => {
    const element = classify(({ Element, HTMLInputElement }) => control === 'select'
      ? new Element('select') : new HTMLInputElement('input', { type: control }));
    const f = fixture(), result = rules.check(f.ctx, 'press', f.target({ element, key }));
    assert.equal(result.verdict, 'refuse'); assert.match(result.message, /browser_fill|upload/);
  });

for (const key of ['Alt+ArrowDown', 'F4']) test(`select refuses its picker-opening ${key}`, () => {
  const element = classify(({ Element }) => new Element('select')), f = fixture();
  assert.equal(rules.check(f.ctx, 'press', f.target({ element, key })).verdict, 'refuse');
});
for (const kind of ['file', 'color', 'select']) for (const key of ['Tab', 'Escape', 'ArrowLeft'])
  test(`native ${kind} keeps harmless ${key} available`, () => {
    const f = fixture(); assert.equal(rules.check(f.ctx, 'press', f.target({ element: input({ kind }), key })).verdict, 'allow');
  });
test('Enter in a neutral field inherits payment risk from an image submit', () => {
  const element = classify(({ Element, HTMLInputElement }) => {
    const form = new Element('form'); new HTMLInputElement('input', { type: 'image', value: 'Pay $18 now' }, '', form);
    return new HTMLInputElement('input', {}, '', form);
  });
  const f = fixture(); assert.equal(rules.check(f.ctx, 'press', f.target({ element, key: 'Enter' })).verdict, 'confirm');
});
for (const control of ['file', 'color', 'select']) test(`native ${control} remains a picker when its ARIA role is button`, () => {
  const element = classify(({ Element, HTMLInputElement }) => control === 'select'
    ? new Element('select', { role: 'button' }) : new HTMLInputElement('input', { type: control, role: 'button' }));
  const f = fixture();
  for (const [kind, key] of [['click', undefined], ['press', 'Space']])
    assert.equal(rules.check(f.ctx, kind, f.target({ element, key })).verdict, 'refuse');
});
