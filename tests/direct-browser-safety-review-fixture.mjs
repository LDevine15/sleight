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
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'strict-popup' };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      if (method === 'Page.setInterceptFileChooserDialog') return {};
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
        if (source.includes('this.setupHitTargetInterceptor')) return { result: { objectId: 'interceptor-' + (++sequence) } };
        if (source === 'function(){return this.stop();}') return { result: { value: 'done' } };
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
export { identity, lease, api, createAuthority, createTransportAuthority, createBroker, validateHostRequest };
