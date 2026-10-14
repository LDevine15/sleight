import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import * as scoped from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
const { createScopedAdapter, reorderListSource } = scoped;
import { formFixture } from './direct-browser-safety-review-fixture.mjs';
import { fixedFormInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';

const lease = { target: 'target', cdpSessionId: 'page', frame: 'parent', origin: 'https://fixture.invalid', document: 1, epoch: 1 };
test('checkout frame host remains readable without leasing its cross-origin content', async t => {
  const sent = [], adapter = createScopedAdapter({ helpers: {}, checkLease: () => true,
    nodeBinding: id => [1, 2].includes(id) ? { ...lease, backendNodeId: id } : null,
    session: { sessionId: 'root', on() {}, off() {}, async send(method) {
      sent.push(method); assert.equal(method, 'DOM.getDocument');
      return { root: { backendNodeId: 1, nodeType: 9, children: [{ backendNodeId: 2, nodeType: 1,
        localName: 'iframe', frameId: 'child', contentDocument: { backendNodeId: 99, frameId: 'child' } }] } };
    } } });
  t.after(() => adapter.disconnect());
  const result = await adapter.forLease(lease).send('DOM.getDocument', { depth: 1, pierce: false });
  assert.equal(result.root.children[0].backendNodeId, 2);
  assert.equal(result.root.children[0].contentDocument, undefined); assert.deepEqual(sent, ['DOM.getDocument']);
});
test('native select fills exact labels without opening its native panel', async t => {
  const f = formFixture(t, [{ kind: 'select', value: '', optionsComplete: true,
    options: [{ value: 'ja', label: 'Japan', selected: false, disabled: false }] }]);
  const result = await f.form.fill([{ ref: f.handles[0], value: 'Japan' }], { operation: 'country' });
  assert.equal(result.completed, 1); assert.equal(f.states.get(2).value, 'ja');
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});

function listFixture(options = {}) {
  assert.equal(typeof reorderListSource, 'string', 'missing closed node-scoped reorder actuator');
  const events = [], order = ['Billing', 'Security', 'Product updates', 'Mentions', 'Reminders'];
  class Element {
    localName = 'ol'; isConnected = true;
    getAttribute(name) { return name === 'aria-label' ? this.label : name === 'draggable' ? 'true' : null; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 20 }; }
    matches() { return false; }
    contains(node) { return node === this || this.children?.includes(node) === true; }
    get children() { return this.items; }
    get textContent() { return this.label; }
    getRootNode() { return document; }
    dispatchEvent(event) {
      events.push([this.label, event.type]);
      if (event.type === 'dragstart') event.dataTransfer.setData('text/plain', this.label);
      if (event.type === 'drop' && !options.ignoreDrop) {
        const from = order.indexOf(event.dataTransfer.getData('text/plain')), to = order.indexOf(this.label);
        order.splice(to, 0, order.splice(from, 1)[0]); render();
      }
      if (event.type === 'dragstart' && options.replace) render();
      return true;
    }
  }
  const list = new Element();
  const render = () => { list.items = order.map(label => Object.assign(new Element(), { localName: 'li', label, draggable: true })); };
  render();
  const document = { elementFromPoint: () => options.covered ? {} : hit, activeElement: null }; let hit;
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function() { hit = this; return rect.call(this); };
  Object.defineProperty(Element.prototype, 'children', { get() { return this.items; } });
  Object.defineProperty(Element.prototype, 'textContent', { get() { return this.label; } });
  class Transfer { data = new Map(); setData(k, v) { this.data.set(k, v); } getData(k) { return this.data.get(k); } }
  class Drag { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  const fn = runInNewContext('(' + reorderListSource + ')', { Element, Node: Element, HTMLLIElement: Element,
    DataTransfer: Transfer, DragEvent: Drag, document, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
  return { fn, list, order, events };
}
const wanted = ['Security', 'Mentions', 'Billing', 'Reminders', 'Product updates'];
test('priority reorder dispatches owned HTML drag operations and verifies exact DOM order', () => {
  const f = listFixture(), result = f.fn.call(f.list, wanted);
  assert.equal(result.effect, 'verified'); assert.deepEqual(f.order, wanted);
  assert.ok(f.events.some(([, type]) => type === 'drop'));
});
for (const mode of ['covered', 'duplicate', 'missing', 'ignoreDrop', 'replace']) test('priority reorder refuses ' + mode + ' without unproved success', () => {
  const f = listFixture({ [mode]: true });
  const result = f.fn.call(f.list, mode === 'duplicate' ? [...wanted.slice(0, 4), wanted[0]] : mode === 'missing' ? wanted.slice(0, 4) : wanted);
  assert.notEqual(result.effect, 'verified');
  if (['covered', 'duplicate', 'missing'].includes(mode)) assert.equal(f.events.length, 0);
});
test('reorder fill uses a typed select actuator, not arbitrary page evaluation', async t => {
  const f = formFixture(t, [{ kind: 'reorder', value: ['B', 'A'], items: ['B', 'A'] }], {
    beforeSend(method, params, { states }) {
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === reorderListSource) states.get(2).value = params.arguments[0].value;
    },
  });
  const result = await f.form.fill([{ ref: f.handles[0], value: ['A', 'B'] }], { operation: 'order' });
  assert.equal(result.completed, 1, JSON.stringify(result));
  const command = f.calls.find(c => c.params.functionDeclaration === reorderListSource);
  assert.equal(command.operation.kind, 'select'); assert.deepEqual(command.operation.args.values, ['A', 'B']);
});

test('a changed native checkbox click has target proof without a whole-page read', async t => {
  const f = formFixture(t, [{ kind: 'checkbox', value: false }]);
  const result = await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'toggle' });
  assert.equal(result.effect, 'verified'); assert.equal(result.observation.source, 'native');
});
test('background refusal names browser_fill and preserves the no-input effect', async () => {
  const { browserError, BrowserFailure } = await import('../plugins/sleight/lib/direct-browser/errors.mjs');
  const error = browserError(new BrowserFailure('NO_EFFECT', { effect: 'none' }), {
    tab: 'tfixture', observation: { code: 'BACKGROUND_UNAVAILABLE', next: 'browser_fill' } });
  assert.match(error.message, /browser_fill/); assert.equal(error.next.tool, 'browser_fill'); assert.equal(error.effect, 'none');
});

test('reorder reaches the real broker authority as one exact select operation', async t => {
  const { createAuthority, createTransportAuthority } = await import('../plugins/sleight/lib/direct-browser/authority.mjs');
  const { createBroker } = await import('../plugins/sleight/lib/direct-browser/broker.mjs');
  const { validateHostRequest } = await import('../plugins/sleight/lib/direct-browser/request-schema.mjs');
  const f = formFixture(t, [{ kind: 'reorder', value: ['B', 'A'], items: ['B', 'A'] }]);
  const authority = createAuthority({ current: f.scope, authenticate: () => false,
    classify: f.form.classify, checkTarget: f.form.checkTarget, snapshot: () => ({ scope: f.scope(), time: Date.now() }) });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: (plan, context, command) => f.form.resolveOperation(command) });
  const uid = process.getuid?.() ?? 1000, secret = 'c'.repeat(64);
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => f.raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest, prepare: () => ({ target: 'target' }),
    authorize: () => true, dispatchFence: () => true, transportAuthority, endSession: () => true, disconnect: () => true, redact: v => v,
    async dispatch(plan, context) { f.setContext(context); try { return await f.form.fill(plan.args.fields, { operation: context.operation }); } finally { f.setContext(null); } } });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  const result = await client.request({ id: 'order', operation: 'browser_fill', args: { tab: 'tfixture', fields: [{ ref: f.handles[0], value: ['A', 'B'] }] } });
  assert.equal(result.effect, 'verified', JSON.stringify({ result, errors: f.errors })); assert.equal(result.completed, 1);
  const command = f.calls.find(c => c.params.functionDeclaration === reorderListSource);
  assert.equal(authority.receipt(command.operation.id).phase, 'verified');
});
