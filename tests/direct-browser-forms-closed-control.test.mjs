import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { createFormSession, formInspectors, fixedFormInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';
import { RefMap } from '../plugins/sleight/lib/direct-browser/refs.mjs';

const identity = { browserIncarnation: 'closed-fixture', brokerEpoch: 1, clientSession: 'client', turn: 'turn',
  leaseGeneration: 1, target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
const lease = { ...identity, epoch: 1, cdpSessionId: 'page' };
const host = { backendNodeId: 2, nodeType: 1, nodeName: 'FB-SECURE-SWITCH', localName: 'fb-secure-switch',
  nodeValue: '', childNodeCount: 0, attributes: ['id', 'twoFactor', 'label', 'Two-factor authentication'] };
const fragment = { backendNodeId: 3, nodeType: 11, nodeName: '#document-fragment', localName: '',
  nodeValue: '', shadowRootType: 'closed', childNodeCount: 2 };
const style = { backendNodeId: 4, nodeType: 1, nodeName: 'STYLE', localName: 'style', nodeValue: '',
  childNodeCount: 1, children: [{ backendNodeId: 5, nodeType: 3, nodeName: '#text', localName: '',
    nodeValue: 'button{width:46px;height:28px}', childNodeCount: 0 }] };
const button = { backendNodeId: 6, nodeType: 1, nodeName: 'BUTTON', localName: 'button', nodeValue: '',
  childNodeCount: 0, attributes: ['type', 'button', 'role', 'switch', 'aria-label', 'Two-factor authentication', 'aria-checked', 'false'] };
const visible = { connected: true, visible: true, enabled: true, editable: true, readonly: false,
  hit: true, frameLocal: false, rect: { x: 20, y: 20, width: 46, height: 28 } };

// The cached settings.html builds STYLE + BUTTON in a closed fragment. Chromium's
// unpierced host description reports the fragment's count without its children.
// The real scoped adapter remains in the test: ownership, command grammar and
// foreign-frame checks must survive any acquisition strategy change.
function fixture(t, { initial = { ...host, shadowRoots: [fragment] }, expanded = { ...fragment, children: [style, button] },
  value = false, controlState = {}, expansionNodes = [] } = {}) {
  const events = new Set(), calls = [], known = new Set([2]), objects = new Map();
  const descriptions = new Map([[2, initial], [3, expanded], [4, style], [5, style.children[0]], [6, button],
    ...expansionNodes.map(node => [node.backendNodeId, node])]);
  let sequence = 0, form, checked = value;
  const collect = raw => {
    if (!raw) return;
    known.add(raw.backendNodeId);
    for (const child of [...raw.children ?? [], ...raw.shadowRoots ?? []]) collect(child);
  };
  const raw = new Proxy({ sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); events.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); events.delete(fn); },
    async send(method, params, route) {
      assert.equal(route, 'page'); calls.push({ method, params: structuredClone(params) });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'strict-popup' };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      if (method === 'Page.setInterceptFileChooserDialog') { assert.deepEqual(params, { enabled: true }); return {}; }
      if (method === 'Page.enable') { assert.deepEqual(params, {}); return {}; }
      if (method === 'Page.createIsolatedWorld') {
        assert.deepEqual(params, { frameId: 'frame', worldName: 'sleight-state', grantUniveralAccess: false });
        return { executionContextId: 9 };
      }
      if (method === 'Accessibility.getPartialAXTree') {
        assert.equal(params.backendNodeId, 2); assert.equal(params.fetchRelatives, false);
        return { nodes: [{ nodeId: 'ax-host', backendDOMNodeId: 2, frameId: 'frame',
          role: { value: 'generic' }, name: { value: '' } }] };
      }
      if (method === 'DOM.describeNode') {
        assert.ok(known.has(params.backendNodeId), 'describe only a node discovered under the owned host');
        assert.ok([0, 1, 2].includes(params.depth)); assert.equal(params.pierce, false);
        const node = descriptions.get(params.backendNodeId);
        assert.ok(node, 'unsupported fixture expansion: ' + params.backendNodeId);
        collect(node); return { node: structuredClone(node) };
      }
      if (method === 'DOM.scrollIntoViewIfNeeded') { assert.ok(known.has(params.backendNodeId)); return {}; }
      if (method === 'DOM.resolveNode') {
        assert.ok(known.has(params.backendNodeId)); assert.equal(params.executionContextId, 9);
        const id = 'node-' + ++sequence; objects.set(id, params.backendNodeId); return { object: { objectId: id } };
      }
      if (method === 'Runtime.releaseObject') { assert.ok(objects.has(params.objectId)); objects.delete(params.objectId); return {}; }
      if (method === 'Runtime.callFunctionOn') {
        const source = params.functionDeclaration;
        if (source.includes('this.setupHitTargetInterceptor')) {
          const id = 'interceptor-' + (++sequence); objects.set(id, 6); return { result: { objectId: id } };
        }
        if (source === 'function(){return this.stop();}') { assert.ok(objects.has(params.objectId)); return { result: { value: 'done' } }; }
        if (source.startsWith('function(){const module = {};\n')) {
          assert.equal(params.executionContextId, 9); return { result: { objectId: 'constructor' } };
        }
        if (source.startsWith('function(){return new this(window,')) return { result: { objectId: 'instance' } };
        const node = objects.get(params.arguments?.[0]?.objectId ?? params.objectId);
        assert.ok([2, 6].includes(node), 'fixed helper must bind the owned host or its discovered switch');
        if (source === fixedFormInspectors['form-state'].source) return { result: { value: node === 2
          ? { ...visible, tag: 'fb-secure-switch', role: '', kind: 'custom' }
          : { ...visible, tag: 'button', role: 'switch', kind: 'switch', value: checked, source: 'ax', ...controlState } } };
        if (source === 'async function(node,states){return await this.checkElementStates(node,states,true) ?? null;}') return { result: { value: null } };
        if (source === 'function(node,x,y){return this.expectHitTarget({x,y},node);}') return { result: { value: 'done' } };
        throw Error('unsupported fixed function');
      }
      if (method === 'Input.dispatchMouseEvent') {
        assert.equal(form.activeNode, 6, 'input must target the uniquely acquired owned control');
        assert.ok(['mousePressed', 'mouseReleased'].includes(params.type));
        if (params.type === 'mouseReleased') checked = !checked;
        return {};
      }
      throw Error('unsupported physical method ' + method);
    } }, { get(o, key) { if (key in o || typeof key === 'symbol' || key === 'then') return o[key]; throw Error('unsupported fake member ' + key); } });
  const refs = new RefMap(identity), ref = refs.observe(identity, 2, JSON.stringify(['generic', '', null]));
  const adapter = createScopedAdapter({ session: raw, helpers: formInspectors(), checkLease: () => true,
    nodeBinding: id => known.has(id) ? { ...lease, backendNodeId: id } : null });
  form = createFormSession({ session: adapter.forLease(lease), identity, current: () => identity,
    resolveRef: handle => refs.resolve(handle, identity), onOperation() {} });
  t.after(() => { form.dispose(); adapter.disconnect(); });
  return { calls, fill: () => form.fill([{ ref, value: true }], { operation: 'settings' }), checked: () => checked };
}

test('settings switch expands a shallow closed fragment and verifies one native click', async t => {
  const f = fixture(t), result = await f.fill();
  assert.equal(result.completed, 1, JSON.stringify(result)); assert.equal(result.effect, 'verified');
  assert.equal(f.checked(), true);
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseReleased').length, 1);
});

test('already checked shallow closed switch verifies without clicking', async t => {
  const f = fixture(t, { value: true }), result = await f.fill();
  assert.equal(result.completed, 1, JSON.stringify(result)); assert.equal(result.results[0].effect, 'unchanged');
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});

const secondButton = { ...button, backendNodeId: 7 };
for (const [name, options] of [
  ['missing control', { expanded: { ...fragment, childNodeCount: 1, children: [style] } }],
  ['ambiguous controls', { expanded: { ...fragment, childNodeCount: 2, children: [button, secondButton] } }],
  ['incomplete fragment after expansion', { expanded: { ...fragment, childNodeCount: 3, children: [style, button] } }],
  ['foreign-frame fragment', { expanded: { ...fragment, frameId: 'foreign-frame', children: [style, button] } }],
  ['missing native checked state', { controlState: { value: undefined } }],
]) test(name + ' refuses the shallow closed switch without input', async t => {
  const f = fixture(t, options), result = await f.fill();
  assert.equal(result.completed, 0); assert.equal(result.effect, 'none'); assert.equal(result.untouched, 1);
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});

test('a visible candidate cannot hide a second control in an incomplete fragment', async t => {
  const f = fixture(t, { initial: { ...host, shadowRoots: [{ ...fragment, children: [button] }] },
    expanded: { ...fragment, children: [button, secondButton] } });
  const result = await f.fill();
  assert.equal(result.completed, 0, JSON.stringify(result)); assert.equal(result.effect, 'none');
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});

const leaf = id => ({ backendNodeId: id, nodeType: 1, nodeName: 'SPAN', localName: 'span', nodeValue: '', childNodeCount: 0 });
for (const [name, raw] of [
  ['negative child count', { ...fragment, childNodeCount: -1, children: [button] }],
  ['duplicate backend identity', { ...fragment, childNodeCount: 3, children: [button, leaf(4), leaf(4)] }],
  ['ancestor backend identity cycle', { ...fragment, childNodeCount: 2, children: [button, leaf(2)] }],
  ['node budget exhaustion', { ...fragment, childNodeCount: 66, children: [button, ...Array.from({ length: 65 }, (_, i) => leaf(200 + i))] }],
]) test(name + ' cannot authorize input to an otherwise valid visible switch', async t => {
  const f = fixture(t, { initial: { ...host, shadowRoots: [raw] } }), result = await f.fill();
  assert.equal(result.completed, 0, JSON.stringify(result)); assert.equal(result.effect, 'none');
  assert.equal(result.observation.code, 'UNKNOWN_CHECKED_STATE');
  assert.equal(f.checked(), false); assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});

for (const [branches, want] of [[16, 'verified'], [17, 'none']]) test(branches + ' targeted expansions respect the owned read budget', async t => {
  const shallow = Array.from({ length: branches }, (_, i) => ({ ...leaf(100 + i), childNodeCount: 1 }));
  const f = fixture(t, {
    initial: { ...host, shadowRoots: [{ ...fragment, childNodeCount: branches + 1, children: [button, ...shallow] }] },
    expansionNodes: shallow.map((node, i) => ({ ...node, children: [leaf(200 + i)] })),
  });
  const result = await f.fill();
  assert.equal(result.effect, want, JSON.stringify(result));
  assert.equal(result.completed, branches === 16 ? 1 : 0);
  assert.equal(f.calls.filter(c => c.method === 'DOM.describeNode' && c.params.backendNodeId !== 2).length, 16);
  if (branches === 17) {
    assert.equal(result.observation.code, 'UNKNOWN_CHECKED_STATE');
    assert.equal(f.checked(), false); assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
  } else assert.equal(f.checked(), true);
});
