// Adversarial PoCs for turbo (private/codex/bp2-join 68bdf11e). Each test asserts the
// SAFE behavior the owner's rules require; a failure is the proof of the finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { formFixture, identity, api, createAuthority, createTransportAuthority, createBroker, validateHostRequest } from './direct-browser-safety-review-fixture.mjs';

// ---- Minimal DOM so the real forms.mjs formState() source runs unchanged ----
function classify(build) {
  const ctx = {};
  runInNewContext(`
    class Element {
      constructor(tag, attrs = {}, text = '', parent = null) { this.localName = tag; this.attrs = attrs; this.text = text; this.parent = parent; this.children = []; parent?.children.push(this); this.isConnected = true; }
      getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; }
      getBoundingClientRect() { return { x: 0, y: 0, width: 10, height: 10 }; }
      matches() { return false; }
      closest(sel) { const names = sel.split(','); for (let n = this; n; n = n.parent)
        if (names.some(s => s === n.localName || s === '[role="dialog"]' && n.attrs.role === 'dialog')) return n; return null; }
      get textContent() { return this.text; }
      getRootNode() { return document; }
      get parentNode() { return this.parent; }
      querySelectorAll() { return this.children.flatMap(n => [n, ...n.querySelectorAll()]); }
    }
    class ValidityState { get valid() { return true; } }
    class HTMLInputElement extends Element {
      get type() { return this.attrs.type ?? 'text'; } get readOnly() { return false; } get labels() { return []; }
      get value() { return this.attrs.value ?? ''; } get files() { return []; } get validity() { return new ValidityState(); }
    }
    class HTMLTextAreaElement extends Element {}
    class HTMLSelectElement extends Element {}
    class HTMLOptionElement extends Element {}
    class HTMLButtonElement extends Element {
      get type() { return this.attrs.type ?? 'submit'; } get form() { return this.closest('form'); }
    }
    var window = { location: { origin: 'https://fixture.invalid', href: 'https://fixture.invalid/' } }; window.top = window;
    var getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    var document = { activeElement: null, elementFromPoint: () => globalThis.target };
    globalThis.mk = { Element, HTMLInputElement, HTMLButtonElement };
  `, ctx);
  ctx.target = build(ctx.mk);
  return runInNewContext(`(${api.fixedFormInspectors['form-state'].source}).call(target, '')`, ctx);
}

test('F1a: a Pay button whose aria-label says "Continue" is classified as payment', () => {
  const s = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', { 'aria-label': 'Continue' }, 'Pay $500 now', new Element('form')));
  assert.equal(s.payment, true, 'visible text "Pay $500 now" is overridden by aria-label=Continue: ' + JSON.stringify({ payment: s.payment, submit: s.submit }));
});
test('F1b: <input type=submit value="Place order"> is classified as payment', () => {
  const s = classify(({ Element, HTMLInputElement }) => new HTMLInputElement('input', { type: 'submit', value: 'Place order' }, '', new Element('form')));
  assert.equal(s.payment, true, 'input value is never inspected: ' + JSON.stringify({ payment: s.payment, submit: s.submit }));
});
test('F3a: an SPA <div role=button>Send</div> outside a form is classified as submit', () => {
  const s = classify(({ Element }) => new Element('div', { role: 'button' }, 'Send', new Element('main')));
  assert.equal(s.submit, true, JSON.stringify({ kind: s.kind, submit: s.submit }));
});

// ---- Broker + authority + form session, exactly as tests/direct-browser-forms-join wires them ----
async function wired(t, fields, options = {}, confirmPayments) {
  const f = formFixture(t, fields, options);
  const user = {}, authority = createAuthority({ current: f.scope, authenticate: e => e === user, confirmPayments,
    classify: op => f.form.classify(op), checkTarget: op => f.form.checkTarget(op), snapshot: () => ({ scope: f.scope(), time: Date.now() }) });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: (plan, scope, command) => f.form.resolveOperation(command) });
  const uid = process.getuid?.() ?? 1000, secret = 'c'.repeat(64);
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => f.raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest, prepare: () => ({ target: 'target' }),
    authorize: () => true, dispatchFence: () => true, transportAuthority, endSession: () => true, disconnect: () => true, redact: v => v,
    async dispatch(plan, context) { f.setContext(context); try { return plan.operationName === 'browser_fill' ?
      await f.form.fill(plan.args.fields, { operation: context.operation }) : await f.form.act(plan.args, { operation: context.operation }); } finally { f.setContext(null); } } });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  return { f, authority, user, client, inputs: () => f.calls.filter(c => c.method.startsWith('Input.')).length };
}

test('F1c: with no user payment request, a mislabeled Pay button (formState: submit, not payment) sends no input', async t => {
  // State is exactly what F1a/F1b show formState returns for a "Continue"-labelled Pay button.
  // Recompute the real inspector after the fix rather than preserving the
  // vulnerable inspector's fabricated payment:false result in the CDP fake.
  const state = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', { 'aria-label': 'Continue' }, 'Pay $500 now', new Element('form')));
  const w = await wired(t, [state]);
  const r = await w.client.request({ id: 'pay', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: w.f.handles[0] } });
  assert.equal(w.inputs(), 0, 'payment click dispatched as ordinary: ' + JSON.stringify({ effect: r.effect, inputs: w.inputs() }));
});
test('F1d: Enter in the last field of a payment form is not dispatched without payment authority', async t => {
  const state = classify(({ Element, HTMLInputElement, HTMLButtonElement }) => {
    const form = new Element('form'); new HTMLButtonElement('button', {}, 'Pay $500', form);
    return new HTMLInputElement('input', { value: '94110' }, '', form);
  });
  const w = await wired(t, [{ ...state, focused: true }]);
  const r = await w.client.request({ id: 'enter', operation: 'browser_act', args: { tab: 'tfixture', op: 'key', ref: w.f.handles[0], key: 'Enter' } });
  assert.equal(w.inputs(), 0, 'implicit form submission sent with consequence ordinary: ' + JSON.stringify({ effect: r.effect, inputs: w.inputs() }));
});

const terms = { item: 'Fixture product', method: 'fixture card', amount: '18.00', payee: 'Fixture shop' };
for (const mode of ['requested', 'always']) test(`F2 (${mode}): one payment authority pays once, not twice`, async t => {
  const w = await wired(t, [{ kind: 'button', submit: true, payment: true }],
    { form: { paymentTerms: () => ({ page: { item: terms.item, amount: terms.amount, payee: terms.payee }, method: terms.method }),
      observeEffect: async () => ({ matched: true, identity, source: 'causal-event' }) } }, mode === 'always' ? 'always' : undefined);
  if (mode === 'requested') w.authority.user(w.user, 'request', { session: 'client', consequence: 'payment', terms });
  else w.authority.user(w.user, 'confirm', { operation: { id: 'native-card', kind: 'click', args: {}, scope: {
    browser: identity.browserIncarnation, broker: identity.brokerEpoch, session: identity.clientSession, turn: identity.turn, target: identity.target,
    lease: identity.leaseGeneration, frame: identity.frame, document: identity.document, ref: w.f.handles[0], origin: identity.origin },
    consequence: 'payment', submit: true, terms } });
  await w.client.request({ id: 'pay1', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: w.f.handles[0] } });
  assert.equal(w.inputs(), 2, 'first authorized payment click sent');
  // The first payment's effect was verified (no Rule 3 fence). The page still offers Pay
  // (e.g. "Buy again", or a model loop); the user named one payment.
  await w.client.request({ id: 'pay2', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: w.f.handles[0] } });
  assert.equal(w.inputs(), 2, 'second payment charged under the same once-authority: inputs=' + w.inputs());
});

test('F3b: an uncertain SPA "Send" click (formState: not submit) cannot be clicked again before a read', async t => {
  const w = await wired(t, [{ kind: 'custom', role: 'button', submit: false, payment: false }]);
  const first = await w.client.request({ id: 'send1', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: w.f.handles[0] } });
  assert.equal(first.effect, 'unknown');
  await w.client.request({ id: 'send2', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: w.f.handles[0] } });
  assert.equal(w.inputs(), 2, 'blind resend after unknown effect: inputs=' + w.inputs());
});

test('F4: Shift+Enter (opens a link in a new foreground window) is refused', async t => {
  const w = await wired(t, [{ kind: 'custom', role: 'link', focused: true }]);
  await w.client.request({ id: 'shift', operation: 'browser_act', args: { tab: 'tfixture', op: 'key', ref: w.f.handles[0], key: 'Shift+Enter' } });
  const sent = w.f.calls.filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params.modifiers);
  assert.deepEqual(sent, [], 'Shift+Enter dispatched with modifiers ' + JSON.stringify(sent));
});

test('F5: a target covered after expectHitTarget (e.g. a Pay overlay slid over "Add to cart") is not clicked', async t => {
  let ax = 0;
  const w = await wired(t, [{ kind: 'button', submit: false, payment: false }], {
    beforeSend(method, params, { states }) {
      // validateSemantic runs again after expectHitTarget; the page covers the target now.
      if (method === 'Accessibility.getPartialAXTree' && ++ax === 2) states.get(2).hit = false;
    } });
  await w.client.request({ id: 'cart', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: w.f.handles[0] } });
  const finalInspect = w.f.calls.filter(c => c.method === 'Runtime.callFunctionOn' && c.params.functionDeclaration === api.fixedFormInspectors['form-state'].source).length;
  assert.equal(w.inputs(), 0, `clicked a covered target; the final inspect (#${finalInspect}) reported hit:false and was ignored, inputs=${w.inputs()}`);
});
for (const structure of ['card', 'iframe']) test(`a neutral submit in a ${structure} form is payment`, () => {
  const state = classify(({ Element, HTMLInputElement, HTMLButtonElement }) => {
    const form = new Element('form');
    if (structure === 'card') new HTMLInputElement('input', { autocomplete: 'cc-number' }, '', form);
    else new Element('iframe', { src: 'https://payment.invalid/' }, '', form);
    return new HTMLButtonElement('button', {}, 'Continue', form);
  });
  assert.equal(state.payment, true);
});
test('unknown effects fence only the same backend element and a delivered read releases only covered refs', async t => {
  const f = formFixture(t, [{ kind: 'custom', role: 'button' }, { kind: 'custom', role: 'button' }]);
  assert.equal((await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'first' })).effect, 'unknown');
  assert.equal((await f.form.act({ op: 'click', ref: f.handles[1] }, { operation: 'other' })).effect, 'unknown');
  f.form.pendingRead('other-only', identity, [f.handles[1]]); f.form.deliveredRead('other-only', identity);
  assert.equal((await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'blocked' })).observation.code, 'RECOVERY_READ_REQUIRED');
  f.form.pendingRead('same', identity, [f.handles[0]]); f.form.deliveredRead('same', identity);
  await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'after' });
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 6);
});
for (const kind of ['file', 'color', 'select']) test(`act refuses native ${kind} panels and names browser_fill`, async t => {
  const f = formFixture(t, [{ kind }]);
  const r = await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: kind });
  assert.equal(r.effect, 'none'); assert.equal(r.observation.next, 'browser_fill');
  assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, 0);
});
test('a payment provider echo cannot grant payment; page amount and payee must match independently', async t => {
  for (const provider of [() => terms, () => ({ page: { item: terms.item, amount: '900.00', payee: terms.payee }, method: terms.method }),
    () => ({ page: { item: terms.item, amount: terms.amount, payee: 'Different shop' }, method: terms.method })]) {
    const w = await wired(t, [{ kind: 'button', submit: true, payment: true }], { form: { paymentTerms: provider } });
    w.authority.user(w.user, 'request', { session: 'client', consequence: 'payment', terms });
    await w.client.request({ id: 'pay', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: w.f.handles[0] } });
    assert.equal(w.inputs(), 0);
  }
});
test('mouse dispatch is enclosed by the admitted Playwright hit interceptor', async t => {
  const f = formFixture(t, [{ kind: 'button' }]);
  await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'intercept' });
  const start = f.calls.findIndex(c => c.params?.functionDeclaration?.includes('this.setupHitTargetInterceptor'));
  const press = f.calls.findIndex(c => c.method === 'Input.dispatchMouseEvent');
  const stop = f.calls.findIndex(c => c.params?.functionDeclaration === 'function(){return this.stop();}');
  assert.ok(start >= 0 && start < press && stop > press);
});
test('every action installs the fixed strict popup and file-chooser guard before input', async t => {
  const f = formFixture(t, [{ kind: 'button' }]);
  await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'background' });
  const setup = f.calls.findIndex(c => c.method === 'Page.addScriptToEvaluateOnNewDocument');
  const intercept = f.calls.findIndex(c => c.method === 'Page.setInterceptFileChooserDialog' && c.params.enabled === true);
  const input = f.calls.findIndex(c => c.method.startsWith('Input.'));
  assert.ok(setup >= 0 && intercept >= 0 && setup < input && intercept < input);
  assert.match(f.calls[setup].params.source, /strict/);
});
test('filling a payment-labelled field stays ordinary and never pays or submits', async t => {
  const state = classify(({ Element, HTMLInputElement }) => new HTMLInputElement('input', { 'aria-label': 'Payment amount' }, '', new Element('form')));
  const w = await wired(t, [state]);
  const result = await w.client.request({ id: 'amount', operation: 'browser_fill', args: { tab: 'tfixture', fields: [{ ref: w.f.handles[0], value: '12' }] } });
  assert.equal(result.effect, 'verified', JSON.stringify(result));
  assert.equal(w.inputs(), 1); assert.equal(w.f.calls.some(c => c.method === 'Input.dispatchMouseEvent'), false);
});
