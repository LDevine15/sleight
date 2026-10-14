import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { fixedWorldInspectors } from './fixtures/direct-browser-p2-worlds.mjs';

const lease = { target: 'target', cdpSessionId: 'page-session', frame: 'frame',
  origin: 'https://fixture.invalid', document: 1, epoch: 1, executionContextId: 7 };
const world = { frameId: lease.frame, worldName: 'sleight-state', grantUniveralAccess: false };
const inspector = fixedWorldInspectors['world-state'];
const call = objectId => ({ objectId, functionDeclaration: inspector.source,
  arguments: [{ value: 'checked' }, { value: 'native' }], returnByValue: true, awaitPromise: false });
function fixture(t, options = {}) {
  const calls = [], listeners = new Map(); let live = true;
  const replies = {
    'Page.createIsolatedWorld': { executionContextId: 9 },
    'DOM.resolveNode': { object: { objectId: 'node-object' } },
    'Runtime.callFunctionOn': { result: { value: { state: 'value', value: true } } },
    'Accessibility.getPartialAXTree': { nodes: [{ nodeId: 'ax', backendDOMNodeId: 42 }] },
    'DOM.getDocument': { root: { backendNodeId: 1, nodeType: 9, children: [{ backendNodeId: 42, nodeType: 1 }] } },
    'DOM.describeNode': { node: { backendNodeId: 42, nodeType: 1 } },
  };
  const session = new Proxy({ sessionId: 'root',
    async send(method, params, route) {
      assert.ok(Object.hasOwn(replies, method) || ['Runtime.releaseObject', 'DOM.scrollIntoViewIfNeeded',
        'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText'].includes(method), 'unsupported fake method ' + method);
      calls.push({ method, params, route });
      return options.send ? options.send(method, params, route, replies) : replies[method] ?? {};
    }, on(event, fn) { listeners.set(event, fn); }, off(event) { listeners.delete(event); } },
  { get(object, key) { if (key in object || typeof key === 'symbol' || key === 'then') return object[key]; throw Error('unsupported fake member ' + key); } });
  const adapter = createScopedAdapter({ session, checkLease: () => live, helpers: fixedWorldInspectors,
    nodeBinding: id => [1, 42].includes(id) ? { ...lease, backendNodeId: id } : null,
    contextBinding: id => id === 7 ? { ...lease, executionContextId: id, world: 'main' } : null,
    ...options });
  t.after(() => adapter.disconnect());
  return { adapter, view: adapter.forLease(lease), calls, revoke() { live = false; },
    emit(method, params = {}) { listeners.get('event')?.({ sessionId: lease.cdpSessionId, method, params }); } };
}
async function resolve(f) {
  await f.view.send('Page.createIsolatedWorld', world);
  return (await f.view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 })).object.objectId;
}
test('P2 native world inspector joins a leased node and releases its object', async t => {
  const f = fixture(t), objectId = await resolve(f);
  assert.deepEqual((await f.view.send('Runtime.callFunctionOn', call(objectId))).result.value, { state: 'value', value: true });
  await f.view.send('Runtime.releaseObject', { objectId });
  assert.ok(f.calls.every(c => c.route === lease.cdpSessionId));
  await assert.rejects(f.view.send('Runtime.callFunctionOn', call(objectId)), /OBJECT_LOST/);
});
test('the four P2 semantic preparation refusals become closed passes', async t => {
  const f = fixture(t); await resolve(f);
  await f.view.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: 42 });
  assert.equal((await f.view.send('Accessibility.getPartialAXTree', { backendNodeId: 42, fetchRelatives: false })).nodes.length, 1);
  assert.equal(f.calls.length, 4);
});
test('MAIN inspection requires trusted frame/document/world evidence', async t => {
  const f = fixture(t);
  const { object } = await f.view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 7 });
  await f.view.send('Runtime.callFunctionOn', { ...call(object.objectId), arguments: [{ value: 'checked' }, { value: 'page' }] });
  const missing = fixture(t, { contextBinding: undefined });
  await assert.rejects(missing.view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 7 }), /WORLD_LOST/);
  assert.equal(missing.calls.length, 0);
});
test('parameterized DOM reads are shallow and scoped', async t => {
  const f = fixture(t);
  await f.view.send('DOM.getDocument', { depth: 1, pierce: false });
  await f.view.send('DOM.describeNode', { backendNodeId: 42, depth: 1, pierce: false });
  assert.equal(f.calls.length, 2);
});
test('mouse buttons and closed keyboard/text shapes enter the actuator', async t => {
  const f = fixture(t);
  for (const [method, params] of [
    ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 3, button: 'left', buttons: 1, clickCount: 1 }],
    ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 3, button: 'left', buttons: 0, clickCount: 1 }],
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0 }],
    ['Input.insertText', { text: 'fixture' }],
  ]) await f.view.input(method, params);
  assert.equal(f.calls.length, 4);
});
for (const [method, params] of [
  ['Page.createIsolatedWorld', { ...world, frameId: 'foreign' }],
  ['Page.createIsolatedWorld', { ...world, grantUniveralAccess: true }],
  ['Page.createIsolatedWorld', { ...world, worldName: 'model-world' }],
  ['DOM.resolveNode', { backendNodeId: 43, executionContextId: 9 }],
  ['DOM.resolveNode', { backendNodeId: 42, executionContextId: 123 }],
  ['DOM.scrollIntoViewIfNeeded', { backendNodeId: 43 }],
  ['Accessibility.getPartialAXTree', { backendNodeId: 42, fetchRelatives: true }],
  ['Accessibility.queryAXTree', { backendNodeId: 42 }],
  ['Accessibility.getFullAXTree', {}],
  ['DOM.getDocument', { depth: -1, pierce: true }],
  ['DOM.describeNode', { backendNodeId: 42, depth: 1, pierce: true }],
  ['Runtime.evaluate', { expression: 'document.title' }],
  ['Runtime.callFunctionOn', call('foreign-object')],
  ['Runtime.releaseObject', { objectId: 'foreign-object' }],
  ['Input.insertText', { text: 'direct send' }],
]) test(`outside the closed host set refuses ${method} ${JSON.stringify(params).slice(0, 100)}`, async t => {
  const f = fixture(t); await resolve(f); f.calls.length = 0;
  await assert.rejects(f.view.send(method, params), /SCOPED_COMMAND_DENIED|FOREIGN_|WORLD_LOST|OBJECT_LOST/);
  assert.equal(f.calls.length, 0);
});
for (const change of [
  { functionDeclaration: 'function(){return document.cookie}' },
  { arguments: [{ value: 'cookie' }, { value: 'native' }] },
  { arguments: [{ objectId: 'foreign' }, { value: 'native' }] },
  { awaitPromise: true }, { returnByValue: false }, { executionContextId: 123 },
]) test(`fixed inspectors refuse unregistered source or arguments ${JSON.stringify(change)}`, async t => {
  const f = fixture(t), objectId = await resolve(f); f.calls.length = 0;
  await assert.rejects(f.view.send('Runtime.callFunctionOn', { ...call(objectId), ...change }), /FIXED_HELPER_REQUIRED|SCOPED_COMMAND_DENIED/);
  assert.equal(f.calls.length, 0);
});
for (const key of ['target', 'cdpSessionId', 'frame', 'document', 'epoch', 'origin'])
  test(`node binding from another ${key} refuses before transport`, async t => {
    const f = fixture(t, { nodeBinding: id => ({ ...lease, backendNodeId: id, [key]: key === 'document' || key === 'epoch' ? 2 : 'foreign' }) });
    await f.view.send('Page.createIsolatedWorld', world); f.calls.length = 0;
    await assert.rejects(f.view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 }), /FOREIGN_NODE/);
    assert.equal(f.calls.length, 0);
  });
for (const method of ['DOM.documentUpdated', 'Runtime.executionContextsCleared', 'Page.frameNavigated', 'Page.frameDetached'])
  test(`${method} retires world/object handles and rejects a late resolve`, async t => {
    let f;
    f = fixture(t, { async send(command, params, route, replies) {
      if (command === 'DOM.resolveNode') f.emit(method, { frameId: lease.frame, frame: { id: lease.frame } });
      return replies[command] ?? {};
    } });
    await f.view.send('Page.createIsolatedWorld', world);
    await assert.rejects(f.view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 }), /LEASE_LOST|WORLD_LOST/);
    assert.equal(f.calls.some(c => c.method === 'Runtime.callFunctionOn'), false);
  });
test('a destroyed world cannot be reused but an unrelated context remains untouched', async t => {
  const f = fixture(t); await resolve(f);
  f.emit('Runtime.executionContextDestroyed', { executionContextId: 123 });
  await f.view.send('Runtime.callFunctionOn', call('node-object'));
  f.emit('Runtime.executionContextDestroyed', { executionContextId: 9 }); f.calls.length = 0;
  await assert.rejects(f.view.send('Runtime.callFunctionOn', call('node-object')), /OBJECT_LOST|WORLD_LOST/);
  assert.equal(f.calls.length, 0);
});
test('a fixed helper needs its exact hash, closed parameters, and the byte ceiling', async t => {
  const f = fixture(t, { helpers: { changed: { ...inspector, sha256: '0'.repeat(64) },
    large: { version: 1, source: 'x'.repeat(65537), sha256: createHash('sha256').update('x'.repeat(65537)).digest('hex'), parameters: [] } } });
  for (const name of ['changed', 'large']) await assert.rejects(f.view.callFixed(name, []), /FIXED_HELPER_REQUIRED/);
  assert.equal(f.calls.length, 0);
});
test('bounded ARIA refuses excess nodes instead of publishing an unbounded result', async t => {
  const f = fixture(t, { send: () => ({ nodes: Array.from({ length: 2049 }, (_, i) => ({ nodeId: String(i) })) }) });
  await assert.rejects(f.view.send('Accessibility.getPartialAXTree', { backendNodeId: 42, fetchRelatives: false }), /READ_BUDGET/);
});
test('scoped views never share a resolved remote object', async t => {
  const f = fixture(t); await resolve(f); f.calls.length = 0;
  const other = f.adapter.forLease(lease);
  await assert.rejects(other.send('Runtime.callFunctionOn', call('node-object')), /OBJECT_LOST/);
  assert.equal(f.calls.length, 0);
});
test('lease loss immediately before every physical command refuses it', async t => {
  const f = fixture(t); await resolve(f); f.revoke(); f.calls.length = 0;
  await assert.rejects(f.view.send('Runtime.callFunctionOn', call('node-object')), /LEASE_LOST/);
  await assert.rejects(f.view.input('Input.insertText', { text: 'fixture' }), /LEASE_LOST/);
  assert.equal(f.calls.length, 0);
});
test('the pinned Playwright module alone can exceed the fixed helper byte ceiling', async t => {
  const path = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/lib/coreBundle.js');
  if (!existsSync(path)) return t.skip('pinned Playwright 1.64.0 source cache unavailable');
  const bundle = readFileSync(path, 'utf8');
  if (createHash('sha256').update(bundle).digest('hex') !== '2325ca4c1c83070e89dc49fb82525508f0a68e0cf12e2a624277968da216b7e0')
    return t.skip('pinned Playwright 1.64.0 source cache differs');
  // Decode a static JS string only. No package import, browser or page execution.
  const literal = bundle.match(/source5 = ('(?:\\.|[^'\\])*');/)[1];
  const source = runInNewContext(literal, Object.create(null), { timeout: 100 });
  const sha256 = createHash('sha256').update(source).digest('hex');
  assert.equal(Buffer.byteLength(source), 328349);
  assert.equal(sha256, '852e40f938e72e6129b6c9a8bde3f4cc6cfe5cecb5ac734b6b06c8ad1fde42bf');
  const f = fixture(t, { helpers: { playwright: { version: 1, source, sha256, parameters: [] } },
    send(method) { return method === 'Page.createIsolatedWorld' ? { executionContextId: 9 } : { result: { objectId: 'constructor' } }; } });
  await f.view.send('Page.createIsolatedWorld', world);
  assert.deepEqual(await f.view.installFixed('playwright', 9), { objectId: 'constructor' });
  assert.equal(f.calls[1].params.returnByValue, false);
  assert.equal(f.calls[1].params.executionContextId, 9);
  assert.ok(f.calls[1].params.functionDeclaration.includes(source));
  await f.view.send('Runtime.releaseObject', { objectId: 'constructor' });
  await assert.rejects(f.view.installFixed('playwright', 7), /FIXED_HELPER_REQUIRED/);
  const changed = source + ' ';
  const bad = fixture(t, { helpers: { playwright: { version: 1, source: changed,
    sha256: createHash('sha256').update(changed).digest('hex'), parameters: [] } } });
  await assert.rejects(bad.view.installFixed('playwright', 9), /FIXED_HELPER_REQUIRED/);
  assert.equal(bad.calls.length, 0);
});
test('fixed parameters cannot use object arguments or a schema callback', async t => {
  const source = 'function(value){return value}', sha256 = createHash('sha256').update(source).digest('hex');
  const f = fixture(t, { helpers: { bounded: { version: 1, source, sha256, parameters: [{ type: 'string', maxBytes: 4 }] } } });
  await f.view.callFixed('bounded', ['four']);
  await assert.rejects(f.view.callFixed('bounded', ['fives']), /FIXED_HELPER_REQUIRED/);
  await assert.rejects(f.view.callFixed('bounded', [{ text: 'x' }]), /FIXED_HELPER_REQUIRED/);
  await assert.rejects(f.view.callFixed('world-state', ['checked', 'page']), /FIXED_HELPER_REQUIRED/);
});
test('lease-scoped trusted metadata is rechecked after an inspector reply', async t => {
  let changed = false;
  const f = fixture(t, { nodeBinding: id => ({ ...lease, backendNodeId: id, document: changed ? 2 : 1 }),
    send(method, params, route, replies) { if (method === 'Runtime.callFunctionOn') changed = true; return replies[method]; } });
  const objectId = await resolve(f);
  await assert.rejects(f.view.send('Runtime.callFunctionOn', call(objectId)), /FOREIGN_NODE/);
});
test('UTF-8 byte limits apply to source and text input', async t => {
  const source = 'function(){/*' + '界'.repeat(22000) + '*/}', sha256 = createHash('sha256').update(source).digest('hex');
  const f = fixture(t, { helpers: { unicode: { version: 1, source, sha256, parameters: [] } } });
  await assert.rejects(f.view.callFixed('unicode', []), /FIXED_HELPER_REQUIRED/);
  await assert.rejects(f.view.input('Input.insertText', { text: '界'.repeat(22000) }), /SCOPED_COMMAND_DENIED/);
  for (const buttons of [-1, 8, 1.5]) await assert.rejects(f.view.input('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: 1, y: 1, buttons }), /SCOPED_COMMAND_DENIED/);
  assert.equal(f.calls.length, 0);
});
test('the immutable P2 WorldReader preflight now returns a native and MAIN value', async t => {
  const bank = '575560023903f1379436e4cd58fd1655c6aecf2a', sources = new Map();
  try {
    for (const file of ['worlds.mjs', 'refs.mjs', 'protected-proof.mjs']) sources.set(file, execFileSync('/usr/bin/git',
      ['show', bank + ':plugins/sleight/lib/direct-browser/' + file],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return t.skip('immutable P2 bank unavailable in this checkout'); }
  const directory = mkdtempSync(join(tmpdir(), 'sleight-host-join-')); trackTemp(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, source] of sources) writeFileSync(join(directory, name), source);
  const { WorldReader, fixedWorldInspectors: registered } = await import(pathToFileURL(join(directory, 'worlds.mjs')));
  const { RefMap } = await import(pathToFileURL(join(directory, 'refs.mjs')));
  const identity = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 1,
    leaseGeneration: 1, target: lease.target, frame: lease.frame, document: 1, origin: lease.origin };
  const f = fixture(t, { helpers: registered }), refs = new RefMap(identity);
  const ref = refs.observe(identity, 42, 'checkbox:Example');
  const reader = new WorldReader(f.view, refs, { current: () => identity, mainContext: () => 7 });
  t.after(() => reader.dispose());
  assert.deepEqual(await reader.read(ref, 'checked'), { state: 'value', value: true, source: 'native' });
  assert.deepEqual(await reader.read(ref, 'checked', { semantics: 'page' }), { state: 'value', value: true, source: 'page-reported' });
  assert.equal(f.calls.length, 7);
});
test('parameterized reads and whole clicks use the actual coherent broker fence', async t => {
  const root = fixture(t), secret = 'a'.repeat(64), user = {}, uid = process.getuid?.() ?? 1000;
  const scope = { browser: 'browser', broker: 1, session: 'client', turn: 'turn', target: lease.target,
    lease: 1, frame: lease.frame, document: 1, ref: 'ref', origin: lease.origin };
  let snapshots = 0, revokeAt = Infinity;
  const authority = createAuthority({ checkTarget: () => ({ present: true, visible: true, enabled: true, same: true }), current: () => scope, now: () => 100,
    authenticate: event => event === user, classify: operation => operation,
    snapshot() {
      snapshots++;
      if (snapshots === revokeAt) authority.user(user, 'revoke', { session: scope.session });
      return { scope, time: 100 };
    } });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation(plan, context) {
    return { id: context.operation, kind: plan.operationName === 'browser_read' ? 'read' : 'click', args: {}, scope, consequence: 'ordinary' };
  } });
  const session = { sessionId: 'root', on() {}, off() {},
    send(method, params, route) {
      root.calls.push({ method, params, route });
      const replies = { 'Page.createIsolatedWorld': { executionContextId: 9 },
        'DOM.resolveNode': { object: { objectId: 'object' } },
        'Runtime.callFunctionOn': { result: { value: { state: 'value', value: true } } } };
      assert.ok(Object.hasOwn(replies, method) || ['Runtime.releaseObject', 'Input.dispatchMouseEvent'].includes(method));
      return Promise.resolve(replies[method] ?? {});
    } };
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: scope.browser,
    connect: async () => session, disconnect: () => true, verifyConnection: () => true,
    currentTurn: () => scope.turn, validateRequest: frame => frame, prepare: () => ({ target: lease.target }),
    authorize: () => true, dispatchFence: () => true, transportAuthority, endSession: () => true, redact: value => value,
    async dispatch(plan, context) {
      const adapter = createScopedAdapter({ session: context.session, checkLease: () => true, helpers: fixedWorldInspectors,
        nodeBinding: id => ({ ...lease, backendNodeId: id }) });
      const view = adapter.forLease(lease);
      try {
        if (plan.operationName === 'browser_read') {
          await view.send('Page.createIsolatedWorld', world);
          const { object } = await view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 });
          await view.send('Runtime.callFunctionOn', call(object.objectId));
          await view.send('Runtime.releaseObject', { objectId: object.objectId });
        } else for (const [type, buttons] of [['mousePressed', 1], ['mouseReleased', 0]])
          await view.input('Input.dispatchMouseEvent', { type, buttons, x: 1, y: 1, button: 'left', clickCount: 1 });
        return { effect: 'verified', observation: {} };
      } finally { adapter.disconnect(); }
    } });
  t.after(() => broker.shutdown());
  await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: scope.session, incarnation: 'p1-v1' });
  const request = (id, operation) => ({ id, operation, args: {} });
  assert.equal((await client.request(request('read', 'browser_read'))).effect, 'verified');
  assert.equal(snapshots, 4); assert.equal(root.calls.length, 4);
  assert.equal((await client.request(request('click', 'browser_act'))).effect, 'verified');
  assert.equal(root.calls.length, 6); assert.equal(snapshots, 6);
  revokeAt = snapshots + 2;
  assert.equal((await client.request(request('revoked', 'browser_act'))).effect, 'unknown');
  assert.equal(root.calls.length, 7); assert.equal(snapshots, 8);
  assert.ok(root.calls.every(command => command.route === lease.cdpSessionId));
});
