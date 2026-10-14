import test from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { validateHostRequest } from '../plugins/sleight/lib/direct-browser/request-schema.mjs';
import { createTransportOwner } from '../plugins/sleight/lib/direct-browser/transport-owner.mjs';
const root = await import('../plugins/sleight/lib/direct-browser/root-targets.mjs').catch(() => ({}));

async function fixture(t, options = {}) {
  assert.equal(typeof root.createRootTargets, 'function', 'closed root allocator missing');
  const calls = [], listeners = new Set(), targets = new Map(); let next = 0, opener, active;
  const raw = { sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); },
    async send(method, params, route) {
      calls.push({ method, params, route });
      if (options.send) { const result = await options.send(method, params); if (result) return result; }
      switch (method) {
        case 'Target.createTarget': {
          assert.equal(route, undefined); assert.deepEqual(Object.keys(params).sort(), ['background', 'url']);
          assert.equal(params.background, true); const targetId = 'owned-' + (++next);
          targets.set(targetId, { targetId, type: 'page', url: params.url }); return { targetId };
        }
        case 'Target.attachToTarget': assert.equal(params.flatten, true); return { sessionId: 'page-' + params.targetId };
        case 'Target.getTargetInfo': return { targetInfo: targets.get(params.targetId) };
        case 'Page.enable': return {};
        case 'Page.getFrameTree': return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: options.redirect ?? 'https://fixture.invalid/form' } } };
        case 'Target.closeTarget': targets.delete(params.targetId); return { success: true };
        case 'Target.detachFromTarget': return {};
        case 'Target.getTargets': return { targetInfos: [...targets.values()] };
        default: assert.fail('unsupported CDP ' + method);
      }
    } };
  const binding = { session: 'client', turn: 'turn', browserIncarnation: 'browser', brokerEpoch: 1 };
  opener = root.createRootTargets({ session: raw, current: () => binding, timeoutMs: options.timeoutMs ?? 1000 });
  const authority = createAuthority({ authenticate: () => false, current: () => active.scope,
    classify: op => { assert.deepEqual(op, active); return op; }, snapshot: () => ({ scope: active.scope, time: Date.now() }) });
  const transportAuthority = createTransportAuthority({ authority, resolveOperation(plan, ctx, command) {
    active = opener.resolveOperation(plan, ctx, command); return active;
  } });
  const uid = process.getuid?.() ?? 1000, secret = 'a'.repeat(64);
  const broker = createBroker({ uid, secret, idlePolicy: 'retain', browserIncarnation: 'browser',
    connect: () => raw, verifyConnection: () => true, currentTurn: () => binding.turn,
    validateRequest: validateHostRequest, prepare: opener.prepare, authorize: () => true,
    dispatchFence: opener.dispatchFence, transportAuthority, dispatch: opener.open,
    endSession: () => { opener.revokeSession('client'); return true; }, disconnect: () => true, redact: v => v,
    timeoutMs: options.brokerTimeoutMs ?? 1000 });
  await broker.connect({ userInitiated: true });
  const client = broker.attach({ version: 1, uid, secret, session: 'client', incarnation: 'fixture' });
  t.after(async () => { await broker.shutdown(); await opener.cleanupSession('client'); });
  const open = (args = {}) => client.request({ id: 'open', operation: 'browser_open', args: { browser: 'bfixture', url: 'https://fixture.invalid/form', ...args } });
  return { opener, calls, targets, open, broker, raw, binding, emit(event) { for (const fn of listeners) fn(event); } };
}
test('root open allocates background, attaches exact target and registers an opaque owned lease', async t => {
  const f = await fixture(t), result = await f.open();
  assert.equal(result.effect, 'verified', JSON.stringify(result)); assert.match(result.tab, /^t[A-Za-z0-9_-]+$/);
  const lease = f.opener.leaseFor(result.tab, { ...f.binding });
  assert.equal(lease.target, 'owned-1'); assert.equal(lease.cdpSessionId, 'page-owned-1');
  assert.equal(lease.frame, 'frame'); assert.equal(lease.document, 1); assert.equal(lease.origin, 'https://fixture.invalid');
  assert.equal(f.opener.checkLease(lease), true);
  assert.ok(f.calls.every(c => !['Page.bringToFront', 'Target.activateTarget'].includes(c.method)));
  assert.throws(() => f.opener.leaseFor(result.tab, { ...f.binding, session: 'foreign' }), /LEASE_LOST/);
  assert.throws(() => f.opener.leaseFor(result.tab, { ...f.binding, turn: 'foreign' }), /LEASE_LOST/);
});
test('root entry refuses a forged broker transport before any create', async t => {
  const f = await fixture(t), context = { ...f.binding, clientSession: 'client', operation: 'forged', session: f.raw };
  const plan = f.opener.prepare({ url: 'https://fixture.invalid/form' }, { ...f.binding, operation: 'forged' }, 'browser_open');
  await assert.rejects(f.opener.open(plan, context), /TRUSTED_ROUTE_REQUIRED/); assert.equal(f.calls.length, 0);
});
test('exact owned cleanup verifies absence and leaves unrelated targets', async t => {
  const f = await fixture(t); f.targets.set('user', { targetId: 'user', type: 'page', url: 'https://fixture.invalid/form' });
  const result = await f.open(); f.opener.revokeSession('client');
  assert.throws(() => f.opener.leaseFor(result.tab, f.binding), /LEASE_LOST/);
  const cleanup = await f.opener.cleanupSession('client'); assert.equal(cleanup.closed, true);
  assert.equal(f.targets.has('owned-1'), false); assert.equal(f.targets.has('user'), true);
});
test('redirect during allocation refuses a reusable lease and retains exact cleanup ownership', async t => {
  const f = await fixture(t, { redirect: 'https://foreign.invalid/' }), result = await f.open();
  assert.notEqual(result.effect, 'verified'); assert.equal(result.tab, undefined);
  assert.equal((await f.opener.cleanupSession('client')).closed, true); assert.equal(f.targets.size, 0);
});
test('a late created target after deadline is owned and cleaned without late attachment', async t => {
  let resolve;
  const f = await fixture(t, { brokerTimeoutMs: 20, send(method) {
    if (method === 'Target.createTarget') return new Promise(r => { resolve = r; });
  } });
  const pending = f.open(); while (!resolve) await new Promise(r => setImmediate(r));
  const result = await pending; assert.equal(result.effect, 'unknown');
  f.opener.revokeSession('client'); const before = await f.opener.cleanupSession('client'); assert.equal(before.closed, false);
  f.targets.set('late', { targetId: 'late', type: 'page', url: 'https://fixture.invalid/form' }); resolve({ targetId: 'late' });
  await new Promise(r => setImmediate(r)); const after = await f.opener.cleanupSession('client');
  assert.equal(after.closed, true); assert.equal(f.targets.size, 0);
  assert.equal(f.calls.some(c => c.method === 'Target.attachToTarget'), false);
});
test('navigation retires the old lease and cannot act through a different frame', async t => {
  const f = await fixture(t), result = await f.open(), lease = f.opener.leaseFor(result.tab, f.binding);
  f.emit({ sessionId: lease.cdpSessionId, method: 'Page.frameNavigated', params: { frame: { id: 'frame', loaderId: 'changed', url: 'https://fixture.invalid/next' } } });
  assert.equal(f.opener.checkLease(lease), false);
});
test('a close that settles late is not physically retried while its ownership is pending', async t => {
  let release;
  const f = await fixture(t, { timeoutMs: 20, send(method, params) {
    if (method === 'Target.closeTarget') return new Promise(resolve => { release = () => {
      f.targets.delete(params.targetId); resolve({ success: true });
    }; });
  } });
  await f.open(); f.opener.revokeSession('client');
  assert.equal((await f.opener.cleanupSession('client')).closed, false);
  const retry = f.opener.cleanupSession('client'); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.filter(c => c.method === 'Target.closeTarget').length, 1);
  release(); await retry;
  assert.equal((await f.opener.cleanupSession('client')).closed, true);
});

test('owned allocation waits through about blank and missing loader until the requested root frame is ready', async t => {
  let infos = 0, frames = 0;
  const f = await fixture(t, { send(method, params) {
    if (method === 'Target.getTargetInfo' && ++infos === 1) return { targetInfo: { targetId: params.targetId, type: 'page', url: 'about:blank' } };
    if (method === 'Page.getFrameTree' && ++frames === 1) return { frameTree: { frame: { id: 'frame', url: 'about:blank' } } };
  } });
  const result = await f.open();
  assert.equal(result.effect, 'verified', JSON.stringify(result));
  assert.ok(infos > 1); assert.ok(frames > 1);
  assert.equal(f.calls.filter(call => call.method === 'Target.createTarget').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'Target.attachToTarget').length, 1);
  assert.equal(f.opener.leaseFor(result.tab, f.binding).frame, 'frame');
});

test('a root that remains loading expires its bounded readiness and retains exact cleanup ownership', async t => {
  let frames = 0;
  const f = await fixture(t, { timeoutMs: 30, send(method) {
    if (method === 'Page.getFrameTree') { frames++; return { frameTree: { frame: { id: 'frame', url: 'about:blank' } } }; }
  } });
  const result = await f.open();
  assert.equal(result.tab, undefined); assert.notEqual(result.effect, 'verified');
  assert.ok(frames > 1, 'readiness must retry the actual owned frame before its deadline');
  assert.equal((await f.opener.cleanupSession('client')).closed, true);
  assert.equal(f.targets.size, 0);
});

test('genuine attached main frame navigation replaces the document lease and clears all old node bindings', async t => {
  const f = await fixture(t), result = await f.open(), old = f.opener.leaseFor(result.tab, f.binding);
  f.opener.observeNodes(old.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 7 } });
  assert.ok(f.opener.nodeBinding(7, old));
  f.emit({ sessionId: old.cdpSessionId, method: 'Page.frameNavigated', params: {
    frame: { id: 'new-root', loaderId: 'new-document', url: 'https://fixture.invalid/after-submit' },
  } });
  const fresh = f.opener.leaseFor(result.tab, f.binding);
  assert.equal(f.opener.checkLease(old), false); assert.equal(f.opener.current(old), null);
  assert.equal(f.opener.checkLease(fresh), true); assert.equal(fresh.target, old.target);
  assert.equal(fresh.frame, 'new-root'); assert.equal(fresh.document, old.document + 1);
  assert.equal(fresh.epoch, old.epoch + 1); assert.equal(fresh.leaseGeneration, fresh.epoch);
  assert.equal(f.opener.nodeBinding(7, fresh), null);
  f.opener.observeNodes(fresh.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 11 } });
  assert.ok(f.opener.nodeBinding(11, fresh));
  f.emit({ sessionId: fresh.cdpSessionId, method: 'Page.frameNavigated', params: {
    frame: { id: fresh.frame, loaderId: 'new-document', url: 'https://fixture.invalid/after-submit' },
  } });
  assert.deepEqual(f.opener.leaseFor(result.tab, f.binding), fresh, 'duplicate document event must not mint another lease');
});

test('subframe and other-session navigation cannot replace the owned root lease', async t => {
  const f = await fixture(t), result = await f.open(), lease = f.opener.leaseFor(result.tab, f.binding);
  for (const event of [
    { sessionId: 'foreign', method: 'Page.frameNavigated', params: { frame: { id: 'frame', loaderId: 'foreign', url: 'https://fixture.invalid/next' } } },
    { sessionId: lease.cdpSessionId, method: 'Page.frameNavigated', params: { frame: { id: 'child', parentId: 'frame', loaderId: 'child-loader', url: 'https://fixture.invalid/next' } } },
  ]) f.emit(event);
  assert.deepEqual(f.opener.leaseFor(result.tab, f.binding), lease);
});

test('cross-origin navigation invalidates content authority and physical detach cannot be revived by navigation', async t => {
  const f = await fixture(t), result = await f.open(), lease = f.opener.leaseFor(result.tab, f.binding);
  f.emit({ sessionId: lease.cdpSessionId, method: 'Page.frameNavigated', params: {
    frame: { id: lease.frame, loaderId: 'foreign', url: 'https://foreign.invalid/next' },
  } });
  assert.equal(f.opener.checkLease(lease), false);
  assert.throws(() => f.opener.leaseFor(result.tab, f.binding), /LEASE_LOST/);
  f.emit({ method: 'Target.detachedFromTarget', params: { sessionId: lease.cdpSessionId } });
  f.emit({ sessionId: lease.cdpSessionId, method: 'Page.frameNavigated', params: {
    frame: { id: lease.frame, loaderId: 'returned', url: 'https://fixture.invalid/back' },
  } });
  assert.throws(() => f.opener.leaseFor(result.tab, f.binding), /LEASE_LOST/);
});

test('concurrent cleanup shares exact closure and a truthy untyped close result is not absence proof', async t => {
  let release;
  const f = await fixture(t, { send(method) {
    if (method === 'Target.closeTarget') return new Promise(resolve => { release = () => resolve({ success: 'true' }); });
  } });
  await f.open();
  const first = f.opener.cleanupSession('client'), second = f.opener.cleanupSession('client');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.method === 'Target.closeTarget').length, 1);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.every(result => result.closed === false && result.cleanup[0].code === 'CLOSE_UNPROVED'), true);
  assert.equal(f.targets.has('owned-1'), true);
  // Release the test-only held transport for fixture teardown; no second close
  // is issued until the first command has settled as an unproved result.
  f.raw.send = async (method, params) => {
    if (method === 'Target.getTargetInfo') return { targetInfo: f.targets.get(params.targetId) };
    if (method === 'Target.closeTarget') { f.targets.delete(params.targetId); return { success: true }; }
    if (method === 'Target.getTargets') return { targetInfos: [...f.targets.values()] };
    assert.fail('unexpected cleanup command');
  };
});

test('a root navigation during an in-flight frame snapshot forces a fresh exact-target sample before leasing', async t => {
  let release, frames = 0;
  const f = await fixture(t, { send(method) {
    if (method === 'Page.getFrameTree') {
      if (++frames === 1) return new Promise(resolve => { release = resolve; });
      return { frameTree: { frame: { id: 'committed-root', loaderId: 'committed-loader', url: 'https://fixture.invalid/form' } } };
    }
  } });
  const pending = f.open(); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.emit({ sessionId: 'page-owned-1', method: 'Page.frameNavigated', params: {
    frame: { id: 'committed-root', loaderId: 'committed-loader', url: 'https://fixture.invalid/form' },
  } });
  release({ frameTree: { frame: { id: 'stale-root', loaderId: 'old-loader', url: 'https://fixture.invalid/form' } } });
  const result = await pending;
  assert.equal(result.effect, 'verified', JSON.stringify(result));
  assert.equal(f.opener.leaseFor(result.tab, f.binding).frame, 'committed-root');
  assert.equal(frames, 2);
});

test('a root frame swap invalidates old refs but permits the subsequent same-target root document commit', async t => {
  const f = await fixture(t), result = await f.open(), old = f.opener.leaseFor(result.tab, f.binding);
  f.emit({ sessionId: old.cdpSessionId, method: 'Page.frameDetached', params: { frameId: old.frame, reason: 'swap' } });
  assert.equal(f.opener.checkLease(old), false);
  assert.throws(() => f.opener.leaseFor(result.tab, f.binding), /LEASE_LOST/);
  f.emit({ sessionId: old.cdpSessionId, method: 'Page.frameNavigated', params: {
    frame: { id: 'swapped-root', loaderId: 'swapped-loader', url: 'https://fixture.invalid/next' },
  } });
  const fresh = f.opener.leaseFor(result.tab, f.binding);
  assert.equal(fresh.frame, 'swapped-root'); assert.equal(fresh.document, old.document + 1);
  assert.equal(f.opener.checkLease(old), false); assert.equal(f.opener.checkLease(fresh), true);
});

test('same-document root navigation refreshes read authority without claiming a new physical document', async t => {
  const f = await fixture(t), result = await f.open(), old = f.opener.leaseFor(result.tab, f.binding);
  f.emit({ sessionId: old.cdpSessionId, method: 'Page.navigatedWithinDocument', params: {
    frameId: old.frame, url: 'https://fixture.invalid/form#confirmation', navigationType: 'fragment',
  } });
  const fresh = f.opener.leaseFor(result.tab, f.binding);
  assert.equal(f.opener.checkLease(old), false); assert.equal(f.opener.checkLease(fresh), true);
  assert.equal(fresh.document, old.document); assert.equal(fresh.leaseGeneration, old.leaseGeneration + 1);
});

test('owned DOM document update fences stale content until an exact root snapshot allows a fresh TransportOwner world', async t => {
  let bootstrap = false, release, worlds = 0;
  const f = await fixture(t, { send(method) {
    if (method === 'Page.getFrameTree' && bootstrap) return new Promise(resolve => { release = resolve; });
    if (method === 'Page.createIsolatedWorld') return { executionContextId: ++worlds };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'owned-object' } };
    if (method === 'Runtime.releaseObject') return {};
  } });
  const result = await f.open(), old = f.opener.leaseFor(result.tab, f.binding);
  const owner = createTransportOwner({ session: f.raw, checkLease: f.opener.checkLease, helpers: {}, nodeBinding: f.opener.nodeBinding });
  t.after(() => owner.close());
  const context = id => ({ ...f.binding, clientSession: f.binding.session, operation: id, session: f.raw });
  let oldView, oldReader, disposed = 0;
  await owner.run(old, context('old-read'), async view => {
    oldView = view; oldReader = owner.reader(old, 'state', () => ({ dispose() { disposed++; } }));
    assert.equal((await view.send('Page.createIsolatedWorld', { frameId: old.frame, worldName: 'sleight-state' })).executionContextId, 1);
  });
  f.opener.observeNodes(old.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 7 } });
  f.emit({ sessionId: 'foreign', method: 'DOM.documentUpdated', params: {} });
  assert.equal(f.opener.checkLease(old), true);
  bootstrap = true;
  f.emit({ sessionId: old.cdpSessionId, method: 'DOM.documentUpdated', params: {} });
  assert.equal(disposed, 1); assert.equal(f.opener.checkLease(old), false);
  assert.throws(() => f.opener.leaseFor(result.tab, f.binding), /LEASE_LOST/);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release({ frameTree: { frame: { id: old.frame, loaderId: 'loader', url: 'https://fixture.invalid/form' } } });
  await new Promise(resolve => setImmediate(resolve));
  const fresh = f.opener.leaseFor(result.tab, f.binding);
  assert.equal(fresh.document, old.document); assert.equal(fresh.leaseGeneration, old.leaseGeneration + 1);
  assert.equal(f.opener.nodeBinding(7, fresh), null);
  f.opener.observeNodes(fresh.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 11 } });
  await owner.run(fresh, context('fresh-read'), async view => {
    assert.notEqual(view, oldView);
    assert.notEqual(owner.reader(fresh, 'state', () => ({ dispose() {} })), oldReader);
    await assert.rejects(view.send('DOM.resolveNode', { backendNodeId: 11, executionContextId: 1 }), /WORLD_LOST/);
    assert.equal((await view.send('Page.createIsolatedWorld', { frameId: fresh.frame, worldName: 'sleight-state' })).executionContextId, 2);
    assert.equal((await view.send('DOM.resolveNode', { backendNodeId: 11, executionContextId: 2 })).object.objectId, 'owned-object');
  });
  await assert.rejects(owner.run(old, context('stale-read'), () => {}), /LEASE_LOST/);
  assert.equal((await owner.close()).closed, true);
});

test('cleanup during an exact-root DOM refresh retains its in-flight metadata and never publishes a late lease', async t => {
  let refreshing = false, release;
  const f = await fixture(t, { send(method) {
    if (method === 'Page.getFrameTree' && refreshing) return new Promise(resolve => { release = resolve; });
  } });
  const result = await f.open(), old = f.opener.leaseFor(result.tab, f.binding);
  refreshing = true; f.emit({ sessionId: old.cdpSessionId, method: 'DOM.documentUpdated', params: {} });
  assert.equal(f.opener.checkLease(old), false);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const before = await f.opener.cleanupSession('client');
  assert.equal(before.closed, false); assert.equal(before.cleanup[0].code, 'ACQUISITION_PENDING');
  release({ frameTree: { frame: { id: 'late-root', loaderId: 'late-document', url: 'https://fixture.invalid/form' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => f.opener.leaseFor(result.tab, f.binding), /LEASE_LOST/);
  assert.equal((await f.opener.cleanupSession('client')).closed, true);
});

test('pre-await observation fences prevent an old document response from binding nodes into a fresh lease', async t => {
  const f = await fixture(t), result = await f.open(), old = f.opener.leaseFor(result.tab, f.binding);
  assert.equal(typeof f.opener.captureObservation, 'function', 'pre-await document fence missing');
  const stale = f.opener.captureObservation(old.cdpSessionId);
  f.emit({ sessionId: old.cdpSessionId, method: 'Page.frameNavigated', params: {
    frame: { id: old.frame, loaderId: 'new-loader', url: 'https://fixture.invalid/next' },
  } });
  const fresh = f.opener.leaseFor(result.tab, f.binding), captured = f.opener.captureObservation(fresh.cdpSessionId);
  f.opener.observeNodes(fresh.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 7 } }, stale);
  f.opener.observeNodes(fresh.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 8 } }, null);
  f.opener.observeNodes(fresh.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 9 } }, Object.freeze({}));
  for (const id of [7, 8, 9]) assert.equal(f.opener.nodeBinding(id, fresh), null);
  f.opener.observeNodes(fresh.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 11 } }, captured);
  assert.ok(f.opener.nodeBinding(11, fresh));
  f.opener.observeNodes(fresh.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 12 } }, captured);
  assert.equal(f.opener.nodeBinding(12, fresh), null, 'a captured response fence is single use');
  assert.equal(f.opener.captureObservation('foreign'), null);
});

test('checkout iframe host is parent-owned while child content never gains a parent binding', async t => {
  const f = await fixture(t), opened = await f.open(), lease = f.opener.leaseFor(opened.tab, f.binding);
  f.opener.observeNodes(lease.cdpSessionId, 'DOM.getDocument', { root: { backendNodeId: 1, nodeType: 9,
    children: [{ backendNodeId: 2, nodeType: 1, localName: 'iframe', frameId: 'payment',
      children: [{ backendNodeId: 99, nodeType: 1 }], contentDocument: { backendNodeId: 100 } }] } });
  assert.deepEqual(f.opener.nodeBinding(2, lease), { ...lease, backendNodeId: 2 });
  assert.equal(f.opener.nodeBinding(99, lease), null); assert.equal(f.opener.nodeBinding(100, lease), null);
  f.opener.observeNodes(lease.cdpSessionId, 'Accessibility.getPartialAXTree', { nodes: [{ backendDOMNodeId: 101, frameId: 'payment' }] });
  assert.equal(f.opener.nodeBinding(101, lease), null);
});
