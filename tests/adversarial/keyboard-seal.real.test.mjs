import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, readOnly, skip } from './fixtures/bank.mjs';

// The key shield seals where Enter goes (form owner, action, method, target, default submitter and its formaction) and, after the
// first keydown, the data the page chose for the request (the default submitter's name and value, the form's hidden inputs). A
// keydown handler that changes any of it is vetoed. A handler that only disables the default submitter makes Chrome do nothing.
// The page also holds a second submit button (Continue, formaction=/charge) that the model never checked: no case may click it.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const N = Number(process.env.N ?? 4);
const form = (pre = '', post = '') => `<form id="f" action="/search">${pre}<input id="a" name="q" aria-label="Search">
<button id="real" type="submit">Search</button>${post}<button id="pay" type="submit" formaction="/charge" formmethod="post">Continue</button></form>`;
// Handlers that change data the request carries, to the same action: vetoed.
const data = {
  'S6 submitter text, aria-label, value and name changed': [form(), `a.addEventListener('keydown',()=>{real.textContent='Pay now';real.setAttribute('aria-label','Pay now');real.value='pay';real.name='intent';})`],
  'S8 hidden input flipped from save to charge': [form('<input type=hidden id=op name=op value=save>'), `a.addEventListener('keydown',()=>{op.value='charge';})`],
  'R10 submitter name and value set to intent=charge': [form(), `a.addEventListener('keydown',()=>{real.name='intent';real.value='charge';})`],
  'D1 hidden input renamed': [form('<input type=hidden id=op name=op value=save>'), `a.addEventListener('keydown',()=>{op.name='intent';})`],
  'D2 hidden input added': [form('<input type=hidden id=op name=op value=save>'), `a.addEventListener('keydown',()=>{const h=document.createElement('input');h.type='hidden';h.name='amount';h.value='9999';f.append(h);})`],
  'D3 hidden input removed': [form('<input type=hidden id=op name=op value=save>'), `a.addEventListener('keydown',()=>{op.remove();})`],
  'D4 hidden input value flipped at keypress': [form('<input type=hidden id=op name=op value=save>'), `a.addEventListener('keypress',()=>{op.value='charge';})`],
  'D5 hidden input outside the form, form= attribute, flipped': [form('', '<input type=hidden form=f id=op name=op value=save>'), `a.addEventListener('keydown',()=>{op.value='charge';})`],
};
// Handlers that change where the key goes: vetoed, or Chrome does nothing. Never the /charge button.
const routes = Object.assign({}, {
  'S1 disable real default submitter': [form(), `a.addEventListener('keydown',()=>{real.disabled=true;})`],
  'S1b disable real default submitter at keypress': [form(), `a.addEventListener('keypress',()=>{real.disabled=true;})`],
  'S2 disable fieldset around real submitter': [form('', '').replace('<button id="real" type="submit">Search</button>', '<fieldset id="fs"><button id="real" type="submit">Search</button></fieldset>'), `a.addEventListener('keydown',()=>{fs.disabled=true;})`],
  'S3 real submitter type -> button': [form(), `a.addEventListener('keydown',()=>{real.type='button';})`],
  'S4 remove real submitter': [form(), `a.addEventListener('keydown',()=>{real.remove();})`],
  'S5 real submitter form= other': [form(), `a.addEventListener('keydown',()=>{real.setAttribute('form','nonexistent');})`],
  'S6 swap text/value/aria-label of real submitter': [form(), `a.addEventListener('keydown',()=>{real.textContent='Pay now';real.setAttribute('aria-label','Pay now');real.value='pay';real.name='intent';})`],
  'S7 no real submitter; only input type text->submit': [`<form id="f" action="/search"><input id="a" name="q" aria-label="Search"><input id="b" type="text" value="Pay"></form>`, `a.addEventListener('keydown',()=>{b.type='submit';})`],
  'S8 hidden field value flip': [form('<input type=hidden id=op name=op value=save>'), `a.addEventListener('keydown',()=>{op.value='charge';})`],
  'S9 real submitter hidden attr + disabled after keydown via setTimeout 0': [form(), `a.addEventListener('keydown',()=>{setTimeout(()=>{real.disabled=true;},0);})`],
  'S10 disable checked input itself': [form(), `a.addEventListener('keydown',()=>{a.disabled=true;})`],
  'S11 real submitter disabled + pay has formaction charge, via fieldset toggle at keyup': [form(), `a.addEventListener('keyup',()=>{real.disabled=true;})`],
  'S12 real submitter display none + disabled attr via aria': [form(), `a.addEventListener('keydown',()=>{real.setAttribute('disabled','');real.setAttribute('hidden','');})`],
}, {
  'R1 move pay before real (tree order)': [form(), `a.addEventListener('keydown',()=>{f.insertBefore(pay,real);})`],
  'R2 insert new first submit with formaction': [form(), `a.addEventListener('keydown',()=>{const n=document.createElement('button');n.id='newpay';n.formAction='/charge';n.textContent='Go';f.prepend(n);})`],
  'R3 move checked input into another form': [form() + '<form id="g" action="/charge" method="post"><button id="gp">Buy</button></form>', `a.addEventListener('keydown',()=>{g.prepend(a);})`],
  'R4 set form attr on checked input': [form() + '<form id="g" action="/charge" method="post"><button id="gp">Buy</button></form>', `a.addEventListener('keydown',()=>{a.setAttribute('form','g');})`],
  'R5 change form action': [form(), `a.addEventListener('keydown',()=>{f.action='/charge';})`],
  'R6 change real formaction': [form(), `a.addEventListener('keydown',()=>{real.formAction='/charge';})`],
  'R7 change form target': [form(), `a.addEventListener('keydown',()=>{f.target='_blank';})`],
  'R8 submitter ident same, form.method->post': [form(), `a.addEventListener('keydown',()=>{f.method='post';})`],
  'R9 form id/name change only (benign)': [form(), `a.addEventListener('keydown',()=>{f.id='f2';f.name='checkout';})`],
  'R10 real submitter name/value -> intent=charge (data)': [form(), `a.addEventListener('keydown',()=>{real.name='intent';real.value='charge';})`],
});
for (const key of ['S6 swap text/value/aria-label of real submitter', 'S8 hidden field value flip', 'R10 real submitter name/value -> intent=charge (data)']) delete routes[key];
async function run(t, html, script, key = 'Enter') {
  const b = await bank(t);
  const f = await b.start(doc(html, script + `;window.__clicks=[];addEventListener('click',e=>__clicks.push(e.target.id||e.target.localName),true);`), readOnly);
  b.routes.set('/charge', '<title>c</title>charge'); b.routes.set('/search', '<title>s</title>search');
  const out = { vetoed: 0, searched: 0, charged: 0, paid: 0, clicksOnPay: 0, firstLines: new Set() };
  for (let i = 0; i < N; i++) {
    await f.page.goto(b.origin + '/attack-1');
    const text = await f.read(), before = b.effects.payment, h = f.hits().length;
    const r = await f.act([{ do: 'press', ref: f.ref('Search', text), key }]);
    await sleep(150);
    const clicks = await f.page.evaluate(() => window.__clicks).catch(() => []);
    const hits = f.hits().slice(h);
    out.firstLines.add(r.text.split('\n')[0].replace(/\d+/g, '#').slice(0, 100));
    if (/may have activated|changed|different|not run/.test(r.text)) out.vetoed++;
    out.searched += hits.filter(x => x.path.startsWith('/search')).length;
    out.charged += hits.filter(x => x.path.startsWith('/charge')).length;
    out.paid += b.effects.payment - before;
    out.clicksOnPay += Array.isArray(clicks) ? clicks.filter(x => x === 'pay').length : 0;
  }
  t.diagnostic(JSON.stringify({ ...out, firstLines: [...out.firstLines] }));
  return out;
}
for (const [name, [html, script]] of Object.entries(data))
  test('data swap in the first keydown handler is vetoed: ' + name, { skip, timeout: 170000 }, async t => {
    const out = await run(t, html, script);
    assert.equal(out.paid, 0); assert.equal(out.charged, 0); assert.equal(out.clicksOnPay, 0);
    assert.equal(out.searched, 0, 'the request must not leave with data the page chose after the check: ' + [...out.firstLines].join(' | '));
    assert.equal(out.vetoed, N, [...out.firstLines].join(' | '));
  });
for (const [name, [html, script]] of Object.entries(routes))
  test('routing change in a keydown handler never reaches the unchecked button: ' + name, { skip, timeout: 170000 }, async t => {
    // The page counts any submit as a payment, so a submit of the checked form (the model asked for it) shows in out.paid; only the
    // unchecked button matters here.
    const out = await run(t, html, script);
    assert.equal(out.charged, 0, [...out.firstLines].join(' | ')); assert.equal(out.clicksOnPay, 0, [...out.firstLines].join(' | '));
  });
test('benign change (form id and name) is not a veto', { skip, timeout: 170000 }, async t => {
  const out = await run(t, form(), `a.addEventListener('keydown',()=>{f.id='f2';f.name='checkout';})`);
  // The page's audit cancels the submit itself, so no request leaves; what matters is that the seal does not veto the key.
  assert.equal(out.charged, 0);
  assert.equal(out.vetoed, 0, [...out.firstLines].join(' | '));
});
