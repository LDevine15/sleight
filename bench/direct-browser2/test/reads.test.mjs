import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserReads, inspectControl } from '../reads.mjs';
import { RefMap } from '../refs.mjs';
import vm from 'node:vm';

const identity = { browser: 'browser-incarnation', epoch: 2, broker: 4, session: 'client', lease: 3, target: 'target' };
const node = (id, name = `Field ${id}`, extra = {}) => ({ nodeId: String(id), backendDOMNodeId: id,
  role: { value: id === 1 ? 'RootWebArea' : 'textbox' }, name: { value: name },
  childIds: id === 1 ? ['2', '3'] : [], ...extra });
class Session extends EventEmitter {
  sessionId = 'cdp-session'; nodes = [node(1), node(2), node(3)]; states = new Map(); calls = [];
  async send(method, params = {}) {
    this.calls.push([method, params]);
    switch (method) {
      case 'Page.enable':
      case 'Accessibility.enable': return {};
      case 'Accessibility.getRootAXNode': return { node: structuredClone(this.nodes[0]) };
      case 'Accessibility.getFullAXTree': return { nodes: structuredClone(this.nodes) };
      case 'Accessibility.getPartialAXTree': return { nodes: structuredClone(this.nodes.filter(n => n.backendDOMNodeId === params.backendNodeId)) };
      case 'Accessibility.getChildAXNodes': {
        const children = new Set(this.nodes.find(p => p.nodeId === params.id)?.childIds ?? []);
        return { nodes: structuredClone(this.nodes.filter(n => children.has(n.nodeId))) };
      }
      case 'Page.createIsolatedWorld': return { executionContextId: 7 };
      case 'DOM.resolveNode': return { object: { objectId: String(params.backendNodeId) } };
      case 'Runtime.callFunctionOn': return { result: { value: this.states.get(Number(params.objectId)) ?? { standard: true } } };
      case 'Runtime.releaseObject': return {};
      default: throw Error(`Unsupported CDP command ${method}`);
    }
  }
}
function setup(options = {}) {
  const session = new Session();
  const reader = new BrowserReads({ identity, authorize: () => true, ...options });
  reader.addFrame({ session, frameId: 'main', document: 'doc', target: identity.target });
  return { session, reader };
}
const delivered = async reader => { const r = await reader.read(); reader.acknowledge(r.observation); return r; };

for (const autocomplete of ['cc-number', 'CC-NUMBER', 'Cc-CsC', 'ONE-TIME-CODE', 'CURRENT-PASSWORD', 'NEW-PASSWORD',
  'section-fixture shipping CC-NUMBER', '\tsection-fixture\nCc-CsC\r\f', 'username ONE-TIME-CODE webauthn']) {
  test('serialized inspector redacts protected autocomplete token ' + JSON.stringify(autocomplete) + ' in a full read', async t => {
    const { reader, session } = setup(); t.after(() => reader.dispose());
    const secret = 'synthetic-private';
    session.nodes[1].value = { value: secret };
    const send = session.send.bind(session);
    session.send = async (method, params) => {
      if (method !== 'Runtime.callFunctionOn') return send(method, params);
      const state = vm.runInNewContext(`
        class Element { getAttribute(name) { return name === 'autocomplete' ? rawAutocomplete : null; } }
        class HTMLInputElement extends Element {
          get type() { return 'text'; } get value() { return privateValue; }
          get disabled() { return false; } get readOnly() { return false; } get required() { return false; }
        }
        class HTMLTextAreaElement extends Element {}
        class HTMLSelectElement extends Element {}
        class HTMLOptionElement extends Element {}
        (${params.functionDeclaration}).call(new HTMLInputElement())`, { rawAutocomplete: autocomplete, privateValue: secret });
      return { result: { value: state } };
    };
    const result = await reader.read();
    assert.equal(result.data[1].state.protected, true);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  });
}
test('serialized inspector matches whole ASCII autocomplete tokens only', () => {
  for (const autocomplete of ['username', 'not-CC-NUMBER', 'CC-NUMBER-extra', 'one-time-code_suffix', 'CC-NUMBER,Cc-CsC', 'CURRENT-PAſſWORD']) {
    const state = vm.runInNewContext(`
      class Element { getAttribute() { return rawAutocomplete; } }
      class HTMLInputElement extends Element { get type() { return 'text'; } get value() { return 'public-fixture'; } }
      class HTMLTextAreaElement extends Element {}
      class HTMLSelectElement extends Element {}
      class HTMLOptionElement extends Element {}
      (${inspectControl.toString()}).call(new HTMLInputElement())`, { rawAutocomplete: autocomplete });
    assert.equal(state.protected, undefined, autocomplete);
    assert.equal(state.value, 'public-fixture', autocomplete);
  }
});

test('lost full and delta envelopes never activate new refs', async () => {
  const { reader, session } = setup();
  const lost = await reader.read();
  assert.throws(() => reader.resolve(lost.data[1].ref), /stale/);
  const first = await delivered(reader);
  session.nodes[1].name.value = 'New row';
  const delta = await reader.read({ since: first.observation });
  assert.throws(() => reader.resolve(delta.data.find(r => r.name === 'New row').ref), /stale/);
  assert.equal(reader.acknowledge(lost.observation), false);
  assert.equal(reader.acknowledge(delta.observation), true);
  assert.equal(reader.resolve(delta.data.find(r => r.name === 'New row').ref).backendNode, 2);
});
test('private reads preserve independently delivered scoped baselines', async () => {
  const { reader } = setup(); const first = await delivered(reader);
  const scoped = await reader.read({ ref: first.data[1].ref }); reader.acknowledge(scoped.observation);
  await reader.read({ private: true });
  const delta = await reader.read({ since: first.observation });
  assert.equal(delta.mode, 'delta'); assert.equal(delta.data.length, 0);
});
test('default acquisition never asks for a full tree and has an independent node cap', async () => {
  const { reader, session } = setup({ maxNodes: 5 });
  session.nodes = Array.from({ length: 100 }, (_, i) => node(i + 1, `Row ${i}`, { childIds: i < 99 ? [String(i + 2)] : [] }));
  const result = await reader.read();
  assert.equal(session.calls.some(([m]) => m === 'Accessibility.getFullAXTree'), false);
  assert.ok(result.coverage.acquired <= 5); assert.equal(result.complete, false);
});
test('real serialized native inspector reports truncated values and cannot claim unchanged tails', async () => {
  const context = vm.createContext({});
  vm.runInContext(`class Element { getAttribute() { return null; } }; class HTMLInputElement extends Element { get type(){return 'text'} get value(){return this.v} }; class HTMLTextAreaElement extends Element {}; class HTMLSelectElement extends Element {}; class HTMLOptionElement extends Element {}; globalThis.input=new HTMLInputElement(); input.v='x'.repeat(600)+'before';`, context);
  const { reader, session } = setup();
  session.states.set(2, vm.runInContext(`(${inspectControl.toString()}).call(input)`, context));
  const first = await delivered(reader);
  assert.equal(first.data[1].state.valueTruncated, true); assert.equal(first.complete, false);
  vm.runInContext(`input.v='x'.repeat(600)+'after'`, context);
  session.states.set(2, vm.runInContext(`(${inspectControl.toString()}).call(input)`, context));
  const next = await reader.read({ since: first.observation });
  assert.equal(next.mode, 'full'); assert.equal(next.complete, false);
});
test('broker epoch is part of ref authority', () => {
  const refs = new RefMap(identity); const ref = refs.observe({ frame: 'main', document: 'doc' }, 1, 'row');
  assert.throws(() => refs.resolve(ref, { ...identity, broker: 5 }), /stale/);
});
test('same-node recycled meaning, detach, and navigation refuse old refs', async () => {
  const { reader, session } = setup(); const first = await delivered(reader);
  session.nodes[1].name.value = 'Recycled'; await delivered(reader);
  assert.throws(() => reader.resolve(first.data[1].ref), /stale/);
  const fresh = await delivered(reader); session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'new' } });
  assert.throws(() => reader.resolve(fresh.data[0].ref), /stale/);
  session.emit('Page.frameDetached', { frameId: 'main' }); await assert.rejects(reader.read(), /Frame unavailable/);
});
test('cross-origin session denied before any content acquisition', async () => {
  const { reader } = setup({ authorize: scope => scope.target === 'target' }); const child = new Session();
  reader.addFrame({ session: child, frameId: 'child', document: 'child-doc', target: 'other', parent: 'main' });
  await assert.rejects(reader.read({ frame: 'child' }), /not authorized/); assert.equal(child.calls.length, 0);
});
test('late navigation discards an acquisition', async () => {
  const { reader, session } = setup(); const send = session.send.bind(session);
  session.send = async (...args) => { const r = await send(...args); if (args[0] === 'Accessibility.getChildAXNodes') session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'late' } }); return r; };
  await assert.rejects(reader.read(), /invalidated/);
});
test('Unicode metadata-inclusive budget, duplicate labels and nested scopes', async () => {
  const { reader, session } = setup(); session.nodes[1].name.value = session.nodes[2].name.value = '選択🧪'.repeat(80);
  const first = await reader.read({ maxBytes: 1200 }); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 1200);
  reader.acknowledge(first.observation);
  const full = await reader.read({ maxBytes: 64000 }); reader.acknowledge(full.observation);
  assert.notEqual(full.data[1].ref, full.data[2].ref);
  const scoped = await reader.read({ ref: full.data[1].ref }); assert.equal(scoped.data.length, 1);
});
test('sessions isolate baseline and refs, protected state and errors never leak', async () => {
  const a = setup(), b = setup({ identity: { ...identity, session: 'other-client' } });
  a.session.states.set(2, { protected: true, value: 'secret-fixture' }); const first = await delivered(a.reader);
  assert.doesNotMatch(JSON.stringify(first), /secret-fixture/);
  await assert.rejects(b.reader.read({ ref: first.data[1].ref }), /stale/);
  const next = await b.reader.read({ since: first.observation }); assert.equal(next.resync, 'baseline-mismatch');
  a.session.send = async () => { throw Error('secret-fixture'); };
  await assert.rejects(a.reader.read(), e => !e.message.includes('secret-fixture'));
});

test('private proof cannot overwrite a pending delivery receipt or cursor', async () => {
  const { reader } = setup(); const result = await reader.read();
  await reader.read({ private: true });
  assert.equal(reader.acknowledge(result.observation), true);
  assert.equal(reader.resolve(result.data[1].ref).backendNode, 2);
});
test('bounded trusted ARIA acquisition uses selective AX only for missing backend semantics', async () => {
  const { reader, session } = setup({ ariaAcquire: async request => {
    assert.equal(request.maxNodes, 1000);
    return { nodes: [node(1, 'ARIA page', { childIds: ['2'] }), node(2, 'ARIA field')], complete: true };
  } });
  const result = await reader.read();
  assert.equal(result.data[1].name, 'ARIA field');
  assert.equal(session.calls.some(([m]) => m.startsWith('Accessibility.get')), false);
});
test('stale scope never guesses the reused backend node meaning', async () => {
  const { reader, session } = setup(); const first = await delivered(reader);
  session.nodes[1].name.value = 'Different meaning';
  await assert.rejects(reader.read({ ref: first.data[1].ref }), /stale/);
});
test('truncation and sensed values propagate for options without false complete', async () => {
  const { reader, session } = setup(); session.states.set(2, { value: '選択', truncated: true, options: [{ label: '選択', value: 'v' }], optionsOmitted: 2 });
  const result = await reader.read(); assert.equal(result.complete, false); assert.equal(result.data[1].state.valueTruncated, true);
});
test('multiple pending scoped and frame deliveries acknowledge independently', async () => {
  const { reader } = setup(); const first = await delivered(reader);
  const scoped = await reader.read({ ref: first.data[1].ref });
  const full = await reader.read();
  assert.equal(reader.acknowledge(scoped.observation), true); assert.equal(reader.acknowledge(full.observation), true);
  const again = await reader.read({ ref: first.data[1].ref, since: scoped.observation }); assert.equal(again.mode, 'delta');
});

test('wide acquisition refuses oversized child payloads before requesting them', async () => {
  const { reader, session } = setup({ maxNodes: 5 });
  session.nodes[0].childIds = Array.from({ length: 3000 }, (_, i) => String(i + 2));
  const result = await reader.read();
  assert.equal(result.complete, false);
  assert.equal(session.calls.some(([m]) => m === 'Accessibility.getChildAXNodes'), false);
});
test('same-document navigation invalidates refs pending reclassification', async () => {
  const { reader, session } = setup(); const first = await delivered(reader);
  session.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://fixture.test/other' });
  assert.throws(() => reader.resolve(first.data[1].ref), /stale/);
});
test('oversized ARIA acquisition refuses rather than silently claiming bounded work', async () => {
  const { reader } = setup({ maxNodes: 1, ariaAcquire: async () => ({ nodes: [node(1), node(2)], complete: true }) });
  await assert.rejects(reader.read(), /Read unavailable/);
});

test('lost page refs stay unavailable and valid cursor acknowledges only its preceding page', async () => {
  const { reader, session } = setup();
  session.nodes = [node(1, 'List', { childIds: Array.from({ length: 20 }, (_, i) => String(i + 2)) }), ...Array.from({ length: 20 }, (_, i) => node(i + 2))];
  const first = await reader.read({ maxBytes: 1000 });
  assert.throws(() => reader.resolve(first.data[0].ref), /stale/);
  const second = await reader.read({ cursor: first.cursor, maxBytes: 1000 });
  assert.equal(reader.resolve(first.data[0].ref).backendNode, 1);
  for (const row of second.data) assert.throws(() => reader.resolve(row.ref), /stale/);
  assert.equal(reader.acknowledge(second.observation), true);
});
test('selective AX enrichment remains in the exact selected frame', async () => {
  const { reader, session } = setup({ ariaAcquire: async () => ({ nodes: [node(2, 'ARIA field', { axEnrich: true })], complete: true }) });
  const result = await reader.read(); assert.equal(result.complete, true);
  const partial = session.calls.filter(([m]) => m === 'Accessibility.getPartialAXTree');
  assert.equal(partial.length, 1); assert.equal(partial[0][1].backendNodeId, 2); assert.equal(partial[0][1].fetchRelatives, false);
});
test('retained ref cannot cross an identity change and opaque IDs contain no backend or origin', () => {
  const refs = new RefMap(identity); const ref = refs.observe({ frame: 'main', document: 'doc' }, 12, 'button');
  for (const field of ['browser', 'epoch', 'broker', 'session', 'lease', 'target']) assert.throws(() => refs.resolve(ref, { ...identity, [field]: 'changed' }), /stale/);
  assert.doesNotMatch(ref, /main|doc|target|client|browser/);
});
test('missing standard sensing is incomplete and cannot expose AX fallback', async () => {
  const { reader, session } = setup(); session.nodes[1].value = { value: 'private-fallback' }; session.states.set(2, { unsupported: true });
  const result = await reader.read(); assert.equal(result.complete, false); assert.doesNotMatch(JSON.stringify(result), /private-fallback/);
});
test('fake read calibration publishes all samples at concurrency 1, 4 and 13', async () => {
  const samples = [];
  for (const concurrency of [1, 4, 13]) for (const [workload, count] of [['small', 3], ['dense', 121], ['list3000', 3001]]) {
    for (let trial = 0; trial < 3; trial++) await Promise.all(Array.from({ length: concurrency }, async (_, lane) => {
      const { reader, session } = setup({ maxNodes: 512 });
      session.nodes = Array.from({ length: count }, (_, i) => node(i + 1, `選択 ${i} 🧪`, { role: { value: i === 0 ? 'RootWebArea' : 'button' }, childIds: i + 1 < count ? [String(i + 2)] : [] }));
      const result = await reader.read();
      samples.push({ concurrency, workload, trial, lane, ...reader.lastMetrics, complete: result.complete, matched: result.coverage.matched, expected: count });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12000); assert.ok(reader.lastMetrics.acquiredNodes <= 512);
      if (count === 3) assert.equal(result.complete, true);
      if (count > 512) assert.equal(result.complete, false);
      reader.dispose();
    }));
  }
  console.log('BP2_4_RAW_CALIBRATION', JSON.stringify(samples));
});
test('navigation domain enabled before any acquisition', async () => {
  const { reader, session } = setup(); await reader.read();
  assert.equal(session.calls[0][0], 'Page.enable');
});


test('real-page harness follows node:test and skips without the live opt-in', async () => {
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env, SLEIGHT_LIVE_DOM_TEST: '0' };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', new URL('./reads.live.test.mjs', import.meta.url).pathname], {
    env, encoding: 'utf8', timeout: 10000
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /(?:#|ℹ) skipped 2/);
  assert.match(run.stdout, /live browser test is reserved for sleight-arch/);
});

test('removed refs retire despite an unrelated unreadable or truncated control', async () => {
  for (const state of [{ unsupported: true }, { value: 'x', truncated: true }]) {
    const { reader, session } = setup();
    const first = await delivered(reader), old = first.data[1].ref;
    session.nodes = [node(1, 'Page', { childIds: ['3'] }), node(3)];
    session.states.set(3, state);
    const next = await reader.read(); reader.acknowledge(next.observation);
    assert.equal(next.complete, false);
    assert.throws(() => reader.resolve(old), /stale/);
    reader.dispose();
  }
});
test('partial topology fences unchecked old refs while keeping absence unknown', async () => {
  const { reader, session } = setup({ maxNodes: 4 });
  const first = await delivered(reader), old = first.data[1].ref;
  session.nodes[0].childIds = Array.from({ length: 20 }, (_, i) => String(i + 2));
  const next = await reader.read(); reader.acknowledge(next.observation);
  assert.equal(next.coverage.sensing, 'incomplete');
  assert.equal(next.complete, false);
  assert.throws(() => reader.resolve(old), /stale/);
  assert.equal(reader.resolve(first.data[0].ref).backendNode, 1);
  reader.dispose();
});
test('a failed scoped acquisition retires its requested ref', async () => {
  const { reader, session } = setup();
  const first = await delivered(reader), old = first.data[1].ref;
  session.nodes = [node(1, 'Page', { childIds: ['3'] }), node(3)];
  await assert.rejects(reader.read({ ref: old }), /unavailable/);
  assert.throws(() => reader.resolve(old), /stale/);
  assert.equal(reader.resolve(first.data[2].ref).backendNode, 3);
  reader.dispose();
});
test('two scoped cursors and a private proof keep independent delivery state', async () => {
  const { reader, session } = setup();
  session.nodes = [node(1, 'List', { childIds: Array.from({ length: 20 }, (_, i) => String(i + 2)) }),
    ...Array.from({ length: 20 }, (_, i) => node(i + 2))];
  const first = await reader.read({ maxBytes: 1000 }); reader.acknowledge(first.observation);
  const second = await reader.read({ query: 'Field', maxBytes: 1000 });
  assert.ok(first.cursor); assert.ok(second.cursor); assert.notEqual(first.cursor, second.cursor);
  await reader.read({ private: true });
  const nextFirst = await reader.read({ cursor: first.cursor, maxBytes: 1000 });
  const nextSecond = await reader.read({ cursor: second.cursor, maxBytes: 1000 });
  assert.equal(nextFirst.coverage.offset, first.data.length);
  assert.equal(nextSecond.coverage.offset, second.data.length);
  assert.equal(reader.acknowledge(nextFirst.observation), true);
  assert.equal(reader.acknowledge(nextSecond.observation), true);
  reader.dispose();
});
test('a changed page or navigation still refuses a retained cursor', async () => {
  for (const cause of ['change', 'navigation']) {
    const { reader, session } = setup();
    session.nodes[1].name.value = session.nodes[2].name.value = '選択🧪'.repeat(80);
    const first = await reader.read({ maxBytes: 1000 });
    assert.ok(first.cursor);
    if (cause === 'change') session.nodes[2].name.value = 'Different';
    else session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'new' } });
    await assert.rejects(reader.read({ cursor: first.cursor }), /Cursor stale/);
    reader.dispose();
  }
});
test('cursor retention evicts the oldest view without erasing recent independent scopes', async () => {
  const { reader, session } = setup();
  session.nodes = [node(1, 'List', { childIds: Array.from({ length: 20 }, (_, i) => String(i + 2)) }),
    ...Array.from({ length: 20 }, (_, i) => node(i + 2, 'x'.repeat(40)))];
  const pages = [];
  for (let n = 1; n <= 33; n++) {
    const page = await reader.read({ query: 'x'.repeat(n), maxBytes: 1000 });
    assert.ok(page.cursor); pages.push(page);
  }
  await assert.rejects(reader.read({ cursor: pages[0].cursor }), /Cursor stale/);
  const next = await reader.read({ cursor: pages[1].cursor, maxBytes: 1000 });
  assert.equal(next.coverage.offset, pages[1].data.length);
  reader.dispose();
});

function scopedCursorFixture() {
  const f = setup();
  const group = (id, children) => node(id, `Group ${id}`, { role: { value: 'list' }, childIds: children.map(String) });
  f.session.nodes = [node(1, 'Page', { childIds: ['2', '30'] }), group(2, Array.from({ length: 20 }, (_, i) => i + 3)),
    ...Array.from({ length: 20 }, (_, i) => node(i + 3, `Item ${i}`, { role: { value: 'button' } })),
    group(30, Array.from({ length: 20 }, (_, i) => i + 31)),
    ...Array.from({ length: 20 }, (_, i) => node(i + 31, `Other ${i}`, { role: { value: 'button' } }))];
  return f;
}
for (const failure of ['missing', 'transport']) test('cursor-bound ' + failure + ' acquisition retires the actual ref and expansion receipt', async t => {
  const { reader, session } = scopedCursorFixture(); t.after(() => reader.dispose());
  const first = await delivered(reader), ref = first.data.find(row => row.name === 'Group 2').ref;
  const page = await reader.read({ ref, maxBytes: 1000 }); assert.ok(page.cursor);
  if (failure === 'missing') session.nodes = session.nodes.filter(n => n.backendDOMNodeId !== 2);
  else { const send = session.send.bind(session); session.send = (method, args) => {
    if (method === 'Accessibility.getPartialAXTree' && args.backendNodeId === 2) throw Error('private page failure');
    return send(method, args);
  }; }
  await assert.rejects(reader.read({ cursor: page.cursor }), /unavailable/);
  assert.throws(() => reader.resolve(ref), /stale/);
  assert.equal(reader.acknowledge(page.observation), false);
  await assert.rejects(reader.read({ cursor: page.cursor }), /Cursor stale/);
});
test('cursor acquisition failure preserves unrelated caller refs, receipts and cursors', async t => {
  const { reader, session } = scopedCursorFixture(); t.after(() => reader.dispose());
  const first = await delivered(reader);
  const ref = first.data.find(row => row.name === 'Group 2').ref;
  const other = first.data.find(row => row.name === 'Group 30').ref;
  const page = await reader.read({ ref, maxBytes: 1000 });
  const independent = await reader.read({ ref: other, maxBytes: 1000 });
  assert.ok(page.cursor); assert.ok(independent.cursor);
  session.nodes = session.nodes.filter(n => n.backendDOMNodeId !== 2);
  await assert.rejects(reader.read({ ref: other, cursor: page.cursor }), /unavailable/);
  assert.throws(() => reader.resolve(ref), /stale/);
  assert.equal(reader.resolve(other).backendNode, 30);
  assert.equal(reader.acknowledge(independent.observation), true);
  const expanded = await reader.read({ cursor: independent.cursor }); assert.ok(expanded.data.length);
});
test('failure expires related query cursors without clearing a different scope', async t => {
  const { reader, session } = scopedCursorFixture(); t.after(() => reader.dispose());
  const first = await delivered(reader), ref = first.data.find(row => row.name === 'Group 2').ref;
  const plain = await reader.read({ ref, maxBytes: 1000 }); reader.acknowledge(plain.observation);
  const queried = await reader.read({ ref, query: 'Item', maxBytes: 1000 }); reader.acknowledge(queried.observation);
  assert.ok(plain.cursor); assert.ok(queried.cursor);
  session.nodes = session.nodes.filter(n => n.backendDOMNodeId !== 2);
  await assert.rejects(reader.read({ cursor: queried.cursor, private: true }), /unavailable/);
  assert.throws(() => reader.resolve(ref), /stale/);
  await assert.rejects(reader.read({ cursor: plain.cursor }), /Cursor stale/);
  await assert.rejects(reader.read({ cursor: queried.cursor }), /Cursor stale/);
});

// Retained V-BP2-4R2 case: a newer semantic ref replaces a cursor's binding.
for (const privateRead of [false, true]) test('obsolete semantic cursor refuses before probing a newly delivered missing ref (private=' + privateRead + ')', async t => {
  const { reader, session } = scopedCursorFixture(); t.after(() => reader.dispose());
  const first = await delivered(reader), old = first.data.find(row => row.name === 'Group 2').ref;
  const page = await reader.read({ ref: old, maxBytes: 1000 }); reader.acknowledge(page.observation);
  assert.ok(page.cursor);
  session.nodes[1].name.value = 'Changed list meaning';
  const fresh = await delivered(reader), current = fresh.data.find(row => row.name === 'Changed list meaning').ref;
  const other = fresh.data.find(row => row.name === 'Group 30').ref;
  assert.notEqual(current, old); assert.throws(() => reader.resolve(old), /stale/);
  const independent = await reader.read({ ref: other, maxBytes: 1000 });
  session.nodes = session.nodes.filter(row => row.backendDOMNodeId !== 2); session.calls = [];
  await assert.rejects(reader.read({ cursor: page.cursor, private: privateRead }), /unavailable/);
  const probedMissing = session.calls.some(([method, params]) => method === 'Accessibility.getPartialAXTree' && params.backendNodeId === 2);
  let retained;
  try { retained = reader.resolve(current).backendNode; } catch {}
  t.diagnostic(JSON.stringify({ privateRead, probedMissing, retainedBackendNode: retained ?? null }));
  // Either refuse the obsolete cursor first or retire the current ref after
  // observing absence. This implementation refuses before acquiring content.
  if (probedMissing) assert.throws(() => reader.resolve(current), /stale/);
  assert.equal(session.calls.length, 0);
  assert.equal(reader.resolve(current).backendNode, 2);
  assert.equal(reader.resolve(other).backendNode, 30);
  assert.equal(reader.acknowledge(independent.observation), true);
  const expanded = await reader.read({ cursor: independent.cursor }); assert.ok(expanded.data.length);
});
