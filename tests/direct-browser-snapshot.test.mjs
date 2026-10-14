import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const module = await import('../plugins/sleight/lib/direct-browser/snapshot.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

function nativeSnapshot(secrets) {
  const strings = ['#document', 'INPUT', '', 'type', 'password', 'http://127.0.0.1/fixture', 'UTF-8', 'frame'];
  const values = secrets.map(value => { strings.push(value); return strings.length - 1; });
  return { strings, documents: [{ documentURL: 5, title: 2, baseURL: 5, contentLanguage: 2, encodingName: 6,
    publicId: 2, systemId: 2, frameId: 7, scrollOffsetX: 0, scrollOffsetY: 0,
    nodes: { parentIndex: [-1, ...values.map(() => 0)], nodeType: [9, ...values.map(() => 1)],
      nodeName: [0, ...values.map(() => 1)], nodeValue: [2, ...values.map(() => 2)],
      backendNodeId: [1, ...values.map((_, i) => i + 2)], attributes: [[], ...values.map(() => [3, 4])],
      inputValue: { index: values.map((_, i) => i + 1), value: values } },
    layout: { nodeIndex: [], styles: [], bounds: [], text: [], stackingContexts: { index: [] } },
    textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] } }] };
}

function fixture(tree, secrets = []) {
  const page = new EventEmitter();
  const frame = { evaluate: async () => secrets };
  let current = tree;
  Object.assign(page, {
    url: () => 'http://127.0.0.1/fixture', frames: () => [frame], mainFrame: () => frame,
    ariaSnapshotJSON: async options => {
      assert.equal(options.mode, 'ai');
      return structuredClone(current);
    },
    context: () => ({ newCDPSession: async () => ({
      send: async method => {
        if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [] } };
        if (method === 'DOMSnapshot.captureSnapshot') return nativeSnapshot(secrets);
        throw Error('unsupported CDP call: ' + method);
      }, detach: async () => {},
    }) }),
  });
  return { page, set: value => { current = value; } };
}

test('snapshot exports the fixed V3 interface', () => {
  assert.equal(typeof module.snapshot, 'function');
});

test('snapshot renders compact untrusted YAML with usable iframe refs', async () => {
  const { page } = fixture([{ role: 'main', ref: 'e1', children: [
    { role: 'button', name: 'Next', ref: 'e2', disabled: true },
    { role: 'iframe', ref: 'e3', children: [{ role: 'textbox', name: 'City', ref: 'f2e1', text: 'Portland' }] },
  ] }]);
  const result = await module.snapshot(page);
  assert.equal(result.number, 1);
  assert.match(result.text, /untrusted/i);
  assert.match(result.text, /- main \[ref=e1\]:\n  - button "Next" \[disabled\] \[ref=e2\]/);
  assert.match(result.text, /textbox "City" \[ref=f2e1\]: "Portland"/);
  assert.ok(result.text.length < 400);
});

test('password and card values are removed from all output and subsequent diffs', async () => {
  const { page, set } = fixture([{ role: 'textbox', name: 'Password', ref: 'e1', text: 'fixture-secret' },
    { role: 'textbox', name: 'Account', ref: 'f2e2', text: '4111 1111 1111 1111' },
    { role: 'text', text: 'echo fixture-secret' }], ['fixture-secret', '4111 1111 1111 1111']);
  const first = await module.snapshot(page);
  assert.doesNotMatch(first.text, /fixture-secret|4111/);
  assert.match(first.text, /redacted/);
  set([{ role: 'textbox', name: 'Password', ref: 'e1', text: 'new-secret' }]);
  const next = await module.snapshot(page, { since: first.number });
  assert.doesNotMatch(next.text, /fixture-secret|new-secret|4111/);
});

test('a failed sensitive-value read refuses without exposing the upstream error', async () => {
  const { page } = fixture([{ role: 'text', text: 'fixture-secret' }]);
  page.frames = () => [{ evaluate: async () => { throw Error('fixture-secret'); } }];
  page.context = () => ({ newCDPSession: async () => ({ send: async () => { throw Error('fixture-secret'); }, detach: async () => {} }) });
  await assert.rejects(module.snapshot(page), error => !error.message.includes('fixture-secret'));
});

test('snapshot options reject malformed or unbounded requests', async () => {
  const { page } = fixture([]);
  for (const options of [{ maxChars: 999 }, { maxChars: 40001 }, { maxChars: NaN }, { find: [] }, { since: 0 }, { ref: 'css=body' }]) {
    await assert.rejects(module.snapshot(page, options), /Invalid snapshot/);
  }
});

test('ref-keyed diffs keep sibling reorders and changed parents visible', async () => {
  const a = { role: 'button', name: 'A', ref: 'e2' }, b = { role: 'button', name: 'B', ref: 'e3' };
  const { page, set } = fixture([{ role: 'main', ref: 'e1', children: [a, b] }]);
  const first = await module.snapshot(page);
  set([{ role: 'main', ref: 'e1', children: [b, { ...a, name: 'A changed' }] }]);
  const diff = await module.snapshot(page, { since: first.number });
  assert.match(diff.text, /Changes since snapshot 1/);
  assert.match(diff.text, /\+ .*button "B".*ref=e3/);
  assert.match(diff.text, /\+ .*button "A changed".*ref=e2/);
  assert.ok(diff.text.indexOf('"B"') < diff.text.indexOf('"A changed"'));
  set([{ role: 'group', ref: 'e4', children: [a] }]);
  const moved = await module.snapshot(page, { since: diff.number });
  assert.match(moved.text, /group \[ref=e4\]/);
  assert.match(moved.text, /Removed.*ref=e3/s);
});

test('unchanged diffs and page histories are isolated by page', async () => {
  const { page } = fixture([{ role: 'button', ref: 'e1', name: 'Keep' }]);
  const first = await module.snapshot(page);
  assert.match((await module.snapshot(page, { since: first.number })).text, /No visible changes/);
  const other = fixture([{ role: 'button', ref: 'e2', name: 'Other' }]).page;
  assert.match((await module.snapshot(other, { since: first.number })).text, /"Other"/);
});

test('find and ref reads include matching controls and their ancestors only', async () => {
  const { page } = fixture([{ role: 'main', ref: 'e1', children: [
    { role: 'group', name: 'Travel', ref: 'e2', children: [{ role: 'button', name: 'Norcrest', ref: 'e3' }] },
    { role: 'button', name: 'Elsewhere', ref: 'e4' },
  ] }]);
  const found = await module.snapshot(page, { find: 'norcrest' });
  assert.match(found.text, /main.*Travel.*Norcrest/s);
  assert.doesNotMatch(found.text, /Elsewhere/);
  const scoped = await module.snapshot(page, { ref: 'e2' });
  assert.match(scoped.text, /Travel.*Norcrest/s);
  assert.doesNotMatch(scoped.text, /Elsewhere/);
  await assert.rejects(module.snapshot(page, { ref: 'e999' }), /Snapshot unavailable/);
  assert.match((await module.snapshot(page, { find: 'missing' })).text, /No matching/);
});

test('a cut names a continuation ref that advances with ancestors and bounded output', async () => {
  const { page } = fixture([{ role: 'main', ref: 'e1', children: Array.from({ length: 70 }, (_, i) =>
    ({ role: 'button', ref: 'e' + (i + 2), name: 'Choice ' + i + ' x'.repeat(12) })) }]);
  let result = await module.snapshot(page, { maxChars: 1000 });
  const seen = new Set();
  for (let n = 0; ; n++) {
    assert.ok(n < 20, 'continuations must make progress');
    assert.ok(result.text.length <= 1000);
    assert.match(result.text, /main \[ref=e1\]/);
    for (const [, ref] of result.text.matchAll(/\[ref=(e\d+)\]/g)) seen.add(ref);
    const next = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
    if (!next) break;
    result = await module.snapshot(page, { ref: next, maxChars: 1000 });
  }
  assert.equal(seen.size, 71);
});

test('a cut baseline does not claim unseen rows unchanged in the next diff', async () => {
  const { page } = fixture(Array.from({ length: 60 }, (_, i) => ({ role: 'button', ref: 'e' + (i + 1), name: 'Option ' + i })));
  const first = await module.snapshot(page, { maxChars: 1000 });
  const diff = await module.snapshot(page, { since: first.number, maxChars: 40000 });
  assert.match(diff.text, /\+ - button "Option 59" \[ref=e60\]/);
});

test('navigation retires prior continuations and rejects mixed-document reads', async () => {
  const { page } = fixture(Array.from({ length: 100 }, (_, i) => ({ role: 'button', ref: 'e' + (i + 1), name: 'Option ' + i })));
  const first = await module.snapshot(page, { maxChars: 1000 });
  const ref = /Continue with ref="([^"]+)"/.exec(first.text)?.[1];
  assert.ok(ref);
  page.emit('framenavigated', page.mainFrame());
  await assert.rejects(module.snapshot(page, { ref }), /Snapshot unavailable/);
  page.ariaSnapshotJSON = async () => { page.emit('framenavigated', page.mainFrame()); return []; };
  await assert.rejects(module.snapshot(page), /Snapshot unavailable/);
});

test('a changed page invalidates a continuation instead of mixing old and new rows', async () => {
  const { page, set } = fixture(Array.from({ length: 60 }, (_, i) => ({ role: 'button', ref: 'e' + (i + 1), name: 'Option ' + i })));
  const first = await module.snapshot(page, { maxChars: 1000 });
  const ref = /Continue with ref="([^"]+)"/.exec(first.text)?.[1];
  set([{ role: 'button', ref: 'e1', name: 'Changed' }]);
  await assert.rejects(module.snapshot(page, { ref }), /Snapshot unavailable/);
});

test('long values cannot trap a continuation on a single oversized row', async () => {
  const { page } = fixture([{ role: 'text', text: 'long '.repeat(3000) }, { role: 'button', ref: 'e1', name: 'End' }]);
  const first = await module.snapshot(page, { maxChars: 1000 });
  assert.ok(first.text.length <= 1000);
  assert.match(first.text, /shortened/);
  const shortened = first.text.split('\n').find(line => line.includes('shortened'));
  assert.doesNotThrow(() => JSON.parse(shortened.slice(shortened.indexOf(':') + 1).trim()), 'a shortened YAML scalar must remain quoted');
  const ref = /Continue with ref="([^"]+)"/.exec(first.text)?.[1];
  assert.ok(ref);
  assert.match((await module.snapshot(page, { ref, maxChars: 1000 })).text, /"End"/);
});

function closedFixture({ emptyHostQuery = false } = {}) {
  const base = fixture([{ role: 'main', ref: 'e1' }]);
  let nodes = [{ nodeId: 'switch', backendDOMNodeId: 30, role: { value: 'switch' }, name: { value: 'Secure mode' },
    properties: [{ name: 'checked', value: { value: true } }] },
  { nodeId: 'password', backendDOMNodeId: 31, role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'closed-secret' } }];
  const root = { nodeType: 9, children: [{ nodeType: 1, backendNodeId: 20, localName: 'custom-control', shadowRoots: [
    { nodeType: 11, shadowRootType: 'closed', children: [
      { nodeType: 1, localName: 'button', backendNodeId: 30 },
      { nodeType: 1, localName: 'input', backendNodeId: 31, attributes: ['type', 'password'] },
    ] },
  ] }] };
  base.page.context = () => ({ newCDPSession: async () => ({
    send: async (method, params) => {
      if (method === 'DOM.getDocument') return { root };
      if (method === 'DOMSnapshot.captureSnapshot') return nativeSnapshot(['closed-secret']);
      if (method === 'Accessibility.queryAXTree') return { nodes: emptyHostQuery ? [] : structuredClone(nodes) };
      if (method === 'Accessibility.getPartialAXTree') return { nodes: structuredClone(nodes.filter(node => node.backendDOMNodeId === params.backendNodeId)) };
      if (method === 'DOM.resolveNode') return { object: { objectId: String(params.backendNodeId) } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: 'closed-secret' } };
      if (method === 'Runtime.releaseObject') return {};
      throw Error('unsupported CDP call: ' + method);
    }, detach: async () => {},
  }) });
  return { ...base, setClosed: value => { nodes = value; } };
}

test('closed-root controls get stable refs, flags and redacted values', async () => {
  const { page } = closedFixture();
  const first = await module.snapshot(page);
  assert.match(first.text, /switch "Secure mode" \[checked\] \[ref=s\d+\]/);
  assert.doesNotMatch(first.text, /closed-secret/);
  const ref = /switch.*\[ref=(s\d+)\]/.exec(first.text)[1];
  const binding = module.closedRefBinding(page, ref);
  assert.equal(binding.backendNodeId, 30);
  assert.equal(binding.frame, page.mainFrame());
  const second = await module.snapshot(page);
  assert.match(second.text, new RegExp('switch.*ref=' + ref));
  assert.match((await module.snapshot(page, { ref })).text, /Secure mode/);
});

test('an ignored closed-root host cannot hide its native actionable descendants', async () => {
  const { page } = closedFixture({ emptyHostQuery: true });
  const result = await module.snapshot(page);
  assert.match(result.text, /switch "Secure mode" \[checked\] \[ref=s\d+\]/);
  assert.doesNotMatch(result.text, /closed-secret/);
});

test('closed refs disappear on node removal and are never reused after navigation', async () => {
  const { page, setClosed } = closedFixture();
  const first = await module.snapshot(page);
  const ref = /switch.*\[ref=(s\d+)\]/.exec(first.text)?.[1];
  assert.ok(ref);
  setClosed([]);
  await module.snapshot(page);
  assert.throws(() => module.closedRefBinding(page, ref), /stale/i);
  page.emit('framenavigated', page.mainFrame());
  assert.throws(() => module.closedRefBinding(page, ref), /stale/i);
});

test('failure to scan closed roots fails closed and detaches its owned CDP session', async () => {
  const { page } = fixture([]);
  let detached = false;
  page.context = () => ({ newCDPSession: async () => ({
    send: async () => { throw Error('closed-secret'); }, detach: async () => { detached = true; },
  }) });
  await assert.rejects(module.snapshot(page), error => !error.message.includes('closed-secret'));
  assert.equal(detached, true);
});

test('same-process child frames use the parent CDP tree for closed controls', async () => {
  const { page } = closedFixture();
  const child = { evaluate: async () => [] };
  const context = page.context();
  page.frames = () => [page.mainFrame(), child];
  page.context = () => ({ newCDPSession: frame => {
    if (frame === child) throw Error("This frame does not have a separate CDP session, it is a part of the parent frame's session");
    return context.newCDPSession(frame);
  } });
  const result = await module.snapshot(page);
  assert.match(result.text, /Secure mode/);
});

test('redaction also covers a protected value that changed immediately after the snapshot', async () => {
  const { page } = fixture([{ role: 'textbox', name: 'Account', ref: 'e1', text: 'old-secret' }]);
  let value = 'old-secret';
  const context = page.context();
  page.context = () => ({ newCDPSession: async frame => {
    const session = await context.newCDPSession(frame), send = session.send;
    session.send = (method, params) => method === 'DOMSnapshot.captureSnapshot' ? nativeSnapshot([value]) : send(method, params);
    return session;
  } });
  page.frames = () => [{ evaluate: async () => [value] }];
  page.ariaSnapshotJSON = async () => { value = 'new-secret'; return [{ role: 'textbox', name: 'Account', ref: 'e1', text: 'old-secret' }]; };
  assert.doesNotMatch((await module.snapshot(page)).text, /old-secret|new-secret/);
});

test('page-overridden getters cannot hide the native protected value from redaction', async () => {
  const { page } = fixture([{ role: 'text', text: 'echo native-password' }], ['native-password']);
  page.mainFrame().evaluate = async () => ['page-decoy'];
  assert.doesNotMatch((await module.snapshot(page)).text, /native-password/);
});

test('card expiry values are masked even without autocomplete or a password type', async () => {
  const { page } = fixture([{ role: 'textbox', name: 'Expiry', ref: 'e1', text: '08/30' },
    { role: 'text', text: 'echo 08/30' }]);
  const context = page.context();
  page.context = () => ({ newCDPSession: async frame => {
    const session = await context.newCDPSession(frame), send = session.send;
    session.send = (method, params) => {
      if (method !== 'DOMSnapshot.captureSnapshot') return send(method, params);
      const data = nativeSnapshot(['08/30']);
      data.strings[4] = 'text'; data.strings.push('name', 'expiry');
      data.documents[0].nodes.attributes[1].push(9, 10);
      return data;
    };
    return session;
  } });
  assert.doesNotMatch((await module.snapshot(page)).text, /08\/30/);
});

test('deep continuation context always leaves space to advance to the next row', async () => {
  let tree = [{ role: 'button', name: 'Target', ref: 'e99' }];
  for (let n = 50; n >= 1; n--) tree = [{ role: 'group', ref: 'e' + n, name: 'Ancestor ' + n, children: tree }];
  const { page } = fixture(tree);
  let result = await module.snapshot(page, { maxChars: 1000 });
  for (let n = 0; !result.text.includes('"Target"'); n++) {
    assert.ok(n < 60, 'deep continuations must advance');
    assert.ok(result.text.length <= 1000);
    const ref = /Continue with ref="([^"]+)"/.exec(result.text)?.[1];
    assert.ok(ref);
    result = await module.snapshot(page, { ref, maxChars: 1000 });
  }
});
