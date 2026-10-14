import test from 'node:test';
import assert from 'node:assert/strict';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';

function fixture({ metadata = 'success', late = false, detachedBeforeReply = false } = {}) {
  const listeners = new Set(), calls = []; let answerAttach, answerInfo, failDetach = false;
  const info = { targetId: 'owned', type: 'page', url: 'about:blank' };
  const upstream = { sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); },
    off(name, fn) { assert.equal(name, 'event'); listeners.delete(fn); },
    async send(method, params = {}, route = 'root') {
      calls.push({ method, params, route });
      if (method === 'Target.attachToTarget') {
        if (detachedBeforeReply) {
          for (const fn of listeners) fn({ method: 'Target.attachedToTarget', params: { sessionId: 'acquired', targetInfo: info } });
          for (const fn of listeners) fn({ method: 'Target.detachedFromTarget', params: { sessionId: 'acquired' } });
        }
        return late ? new Promise(resolve => { answerAttach = resolve; }) : { sessionId: 'acquired' };
      }
      if (method === 'Target.getTargetInfo') {
        if (metadata === 'pending') return new Promise(resolve => { answerInfo = resolve; });
        if (metadata === 'failure') throw Error('metadata unavailable');
        return { targetInfo: metadata === 'foreign' ? { ...info, targetId: 'foreign' } : info };
      }
      if (method === 'Target.detachFromTarget') { if (failDetach) throw Error('transport unavailable'); return {}; }
      if (method === 'Runtime.enable') return {};
      throw Error('unknown fake command: ' + method);
    } };
  const filter = createCDPFilter({ session: upstream, ownedTargets: ['owned'] });
  return { filter, calls, emit: event => { for (const fn of listeners) fn(event); },
    pendingInfo: () => !!answerInfo, resolveInfo: () => answerInfo({ targetInfo: info }),
    pendingAttach: () => !!answerAttach, resolveAttach: () => answerAttach({ sessionId: 'acquired' }),
    failDetach(value) { failDetach = value; },
    attach: () => filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true }) };
}
const wait = async predicate => { while (!predicate()) await new Promise(resolve => setImmediate(resolve)); };
const detached = f => f.calls.filter(call => call.method === 'Target.detachFromTarget');

test('a late attach reply cannot revive a session whose detach event already proved collection', async t => {
  const f = fixture({ detachedBeforeReply: true }); t.after(() => f.filter.dispose());
  await assert.rejects(f.attach(), /CDP_SESSION_NOT_OWNED/);
  await assert.rejects(f.filter.session.send('Runtime.enable', {}, 'acquired'), /CDP_SESSION_NOT_OWNED/);
  assert.equal(await f.filter.dispose(), true); assert.deepEqual(detached(f), []);
});

for (const metadata of ['failure', 'foreign']) test('acquired attachment stays owned for cleanup after ' + metadata + ' metadata', async t => {
  const f = fixture({ metadata }); t.after(() => f.filter.dispose());
  await assert.rejects(f.attach());
  assert.equal(await f.filter.dispose(), true);
  assert.deepEqual(detached(f).map(call => [call.params.sessionId, call.route]), [['acquired', 'root']]);
});

test('dispose collects an acquired session while its metadata reply is still pending', async () => {
  const f = fixture({ metadata: 'pending' }), attaching = f.attach(); attaching.catch(() => {});
  await wait(f.pendingInfo);
  const disposed = await f.filter.dispose();
  f.resolveInfo(); await assert.rejects(attaching, /CDP_FILTER_CLOSED/);
  assert.equal(disposed, true);
  assert.deepEqual(detached(f).map(call => call.params.sessionId), ['acquired']);
});

test('failed detach retains cleanup ownership and repeated disposal retries the exact session', async () => {
  const f = fixture({ metadata: 'failure' }); f.failDetach(true);
  await assert.rejects(f.attach());
  assert.equal(await f.filter.dispose(), false);
  assert.equal(await f.filter.dispose(), false);
  f.failDetach(false); assert.equal(await f.filter.dispose(), true);
  assert.ok(detached(f).length >= 3);
  assert.ok(detached(f).every(call => call.params.sessionId === 'acquired' && call.route === 'root'));
});

test('dispose cannot report collection before an outstanding attach returns its session', async () => {
  const f = fixture({ late: true }), attaching = f.attach(); attaching.catch(() => {});
  await wait(f.pendingAttach);
  assert.equal(await f.filter.dispose(), false);
  f.resolveAttach(); await assert.rejects(attaching, /CDP_FILTER_CLOSED/);
  assert.equal(await f.filter.dispose(), true);
  assert.deepEqual(detached(f).map(call => call.params.sessionId), ['acquired']);
});

test('a failed late detach remains uncollected until an exact retry succeeds', async () => {
  const f = fixture({ late: true }), attaching = f.attach(); attaching.catch(() => {});
  await wait(f.pendingAttach); f.failDetach(true);
  await f.filter.dispose(); f.resolveAttach(); await assert.rejects(attaching, /CDP_FILTER_CLOSED/);
  assert.equal(await f.filter.dispose(), false);
  f.failDetach(false); assert.equal(await f.filter.dispose(), true);
  assert.ok(detached(f).every(call => call.params.sessionId === 'acquired'));
});

test('connection-loss detach errors preserve ownership without closing the approved connection', async () => {
  const f = fixture(); await f.attach(); f.failDetach(true);
  assert.equal(await f.filter.dispose(), false);
  f.failDetach(false); assert.equal(await f.filter.dispose(), true);
  assert.ok(f.calls.every(call => call.method !== 'Browser.close'));
});

test('destroying one child revokes its subtree while preserving its parent and sibling', async t => {
  const f = fixture(); t.after(() => f.filter.dispose()); await f.attach();
  for (const [parent, child] of [['acquired', 'child'], ['child', 'grandchild'], ['grandchild', 'greatgrandchild'], ['acquired', 'sibling']])
    f.emit({ method: 'Target.attachedToTarget', sessionId: parent, params: { sessionId: child,
      targetInfo: { targetId: child, type: 'iframe', url: 'about:blank' }, waitingForDebugger: false } });
  f.emit({ method: 'Target.targetDestroyed', params: { targetId: 'child' } });
  for (const name of ['child', 'grandchild', 'greatgrandchild']) {
    assert.equal(f.filter.owns(name), false);
    await assert.rejects(f.filter.session.send('Runtime.enable', {}, name), /CDP_SESSION_NOT_OWNED/);
  }
  await f.filter.session.send('Runtime.enable', {}, 'acquired');
  await f.filter.session.send('Runtime.enable', {}, 'sibling');
  assert.equal(f.filter.owns('owned'), true); assert.equal(f.filter.owns('sibling'), true);
});
