import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAXProbe, compareAXPairs } from '../ax-probe.mjs';

const identity = { session: 's1', generation: 1, pid: 42, processStart: 100, window: 'w1', scope: 'region1' };
const request = { operation: 'exists', role: 'AXCheckBox', name: 'Ready' };
function fixture() {
  let time = 0;
  const calls = [];
  const root = { role: 'AXWindow', name: 'Fixture', children: [] };
  const checkbox = { role: 'AXCheckBox', name: 'Ready', value: false, children: [] };
  root.children.push(checkbox);
  const ticket = { ...identity, expiresAt: 1000, operations: ['metadata', 'state', 'exists'], fields: ['title', 'minimized', 'role', 'name', 'checked'] };
  const policy = {
    async inspect() { calls.push('policy'); return { ...ticket, approved: true, forbidden: false, settings: false, revoked: false }; },
    async classify() { return 'metadata'; },
    // Synthetic coherent host decision. This hook has no supported live adapter.
    fence(current, query, pairs) {
      assert.equal(current.session, ticket.session); assert.ok(pairs.length > 0);
      return { ...ticket, approved: true, forbidden: false, settings: false, revoked: false, classification: 'metadata' };
    },
  };
  const methods = {
    async isProcessTrusted() { return true; },
    async identity() { return { ...identity }; },
    async resolveWindow() { return { element: root, matches: 1 }; },
    async setMessagingTimeout(node, seconds) { calls.push(['timeout', node, seconds]); return { status: 'ok' }; },
    async copyMultipleAttributeValues(node, attrs) {
      calls.push(['attributes', attrs]);
      return Object.fromEntries(attrs.map(attr => [attr, node.unsupported?.includes(attr)
        ? { status: 'unsupported' } : { status: node[attr] === undefined ? 'missing' : 'ok', value: node[attr] }]));
    },
    async getAttributeValueCount(node) { return { status: 'ok', count: node.children.length }; },
    async copyAttributeValues(node, start, count) { calls.push(['children', start, count]); return { status: 'ok', values: node.children.slice(start, start + count) }; },
  };
  const ax = new Proxy(methods, { get(target, key) { if (!(key in target)) throw new Error('Unavailable AX method: ' + String(key)); return target[key]; } });
  const probe = createAXProbe({ ax, policy, now: () => time });
  return { probe, ax, policy, methods, calls, root, checkbox, ticket, advance: ms => { time += ms; } };
}
const run = (f, query = request) => f.probe.read(f.ticket, query);

test('closed probe refuses missing effective policy without AX access', async () => {
  const probe = createAXProbe({ ax: new Proxy({}, { get() { throw new Error('AX must not run'); } }) });
  assert.equal((await probe.read(fixture().ticket, request)).code, 'POLICY_UNAVAILABLE');
  assert.deepEqual(Object.keys(probe), ['read']);
});
test('policy parity: approval, forbidden/settings, revocation, generation, expiry and session fail closed', async () => {
  for (const [patch, code] of [
    [{ approved: false }, 'DENIED'], [{ forbidden: true }, 'FORBIDDEN'], [{ settings: true }, 'FORBIDDEN'],
    [{ revoked: true }, 'DENIED'], [{ generation: 2 }, 'DENIED'], [{ expiresAt: 0 }, 'DENIED'], [{ session: 'other' }, 'DENIED'],
    [{ fields: ['title'] }, 'DENIED'], [{ operations: ['metadata'] }, 'DENIED'],
  ]) {
    const f = fixture();
    const ordinary = await f.policy.inspect();
    f.policy.inspect = async () => ({ ...ordinary, ...patch });
    assert.equal((await run(f)).code, code);
    assert.equal(f.calls.filter(Array.isArray).length, 0);
  }
});
test('trust denial never traverses and cannot prompt', async () => {
  const f = fixture(); f.methods.isProcessTrusted = async () => false;
  assert.equal((await run(f)).code, 'AX_DENIED');
  assert.equal(f.calls.filter(Array.isArray).length, 0);
});
test('supported checked false differs from missing and unsupported', async () => {
  const f = fixture();
  assert.deepEqual((await run(f, { ...request, operation: 'state' })).value, false);
  delete f.checkbox.value;
  assert.equal((await run(f, { ...request, operation: 'state' })).status, 'unknown');
  f.checkbox.unsupported = ['value'];
  assert.equal((await run(f, { ...request, operation: 'state' })).status, 'unsupported');
});
test('exact scoped metadata has no engine target or guard authority', async () => {
  const f = fixture(); f.root.title = 'Fixture'; f.root.minimized = false;
  const result = await run(f, { operation: 'metadata' });
  assert.deepEqual(result.value, { title: 'Fixture', minimized: false });
  assert.equal(result.source, 'direct-ax'); assert.equal(result.actionEvidence, false);
  assert.equal(result.engineNumber, undefined);
});
test('absence only follows a complete scoped traversal; duplicate targets refuse scalar', async () => {
  const f = fixture();
  assert.equal((await run(f)).value, true);
  assert.equal((await run(f, { ...request, name: 'Missing' })).value, false);
  f.root.children.push({ ...f.checkbox });
  assert.equal((await run(f, { ...request, operation: 'state' })).code, 'TARGET_AMBIGUOUS');
});
test('cyclic and deep trees, node cap and short slices never establish absence', async () => {
  for (const shape of ['cycle', 'deep', 'wide', 'short']) {
    const f = fixture();
    if (shape === 'cycle') f.checkbox.children = [f.root];
    if (shape === 'deep') { let n = f.root; for (let i = 0; i < 10; i++) { const child = { role: 'AXGroup', name: '', children: [] }; n.children = [child]; n = child; } }
    if (shape === 'wide') f.root.children = Array.from({ length: 130 }, () => ({ role: 'AXGroup', name: '', children: [] }));
    if (shape === 'short') f.methods.copyAttributeValues = async () => ({ status: 'ok', values: [] });
    const result = await run(f, { ...request, name: 'Missing' });
    assert.equal(result.status, 'incomplete', shape); assert.equal(result.value, undefined);
    assert.ok(f.calls.filter(x => Array.isArray(x) && x[0] === 'children').every(x => x[2] <= 32));
  }
});
test('PID reuse, window replacement, unknown identity and duplicate windows suppress all delivery', async () => {
  for (const patch of [{ processStart: 101 }, { window: 'w2' }, { pid: 43 }, { scope: 'other' }, { window: undefined }]) {
    const f = fixture(); f.methods.identity = async () => ({ ...identity, ...patch });
    assert.equal((await run(f)).code, 'IDENTITY_CHANGED');
  }
  const f = fixture(); f.methods.resolveWindow = async () => ({ element: f.root, matches: 2 });
  assert.equal((await run(f)).code, 'TARGET_AMBIGUOUS');
});
test('revocation and identity replacement during capture suppress pending result', async () => {
  for (const mode of ['revoke', 'replace']) {
    const f = fixture(); const original = f.methods.copyMultipleAttributeValues;
    f.methods.copyMultipleAttributeValues = async (...args) => {
      const result = await original(...args);
      if (mode === 'revoke') f.policy.inspect = async () => ({ ...identity, revoked: true });
      else f.methods.identity = async () => ({ ...identity, window: 'replaced' });
      return result;
    };
    const result = await run(f); assert.equal(result.value, undefined);
    assert.equal(result.status, 'denied');
  }
});
test('revocation during the final identity check still suppresses delivery', async () => {
  const f = fixture(); f.root.title = 'Fixture'; f.root.minimized = false; let checks = 0;
  f.methods.identity = async () => {
    if (++checks === 3) f.policy.inspect = async () => ({ ...f.ticket, revoked: true });
    return { ...identity };
  };
  const result = await run(f, { operation: 'metadata' });
  assert.equal(result.code, 'DENIED'); assert.equal(result.value, undefined);
});
test('protected and unknown-sensitive nodes are redacted before attributes, errors or output', async () => {
  for (const classification of ['protected', 'unknown']) {
    const f = fixture(); const secret = 'seeded-private-value'; f.checkbox.name = secret; f.checkbox.value = secret;
    f.policy.classify = async node => node === f.checkbox ? classification : 'metadata';
    const result = await run(f, { ...request, name: secret });
    assert.equal(result.status, 'incomplete'); assert.equal(result.value, undefined);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(f.calls.filter(x => Array.isArray(x) && x[0] === 'attributes').length, 1);
  }
  const f = fixture(); f.methods.copyMultipleAttributeValues = async () => { throw new Error('seeded-private-value'); };
  assert.ok(!JSON.stringify(await run(f)).includes('seeded-private-value'));
});
test('every object gets at most 100ms messaging timeout and one total 500ms budget includes policy', async () => {
  const f = fixture(); f.policy.inspect = async () => { f.advance(80); return { ...f.ticket, approved: true, forbidden: false, settings: false, revoked: false }; };
  const result = await run(f);
  assert.equal(result.code, 'AX_TIMEOUT'); assert.equal(result.value, undefined);
  assert.ok(f.calls.filter(x => Array.isArray(x) && x[0] === 'timeout').every(x => x[2] > 0 && x[2] <= 0.1));
  const stalled = fixture(); stalled.methods.copyMultipleAttributeValues = () => new Promise(() => {});
  const start = performance.now(); assert.equal((await run(stalled)).code, 'AX_TIMEOUT');
  assert.ok(performance.now() - start < 500);
});
test('closed request grammar refuses input, unsupported state, broader fields and expired tickets', async () => {
  for (const query of [{ operation: 'click' }, { ...request, operation: 'state', attribute: 'text' }, { ...request, code: 'anything' }]) {
    assert.equal((await run(fixture(), query)).code, 'INVALID_REQUEST');
  }
  const f = fixture(); f.ticket.expiresAt = 0; assert.equal((await run(f)).code, 'DENIED');
  const other = fixture(); other.ticket.fields = ['title']; assert.equal((await run(other)).code, 'DENIED');
});
test('bounded output and capability source contain no actuator or permission-request APIs', async () => {
  const f = fixture(); f.root.title = '😀'.repeat(5000); f.root.minimized = false;
  const result = await run(f, { operation: 'metadata' });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096); assert.equal(result.status, 'incomplete');
  for (const file of ['ax-read.js', 'ax-probe.mjs']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /AXPerformAction|AXUIElementSetAttribute|CGEvent|AXIsProcessTrustedWithOptions|osascript|child_process|clipboard|\.activate\(|\.raise\(/);
  }
});
test('timed-out adapter work keeps ownership until it actually completes', async () => {
  const f = fixture(); let finish;
  f.methods.copyMultipleAttributeValues = () => new Promise(resolve => { finish = resolve; });
  assert.equal((await run(f)).code, 'AX_TIMEOUT');
  assert.equal((await run(f)).code, 'AX_PENDING');
  finish({}); await new Promise(setImmediate);
  f.methods.copyMultipleAttributeValues = async () => ({ role: { status: 'unsupported' }, name: { status: 'unsupported' } });
  assert.equal((await run(f)).status, 'incomplete');
});
test('native denied, timeout and invalid-reference responses keep distinct sanitized codes', async () => {
  for (const [status, code] of [['denied', 'AX_DENIED'], ['timeout', 'AX_TIMEOUT'], ['invalid-reference', 'AX_INVALID_REFERENCE']]) {
    const f = fixture(); f.methods.copyMultipleAttributeValues = async () => ({ role: { status } });
    assert.equal((await run(f)).code, code);
  }
});
test('paired collector balances order, counts every unknown/disagreement and records no values', async () => {
  let time = 0, directCount = 0; const order = [];
  const receipt = value => ({ status: 'ok', value, settled: true });
  const ordinary = async () => { order.push('engine'); time += 240; return receipt(false); };
  const direct = async () => { order.push('direct'); time += 100; directCount++;
    return directCount === 1 ? { status: 'unknown', value: 'seeded-private-value' }
      : receipt(directCount === 2); };
  const report = await compareAXPairs({ ordinary, direct, now: () => time });
  assert.equal(report.pairs.length, 30); assert.equal(report.unknown, 1); assert.equal(report.disagreements, 1);
  assert.equal(report.qualified, false); assert.equal(report.medianSavingMs, 140);
  assert.deepEqual(order.slice(0, 4), ['engine', 'direct', 'direct', 'engine']);
  assert.ok(!JSON.stringify(report).includes('seeded-private-value'));
  const unsettled = await compareAXPairs({ ordinary: async () => receipt(false), direct: async () => ({ status: 'ok', value: false }) });
  assert.equal(unsettled.unknown, 30); assert.equal(unsettled.qualified, false);
});

for (const phase of ['dispatch', 'delivery']) for (const classification of ['protected', 'unknown']) {
  test(`${classification} metadata at ${phase} is suppressed after classification changes`, async () => {
    const f = fixture(); f.root.title = 'seeded-private-title'; f.root.minimized = false;
    let sensitive = false, reads = 0, checks = 0;
    f.policy.classify = async (node, fields) => {
      assert.equal(node, f.root); assert.deepEqual(fields, ['title', 'minimized']);
      return sensitive ? classification : 'metadata';
    };
    const timeout = f.methods.setMessagingTimeout;
    f.methods.setMessagingTimeout = async (...args) => {
      if (phase === 'dispatch') sensitive = true;
      return timeout(...args);
    };
    f.methods.identity = async () => {
      if (phase === 'delivery' && ++checks === 3) sensitive = true;
      return { ...identity };
    };
    const attributes = f.methods.copyMultipleAttributeValues;
    f.methods.copyMultipleAttributeValues = async (...args) => { reads++; return attributes(...args); };
    const result = await run(f, { operation: 'metadata' });
    assert.notEqual(result.status, 'ok'); assert.equal(result.value, undefined);
    assert.ok(!JSON.stringify(result).includes('seeded-private-title'));
    assert.equal(reads, phase === 'dispatch' ? 0 : 1);
  });
}
test('field revalidation cost is included before delivering a result', async () => {
  const f = fixture(); f.root.title = 'Fixture'; f.root.minimized = false;
  f.policy.classify = async () => { f.advance(180); return 'metadata'; };
  const result = await run(f, { operation: 'metadata' });
  assert.equal(result.code, 'AX_TIMEOUT'); assert.equal(result.value, undefined);
});
for (const phase of ['dispatch', 'delivery']) test(`app revocation during ${phase} field revalidation suppresses capture or delivery`, async () => {
  const f = fixture(); f.root.title = 'Fixture'; f.root.minimized = false;
  let classifications = 0, reads = 0;
  f.policy.classify = async () => {
    if (++classifications === (phase === 'dispatch' ? 2 : 3)) {
      f.policy.inspect = async () => ({ ...f.ticket, revoked: true });
    }
    return 'metadata';
  };
  const attributes = f.methods.copyMultipleAttributeValues;
  f.methods.copyMultipleAttributeValues = async (...args) => { reads++; return attributes(...args); };
  const result = await run(f, { operation: 'metadata' });
  assert.equal(result.code, 'DENIED'); assert.equal(result.value, undefined);
  assert.equal(reads, phase === 'dispatch' ? 0 : 1);
});

test('missing synchronous host policy fence refuses before native access', async () => {
  const f = fixture(); delete f.policy.fence;
  const result = await run(f, { operation: 'metadata' });
  assert.equal(result.code, 'POLICY_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

for (const phase of ['dispatch', 'delivery']) for (const classification of ['protected', 'unknown']) {
  test(`${classification} fields changed during final ${phase} policy await are fenced`, async () => {
    const f = fixture(); f.root.title = 'seeded-private-title'; f.root.minimized = false;
    let sensitive = false, classifications = 0, atRead = 0, reads = 0;
    f.policy.classify = async () => { classifications++; return sensitive ? classification : 'metadata'; };
    f.policy.inspect = async () => {
      if (phase === 'dispatch' ? classifications >= 2 : reads > 0 && classifications > atRead) sensitive = true;
      return { ...f.ticket, approved: true, forbidden: false, settings: false, revoked: false };
    };
    f.policy.fence = (ticket, request, pairs) => {
      assert.ok(pairs.every(pair => pair.node === f.root && pair.fields.join(',') === 'title,minimized'));
      return { ...f.ticket, approved: true, forbidden: false, settings: false, revoked: false,
        classification: sensitive ? classification : 'metadata' };
    };
    const attributes = f.methods.copyMultipleAttributeValues;
    f.methods.copyMultipleAttributeValues = async (...args) => { atRead = classifications; reads++; return attributes(...args); };
    const result = await run(f, { operation: 'metadata' });
    assert.equal(result.code, 'PROTECTED'); assert.equal(result.value, undefined);
    assert.ok(!JSON.stringify(result).includes('seeded-private-title'));
    assert.equal(reads, phase === 'dispatch' ? 0 : 1);
  });
}

test('the dispatch callback applies the combined fence after the native scheduling gap', async () => {
  const f = fixture(); f.root.title = 'Fixture'; f.root.minimized = false;
  let revoked = false; const reads = [];
  f.policy.inspect = async () => ({ ...f.ticket, approved: true, forbidden: false, settings: false, revoked });
  f.policy.fence = () => {
    // Model a revocation delivered in the next microtask after this current snapshot.
    queueMicrotask(() => { revoked = true; });
    return { ...f.ticket, approved: true, forbidden: false, settings: false, revoked, classification: 'metadata' };
  };
  const attributes = f.methods.copyMultipleAttributeValues;
  f.methods.copyMultipleAttributeValues = async (...args) => { reads.push(revoked); return attributes(...args); };
  const result = await run(f, { operation: 'metadata' });
  assert.deepEqual(reads, [false], 'dispatch must share the current fence callback before queued revocation');
  assert.equal(result.code, 'DENIED'); assert.equal(result.value, undefined);
});

test('delivery fences every captured field together and charges synchronous fence cost', async () => {
  const f = fixture(); const pairsSeen = [];
  f.policy.fence = (ticket, query, pairs) => {
    pairsSeen.push(pairs);
    if (pairs.length > 1) return { ...f.ticket, approved: true, forbidden: false, settings: false, revoked: false,
      classification: 'unknown' };
    return { ...f.ticket, approved: true, forbidden: false, settings: false, revoked: false, classification: 'metadata' };
  };
  const result = await run(f, { ...request, operation: 'state' });
  assert.equal(result.code, 'PROTECTED'); assert.equal(result.value, undefined);
  assert.ok(pairsSeen.some(pairs => pairs.some(pair => pair.node === f.root)
    && pairs.some(pair => pair.node === f.checkbox && pair.fields.includes('checked'))));
  const costly = fixture(); costly.policy.fence = () => {
    costly.advance(501);
    return { ...costly.ticket, approved: true, forbidden: false, settings: false, revoked: false, classification: 'metadata' };
  };
  assert.equal((await run(costly)).code, 'AX_TIMEOUT');
  assert.equal(costly.calls.some(call => Array.isArray(call) && call[0] === 'attributes'), false);
});

test('an asynchronous fence cannot authorize a read and keeps its work owned', async () => {
  const f = fixture(); let finish;
  f.policy.fence = () => new Promise(resolve => { finish = resolve; });
  assert.equal((await run(f)).code, 'POLICY_UNAVAILABLE');
  assert.equal((await run(f)).code, 'AX_PENDING');
  finish({}); await new Promise(setImmediate);
});

test('combined fence requires the current exact app decision and identity, not field approval alone', async () => {
  for (const patch of [{ approved: false }, { revoked: true }, { forbidden: true }, { settings: true },
    { generation: 2 }, { session: 'other' }, { pid: 43 }, { processStart: 101 }, { window: 'other' },
    { scope: 'other' }, { expiresAt: 0 }, { fields: [] }, { operations: [] }]) {
    const f = fixture(); let reads = 0;
    f.policy.fence = () => ({ ...f.ticket, approved: true, revoked: false, forbidden: false, settings: false,
      classification: 'metadata', ...patch });
    f.methods.copyMultipleAttributeValues = async () => { reads++; throw Error('must not read'); };
    const result = await run(f);
    assert.equal(result.status, 'denied'); assert.equal(result.value, undefined); assert.equal(reads, 0);
  }
});

test('combined fence exceptions stay private and cannot dispatch a native read', async () => {
  const f = fixture(); f.policy.fence = () => { throw Error('seeded-private-title'); };
  const result = await run(f);
  assert.equal(result.code, 'AX_UNKNOWN'); assert.equal(result.value, undefined);
  assert.ok(!JSON.stringify(result).includes('seeded-private-title'));
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'attributes'), false);
});
