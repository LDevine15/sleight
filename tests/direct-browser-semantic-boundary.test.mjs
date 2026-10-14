import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { createInputController } from '../plugins/sleight/lib/direct-browser/input.mjs';

const lease = { target: 'target', frame: 'frame', document: 1, epoch: 1,
  origin: 'https://fixture.invalid', cdpSessionId: 'page' };
function fixture(t, helpers = {}) {
  const calls = [];
  const adapter = createScopedAdapter({ helpers, checkLease: () => true,
    nodeBinding: id => ({ ...lease, backendNodeId: id }),
    session: { sessionId: 'root', on() {}, off() {}, async send(method, params, route) {
      assert.equal(route, 'page'); calls.push({ method, params });
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
      if (method === 'Runtime.callFunctionOn') return { result: { objectId: 'constructor' } };
      throw Error('Unsupported fake command ' + method);
    } } });
  t.after(() => adapter.disconnect());
  return { view: adapter.forLease(lease), calls };
}
test('P1I installs the approved constructor but cannot construct a node-bound Playwright instance', async t => {
  const bundle = readFileSync(new URL('../plugins/sleight/vendor/playwright-core/lib/coreBundle.js', import.meta.url), 'utf8');
  const literal = bundle.match(/source5 = ('(?:\\.|[^'\\])*');/)[1];
  const source = runInNewContext(literal, Object.create(null), { timeout: 100 });
  const sha256 = createHash('sha256').update(source).digest('hex');
  assert.equal(sha256, '852e40f938e72e6129b6c9a8bde3f4cc6cfe5cecb5ac734b6b06c8ad1fde42bf');
  const construct = 'function(){return new this()}';
  const f = fixture(t, { playwright: { version: 1, source, sha256, parameters: [] },
    construct: { version: 1, source: construct, sha256: createHash('sha256').update(construct).digest('hex'), parameters: [] } });
  await f.view.send('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'sleight-state', grantUniveralAccess: false });
  const { objectId } = await f.view.installFixed('playwright', 9);
  assert.equal(objectId, 'constructor'); f.calls.length = 0;
  await assert.rejects(f.view.send('Runtime.callFunctionOn', { objectId, functionDeclaration: construct,
    arguments: [], returnByValue: true, awaitPromise: false }), /OBJECT_LOST/);
  assert.equal(f.calls.length, 0);
});
for (const [method, params] of [
  ['DOM.setFileInputFiles', { backendNodeId: 2, files: ['/fixture-only'] }],
  ['Page.handleJavaScriptDialog', { accept: false }],
  ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: 5 }],
]) test('unassigned semantic actuator refuses ' + method, async t => {
  const f = fixture(t);
  await assert.rejects(f.view.input(method, params), /SCOPED_COMMAND_DENIED/);
  assert.equal(f.calls.length, 0);
});
for (const op of [{ op: 'scroll', deltaX: 0, deltaY: 5 }, { op: 'dialog', accept: false }])
  test(op.op + ' controller barrier proves none before its absent host actuator', async () => {
    let preparations = 0;
    const controller = createInputController({ resolve: () => { preparations++; }, authorize() {}, fence() {}, observe() {} });
    const result = await controller.act({ browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 1,
      leaseGeneration: 1, target: 'target', frame: 'frame', document: 1, origin: lease.origin,
      operationId: 'barrier', sequence: 1, ref: 'rfixture', expect: { kind: 'state', field: 'checked', equals: false }, ...op });
    assert.equal(result.effect, 'none'); assert.equal(result.code, 'ADAPTER_UNAVAILABLE');
    assert.equal(preparations, 0);
  });
