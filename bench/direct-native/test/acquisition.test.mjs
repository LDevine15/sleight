import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition, CapabilityCache } from '../acquisition.mjs';

// Launcher and adapter are trusted integration seams, not extra engine APIs. The only
// engine methods in this fixture are getApp, click and typeText. Everything else throws.
function fixture(options = {}) {
  let clock = 0, grants = 0;
  const calls = [], invalidations = [];
  const binding = { sessionId: 's1', runtimeEpoch: 1, appId: 'org.fixture.editor', pid: 91,
    appName: 'Fixture Editor', processStart: 100, windowId: 7, documentId: 'd1', leaseGeneration: 1, policyGeneration: 1 };
  const app = new Proxy({
    click: async n => { calls.push(['click', n]); },
    typeText: async text => { calls.push(['typeText', text]); },
  }, { get: (target, name) => {
    if (name === 'then') return;
    if (!(name in target)) throw new Error(`Engine app has no ${String(name)}`);
    return target[name];
  } });
  const engine = new Proxy({ getApp: async name => {
    calls.push(['getApp', name]); clock += 30;
    if (options.denied) throw Object.assign(new Error('private reason'), { code: 'DENIED' });
    if (!grants) grants++;
    await options.acquiring?.();
    return app;
  } }, { get: (target, name) => {
    if (!(name in target)) throw new Error(`Engine has no ${String(name)}`);
    return target[name];
  } });
  const launcher = {
    start: async () => { calls.push(['start']); clock += 5; return { owned: true, helperState: options.helperState ?? 'cold' }; },
    connect: async () => { calls.push(['connect']); clock += 10;
      return { buildKey: options.buildKey ?? 'b1', protocolKey: 'p1', runtimeEpoch: 1 }; },
    dispose: async () => { calls.push(['dispose']); },
  };
  const adapter = {
    capabilities: async () => { calls.push(['capabilities']); return 'immutable API'; },
    instructions: async () => options.instructions ?? 'Mandatory policy instructions',
    acquire: async (_connection, name) => ({ handle: await engine.getApp(name), binding: { ...binding }, observation: 'initial tree' }),
    binding: async () => { calls.push(['binding']); return { binding: { ...binding }, allowed: !options.revoked }; },
    execute: async (_connection, handle, actions, context) => {
      calls.push(['execute', context.turnId]);
      for (const action of actions) await handle[action.method](...action.args);
      return 'guarded action receipt';
    },
  };
  const lane = new NativeAcquisition({ sessionId: 's1', launcher, adapter, now: () => clock,
    invalidate: reason => invalidations.push(reason), cache: options.cache });
  return { lane, calls, invalidations, binding, options, launcher, adapter, grants: () => grants,
    deliver: async () => { clock += 2; } };
}
const request = { app: 'org.fixture.editor', turnId: 't1' };

test('named acquisition does no inventory or duplicate initial read and separates public phases', async () => {
  const f = fixture();
  const r = await f.lane.open(request, f.deliver);
  assert.equal(r.result.observation, 'initial tree');
  assert.equal(r.result.instructions, 'Mandatory policy instructions');
  assert.equal(r.receipt.state, 'cold');
  assert.deepEqual(r.receipt.ms, { launcher: 5, connectionReady: 10, preApprovalBracket: null,
    publicAcquisition: 30, resultDelivery: 2, total: 47, policy: null, internalCapture: null, nativeQueue: null });
  assert.equal(r.receipt.initialObservationIncluded, true);
  assert.deepEqual(f.calls.filter(c => ['start', 'connect', 'getApp'].includes(c[0])),
    [['start'], ['connect'], ['getApp', request.app]]);
  assert.equal(r.receipt.cpuSeconds, null); assert.equal(r.receipt.rssBytes, null);
  await f.lane.shutdown();
});

test('retained handle keeps session grant and turn identity without stale initial observation', async () => {
  const f = fixture();
  await f.lane.open({ ...request, actions: [{ method: 'click', args: [2] }] });
  const text = 'Exact\n  input 🎯';
  const r = await f.lane.open({ ...request, turnId: 't2', actions: [{ method: 'typeText', args: [text] }] });
  assert.equal(r.receipt.state, 'runtime-warm'); assert.equal(r.receipt.retained, true);
  assert.equal(r.result.observation, null); assert.equal(r.result.capabilities, null);
  assert.equal(f.grants(), 1); assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 1);
  assert.deepEqual(f.calls.filter(c => ['click', 'typeText', 'execute'].includes(c[0])),
    [['execute', 't1'], ['click', 2], ['execute', 't2'], ['typeText', text]]);
  await f.lane.shutdown();
});

for (const field of ['pid', 'processStart', 'windowId', 'documentId', 'runtimeEpoch', 'leaseGeneration', 'policyGeneration']) {
  test(`${field} change retires handle and references without selecting a replacement`, async () => {
    const f = fixture(); await f.lane.open(request); f.binding[field] = 'replacement';
    await assert.rejects(f.lane.open(request), { code: 'TARGET_STALE' });
    assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 1);
    assert.equal(f.invalidations.length, 1); await f.lane.shutdown();
  });
}

test('explicit reset invalidates references, owns cleanup and needs new acquisition', async () => {
  const f = fixture(); await f.lane.open(request); await f.lane.reset();
  assert.equal(f.calls.filter(c => c[0] === 'dispose').length, 1);
  await f.lane.open(request);
  assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 2);
  assert.equal(f.invalidations.length, 1); await f.lane.shutdown();
});

test('a decline stops its request without caching a denial across eligible turns', async () => {
  const f = fixture({ denied: true });
  await assert.rejects(f.lane.open(request), { code: 'DENIED' });
  assert.equal(f.grants(), 0); assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 1);
  f.options.denied = false;
  await f.lane.open({ ...request, turnId: 't2' });
  assert.equal(f.grants(), 1); assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 2);
  await f.lane.reset(); f.options.denied = true;
  await assert.rejects(f.lane.open({ ...request, turnId: 't3' }), { code: 'DENIED' });
  f.options.denied = false;
  await f.lane.open({ ...request, turnId: 't4' });
  await f.lane.shutdown();
});

test('revocation blocks a retained handle and suppresses delivery', async () => {
  const f = fixture(); await f.lane.open(request); f.options.revoked = true;
  let deliveries = 0;
  await assert.rejects(f.lane.open(request, () => deliveries++), { code: 'DENIED' });
  assert.equal(deliveries, 0); await f.lane.shutdown();
});

test('reset racing acquisition drops late result and closes only owned runtime', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ acquiring: () => { entered(); return pending; } });
  let deliveries = 0;
  const opening = f.lane.open(request, () => deliveries++);
  await waiting; const resetting = f.lane.reset(); release();
  await assert.rejects(opening, { code: 'TARGET_STALE' }); await resetting;
  assert.equal(deliveries, 0); assert.equal(f.calls.filter(c => c[0] === 'dispose').length, 1);
  await f.lane.shutdown();
});

test('build-keyed static text cache excludes current policy and session permission', async () => {
  const cache = new CapabilityCache();
  const a = fixture({ cache }); await a.lane.open(request); await a.lane.shutdown();
  const b = fixture({ cache, instructions: 'Changed mandatory policy' });
  const r = await b.lane.open(request);
  assert.equal(b.calls.filter(c => c[0] === 'capabilities').length, 0);
  assert.equal(r.result.capabilities, 'immutable API'); assert.equal(r.result.instructions, 'Changed mandatory policy');
  assert.equal(b.grants(), 1); await b.lane.shutdown();
  const c = fixture({ cache, buildKey: 'b2' }); await c.lane.open(request);
  assert.equal(c.calls.filter(c => c[0] === 'capabilities').length, 1); await c.lane.shutdown();
});

test('authorized runtime warmup reads no app and accounts moved and unused time', async () => {
  const f = fixture({ helperState: 'warm' });
  await assert.rejects(f.lane.warmup(), { code: 'APPROVAL_REQUIRED' });
  assert.equal(f.calls.length, 0);
  await f.lane.warmup({ independentWorkAuthorized: true });
  assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 0);
  assert.deepEqual(f.lane.accounting(), { warmups: 1, unusedWarmups: 1, movedMs: 15, elapsedTaskSavingsMs: null });
  const r = await f.lane.open(request);
  assert.equal(r.receipt.state, 'runtime-warm'); assert.equal(f.lane.accounting().unusedWarmups, 0);
  await f.lane.shutdown();
  const cold = fixture({ helperState: 'warm' });
  assert.equal((await cold.lane.open(request)).receipt.state, 'shared-helper-warm'); await cold.lane.shutdown();
});

test('shutdown is idempotent and closed route does not launch', async () => {
  const f = fixture(); await f.lane.open(request); await f.lane.shutdown(); await f.lane.shutdown();
  assert.equal(f.calls.filter(c => c[0] === 'dispose').length, 1);
  await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
});

test('optional public pre-approval bracket is measured without attributing policy-only cost', async () => {
  const f = fixture();
  f.adapter.preApproval = async () => {};
  const r = await f.lane.open(request);
  assert.equal(r.receipt.ms.preApprovalBracket, 0); assert.equal(r.receipt.ms.policy, null);
  await f.lane.shutdown();
});

test('a missing or mismatched app cannot silently become another app', async () => {
  const f = fixture(); f.binding.appId = 'org.fixture.other';
  await assert.rejects(f.lane.open(request), { code: 'TARGET_STALE' }); await f.lane.shutdown();
  const missing = fixture(); missing.adapter.acquire = async () => null;
  await assert.rejects(missing.lane.open(request), { code: 'TARGET_STALE' }); await missing.lane.shutdown();
});

test('a retired process cannot be reacquired by the next call without explicit reset', async () => {
  const f = fixture(); await f.lane.open(request); f.binding.pid++;
  await assert.rejects(f.lane.open(request), { code: 'TARGET_STALE' });
  await assert.rejects(f.lane.open(request), { code: 'TARGET_STALE' });
  assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 1);
  await f.lane.reset(); await f.lane.open(request); await f.lane.shutdown();
});

test('a lost action reply records unknown effect and never resends input', async () => {
  const f = fixture();
  f.adapter.execute = async () => { f.calls.push(['dispatched']); throw new Error('private document contents'); };
  const actions = [{ method: 'click', args: [2] }];
  const error = await f.lane.open({ ...request, actions }).catch(error => error);
  assert.equal(error.code, 'ENGINE_UNAVAILABLE'); assert.equal(error.receipt.effect, 'unknown');
  assert.equal(error.message, 'ENGINE_UNAVAILABLE');
  await assert.rejects(f.lane.open({ ...request, actions }), { code: 'ENGINE_UNAVAILABLE' });
  assert.equal(f.calls.filter(c => c[0] === 'dispatched').length, 1); await f.lane.shutdown();
});

test('a declined action with unknown effect fences dispatch until reset without caching decline', async () => {
  const f = fixture();
  f.adapter.execute = async () => { throw Object.assign(new Error('decline'), { code: 'DENIED' }); };
  await assert.rejects(f.lane.open({ ...request, actions: [{ method: 'click', args: [2] }] }), { code: 'DENIED' });
  await assert.rejects(f.lane.open({ ...request, turnId: 't2' }), { code: 'ENGINE_UNAVAILABLE' });
  await f.lane.reset();
  await f.lane.open({ ...request, turnId: 't3' }); await f.lane.shutdown();
});

test('a borrowed launcher resource is refused and never disposed or connected', async () => {
  const f = fixture(); f.launcher.start = async () => ({ owned: false });
  await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' }); await f.lane.shutdown();
  assert.equal(f.calls.length, 0);
});

test('concurrent acquisition is refused rather than creating another runtime', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ acquiring: () => { entered(); return pending; } });
  const opening = f.lane.open(request); await waiting;
  await assert.rejects(f.lane.open(request), { code: 'LEASE_BUSY' }); release(); await opening;
  assert.equal(f.calls.filter(c => c[0] === 'start').length, 1); await f.lane.shutdown();
});

test('an explicit app name acquires directly and retains its canonical process identity', async () => {
  const f = fixture();
  await f.lane.open({ ...request, app: 'Fixture Editor' });
  await f.lane.open({ ...request, app: 'Fixture Editor' });
  assert.deepEqual(f.calls.filter(c => c[0] === 'getApp'), [['getApp', 'Fixture Editor']]);
  await f.lane.shutdown();
});

test('failed initialization disposes its exact owned start before a replacement', async () => {
  const f = fixture(), starts = [], disposed = []; let connects = 0;
  f.launcher.start = async () => { const r = { owned: true, id: starts.length + 1 }; starts.push(r); return r; };
  f.launcher.dispose = async r => { disposed.push(r); };
  f.launcher.connect = async () => {
    if (++connects === 1) throw Error('failed connect');
    return { buildKey: 'b1', protocolKey: 'p1', runtimeEpoch: 1 };
  };
  await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
  await f.lane.open(request); await f.lane.shutdown();
  assert.deepEqual(disposed, starts);
});

test('failed cleanup retains ownership and blocks another start until exact disposal succeeds', async () => {
  const f = fixture(), r = { owned: true, id: 1 }; let starts = 0, failCleanup = true;
  f.launcher.start = async () => { starts++; return r; };
  f.launcher.connect = async () => { throw Error('failed connect'); };
  f.launcher.dispose = async owned => {
    assert.equal(owned, r);
    if (failCleanup) throw Error('cleanup unavailable');
  };
  await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
  await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
  assert.equal(starts, 1);
  await assert.rejects(f.lane.reset());
  await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
  assert.equal(starts, 1);
  failCleanup = false; await f.lane.shutdown(); await f.lane.shutdown();
  assert.equal(starts, 1);
});

for (const field of ['buildKey', 'protocolKey', 'runtimeEpoch']) {
  const invalid = field === 'runtimeEpoch' ? [undefined, null, '', ' ', 0, -1, NaN, Infinity, {}, true] : [undefined, null, '', ' ', 3, {}, true];
  for (const value of invalid) test(`invalid ${field} ${String(value)} never publishes a ready connection`, async () => {
    const f = fixture(); let disposed = 0;
    f.launcher.connect = async () => ({ buildKey: 'b1', protocolKey: 'p1', runtimeEpoch: 1, [field]: value });
    f.launcher.dispose = async () => { disposed++; };
    await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
    await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
    assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 0);
    await f.lane.shutdown(); assert.equal(disposed, 2);
  });
}

test('a failed reset cannot leave a cached ready connection usable', async () => {
  const f = fixture(); await f.lane.open(request); let failed = true;
  f.launcher.dispose = async () => { if (failed) throw Error('retained cleanup'); };
  await assert.rejects(f.lane.reset());
  await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
  assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
  failed = false; await f.lane.reset(); await f.lane.open(request); await f.lane.shutdown();
});

for (const owned of [true, false]) test(`reset racing a late ${owned ? 'owned' : 'borrowed'} start preserves cleanup ownership`, async () => {
  const f = fixture(); let release, entered;
  const starting = new Promise(resolve => { entered = resolve; });
  f.launcher.start = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const opening = f.lane.open(request); await starting;
  const resetting = f.lane.reset(); release({ owned });
  await assert.rejects(opening); await resetting; await f.lane.shutdown();
  assert.equal(f.calls.filter(c => c[0] === 'dispose').length, owned ? 1 : 0);
  assert.equal(f.calls.filter(c => c[0] === 'connect' || c[0] === 'getApp').length, 0);
});

test('reset during connection setup drops the late handshake before acquisition', async () => {
  const f = fixture(); let release, entered;
  const connecting = new Promise(resolve => { entered = resolve; });
  f.launcher.connect = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const opening = f.lane.open(request); await connecting;
  const resetting = f.lane.reset(); release({ buildKey: 'b1', protocolKey: 'p1', runtimeEpoch: 1 });
  await assert.rejects(opening, { code: 'TARGET_STALE' }); await resetting; await f.lane.shutdown();
  assert.equal(f.calls.filter(c => c[0] === 'dispose').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 0);
});

test('retained once/session approvals are checked with each current turn by the trusted adapter', async () => {
  for (const mode of ['once', 'session']) {
    const f = fixture(), turns = [];
    f.adapter.binding = async (_connection, _handle, context) => {
      turns.push(context?.turnId);
      return { allowed: mode === 'session' || context?.turnId === 't1', binding: { ...f.binding } };
    };
    await f.lane.open(request);
    if (mode === 'once') await assert.rejects(f.lane.open({ ...request, turnId: 't2' }), { code: 'DENIED' });
    else await f.lane.open({ ...request, turnId: 't2' });
    assert.deepEqual(turns, ['t1', 't1', ...(mode === 'once' ? ['t2'] : ['t2', 't2'])]);
    await f.lane.shutdown();
  }
});

test('forbidden policy refusal remains a fence across reset', async () => {
  const f = fixture();
  f.adapter.acquire = async () => { throw Object.assign(Error('forbidden'), { code: 'FORBIDDEN' }); };
  await assert.rejects(f.lane.open(request), { code: 'FORBIDDEN' }); await f.lane.reset();
  await assert.rejects(f.lane.open({ ...request, turnId: 't2' }), { code: 'FORBIDDEN' });
  await f.lane.shutdown();
});

test('warmup cannot turn later invalid connection metadata into usable acquisition', async () => {
  const f = fixture(), connection = { buildKey: 'b1', protocolKey: 'p1', runtimeEpoch: 1 };
  f.launcher.connect = async () => connection;
  await f.lane.warmup({ independentWorkAuthorized: true }); connection.buildKey = '';
  await assert.rejects(f.lane.open(request), { code: 'ENGINE_UNAVAILABLE' });
  assert.equal(f.calls.filter(c => c[0] === 'getApp').length, 0); await f.lane.shutdown();
});

test('failed warmup retains failed-cleanup ownership through shutdown retries', async () => {
  const f = fixture(); let starts = 0, disposed = 0, cleanupFails = true;
  f.launcher.start = async () => { starts++; return { owned: true }; };
  f.launcher.connect = async () => null;
  f.launcher.dispose = async () => { if (cleanupFails) throw Error('failed cleanup'); disposed++; };
  await assert.rejects(f.lane.warmup({ independentWorkAuthorized: true }));
  await assert.rejects(f.lane.warmup({ independentWorkAuthorized: true }));
  await assert.rejects(f.lane.shutdown());
  assert.equal(starts, 1); assert.equal(disposed, 0);
  cleanupFails = false; await f.lane.shutdown(); await f.lane.shutdown();
  assert.equal(disposed, 1);
});
