import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';

const lease = { target: 'target', cdpSessionId: 'page', frame: 'frame', origin: 'https://fixture.invalid', document: 1, epoch: 1,
  browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn' };
const hash = '852e40f938e72e6129b6c9a8bde3f4cc6cfe5cecb5ac734b6b06c8ad1fde42bf';
function playwright(t) {
  const path = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/lib/coreBundle.js');
  if (!existsSync(path)) { t.skip('pinned Playwright source cache unavailable'); return; }
  const bundle = readFileSync(path, 'utf8');
  if (createHash('sha256').update(bundle).digest('hex') !== '2325ca4c1c83070e89dc49fb82525508f0a68e0cf12e2a624277968da216b7e0') {
    t.skip('pinned Playwright source cache differs'); return;
  }
  const source = runInNewContext(bundle.match(/source5 = ('(?:\\.|[^'\\])*');/)[1], {}, { timeout: 100 });
  assert.equal(createHash('sha256').update(source).digest('hex'), hash);
  return { playwright: { version: 1, source, sha256: hash, parameters: [] } };
}
function fixture(t, options = {}) {
  const calls = [], listeners = new Set(); let alive = true, next = 0;
  const session = new Proxy({ sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); }, async send(method, params, route) {
      assert.ok(['Page.createIsolatedWorld', 'DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject',
        'DOM.setFileInputFiles', 'Page.handleJavaScriptDialog', 'Input.dispatchMouseEvent'].includes(method), method);
      calls.push({ method, params, route });
      if (options.send) return options.send(method, params, route);
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node-' + (++next) } };
      if (method === 'Runtime.callFunctionOn') return params.returnByValue ? { result: { value: 'done' } } : { result: { objectId: 'instance-' + (++next) } };
      return {};
    } }, { get(object, key) {
    if (key in object || typeof key === 'symbol' || key === 'then') return object[key];
    throw Error('unsupported fake member ' + key);
  } });
  const adapter = createScopedAdapter({ session, checkLease: () => alive, helpers: {},
    nodeBinding: id => id === 42 ? { ...lease, backendNodeId: id } : null, ...options });
  t.after(() => adapter.disconnect());
  return { session, adapter, view: adapter.forLease(lease), calls, revoke() { alive = false; },
    emit(method, params) { for (const fn of listeners) fn({ sessionId: lease.cdpSessionId, method, params }); } };
}
async function instance(t, options = {}) {
  const helpers = playwright(t); if (!helpers) return;
  const f = fixture(t, { ...options, helpers });
  await f.view.send('Page.createIsolatedWorld', { frameId: lease.frame, worldName: 'sleight-state' });
  const constructor = await f.view.installFixed('playwright', 9);
  const handle = await f.view.createPlaywright({ constructor: constructor.objectId });
  const node = await f.view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 });
  return { ...f, handle: handle.objectId, node: node.object.objectId };
}
test('pinned constructor creates one typed instance in its leased isolated world', async t => {
  const f = await instance(t); if (!f) return;
  const command = f.calls[2];
  assert.equal(command.params.objectId, 'instance-1');
  assert.equal(command.params.returnByValue, false);
  let received;
  const Constructor = function(window, options) { received = options; };
  const construct = runInNewContext('(' + command.params.functionDeclaration + ')', { window: {} });
  construct.call(Constructor);
  assert.equal(received.sdkLanguage, 'javascript');
  assert.equal(received.isUnderTest, false);
  assert.equal(received.customEngines.length, 0);
  assert.equal(received.stableRafCount, 2);
});
for (const [method, args] of [
  ['checkElementStates', { states: ['visible', 'enabled', 'stable'] }],
  ['elementState', { state: 'checked' }], ['expectHitTarget', { x: 2, y: 3 }],
  ['ariaSnapshot', { depth: 3 }], ['fill', { value: 'fixture' }],
  ['selectOptions', { options: [{ label: 'One' }, { value: 'two' }] }], ['check', { checked: true }],
]) test('typed Playwright entry supports ' + method, async t => {
  const f = await instance(t); if (!f) return;
  assert.equal((await f.view.callPlaywright({ instance: f.handle, node: f.node, method, args })).result.value, 'done');
  const command = f.calls.at(-1);
  assert.equal(command.route, lease.cdpSessionId);
  assert.equal(command.params.objectId, f.handle);
  assert.equal(command.params.arguments[0].objectId, f.node);
  assert.equal(command.params.awaitPromise, true);
});
for (const change of [
  { method: 'evaluate' }, { method: 'constructor' }, { instance: 'foreign' }, { node: 'foreign' },
  { args: { value: 'ok', force: true } }, { args: { value: '界'.repeat(22000) } },
  { executionContextId: 7 }, { functionDeclaration: 'function(){return document.cookie}' },
]) test('typed Playwright refuses ' + JSON.stringify(change).slice(0, 80), async t => {
  const f = await instance(t); if (!f) return; const count = f.calls.length;
  await assert.rejects(f.view.callPlaywright({ instance: f.handle, node: f.node, method: 'fill', args: { value: 'ok' }, ...change }));
  assert.equal(f.calls.length, count);
});
test('Playwright instance and node must share the same world and retire on context loss', async t => {
  const f = await instance(t, { contextBinding: id => ({ ...lease, executionContextId: id, world: 'main' }) }); if (!f) return;
  const other = await f.view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 7 });
  await assert.rejects(f.view.callPlaywright({ instance: f.handle, node: other.object.objectId, method: 'fill', args: { value: 'x' } }), /WORLD_LOST/);
  f.emit('Runtime.executionContextDestroyed', { executionContextId: 9 });
  await assert.rejects(f.view.callPlaywright({ instance: f.handle, node: f.node, method: 'fill', args: { value: 'x' } }), /OBJECT_LOST/);
});
test('wheel is one closed actuator command, with bounded deltas', async t => {
  const f = fixture(t);
  await f.view.input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 120 });
  assert.equal(f.calls.length, 1);
  for (const params of [{ deltaY: Infinity }, { deltaY: 100001 }, { deltaMode: 1 }, { type: 'mousePressed', deltaX: 0 }])
    await assert.rejects(f.view.input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 2, ...params }));
  assert.equal(f.calls.length, 1);
});
test('dialog actuator binds the event, operation, choice and trusted current metadata', async t => {
  let decision = { ...lease, operation: 'answer', dialogId: 'dialog-1', accept: true, promptText: 'fixture' };
  const f = fixture(t, { dialogBinding: () => decision });
  f.emit('Page.javascriptDialogOpening', { type: 'prompt', url: lease.origin, frameId: lease.frame });
  const input = { dialogId: 'dialog-1', operation: 'answer', accept: true, promptText: 'fixture' };
  await assert.rejects(f.view.answerDialog({ ...input, accept: false }));
  await assert.rejects(f.view.answerDialog({ ...input, operation: 'other' }));
  await f.view.answerDialog(input);
  assert.deepEqual(f.calls.at(-1).params, { accept: true, promptText: 'fixture' });
  await assert.rejects(f.view.answerDialog(input));
  assert.equal(f.calls.length, 1);
  decision = { ...decision, document: 2 };
  f.emit('Page.javascriptDialogOpening', { type: 'prompt', url: lease.origin, frameId: lease.frame });
  await assert.rejects(f.view.answerDialog({ ...input, dialogId: 'dialog-2' }));
});
test('dialog has no raw send/input escape or page-origin substitution', async t => {
  const f = fixture(t);
  await assert.rejects(f.view.send('Page.handleJavaScriptDialog', { accept: true }));
  await assert.rejects(f.view.input('Page.handleJavaScriptDialog', { accept: true }));
  f.emit('Page.javascriptDialogOpening', { type: 'confirm', url: 'https://foreign.invalid', frameId: lease.frame });
  await assert.rejects(f.view.answerDialog({ dialogId: 'dialog-1', operation: 'answer', accept: true }));
  assert.equal(f.calls.length, 0);
});
test('approved canonical file capability is the only file actuator input', async t => {
  const files = await import('../plugins/sleight/lib/direct-browser/host-files.mjs');
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-host-files-')); trackTemp(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'fixture.txt'); writeFileSync(path, 'fixture');
  const binding = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn', leaseGeneration: 1,
    target: lease.target, frame: lease.frame, document: 1, origin: lease.origin, operation: 'upload', ref: 'ref' };
  const authority = files.createFileAuthority({ approve: () => true });
  const f = fixture(t, { fileAuthority: authority, fileBinding: () => binding });
  const token = await authority.issue([path], binding);
  await assert.rejects(f.view.setFiles({ backendNodeId: 42, operation: 'upload', files: [path] }, token));
  await f.view.setFiles({ backendNodeId: 42, operation: 'upload' }, token);
  assert.deepEqual(f.calls.at(-1).params, { backendNodeId: 42, files: [path] });
  await assert.rejects(f.view.setFiles({ backendNodeId: 42, operation: 'upload' }, token));
  const changed = await authority.issue([path], binding); writeFileSync(path, 'replacement');
  await assert.rejects(f.view.setFiles({ backendNodeId: 42, operation: 'upload' }, changed));
  await assert.rejects(f.view.setFiles({ backendNodeId: 42, operation: 'upload' }, {}));
  const { clientSession, turn, browserIncarnation, brokerEpoch, ...incomplete } = lease;
  const unbound = f.adapter.forLease(incomplete), another = await authority.issue([path], binding);
  await assert.rejects(unbound.setFiles({ backendNodeId: 42, operation: 'upload' }, another), /FILE_AUTHORITY_REQUIRED/);
  const link = join(dir, 'link'); symlinkSync(path, link);
  await assert.rejects(authority.issue([link], binding));
  assert.equal(f.calls.length, 1);
});
