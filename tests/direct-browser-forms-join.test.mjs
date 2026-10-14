import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { validateHostRequest } from '../plugins/sleight/lib/direct-browser/request-schema.mjs';
import { RefMap } from '../plugins/sleight/lib/direct-browser/refs.mjs';
import { createUserFileProvider } from '../plugins/sleight/lib/direct-browser/files.mjs';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const api = await import('../plugins/sleight/lib/direct-browser/forms.mjs').catch(() => ({}));
const identity = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn',
  leaseGeneration: 1, target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
const lease = { ...identity, epoch: 1, cdpSessionId: 'page' };
const base = { kind: 'text', value: '', connected: true, visible: true, enabled: true,
  editable: true, hit: true, readonly: false, rect: { x: 1, y: 2, width: 30, height: 20 } };
export function formFixture(t, fields, options = {}) {
  assert.equal(typeof api.createFormSession, 'function', 'production form strategy must exist');
  const calls = [], errors = [], refs = new RefMap(identity), states = new Map(), bindings = new Map(), events = new Set();
  const handles = fields.map((field, i) => {
    const state = { ...base, ...field, role: field.kind === 'button' ? 'button' : 'textbox', name: 'Field ' + i };
    const ref = refs.observe(identity, i + 2, JSON.stringify([state.role, state.name, null])); states.set(i + 2, state); return ref;
  });
  if (options.closedSwitch) states.set(100, { ...base, kind: 'switch', value: false, source: 'ax', name: 'Closed switch', role: 'switch' });
  let form, sequence = 0, live = true, operation;
  const raw = new Proxy({ sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); events.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); events.delete(fn); },
    async send(method, params, route) {
      assert.equal(route, 'page'); calls.push({ method, params: structuredClone(params), operation });
      if (options.beforeSend) await options.beforeSend(method, params, { states, revoke: () => { live = false; } });
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
      if (['Page.enable', 'DOM.scrollIntoViewIfNeeded', 'Runtime.releaseObject', 'Page.handleJavaScriptDialog'].includes(method)) return {};
      if (method === 'DOM.resolveNode') {
        const id = 'node-' + (++sequence); bindings.set(id, params.backendNodeId); return { object: { objectId: id } };
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: params.backendNodeId, nodeType: 1, childNodeCount: 0,
        ...(options.closedSwitch && params.backendNodeId === 2 ? { shadowRoots: [{ backendNodeId: 101, nodeType: 11, shadowRootType: 'closed',
          children: [{ backendNodeId: 100, nodeType: 1, attributes: ['role', 'switch'] }] }] } : {}) } };
      if (method === 'Accessibility.getPartialAXTree') { const state = states.get(params.backendNodeId);
        return { nodes: [{ nodeId: String(params.backendNodeId), backendDOMNodeId: params.backendNodeId, frameId: 'frame', role: { value: state.role }, name: { value: state.name } }] }; }
      if (method === 'Runtime.callFunctionOn') {
        const source = params.functionDeclaration;
        if (source.startsWith('function(){const module')) return { result: { objectId: 'constructor' } };
        if (source.startsWith('function(){return new this')) return { result: { objectId: 'instance' } };
        const node = bindings.get(params.arguments?.[0]?.objectId ?? params.objectId);
        assert.ok(states.has(node), 'function must bind an owned node');
        const state = states.get(node), value = params.arguments?.at(-1)?.value;
        if (source === api.fixedFormInspectors['form-state'].source) {
          return { result: { value: { ...state, value: state.protected ? undefined : state.value,
            ...(state.protected ? { matched: state.value === value } : {}) } } };
        }
        if (source.includes('this.checkElementStates')) return { result: { value: null } };
        if (source.includes('this.expectHitTarget')) return { result: { value: state.hit ? 'done' : { hitTargetDescription: 'cover' } } };
        if (source.includes('this.fill(node,value)')) { state.value = value; options.changed?.(states, node); return { result: { value: 'needsinput' } }; }
        if (source.includes('this.selectOptions(node,options)')) {
          state.value = value.map(v => v.value); if (!state.multiple) state.value = state.value[0];
          options.changed?.(states, node); return { result: { value: state.multiple ? state.value : [state.value] } };
        }
        if (source.includes('this.elementState')) return { result: { value: { matches: state.value === (value === 'checked'), received: state.value } } };
        if (source.startsWith('function(payloads)')) {
          state.files = value.map(p => ({ name: p.name, size: Buffer.from(p.base64, 'base64').length }));
          return { result: { value: { transferred: true, count: value.length } } };
        }
        throw Error('unsupported fixed function');
      }
      if (method === 'Input.insertText') {
        const state = states.get(form.activeNode); state.value = params.text; return {};
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (params.type === 'mouseWheel') states.get(form.activeNode).scrollTop = (states.get(form.activeNode).scrollTop ?? 0) + params.deltaY;
        if (params.type === 'mouseMoved') states.get(form.activeNode).hovered = true;
        if (params.type === 'mouseReleased') {
          const state = states.get(form.activeNode);
          if (['checkbox', 'radio', 'switch'].includes(state.kind)) state.value = !state.value;
          if (state.submit) options.submit?.(states, (method, params) => { for (const fn of events) fn({ sessionId: 'page', method, params }); });
        }
        return {};
      }
      if (method === 'Input.dispatchKeyEvent') {
        const state = states.get(form.activeNode);
        if (state.kind === 'range' && params.type === 'rawKeyDown') {
          if (params.key === 'Home') state.value = String(state.min ?? 0);
          if (params.key === 'ArrowRight') state.value = String(Number(state.value) + Number(state.step ?? 1));
        }
        return {};
      }
      throw Error('unsupported physical method ' + method);
    } }, { get(o, k) { if (k in o || typeof k === 'symbol' || k === 'then') return o[k]; throw Error('unsupported fake member ' + k); } });
  let brokerContext;
  const bridge = { sessionId: raw.sessionId, on: raw.on.bind(raw), off: raw.off.bind(raw),
    send: (...args) => { try { return (brokerContext?.session ?? raw).send(...args); } catch (error) { errors.push(error.message); throw error; } } };
  const adapter = createScopedAdapter({ session: bridge, checkLease: () => live, helpers: api.formInspectors(),
    nodeBinding: id => states.has(id) || id === 101 ? { ...lease, backendNodeId: id } : null,
    fileAuthority: options.files?.authority,
    fileBinding: () => ({ ...identity, operation: operation.id, ref: operation.scope.ref }),
    dialogBinding: () => form.dialogBinding() });
  const view = adapter.forLease(lease);
  form = api.createFormSession({ session: view, identity, current: () => live ? identity : { ...identity, document: 2 },
    resolveRef: ref => refs.resolve(ref, identity), onOperation: op => { operation = op; }, files: options.files, ...options.form });
  t.after(() => { form.dispose(); adapter.disconnect(); });
  return { form, calls, handles, states, raw, errors, setContext(value) { brokerContext = value; },
    revoke() { live = false; }, scope: () => operation.scope, operation: () => operation };
}
test('demo travel ordinary and dependent fields fill despite incomplete unrelated sensing', async t => {
  const f = formFixture(t, [{}, { kind: 'select', options: [{ value: 'Japan', label: 'Japan' }], value: '' },
    { kind: 'select', options: [], value: '', enabled: false }], { changed(states, node) {
    if (node === 3) Object.assign(states.get(4), { enabled: true, options: [{ value: 'Osaka', label: 'Osaka' }] });
  } });
  const r = await f.form.fill(f.handles.map((ref, i) => ({ ref, value: ['Example', 'Japan', 'Osaka'][i] })), { operation: 'travel' });
  assert.equal(r.completed, 3); assert.equal(r.effect, 'verified');
  assert.equal(f.calls.filter(c => c.method === 'Input.insertText').length, 1);
});
test('demo settings grouped multi-select and known switch set once', async t => {
  const f = formFixture(t, [{ kind: 'select', multiple: true, options: [{ value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' }], value: [] },
    { kind: 'switch', value: false, source: 'ax' }]);
  const r = await f.form.fill([{ ref: f.handles[0], value: ['Korean', 'Japanese'] }, { ref: f.handles[1], value: true }], { operation: 'settings' });
  assert.equal(r.completed, 2); assert.deepEqual(f.states.get(2).value, ['ko', 'ja']);
  assert.equal(f.calls.filter(c => c.params.type === 'mouseReleased').length, 1);
});
test('checkout protected equality never serializes plaintext and fill never implicitly submits', async t => {
  const f = formFixture(t, [{ protected: true, value: 'before' }, { kind: 'button', submit: true, payment: true }]);
  const r = await f.form.fill([{ ref: f.handles[0], value: 'synthetic-private' }], { operation: 'checkout' });
  assert.equal(r.completed, 1); assert.equal(r.results[0].effect, 'protected');
  assert.doesNotMatch(JSON.stringify(r), /synthetic-private|before|digest|length/);
  assert.equal(f.calls.some(c => c.params.type === 'mouseReleased'), false);
});
for (const [name, state] of [['hidden', { visible: false }], ['disabled', { enabled: false }], ['covered', { hit: false }],
  ['readonly', { readonly: true, editable: false }]]) test(name + ' target preserves untouched suffix with no input', async t => {
  const f = formFixture(t, [state, {}]);
  const r = await f.form.fill(f.handles.map(ref => ({ ref, value: 'private' })), { operation: name });
  assert.equal(r.completed, 0); assert.equal(r.effect, 'none'); assert.equal(r.untouched, 2);
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});
test('replacing the target during final preparation refuses before input', async t => {
  let replaced = false;
  const f = formFixture(t, [{}], { beforeSend(method, params, { revoke }) {
    if (!replaced && method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('this.expectHitTarget')) { replaced = true; revoke(); }
  } });
  const r = await f.form.fill([{ ref: f.handles[0], value: 'private' }], { operation: 'stale' });
  assert.equal(r.effect, 'none'); assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});
test('broker-to-form contract supplies current checks and trusted submit/payment classification', async t => {
  let submitted = 0;
  const f = formFixture(t, [{}, {}, { kind: 'button', submit: true, payment: false }], { submit: () => submitted++ });
  const user = {}, authority = createAuthority({ current: f.scope, authenticate: e => e === user,
    classify: op => f.form.classify(op), checkTarget: op => f.form.checkTarget(op), snapshot: () => ({ scope: f.scope(), time: Date.now() }) });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: (plan, scope, command) => f.form.resolveOperation(command) });
  const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => f.raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest,
    prepare: () => ({ target: 'target' }), authorize: () => true, dispatchFence: () => true,
    transportAuthority, endSession: () => true, disconnect: () => true, redact: value => value,
    async dispatch(plan, context) { f.setContext(context);
      try { return plan.operationName === 'browser_fill' ? await f.form.fill(plan.args.fields, { operation: context.operation })
        : await f.form.act(plan.args, { operation: context.operation }); }
      finally { f.setContext(null); }
    } });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  const filled = await client.request({ id: 'fields', operation: 'browser_fill', args: { tab: 'tfixture', fields: f.handles.slice(0, 2).map(ref => ({ ref, value: 'Example' })) } });
  assert.equal(filled.effect, 'verified', JSON.stringify({ filled, errors: f.errors })); assert.equal(filled.completed, 2);
  const clicked = await client.request({ id: 'submit', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: f.handles[2] } });
  assert.equal(clicked.effect, 'unknown', 'a successful CDP click alone does not prove form submission'); assert.equal(submitted, 1);
  assert.ok(f.calls.filter(c => c.method.startsWith('Input.')).every(c => c.operation.kind !== 'read'));
});
test('uncertain submits require a successful delivered read, while ordinary fields can continue', async t => {
  const f = formFixture(t, [{}, { kind: 'button', submit: true }]);
  assert.equal((await f.form.act({ op: 'click', ref: f.handles[1] }, { operation: 'first' })).effect, 'unknown');
  assert.equal((await f.form.act({ op: 'click', ref: f.handles[1] }, { operation: 'blocked' })).observation.code, 'RECOVERY_READ_REQUIRED');
  assert.equal((await f.form.fill([{ ref: f.handles[0], value: 'Example' }], { operation: 'ordinary' })).completed, 1);
  assert.equal(f.form.deliveredRead('not-owned', identity), false);
  f.form.pendingRead('fresh', identity);
  assert.equal(f.form.deliveredRead('fresh', { ...identity, frame: 'foreign' }), false);
  assert.equal(f.form.deliveredRead('fresh', identity), true);
  assert.equal((await f.form.act({ op: 'click', ref: f.handles[1] }, { operation: 'after-read' })).effect, 'unknown');
  assert.equal(f.form.deliveredRead('fresh', identity), false);
});
test('ordinary hidden unrelated page content never blocks a checked submit', async t => {
  let count = 0;
  const f = formFixture(t, [{ kind: 'button', submit: true }], { submit: () => count++, form: {
    observeEffect: async () => ({ matched: true, identity, source: 'causal-event', pageComplete: false }) } });
  const r = await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'submit' });
  assert.equal(r.effect, 'verified'); assert.equal(count, 1);
});
test('a recycled backend node cannot act under the old delivered semantic name', async t => {
  const f = formFixture(t, [{}]); f.states.get(2).name = 'Replacement';
  const result = await f.form.fill([{ ref: f.handles[0], value: 'private' }], { operation: 'recycled' });
  assert.equal(result.effect, 'none'); assert.equal(result.observation.code, 'STALE_REF');
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});
test('settings volume uses bounded native keyboard increments and native readback', async t => {
  const f = formFixture(t, [{ kind: 'range', value: '50', min: '0', max: '100', step: '1' }]);
  const r = await f.form.fill([{ ref: f.handles[0], value: 72 }], { operation: 'volume' });
  assert.equal(r.completed, 1); assert.equal(f.states.get(2).value, '72');
});
test('number step constraints refuse invalid data before the first actuator', async t => {
  const f = formFixture(t, [{ kind: 'number', value: '0', min: '0', max: '10', step: '.5' }]);
  const r = await f.form.fill([{ ref: f.handles[0], value: 1.2 }], { operation: 'step' });
  assert.equal(r.effect, 'none'); assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});
test('settings closed-shadow switch resolves one owned native child without a MAIN getter', async t => {
  const f = formFixture(t, [{ kind: 'custom' }], { closedSwitch: true });
  const r = await f.form.fill([{ ref: f.handles[0], value: true }], { operation: 'closed' });
  assert.equal(r.completed, 1); assert.equal(f.states.get(100).value, true);
  assert.equal(f.calls.some(c => c.params.executionContextId && c.params.executionContextId !== 9), false);
});
test('checkout prearms its page confirm and answers only its owned dialog through the typed host', async t => {
  const f = formFixture(t, [{ kind: 'button', submit: true, payment: true }], {
    submit: (_, emit) => emit('Page.javascriptDialogOpening', { type: 'confirm', url: identity.origin, frameId: identity.frame, message: 'Pay $18.00 now?' }),
  });
  const click = await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'payment' });
  assert.equal(click.effect, 'verified'); assert.equal(click.observation.dialog.type, 'confirm');
  assert.doesNotMatch(JSON.stringify(click), /\$18|Pay/);
  const answer = await f.form.act({ op: 'dialog', dialog: click.observation.dialog.id, action: 'accept' }, { operation: 'answer' });
  assert.equal(answer.effect, 'unknown');
  assert.equal(f.calls.filter(c => c.method === 'Page.handleJavaScriptDialog').length, 1);
  assert.deepEqual(await f.form.act({ op: 'dialog', dialog: click.observation.dialog.id, action: 'accept' }, { operation: 'answer' }), answer);
  assert.equal(f.calls.filter(c => c.method === 'Page.handleJavaScriptDialog').length, 1);
});
test('a dependent select can become enabled after its predecessor under the shared form deadline', async t => {
  let checks = 0;
  const f = formFixture(t, [{}, { kind: 'select', value: '', enabled: false, options: [{ label: 'Ready', value: 'ready' }] }], {
    beforeSend(method, params, { states }) {
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration === api.fixedFormInspectors['form-state'].source && ++checks === 6)
        states.get(3).enabled = true;
    },
  });
  const r = await f.form.fill([{ ref: f.handles[0], value: 'Example' }, { ref: f.handles[1], value: 'Ready' }], { operation: 'dependent', timeoutMs: 1000 });
  assert.equal(r.completed, 2); assert.equal(f.states.get(3).value, 'ready');
});
test('broker-scoped file input transfers only the user-named retained bytes before local cleanup', async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'p2-form-file-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.txt'); writeFileSync(path, 'approved bytes');
  const user = {}; let f;
  const files = createUserFileProvider({ current: () => identity,
    readUserMessage: event => event === user ? { session: 'client', text: `Upload "${path}" to Resume` } : null,
    resolveInput: ref => f?.handles[0] === ref ? { ...identity, ref, name: 'Resume' } : null });
  t.after(() => files.dispose()); f = formFixture(t, [{ kind: 'file', value: '', files: [] }], { files });
  const handle = files.offer(user, [path], f.handles[0]);
  const r = await f.form.fill([{ ref: f.handles[0], value: { files: [handle] } }], { operation: 'file' });
  assert.equal(r.completed, 1, JSON.stringify(r)); assert.equal(r.results[0].observation.files.transferred, true);
  assert.deepEqual(f.states.get(2).files, [{ name: 'fixture.txt', size: 14 }]);
  assert.doesNotMatch(JSON.stringify(r), /approved bytes|fixture\.txt/);
});
for (const mode of ['page-only', 'requested', 'always', 'changed-dialog']) test('trusted payment classification: ' + mode, async t => {
  const terms = { item: 'Fixture product', method: 'fixture card', amount: '18.00', payee: 'Fixture shop' };
  const f = formFixture(t, [{ kind: 'button', submit: true, payment: true }], {
    form: { paymentTerms: state => ({ ...terms, ...(state.dialog ? { amount: '19.00' } : {}) }) },
    ...(mode === 'changed-dialog' ? { submit: (_, emit) => emit('Page.javascriptDialogOpening', {
      type: 'confirm', url: identity.origin, frameId: identity.frame, message: 'Pay $19.00 now?' }) } : {}),
  });
  const user = {}, authority = createAuthority({ current: f.scope, authenticate: e => e === user,
    confirmPayments: mode === 'always' ? 'always' : undefined, classify: op => f.form.classify(op), checkTarget: op => f.form.checkTarget(op),
    snapshot: () => ({ scope: f.scope(), time: Date.now() }) });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: (plan, scope, command) => f.form.resolveOperation(command) });
  const uid = process.getuid?.() ?? 1000, secret = 'b'.repeat(64);
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => f.raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest, prepare: () => ({ target: 'target' }),
    authorize: () => true, dispatchFence: () => true, transportAuthority, endSession: () => true, disconnect: () => true, redact: v => v,
    async dispatch(plan, context) { f.setContext(context); try { return await f.form.act(plan.args, { operation: context.operation }); } finally { f.setContext(null); } } });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  if (mode !== 'page-only') authority.user(user, 'request', { session: 'client', consequence: 'payment', terms });
  const clicked = await client.request({ id: 'pay', operation: 'browser_act', args: { tab: 'tfixture', op: 'click', ref: f.handles[0] } });
  assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, ['requested', 'changed-dialog'].includes(mode) ? 2 : 0);
  if (mode === 'changed-dialog') {
    assert.equal(clicked.effect, 'verified');
    await client.request({ id: 'answer', operation: 'browser_act', args: { tab: 'tfixture', op: 'dialog', dialog: clicked.observation.dialog.id, action: 'accept' } });
    assert.equal(f.calls.filter(c => c.method === 'Page.handleJavaScriptDialog').length, 0);
  }
});
test('closed act joins wheel, hover and keyboard without foreground or focus-emulation methods', async t => {
  const f = formFixture(t, [{ scrollTop: 0, hovered: false, focused: true }]);
  const wheel = await f.form.act({ op: 'scroll', ref: f.handles[0], dy: 120 }, { operation: 'wheel' });
  assert.equal(wheel.effect, 'verified');
  const hover = await f.form.act({ op: 'hover', ref: f.handles[0] }, { operation: 'hover' });
  assert.equal(hover.effect, 'verified');
  const key = await f.form.act({ op: 'key', ref: f.handles[0], key: 'Control+A' }, { operation: 'key' });
  assert.equal(key.effect, 'unknown');
  assert.deepEqual(f.calls.filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params.type), ['rawKeyDown', 'keyUp']);
  assert.equal(f.calls.some(c => /bringToFront|activateTarget|FocusEmulation/.test(c.method)), false);
});
test('wait checks only its target and never sends input or a focus command', async t => {
  const f = formFixture(t, [{ visible: false }]);
  const r = await f.form.act({ op: 'wait', ref: f.handles[0], state: 'hidden' }, { operation: 'wait' });
  assert.equal(r.effect, 'verified'); assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});
