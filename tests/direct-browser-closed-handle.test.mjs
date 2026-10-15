import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { utilityLocator } from './direct-browser-utility-fixture.mjs';
import { closedLocator, closedDetails, resolveClosedHandle, hostsRootEvidence } from '../plugins/sleight/lib/direct-browser/closed-handle.mjs';
import { focusCheckedNode } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { inspectTarget } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';

// A fake of the in-process Playwright seams resolveClosedHandle uses: the client connection's toImpl/_objects, the
// frame's page delegate session, and one seed element handle that teaches the dispatcher class. The page has the
// binding's frame and one same-session child frame.
function inProcess({ adopt = async () => ({ disposed: false, dispose() { this.disposed = true; } }), shadowRoots = [], owner } = {}) {
  const objects = new Map(), dispatchers = new Map(), calls = { adopt: [], seeds: 0, described: [] };
  const connection = { _objects: objects };
  const dispatchConnection = { _dispatcherByGuid: dispatchers, existingDispatcher: impl => impl === childImpl ? childDispatcher : undefined };
  class ElementHandleDispatcher {
    static fromJSOrElementHandle(scope, impl) {
      const dispatcher = new ElementHandleDispatcher(); dispatcher._guid = 'handle@' + objects.size;
      dispatcher.scope = scope; dispatcher.impl = impl;
      dispatchers.set(dispatcher._guid, dispatcher);
      objects.set(dispatcher._guid, { _guid: dispatcher._guid, click() {}, async ownerFrame() { return (owner ?? (() => frame))(); },
        async dispose() { calls.disposedClient = (calls.disposedClient ?? 0) + 1; } });
      return dispatcher;
    }
  }
  const seed = new ElementHandleDispatcher(); seed._type_ElementHandle = true; dispatchers.set('seed', seed);
  const frameDispatcher = { kind: 'frame' }, childDispatcher = { kind: 'child frame' };
  dispatchers.set('frame@1', frameDispatcher);
  const session = { async _adoptBackendNodeId(id, context) { calls.adopt.push([id, context]); return adopt(id, context); },
    _client: { async _sendMayFail(method, params) { calls.described.push([method, params]); return shadowRoots === null ? null : { node: { shadowRoots } }; } } };
  const frameImpl = { _page: { delegate: { _sessionForFrame: () => session }, frames: () => [frameImpl, childImpl] }, async mainContext() { return 'main-context'; } };
  const childImpl = { _page: frameImpl._page, async mainContext() { return 'child-context'; } };
  const frame = { _connection: connection, _guid: 'frame@1', async evaluateHandle() { calls.seeds++; return { _guid: 'seed', async dispose() {} }; } };
  const child = { kind: 'client child frame' };
  connection.toImpl = value => value === connection ? dispatchConnection : value === frame ? frameImpl : value === child ? childImpl : undefined;
  return { frame, child, calls, objects };
}

test('a closed-root ref resolves to a client handle from its backend node and records whether it hosts a root', async () => {
  const fake = inProcess({ shadowRoots: [] });
  const handle = await resolveClosedHandle({ frame: fake.frame, backendNodeId: 12 });
  assert.deepEqual(fake.calls.adopt, [[12, 'main-context']]);
  assert.deepEqual(closedDetails(handle), { backendNodeId: 12, hostsRoot: false });
  assert.deepEqual(fake.calls.described, [['DOM.describeNode', { backendNodeId: 12 }]]);
  await resolveClosedHandle({ frame: fake.frame, backendNodeId: 13 });
  assert.equal(fake.calls.seeds, 1, 'the dispatcher class is learned once per connection');
});

test('a node owned by a same-process child frame is resolved again in that frame', async () => {
  let fake;
  fake = inProcess({ owner: () => fake.child });
  const handle = await resolveClosedHandle({ frame: fake.frame, backendNodeId: 21 });
  assert.deepEqual(fake.calls.adopt, [[21, 'main-context'], [21, 'child-context']]);
  assert.equal(fake.calls.disposedClient, 1, 'the handle adopted into the parent frame is released');
  assert.ok(closedDetails(handle));
});

test('a child frame that the parent context refuses to adopt from owns the node', async () => {
  const fake = inProcess({ adopt: async (id, context) => {
    if (context === 'main-context') throw Error('Unable to adopt element handle from a different document');
    return { dispose() {} };
  }, owner: () => fake.child });
  const handle = await resolveClosedHandle({ frame: fake.frame, backendNodeId: 21 });
  assert.deepEqual(fake.calls.adopt, [[21, 'main-context'], [21, 'child-context']]);
  assert.ok(closedDetails(handle));
});

test('a node whose owner keeps changing is refused after each frame was tried once', async () => {
  let asked = 0, fake;
  fake = inProcess({ owner: () => asked++ % 2 === 0 ? fake.child : fake.frame });
  await assert.rejects(resolveClosedHandle({ frame: fake.frame, backendNodeId: 21 }), /stale or unavailable/);
  assert.ok(fake.calls.adopt.length <= 2);
});

test('a closed host, or a describeNode that gives no answer, counts as hosting a root', async () => {
  for (const [shadowRoots, hostsRoot] of [[[{ shadowRootType: 'closed' }], true], [null, true]]) {
    const handle = await resolveClosedHandle({ frame: inProcess({ shadowRoots }).frame, backendNodeId: 5 });
    assert.equal(closedDetails(handle).hostsRoot, hostsRoot);
  }
});

test('a node that cannot be adopted is a stale ref, and a frame without the in-process seams is unavailable', async () => {
  const gone = inProcess({ adopt: async () => { throw Error('Unable to adopt element handle from a different document'); } });
  await assert.rejects(resolveClosedHandle({ frame: gone.frame, backendNodeId: 5 }), /stale or unavailable/);
  await assert.rejects(resolveClosedHandle({ frame: {}, backendNodeId: 5 }), /in-process/);
  await assert.rejects(resolveClosedHandle({ frame: gone.frame, backendNodeId: 0 }), /in-process/);
});

test('the closed locator resolves fresh on every use and refuses page-side searches', async () => {
  let bindings = 0;
  const locator = closedLocator(() => { bindings++; throw Error('Closed-root ref is stale or unavailable; take a new snapshot.'); });
  await assert.rejects(locator.elementHandle(), /stale or unavailable/);
  await assert.rejects(locator.click(), /stale or unavailable/);
  assert.equal(await locator.count(), 0);
  assert.equal(bindings, 3);
  for (const name of ['locator', 'getByRole', 'getByText', 'getByLabel', 'frameLocator', 'nth']) assert.throws(() => locator[name]('x'), /closed shadow root/);
});

// Focus: a node inside a closed root is reachable only through its own root chain.
function chain({ evidence, receiver = 'self', nested = false, localName = 'div' } = {}) {
  const doc = { nodeType: 9 }, view = { frameElement: null }; view.top = view; doc.defaultView = view;
  const outerHost = { localName: 'x-outer', isConnected: true, ownerDocument: doc, getRootNode: () => doc, shadowRoot: null };
  const outerRoot = { nodeType: 11, host: outerHost };
  const innerHost = nested ? { localName: 'x-inner', isConnected: true, ownerDocument: doc, getRootNode: () => outerRoot, shadowRoot: null } : outerHost;
  const innerRoot = nested ? { nodeType: 11, host: innerHost } : outerRoot;
  const el = { localName, isConnected: true, ownerDocument: doc, getRootNode: () => innerRoot, shadowRoot: null };
  innerRoot.activeElement = receiver === 'self' ? el : { localName: 'button' };
  if (nested) { outerRoot.activeElement = innerHost; doc.activeElement = outerHost; } else doc.activeElement = outerHost;
  return runInNewContext('(' + focusCheckedNode.toString() + ')(el, options)', { el, options: { focus: true, hostsRoot: evidence },
    HTMLElement: { prototype: { focus() {} } } });
}
test('focus in a closed root is proved by the root chain, once CDP says the node hosts no closed root', () => {
  assert.equal(chain({ evidence: false }), true);
  assert.equal(chain({ evidence: false, nested: true }), true);
  assert.equal(chain({ evidence: false, localName: 'button' }), true);
});
test('focus in a closed root without that evidence, or on another receiver, is refused', () => {
  assert.equal(chain({ evidence: undefined }), false, 'a div could host a deeper closed root');
  assert.equal(chain({ evidence: true }), false);
  assert.equal(chain({ evidence: undefined, localName: 'button' }), true);
  assert.equal(chain({ evidence: false, receiver: 'other' }), false);
  assert.equal(chain({ evidence: false, receiver: 'other', nested: true }), false);
});

// Risk classification reads the form around a shadow host.
function node(localName, attrs = {}, extra = {}) {
  return { localName, textContent: attrs.text ?? '', id: attrs.id ?? '', type: attrs.type, getAttribute: key => attrs[key] ?? null,
    closest: () => null, getRootNode() { return { nodeType: 9 }; }, ...extra };
}
test('a closed-root button counts for the form around its host: submit and card payment follow the host', () => {
  const card = node('input', { autocomplete: 'cc-number' });
  const form = node('form', {}, { querySelectorAll: () => [card] });
  const host = node('x-continue', {}, { closest: selector => selector === 'form' ? form : null });
  const button = node('button', { text: 'Continue' }, { form: null, getRootNode: () => ({ nodeType: 11, host }) });
  const inside = inspectTarget(button);
  assert.equal(inside.form, true); assert.equal(inside.formPayment, true);
  const loose = node('button', { text: 'Continue' }, { form: null, getRootNode: () => ({ nodeType: 11, host: node('x-continue') }) });
  assert.equal(inspectTarget(loose).form, false);
  assert.equal(inspectTarget(loose).payment, false);
});

// fill: a string for a closed-root select becomes a select step.
function selectNode() {
  return { tagName: 'SELECT', type: 'select-one', value: 'eu', checked: false, isConnected: true, disabled: false, readOnly: false,
    isContentEditable: false, multiple: false, options: [{ value: 'eu', label: 'Europe', selected: true, disabled: false }], children: [], labels: [],
    getAttribute: () => null, closest: () => null, getRootNode: () => ({ nodeType: 11, host: { closest: () => null } }), matches: () => false };
}
test('browser_fill with a string on a closed-root select asks for the select step, a text field for the type step', async () => {
  const seen = [];
  const make = node => ({ page: { getByRef: () => utilityLocator({ async evaluate(fn, arg) { return fn(node, arg); } }),
    on() {}, off() {}, mainFrame() { return this; } }, state: { snapshotNo: 1, submitUnconfirmed: false } });
  const fill = createFillFields({ check: () => 'allow', runSteps: async (tab, steps) => { seen.push(steps); return { lines: ['ok'], stoppedAt: null }; } });
  await fill(make(selectNode()), [{ ref: 's1', value: 'Europe' }], {}, { userMessage: 'x' });
  const text = selectNode(); text.tagName = 'INPUT'; text.type = 'text';
  await fill(make(text), [{ ref: 's1', value: 'Ada' }], {}, { userMessage: 'x' });
  assert.deepEqual(seen, [[{ do: 'select', ref: 's1', values: ['Europe'] }], [{ do: 'type', ref: 's1', text: 'Ada' }]]);
});

test('the action runner accepts closed-root s refs and resolves them through page.getByRef', async () => {
  const { createActionRunner } = await import('../plugins/sleight/lib/direct-browser/act.mjs');
  const asked = [], run = createActionRunner({ check: () => 'allow', snapshot: async () => ({ text: 'x', number: 1 }) });
  const page = { on() {}, off() {}, getByRef(ref) { asked.push(ref); throw Error('resolver reached'); }, url: () => 'http://x.invalid/' };
  const result = await run({ page, state: { snapshotNo: 0, submitUnconfirmed: false } },
    [{ do: 'click', ref: 's3' }, { do: 'press', ref: 's3', key: 'Space' }], {});
  assert.deepEqual(asked, ['s3']);
  assert.match(result.lines[0], /1 click s3: not run: resolver reached/);
  await assert.rejects(run({ page, state: {} }, [{ do: 'click', ref: 'sx3' }], {}), /click needs ref/);
});

// hostsRootEvidence asks the DOM agent about an ordinary handle: only "described, and no shadow root" says false.
function ordinaryHandle(answer, { objectId = 'object-1', owner = true } = {}) {
  const asked = [], frame = {};
  const session = { _client: { async _sendMayFail(method, params) { asked.push([method, params]); return typeof answer === 'function' ? answer() : answer; } } };
  const frameImpl = { _page: { delegate: { _sessionForFrame: value => (value === frameImpl ? session : undefined) } } };
  const connection = { toImpl: value => value === frame ? frameImpl : { _objectId: objectId } };
  return { handle: { _connection: connection, ownerFrame: async () => (owner ? frame : null) }, asked };
}
test('a light-DOM handle with no shadow root in the DOM agent gives false evidence, from its object id', async () => {
  const { handle, asked } = ordinaryHandle({ node: { shadowRoots: [] } });
  assert.equal(await hostsRootEvidence(handle), false); assert.deepEqual(asked, [['DOM.describeNode', { objectId: 'object-1' }]]);
  assert.equal(await hostsRootEvidence(ordinaryHandle({ node: {} }).handle), false, 'a node with no shadowRoots field hosts none');
});
test('a handle that hosts a root, is not described, or cannot be asked gives no evidence', async () => {
  assert.equal(await hostsRootEvidence(ordinaryHandle({ node: { shadowRoots: [{}] } }).handle), undefined);
  assert.equal(await hostsRootEvidence(ordinaryHandle(null).handle), undefined);
  assert.equal(await hostsRootEvidence(ordinaryHandle(() => { throw Error('gone'); }).handle), undefined);
  assert.equal(await hostsRootEvidence(ordinaryHandle({ node: {} }, { objectId: 7 }).handle), undefined);
  assert.equal(await hostsRootEvidence(ordinaryHandle({ node: {} }, { owner: false }).handle), undefined);
  assert.equal(await hostsRootEvidence({}), undefined);
});
