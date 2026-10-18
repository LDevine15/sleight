import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, fixture, terms, classify } from './direct-browser-rules-fixture.mjs';

// A real-href link outside a payment form is navigation. Everything else with payment words keeps the payment rule.
const link = (attrs, text, wrap) => classify(({ Element }) => new Element('a', attrs, text, wrap?.(Element)));
const verdict = (element, kind = 'click') => { const f = fixture(); return rules.check(f.ctx, kind, f.target({ element, key: 'Enter' })).verdict; };

test('a Go to checkout link with a real href is navigation: no payment, no submit, allowed without consent', () => {
  for (const href of ['/shop/checkout/address', 'https://shop.invalid/checkout', '//shop.invalid/checkout', '?step=checkout', 'checkout/address']) {
    const element = link({ href }, 'Go to checkout');
    assert.equal(element.payment, false, href); assert.equal(element.submit, false, href);
    assert.equal(verdict(element), 'allow', href); assert.equal(verdict(element, 'press'), 'allow', href);
  }
});

test('following the link does not spend the request payment budget: the priced Place order after it still proceeds, once', () => {
  const nav = link({ href: '/shop/checkout/address' }, 'Go to checkout');
  const place = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Place order', new Element('main')));
  assert.equal(place.payment, true);
  const f = fixture(terms);
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: nav })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: place })).verdict, 'allow', 'the payment the message priced');
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: place })).verdict, 'confirm', 'one activation per request');
});

test('an unpriced Place order button still asks, as does a Checkout button outside any form', () => {
  const place = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Place order', new Element('main')));
  const checkout = classify(({ Element }) => new Element('button', {}, 'Checkout', new Element('main')));
  const bare = classify(({ HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Checkout'));
  for (const element of [place, checkout, bare]) { assert.equal(element.payment, true); assert.equal(verdict(element), 'confirm'); }
});

test('hrefs that are not a navigation stay payments: #, javascript: in every spelling, no href, mailto:, data:', () => {
  const hrefs = ['#', '#checkout', 'javascript:void(0)', 'JavaScript:buy()', '  javascript:buy()', 'java\tscript:buy()', 'java\nscript:buy()',
    '\u0001javascript:buy()', 'mailto:pay@shop.invalid', 'tel:5551212', 'data:text/html,x', 'vbscript:x', ''];
  for (const href of hrefs) {
    const element = link({ href }, 'Buy now');
    assert.equal(element.payment, true, JSON.stringify(href)); assert.equal(verdict(element), 'confirm', JSON.stringify(href));
  }
  const none = link({}, 'Go to checkout'); assert.equal(none.payment, true); assert.equal(verdict(none), 'confirm');
});

test('a link in a payment form stays a payment; one in a form without payment fields is navigation', () => {
  const inCard = link({ href: '/shop/checkout/order' }, 'Go to checkout', Element => {
    const form = new Element('form'); new Element('input', { autocomplete: 'cc-number' }, '', form); return form;
  });
  assert.equal(inCard.payment, true); assert.equal(inCard.formPayment, true); assert.equal(verdict(inCard), 'confirm');
  const inPayButton = link({ href: '/next' }, 'Checkout', Element => {
    const form = new Element('form'); new Element('button', {}, 'Pay now', form); return form;
  });
  assert.equal(verdict(inPayButton), 'confirm');
  const inPlain = link({ href: '/shop/checkout/address' }, 'Go to checkout', Element => new Element('form'));
  assert.equal(inPlain.payment, false); assert.equal(verdict(inPlain), 'allow');
});

test('a script-driven link stays guarded: inline handler, button or other role, non-anchor link, or a money figure in its words', () => {
  const guarded = [
    link({ href: '/shop/checkout', onclick: 'form.submit()' }, 'Go to checkout'),
    link({ href: '/shop/checkout', onmousedown: 'x()' }, 'Go to checkout'),
    link({ href: '/shop/checkout', role: 'button' }, 'Go to checkout'),
    link({ href: '/shop/checkout', role: 'menuitem' }, 'Go to checkout'),
    classify(({ Element }) => new Element('div', { role: 'link', href: '/shop/checkout' }, 'Go to checkout')),
    link({ href: '/charge' }, 'Pay $18 now'), link({ href: '/charge' }, 'Buy for 18.00'), link({ href: '/charge' }, 'Subscribe, 18 USD'),
  ];
  for (const [index, element] of guarded.entries()) { assert.equal(element.payment, true, String(index)); assert.equal(verdict(element), 'confirm', String(index)); }
});

test('an attribute list that cannot be read leaves the link guarded', () => {
  const element = classify(({ Element }) => { delete Element.prototype.getAttributeNames; return new Element('a', { href: '/shop/checkout' }, 'Go to checkout'); });
  assert.equal(element.payment, true); assert.equal(verdict(element), 'confirm');
});

test('navigation leaves the submit fence and the figure check alone', () => {
  const f = fixture(terms), save = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Save', new Element('form')));
  rules.beginSubmit(f.state, 100);
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: save })).verdict, 'refuse');
  const nav = link({ href: '/shop/checkout/address' }, 'Go to checkout');
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: nav })).verdict, 'allow');
  // A priced payment whose page terms the figure check blanked (a larger figure on the checkout) still asks.
  const g = fixture(terms), pay = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Place order', new Element('main')));
  assert.equal(rules.check(g.ctx, 'click', g.target({ element: pay, terms: { page: { ...terms, amount: undefined }, method: terms.method } })).verdict, 'confirm');
});
