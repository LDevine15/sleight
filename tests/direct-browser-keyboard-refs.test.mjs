import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as snapshots from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { browserTools } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';

function world() {
  const events = [], state = { active: true, eligible: true, native: true, role: 'textbox', axRole: 'textbox', zeroArea: true, context: {}, failed: false, backend: 7 };
  const page = new EventEmitter();
  const contextHandle = () => { const context = state.context; return { context, async dispose() { events.push(['context-disposed', context]); } }; };
  const utility = { world: 'utility', async evaluateExpression(source, options, args) {
    assert.equal(options.isFunction, true);
    if (source.includes('sameNativeEditContext')) return state.eligible && args[1].context === state.context;
    if (source.includes('readNativeEditContext')) return { native: state.native, eligible: state.eligible, role: state.role, zeroArea: state.zeroArea };
    return state.active;
  }, async evaluateExpressionHandle(source) {
    if (source.includes('retainNativeEditContext')) return contextHandle();
    assert.match(source, /activeElement/);
    return state.active ? active : { asElement: () => null, async dispose() {} };
  } };
  const nativeSession = { _client: { async _sendMayFail(method, args) {
    events.push([method, args]);
    if (method === 'DOM.describeNode') { assert.deepEqual(args, { objectId: 'active-object' }); return { node: { backendNodeId: state.backend } }; }
    if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ backendDOMNodeId: state.backend, ignored: false, role: { value: state.axRole }, name: { value: 'Editor' }, properties: [] }] };
    throw Error('unexpected native read');
  } } };
  const frameImpl = { _page: { delegate: { noUtilityWorld: () => false, _sessionForFrame: () => nativeSession } }, utilityContext: async () => utility };
  const active = { _frame: frameImpl, _objectId: 'active-object', asElement() { return this; }, async dispose() { events.push(['active-disposed']); } };
  const frame = { _connection: { toImpl: object => { assert.equal(object, frame); return frameImpl; } }, isDetached: () => false };
  Object.assign(page, { url: () => 'http://fixture.invalid/', frames: () => [frame], mainFrame: () => frame,
    locator() { throw Error('selector identity is forbidden'); },
    async ariaSnapshotJSON() { if (state.failed) throw Error('failed read'); return structuredClone(state.tree ?? [{ role: 'textbox', name: 'Editor', active: true }, { role: 'button', name: 'Ordinary', ref: 'e1' }]); },
    context: () => ({ async newCDPSession() { return { async send(method) {
      if (method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [] };
      throw Error('no metrics');
    }, async detach() {} }; } }),
  });
  return { page, state, events, active, utility, frame };
}
const xref = text => /\[ref=(x\d+)\]/.exec(text)?.[1];

test('snapshot acquires a genuine active zero-area context as an ACK-gated keyboard-only x ref', async () => {
  const w = world(), read = await snapshots.snapshot(w.page), ref = xref(read.text);
  assert.match(ref ?? '', /^x\d+$/);
  assert.match(read.text, /textbox "Editor".*\[keyboard-only\].*\[ref=x\d+\]/);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, ref), /delivered|stale/);
  assert.equal(snapshots.acknowledgeSnapshot(w.page, read.number), true);
  const binding = snapshots.keyboardRefBinding(w.page, ref);
  assert.equal(binding.backendNodeId, 7);
  assert.equal(binding.context.context, w.state.context);
  assert.equal(binding.keyboardOnly, true);
  assert.ok(w.events.some(([method]) => method === 'DOM.describeNode'));
  assert.match(read.text, /button "Ordinary" \[ref=e1\]/);
});
test('changed native contexts mint unique x refs and cannot gain authority from an older snapshot ACK', async () => {
  const w = world(), first = await snapshots.snapshot(w.page), oldRef = xref(first.text);
  w.state.context = {};
  const second = await snapshots.snapshot(w.page), next = xref(second.text);
  assert.notEqual(next, oldRef);
  snapshots.acknowledgeSnapshot(w.page, first.number);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, oldRef), /delivered|stale/);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, next), /delivered|stale/);
  snapshots.acknowledgeSnapshot(w.page, second.number);
  assert.equal(snapshots.keyboardRefBinding(w.page, next).keyboardOnly, true);
});
test('an unchanged native binding keeps its acknowledged ref and exact retained handle across scoped reads', async () => {
  const w = world(), first = await snapshots.snapshot(w.page), oldRef = xref(first.text);
  snapshots.acknowledgeSnapshot(w.page, first.number);
  const original = snapshots.keyboardRefBinding(w.page, oldRef), scoped = await snapshots.snapshot(w.page, { ref: oldRef });
  assert.equal(xref(scoped.text), oldRef);
  assert.equal(snapshots.keyboardRefBinding(w.page, oldRef).context, original.context);
  assert.doesNotMatch(scoped.text, /Ordinary/);
  assert.equal(w.events.filter(([kind]) => kind === 'context-disposed').length, 0);
});
test('find omission retires ACK authority and an old printed snapshot cannot refresh it', async () => {
  const w = world(), first = await snapshots.snapshot(w.page), oldRef = xref(first.text);
  snapshots.acknowledgeSnapshot(w.page, first.number);
  const prior = await snapshots.snapshot(w.page);
  const second = await snapshots.snapshot(w.page, { find: 'Ordinary' });
  snapshots.acknowledgeSnapshot(w.page, second.number);
  assert.equal(xref(second.text), undefined);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, oldRef), /delivered|stale/);
  snapshots.acknowledgeSnapshot(w.page, prior.number);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, oldRef), /delivered|stale/);
  const fresh = await snapshots.snapshot(w.page);
  assert.equal(xref(fresh.text), oldRef);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, oldRef), /delivered|stale/);
  snapshots.acknowledgeSnapshot(w.page, fresh.number);
  assert.equal(snapshots.keyboardRefBinding(w.page, oldRef).keyboardOnly, true);
});
test('clipped continuations preserve stable keyboard refs and ACK only the slice that prints them', async () => {
  const w = world(); w.state.tree = Array.from({ length: 60 }, (_, i) => ({ role: 'button', name: 'Ordinary item ' + i + ' '.repeat(20), ref: 'e' + (i + 1) }));
  const full = await snapshots.snapshot(w.page, { maxChars: 40000 }), known = xref(full.text);
  let read = await snapshots.snapshot(w.page, { maxChars: 1000 }), slices = 1, ref = xref(read.text);
  snapshots.acknowledgeSnapshot(w.page, full.number);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, known), /delivered|stale/);
  while (/Continue with ref="(more\d+_\d+)"/.test(read.text)) {
    snapshots.acknowledgeSnapshot(w.page, read.number);
    const token = /Continue with ref="(more\d+_\d+)"/.exec(read.text)[1];
    read = await snapshots.snapshot(w.page, { ref: token, maxChars: 1000 });
    ref ??= xref(read.text);
    assert.ok(++slices < 12);
  }
  assert.ok(slices > 1);
  assert.match(ref ?? '', /^x\d+$/);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, ref), /delivered|stale/);
  snapshots.acknowledgeSnapshot(w.page, read.number);
  assert.equal(snapshots.keyboardRefBinding(w.page, ref).keyboardOnly, true);
});
test('a context swap invalidates the old scoped read and cannot reuse its ACK', async () => {
  const w = world(), first = await snapshots.snapshot(w.page), old = xref(first.text);
  w.state.context = {};
  await assert.rejects(snapshots.snapshot(w.page, { ref: old }), /not on the page now/);
  snapshots.acknowledgeSnapshot(w.page, first.number);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, old), /delivered|stale/);
  const fresh = await snapshots.snapshot(w.page), next = xref(fresh.text);
  assert.notEqual(next, old);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, next), /delivered|stale/);
});
test('native attachment disappearance retires its previously acknowledged ref and disposes the old context', async () => {
  const w = world(), first = await snapshots.snapshot(w.page), ref = xref(first.text);
  snapshots.acknowledgeSnapshot(w.page, first.number); w.state.active = false;
  assert.equal(xref((await snapshots.snapshot(w.page)).text), undefined);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, ref), /stale/);
  assert.ok(w.events.some(([kind]) => kind === 'context-disposed'));
});
for (const [name, change] of [ ['inactive', w => { w.state.active = false; }], ['non-native', w => { w.state.native = false; }],
  ['ineligible', w => { w.state.eligible = false; }], ['non-text AX role', w => { w.state.axRole = 'button'; }],
  ['role disagreement', w => { w.state.axRole = 'searchbox'; }],
  ['positive area', w => { w.state.zeroArea = false; }] ])
  test(`snapshot never acquires keyboard refs for ${name}`, async () => {
    const w = world(); change(w);
    const read = await snapshots.snapshot(w.page);
    assert.equal(xref(read.text), undefined);
  });
for (const event of ['framenavigated', 'framedetached', 'close']) test(`${event} retires and disposes the retained native context`, async () => {
  const w = world(), read = await snapshots.snapshot(w.page), ref = xref(read.text);
  snapshots.acknowledgeSnapshot(w.page, read.number);
  w.page.emit(event);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, ref), /delivered|stale/);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(w.events.some(([kind]) => kind === 'context-disposed'));
});
test('missing native backend identity fails the capture instead of preserving a partial x bank', async () => {
  const w = world(); w.state.backend = 0;
  await assert.rejects(snapshots.snapshot(w.page), /Snapshot unavailable/);
});
test('failed capture retires an acknowledged x bank', async () => {
  const w = world(), read = await snapshots.snapshot(w.page), ref = xref(read.text);
  snapshots.acknowledgeSnapshot(w.page, read.number); w.state.failed = true;
  await assert.rejects(snapshots.snapshot(w.page), /Snapshot unavailable/);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, ref), /delivered|stale/);
});
test('a partial candidate read failure disposes already retained contexts and invalidates the whole bank', async () => {
  const w = world(), first = await snapshots.snapshot(w.page), old = xref(first.text);
  snapshots.acknowledgeSnapshot(w.page, first.number);
  const other = { _connection: { toImpl: () => ({ _page: { delegate: {} }, utilityContext: async () => { throw Error('frame read failed'); } }) } };
  w.page.frames = () => [w.frame, other];
  await assert.rejects(snapshots.snapshot(w.page), /Snapshot unavailable/);
  assert.throws(() => snapshots.keyboardRefBinding(w.page, old), /stale/);
  assert.ok(w.events.some(([kind]) => kind === 'context-disposed'));
});
test('navigation during a pending native retention cannot publish a late capability', async () => {
  const w = world(), evaluate = w.utility.evaluateExpressionHandle; let release;
  w.utility.evaluateExpressionHandle = async (...args) => {
    if (!args[0].includes('retainNativeEditContext')) return evaluate(...args);
    return new Promise(resolve => { release = async () => resolve(await evaluate(...args)); });
  };
  const pending = snapshots.snapshot(w.page);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  w.page.emit('framenavigated'); await release();
  await assert.rejects(pending, /Snapshot unavailable/);
  assert.ok(w.events.some(([kind]) => kind === 'context-disposed'));
});
test('a timed-out active-node read blocks subsequent refs and captures until the original read settles', async () => {
  const w = world(), evaluate = w.utility.evaluateExpressionHandle; let release;
  const original = await snapshots.snapshot(w.page); snapshots.acknowledgeSnapshot(w.page, original.number);
  w.utility.evaluateExpressionHandle = async () => new Promise(resolve => { release = () => resolve(w.active); });
  await assert.rejects(snapshots.snapshot(w.page), /Snapshot unavailable/);
  assert.equal(snapshots.snapshotAcquisitionPending(w.page), true);
  assert.throws(() => w.page.getByRef('e1'), /pending|progress/);
  await assert.rejects(snapshots.snapshot(w.page), /pending|progress/);
  const calls = { resolve: 0, input: 0, rules: 0, steps: 0 };
  const refuseResolver = () => { calls.resolve++; throw Error('resolver reached'); };
  w.page.locator = refuseResolver;
  Object.defineProperty(w.page, 'getByRef', { configurable: true, value: refuseResolver });
  w.page.keyboard = { async press() { calls.input++; }, async insertText() { calls.input++; } };
  const tab = { page: w.page, state: { snapshotNo: original.number, submitUnconfirmed: false } };
  const run = createActionRunner({ check() { calls.rules++; return 'allow'; }, snapshot: async () => ({ number: 99, text: 'unused' }) });
  const fill = createFillFields({ check() { calls.rules++; return 'allow'; }, runSteps: async () => { calls.steps++; return { lines: [] }; } });
  const acted = await run(tab, [{ do: 'press', key: 'Escape' }], {}, { observe: 'none' });
  assert.match(acted.lines[0], /not run: Snapshot acquisition is still pending/);
  assert.match(JSON.stringify(await fill(tab, [{ ref: 'e1', value: 'unused' }], {}, {})), /Snapshot acquisition is still pending/);
  assert.deepEqual(calls, { resolve: 0, input: 0, rules: 0, steps: 0 });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.snapshotAcquisitionPending(w.page), false);
  assert.match((await run(tab, [{ do: 'press', key: 'Escape' }], {}, { observe: 'none' })).lines[0], /resolver reached/);
  assert.doesNotMatch(JSON.stringify(await fill(tab, [{ ref: 'e1', value: 'unused' }], {}, {})), /Snapshot acquisition is still pending/);
  assert.deepEqual(calls, { resolve: 2, input: 0, rules: 0, steps: 0 });
  w.utility.evaluateExpressionHandle = evaluate;
  const fresh = await snapshots.snapshot(w.page);
  assert.match(xref(fresh.text) ?? '', /^x\d+$/);
});
test('public action and fill schemas accept distinct keyboard-only refs', () => {
  assert.equal(typeof browserTools, 'function');
  const tools = browserTools();
  const act = tools.find(tool => tool.name === 'browser_act');
  const fill = tools.find(tool => tool.name === 'browser_fill');
  assert.equal(new RegExp(act.inputSchema.properties.steps.items.properties.ref.pattern).test('x41'), true);
  assert.equal(new RegExp(fill.inputSchema.properties.fields.items.properties.ref.pattern).test('x41'), true);
});
