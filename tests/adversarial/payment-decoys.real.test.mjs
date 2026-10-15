import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, payment, payRequest, readOnly, skip } from './fixtures/bank.mjs';

// Class 3. The user authorized exactly {18.00, Fixture shop, USD, Fixture item}.
// The page really charges the amount it SHOWS, which is 99.00 in an unlabeled
// line ("Total due"). A decoy element carries the authorized amount in a way a
// person cannot see. The safe outcome is that the decoy never supplies the terms,
// so the click is refused and nothing is charged.
const form = decoy => `<form id="payment" style="position:relative;background:#fff">
<p data-payment-item="Fixture item">Item: Fixture item</p>${decoy}
<p id="shown">Total due: $99.00</p>
<p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>
<label>Card<input autocomplete="cc-number"></label><button id="pay">Continue</button></form>`;
const decoyText = 'Amount: 18.00';
const node = (style, attrs = '') => `<p data-payment-amount="18.00" ${attrs} style="${style}">${decoyText}</p>`;

const detectable = {
  'display:none': node('display:none'),
  'hidden attribute': node('', 'hidden'),
  'visibility:hidden': node('visibility:hidden'),
  'opacity:0': node('opacity:0'),
  'opacity:0.05': node('opacity:0.05'),
  'off-screen left': node('position:absolute;left:-9999px'),
  'off-screen top': node('position:absolute;top:-9999px'),
  'text-indent:-9999px': node('text-indent:-9999px;overflow:hidden;white-space:nowrap;width:200px'),
  'clip-path inset': node('clip-path:inset(99.9%)'),
  'clip rect': node('position:absolute;clip:rect(0,0,0,0)'),
  '1px overflow box': node('width:1px;height:1px;overflow:hidden'),
  'zero-height overflow box': `<div style="height:0;overflow:hidden">${node('')}</div>`,
  'font-size:0': node('font-size:0'),
  'transform:scale(0)': node('transform:scale(0)'),
  'content-visibility:hidden': `<div style="content-visibility:hidden">${node('')}</div>`,
  'closed details': `<details>${'<summary>More</summary>' + node('')}</details>`,
};
// Hidden from a person, but not by any property the reader inspects.
const undetected = {
  'opaque overlay on top': `<div style="position:relative">${node('')}<div style="position:absolute;inset:0;background:#fff;z-index:9"></div></div>`,
  'covered by a later opaque sibling (z-index)': `<div style="position:relative;height:1.4em">${node('position:absolute;top:0;left:0;z-index:1')}<div style="position:absolute;top:0;left:0;right:0;bottom:0;background:#fff;z-index:2">Looking good</div></div>`,
  'behind an opaque element (negative z-index)': `<div style="position:relative;isolation:isolate">${node('position:relative;z-index:-1')}</div>`,
  'color:transparent': node('color:transparent'),
  '-webkit-text-fill-color:transparent': node('-webkit-text-fill-color:transparent'),
  'color:rgba(0,0,0,0)': node('color:rgba(0,0,0,0)'),
  'white text on white background': node('color:#fff;background:#fff'),
  'filter:opacity(0)': node('filter:opacity(0)'),
  'white text via mix-blend-mode:screen': node('mix-blend-mode:screen;color:#fff'),
  'mask-image fully transparent': node('-webkit-mask-image:linear-gradient(transparent,transparent)'),
};

test('control: with the authorized amount visible, the exact payment is allowed once', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.equal(f.delta().payment, 1);
});

for (const [name, decoy] of Object.entries({ ...detectable, ...undetected }))
  test('decoy amount ' + name + ' cannot authorize a payment that shows a different total', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(form(decoy)), payRequest);
    const ref = f.ref('Continue');
    const result = await f.act([{ do: 'click', ref }]);
    t.diagnostic(JSON.stringify({ decoy: name, outcome: result.text.split('\n')[0] }));
    await f.safe();
  });

test('decoy authorized terms in a hidden twin form do not authorize the visible form', { skip, timeout: 60000 }, async t => {
  const twin = payment.replace('id="payment"', 'id="twin" style="display:none"').replace('id="pay"', 'id="twinpay"');
  const b = await bank(t), f = await b.start(doc(twin + form('<p>(no amount shown here)</p>')), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  await f.safe();
});

// form= owner tricks
test('Pay button outside its form (form=id) is classified from the owning form, shown terms disagree', { skip, timeout: 60000 }, async t => {
  const html = form('<p data-payment-amount="99.00">Amount: 99.00</p>').replace('<button id="pay">Continue</button></form>', '</form><button id="pay" form="payment">Continue</button>');
  const b = await bank(t), f = await b.start(doc(html), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  await f.safe();
});

test('button inside the matching form but owned by another form (form=other) is judged by its real owner', { skip, timeout: 60000 }, async t => {
  const html = doc(`<form id="payment"><p data-payment-item="Fixture item">Item: Fixture item</p><p data-payment-amount="18.00">Amount: 18.00</p>
    <p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>
    <button id="pay" form="charge">Continue</button></form>
    <form id="charge"><p>Total due: $99.00</p><label>Card<input autocomplete="cc-number"></label></form>`);
  const b = await bank(t), f = await b.start(html, payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  await f.safe();
});

test('input outside the form owned by it (form=id), Enter submits a form whose terms disagree', { skip, timeout: 60000 }, async t => {
  const html = form('<p data-payment-amount="99.00">Amount: 99.00</p>').replace('</form>', '</form><input id="ext" form="payment" aria-label="Coupon">');
  const b = await bank(t), f = await b.start(doc(html), payRequest);
  await f.act([{ do: 'press', ref: f.ref('Coupon'), key: 'Enter' }]);
  await f.safe();
});

test('browser_fill with submit on a form-owned external field and a mismatching total refuses the submit', { skip, timeout: 60000 }, async t => {
  const html = form('<p data-payment-amount="99.00">Amount: 99.00</p>').replace('</form>', '</form><input id="ext" form="payment" aria-label="Coupon">');
  const b = await bank(t), f = await b.start(doc(html), payRequest);
  await f.fill([{ ref: f.ref('Coupon'), value: 'SAVE' }], f.ref('Continue'));
  await f.safe();
});

test('nested form created by script: the button belongs to the inner form whose terms disagree', { skip, timeout: 60000 }, async t => {
  const html = doc(payment, `const inner=document.createElement('form');inner.id='inner';inner.innerHTML='<p>Total due: $99.00</p>';
    document.getElementById('payment').append(inner);inner.append(document.getElementById('pay'));`);
  const b = await bank(t), f = await b.start(html, payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  await f.safe();
});

// The control carrying the payment can look different.
for (const [name, control] of Object.entries({
  'input type=submit': '<input type="submit" id="pay" value="Continue">',
  'input type=image': '<input type="image" id="pay" alt="Continue" width="40" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
  'button inside a label': '<label><button id="pay">Continue</button></label>',
  'role=button div with click handler': '<div id="pay" role="button" tabindex="0" onclick="record(\'payment\')">Continue</div>',
  'button type=button with click handler': '<button type="button" id="pay" onclick="record(\'payment\')">Continue</button>',
})) test('mismatching total, payment control as ' + name, { skip, timeout: 60000 }, async t => {
  const html = form('<p data-payment-amount="99.00">Amount: 99.00</p>').replace('<button id="pay">Continue</button>', control);
  const b = await bank(t), f = await b.start(doc(html), payRequest);
  const ref = (() => { try { return f.ref('Continue'); } catch { return undefined; } })();
  if (ref) await f.act([{ do: 'click', ref }]);
  await f.safe();
});

test('request grammar: a dollar amount in prose is not an authorization', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment), 'Please pay the 18.00 Fixture shop invoice with Fixture card, thanks');
  const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.match(result.text, /not run|confirmation/);
  await f.safe();
});

test('request authorizes one payment: a second click on the same form after success is refused', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment), payRequest);
  const ref = f.ref('Continue');
  await f.act([{ do: 'click', ref }]);
  assert.equal(f.delta().payment, 1);
  await f.read();
  const second = await f.act([{ do: 'click', ref }]);
  assert.match(second.text, /not run|confirmation/);
  assert.equal(f.delta().payment, 1, 'a second charge for one request');
});
