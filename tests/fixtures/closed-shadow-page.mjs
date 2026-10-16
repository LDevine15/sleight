// A page of controls inside CLOSED shadow roots, written for sleight's own tests. Every control reports what it did
// to the fixture server (POST /log), so a test checks the page's behavior from outside the worker's browser.
export const CLOSED_SHADOW_HTML = `<!doctype html><title>Closed shadow controls</title>
<style>body{font:16px sans-serif}main>*{display:block;margin:14px 0}button,select,input{font:inherit}</style>
<main>
<h1>Account controls</h1>
<x-switch id="sw" label="Two-factor authentication"></x-switch>
<x-check id="ck" label="Marketing emails"></x-check>
<x-text id="tx" label="Display name"></x-text>
<x-select id="sl" label="Region"></x-select>
<x-button id="bt" label="Save preferences"></x-button>
<x-button id="off" label="Archive account" disabled></x-button>
<x-outer id="outer"></x-outer>
<x-link id="help"></x-link>
<a id="light-help" href="/popped?from=light" target="_blank">Open help light</a>
<label>Light note <input id="light-note"></label>
<output id="status">idle</output>
</main>
<script>
const log = text => fetch('/log', { method: 'POST', body: text, keepalive: true });
document.getElementById('light-note').addEventListener('keydown', event => log('light key ' + event.key));
const css = '<style>*{font:inherit}div[role=switch]{width:60px;height:30px;background:#bbb;border-radius:15px}div[aria-checked=true]{background:#2a7}</style>';
customElements.define('x-switch', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = css + '<div role="switch" tabindex="0" aria-checked="false" aria-label="' + this.getAttribute('label') + '"></div>';
    const knob = root.querySelector('div');
    const flip = () => { knob.setAttribute('aria-checked', String(knob.getAttribute('aria-checked') !== 'true')); log('switch ' + (this.id || this.getAttribute('label')) + ' ' + knob.getAttribute('aria-checked')); };
    knob.addEventListener('click', flip);
    knob.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); flip(); } });
  }
});
customElements.define('x-check', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<label><input type="checkbox"> ' + this.getAttribute('label') + '</label>';
    const box = root.querySelector('input');
    box.addEventListener('change', () => log('check ' + this.id + ' ' + box.checked));
  }
});
customElements.define('x-text', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<label>' + this.getAttribute('label') + ' <input type="text"></label>';
    const input = root.querySelector('input');
    input.addEventListener('input', () => log('text ' + this.id + ' ' + input.value));
    input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') log('key ' + this.id + ' ArrowDown'); });
  }
});
customElements.define('x-select', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<label>' + this.getAttribute('label') + ' <select><option value="eu">Europe</option><option value="us">Americas</option><option value="ap">Asia</option></select></label>';
    const select = root.querySelector('select');
    select.addEventListener('change', () => log('select ' + this.id + ' ' + select.value));
  }
});
customElements.define('x-button', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<button type="button">' + this.getAttribute('label') + '</button>';
    const button = root.querySelector('button');
    button.disabled = this.hasAttribute('disabled');
    button.addEventListener('click', () => log('button ' + this.id));
  }
});
customElements.define('x-link', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<a href="/popped?from=closed" target="_blank">Open help closed</a>';
  }
});
// A closed root inside a closed root: the host of the inner switch is itself a control container.
customElements.define('x-outer', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<fieldset><legend>Nested group</legend><x-switch id="inner" label="Nested switch"></x-switch><x-button id="nested-save" label="Nested save"></x-button></fieldset>';
  }
});
</script>`;

// Card forms with closed roots. A: the whole card form lives in the closed root. B: the form is in the page and only its
// continue button is in a closed root, which asks the form to submit as a component would.
export const CLOSED_PAYMENT_HTML = `<!doctype html><title>Closed shadow checkout</title>
<style>body{font:16px sans-serif}main>*{display:block;margin:14px 0}</style>
<main>
<h1>Checkout</h1>
<x-card id="card-a"></x-card>
<form id="form-b" onsubmit="event.preventDefault(); fetch('/log', { method: 'POST', body: 'pay form-b' });">
  <p data-payment-item="Fixture mug">Item: Fixture mug</p><p data-payment-amount="18.00">Amount: 18.00</p>
  <p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>
  <label>Card number <input autocomplete="cc-number" name="number"></label>
  <x-continue id="continue-b"></x-continue>
</form>
</main>
<script>
const log = text => fetch('/log', { method: 'POST', body: text, keepalive: true });
customElements.define('x-card', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<form><p data-payment-item="Fixture mug">Item: Fixture mug</p><p data-payment-amount="18.00">Amount: 18.00</p>' +
      '<p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>' +
      '<label>Card number <input autocomplete="cc-number" name="number"></label><button type="submit">Pay $18.00</button></form>';
    root.querySelector('form').addEventListener('submit', event => { event.preventDefault(); log('pay card-a'); });
  }
});
customElements.define('x-continue', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<button>Continue</button>';
    root.querySelector('button').addEventListener('click', () => this.closest('form').requestSubmit());
  }
});
</script>`;

// Controls the page swaps while they are being used. "mouse" swaps the control when the mouse button goes down,
// "hover" swaps it as soon as the pointer arrives. Each swapped-in control reports any pointer-up or click it receives.
export const SWAP_HTML = `<!doctype html><title>Swapped controls</title>
<style>body{font:16px sans-serif}main>*{display:block;margin:14px 0}button{font:inherit;width:220px;height:40px}</style>
<main>
<h1>Swaps</h1>
<x-swap id="closed-mouse" mode="mouse"></x-swap>
<x-swap id="closed-hover" mode="hover"></x-swap>
<div id="light-mouse"></div>
<div id="light-hover"></div>
</main>
<script>
const log = text => fetch('/log', { method: 'POST', body: text, keepalive: true });
function build(root, name, mode) {
  const original = document.createElement('button'); original.type = 'button'; original.textContent = 'Toggle details ' + name;
  original.addEventListener('click', () => log('original ' + name));
  root.append(original);
  const swapIn = () => {
    const trap = document.createElement('button'); trap.type = 'button'; trap.textContent = 'Delete everything ' + name;
    for (const type of ['pointerup', 'mouseup', 'click']) trap.addEventListener(type, () => log('swapped ' + type + ' ' + name));
    if (original.isConnected) original.replaceWith(trap);
  };
  original.addEventListener(mode === 'mouse' ? 'mousedown' : 'mouseover', swapIn);
}
customElements.define('x-swap', class extends HTMLElement {
  connectedCallback() { build(this.attachShadow({ mode: 'closed' }), this.id, this.getAttribute('mode')); }
});
build(document.getElementById('light-mouse'), 'light-mouse', 'mouse');
build(document.getElementById('light-hover'), 'light-hover', 'hover');
</script>`;
