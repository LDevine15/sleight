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

// Round 2. STRICT: a term only authorizes if a person could see it. The form below shows no other amount, so a
// decoy that is hidden by any means leaves no visible amount and the payment must ask.
const quiet = amount => `<form id="payment" style="position:relative;background:#fff"><p data-payment-item="Fixture item">Item: Fixture item</p>${amount}
<p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>
<label>Card<input autocomplete="cc-number"></label><button id="pay">Continue</button></form>`;
const amountP = (style = '', inner = '') => `<p data-payment-amount="18.00" style="margin:0;position:relative;width:max-content;${style}">Amount: 18.00${inner}</p>`;
const over = style => `<span style="position:absolute;left:0;top:0;width:100%;height:100%;${style}"></span>`;
const svgWhite = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27%3E%3Crect width=%27100%25%27 height=%27100%25%27 fill=%27%23@@%27/%3E%3C/svg%3E';
const hiddenFromPerson = {
  'white cover with pointer-events:none': amountP('', over('background:#fff;pointer-events:none')),
  'white cover as a child of the term': amountP('', over('background:#fff')),
  '::after white cover': '<style>.z::after{content:"";position:absolute;inset:0;background:#fff}</style>' + amountP().replace('<p ', '<p class="z" '),
  'opaque canvas on top': amountP('', '<canvas width="300" height="40" style="position:absolute;left:0;top:0;pointer-events:none"></canvas><script>var c=document.querySelector("canvas").getContext("2d");c.fillStyle="#fff";c.fillRect(0,0,300,40)</script>'),
  'svg on top': amountP('', '<svg style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none"><rect width="100%" height="100%" fill="#fff"/></svg>'),
  'backdrop-filter overlay': amountP('', over('backdrop-filter:blur(14px);pointer-events:none')),
  'inset box-shadow overlay': amountP('', over('box-shadow:inset 0 0 0 200px #fff;pointer-events:none')),
  'thick border overlay': amountP('', over('border:200px solid #fff;box-sizing:border-box;pointer-events:none')),
  'img on top': amountP('', '<img alt="" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none" src="' + svgWhite.replace('@@', 'fff') + '">'),
  '::before with a background on an overlay': '<style>.o::before{content:"";position:absolute;inset:0;background:#fff}</style>' + amountP('', '<span class="o" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none"></span>'),
  'black text over a black z-index:-1 sibling': `<div style="position:relative;width:max-content"><div style="position:absolute;inset:0;background:#000;z-index:-1"></div>${amountP('color:#000')}</div>`,
  'black text over a black img': `<div style="position:relative;width:max-content">${amountP('color:#000')}<img alt="" style="position:absolute;inset:0;width:100%;height:100%;z-index:-1" src="${svgWhite.replace('@@', '000')}"></div>`,
  'filter:blur': amountP('filter:blur(6px)'),
  'filter:brightness(0) invert(1)': amountP('filter:brightness(0) invert(1)'),
  '5px font': amountP('font-size:5px'),
  'opacity 0.10 (contrast about 1.3)': amountP('opacity:.1'),
  'opaque cover over the digits only': amountP('', '<span style="position:absolute;right:0;top:0;width:60%;height:100%;background:#fff;pointer-events:none"></span>'),
};
for (const [name, decoy] of Object.entries(hiddenFromPerson))
  test('hidden amount (' + name + ') never supplies the terms: the payment asks', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(quiet(decoy)), payRequest);
    const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.match(result.text, /not run|confirmation/);
    await f.safe();
  });

// LOOSE: anything rendered that shows a different payable figure forces an ask, even where a person might not look.
const conflicting = {
  'Total line': '<p>Total: $500.00</p>',
  'two totals on one line': '<p>Total: $18.00 <span>Total due now: $500.00</span></p>',
  'Price': '<p>Price: $500.00</p>',
  'Payment': '<p>Payment: $500.00</p>',
  'long qualifier': '<p>Total for your order including tax and shipping: $500.00</p>',
  '::before content': '<style>.t::before{content:"Total: $500.00"}</style><p class="t"></p>',
  'input value': '<input readonly value="Total: $500.00" size="20" aria-label="summary">',
  'open shadow root': '<div id="h"></div><script>document.getElementById("h").attachShadow({mode:"open"}).innerHTML="<p>Total: $500.00</p>"</script>',
  'below the fold': '<div style="height:2000px"></div><p>Total: $500.00</p>',
  'low contrast': '<p style="color:#e8e8e8">Total: $500.00</p>',
  '5px font': '<p style="font-size:5px">Total: $500.00</p>',
  'same-origin iframe': '<iframe srcdoc="Total: $500.00" style="width:200px;height:40px"></iframe>',
  'label and figure in separate blocks': '<div>Total due</div><div>$500.00</div>',
};
for (const [name, extra] of Object.entries(conflicting))
  test('visible amount matches but a rendered ' + name + ' shows another payable figure: the payment asks', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', extra + '<button id="pay">')), payRequest);
    const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.match(result.text, /not run|confirmation/);
    await f.safe();
  });
test('the activating button names a different amount: the payment asks', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment.replace('>Continue<', '>Pay $500.00<')), payRequest);
  const result = await f.act([{ do: 'click', ref: f.ref('Pay $500.00') }]);
  assert.match(result.text, /not run|confirmation/);
  await f.safe();
});

// Honest pages: figures that are not the payable total must not force an ask.
const honestLines = ['Total (3 items): $18.00', 'Total includes 8% tax: $18.00', 'Total before tax: $16.50', 'Tax amount: $1.50', 'Total savings: $2.00',
  'Available balance: $250.00', 'Subtotal: $16.50', 'Shipping: $1.50', 'You save: $2.00 (Amount saved $2.00)', 'Due today: $18.00', 'Order total: $18.00 (includes $2.00 tax)'];
for (const line of honestLines)
  test('honest line "' + line + '" does not stop the exact payment', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', '<p>' + line + '</p><button id="pay">')), payRequest);
    await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.equal(f.delta().payment, 1);
  });
const honestPages = {
  'gradient body with no opaque card': payment.replace('<form', '<style>body{background:linear-gradient(#fff,#eee)}</style><form'),
  'dark color-scheme with no explicit background': payment.replace('<form', '<style>:root{color-scheme:dark}</style><form'),
};
for (const [name, html] of Object.entries(honestPages))
  test('honest page (' + name + ') still pays once', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(html), payRequest);
    await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.equal(f.delta().payment, 1);
  });

// Script-driven buttons in a payment form are payment controls and share the request's one payment activation with the real submit.
for (const [name, control, label] of [['button type=button', '<button type="button" id="aux" onclick="record(\'aux\')">Apply coupon</button>', 'Apply coupon'],
    ['div role=button', '<div role="button" tabindex="0" id="aux" onclick="record(\'aux\')">Edit</div>', 'Edit']])
  test('clicking ' + name + ' (' + label + ') in the card form spends the request\'s one payment: the real Pay then asks', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', control + '<button id="pay">')), payRequest);
    const first = await f.act([{ do: 'click', ref: f.ref(label) }]);
    assert.doesNotMatch(first.text, /confirmation/);
    await f.read();
    const pay = await f.act([{ do: 'click', ref: f.ref('Continue', await f.read()) }]);
    assert.match(pay.text, /not run|confirmation/);
    assert.equal(f.delta().payment, 0);
  });
test('a script-driven button without a matching user request still asks', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', '<button type="button" id="aux">Apply coupon</button><button id="pay">')), readOnly);
  const result = await f.act([{ do: 'click', ref: f.ref('Apply coupon') }]);
  assert.match(result.text, /not run|confirmation/);
  await f.safe();
});
test('button type=reset in the card form is not a payment control', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', '<button type="reset" id="clear">Clear form</button><button id="pay">')), readOnly);
  const result = await f.act([{ do: 'click', ref: f.ref('Clear form') }]);
  assert.doesNotMatch(result.text, /not run|confirmation/);
  await f.safe();
});

// Round 3. A script-only button that looks like a charge gets one activation per request, not one per fresh read.
test('a script-only pay-looking button can be activated once per request: the second activation asks', { skip, timeout: 60000 }, async t => {
  const html = doc(payment.replace('<button id="pay">Continue</button>', '<div role="button" tabindex="0" id="aux" onclick="record(\'aux\')">Confirm choice</div>'));
  const b = await bank(t), f = await b.start(html, payRequest);
  const first = await f.act([{ do: 'click', ref: f.ref('Confirm choice') }]);
  assert.doesNotMatch(first.text, /not run|confirmation/);
  const fresh = await f.read();
  const second = await f.act([{ do: 'click', ref: f.ref('Confirm choice', fresh) }]);
  assert.match(second.text, /not run|confirmation/);
  await f.safe();
});
test('coupon Apply followed by the real Pay: the second asks, one activation per request', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', '<button type="button" id="aux" onclick="record(\'aux\')">Apply coupon</button><button id="pay">')), payRequest);
  const first = await f.act([{ do: 'click', ref: f.ref('Apply coupon') }]);
  assert.doesNotMatch(first.text, /not run|confirmation/);
  const fresh = await f.read();
  const pay = await f.act([{ do: 'click', ref: f.ref('Continue', fresh) }]);
  assert.match(pay.text, /not run|confirmation/);
  assert.equal(f.delta().payment, 0);
});
test('the real Pay first, then a script-driven button: the second asks', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', '<button type="button" id="aux" onclick="record(\'aux\')">Apply coupon</button><button id="pay">')), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.equal(f.delta().payment, 1);
  const second = await f.act([{ do: 'click', ref: f.ref('Apply coupon', await f.read()) }]);
  assert.match(second.text, /not run|confirmation/);
});

// Round 4. Conflicting figures the first scan missed: figure first, split over lines, fullwidth digits,
// an image where the figure should be, and exemption words that hide a real total.
const img = (w, h) => '<img alt="" width="' + w + '" height="' + h + '" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27' + w + '%27 height=%27' + h + '%27%3E%3Ctext y=%2716%27 font-size=%2716%27%3E$500.00%3C/text%3E%3C/svg%3E">';
const conflicting4 = {
  'figure first: due today': '<p>$500.00 due today</p>',
  'figure first: total': '<p>$500.00 total</p>',
  'billed ... today': '<p>You will be billed $500.00 today</p>',
  'label, qualifier and figure on three lines': '<div>Total</div><div>(incl. VAT)</div><div>$500.00</div>',
  'fullwidth digits': '<p>Total: $&#xFF15;&#xFF10;&#xFF10;.&#xFF10;&#xFF10;</p>',
  'zero-width space inside the figure': '<p>Total: $&#x200B;500.00</p>',
  'a 70x20 image where the figure should be': '<p>Total: ' + img(70, 20) + '</p>',
  'Total before tax': '<p>Total before tax: $500.00</p>',
  'Subtotal': '<p>Subtotal: $500.00</p>',
  'Item total': '<p>Item total: $500.00</p>',
  'a leading "Includes tax & fees." sentence': '<p>Includes tax &amp; fees. Total due: $500.00</p>',
  'a discount that does not close the gap': '<p>Total after $2.00 discount: $500.00</p>',
  'Total (incl. VAT)': '<p>Total (incl. VAT): $500.00</p>',
  'a unit price above the amount': '<p>Price: $500.00 each</p>',
};
for (const [name, extra] of Object.entries(conflicting4))
  test('round 4: a rendered ' + name + ' shows another payable figure: the payment asks', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', () => extra + '<button id="pay">')), payRequest);
    const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.match(result.text, /not run|confirmation/);
    await f.safe();
  });

// Ways to hide the amount that the first visibility check missed.
const hidden4 = {
  'input value blocks over the text': amountP('', '<input readonly value="\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588" style="position:absolute;left:0;top:0;width:200px;height:20px;border:0;background:transparent;color:#000;padding:0">'),
  'in-flow ::before blocks on a transparent placed box': '<style>.k::before{content:"\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588";font-size:20px}</style>' + amountP('', '<span class="k" style="position:absolute;left:0;top:0;white-space:nowrap;line-height:20px"></span>'),
  'thick white outline on a 1px box': amountP('', '<span style="position:absolute;left:5px;top:5px;width:1px;height:1px;outline:300px solid #fff"></span>'),
  'outer box-shadow spread on a 1px box': amountP('', '<span style="position:absolute;left:5px;top:5px;width:1px;height:1px;box-shadow:0 0 0 2000px #fff"></span>'),
  'drop-shadow filter on a 1px box': amountP('', '<span style="position:absolute;left:5px;top:5px;width:1px;height:1px;background:#fff;filter:drop-shadow(0 0 200px #fff)"></span>'),
  'popover ::backdrop': '<style>#pop::backdrop{background:#fff}#pop{width:1px;height:1px;padding:0;border:0}</style><div popover="manual" id="pop"></div><script>document.getElementById("pop").showPopover()</script>' + amountP(),
  'thick line-through': amountP('text-decoration:line-through;text-decoration-thickness:30px;text-decoration-color:#000'),
  'text-stroke': amountP('-webkit-text-stroke:10px #fff'),
  'mirrored scaleX(-1)': amountP('transform:scaleX(-1);display:inline-block'),
  'bidi override': amountP('unicode-bidi:bidi-override;direction:rtl'),
};
for (const [name, decoy] of Object.entries(hidden4))
  test('round 4: hidden amount (' + name + ') never supplies the terms: the payment asks', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(quiet(decoy)), payRequest);
    const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.match(result.text, /not run|confirmation/);
    await f.safe();
  });

// Honest wording that is not a conflicting total.
const honest4 = ['Pay in 4 payments of $4.50', 'Pay in 4 interest-free payments of $4.50', 'Price: $9.00 each x 2', 'Cost per unit: $9.00', 'Total after $2.00 discount: $18.00',
  'Total (incl. $1.50 tax): $18.00', 'Total (incl. $1.50 tax): $18.00. Subtotal: $16.50', 'Cashback: $1.80 total savings'];
for (const line of honest4)
  test('round 4: honest line "' + line + '" does not stop the exact payment', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', '<p>' + line + '</p><button id="pay">')), payRequest);
    await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.equal(f.delta().payment, 1);
  });
test('round 4: a subtotal above the amount with a visible discount line that closes the gap still pays', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', '<p>Subtotal: $22.00</p><p>Discount: $4.00</p><button id="pay">')), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.equal(f.delta().payment, 1);
});
test('round 4: terms below the fold still pay once', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<div style="height:2400px"></div>' + payment), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.equal(f.delta().payment, 1);
});

// Round 5. Two round-4 tests changed with the default-deny design (payment-checkouts.real.test.mjs has the rest).
// A figure in another currency than the page's now asks, so the honest "Total: $18.00 USD (about $24.50 CAD)" moved here.
test('round 5: a line with another currency ("about $24.50 CAD" under Currency: USD) asks', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', '<p>Total: $18.00 USD (about $24.50 CAD)</p><button id="pay">')), payRequest);
  const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.match(result.text, /not run|confirmation/);
  await f.safe();
});
// The empty-box rule that asked on a possible closed shadow root is gone (it asked on spacers, icons and radios). The text of
// a closed root with no light children is therefore not read: a known limit in docs/known-problems.md, asserted so it stays visible.
test('round 5 known limit: a closed shadow root holding another total is not read', { skip, timeout: 60000 }, async t => {
  const extra = '<div id="h"></div><script>document.getElementById("h").attachShadow({mode:"closed"}).innerHTML="<p>Total: $500.00</p>"</script>';
  const b = await bank(t), f = await b.start(doc(payment.replace('<button id="pay">', () => extra + '<button id="pay">')), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.equal(f.delta().payment, 1);
});
