import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { bank, doc, skip, payRequest } from './fixtures/bank.mjs';
import { trustedLocatorRead } from '../../plugins/sleight/lib/direct-browser/trusted-dom.mjs';
import { readPaymentPage } from '../../plugins/sleight/lib/direct-browser/v3-context.mjs';

// Round 5. The user named {18.00, Fixture item, Fixture shop, USD}. Part 1 clicks Pay on realistic checkout pages through the
// real route (the false-ask rate). Part 2 reads the terms of many layouts and bypass wordings directly: "allow" means the
// page's visible Amount was accepted as the payment terms, "ask" means a conflicting figure made the read give up.
const meta = (item = 'Fixture item', payee = 'Fixture shop', cur = 'USD') =>
  `<p data-payment-item="${item}">Item: ${item}</p><p data-payment-payee="${payee}">Payee: ${payee}</p><p data-payment-currency="${cur}">Currency: ${cur}</p>`;
const amt = (v = '18.00') => `<span data-payment-amount="${v}">${v}</span>`;
const card = '<label>Card number<input autocomplete="cc-number" inputmode="numeric"></label> <label>Expiry<input autocomplete="cc-exp"></label> <label>CVC<input autocomplete="cc-csc"></label>';

async function payOnce(t, html, label, { before = [], head = '' } = {}) {
  const b = await bank(t), f = await b.start(doc(html, '', head), payRequest);
  let out = f.opened; if (/Snapshot unavailable/.test(f.opened)) out = await f.read();
  for (const step of before) { await f.act([{ do: 'click', ref: f.ref(step, out) }]); out = await f.read(); }
  const result = await f.act([{ do: 'click', ref: f.ref(label, out) }]);
  await new Promise(resolve => setTimeout(resolve, 400));
  return { payment: f.delta().payment, text: result.text.split('\n')[0] };
}

// Direct reads: one browser for the whole list, one subtest per case.
async function readCases(t, cases, selector = '#pay') {
  const b = await bank(t), page = await b.host.newPage();
  try {
    for (const [name, html, expect] of cases)
      await t.test(name, async () => {
        await page.setContent('<!doctype html><body style="margin:8px"><main>' + html);
        let amount; try { amount = (await trustedLocatorRead(page.locator(selector).first(), readPaymentPage)).page?.amount; } catch { amount = undefined; }
        assert.equal(amount === '18.00' ? 'allow' : 'ask', expect, name + ' read amount=' + amount);
      });
  } finally { await page.close(); }
}
const form = (inner, head = '') => `${head}<form id="payment">${meta()}${inner}<label>Card<input autocomplete="cc-number"></label><button id="pay">Pay</button></form>`;
const withAmount = (inner, extra = '') => `<form id="payment">${meta()}<p>Amount: ${amt()}</p>${inner}${extra}<label>Card<input autocomplete="cc-number"></label><button id="pay">Pay</button></form>`;

// ---------------------------------------------------------------- Part 1. Realistic checkout pages, real route
const css = '<style>body{font:14px system-ui}table{width:320px;border-collapse:collapse}td{padding:4px 0}td:last-child{text-align:right}.row{display:flex;justify-content:space-between;width:320px;padding:4px 0}.spacer{height:16px}.lock{width:16px;height:16px}.checkmark{display:inline-block;width:20px;height:20px;border:2px solid #888;border-radius:50%;vertical-align:middle}.brand{display:inline-block;width:38px;height:24px;background:#ddd;border-radius:3px}.thumb{width:48px;height:48px}</style>';
const thumb = '<img class="thumb" alt="Fixture item" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
const lockSvg = '<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 7V5a4 4 0 0 1 8 0v2h1v8H3V7z"/></svg>';
const row = (l, v) => `<div class="row"><span>${l}</span><span>${v}</span></div>`;
const pages = {
  'R1 table summary (subtotal, shipping, tax, total)': [`${css}<form id="payment">${meta()}<h2>Order summary</h2><table><tr><td>Fixture item × 2</td><td>$18.00</td></tr></table><table><tr><td>Subtotal</td><td>$15.00</td></tr><tr><td>Shipping</td><td>$2.00</td></tr><tr><td>Taxes</td><td>$1.00</td></tr><tr><td><b>Total</b></td><td><b>USD $${amt()}</b></td></tr></table>${card}<button id="pay">Pay now</button></form>`, 'Pay now'],
  'R2 flex summary, svg lock, card-brand badges, spacers': [`${css}<form id="payment">${meta()}<div class="spacer"></div>${row('Subtotal', '$15.00')}${row('Shipping', '$2.00')}${row('Tax', '$1.00')}${row('<b>Total</b>', '<b>$' + amt() + '</b>')}<div class="spacer"></div><span class="brand"></span><span class="brand"></span><div>${lockSvg} Secure payment</div>${card}<button id="pay">Pay $18.00</button></form>`, 'Pay $18.00'],
  'R3 dl summary, custom radios, coupon Apply': [`${css}<form id="payment">${meta()}<fieldset><legend>Shipping</legend><label><input type="radio" name="s" checked> Standard <span class="checkmark"></span></label><label><input type="radio" name="s"> Express <span class="checkmark"></span></label></fieldset><label>Discount code <input name="code"></label><button type="button">Apply</button><dl><dt>Subtotal</dt><dd>$15.00</dd><dt>Shipping</dt><dd>$2.00</dd><dt>Tax</dt><dd>$1.00</dd><dt>Total</dt><dd>$${amt()}</dd></dl>${card}<button id="pay">Place order</button></form>`, 'Place order'],
  'R5 inline "Label: value" rows': [`${css}<form id="payment">${meta()}<p>Subtotal: $15.00</p><p>Shipping: $2.00</p><p>Tax: $1.00</p><p>Total: $${amt()}</p>${card}<button id="pay">Pay now</button></form>`, 'Pay now'],
  'R6 subscription, flex rows, trial note': [`${css}<form id="payment">${meta()}<h3>Pro plan</h3>${row('Pro plan (monthly)', '$18.00')}${row('Tax', '$0.00')}${row('Total due today', '$' + amt())}<p style="color:#666">Then $18.00 per month. Cancel anytime.</p>${card}<button id="pay">Subscribe</button></form>`, 'Subscribe'],
  'R7 flex Subtotal, Discount, free Shipping, Total': [`${css}<form id="payment">${meta()}${row('Subtotal', '$20.00')}${row('Discount (SAVE10)', '-$2.00')}${row('Shipping', 'FREE')}${row('Total', '$' + amt())}${card}<button id="pay">Complete order</button></form>`, 'Complete order'],
  'R8 express-pay row, "or" divider, table summary': [`${css}<form id="payment">${meta()}<div style="display:flex;gap:8px"><button type="button" style="width:120px;height:40px;background:#000;color:#fff" aria-label="Apple Pay"><svg width="36" height="14"><rect width="36" height="14"/></svg></button><button type="button" style="width:120px;height:40px;background:#ffc439">PayPal</button></div><div style="text-align:center;width:250px">— or —</div><table><tr><td>Items</td><td>$16.00</td></tr><tr><td>Tax</td><td>$2.00</td></tr><tr><td>Total</td><td>$${amt()}</td></tr></table>${card}<button id="pay">Pay</button></form>`, 'Pay'],
  'R9 sticky footer Place order, table summary': [`${css}<form id="payment">${meta()}<table><tr><td>Items</td><td>$16.00</td></tr><tr><td>Tax</td><td>$2.00</td></tr><tr><td>Total</td><td>$${amt()}</td></tr></table>${card}</form><div style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#fff;box-shadow:0 -2px 6px rgba(0,0,0,.2)"><button form="payment" id="pay">Place order</button></div>`, 'Place order'],
  'P1 cart summary with line item and coupon': [`<style>body{font:14px sans-serif}table{border-collapse:collapse}td{padding:4px 8px}</style><form id="payment"><h2>Order summary</h2>${meta()}<table><tr><td>Fixture item × 2</td><td>$9.00 each</td><td>$18.00</td></tr></table><table><tr><td>Subtotal</td><td>$15.00</td></tr><tr><td>Shipping</td><td>$2.00</td></tr><tr><td>Tax</td><td>$1.00</td></tr><tr><td><b>Total</b></td><td><b>$${amt()}</b></td></tr></table><label>Coupon <input name="coupon"></label><button type="button">Apply</button><label>Card<input autocomplete="cc-number"></label><button id="pay">Pay now</button></form>`, 'Pay now'],
  'P2 icons, spacers, steppers': [`<style>.ic{width:24px;height:24px;background:url("data:image/gif;base64,R0lGODlhAQABAAAAACw=") center no-repeat;display:inline-block}.sp{height:16px;width:100%}.chip{display:inline-block;width:40px;height:12px;background:#eee}</style><form id="payment"><div class="sp"></div>${meta()}<div class="sp"></div><div><span class="ic"></span> Fixture item <button type="button" aria-label="Decrease quantity">-</button> 2 <button type="button" aria-label="Increase quantity">+</button></div><div class="sp"></div><div><span class="chip"></span></div><p>Total: $${amt()}</p><div style="height:10px;width:60px"></div><label>Card<input autocomplete="cc-number"></label><button id="pay">Pay $18.00</button></form>`, 'Pay $18.00'],
  'P4 express pay buttons': [`<form id="payment">${meta()}<div style="display:flex;gap:8px"><button type="button" style="width:140px;height:40px;background:#000;color:#fff" aria-label="Apple Pay"><svg width="40" height="16" viewBox="0 0 40 16"><rect width="40" height="16"/></svg></button><div role="button" tabindex="0" style="width:140px;height:40px;background:#fff;border:1px solid #000"><svg width="50" height="18"><circle cx="9" cy="9" r="8"/></svg></div><button type="button" style="width:140px;height:40px;background:#ffc439">PayPal</button></div><p>or pay by card</p><p>Order total <strong>$${amt()}</strong></p><label>Card number<input autocomplete="cc-number"></label><button id="pay">Pay</button></form>`, 'Pay'],
  'P5 sticky footer with its own total': [`<form id="payment">${meta()}<div style="height:500px">Items...<p>Total <b>$${amt()}</b></p></div><label>Card<input name="cardnumber"></label></form><div style="position:fixed;bottom:0;left:0;right:0;height:60px;background:#fff;box-shadow:0 -2px 8px rgba(0,0,0,.2)"><span>Total: $18.00</span> <button form="payment" id="pay">Place order</button></div>`, 'Place order'],
  'P6 discount line': [`<form id="payment">${meta()}<table><tr><td>Subtotal</td><td>$20.00</td></tr><tr><td>Discount (SAVE10)</td><td>-$2.00</td></tr><tr><td>Shipping</td><td>FREE</td></tr><tr><td>Total</td><td>$${amt()}</td></tr></table><label>Card<input autocomplete="cc-number"></label><button id="pay">Complete order</button></form>`, 'Complete order'],
  'P7 was-price, savings, installments': [`<form id="payment">${meta()}<p>Was <s>$22.00</s> Now $18.00 — You save $4.00!</p><p>Free shipping on orders over $50.00</p><p>Pay in 4 interest-free payments of $4.50 with Klarna</p><p>Estimated total: $${amt()}</p><label>Card<input autocomplete="cc-number"></label><button id="pay">Pay now</button></form>`, 'Pay now'],
  'P8 subscription': [`<form id="payment">${meta()}<h3>Pro plan</h3><p>$18.00 per month, billed monthly. Cancel anytime.</p><p>Total due today: $${amt()}</p><p>Then $18.00/month starting Nov 15.</p><label>Card<input autocomplete="cc-number"></label><button id="pay">Subscribe</button></form>`, 'Subscribe'],
  'P9 free-shipping bar, tips, loyalty points': [`<form id="payment">${meta()}<p>You're $32.00 away from free shipping</p><p>Earn 18 points ($0.18 value)</p><p>Add a tip: <button type="button">$1</button><button type="button">$2</button></p><p>Items: $15.00 &nbsp; Delivery: $2.00 &nbsp; Taxes: $1.00</p><p><b>Amount due:</b> ${amt()}</p><label>Card<input autocomplete="cc-number"></label><button id="pay">Pay</button></form>`, 'Pay'],
};
// A donation page with preset amount chips ($50 is larger than the named $18) and a dialog whose terms sit outside the
// button's own nested form are the two false asks that remain.
const asks = {
  'R10 donation with amount chips ($10, $18, $50) and a cover-fees checkbox': [`${css}<form id="payment">${meta()}<div><button type="button">$10</button><button type="button">$18</button><button type="button">$50</button></div><label><input type="checkbox"> Add $0.82 to cover processing fees</label><p>Your gift: $${amt()}</p>${card}<button id="pay">Donate</button></form>`, 'Donate'],
  'P10 dialog checkout whose terms sit outside the Pay button\'s own form': [`<div role="dialog" aria-label="Checkout" id="payment">${meta()}<p>Order total: ${amt()}</p><div style="width:100px;height:30px"></div><label>Card<input autocomplete="cc-number"></label><form><button id="pay">Pay now</button></form></div>`, 'Pay now'],
};
const outcome = new Map();
// Round 13. The payment read asks whenever any visible figure is larger than the amount, whatever its label says. These pages used to be
// allowed on the strength of a label (discount, was, gift card, late fee, converted total...) and now ask like the two donation pages.
const askNow = new Set(['R7 flex Subtotal, Discount, free Shipping, Total', 'P6 discount line', 'P7 was-price, savings, installments', 'P9 free-shipping bar, tips, loyalty points',
  'N1 subscription: monthly vs annual toggle', 'N5 checkout with gift card balance applied', 'N6 invoice payment with due date and late fee note', 'N7 airline fare with taxes and bag fee note',
  'M1 order bump checkbox already checked', 'M2 multi-currency: converted total in euro', 'M4 split payment gift card + card (total due)', 'M4b split payment: card charge line',
  'M5 invoice with past-due amount', 'M5b invoice with previous balance line']);
for (const [name, [html, label]] of Object.entries(pages))
  test('realistic page ' + name + (askNow.has(name) ? ': asks (round 13: a figure above the amount)' : ': the exact payment is allowed once'), { skip, timeout: 90000 }, async t => {
    const r = await payOnce(t, html, label);
    outcome.set(name, r.payment === 1);
    assert.equal(r.payment, askNow.has(name) ? 0 : 1, r.text);
  });
for (const [name, [html, label]] of Object.entries(asks))
  test('realistic page ' + name + ': asks (known false ask)', { skip, timeout: 90000 }, async t => {
    const r = await payOnce(t, html, label);
    outcome.set(name, r.payment === 1);
    assert.equal(r.payment, 0);
    assert.match(r.text, /not run|confirmation/);
  });
// Cross-origin card iframes cannot be snapshotted by this harness, so their terms are read directly.
test('realistic pages with a cross-origin card iframe (R4 grid summary and steppers, P3 subtotal and tax line): terms are accepted', { skip, timeout: 90000 }, async t => {
  const frame = '<iframe src="http://card-fields.invalid/frame" title="Secure card payment input frame" style="border:0;width:320px;height:44px"></iframe>';
  await readCases(t, [
    ['R4 grid summary, steppers, thumbnails, iframe', `${css}<form id="payment">${meta()}<div>${thumb} Fixture item <button type="button" aria-label="Decrease">−</button> 2 <button type="button" aria-label="Increase">+</button></div><div style="display:grid;grid-template-columns:1fr auto;width:320px"><span>Subtotal</span><span>$16.00</span><span>Tax</span><span>$2.00</span><span>Total</span><span>$${amt()}</span></div>${frame}<button id="pay">Pay</button></form>`, 'allow'],
    ['P3 one-line subtotal and tax, iframe', `<form id="payment">${meta()}<p>Subtotal $16.00 · Tax $2.00</p><p>Total $${amt()}</p>${frame}<button id="pay">Pay $18.00</button></form>`, 'allow'],
  ]);
});
test('false-ask rate on the 10 realistic pages R1 to R10 is at most 2/10 (R7 and R10 ask)', { skip }, () => {
  const names = [...Object.keys(pages), ...Object.keys(asks)].filter(name => /^R\d/.test(name));
  assert.equal(names.length, 9);
  const allowed = names.filter(name => outcome.get(name)).length + 1; // R4 above
  assert.ok(allowed >= 8, 'allowed ' + allowed + ' of 10');
});

// Round 4 made every script-driven button spend the request's one payment, so Apply, steppers, Remove or "Show order summary"
// before Pay made Pay ask (4 of 4). An activation that settles with no request, navigation or form change gives the budget back.
const stepsPage = `<style>body{font:14px system-ui}</style><form id="payment">${meta()}<p>Fixture item <button type="button">Decrease</button> 2 <button type="button">Increase</button> <button type="button">Remove</button></p>
<label>Discount code <input name="code" aria-label="Discount code"></label><button type="button">Apply</button><button type="button">Show order summary</button>
<p>Subtotal: $16.00</p><p>Tax: $2.00</p><p>Total: $${amt()}</p><label>Card number<input autocomplete="cc-number"></label><button id="pay">Pay now</button></form>`;
for (const step of ['Apply', 'Show order summary', 'Increase', 'Remove'])
  test('F4: ' + step + ' (no request, no navigation) before Pay does not make Pay ask', { skip, timeout: 90000 }, async t => {
    const r = await payOnce(t, stepsPage, 'Pay now', { before: [step] });
    assert.equal(r.payment, 1, r.text);
  });
test('F4: a script-driven button whose handler sends a request keeps the budget spent: Pay asks', { skip, timeout: 90000 }, async t => {
  const html = stepsPage.replace('<button type="button">Apply</button>', '<button type="button" onclick="record(\'aux\')">Apply</button>');
  const r = await payOnce(t, html, 'Pay now', { before: ['Apply'] });
  assert.equal(r.payment, 0);
  assert.match(r.text, /not run|confirmation/);
});

// ---------------------------------------------------------------- Part 2. Direct reads
const flex = (l, v) => `<div style="display:flex;justify-content:space-between"><span>${l}</span><span>${v}</span></div>`;
const rows = [['Subtotal', '$15.00'], ['Shipping', '$2.00'], ['Tax', '$1.00']];
test('F1: 15 summary layouts (table, flex, grid, dl, float, inline, stacked) are accepted', { skip, timeout: 120000 }, async t => {
  await readCases(t, [
    ['table rows Subtotal/Shipping/Tax/Total', form(`<table>${rows.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('')}<tr><td>Total</td><td>$${amt()}</td></tr></table>`), 'allow'],
    ['flex rows', form(rows.map(([l, v]) => flex(l, v)).join('') + flex('Total', '$' + amt())), 'allow'],
    ['grid rows', form('<div style="display:grid;grid-template-columns:1fr auto">' + rows.map(([l, v]) => `<span>${l}</span><span>${v}</span>`).join('') + `<span>Total</span><span>$${amt()}</span></div>`), 'allow'],
    ['dl/dt/dd', form('<dl>' + rows.map(([l, v]) => `<dt>${l}</dt><dd>${v}</dd>`).join('') + `<dt>Total</dt><dd>$${amt()}</dd></dl>`), 'allow'],
    ['ul li with float right price', form('<ul style="list-style:none">' + rows.map(([l, v]) => `<li>${l}<span style="float:right">${v}</span></li>`).join('') + `<li>Total<span style="float:right">$${amt()}</span></li></ul>`), 'allow'],
    ['p with inline value "Tax: $1.00"', form(rows.map(([l, v]) => `<p>${l}: ${v}</p>`).join('') + `<p>Total: $${amt()}</p>`), 'allow'],
    ['only Shipping + Total (flex)', form(flex('Shipping', '$2.00') + flex('Total', '$' + amt())), 'allow'],
    ['only Tax + Total (table)', form(`<table><tr><td>Tax</td><td>$1.00</td></tr><tr><td>Total</td><td>$${amt()}</td></tr></table>`), 'allow'],
    ['Shipping FREE then Total', form(flex('Shipping', 'FREE') + flex('Total', '$' + amt())), 'allow'],
    ['item row price then Total (flex)', form(flex('Fixture item', '$18.00') + flex('Total', '$' + amt())), 'allow'],
    ['two items $9.00 each, then Total (flex)', form(flex('Mug', '$9.00') + flex('Plate', '$9.00') + flex('Total', '$' + amt())), 'allow'],
    ['item $30.00, Discount -$12.00, Total (flex)', form(flex('Mug', '$30.00') + flex('Discount', '-$12.00') + flex('Total', '$' + amt())), 'ask'],
    ['Total label above, figure stacked below', form(`<div>Total</div><div>$${amt()}</div>`), 'allow'],
    ['Total row then "Includes tax" row below', form(flex('Total', '$' + amt()) + flex('Includes tax', '$1.50')), 'allow'],
    ['Total row then "Includes $1.50 in taxes" note', form(flex('Total', '$' + amt()) + '<div style="color:#888">Includes $1.50 in taxes</div>'), 'allow'],
  ]);
});
const T = `<tr><td><b>Total</b></td><td><b>$${amt()}</b></td></tr>`;
test('F1: cart tables, coupon boxes, line items and delivery rows are accepted', { skip, timeout: 120000 }, async t => {
  await readCases(t, [
    ['line item row "Fixture item × 2 | $9.00 each | $18.00"', form(`<table><tr><td>Fixture item × 2</td><td>$9.00 each</td><td>$18.00</td></tr></table><table>${T}</table>`), 'allow'],
    ['coupon input and Apply', form(`<label>Coupon <input name="coupon"></label><button type="button">Apply</button><table>${T}</table>`), 'allow'],
    ['Qty 2 × $9.00 = $18.00', form(`<p>Fixture item</p><p>Qty 2 × $9.00 = $18.00</p><table>${T}</table>`), 'allow'],
    ['$9.00 × 2 (price first)', form(`<p>Fixture item $9.00 × 2</p><table>${T}</table>`), 'allow'],
    ['Item | Price | Qty | Subtotal table', form(`<table><tr><th>Item</th><th>Price</th><th>Qty</th><th>Subtotal</th></tr><tr><td>Fixture item</td><td>$9.00</td><td>2</td><td>$18.00</td></tr></table><table>${T}</table>`), 'allow'],
    ['items 12 + 8, Discount 2', form(`<table><tr><td>Mug</td><td>$12.00</td></tr><tr><td>Plate</td><td>$8.00</td></tr><tr><td>Discount</td><td>-$2.00</td></tr></table><table>${T}</table>`), 'allow'],
    ['item $30, Subtotal $30, You save $12', form(`<table><tr><td>Mug</td><td>$30.00</td></tr><tr><td>Subtotal</td><td>$30.00</td></tr><tr><td>You save</td><td>$12.00</td></tr></table><table>${T}</table>`), 'ask'],
    ['Estimated tax and shipping lines', form(`<p>Subtotal ($15.00)</p><p>Shipping & handling $2.00</p><p>Estimated tax $1.00</p><table>${T}</table>`), 'allow'],
    ['Delivery estimate $5.00 above the Total (flex)', form(flex('Delivery estimate', '$5.00') + `<p>Total: $${amt()}</p>`), 'allow'],
    ['Gift card applied -$5.00, Estimated total', form(`<p>Gift card applied: -$5.00</p><p>Estimated total: $${amt()}</p>`), 'allow'],
    ['Amount due today plus Next payment on Nov 15', form(`<p>Amount due today: $${amt()}</p><p>Next payment: $18.00 on Nov 15</p>`), 'allow'],
    ['Payment charged to Visa ending 4242', form(`<p>Payment of $${amt()} will be charged to Visa ending 4242</p>`), 'allow'],
    ['Total (USD) and Total: $18.00 USD', form(`<p>Total (USD): $${amt()}</p><p>Total: $18.00 USD</p>`), 'allow'],
    ['figure-first "$18.00 due today"', form(`<p><span>$${amt()}</span> due today</p>`), 'allow'],
    ['mobile bar "$18.00" over "Total"', form(`<div style="display:flex;flex-direction:column"><b>$${amt()}</b><small>Total</small></div>`), 'allow'],
    ['Free shipping on orders over $50.00', form(`<p>Free shipping on orders over $50.00</p><p>Total: $${amt()}</p>`), 'ask'],
    ['Save $10.00 on your first order', form(`<p>Save $10.00 on your first order</p><p>Total: $${amt()}</p>`), 'allow'],
    ['"$10.00 off your first order"', form(`<div>$10.00 off your first order</div><p>Total: $${amt()}</p>`), 'allow'],
    ['Gift card balance and Store credit available', form(`<p>Earn 180 points</p><p>Gift card balance: $25.00</p><p>Store credit available: $50.00</p><p>Total: $${amt()}</p>`), 'ask'],
    ['was-price struck through', form(`<p>Fixture item <del>$22.00</del> <ins>$18.00</ins></p><p>Total: $${amt()}</p>`), 'ask'],
    // Still asks, by design.
    ['ask: item price $22.00 above the Total with no discount line', form(`<p>Fixture item  $22.00</p><table>${T}</table>`), 'ask'],
    ['allow (round 13): "Price: $9.00" as a line of its own, a unit price within the amount', form(`<p>Fixture item</p><p>Price: $9.00</p><p>Qty: 2</p><p>Total: $${amt()}</p>`), 'allow'],
    ['ask: "Total savings: $200.00" above the Total', form(`<p>Total savings: $200.00</p><p>Total: $${amt()}</p>`), 'ask'],
  ]);
});
test('F3: ordinary empty boxes, spacers, icons, radios and badges no longer make the read ask', { skip, timeout: 120000 }, async t => {
  const f = extra => form(`<p>Total: $${amt()}</p>${extra}`);
  await readCases(t, [
    ['control', f(''), 'allow'],
    ['empty spacer div 16px x 100%', f('<div style="height:16px;width:100%"></div>'), 'allow'],
    ['empty span 24x24 sprite', f('<span style="display:inline-block;width:24px;height:24px;background:#ccc"></span>'), 'allow'],
    ['empty div 4px divider', f('<div style="height:4px;width:100%;background:#eee"></div>'), 'allow'],
    ['empty flex spacer', f('<div style="display:flex"><span>Qty</span><div style="flex:1;height:20px"></div><span>2</span></div>'), 'allow'],
    ['div role=img card brand 32x20', f('<div role="img" aria-label="Visa" style="width:32px;height:20px;background:#00f"></div>'), 'allow'],
    ['card element mount div 300x40', f('<div id="card-element" style="height:40px;width:300px;border:1px solid #ccc"></div>'), 'allow'],
    ['empty custom element', f('<x-ui style="display:block;width:100px;height:20px"></x-ui>'), 'allow'],
    ['empty td in a table', f('<table><tr><td style="width:40px;height:20px"></td><td>Qty 2</td></tr></table>'), 'allow'],
    ['custom radio span.checkmark 24x24', f('<label><input type="radio" name="r"> Express <span style="display:inline-block;width:24px;height:24px;border:2px solid #888;border-radius:50%"></span></label>'), 'allow'],
    ['toggle span.slider 44x22', f('<label><input type="checkbox"> Save card <span style="display:inline-block;width:44px;height:22px;background:#ccc;border-radius:11px"></span></label>'), 'allow'],
    ['skeleton loader div 120x16', f('<div style="width:120px;height:16px;background:#eee"></div>'), 'allow'],
    ['empty a block 120x30', f('<a href="/" style="display:block;width:120px;height:30px;background:#ddd"></a>'), 'allow'],
    ['offscreen honeypot div', f('<div style="position:absolute;left:-9999px;width:100px;height:20px"></div>'), 'allow'],
    ['svg path 40x16 logo', f('<svg width="44" height="20" viewBox="0 0 44 20"><path d="M2 2h40v16H2z"/></svg>'), 'allow'],
    ['svg card brands 40x24', f('<svg width="40" height="24"><rect width="40" height="24"/></svg>'), 'allow'],
    ['svg inside a button 36x14', f('<button type="button" aria-label="Apple Pay"><svg width="40" height="18"><path d="M2 2h36v14H2z"/></svg></button>'), 'allow'],
    ['product thumbnail with alt text', f('<img alt="Blue mug" width="64" height="64" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'), 'allow'],
  ]);
});

// F2. Wording that hid a total from round 4's one-word role lookup. Every one asks (the Amount: 18.00 is visible).
test('F2: neutral words, currency prefixes, notes, leaders and other labels do not hide a larger figure', { skip, timeout: 180000 }, async t => {
  const P = s => withAmount(`<p>${s}</p>`);
  const asking = ['Total: now $500.00', 'Total: only $500.00', 'Total: USD$500.00', 'Total due: just $500.00', 'Total: A$500.00', 'Amount due: approx. $500.00', 'Total: about $500.00',
    'Total: CA$500.00', 'Total: NZ$500.00', 'Total: US$500.00', 'Total - $500.00', 'Total ........ $500.00', 'Total → $500.00', 'Total | $500.00', 'Total (USD) $500.00',
    'Total*: $500.00', '<b>Total</b> <i>(inc VAT)</i> $500.00', 'Your card will be charged $500.00', 'TOTAL TO PAY: $500.00', 'Total: $ 500.00', 'Total: $500',
    'Total: ＄500.00', 'Total: $5&#8203;00.00', 'Total: $5OO.00', 'Total: five hundred dollars', 'Total:&nbsp;&nbsp;$500.00', 'Total: $٥٠٠.٠٠',
    'Total (taxes included): $500.00', 'Total (VAT included): $500.00', 'Total (estimated): $500.00', 'Total (tax incl.): $500.00', 'Total, final: $500.00',
    'Amount due in full: $500.00', 'Total payable today in full $500.00', 'Pay-now: $500.00', 'Charging $500.00 to your card', 'Invoice: $500.00', 'Your order: $500.00',
    'Billing: $500.00', 'Paying $500.00 today', 'Grand total: $500.00', 'Total 500', 'Total 500 dollars', 'Total 500,00 €', 'Total: 500,00 €', 'Total ¥500', 'Total: US$500.00',
    'Total: Rs. 500', 'Total: USD 500', 'Deposit $18.00. Remaining $482.00 will be charged tomorrow', 'You pay $18.00 now and $500.00 on delivery',
    'Total $18.00, first installment of $500.00', 'Balance due on delivery: $500.00', 'Total after $2.00 discount: $500.00', 'Total (incl. $482.00 tax): $500.00'];
  await readCases(t, [
    ...asking.map(s => ['ask: ' + s, P(s), 'ask']),
    ['ask: <br> between label and figure', P('Total<br>$500.00'), 'ask'],
    ['ask: two blocks Total / $500.00', withAmount('<div style="display:block">Total</div><div style="display:block">$500.00</div>'), 'ask'],
    ['ask: label from a ::before on a figure span', withAmount('<style>.t::before{content:"Total: "}</style><p><span class="t">$500.00</span></p>'), 'ask'],
    ['ask: label only in an aria-label on the parent, figure unlabeled', withAmount('<p><span aria-label="Total">$500.00</span></p>'), 'ask'],
    ['ask: figure alone, no label at all', withAmount('<p>$500.00</p>'), 'ask'],
    // Same wording, honest and smaller than or equal to the amount.
    ['allow: Total: now $18.00', P('Total: now $18.00'), 'allow'],
    ['ask: Total: A$18.00 under Currency: USD is another currency', P('Total: A$18.00'), 'ask'],
    ['allow: Total (taxes included): $18.00', P('Total (taxes included): $18.00'), 'allow'],
    ['allow: Total 18', P('Total 18'), 'allow'],
    ['allow: Total 2 items', P('Total 2 items'), 'allow'],
    ['allow: Total: 18,00 USD', P('Total: 18,00 USD'), 'allow'],
  ]);
});

// F7. Parts above the total and currencies that differ from the page's.
test('F7: a part larger than the total asks, and so does another currency symbol or code', { skip, timeout: 120000 }, async t => {
  const P = s => withAmount(`<p>${s}</p>`);
  await readCases(t, [
    ['ask: Tax: $482.00', P('Tax: $482.00'), 'ask'],
    ['ask: Shipping & handling: $482.00', P('Shipping & handling: $482.00'), 'ask'],
    ['ask: Processing fee: $482.00', P('Processing fee: $482.00'), 'ask'],
    ['ask: Total: $18.00 + $482.00 shipping', P('Total: $18.00 + $482.00 shipping'), 'ask'],
    ['ask: Total: €18.00 under Currency: USD', P('Total: €18.00'), 'ask'],
    ['ask: Total: £18.00', P('Total: £18.00'), 'ask'],
    ['ask: Total: 18.00 JPY', P('Total: 18.00 JPY'), 'ask'],
    ['ask: Total: 18.00 EUR', P('Total: 18.00 EUR'), 'ask'],
    ['ask: Tax: €1.00 in a USD page', P('Total: $18.00 · Tax: €1.00'), 'ask'],
    ['allow: Tax: $1.00 and Shipping: $2.00', P('Tax: $1.00 · Shipping: $2.00'), 'allow'],
    ['allow: Total: $18.00 USD', P('Total: $18.00 USD'), 'allow'],
    ['allow: Total: USD 18.00', P('Total: USD 18.00'), 'allow'],
    ['allow: Total: US$18.00', P('Total: US$18.00'), 'allow'],
    ['ask: a discount larger than the total ("Discount: -$30.00")', withAmount('<p>Subtotal: $48.00</p><p>Discount: -$30.00</p>'), 'ask'],
  ]);
});

// F5. A viewport-sized fixed layer covers every spot the page can scroll to.
test('F5: terms below the fold under a viewport-sized fixed layer are not visible; without the layer they count', { skip, timeout: 120000 }, async t => {
  const A = (s = '') => `<p data-payment-amount="18.00" style="margin:0;${s}">Amount: 18.00</p>`;
  const q = (amount, extra = '') => `<form id="payment">${meta()}${amount}${extra}<label>Card<input autocomplete="cc-number"></label><button id="pay">Pay</button></form>`;
  const down = `<form id="payment" style="position:absolute;top:1500px;left:10px">${meta()}<p>Amount: ${amt()}</p><label>Card<input autocomplete="cc-number"></label><button id="pay">Pay</button></form>`;
  await readCases(t, [
    ['ask: form 1500px down under a fixed opaque "Loading" overlay', '<div style="position:fixed;inset:0;background:#fff;z-index:99">Loading, please wait</div><div style="height:3000px"></div>' + down, 'ask'],
    ['ask: form 1500px down under an open fixed dialog', '<dialog open style="position:fixed;inset:0;width:100%;height:100%;background:#fff;border:0">Loading</dialog><div style="height:3000px"></div>' + down, 'ask'],
    ['allow: the same form below the fold with no overlay', '<div style="height:3000px"></div>' + down, 'allow'],
    ['ask: decoy 1500px down under a fixed white overlay', '<div style="position:fixed;inset:0;background:#fff;z-index:99">Loading, please wait</div>' + q(A('position:absolute;top:1500px;left:20px')), 'ask'],
    ['ask: decoy 3000px down under a fixed 100vh white layer', '<div style="position:fixed;left:0;top:0;width:100%;height:100vh;background:#fff;z-index:9"></div>' + q(A('margin-top:3000px')), 'ask'],
    ['ask: decoy 2500px down under a fixed 100vh bottom layer', '<div style="position:fixed;left:0;bottom:0;width:100%;height:100vh;background:#fff;z-index:9">Cookie preferences</div>' + q(A('margin-top:2500px')), 'ask'],
    ['allow: a fixed cookie bar of 80px does not cover the page', '<div style="position:fixed;left:0;bottom:0;width:100%;height:80px;background:#fff;z-index:9">Cookies</div>' + q(A('margin-top:1500px')), 'allow'],
    ['ask: decoy 12 viewports down', q(A('position:absolute;top:9600px;left:20px')) + '<div style="height:10000px"></div>', 'ask'],
    ['ask: decoy in an overflow:hidden wrapper', '<div style="height:100vh;overflow:hidden;position:relative">' + q(A('position:absolute;top:1500px;left:20px')) + '</div>', 'ask'],
  ]);
});

// F6. An image or canvas that may hold a figure needs a text label in its row.
test('F6: an image or canvas mark with no text label in its row asks', { skip, timeout: 120000 }, async t => {
  const svg = s => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="30"><text y="20" font-size="18">${s}</text></svg>`);
  const P = s => withAmount(`<p>${s}</p>`);
  await readCases(t, [
    ['ask: img 95x40 holding "Total: $500.00", no label', P(`<img alt="" width="95" height="40" src="${svg('Total: $500.00')}">`), 'ask'],
    ['ask: img 300x15 holding the total', P(`<img alt="" width="300" height="15" src="${svg('Total: $500.00')}">`), 'ask'],
    ['ask: canvas 98x30 with the total drawn', P('<canvas id="c" width="98" height="30"></canvas><script>var x=document.getElementById("c").getContext("2d");x.font="10px sans-serif";x.fillText("Total: $500",2,20)</script>'), 'ask'],
    ['ask: img 70x20 where the figure should be, after "Total:"', P(`Total: <img alt="" width="70" height="20" src="${svg('$500.00')}">`), 'ask'],
    ['ask: img 40x30 after "Price:"', P(`Price: <img alt="" width="40" height="30" src="${svg('$500')}">`), 'ask'],
    ['ask: svg 90x20 with an <image>', P(`<svg width="90" height="20"><image href="${svg('Total $500')}" width="90" height="20"/></svg>`), 'ask'],
    ['ask: decorative 24x24 img with empty alt', P('<img alt="" width="24" height="24" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'), 'ask'],
    ['ask: svg 60x16 paypal-like shapes outside a control', P('<svg width="60" height="16"><g><path d="M0 0h12v16H0z"/><path d="M20 0h30v16H20z"/></g></svg>'), 'ask'],
    ['ask: img 40x30 beside an ordinary word, no pay word ("We accept")', P(`We accept <img alt="" width="40" height="30" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`), 'ask'],
    ['allow: img with alt text', P('<img alt="Visa" width="40" height="30" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'), 'allow'],
    ['allow: img inside a button', P('<button type="button" aria-label="Apple Pay"><img alt="" width="40" height="30" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>'), 'allow'],
  ]);
});

// Honest or hidden text that stayed as before.
test('hidden or lower-contrast discount lines never cover a high subtotal; unrelated offers do not either', { skip, timeout: 120000 }, async t => {
  await readCases(t, [
    ['ask: Subtotal $500 + hidden Discount -$482', withAmount('<p>Subtotal: $500.00</p><p style="display:none">Discount: -$482.00</p>'), 'ask'],
    ['ask: Subtotal $500 + low-contrast Discount -$482', withAmount('<p>Subtotal: $500.00</p><p style="color:#fefefe">Discount: -$482.00</p>'), 'ask'],
    ['ask: Subtotal $500 + 4px Discount', withAmount('<p>Subtotal: $500.00</p><p style="font-size:4px">Discount: -$482.00</p>'), 'ask'],
    ['ask: Subtotal $500 + "Get $500 off your next order"', withAmount('<p>Subtotal: $500.00</p><p>Get $500 off your next order!</p>'), 'ask'],
    ['ask: Subtotal $500 + small Discount $10', withAmount('<p>Subtotal: $500.00</p><p>Discount: -$10.00</p>'), 'ask'],
    ['ask: Subtotal and Discount on one line', withAmount('<p>Subtotal: $500.00 Discount: -$482.00</p>'), 'ask'],
    ['ask: Total before discount with no discount line', withAmount('<p>Total before discount: $500.00</p>'), 'ask'],
    ['ask: Total $500 before discounts + Discount -$482', withAmount('<p>Total: $500.00 before discounts</p><p>Discount -$482.00</p>'), 'ask'],
    ['ask: Subtotal $22 + visible Discount $4', withAmount('<p>Subtotal: $22.00</p><p>Discount: $4.00</p>'), 'ask'],
  ]);
});

// Limits found and kept, so a change in behavior shows up here. Each is listed in docs/known-problems.md.
test('known limits: text no one renders into the page is not read', { skip, timeout: 120000 }, async t => {
  const svg = s => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="30"><text y="20" font-size="18">${s}</text></svg>`);
  const P = s => withAmount(`<p>${s}</p>`);
  await readCases(t, [
    ['limit: CSS background image holding the total', P(`<div style="width:300px;height:30px;background:url('${svg('Total: $500.00')}')"></div>`), 'allow'],
    ['limit: closed shadow root without text', withAmount('<div id="h"></div><script>document.getElementById("h").attachShadow({mode:"closed"}).innerHTML="<p>Total: $500.00</p>"</script>'), 'allow'],
    ['limit: total only in an aria-label', P('<span aria-label="Total: $500.00">Total</span>'), 'allow'],
    ['limit: total only in a title attribute', P('<span title="Total: $500.00">Total</span>'), 'allow'],
    ['limit: cross-origin iframe', P('<iframe srcdoc="x" sandbox style="width:300px;height:30px"></iframe>'), 'allow'],
    ['limit: closed popover', P('<div popover>Total: $500.00</div>'), 'allow'],
  ]);
});

// ================================================================ Round 6
// 8 more realistic pages (the round 5 reviewer's N1 to N8, real route). The fixture server sends no charset, so each carries a meta tag.
const css6 = '<style>body{font:14px system-ui}table{width:340px;border-collapse:collapse}td{padding:4px 0}td:last-child{text-align:right}.row{display:flex;justify-content:space-between;width:340px;padding:3px 0}.muted{color:#666;font-size:12px}.opt{display:block;border:1px solid #ccc;padding:8px;margin:4px 0;width:320px}</style>';
const row6 = (l, v) => `<div class="row"><span>${l}</span><span>${v}</span></div>`;
const more = {
  'N1 subscription: monthly vs annual toggle': [`${css6}<form id="payment">${meta()}<h2>Choose your plan</h2>
<label class="opt"><input type="radio" name="p" checked> Monthly <b>$18.00</b>/month</label>
<label class="opt"><input type="radio" name="p"> Annual <b>$180.00</b>/year <span class="muted">(save $36.00, 2 months free)</span></label>
<h3>Order summary</h3>${row6('Pro plan, monthly', '$18.00')}${row6('Tax', '$0.00')}${row6('<b>Total due today</b>', '<b>$' + amt() + '</b>')}
<p class="muted">You will be charged $18.00 every month until you cancel. Annual billing would be $180.00 per year.</p>${card}<button id="pay">Start subscription</button></form>`, 'Start subscription'],
  'N2 cart with 4 line items, shipping, tax': [`${css6}<form id="payment">${meta()}<h2>Your cart (4 items)</h2><table>
<tr><td>Blue widget × 1</td><td>$4.00</td></tr><tr><td>Red widget × 2</td><td>$5.00</td></tr><tr><td>Green gadget × 1</td><td>$2.50</td></tr><tr><td>Gift wrap × 1</td><td>$1.50</td></tr></table><hr>
<table><tr><td>Subtotal</td><td>$13.00</td></tr><tr><td>Shipping</td><td>$3.00</td></tr><tr><td>Estimated tax</td><td>$2.00</td></tr><tr><td><b>Order total</b></td><td><b>$${amt()}</b></td></tr></table>${card}<button id="pay">Place order</button></form>`, 'Place order'],
  'N3 hotel booking: nightly rate × nights': [`${css6}<form id="payment">${meta()}<h2>Seaside Inn, 3 nights</h2><p>Check-in Nov 3, check-out Nov 6</p>
${row6('$4.00 × 3 nights', '$12.00')}${row6('Taxes &amp; fees', '$4.00')}${row6('Resort fee', '$2.00')}${row6('<b>Total (USD)</b>', '<b>$' + amt() + '</b>')}
<p class="muted">Free cancellation until Nov 1. Rooms from $4.00 per night.</p>${card}<button id="pay">Book now</button></form>`, 'Book now'],
  'N5 checkout with gift card balance applied': [`${css6}<form id="payment">${meta()}<h2>Order summary</h2>${row6('Subtotal', '$38.00')}${row6('Gift card (balance $20.00)', '-$20.00')}${row6('Shipping', 'FREE')}${row6('<b>Total due</b>', '<b>$' + amt() + '</b>')}
<p class="muted">Gift card balance remaining after this order: $0.00</p>${card}<button id="pay">Pay now</button></form>`, 'Pay now'],
  'N6 invoice payment with due date and late fee note': [`${css6}<form id="payment">${meta()}<h2>Invoice #1042</h2><p>Due Nov 1. A late fee of $25.00 applies after that date.</p>${row6('Services', '$16.00')}${row6('Tax', '$2.00')}<p><b>Amount due:</b> $${amt()}</p>${card}<button id="pay">Pay invoice</button></form>`, 'Pay invoice'],
  'N7 airline fare with taxes and bag fee note': [`${css6}<form id="payment">${meta()}<h2>Flight AB 123</h2>${row6('Fare', '$12.00')}${row6('Taxes and carrier fees', '$6.00')}${row6('<b>Total price</b>', '<b>$' + amt() + '</b>')}<p class="muted">Checked bag: from $30.00 each way. Seat selection from $9.00.</p>${card}<button id="pay">Purchase</button></form>`, 'Purchase'],
  'N8 pay in 3 installments (Klarna) notice': [`${css6}<form id="payment">${meta()}<h2>Checkout</h2>${row6('Item', '$18.00')}${row6('Shipping', 'Free')}${row6('<b>Total</b>', '<b>$' + amt() + '</b>')}<p class="muted">or 3 payments of $6.00 with Klarna</p>${card}<button id="pay">Pay $18.00</button></form>`, 'Pay $18.00'],
};
const moreAsks = {
  'N4 donation: preset chips and custom amount': [`${css6}<form id="payment">${meta()}<h2>Give today</h2><div><button type="button">$5</button><button type="button">$10</button><button type="button">$18</button><button type="button">$25</button><button type="button">$50</button></div>
<label>Other amount <input name="other" value="18.00"></label><p>Your gift: $${amt()}</p><label><input type="checkbox"> Make this monthly</label>${card}<button id="pay">Donate $18.00</button></form>`, 'Donate $18.00'],
};
for (const [name, [html, label]] of Object.entries(more))
  test('realistic page ' + name + (askNow.has(name) ? ': asks (round 13: a figure above the amount)' : ': the exact payment is allowed once'), { skip, timeout: 90000 }, async t => {
    const r = await payOnce(t, html, label, { head: '<meta charset="utf-8">' });
    outcome.set(name, r.payment === 1);
    assert.equal(r.payment, askNow.has(name) ? 0 : 1, r.text);
  });
for (const [name, [html, label]] of Object.entries(moreAsks))
  test('realistic page ' + name + ': asks (known false ask)', { skip, timeout: 90000 }, async t => {
    const r = await payOnce(t, html, label, { head: '<meta charset="utf-8">' });
    outcome.set(name, r.payment === 1);
    assert.equal(r.payment, 0);
  });
test('allow rate over the 28 realistic pages (20 from round 5 plus N1 to N8) is at least 17/28 (round 13: a figure above the amount asks)', { skip }, t => {
  const real = [...outcome.values()].filter(Boolean).length + 2; // R4 and P3 are read directly, above
  t.diagnostic('allowed ' + real + '/28');
  assert.ok(real >= 17, 'allowed ' + real + ' of 28');
});

// F2. The nearest line above a lone figure labels it, but a note line of exempt words ("incl. savings", "with points") is walked past
// to the pay or part label above it, unless another figure sits between.
test('F2 (round 6): an exempt note line between the pay label and the figure does not clear a larger figure', { skip, timeout: 120000 }, async t => {
  const fx = 'display:flex;justify-content:space-between;width:300px';
  await readCases(t, [
    ['ask: Total / incl. savings / $500.00 stack', withAmount('<div><div>Total</div><div>incl. savings</div><div>$500.00</div></div>'), 'ask'],
    ['ask: Total / after savings / $500.00 stack', withAmount('<div><div>Total</div><div>after savings</div><div>$500.00</div></div>'), 'ask'],
    ['ask: Total / with points / $500.00 flex row', withAmount(`<div style="${fx}"><span>Total</span><span>with points</span><span>$500.00</span></div>`), 'ask'],
    ['ask: Total | Balance | $500.00 table row', withAmount('<table><tr><td>Total</td><td>Balance</td><td>$500.00</td></tr></table>'), 'ask'],
    ['ask: Amount due / available now / $500.00', withAmount('<p>Amount due</p><p>available now</p><p>$500.00</p>'), 'ask'],
    ['ask: You will pay / Savings / $500.00', withAmount('<p>You will pay</p><p>Savings</p><p>$500.00</p>'), 'ask'],
    ['ask: dl dt Total, dt Savings, dd $500.00', withAmount('<dl><dt>Total</dt><dt>Savings</dt><dd>$500.00</dd></dl>'), 'ask'],
    ['ask: Total / Original / $500.00 stack', withAmount('<div>Total</div><div>Original</div><div>$500.00</div>'), 'ask'],
    ['ask: Savings / Total / $500.00 stack', withAmount('<p>Savings</p><p>Total</p><p>$500.00</p>'), 'ask'],
    ['ask: Total (savings in parentheses) / $500.00', withAmount('<div>Total (incl. savings)</div><div>$500.00</div>'), 'ask'],
    // Honest layouts the walk must keep.
    ['ask: Savings / $4.00 under a Total row that has its own figure', withAmount('<div style="display:flex;justify-content:space-between;width:300px"><span>Total</span><span>$18.00</span></div><p>Savings</p><p>$482.00</p>'), 'ask'],
    ['ask: dl Total $18.00, Savings $482.00', withAmount('<dl><dt>Total</dt><dd>$18.00</dd><dt>Savings</dt><dd>$482.00</dd></dl>'), 'ask'],
    ['ask: Savings stack alone, no pay label above', withAmount('<p>Savings</p><p>$482.00</p>'), 'ask'],
    ['ask: an unknown name above a Savings line', withAmount('<p>Blue mug</p><p>Savings</p><p>$482.00</p>'), 'ask'],
    ['ask: a part label (item) above a Savings line', withAmount('<p>Fixture item</p><p>Savings</p><p>$482.00</p>'), 'ask'],
    ['allow: Total / incl. savings / $18.00', withAmount('<div>Total</div><div>incl. savings</div><div>$18.00</div>'), 'allow'],
  ]);
});

// F3. balance, value, worth and credit also name real charges; a pay word after the figure counts as much as one before it.
test('F3 (round 6): balance, value, worth and credit alone do not clear a figure, and a pay word after the figure counts', { skip, timeout: 120000 }, async t => {
  const P = s => withAmount(`<p>${s}</p>`);
  const asking = ['Order value: $500.00', 'Cart value $500.00', 'Credit card: $500.00', 'Balance: $500.00', 'Your balance: $500.00', 'Value: $500.00', 'Savings plan: $500.00',
    'Reward: $500.00 charged now', '$500.00 balance due today', '$500.00 credit card charge', '$500.00 will be billed', 'Balance due: $500.00', 'Amount available: $500.00',
    'Total savings: $482.00 You pay $500.00', 'Total value: $500.00', 'Total was $500.00', 'Worth: $500.00', 'Credit: $500.00', 'Store credit due: $500.00'];
  await readCases(t, [
    ...asking.map(text => ['ask: ' + text, P(text), 'ask']),
    ['ask: Available balance: $500.00', P('Available balance: $500.00'), 'ask'],
    ['ask: Remaining balance: $500.00 (round 12: "remaining" without a wallet word names what is still payable)', P('Remaining balance: $500.00'), 'ask'],
    ['ask: Gift card balance: $500.00', P('Gift card balance: $500.00'), 'ask'],
    ['allow: Points value: $5.00', P('Points value: $5.00'), 'allow'],
    ['ask: You save $482.00 off', P('You save $482.00 off'), 'ask'],
    ['allow: Order value: $18.00', P('Order value: $18.00'), 'allow'],
    ['allow: $4.00 off your total', P('$4.00 off your total'), 'allow'],
    ['ask: Coupon code: $482.00', P('Coupon code: $482.00'), 'ask'],
  ]);
});

// F4. Common checkout content that used to make a correct 18.00 total ask.
test('F4 (round 6): alternatives, recommendations, gift cards, conditional fees and a yearly price beside the monthly one do not ask', { skip, timeout: 180000 }, async t => {
  const T = row6('<b>Total</b>', '$' + amt());
  const P = inner => `${css6}<form id="payment">${meta()}${inner}<label>Card<input autocomplete="cc-number"></label><button id="pay">Pay</button></form>`;
  await readCases(t, [
    ['allow: unchecked radio "Annual $180.00/year" beside the checked monthly one', P(`<label class="opt"><input type="radio" name="p" checked> Monthly <b>$18.00</b>/month</label><label class="opt"><input type="radio" name="p"> Annual <b>$180.00</b>/year (save $36.00)</label>${T}`), 'allow'],
    ['ask: "Annual billing would be $180.00 per year" with "$18.00 every month"', P(`<p>You will be charged $18.00 every month. Annual billing would be $180.00 per year.</p>${T}`), 'ask'],
    ['ask: a yearly price with no monthly price equal to the total', P(`<label>Annual <b>$180.00</b>/year</label>${T}`), 'ask'],
    ['ask: a yearly price above twelve times the monthly total', P(`<p>$18.00 per month. Or $400.00 per year.</p>${T}`), 'ask'],
    ['ask: shipping radios (Standard checked, Express $24.99 unchecked)', P(`<label><input type="radio" name="s" checked> Standard $5.00</label><label><input type="radio" name="s"> Express $24.99</label>${T}`), 'ask'],
    ['allow: unchecked checkbox "Add 2-year protection for $29.99"', P(`<label><input type="checkbox"> Add 2-year protection for $29.99</label>${T}`), 'allow'],
    ['ask: a CHECKED checkbox "Add 2-year protection for $29.99"', P(`<label><input type="checkbox" checked> Add 2-year protection for $29.99</label>${T}`), 'ask'],
    ['ask: an unchecked radio whose label names the Total', P(`<label><input type="radio" name="s"> Total: $500.00</label>${T}`), 'ask'],
    ['allow: an ARIA option that is not selected', P(`<div role="radio" aria-checked="false">Premium $49.00</div>${T}`), 'allow'],
    ['ask: an ARIA option that is selected', P(`<div role="radio" aria-checked="true">Premium $49.00</div>${T}`), 'ask'],
    ['ask: "You may also like" block with a product price', P(`<section><h3>You may also like</h3><ul><li>Gadget $59.00</li><li>Widget $79.00</li></ul></section>${T}`), 'ask'],
    ['ask: "You may also like: Gadget $59.00" as one line', P(`<p>You may also like: Gadget $59.00</p>${T}`), 'ask'],
    ['ask: a "You may also like" block that holds the Total', P(`<section><h3>You may also like</h3><p>Total: $500.00</p></section>${T}`), 'ask'],
    ['ask: gift card (balance $20.00) -$20.00 closes the Subtotal gap', P(row6('Subtotal', '$38.00') + row6('Gift card (balance $20.00)', '-$20.00') + T), 'ask'],
    ['ask: gift card -$20.00 closes the Subtotal gap', P(row6('Subtotal', '$38.00') + row6('Gift card', '-$20.00') + T), 'ask'],
    ['ask: store credit -$20.00', P(row6('Subtotal', '$38.00') + row6('Store credit', '-$20.00') + T), 'ask'],
    ['ask: voucher -$20.00', P(row6('Subtotal', '$38.00') + row6('Voucher', '-$20.00') + T), 'ask'],
    ['ask: Rewards applied -$20.00', P(row6('Subtotal', '$38.00') + row6('Rewards applied', '-$20.00') + T), 'ask'],
    ['ask: Subtotal $38.00 with a gift card line of only -$5.00', P(row6('Subtotal', '$38.00') + row6('Gift card', '-$5.00') + T), 'ask'],
    ['ask: "A late fee of $25.00 applies after that date."', P(`<p>Due Nov 1. A late fee of $25.00 applies after that date.</p>${T}`), 'ask'],
    ['ask: "Cancellation fee $50.00 after 24 hours"', P(`<p>Cancellation fee $50.00 after 24 hours</p>${T}`), 'ask'],
    ['ask: "Checked bag: from $30.00 each way."', P(`<p>Checked bag: from $30.00 each way.</p>${T}`), 'ask'],
    ['ask: "Price match guarantee up to $500.00"', P(`<p>Price match guarantee up to $500.00</p>${T}`), 'ask'],
    ['ask: "Late fee: $25.00 if unpaid"', P(`<p>Late fee: $25.00 if unpaid</p>${T}`), 'ask'],
    ['ask: "Total: from $500.00" (a pay word before "from")', withAmount(`<p>Total: from $500.00</p>`), 'ask'],
    ['ask: "Amount due: up to $500.00"', withAmount(`<p>Amount due: up to $500.00</p>`), 'ask'],
    ['ask: "Pay $500.00 if you agree" (pay word first)', withAmount(`<p>Pay $500.00 if you agree</p>`), 'ask'],
  ]);
});
test('F4 (round 6): invoice and order numbers are not figures; still asks for text-only offers', { skip, timeout: 120000 }, async t => {
  const P = inner => `<form id="payment">${meta()}<p>Total: $${amt()}</p>${inner}<label>Card<input autocomplete="cc-number"></label><button id="pay">Pay</button></form>`;
  await readCases(t, [
    ['allow: Invoice #1042', P('<h2>Invoice #1042</h2>'), 'allow'],
    ['allow: Order #5000123', P('<h2>Order #5000123</h2>'), 'allow'],
    ['ask: Invoice 1042 as a bare figure after a pay word', P('<p>Invoice: 1042</p>'), 'ask'],
    ['ask: text-only offer "Upgrade to Premium for $49.00/month"', P('<p>Upgrade to Premium for $49.00/month</p>'), 'ask'],
    ['ask: text-only shipping options', P('<p>Standard shipping $5.99 · Express shipping $24.99</p>'), 'ask'],
  ]);
});

// ================================================================ Round 7
// F5. The round 6 reviewer's 8 honest pages (real route), then direct reads for each new rule and its negatives.
const css7 = '<style>body{font:14px system-ui}.row{display:flex;justify-content:space-between;width:340px;padding:3px 0}.muted{color:#666;font-size:12px}.bump{display:block;border:2px dashed #e90;padding:8px;margin:6px 0;width:320px;background:#fff8e6}</style>';
const row7 = (l, v) => `<div class="row"><span>${l}</span><span>${v}</span></div>`;
const honest7 = {
  'M1 order bump checkbox already checked': [`${css7}<form id="payment">${meta()}<h2>Order summary</h2>${row7('Fixture item', '$10.00')}
<label class="bump"><input type="checkbox" checked> Yes! Add Express packaging for only <b>$4.00</b></label>${row7('Express packaging', '$4.00')}${row7('Shipping', '$4.00')}${row7('<b>Total</b>', '<b>$' + amt() + '</b>')}
<label class="bump"><input type="checkbox"> Add 2-year warranty for <b>$29.00</b></label>${card}<button id="pay">Place order</button></form>`, 'Place order'],
  'M2 multi-currency: converted total in euro': [`${css7}<form id="payment">${meta()}<h2>Checkout</h2>${row7('Item', '$18.00')}${row7('<b>Total (USD)</b>', '<b>$' + amt() + '</b>')}
<p class="muted">Approximately €16.60 at today's rate. Your card is charged in USD.</p>${card}<button id="pay">Pay $18.00</button></form>`, 'Pay $18.00'],
  'M3 sticky mini-cart with old total': [`${css7}<div style="position:fixed;top:0;right:0;background:#eee;padding:6px 12px;border:1px solid #ccc">Cart (2) · $14.00</div><form id="payment" style="margin-top:40px">${meta()}<h2>Order summary</h2>${row7('Fixture item × 2', '$14.00')}${row7('Shipping', '$4.00')}${row7('<b>Total</b>', '<b>$' + amt() + '</b>')}
${card}<button id="pay">Pay now</button></form>`, 'Pay now'],
  'M4 split payment gift card + card (total due)': [`${css7}<form id="payment">${meta()}<h2>Payment</h2>${row7('Order total', '$28.00')}${row7('Gift card ending 4411', '-$10.00')}${row7('<b>Remaining to pay by card</b>', '<b>$' + amt() + '</b>')}
<p class="muted">Gift card balance after this order: $0.00</p>${card}<button id="pay">Pay $18.00</button></form>`, 'Pay $18.00'],
  'M4b split payment: card charge line': [`${css7}<form id="payment">${meta()}<h2>Split payment</h2>${row7('Order total', '$28.00')}${row7('Paid with gift card', '$10.00')}${row7('Charged to your card', '<b>$' + amt() + '</b>')}
${card}<button id="pay">Pay with card</button></form>`, 'Pay with card'],
  'M5 invoice with past-due amount': [`${css7}<form id="payment">${meta()}<h2>Invoice INV-204</h2><p>Status: <b>Past due</b> since Sep 30</p>${row7('Original invoice amount', '$60.00')}${row7('Payments received', '$42.00')}${row7('<b>Amount due</b>', '<b>$' + amt() + '</b>')}
<p class="muted">A late fee of $5.00 applies if unpaid by Nov 15.</p>${card}<button id="pay">Pay invoice</button></form>`, 'Pay invoice'],
  'M5b invoice with previous balance line': [`${css7}<form id="payment">${meta()}<h2>Invoice INV-205</h2>${row7('Previous balance (paid)', '$42.00')}${row7('Current charges', '$18.00')}${row7('<b>Total due now</b>', '<b>$' + amt() + '</b>')}
${card}<button id="pay">Pay now</button></form>`, 'Pay now'],
};
// Known false ask: line items in euro beside a USD charge. A euro figure that does not call itself an estimate and is not in parentheses
// after the amount is not cleared, because there is no rate to compare it with.
const asks7 = {
  'M2b multi-currency: euro first, USD charge shown': [`${css7}<form id="payment">${meta()}<h2>Checkout</h2>${row7('Item', '€16.60')}${row7('<b>You pay</b>', '<b>$' + amt() + ' USD</b>')}
<p class="muted">Prices shown in EUR for your region (€16.60).</p>${card}<button id="pay">Pay now</button></form>`, 'Pay now'],
};
for (const [name, [html, label]] of Object.entries(honest7))
  test('realistic page ' + name + (askNow.has(name) ? ': asks (round 13: a figure above the amount)' : ': the exact payment is allowed once'), { skip, timeout: 90000 }, async t => {
    const r = await payOnce(t, html, label, { head: '<meta charset="utf-8">' });
    outcome.set(name, r.payment === 1);
    assert.equal(r.payment, askNow.has(name) ? 0 : 1, r.text);
  });
for (const [name, [html, label]] of Object.entries(asks7))
  test('realistic page ' + name + ': asks (known false ask)', { skip, timeout: 90000 }, async t => {
    const r = await payOnce(t, html, label, { head: '<meta charset="utf-8">' });
    outcome.set(name, r.payment === 1);
    assert.equal(r.payment, 0);
  });
test('allow rate over the 36 realistic pages (28 from rounds 5 and 6 plus the 8 of round 7) is at least 18/36 (round 13)', { skip }, t => {
  const real = [...outcome.values()].filter(Boolean).length + 2; // R4 and P3 are read directly, above
  t.diagnostic('allowed ' + real + '/36');
  assert.equal(outcome.size, 36 - 2);
  assert.ok(real >= 18, 'allowed ' + real + ' of 36');
});

test('F5 (round 7): estimates and conversion notes in another currency, invoice history, tender lines under an order total', { skip, timeout: 180000 }, async t => {
  const M = '<meta charset="utf-8">';
  const T = row7('<b>Total</b>', '<b>$' + amt() + '</b>');
  const P = inner => `${M}<form id="payment">${meta()}${inner}${card}<button id="pay">Pay now</button></form>`;
  await readCases(t, [
    // Another currency.
    ['ask: "Approximately €16.60 at today\'s rate."', P(T + '<p>Approximately €16.60 at today\'s rate.</p>'), 'ask'],
    ['ask: "≈ €16.60" beside the total', P(row7('<b>Total (USD)</b>', '<b>$' + amt() + '</b> <small>≈ €16.60</small>')), 'ask'],
    ['ask: "(€16.60)" in parentheses right after the amount', P(row7('<b>Total</b>', '<b>$' + amt() + '</b> (€16.60)')), 'ask'],
    ['ask: "Converted: €16.60"', P(T + '<p>Converted: €16.60</p>'), 'ask'],
    ['ask: a euro figure with no estimate marker', P(T + '<p>Charged: €500.00</p>'), 'ask'],
    ['ask: "Estimated total €500.00" (a pay word in its own label)', P(T + '<p>Estimated total €500.00</p>'), 'ask'],
    ['ask: "Total ≈ €500.00"', P(T + row7('Total ≈', '€500.00')), 'ask'],
    ['ask: "You will be charged approximately €500.00"', P(T + '<p>You will be charged approximately €500.00</p>'), 'ask'],
    ['ask: parentheses after a figure that is not the amount', P(row7('Tax', '$2.00 (€500.00)') + T), 'ask'],
    // Invoices.
    ['ask: Original invoice amount 60, Payments received 42, Amount due 18', P(row7('Original invoice amount', '$60.00') + row7('Payments received', '$42.00') + row7('<b>Amount due</b>', '<b>$' + amt() + '</b>')), 'ask'],
    ['ask: Invoice total 60, Paid to date 42, Balance due 18', P(row7('Invoice total', '$60.00') + row7('Paid to date', '$42.00') + row7('<b>Balance due</b>', '<b>$' + amt() + '</b>')), 'ask'],
    ['ask: Previous balance 42 (paid)', P(row7('Previous balance', '$42.00') + T), 'ask'],
    ['ask: Amount paid 500.00', P(row7('Amount paid', '$500.00') + T), 'ask'],
    ['ask: Credit applied -10.00 under a Subtotal', P(row7('Subtotal', '$28.00') + row7('Credit applied', '-$10.00') + T), 'ask'],
    ['ask: "Next invoice: $60.00 due Dec 1."', P('<p>Next invoice: $60.00 due Dec 1.</p>' + T), 'ask'],
    ['ask: "Past due" is the amount', P(row7('Original invoice amount', '$60.00') + row7('Payments received', '$42.00') + row7('Past due', '$' + amt())), 'ask'],
    ['allow: "Amount due" is the amount under a Past due status', P('<p>Status: Past due</p>' + row7('Amount due', '$' + amt())), 'allow'],
    ['ask: Original invoice amount 60 alone', P(row7('Original invoice amount', '$60.00') + T), 'ask'],
    ['ask: Invoice total 60 with only 30 paid', P(row7('Invoice total', '$60.00') + row7('Paid to date', '$30.00') + T), 'ask'],
    ['ask: "Payments received $500.00 charged now"', P(row7('Payments received', '$500.00 charged now') + T), 'ask'],
    ['ask: "Next invoice: $500.00 due today."', P('<p>Next invoice: $500.00 due today.</p>' + T), 'ask'],
    ['ask: a Past due figure that is not the amount', P(row7('Past due', '$500.00') + T), 'ask'],
    ['ask: two Past due figures, one of them 500.00', P(row7('Past due', '$' + amt()) + row7('Past due', '$500.00')), 'ask'],
    // Tender lines under "Order total".
    ['ask: Order total 28, Gift card -10', P(row7('Order total', '$28.00') + row7('Gift card', '-$10.00') + T), 'ask'],
    ['ask: Order total 28, Store credit applied -10', P(row7('Order total', '$28.00') + row7('Store credit applied', '-$10.00') + T), 'ask'],
    ['ask: Order total 28, Voucher -10', P(row7('Order total', '$28.00') + row7('Voucher', '-$10.00') + T), 'ask'],
    ['ask: Order total 28 with no tender line', P(row7('Order total', '$28.00') + T), 'ask'],
    ['ask: Order total 28 with a discount only', P(row7('Order total', '$28.00') + row7('Discount', '-$10.00') + T), 'ask'],
    ['ask: Order total 40 with a gift card of only -10', P(row7('Order total', '$40.00') + row7('Gift card', '-$10.00') + T), 'ask'],
    ['ask: Cart total 28 with a gift card -10', P(row7('Cart total', '$28.00') + row7('Gift card', '-$10.00') + T), 'ask'],
  ]);
});

// ---------------------------------------------------------------- Round 8
// Fixtures: the round 7 reviewer's 61 lines (charge statements behind exempt labels, estimates, tender lines, next invoices) with the
// outcome each must have, and the reviewer's 20 honest pages. Both are read directly, as in part 2.
const fixture8 = name => JSON.parse(readFileSync(new URL('./fixtures/pay-r8-' + name + '.json', import.meta.url), 'utf8'));
test('F-A to F-E (round 8): the reviewer\'s 61 lines (an exempt label never beats a charge statement, estimates must be near the amount, bought or unapplied tender lines close no gap)', { skip, timeout: 240000 }, async t => {
  await readCases(t, fixture8('reviewer-lines'));
});
test('F-A (round 8): charge words in the label or the clause take back an exemption; the plain labels stay allowed', { skip, timeout: 180000 }, async t => {
  const M = '<meta charset="utf-8">';
  const T = row7('<b>Total</b>', '<b>$' + amt() + '</b>');
  const P = inner => `${M}<form id="payment">${meta()}${inner}${card}<button id="pay">Pay now</button></form>`;
  await readCases(t, [
    ['ask: "Next invoice: $500.00 due at checkout."', P('<p>Next invoice: $500.00 due at checkout.</p>' + T), 'ask'],
    ['ask: "Next invoice: $500.00 due with this order."', P('<p>Next invoice: $500.00 due with this order.</p>' + T), 'ask'],
    ['ask: "Next invoice: $500.00 due upon submission."', P('<p>Next invoice: $500.00 due upon submission.</p>' + T), 'ask'],
    ['ask: "Next invoice: $500.00 due, charged to your card when you press Pay."', P('<p>Next invoice: $500.00 due, charged to your card when you press Pay.</p>' + T), 'ask'],
    ['ask: "Next invoice: $500.00 due as you pay."', P('<p>Next invoice: $500.00 due as you pay.</p>' + T), 'ask'],
    ['ask: "Next invoice: $500.00 (charged to your card now)"', P('<p>Next invoice: $500.00 (charged to your card now)</p>' + T), 'ask'],
    ['ask: "Next invoice: $500.00 due within 5 minutes."', P('<p>Next invoice: $500.00 due within 5 minutes.</p>' + T), 'ask'],
    ['ask: "Next invoice: $60.00 due Dec 1. Your card is charged $18.00 now."', P('<p>Next invoice: $60.00 due Dec 1. Your card is charged $18.00 now.</p>' + T), 'ask'],
    ['ask: "Previous balance to be charged"', P(row7('Previous balance to be charged', '$500.00') + T), 'ask'],
    ['ask: "Previous balance (added to this order)"', P(row7('Previous balance (added to this order)', '$500.00') + T), 'ask'],
    ['ask: "Prior payments due at checkout"', P(row7('Prior payments due at checkout', '$500.00') + T), 'ask'],
    ['ask: "Amount paid by card today"', P(row7('Amount paid by card today', '$500.00') + T), 'ask'],
    ['ask: "Payments made today"', P(row7('Payments made today', '$500.00') + T), 'ask'],
    ['ask: "Credit applied to your card"', P(row7('Credit applied to your card', '$500.00') + T), 'ask'],
    ['ask: label in a line above, clause in the same line as the figure', P(row7('Previous balance', '$500.00 will be charged to your card') + T), 'ask'],
    ['ask: label split over two lines above the figure', P('<div>Previous balance</div><div>(to be charged now)</div><div>$500.00</div>' + T), 'ask'],
    ['ask: "Payments received" under an invoice total, then a sentence about the charge', P(row7('Invoice total', '$60.00') + row7('Payments received', '$42.00') + row7('<b>Amount due</b>', '<b>$' + amt() + '</b>') + '<p>Your card is charged $18.00 now.</p>'), 'ask'],
    ['ask: "Previous balance $42.00 (paid)"', P(row7('Previous balance (paid)', '$42.00') + T), 'ask'],
    // Estimates: within a factor of five of the amount, and no charge word.
    ['ask: "About €500.00 will be charged to your card."', P(T + '<p>About €500.00 will be charged to your card.</p>'), 'ask'],
    ['ask: "About €16.60 will be charged to your card."', P(T + '<p>About €16.60 will be charged to your card.</p>'), 'ask'],
    ['ask: "≈ €500.00" beside the total', P(row7('<b>Total</b>', '<b>$' + amt() + '</b> <small>≈ €500.00</small>')), 'ask'],
    ['ask: "(€500.00)" right after the amount', P(row7('<b>Total</b>', '<b>$' + amt() + '</b> (€500.00)')), 'ask'],
    ['ask: "Equivalent €500.00" in a row', P(T + row7('Equivalent', '€500.00')), 'ask'],
    ['ask: "≈ €100.00" is more than five times the amount', P(row7('<b>Total</b>', '<b>$' + amt() + '</b> <small>≈ €100.00</small>')), 'ask'],
    ['ask: "≈ €3.00" is less than a fifth of the amount', P(row7('<b>Total</b>', '<b>$' + amt() + '</b> <small>≈ €3.00</small>')), 'ask'],
    ['ask: "≈ €3.60" is a fifth of the amount', P(row7('<b>Total</b>', '<b>$' + amt() + '</b> <small>≈ €3.60</small>')), 'ask'],
    ['ask: "≈ €90.00" is five times the amount', P(row7('<b>Total</b>', '<b>$' + amt() + '</b> <small>≈ €90.00</small>')), 'ask'],
    ['ask: "Equivalent €16.60" in a row', P(T + row7('Equivalent', '€16.60')), 'ask'],
    ['ask: "Approximately €16.60 at today\'s rate. Your card is charged in USD."', P(T + '<p>Approximately €16.60 at today\'s rate. Your card is charged in USD.</p>'), 'ask'],
  ]);
});
test('F-D (round 8): a gift card, voucher or store credit that is bought, optional, unused or not applied closes no gap', { skip, timeout: 120000 }, async t => {
  const M = '<meta charset="utf-8">';
  const D = row7('<b>Total due</b>', '<b>$' + amt() + '</b>');
  const P = inner => `${M}<form id="payment">${meta()}${inner}${card}<button id="pay">Pay now</button></form>`;
  const gap = (label, value = '$500.00') => P(row7('Order total', '$518.00') + row7(label, value) + D);
  await readCases(t, [
    ['ask: Gift card applied -$500.00', gap('Gift card applied', '-$500.00'), 'ask'],
    ['ask: Store credit applied -$500.00', gap('Store credit applied', '-$500.00'), 'ask'],
    ['ask: Gift card (balance $500.00) then -$500.00', P(row7('Order total', '$518.00') + row7('Gift card (balance $500.00)', '-$500.00') + D), 'ask'],
    ['ask: Gift card purchase', gap('Gift card purchase'), 'ask'],
    ['ask: Gift card (add to order)', gap('Gift card (add to order)'), 'ask'],
    ['ask: Buy a gift card', gap('Buy a gift card'), 'ask'],
    ['ask: Voucher not applied', gap('Voucher not applied'), 'ask'],
    ['ask: Gift card available', gap('Gift card available'), 'ask'],
    ['ask: Gift card balance', gap('Gift card balance'), 'ask'],
    ['ask: Store credit (optional)', gap('Store credit (optional)'), 'ask'],
    ['ask: Voucher (not valid)', gap('Voucher code SAVE (not valid)'), 'ask'],
    ['ask: Store credit unused', gap('Store credit unused'), 'ask'],
    ['ask: Gift card, offered with an if', gap('Gift card (if you apply it)'), 'ask'],
  ]);
});
test('F-E (round 8): "Invoice #88" labels, an Equivalent row, new charges beside a previous balance', { skip, timeout: 120000 }, async t => {
  const M = '<meta charset="utf-8">';
  const D = row7('<b>Balance due</b>', '<b>$' + amt() + '</b>');
  const P = inner => `${M}<form id="payment">${meta()}${inner}${card}<button id="pay">Pay now</button></form>`;
  await readCases(t, [
    ['ask: Invoice #88 58, Previous payments 40, Balance due 18', P(row7('Invoice #88', '$58.00') + row7('Previous payments', '$40.00') + D), 'ask'],
    ['ask: Invoice #88 58 alone', P(row7('Invoice #88', '$58.00') + D), 'ask'],
    ['ask: Invoice #88 58 with only 10 paid', P(row7('Invoice #88', '$58.00') + row7('Previous payments', '$10.00') + D), 'ask'],
    ['ask: Invoice #88 58, Previous payments 40 charged now', P(row7('Invoice #88', '$58.00') + row7('Previous payments', '$40.00 charged now') + D), 'ask'],
    ['allow: Previous balance 12, New charges 6, Total due 18', P(row7('Previous balance', '$12.00') + row7('New charges', '$6.00') + row7('<b>Total due</b>', '<b>$' + amt() + '</b>')), 'allow'],
    ['ask: New charges 500', P(row7('Previous balance', '$12.00') + row7('New charges', '$500.00') + row7('<b>Total due</b>', '<b>$' + amt() + '</b>')), 'ask'],
    ['ask: Previous balance to be charged 12 beside New charges 500', P(row7('Previous balance to be charged', '$12.00') + row7('New charges', '$500.00') + row7('<b>Total due</b>', '<b>$' + amt() + '</b>')), 'ask'],
  ]);
});
test('round 8: the reviewer\'s 20 honest pages allow at least 9/20, and with the suite 36 realistic pages at least 27/56 (round 13)', { skip, timeout: 180000 }, async t => {
  const b = await bank(t), page = await b.host.newPage(), cases = fixture8('honest-20');
  let allowed = 0;
  try {
    for (const [name, html] of cases) {
      await page.setContent('<!doctype html><body style="margin:8px"><main>' + html);
      let amount; try { amount = (await trustedLocatorRead(page.locator('#pay').first(), readPaymentPage)).page?.amount; } catch { amount = undefined; }
      if (amount === '18.00') allowed++; else t.diagnostic('asks: ' + name);
    }
  } finally { await page.close(); }
  const real = [...outcome.values()].filter(Boolean).length + 2;
  t.diagnostic('reviewer 20: ' + allowed + '/20; suite 36: ' + real + '/36; together ' + (allowed + real) + '/' + (cases.length + 36));
  assert.ok(allowed >= 9, allowed + '/20');
  assert.ok(allowed + real >= 27, 'together ' + (allowed + real) + '/56');
});

// ---------------------------------------------------------------- Round 9
// Exemptions are closed lists of positive phrases. Fixture pay-r9-closed-phrases: the round 8 reviewer's ph/ph2 (29 settled, next-invoice
// and estimate wordings that must ask), tender (unsigned lines that must not close a gap), bis and honest5 (honest notes, unit rates),
// plus this round's own allow and ask lines.
const fixture9 = JSON.parse(readFileSync(new URL('./fixtures/pay-r9-closed-phrases.json', import.meta.url), 'utf8'));
test('F-A, F-D, F-G (round 9): closed positive phrases for settled, next-invoice, estimate and tender lines; late fee, optional and average notes; per-unit rates', { skip, timeout: 600000 }, async t => {
  await readCases(t, fixture9);
});
test('round 9: honest allow rate over the 36 suite pages, the 20 reviewer pages and the reviewer\'s 12 pages is at least 34/68 (round 13)', { skip, timeout: 180000 }, async t => {
  const b = await bank(t), page = await b.host.newPage();
  let twenty = 0, twelve = 0;
  const read = async html => { await page.setContent('<!doctype html><body style="margin:8px"><main>' + html); try { return (await trustedLocatorRead(page.locator('#pay').first(), readPaymentPage)).page?.amount === '18.00'; } catch { return false; } };
  try {
    for (const [, html] of fixture8('honest-20')) if (await read(html)) twenty++;
    for (const [name, html] of fixture9) if (/^N(?:[1-9]|1[0-2]) /.test(name) && await read(html)) twelve++;
  } finally { await page.close(); }
  const real = [...outcome.values()].filter(Boolean).length + 2;
  t.diagnostic('suite 36: ' + real + '; reviewer 20: ' + twenty + '; reviewer 12: ' + twelve + '; together ' + (real + twenty + twelve) + '/68');
  assert.ok(twenty >= 9 && twelve >= 7, twenty + ' of 20, ' + twelve + ' of 12');
  assert.ok(real + twenty + twelve >= 34, 'together ' + (real + twenty + twelve) + '/68');
});

// ---------------------------------------------------------------- Round 10
// Every exemption needs the whole label to be a closed phrase, and the rest of the sentence (across later figures) to be closed too.
// Fixture pay-r10-labels: the round 9 reviewer's ~110 phrasings (a, b, c, d, e, g, h) and this round's own (n1 to n5), 698 bodies with
// the outcome each must have (181 allow: the exact closed phrases, the controls and the known limits; 517 ask). Fixture pay-r10-honest:
// the reviewer's 10 industry pages (honest10, 10/10 allow) and the bisected pieces of them (bis10*, all allow), each with its own amount.
const fixture10 = name => JSON.parse(readFileSync(new URL('./fixtures/pay-r10-' + name + '.json', import.meta.url), 'utf8'));
const form10 = body => `<form id=payment>${meta()}${body}<label>Card number<input autocomplete="cc-number"></label><button id=pay>Pay now</button></form>`;
test('F-A, F-B, F-C, F-D (round 10): 698 closed-label bodies (every charge phrasing of the round 9 review asks; since round 13 so do the closed phrases that stood above the amount)', { skip, timeout: 900000 }, async t => {
  await readCases(t, fixture10('labels').map(([name, body, expect]) => [name, form10(body), expect]));
});
test('F-D (round 10): the reviewer\'s 10 industry pages and their 36 bisected pieces allow with their own amounts', { skip, timeout: 300000 }, async t => {
  const b = await bank(t), page = await b.host.newPage();
  try {
    for (const [name, html, amount, expect] of fixture10('honest'))
      await t.test(name, async () => {
        await page.setContent('<!doctype html><body style="margin:8px"><main>' + html);
        let read; try { read = (await trustedLocatorRead(page.locator('#pay').first(), readPaymentPage)).page?.amount; } catch { read = undefined; }
        assert.equal(read === amount ? 'allow' : 'ask', expect, name + ' read amount=' + read);
      });
  } finally { await page.close(); }
});
test('F-A (round 10): ten of the reviewer\'s charge phrasings, clicked through the real route, do not reach the network', { skip, timeout: 300000 }, async t => {
  const T = row7('<b>Total</b>', '<b>$' + amt() + '</b>');
  const pages = {
    'F1 Debited and applied: $500.00': '<p>Debited and applied: $500.00</p>' + T,
    'F1b Service fee applied $500.00': row7('Service fee applied', '$500.00') + T,
    'A2 Your account will be debited an average of $500.00.': '<p>Your account will be debited an average of $500.00.</p>' + T,
    'A7 Your card will be captured an average of $500.00': '<p>Your card will be captured an average of $500.00</p>' + T,
    'E1 Late fee debited from your card: $500.00': '<p>Late fee debited from your card: $500.00</p>' + T,
    'E2 Cancellation fee captured on your card: $500.00': '<p>Cancellation fee captured on your card: $500.00</p>' + T,
    'U1 Your account will be debited up to $500.00.': '<p>Your account will be debited up to $500.00.</p>' + T,
    'M1 Previous balance: $500.00 ($0.00 tax) will be withdrawn from your card.': '<p>Previous balance: $500.00 ($0.00 tax) will be withdrawn from your card.</p>' + T,
    'LF2 A $500.00 late fee is added within minutes.': '<p>A $500.00 late fee is added within minutes.</p>' + T,
    'O3 Optional debit: $500.00': '<p>Optional debit: $500.00</p>' + T,
  };
  for (const [name, body] of Object.entries(pages))
    await t.test(name, async t2 => {
      const r = await payOnce(t2, form(body), 'Pay', { head: '<meta charset="utf-8">' });
      assert.equal(r.payment, 0, name + ': ' + r.text);
    });
});
test('round 10: honest allow rate over the 36 suite pages, the 20 reviewer pages, the reviewer\'s 12 pages and the 10 industry pages is at least 40/78 (round 13)', { skip, timeout: 180000 }, async t => {
  const b = await bank(t), page = await b.host.newPage();
  let twenty = 0, twelve = 0, ten = 0;
  const read = async (html, amount = '18.00') => { await page.setContent('<!doctype html><body style="margin:8px"><main>' + html); try { return (await trustedLocatorRead(page.locator('#pay').first(), readPaymentPage)).page?.amount === amount; } catch { return false; } };
  try {
    for (const [, html] of fixture8('honest-20')) if (await read(html)) twenty++;
    for (const [name, html] of fixture9) if (/^N(?:[1-9]|1[0-2]) /.test(name) && await read(html)) twelve++;
    for (const [name, html, amount] of fixture10('honest')) if (/^honest10 /.test(name) && await read(html, amount)) ten++;
  } finally { await page.close(); }
  const real = [...outcome.values()].filter(Boolean).length + 2;
  t.diagnostic('suite 36: ' + real + '; reviewer 20: ' + twenty + '; reviewer 12: ' + twelve + '; industry 10: ' + ten + '; together ' + (real + twenty + twelve + ten) + '/78');
  assert.ok(twenty >= 9 && twelve >= 7 && ten >= 6, twenty + ' of 20, ' + twelve + ' of 12, ' + ten + ' of 10');
  assert.ok(real + twenty + twelve + ten >= 40, 'together ' + (real + twenty + twelve + ten) + '/78');
});

// ---------------------------------------------------------------- Round 11
// F-A: a savings noun clears a figure larger than the amount only with the whole label in a closed savings vocabulary, a minus sign, or a
// gross figure it reconciles to; "after/with/net of/less/final/remaining/outstanding/balance" + a savings noun is a pay label.
// F-B: the text of a chosen control (checked box or radio, aria-checked, selected option, a linked label) is an add-on the user will pay:
// one larger than the amount, or chosen figures that together exceed it, ask whatever the label says ("Optional ..." too; the round 10
// expectation "d R O6 Optional tip checked" allow became ask). F-C: a count of 0 days or hours is now; "now" and "today" are not filler
// in a late fee label. F-D: fee-type parts are added up; unsigned savings figures outside the order summary and "Rewards" without
// a minus sign or "applied" close no gap. F-E: a deposit or installment due now equal to the amount lets the estimated total, the
// remaining balance and the items of that bill stand; "After <date> the fine becomes $X" is a note.
// Fixture pay-r11-labels: the round 10 reviewer's fam6 (language prefixes), fam8 (after/with/net), fam11 (checked boxes), fam3 (late fee),
// fam7 (fee-type parts), fam9 (discount sums, banners, sidebars) and this round's own extras (425 bodies). Fixture pay-r11-honest: the
// reviewer's 10 new honest pages (grocery and car rental hold a pre-authorization or deposit hold and ask on purpose; the tuition page
// asks because its items are larger than the installment and no total is shown).
const fixture11 = name => JSON.parse(readFileSync(new URL('./fixtures/pay-r11-' + name + '.json', import.meta.url), 'utf8'));
test('F-A to F-E (round 11): 425 bodies (every charge phrasing of the round 10 review asks; since round 13 so do the closed phrases and honest bills with a figure above the amount)', { skip, timeout: 900000 }, async t => {
  await readCases(t, fixture11('labels').map(([name, body, expect]) => [name, form10(body), expect]));
});
test('F-E (round 11): the reviewer\'s 10 new honest pages read with their own amounts (round 13: 5/10 allow; the holds, the tuition page and the pages with a figure above the amount ask)', { skip, timeout: 300000 }, async t => {
  const b = await bank(t), page = await b.host.newPage();
  try {
    for (const [name, html, amount, expect] of fixture11('honest'))
      await t.test(name, async () => {
        await page.setContent('<!doctype html><body style="margin:8px"><main>' + html);
        let read; try { read = (await trustedLocatorRead(page.locator('#pay').first(), readPaymentPage)).page?.amount; } catch { read = undefined; }
        assert.equal(read === amount ? 'allow' : 'ask', expect, name + ' read amount=' + read);
      });
  } finally { await page.close(); }
});
test('F-A, F-B, F-C (round 11): twelve of the reviewer\'s charge phrasings, clicked through the real route, do not reach the network', { skip, timeout: 600000 }, async t => {
  const T = row7('<b>Total</b>', '<b>$' + amt() + '</b>');
  const X = '$500.00';
  const pages = {
    'K1 checked Optional insurance': `<label><input type=checkbox checked> Optional insurance ${X}</label>` + T,
    'K1b checked Optional tip': `<label><input type=checkbox checked> Optional tip ${X}</label>` + T,
    'K6 checked Insurance from': `<label><input type=checkbox checked> Insurance from ${X}</label>` + T,
    'K2 aria checked Optional protection': `<div role=checkbox aria-checked=true>Optional protection ${X}</div>` + T,
    'K4 selected option Optional tip': `<select><option selected>Optional tip ${X}</option><option>No tip</option></select>` + T,
    'K5 bare checked box row': `<div><input type=checkbox checked> Optional tip ${X}</div>` + T,
    'P1 Zu zahlen discount': row7('Zu zahlen discount', X) + T,
    'P2 Montant prélevé discount': row7('Montant prélevé discount', X) + T,
    'P3 Débit coupon': row7('Débit coupon', X) + T,
    'A1 Final after coupon': row7('Final after coupon', X) + T,
    'A2 Balance after discount': row7('Balance after discount', X) + T,
    'A3 Outstanding after promo': row7('Outstanding after promo', X) + T,
    'L1 A $500.00 late fee applies after 0 hours.': `<p>A ${X} late fee applies after 0 hours.</p>` + T,
    'L2 Late fee now': row7('Late fee now', X) + T,
    'S5 rewards banner beside a $500.00 service fee': row7('Service fee', X) + '<p>Rewards: $482.00 available</p>' + T,
    'D1 Booking payment + Security payment, $17.99 each': row7('Booking payment', '$17.99') + row7('Security payment', '$17.99') + T,
    'H1 control: a plain Service fee $500.00': row7('Service fee', X) + T,
  };
  for (const [name, body] of Object.entries(pages))
    await t.test(name, async t2 => {
      const r = await payOnce(t2, form(body), 'Pay', { head: '<meta charset="utf-8">' });
      assert.equal(r.payment, name.startsWith('D1 ') ? 1 : 0, name + ': ' + r.text); // round 13: D1 has two parts within the amount and no figure above it
    });
});
test('round 11: honest allow rate over the 36 suite pages, 20 + 12 + 10 reviewer pages and the 10 new pages is at least 45/88 (round 13; the two holds count as correct asks)', { skip, timeout: 240000 }, async t => {
  const b = await bank(t), page = await b.host.newPage();
  let twenty = 0, twelve = 0, ten = 0, fresh = 0;
  const read = async (html, amount = '18.00') => { await page.setContent('<!doctype html><body style="margin:8px"><main>' + html); try { return (await trustedLocatorRead(page.locator('#pay').first(), readPaymentPage)).page?.amount === amount; } catch { return false; } };
  try {
    for (const [, html] of fixture8('honest-20')) if (await read(html)) twenty++;
    for (const [name, html] of fixture9) if (/^N(?:[1-9]|1[0-2]) /.test(name) && await read(html)) twelve++;
    for (const [name, html, amount] of fixture10('honest')) if (/^honest10 /.test(name) && await read(html, amount)) ten++;
    for (const [, html, amount] of fixture11('honest')) if (await read(html, amount)) fresh++;
  } finally { await page.close(); }
  const real = [...outcome.values()].filter(Boolean).length + 2;
  const total = real + twenty + twelve + ten + fresh;
  t.diagnostic('suite 36: ' + real + '; reviewer 20: ' + twenty + '; reviewer 12: ' + twelve + '; industry 10: ' + ten + '; new 10: ' + fresh + '; together ' + total + '/88, with the 2 holds counted as correct asks ' + (total + 2) + '/88');
  assert.ok(twenty >= 9 && twelve >= 7 && ten >= 6, twenty + ' of 20, ' + twelve + ' of 12, ' + ten + ' of 10');
  assert.ok(total + 2 >= 47, 'together ' + total + '/88');
});

// ---------------------------------------------------------------- Round 12
// F-A2: the closed-label check and the deny list run on EVERY exempt label (not only those with a savings noun): all words must be in a closed
// vocabulary, one foreign or unknown word makes the figure a plain part, with or without a minus sign (the gross reconcile and the minus-sign
// exception for an unclosed label are gone), and a code after "code/promo/coupon/voucher/offer" ("code SAVE10") is blanked, never read as "save".
// F-B2: a checked box or radio, or an aria-checked, aria-pressed or aria-selected element, marks every money figure in its row (the nearest
// ancestor that holds a figure, shadow trees and slotted labels included, never the form or a block that holds the Pay control) and the inline
// run after it. F-E2: under a deposit pair a part whose label or sentence says charged, billed, debited, withdrawn, taken, card... still asks.
// F-H: an exempt label that follows a sentence that is not savings talk, or a line that says money is charged, is a plain part.
// F-G (closed lists): "Welcome offer" with a minus sign, "(covers ... up to $X)" after a price within the amount, a coverage limit or deductible
// beside an insurance premium, and "renews each week at $X plus shipping" are notes. Fixture pay-r12-labels: the round 11 reviewer's fam1, fam2,
// fam3, fam3b, fam4, fam4b, fam4c, fam5 and fam6 probes (569 bodies) and this round's own (88). Fixture pay-r12-honest: the reviewer's 10 new honest pages.
const fixture12 = name => JSON.parse(readFileSync(new URL('./fixtures/pay-r12-' + name + '.json', import.meta.url), 'utf8'));
test('F-A2, F-B2, F-E2, F-H, F-G (round 12): 657 bodies (every charge phrasing of the round 11 review asks; since round 13 so do the closed phrases that stood above the amount)', { skip, timeout: 900000 }, async t => {
  await readCases(t, fixture12('labels').map(([name, body, expect]) => [name, form10(body), expect]));
});
test('F-G (round 12): the reviewer\'s 10 new honest pages read with their own amounts (round 13: 1/10 allow; any figure above the amount asks)', { skip, timeout: 300000 }, async t => {
  const b = await bank(t), page = await b.host.newPage();
  try {
    for (const [name, html, amount, expect] of fixture12('honest'))
      await t.test(name, async () => {
        await page.setContent('<!doctype html><body style="margin:8px"><main>' + html);
        let read; try { read = (await trustedLocatorRead(page.locator('#pay').first(), readPaymentPage)).page?.amount; } catch { read = undefined; }
        assert.equal(read === amount ? 'allow' : 'ask', expect, name + ' read amount=' + read);
      });
  } finally { await page.close(); }
});
test('F-A2, F-B2, F-E2 (round 12): the reviewer\'s 13 charge pages and 2 controls, clicked through the real route, do not reach the network', { skip, timeout: 600000 }, async t => {
  const T = row7('<b>Total</b>', '<b>$' + amt() + '</b>');
  const X = '$500.00', D = row7('Deposit due now', '$' + amt());
  const pages = {
    'R1 Outstanding after code SAVE10': row7('Outstanding after code SAVE10', X) + T,
    'R2 Balance with code SAVE20': row7('Balance with code SAVE20', X) + T,
    'R3 Remaining after code WELCOME-SAVE': row7('Remaining after code WELCOME-SAVE', X) + T,
    'R4 After code SAVE10': row7('After code SAVE10', X) + T,
    'R5 Zu zahlen code applied': row7('Zu zahlen code applied', X) + T,
    'R6 Montant prélevé points redeemed': row7('Montant prélevé points redeemed', X) + T,
    'R7 Abgebucht offer redeemed': row7('Abgebucht offer redeemed', X) + T,
    'R8 table row checked Optional insurance': `<table><tr><td><input type=checkbox checked></td><td>Optional insurance</td><td>${X}</td></tr></table>` + T,
    'R9 form-check box, price in its own column': `<div style="display:flex"><div><input type=checkbox checked id=bx><label for=bx>Optional insurance</label></div><div style="margin-left:20px">${X}</div></div>` + T,
    'R10 aria-pressed Optional insurance': `<button type=button aria-pressed=true>Optional insurance ${X}</button>` + T,
    'R11 span-wrapped box row': `<div class=row><span><input type=checkbox checked></span> <span>Optional insurance</span> <span>${X}</span></div>` + T,
    'R12 deposit, Service fee charged now, Estimated total': D + '<p>Service fee $500.00 charged now</p>' + row7('Estimated total', '$2,000.00'),
    'R13 deposit, Card fee, Estimated total': D + row7('Card fee', X) + row7('Estimated total', '$2,000.00'),
    'R14 control: a plain Service fee $500.00': row7('Service fee', X) + T,
    'R15 control: Zu zahlen discount $500.00': row7('Zu zahlen discount', X) + T,
  };
  for (const [name, body] of Object.entries(pages))
    await t.test(name, async t2 => {
      const r = await payOnce(t2, form(body), 'Pay', { head: '<meta charset="utf-8">' });
      assert.equal(r.payment, 0, name + ': ' + r.text);
    });
});
test('round 12: honest allow rate over the 36 suite pages, 20 + 12 + 10 + 10 reviewer pages and the 20 pages of rounds 11 and 12 is at least 46/98 (round 13; the two holds count as correct asks)', { skip, timeout: 240000 }, async t => {
  const b = await bank(t), page = await b.host.newPage();
  let twenty = 0, twelve = 0, ten = 0, fresh = 0, newest = 0;
  const read = async (html, amount = '18.00') => { await page.setContent('<!doctype html><body style="margin:8px"><main>' + html); try { return (await trustedLocatorRead(page.locator('#pay').first(), readPaymentPage)).page?.amount === amount; } catch { return false; } };
  try {
    for (const [, html] of fixture8('honest-20')) if (await read(html)) twenty++;
    for (const [name, html] of fixture9) if (/^N(?:[1-9]|1[0-2]) /.test(name) && await read(html)) twelve++;
    for (const [name, html, amount] of fixture10('honest')) if (/^honest10 /.test(name) && await read(html, amount)) ten++;
    for (const [, html, amount] of fixture11('honest')) if (await read(html, amount)) fresh++;
    for (const [, html, amount] of fixture12('honest')) if (await read(html, amount)) newest++;
  } finally { await page.close(); }
  const real = [...outcome.values()].filter(Boolean).length + 2;
  const total = real + twenty + twelve + ten + fresh + newest;
  t.diagnostic('suite 36: ' + real + '; reviewer 20: ' + twenty + '; reviewer 12: ' + twelve + '; industry 10: ' + ten + '; round 11 new 10: ' + fresh + '; round 12 new 10: ' + newest + '; together ' + total + '/98, with the 2 holds counted as correct asks ' + (total + 2) + '/98');
  assert.ok(twenty >= 9 && twelve >= 7 && ten >= 6 && newest >= 1, twenty + ' of 20, ' + twelve + ' of 12, ' + ten + ' of 10, ' + newest + ' of 10');
  assert.ok(total + 2 >= 48, 'together ' + total + '/98');
});

// ---------------------------------------------------------------- Round 13
// The payment read no longer reads wording. Any visible money figure (any currency, any label, any sign) larger than the amount asks, a figure
// in another currency asks, an image or canvas mark, a spelled-out number and digits with a letter glued on ("$5OO.00") ask, and a chosen control
// whose figure is not the amount asks. Figures equal to or below the amount (parts, unit prices, discounts, taxes) do not. Every fixture of rounds
// 4 to 12 that expected an allow because of a label (savings, was price, tender, settled payment, estimate, late fee, coverage, deposit...) with a
// figure above the amount now expects ask (389 fixture bodies, 55 inline cases and 14 realistic pages). Thirteen fixtures that expected ask had
// only figures at or below the amount (a "Payment" or "Charge" of $5.00 beside a $18.00 total, fee-type parts that add up, a unit price) and now allow.
