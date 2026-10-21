import test from 'node:test';
import assert from 'node:assert/strict';
import * as closed from '../plugins/sleight/lib/direct-browser/closed-handle.mjs';

function bridge() {
  const calls = [], objects = new Map(), dispatchers = new Map(), context = { actual: {} };
  const state = { same: true, active: true, current: true, ownerChanged: false, retired: false };
  const connection = { _objects: objects }, dispatcherConnection = { _dispatcherByGuid: dispatchers };
  const utility = { world: 'utility', async evaluateExpression(source, options, args) {
    assert.equal(options.isFunction, true);
    if (source.includes('sameNativeEditContext')) { assert.equal(args[1], context); return state.same; }
    return state.active;
  } };
  const pageImpl = { delegate: { noUtilityWorld: () => false, _sessionForFrame: () => session }, frames: () => [frameImpl, otherImpl] };
  const frameImpl = { _page: pageImpl, utilityContext: async () => utility, async mainContext() { throw Error('MAIN fallback forbidden'); } };
  const otherImpl = { _page: pageImpl }, frame = { _connection: connection, _guid: 'frame' }, otherFrame = {};
  class ElementHandleDispatcher {
    static fromJSOrElementHandle(scope, impl) {
      const dispatcher = new ElementHandleDispatcher(), handle = { _connection: connection,
        click() { throw Error('pointer must not run'); }, ownerFrame: async () => state.ownerChanged ? otherFrame : frame, async dispose() { calls.push('disposed'); } };
      dispatcher._guid = 'node'; objects.set('node', handle); handles.set(handle, impl); return dispatcher;
    }
  }
  const handles = new Map(), seed = new ElementHandleDispatcher(); seed._type_ElementHandle = true; dispatchers.set('seed', seed); dispatchers.set('frame', {});
  frame.evaluateHandle = async () => { throw Error('MAIN bootstrap forbidden'); };
  frame.locator = selector => { assert.equal(selector, ':root'); return { async elementHandle() { calls.push('utility-seed'); return { _guid: 'seed', async dispose() {} }; } }; };
  const session = { _client: { async _sendMayFail() { return { node: { backendNodeId: 9, shadowRoots: [] } }; } },
    async _adoptBackendNodeId(id, realm) { calls.push([id, realm.world]); assert.equal(realm, utility); return { _frame: frameImpl, async dispose() {} }; } };
  connection.toImpl = object => object === connection ? dispatcherConnection : object === frame ? frameImpl : object === otherFrame ? otherImpl : handles.get(object);
  const binding = { frame, backendNodeId: 9, generation: 2, context, keyboardOnly: true,
    current: () => state.current, retire() { state.retired = true; state.current = false; } };
  return { binding, context, state, calls };
}
test('keyboard ref backend resolution pins its exact frame and native context without MAIN evaluation', async () => {
  const w = bridge(), handle = await closed.resolveClosedHandle(w.binding);
  assert.equal(typeof closed.nativeEditContextDetails, 'function');
  const details = closed.nativeEditContextDetails(handle);
  assert.equal(details.context, w.context);
  assert.equal(details.keyboardOnly, true);
  assert.equal(details.generation, 2);
  assert.deepEqual(w.calls.filter(Array.isArray), [[9, 'utility']]);
});
for (const [name, change] of [['context swap', w => { w.state.same = false; }], ['focus loss', w => { w.state.active = false; }],
  ['bank revocation', w => { w.state.current = false; }], ['other frame owner', w => { w.state.ownerChanged = true; }]])
  test(`keyboard backend refuses ${name} and retires the bank entry`, async () => {
    const w = bridge(); change(w);
    await assert.rejects(closed.resolveClosedHandle(w.binding), /stale|unavailable/);
    assert.equal(w.state.retired, true);
    assert.ok(w.calls.filter(Array.isArray).length <= 1, 'another frame must never be searched');
  });
test('keyboard locator refuses pointer actions and direct fill before resolving a node', async () => {
  const w = bridge(); let resolved = false;
  const locator = closed.closedLocator(() => { resolved = true; return w.binding; });
  for (const name of ['click', 'dblclick', 'hover', 'focus', 'scrollIntoViewIfNeeded', 'fill', 'dispatchEvent', 'press'])
    await assert.rejects(locator[name]('x'), /keyboard-only/);
  assert.equal(w.calls.length, 0);
  assert.equal(resolved, true);
});
test('keyboard active proof requires the exact native focus chain through every frame owner', () => {
  const read = (node, key) => node?.[key];
  const rootView = {}; rootView.top = rootView;
  const rootDoc = { defaultView: rootView };
  const owner = { isConnected: true, ownerDocument: rootDoc };
  rootDoc.activeElement = owner;
  const childView = { frameElement: owner, top: rootView }, childDoc = { defaultView: childView };
  const editor = { isConnected: true, ownerDocument: childDoc };
  childDoc.activeElement = editor;
  assert.equal(closed.keyboardFocusChain(editor, undefined, read), true);
  rootDoc.activeElement = {};
  assert.equal(closed.keyboardFocusChain(editor, undefined, read), false);
  rootDoc.activeElement = owner; childView.frameElement = null;
  assert.equal(closed.keyboardFocusChain(editor, undefined, read), false, 'an inaccessible owner cannot be guessed to be top-level');
  childView.frameElement = owner; owner.isConnected = false;
  assert.equal(closed.keyboardFocusChain(editor, undefined, read), false);
  owner.isConnected = true; editor.shadowRoot = { activeElement: {} };
  assert.equal(closed.keyboardFocusChain(editor, undefined, read), false, 'an inner receiver cannot hide behind the checked host');
});
