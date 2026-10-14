import assert from 'node:assert/strict';
import { createSemanticAdapter, formInspectors, fixedFormInspectors } from '../../plugins/sleight/lib/direct-browser/forms.mjs';
import { inspectControl, fixedReadInspectors } from '../../plugins/sleight/lib/direct-browser/reads.mjs';
import { createTransportOwner } from '../../plugins/sleight/lib/direct-browser/transport-owner.mjs';
import { createAuthority, createTransportAuthority, revokeAuthoritySession } from '../../plugins/sleight/lib/direct-browser/authority.mjs';
import { createBroker } from '../../plugins/sleight/lib/direct-browser/broker.mjs';
import { validateHostRequest } from '../../plugins/sleight/lib/direct-browser/request-schema.mjs';
import { createRootTargets } from '../../plugins/sleight/lib/direct-browser/root-targets.mjs';
import { popupIntent } from '../../plugins/sleight/lib/direct-browser/popups.mjs';
const identity = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn', leaseGeneration: 1,
  target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
const lease = { ...identity, epoch: 1, cdpSessionId: 'page' };
export async function fixture(t, options = {}) {
  const calls = [], listeners = new Set(), objects = new Map(); let serial = 0, value = '', live = true, root, activeLease = lease; const targets = new Map();
  const ax = [{ nodeId: '1', backendDOMNodeId: 1, role: { value: 'RootWebArea' }, childIds: ['2', '3'] },
    { nodeId: '2', backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Name' }, childIds: [] },
    { nodeId: '3', backendDOMNodeId: 3, role: { value: 'button' }, name: { value: 'Save' }, childIds: [] }];
  if (options.secondField) { ax[2].role.value = 'textbox'; ax[2].name.value = 'Other'; }
  if (options.manyRows) {
    ax.splice(1);
    for (let i = 2; i <= options.manyRows + 1; i++) ax.push({ nodeId: String(i), backendDOMNodeId: i, role: { value: 'textbox' }, name: { value: 'Field ' + i }, childIds: [] });
    ax[0].childIds = ax.slice(1).map(n => n.nodeId);
  }
  const raw = new Proxy({ sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); },
    async send(method, params, route) {
      calls.push({ method, params, route });
      if (method.startsWith('Target.')) {
        assert.equal(route, undefined);
        switch (method) {
          case 'Target.createTarget': assert.equal(params.background, true); targets.set('owned', { targetId: 'owned', type: 'page', url: params.url }); return { targetId: 'owned' };
          case 'Target.attachToTarget': assert.equal(params.targetId, 'owned'); assert.equal(params.flatten, true); return { sessionId: 'page' };
          case 'Target.getTargetInfo': return { targetInfo: targets.get(params.targetId) };
          case 'Target.closeTarget': targets.delete(params.targetId); return { success: true };
          case 'Target.getTargets': return { targetInfos: [...targets.values()] };
          default: throw Error('unsupported root command ' + method);
        }
      }
      assert.equal(route, 'page');
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: 'https://fixture.invalid' } } };
      if (options.send) await options.send(method, params);
      switch (method) {
        case 'Page.addScriptToEvaluateOnNewDocument': return { identifier: 'strict-popup' };
        case 'Runtime.evaluate': return { result: { value: true } };
        case 'Page.setInterceptFileChooserDialog': return {};
        case 'Page.enable': case 'Accessibility.enable': case 'DOM.scrollIntoViewIfNeeded': case 'Runtime.releaseObject': return {};
        case 'DOM.getDocument': return { root: { backendNodeId: 1, nodeType: 9, children: ax.slice(1).map(n => ({ backendNodeId: n.backendDOMNodeId, nodeType: 1, childNodeCount: 0 })) } };
        case 'DOM.describeNode': return { node: { backendNodeId: params.backendNodeId, nodeType: 1, childNodeCount: 0 } };
        case 'Accessibility.getPartialAXTree': return { nodes: structuredClone(ax.filter(n => n.backendDOMNodeId === params.backendNodeId)) };
        case 'Page.createIsolatedWorld': return { executionContextId: 9 };
        case 'DOM.resolveNode': { const id = 'object-' + (++serial); objects.set(id, params.backendNodeId); return { object: { objectId: id } }; }
        case 'Runtime.callFunctionOn': {
          const s = params.functionDeclaration;
          if (s.includes('this.setupHitTargetInterceptor')) return { result: { objectId: 'interceptor-' + (++serial) } };
          if (s === 'function(){return this.stop();}') return { result: { value: 'done' } };
          if (s.startsWith('function(){const module')) return { result: { objectId: 'constructor' } };
          if (s.startsWith('function(){return new this')) return { result: { objectId: 'instance' } };
          if (s === String(popupIntent)) return { result: { value: { kind: 'none' } } };
          if (s === String(inspectControl)) return { result: { value: { standard: true, value } } };
          if (s === fixedFormInspectors['form-state'].source) return { result: { value: {
            kind: !options.secondField && objects.get(params.objectId) === 3 ? 'button' : 'text', value, connected: true, enabled: true, visible: true, hit: true, readonly: false,
            rect: { x: 1, y: 1, width: 100, height: 20 }, submit: !options.secondField && objects.get(params.objectId) === 3,
          } } };
          if (s.includes('this.checkElementStates')) return { result: { value: null } };
          if (s.includes('this.expectHitTarget')) return { result: { value: 'done' } };
          if (s.includes('this.fill(node,value)')) return { result: { value: 'needsinput' } };
          throw Error('unsupported fixed helper');
        }
        case 'Input.insertText': value = params.text; return {};
        case 'Input.dispatchMouseEvent': return {};
        default: throw Error('unsupported fake CDP method ' + method);
      }
    } }, { get(o, k) { if (k in o || k === 'then' || typeof k === 'symbol') return o[k]; throw Error('unsupported fake member ' + k); } });
  if (options.rawOnly) return { raw, calls, targets, ax, value: () => value };
  root = createRootTargets({ session: raw, current: () => ({ session: 'client', turn: 'turn', browserIncarnation: 'browser', brokerEpoch: 1 }) });
  const owner = createTransportOwner({ session: raw, checkLease: value => live && root.checkLease(value), helpers: { ...formInspectors(), ...fixedReadInspectors },
    nodeBinding: id => ax.some(n => n.backendDOMNodeId === id) ? { ...activeLease, backendNodeId: id } : null });
  const adapter = createSemanticAdapter({ owner, rootTargets: root, current: value => live ? root.current(value) : null,
    leaseFor: (tab, context) => { activeLease = root.leaseFor(tab, context); return activeLease; } });
  const authority = createAuthority({ current: adapter.currentScope, classify: adapter.classify, checkTarget: adapter.checkTarget,
    authenticate: () => false, snapshot: () => ({ scope: adapter.currentScope(), time: Date.now() }) });
  adapter.bindAuthority(authority);
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: adapter.resolveOperation });
  const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest,
    prepare: adapter.prepare, authorize: adapter.authorize, dispatchFence: adapter.dispatchFence, dispatch: adapter.dispatch,
    transportAuthority, endSession: id => { revokeAuthoritySession(authority, id); owner.revokeSession(id); root.revokeSession(id); return true; },
    disconnect: async () => { await owner.close(); return true; }, redact: value => value });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  t.after(() => root.close());
  return { client, adapter, authority, owner, broker, secret, uid, root, raw, targets, calls, ax, value: () => value, revoke() { live = false; } };
}
