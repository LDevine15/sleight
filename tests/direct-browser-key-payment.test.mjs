import test from 'node:test';
import assert from 'node:assert/strict';
import { formFixture, identity, api, createAuthority, createTransportAuthority, createBroker, validateHostRequest } from './direct-browser-safety-review-fixture.mjs';

const terms = { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop', method: 'Fixture card' };
for (const mode of ['form-risk-added', 'payment-wording-added', 'prior-risk-removed', 'ordinary', 'authorized-payment'])
test(`Enter uses final and prior payment risk: ${mode}`, async t => {
  let inspections = 0;
  const button = mode === 'payment-wording-added';
  const f = formFixture(t, [{ kind: button ? 'button' : 'text', tag: button ? 'button' : 'input',
    form: !button, formPayment: mode === 'prior-risk-removed', focused: true }], {
    beforeSend(method, params, { states }) {
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === api.fixedFormInspectors['form-state'].source && ++inspections === 3) {
        if (button) Object.assign(states.get(2), { payment: true, submit: true });
        else states.get(2).formPayment = ['form-risk-added', 'authorized-payment'].includes(mode);
      }
    },
    form: { paymentTerms: () => ({ page: { item: terms.item, amount: terms.amount, payee: terms.payee }, method: terms.method }),
      ...(mode === 'authorized-payment' ? { observeEffect: () => ({ matched: true, identity, source: 'causal-event' }) } : {}) },
  });
  const user = {};
  const authority = createAuthority({ current: f.scope, authenticate: e => e === user,
    classify: op => f.form.classify(op), checkTarget: op => f.form.checkTarget(op), snapshot: () => ({ scope: f.scope(), time: Date.now() }) });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: (plan, scope, command) => f.form.resolveOperation(command) });
  const uid = process.getuid?.() ?? 1000, secret = 'c'.repeat(64);
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => f.raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest, prepare: () => ({ target: 'target' }),
    authorize: () => true, dispatchFence: () => true, transportAuthority, endSession: () => true, disconnect: () => true, redact: v => v,
    async dispatch(plan, context) { f.setContext(context); try { return await f.form.act(plan.args, { operation: context.operation }); }
      finally { f.setContext(null); } } });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  if (mode === 'authorized-payment') authority.user(user, 'request', { session: 'client', consequence: 'payment', terms });
  const result = await client.request({ id: 'enter', operation: 'browser_act', args: { tab: 'tfixture', op: 'key', ref: f.handles[0], key: 'Enter' } });
  const inputs = f.calls.filter(c => c.method.startsWith('Input.'));
  t.diagnostic(JSON.stringify({ inspections, finalFormPayment: f.states.get(2).formPayment, effect: result.effect, inputs: inputs.length }));
  assert.ok(inspections >= 3, 'the final inspector observed the owning form and target');
  assert.equal(inputs.length, ['ordinary', 'authorized-payment'].includes(mode) ? 2 : 0);
  if (mode === 'authorized-payment') {
    assert.equal(result.effect, 'verified');
    await client.request({ id: 'enter-again', operation: 'browser_act', args: { tab: 'tfixture', op: 'key', ref: f.handles[0], key: 'Enter' } });
    assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, 2, 'one request authorizes one payment');
  }
});
