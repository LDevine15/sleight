import test from 'node:test';
import assert from 'node:assert/strict';
import { createRootTargets } from '../plugins/sleight/lib/direct-browser/root-targets.mjs';
import { createTransportOwner } from '../plugins/sleight/lib/direct-browser/transport-owner.mjs';
import { createSemanticAdapter, formInspectors, fixedFormInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';
import { fixedReadInspectors } from '../plugins/sleight/lib/direct-browser/reads.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { validateHostRequest } from '../plugins/sleight/lib/direct-browser/request-schema.mjs';
import * as popups from '../plugins/sleight/lib/direct-browser/popups.mjs';

async function fixture(t, intent, options = {}) {
  const calls = [], targets = new Map(), objects = new Map(), listeners = new Set(); let serial = 0, opened = false, roots;
  const origin = 'https://fixture.invalid';
  const binding = { session: 'client', turn: 'turn', browserIncarnation: 'browser', brokerEpoch: 1 };
  const raw = { sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); },
    async send(method, params, route) {
      calls.push({ method, params, route });
      const targetId = route?.slice(5), info = targets.get(targetId);
      let result;
      switch (method) {
        case 'Target.createTarget': {
          assert.deepEqual(Object.keys(params).sort(), ['background', 'url']); assert.equal(params.background, true);
          const id = 'owned-' + (++serial); targets.set(id, { targetId: id, type: 'page', url: params.url, title: params.url.endsWith('/size') ? 'Size guide' : 'Shipping rates' });
          return { targetId: id };
        }
        case 'Target.attachToTarget': return { sessionId: 'page-' + params.targetId };
        case 'Target.getTargetInfo': return { targetInfo: targets.get(params.targetId) };
        case 'Target.getTargets': return { targetInfos: [...targets.values()] };
        case 'Target.closeTarget': targets.delete(params.targetId); return { success: true };
        case 'Page.getFrameTree': return { frameTree: { frame: { id: 'frame-' + targetId, loaderId: 'loader', url: info.url } } };
        case 'Page.addScriptToEvaluateOnNewDocument': return { identifier: 'strict' };
        case 'Page.navigate': {
          info.url = params.url; info.title = params.url.endsWith('/size') ? 'Size guide' : 'Shipping rates'; return {};
        }
        case 'Runtime.evaluate': return { result: { value: params.expression === `(${popups.popupDestination})()` ?
          { ready: true, independent: options.independent !== false, title: info.title, url: info.url } : true } };
        case 'Page.setInterceptFileChooserDialog': case 'Page.enable': case 'Accessibility.enable':
        case 'DOM.scrollIntoViewIfNeeded': case 'Runtime.releaseObject': return {};
        case 'Page.createIsolatedWorld': return { executionContextId: 9 };
        case 'DOM.resolveNode': { const id = 'node-' + (++serial); objects.set(id, params.backendNodeId); return { object: { objectId: id } }; }
        case 'DOM.getDocument': result = { root: { backendNodeId: 1, nodeType: 9, children: [{ backendNodeId: 2, nodeType: 1, childNodeCount: 0 }] } }; break;
        case 'DOM.describeNode': result = { node: { backendNodeId: params.backendNodeId, nodeType: 1, childNodeCount: 0 } }; break;
        case 'Accessibility.getPartialAXTree': result = { nodes: [{ nodeId: '2', backendDOMNodeId: 2, role: { value: 'button' }, name: { value: 'Popup' }, childIds: [] }] }; break;
        case 'Runtime.callFunctionOn': {
          const s = params.functionDeclaration;
          if (s.startsWith('function(){const module')) return { result: { objectId: 'constructor' } };
          if (s.startsWith('function(){return new this')) return { result: { objectId: 'instance' } };
          if (s.includes('this.setupHitTargetInterceptor')) return { result: { objectId: 'interceptor-' + (++serial) } };
          if (s === 'function(){return this.stop();}') return { result: { value: 'done' } };
          if (s === String(popups.popupIntent)) return { result: { value: options.sourceChanged && targets.size > 1 ?
            { code: 'OPENER_REQUIRED', reason: 'uncertain' } : intent } };
          if (s === String(popups.popupResult)) return { result: { value: opened ? intent : { kind: 'none' } } };
          if (s === fixedFormInspectors['form-state'].source) return { result: { value: { kind: 'button', tag: 'button', connected: true,
            visible: true, enabled: true, hit: true, readonly: false, rect: { x: 1, y: 1, width: 100, height: 20 } } } };
          if (s === fixedReadInspectors['control-state'].source) return { result: { value: { standard: true } } };
          if (s.includes('this.checkElementStates')) return { result: { value: null } };
          if (s.includes('this.expectHitTarget')) return { result: { value: 'done' } };
          assert.fail('unexpected fixed function ' + s.slice(0, 50)); break;
        }
        case 'Input.dispatchMouseEvent': if (params.type === 'mouseReleased') opened = true; return {};
        case 'Input.dispatchKeyEvent': if (params.type === 'keyUp') opened = true; return {};
        default: assert.fail('unexpected CDP method ' + method);
      }
      roots.observeNodes(route, method, result); return result;
    } };
  roots = createRootTargets({ session: raw, current: () => binding });
  const owner = createTransportOwner({ session: raw, checkLease: roots.checkLease, nodeBinding: roots.nodeBinding,
    helpers: { ...formInspectors(), ...fixedReadInspectors } });
  const adapter = createSemanticAdapter({ owner, rootTargets: roots, leaseFor: roots.leaseFor, current: roots.current });
  const authority = createAuthority({ authenticate: () => false, classify: adapter.classify, current: adapter.currentScope,
    checkTarget: adapter.checkTarget, snapshot: () => ({ scope: adapter.currentScope(), time: Date.now() }) });
  adapter.bindAuthority(authority);
  const transportAuthority = createTransportAuthority({ authority, resolveOperation: adapter.resolveOperation });
  const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser', connect: async () => raw,
    verifyConnection: () => true, currentTurn: () => 'turn', validateRequest: validateHostRequest,
    prepare: adapter.prepare, authorize: adapter.authorize, dispatchFence: adapter.dispatchFence, dispatch: adapter.dispatch,
    transportAuthority, endSession: () => { roots.revokeSession('client'); owner.revokeSession('client'); return true; },
    disconnect: () => true, redact: v => v });
  await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  t.after(async () => { await broker.shutdown(); await adapter.cleanupSession('client'); });
  const open = await client.request({ id: 'open', operation: 'browser_open', args: { browser: 'bfixture', url: origin + '/shop' } });
  assert.equal(open.effect, 'verified', JSON.stringify(open));
  const read = await client.request({ id: 'read', operation: 'browser_read', args: { tab: open.tab } });
  assert.equal(read.effect, 'verified', JSON.stringify(read));
  assert.equal(adapter.delivered(roots.leaseFor(open.tab, binding), read.observation.observation), true);
  const ref = read.observation.data.find(r => r.role === 'button').ref;
  return { roots, binding, calls, targets, tab: open.tab, emit: event => { for (const fn of listeners) fn(event); },
    act: id => client.request({ id, operation: 'browser_act', args: { tab: open.tab, op: 'click', ref } }) };
}

for (const kind of ['link', 'window']) test('checked ' + kind + ' opens a leased background tab and returns its title', async t => {
  const f = await fixture(t, { kind, url: 'https://fixture.invalid/size', name: kind === 'window' ? 'sizeguide' : '', nullReturned: kind === 'window' });
  const result = await f.act('popup');
  assert.equal(result.effect, 'verified', JSON.stringify(result)); assert.match(result.tab ?? '', /^t/);
  assert.notEqual(result.tab, f.tab); assert.equal(result.observation.title, 'Size guide');
  assert.equal(result.observation.nullReturned, kind === 'window');
  assert.equal(f.roots.leaseFor(result.tab, f.binding).origin, 'https://fixture.invalid');
  assert.equal(f.calls.filter(c => c.method === 'Target.createTarget').length, 2);
  assert.equal(f.calls.some(c => ['Page.bringToFront', 'Target.activateTarget'].includes(c.method)), false);
});

test('a named popup reuses only the tab this session allocated for its name', async t => {
  const f = await fixture(t, { kind: 'window', url: 'https://fixture.invalid/size', name: 'sizeguide', nullReturned: true });
  const first = await f.act('first'), second = await f.act('second');
  assert.match(first.tab ?? '', /^t/); assert.equal(second.tab, first.tab, JSON.stringify(second));
  assert.equal(f.calls.filter(c => c.method === 'Target.createTarget').length, 2);
});

test('opener dependent action is refused before any Input command or second allocation', async t => {
  const f = await fixture(t, { code: 'OPENER_REQUIRED', reason: 'cross-origin' });
  const result = await f.act('signin');
  assert.equal(result.effect, 'none', JSON.stringify(result)); assert.equal(result.observation.code, 'OPENER_REQUIRED');
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
  assert.equal(f.calls.filter(c => c.method === 'Target.createTarget').length, 1);
});

test('a destination that reads its opener refuses before source input', async t => {
  const f = await fixture(t, { kind: 'window', url: 'https://fixture.invalid/size', name: 'sizeguide', nullReturned: true }, { independent: false });
  const result = await f.act('opener-read');
  assert.equal(result.effect, 'none', JSON.stringify(result)); assert.equal(result.observation.code, 'OPENER_REQUIRED');
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});

test('popup destination gets the strict future hook before its first navigation', async t => {
  const f = await fixture(t, { kind: 'window', url: 'https://fixture.invalid/size', name: 'sizeguide', nullReturned: true });
  await f.act('guarded');
  const creates = f.calls.filter(c => c.method === 'Target.createTarget');
  assert.equal(creates[1].params.url, 'about:blank');
  const popupRoute = f.roots.leaseFor((await f.act('reuse')).tab, f.binding).cdpSessionId;
  const hook = f.calls.findIndex(c => c.route === popupRoute && c.method === 'Page.addScriptToEvaluateOnNewDocument');
  const navigate = f.calls.findIndex(c => c.route === popupRoute && c.method === 'Page.navigate');
  assert.ok(hook >= 0 && navigate > hook, 'the owned destination must be guarded before scripts can open a native window');
});

test('source intent changing during destination qualification prevents source input', async t => {
  const f = await fixture(t, { kind: 'window', url: 'https://fixture.invalid/size', name: 'sizeguide', nullReturned: true }, { sourceChanged: true });
  const result = await f.act('changed-source');
  assert.equal(result.effect, 'none', JSON.stringify(result)); assert.equal(result.observation.code, 'OPENER_REQUIRED');
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});

test('named reuse navigates the owned target for a new URL without another create', async t => {
  const intent = { kind: 'window', url: 'https://fixture.invalid/size', name: 'guide', nullReturned: true };
  const f = await fixture(t, intent), first = await f.act('first-url');
  intent.url = 'https://fixture.invalid/shipping';
  const second = await f.act('next-url');
  assert.equal(second.tab, first.tab, JSON.stringify(second)); assert.equal(second.observation.title, 'Shipping rates');
  assert.equal(f.calls.filter(c => c.method === 'Target.createTarget').length, 2);
  assert.equal(f.roots.leaseFor(first.tab, f.binding).origin, 'https://fixture.invalid');
});

test('an allocated popup remains readable when its source navigates', async t => {
  const f = await fixture(t, { kind: 'window', url: 'https://fixture.invalid/size', name: 'guide', nullReturned: true });
  const result = await f.act('independent'), parent = f.roots.leaseFor(f.tab, f.binding);
  f.emit({ sessionId: parent.cdpSessionId, method: 'Page.frameNavigated', params: {
    frame: { id: parent.frame, loaderId: 'next', url: 'https://fixture.invalid/other' } } });
  assert.equal(f.roots.checkLease(parent), false);
  assert.equal(f.roots.checkLease(f.roots.leaseFor(result.tab, f.binding)), true);
});

test('failed named navigation retains one cleanup owner for its uncertain target', async t => {
  const intent = { kind: 'window', url: 'https://fixture.invalid/size', name: 'guide', nullReturned: true }, options = {};
  const f = await fixture(t, intent, options), first = await f.act('first');
  const target = f.roots.leaseFor(first.tab, f.binding).target;
  intent.url = 'https://fixture.invalid/next'; options.independent = false;
  const failed = await f.act('unqualified'); assert.equal(failed.effect, 'none');
  const cleanup = await f.roots.cleanupSession('client');
  const receipts = cleanup.cleanup.filter(r => r.target === target);
  assert.equal(receipts.length, 1, JSON.stringify(cleanup));
  assert.equal(receipts[0].status, 'retained'); assert.equal(receipts[0].code, 'EFFECT_UNKNOWN');
  assert.equal(f.calls.filter(c => c.method === 'Target.closeTarget' && c.params.targetId === target).length, 0);
});
