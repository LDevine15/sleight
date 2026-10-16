// Pages for the AD1 checks on controls inside CLOSED shadow roots (tests/direct-browser-closed-ad1.real.test.mjs). Each page
// reports what happened to the fixture server (POST /log), and any GET of /charge is logged by the server as a hit.
const LOG = `const log = text => fetch('/log', { method: 'POST', body: text, keepalive: true });`;

// Swap: the control, or the form it submits, changes while the click is in flight. mode "none" is the control.
export const SEAL_HTML = `<!doctype html><title>Closed seal</title>
<style>body{font:16px sans-serif}main>*{display:block;margin:14px 0}</style>
<main>
<h1>Seal</h1>
<x-save id="plain" mode="none"></x-save>
<x-save id="action" mode="action"></x-save>
<x-save id="label" mode="label"></x-save>
<form id="light" action="/ok" method="post" onsubmit="event.preventDefault(); log('submit light-action')">
  <input name="q" aria-label="Light query"><button type="submit" id="lb">Save light-action</button>
</form>
</main>
<script>${LOG}
document.getElementById('lb').addEventListener('pointerdown', () => { document.getElementById('light').action = '/charge'; });
customElements.define('x-save', class extends HTMLElement {
  connectedCallback() {
    const mode = this.getAttribute('mode'), name = this.id, root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<form action="/ok" method="post"><input name="q" aria-label="Query ' + name + '"><button type="submit">Save ' + name + '</button></form>';
    const form = root.querySelector('form'), button = root.querySelector('button');
    form.addEventListener('submit', event => { event.preventDefault(); log('submit ' + name + ' action=' + new URL(form.action).pathname); if (new URL(form.action).pathname === '/charge') fetch('/charge'); });
    if (mode === 'action') button.addEventListener('pointerdown', () => { form.action = '/charge'; });
    if (mode === 'label') button.addEventListener('pointerdown', () => { button.textContent = 'Pay now'; });
  }
});
</script>`;

// Popup: a closed-root link that is plain when the hook looks at it and a new-tab link by the time it is followed.
export const FLIP_HTML = `<!doctype html><title>Closed flip</title>
<main><h1>Flip</h1><x-flip id="flip"></x-flip><x-plain id="plain"></x-plain><x-flipform id="flipform"></x-flipform>
<form id="lff" action="/charge" method="post" target="_self"><button type="submit" id="lfb">Send flipped light form</button></form>
<a id="lf" href="/popped?from=lightflip" target="_self">Open flipped light</a></main>
<script>
document.getElementById('lfb').addEventListener('click', () => { document.getElementById('lff').target = '_blank'; });
document.getElementById('lf').addEventListener('click', () => { document.getElementById('lf').target = '_blank'; });
customElements.define('x-flip', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<a href="/popped?from=flip" target="_self">Open flipped closed</a>';
    root.querySelector('a').addEventListener('click', () => { root.querySelector('a').target = '_blank'; });
  }
});
customElements.define('x-flipform', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<form action="/charge" method="post" target="_self"><button type="submit">Send flipped closed form</button></form>';
    root.querySelector('button').addEventListener('click', () => { root.querySelector('form').target = '_blank'; });
  }
});
customElements.define('x-plain', class extends HTMLElement {
  connectedCallback() { this.attachShadow({ mode: 'closed' }).innerHTML = '<a href="/popped?from=plain" target="_self">Open plain closed</a>'; }
});
</script>`;

// Payment: the closed card form carries a figure above the amount in the user's message, and a script button (a div) in
// a card form whose handler is invisible. "ok" is the control with only the requested figure.
export const EXTRA_HTML = `<!doctype html><title>Closed checkout extras</title>
<style>body{font:16px sans-serif}main>*{display:block;margin:14px 0}</style>
<main>
<h1>Checkout</h1>
<x-card id="ok" extra=""></x-card>
<x-card id="extra" extra="Total with insurance and handling: 25.00"></x-card>
<form id="form-d" onsubmit="event.preventDefault()">
  <p data-payment-item="Fixture mug">Item: Fixture mug</p><p data-payment-amount="18.00">Amount: 18.00</p>
  <p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>
  <label>Card number <input autocomplete="cc-number" name="number"></label>
  <x-div-button id="div"></x-div-button>
</form>
</main>
<script>${LOG}
customElements.define('x-card', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' }), name = this.id, extra = this.getAttribute('extra');
    root.innerHTML = '<form><p data-payment-item="Fixture mug">Item: Fixture mug</p><p data-payment-amount="18.00">Amount: 18.00</p>' +
      '<p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>' + (extra ? '<p>' + extra + '</p>' : '') +
      '<label>Card number <input autocomplete="cc-number" name="number"></label><button type="submit">Pay $18.00 ' + name + '</button></form>';
    root.querySelector('form').addEventListener('submit', event => { event.preventDefault(); log('pay card-' + name); });
  }
});
customElements.define('x-div-button', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<div role="button" tabindex="0">Continue to review</div>';
    const div = root.querySelector('div');
    div.addEventListener('click', () => log('pay div'));
    div.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); log('pay div-key'); } });
  }
});
</script>`;

// Keyboard: Enter in a closed-root field submits its form. "swap" changes the form's action when the key goes down.
export const KEYS_HTML = `<!doctype html><title>Closed keys</title>
<style>body{font:16px sans-serif}main>*{display:block;margin:14px 0}</style>
<main><h1>Keys</h1><x-field id="plain" mode="none"></x-field><x-field id="swap" mode="swap"></x-field><x-field id="focus" mode="focus"></x-field><x-field id="sibling" mode="sibling"></x-field>
<input id="elsewhere" aria-label="Elsewhere"></main>
<script>${LOG}
for (const type of ['keydown', 'keypress', 'keyup']) document.getElementById('elsewhere').addEventListener(type, event => log('elsewhere ' + type + ' ' + event.key));
customElements.define('x-field', class extends HTMLElement {
  connectedCallback() {
    const mode = this.getAttribute('mode'), name = this.id, root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<form action="/ok" method="post"><input name="q" aria-label="Field ' + name + '"><input class="sib" aria-label="Sibling ' + name + '"><button type="submit">Send ' + name + '</button></form>';
    const form = root.querySelector('form'), input = root.querySelector('input'), sibling = root.querySelector('.sib');
    for (const type of ['keypress', 'keyup']) sibling.addEventListener(type, event => log('sibling ' + type + ' ' + event.key));
    if (mode === 'sibling') input.addEventListener('keydown', () => { sibling.focus(); });
    form.addEventListener('submit', event => { event.preventDefault(); log('submit ' + name + ' action=' + new URL(form.action).pathname); if (new URL(form.action).pathname === '/charge') fetch('/charge'); });
    if (mode === 'swap') input.addEventListener('keydown', () => { form.action = '/charge'; });
    if (mode === 'focus') input.addEventListener('keydown', () => { document.getElementById('elsewhere').focus(); });
  }
});
</script>`;

// Cover: another control in the SAME root slides over the checked one when the button goes down. The checked control stays
// connected and unchanged, so the seal has nothing to compare; only where the release and click land tells. The light-DOM
// twin has the same two buttons in the page.
export const COVER_HTML = `<!doctype html><title>Closed cover</title>
<style>body{font:16px sans-serif}main>*{display:block;margin:14px 0}button{font:inherit;width:220px;height:40px}.trap{position:fixed;display:none;z-index:9}</style>
<main><h1>Cover</h1><x-cover id="closed"></x-cover><x-nest id="nest"></x-nest><div id="light"></div></main>
<script>${LOG}
function build(root, name) {
  root.innerHTML = '<style>button{font:inherit;width:220px;height:40px}.trap{position:fixed;display:none;z-index:9}</style><div class="row"><button type="button" class="ok">Toggle details ' + name + '</button><button type="button" class="trap">Delete everything ' + name + '</button></div>';
  const ok = root.querySelector('.ok'), trap = root.querySelector('.trap');
  ok.addEventListener('click', () => log('ok click ' + name));
  ok.addEventListener('pointerdown', () => {
    const box = ok.getBoundingClientRect();
    Object.assign(trap.style, { display: 'block', left: box.left + 'px', top: box.top + 'px' });
  });
  for (const type of ['pointerup', 'mouseup', 'click']) trap.addEventListener(type, () => log('trap ' + type + ' ' + name));
  root.querySelector('.row').addEventListener('click', event => log('row click ' + name + ' target=' + (event.target.className || event.target.tagName)));
}
customElements.define('x-cover', class extends HTMLElement { connectedCallback() { build(this.attachShadow({ mode: 'closed' }), this.id); } });
customElements.define('x-nest', class extends HTMLElement {
  connectedCallback() { const root = this.attachShadow({ mode: 'closed' }); root.innerHTML = '<section><x-cover id="nested"></x-cover></section>'; }
});
build(document.getElementById('light'), 'light');
</script>`;
