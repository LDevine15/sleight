import test from 'node:test';
import assert from 'node:assert/strict';
const lease = { target: 'target', cdpSessionId: 'page', frame: 'frame', origin: 'https://fixture.invalid', document: 1, epoch: 1,
  browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'client', turn: 'turn' };
async function fixture(t, options = {}) {
  const { createTransportOwner } = await import('../plugins/sleight/lib/direct-browser/transport-owner.mjs');
  const calls = [], callbacks = new Set(); let live = true, next = 0;
  const root = { sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); callbacks.add(fn); },
    off(name, fn) { callbacks.delete(fn); }, send(method, params, route) {
      assert.equal(method, 'Runtime.releaseObject', 'root transport is cleanup-only');
      calls.push({ method, params, route, cleanup: true });
      return options.release ? options.release(params) : Promise.resolve({});
    } };
  const owner = createTransportOwner({ session: root, checkLease: () => live, helpers: {},
    nodeBinding: id => ({ ...lease, backendNodeId: id }) });
  t.after(() => owner.close());
  const context = id => ({ operation: id, clientSession: lease.clientSession, turn: lease.turn,
    browserIncarnation: lease.browserIncarnation, brokerEpoch: lease.brokerEpoch,
    session: { sessionId: 'root', on: root.on, off: root.off,
    send(method, params, route) {
      assert.ok(['Page.createIsolatedWorld', 'DOM.resolveNode', 'Input.insertText', 'Runtime.releaseObject'].includes(method));
      calls.push({ id, method, params, route });
      if (options.send) return options.send(method, params);
      return Promise.resolve(method === 'Page.createIsolatedWorld' ? { executionContextId: 9 }
        : method === 'DOM.resolveNode' ? { object: { objectId: 'object-' + (++next) } } : {});
    } } });
  return { owner, calls, context, revoke() { live = false; },
    emit(method, params) { for (const fn of callbacks) fn({ method, params, sessionId: lease.cdpSessionId }); } };
}
test('a trusted reader and view persist across requests while each send uses the current operation fence', async t => {
  const f = await fixture(t); let created = 0, first;
  const reader = view => { created++; return { baseline: null, view, dispose() {} }; };
  await f.owner.run(lease, f.context('one'), view => {
    first = view; const state = f.owner.reader(lease, 'state', reader); state.baseline = 'read-one';
    return view.send('Page.createIsolatedWorld', { frameId: lease.frame, worldName: 'sleight-state' });
  });
  await f.owner.run(lease, f.context('two'), view => {
    assert.equal(view, first); assert.equal(f.owner.reader(lease, 'state', reader).baseline, 'read-one');
    return view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 });
  });
  assert.equal(created, 1); assert.deepEqual(f.calls.map(c => c.id), ['one', 'two']);
  await assert.rejects(first.input('Input.insertText', { text: 'outside request' }), /TRANSPORT_INACTIVE/);
});
test('a reader cannot cross client, turn or document ownership and invalidation disposes it', async t => {
  const f = await fixture(t); let disposed = 0, initial;
  const reader = () => ({ dispose() { disposed++; } });
  await f.owner.run(lease, f.context('one'), () => { initial = f.owner.reader(lease, 'state', reader); });
  for (const changed of [{ clientSession: 'other' }, { turn: 'other' }, { document: 2 }])
    await f.owner.run({ ...lease, ...changed }, { ...f.context('two'), ...changed }, () => {
      assert.notEqual(f.owner.reader({ ...lease, ...changed }, 'state', reader), initial);
    });
  f.emit('DOM.documentUpdated', {});
  assert.equal(disposed, 4);
});
test('owner refuses a transport from another client session before any send', async t => {
  const f = await fixture(t);
  await assert.rejects(f.owner.run(lease, { ...f.context('other'), clientSession: 'foreign' }, view =>
    view.input('Input.insertText', { text: 'fixture' })), /TRANSPORT_CONTEXT_REQUIRED/);
  assert.equal(f.calls.length, 0);
});
test('a delayed resolved object after lease loss is released through cleanup only', async t => {
  let finish;
  const f = await fixture(t, { send(method) { return method === 'Page.createIsolatedWorld' ? Promise.resolve({ executionContextId: 9 })
    : new Promise(resolve => { finish = resolve; }); } });
  const pending = f.owner.run(lease, f.context('one'), async view => {
    await view.send('Page.createIsolatedWorld', { frameId: lease.frame, worldName: 'sleight-state' });
    return view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 });
  });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.revoke(); finish({ object: { objectId: 'late-object' } });
  await assert.rejects(pending, /LEASE_LOST/);
  await new Promise(resolve => setImmediate(resolve));
  const cleanup = f.calls.filter(c => c.cleanup);
  assert.deepEqual(cleanup, [{ method: 'Runtime.releaseObject', params: { objectId: 'late-object' }, route: lease.cdpSessionId, cleanup: true }]);
  assert.equal((await f.owner.close()).closed, true);
});
test('failed release retains exact ownership, explicit cleanup retries without other commands', async t => {
  let healthy = false;
  const f = await fixture(t, { release() { if (!healthy) throw Error('socket lost'); return Promise.resolve({}); } });
  await f.owner.run(lease, f.context('one'), async view => {
    await view.send('Page.createIsolatedWorld', { frameId: lease.frame, worldName: 'sleight-state' });
    await view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 });
  });
  const result = await f.owner.close(); assert.equal(result.closed, false);
  assert.equal(result.cleanup[0].status, 'retained');
  await assert.rejects(f.owner.run(lease, f.context('two'), () => {}), /TRANSPORT_CLOSED/);
  healthy = true;
  assert.equal((await f.owner.close()).closed, true);
  assert.deepEqual(f.calls.filter(c => c.cleanup).map(c => c.params.objectId), ['object-1', 'object-1']);
});
test('two requests cannot replace one active fence and lost world replies never publish handles', async t => {
  let finish;
  const f = await fixture(t, { send() { return new Promise(resolve => { finish = resolve; }); } });
  const pending = f.owner.run(lease, f.context('one'), view => view.send('Page.createIsolatedWorld', { frameId: lease.frame, worldName: 'sleight-state' }));
  await assert.rejects(f.owner.run(lease, f.context('two'), () => {}), /TRANSPORT_BUSY/);
  f.emit('DOM.documentUpdated', {}); finish({ executionContextId: 9 });
  await assert.rejects(pending, /LEASE_LOST|WORLD_LOST/);
});
test('close retains an in-flight acquisition until its late object cleanup is proved', async t => {
  let finish;
  const f = await fixture(t, { send(method) { return method === 'Page.createIsolatedWorld' ? Promise.resolve({ executionContextId: 9 })
    : new Promise(resolve => { finish = resolve; }); } });
  const pending = f.owner.run(lease, f.context('one'), async view => {
    await view.send('Page.createIsolatedWorld', { frameId: lease.frame, worldName: 'sleight-state' });
    return view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 });
  });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const first = await f.owner.close(); assert.equal(first.closed, false);
  assert.equal(first.cleanup.at(-1).status, 'retained');
  finish({ object: { objectId: 'late-close' } }); await assert.rejects(pending, /LEASE_LOST/);
  assert.equal((await f.owner.close()).closed, true);
});
test('an aborted broker request releases its late object instead of publishing it', async t => {
  let finish; const controller = new AbortController();
  const f = await fixture(t, { send(method) { return method === 'Page.createIsolatedWorld' ? Promise.resolve({ executionContextId: 9 })
    : new Promise(resolve => { finish = resolve; }); } });
  const pending = f.owner.run(lease, { ...f.context('one'), signal: controller.signal }, async view => {
    await view.send('Page.createIsolatedWorld', { frameId: lease.frame, worldName: 'sleight-state' });
    return view.send('DOM.resolveNode', { backendNodeId: 42, executionContextId: 9 });
  });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); finish({ object: { objectId: 'late-aborted' } });
  await assert.rejects(pending, /LEASE_LOST/);
  assert.equal((await f.owner.close()).closed, true);
  assert.equal(f.calls.filter(c => c.cleanup).length, 1);
});
