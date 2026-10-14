import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
const production = process.env.SLEIGHT_P2_BASELINE !== '1' && existsSync(new URL('../plugins/sleight/lib/direct-browser/input.mjs', import.meta.url));
const { createInputController, fixedInputInspectors } = await import(production
  ? '../plugins/sleight/lib/direct-browser/input.mjs' : '../bench/direct-browser2/input.mjs');
const canonical = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 1,
  leaseGeneration: 1, target: 'target', frame: 'frame', document: 1, origin: 'https://fixture.invalid' };
const legacy = { ...canonical, targetId: canonical.target, frameId: canonical.frame, documentEpoch: 1 };
delete legacy.target; delete legacy.frame; delete legacy.document;
const identity = production ? canonical : legacy;
const lease = { target: 'target', frame: 'frame', document: 1, epoch: 1, origin: canonical.origin, cdpSessionId: 'page' };
const state = { connected: true, visible: true, enabled: true, hit: true, focused: true, editable: true,
  frameLocal: false, rect: { x: 1, y: 2, width: 20, height: 20 } };
const request = (id = 'action', extra = {}) => ({ ...identity, operationId: id, sequence: 1, ref: 'rfixture', op: 'click',
  expect: { kind: 'state', field: 'checked', equals: true }, timeout_ms: 200, ...extra });
function fixture(t, options = {}) {
  const calls = [], listeners = new Set(); let sequence = 0, inspections = 0, live = true;
  const raw = new Proxy({ sessionId: 'root',
    on(event, fn) { assert.equal(event, 'event'); listeners.add(fn); },
    off(event, fn) { assert.equal(event, 'event'); listeners.delete(fn); },
    async send(method, params, route) {
      assert.equal(route, 'page'); calls.push({ method, params });
      if (options.send) await options.send(method, params);
      switch (method) {
        case 'DOM.scrollIntoViewIfNeeded': case 'Runtime.releaseObject': return {};
        case 'Page.createIsolatedWorld': return { executionContextId: 9 };
        case 'DOM.resolveNode': return { object: { objectId: 'object-' + ++sequence } };
        case 'Runtime.callFunctionOn': inspections++; return { result: { value: options.inspect?.(inspections) ?? state } };
        case 'Input.dispatchMouseEvent': case 'Input.dispatchKeyEvent': case 'Input.insertText': return {};
        default: throw Error('Unsupported fake command ' + method);
      }
    } }, { get(obj, key) { if (key in obj || typeof key === 'symbol' || key === 'then') return obj[key]; throw Error('Unsupported fake member ' + key); } });
  const adapter = createScopedAdapter({ session: raw, checkLease: () => live, helpers: fixedInputInspectors ?? {},
    nodeBinding: id => id === 2 ? { ...lease, backendNodeId: id } : null });
  const view = adapter.forLease(lease);
  const controller = createInputController({ resolve: async () => {
    const world = await view.send('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'sleight-state', grantUniveralAccess: false });
    return { ...identity, session: view, backendNodeId: 2, executionContextId: world.executionContextId };
  },
    authorize: async () => ({ allowed: true }), fence: async () => options.fence?.() ?? identity,
    observe: async () => ({ matched: true, complete: true, source: 'native', [production ? 'document' : 'documentEpoch']: 1 }) });
  t.after(() => adapter.disconnect());
  return { controller, calls, revoke() { live = false; },
    emit(method, params) { for (const fn of listeners) fn({ sessionId: 'page', method, params }); } };
}
test('click joins fixed node preparation and the closed actuator without raw Input send', async t => {
  const f = fixture(t), receipt = await f.controller.act(request());
  assert.equal(receipt.effect, 'verified');
  assert.equal(f.calls.filter(c => c.method === 'Runtime.callFunctionOn').length, 3);
  assert.equal(f.calls.filter(c => c.method === 'Runtime.releaseObject').length, 3);
  assert.deepEqual(f.calls.filter(c => c.method.startsWith('Input.')).map(c => c.params.type), ['mousePressed', 'mouseReleased']);
});
for (const [name, change] of [['hidden', { visible: false }], ['disabled', { enabled: false }], ['covered', { hit: false }],
  ['moving', null], ['subframe', { frameLocal: true }]])
  test(name + ' target never reaches physical input', async t => {
    const f = fixture(t, { inspect: i => ({ ...state, ...(change ?? {}), rect: { ...state.rect, x: change ? 1 : i } }) });
    const result = await f.controller.act(request());
    assert.equal(result.effect, 'none');
    assert.equal(result.code, { hidden: 'NOT_VISIBLE', disabled: 'DISABLED', covered: 'COVERED', moving: 'UNSTABLE', subframe: 'FRAME_UNQUALIFIED' }[name]);
    assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
  });
test('keyboard commands obey the closed P1I key schema', async t => {
  const f = fixture(t), result = await f.controller.act(request('key', { op: 'key', key: 'Tab' }));
  assert.equal(result.effect, 'verified');
  const commands = f.calls.filter(c => c.method.startsWith('Input.'));
  assert.equal(commands.length, 2);
  assert.equal(Object.hasOwn(commands[0].params, 'windowsVirtualKeyCode'), false);
});
test('unknown first input is journaled and another ID cannot replay it', async t => {
  const f = fixture(t, { send(method) { if (method.startsWith('Input.')) throw Error('synthetic-secret'); } });
  const first = await f.controller.act(request());
  assert.equal(first.effect, 'unknown');
  assert.deepEqual(await f.controller.act(request()), first);
  assert.equal((await f.controller.act(request('retry'))).code, 'EFFECT_UNKNOWN');
  assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, 1);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-secret/);
});
for (const phase of [1, 2, 3]) test('stale node during preparation sample ' + phase + ' sends no input', async t => {
  let f;
  f = fixture(t, { inspect(i) { if (i === phase) f.revoke(); return state; } });
  assert.equal((await f.controller.act(request())).effect, 'none');
  assert.equal(f.calls.some(c => c.method.startsWith('Input.')), false);
});
test('prearmed dialog interrupts a click without replay or secret message output', async t => {
  let f;
  f = fixture(t, { send(method, params) { if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')
    f.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'synthetic-secret' }); } });
  const result = await f.controller.act(request('dialog', { expect: { kind: 'dialog', type: 'confirm' } }));
  assert.equal(result.code, 'DIALOG_OPEN'); assert.equal(result.effect, 'verified');
  assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});
