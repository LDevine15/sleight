import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeScheduler, stabilityGate } from '../scheduler.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const target = (pid = 10, window = 'w1', processStart = 'start1') =>
  ({ pid, processStart, window, document: 'd1', leaseGeneration: 1, policyGeneration: 1 });
const request = (changes = {}) => ({ session: 'a', runtime: 'r1', epoch: 1,
  target: target(), kind: 'mutation', surface: 'native', resources: [], timeoutMs: 1000, ...changes });
function rig(options = {}) {
  let time = 0;
  const scheduler = new NativeScheduler({
    runtimes: [{ id: 'r1', epoch: 1, processes: [target(), target(20)] },
      { id: 'r2', epoch: 1, processes: [target(), target(20)] }],
    capacity: 2, now: () => time,
    policy: () => ({ allowed: true, leaseValid: true }), ...options,
  });
  return { scheduler, tick: ms => { time += ms; scheduler.expire(); } };
}

test('same PID mutations serialize across windows and sessions', async () => {
  const { scheduler: s } = rig(); const held = deferred(); const calls = [];
  const first = s.submit(request(), () => { calls.push('first'); return held.promise; });
  const second = s.submit(request({ session: 'b', runtime: 'r2', target: target(10, 'w2') }), () => calls.push('second'));
  await flush(); assert.deepEqual(calls, ['first']); held.resolve('ok');
  assert.equal((await first.result).code, 'OK'); assert.equal((await second.result).code, 'OK');
  assert.deepEqual(calls, ['first', 'second']);
});

test('independent PIDs overlap but one runtime transport stays serial', async () => {
  for (const runtime of ['r1', 'r2']) {
    const { scheduler: s } = rig(); const held = deferred(); let started = false;
    const a = s.submit(request(), () => held.promise);
    const b = s.submit(request({ session: 'b', runtime, target: target(20) }), () => { started = true; });
    await flush(); assert.equal(started, runtime === 'r2'); held.resolve();
    await Promise.all([a.result, b.result]);
  }
});

test('wrong runtime incarnation and wrong process instance never dispatch', async () => {
  const { scheduler: s } = rig(); let calls = 0;
  for (const changes of [{ epoch: 2 }, { target: target(10, 'w1', 'reused') }, { runtime: 'missing' }]) {
    const job = s.submit(request(changes), () => calls++);
    assert.equal((await job.result).code, 'WRONG_INSTANCE');
  }
  assert.equal(calls, 0);
});

test('numeric PID remains reserved after reuse while an old mutation is unknown', async () => {
  const { scheduler: s } = rig(); const held = deferred(); let calls = 0;
  const a = s.submit(request(), () => held.promise); await flush();
  s.disconnect('r1'); assert.equal((await a.result).effect, 'unknown');
  const b = s.submit(request({ runtime: 'r2', session: 'b' }), () => calls++);
  assert.equal((await b.result).code, 'ENGINE_UNAVAILABLE'); assert.equal(calls, 0);
  assert.equal(s.snapshot().inFlight, 1); held.resolve(); await flush();
});

test('round robin gives another session admission before a busy session refills', async () => {
  const { scheduler: s } = rig({ capacity: 1 }); const held = deferred(); const order = [];
  const first = s.submit(request(), () => held.promise); await flush();
  const jobs = [s.submit(request(), () => order.push('a1')), s.submit(request(), () => order.push('a2')),
    s.submit(request({ session: 'b' }), () => order.push('b1'))];
  held.resolve(); await first.result; await Promise.all(jobs.map(j => j.result));
  assert.deepEqual(order, ['b1', 'a1', 'a2']);
});

test('coalescing is bounded and session, identity, scope and generation exact', async () => {
  const { scheduler: s } = rig({ capacity: 1, maxCoalesced: 2 }); const held = deferred(); let calls = 0;
  const a = s.submit(request(), () => held.promise); await flush();
  const read = request({ kind: 'read', readKey: 'metadata', scope: 'window' });
  const b = s.submit(read, () => { calls++; return { count: 1 }; });
  const c = s.submit(read, () => { calls++; });
  const d = s.submit(read, () => { calls++; });
  const e = s.submit({ ...read, session: 'b' }, () => { calls++; });
  const f = s.submit({ ...read, scope: 'sheet' }, () => { calls++; });
  const g = s.submit({ ...read, target: { ...target(), policyGeneration: 2 } }, () => { calls++; });
  held.resolve(); await a.result;
  await Promise.all([b, c, d, e, f, g].map(j => j.result));
  assert.equal(b.operation, c.operation); assert.notEqual(c.operation, d.operation); assert.equal(calls, 5);
});

test('mutation between reads prevents coalescing across the boundary', async () => {
  const { scheduler: s } = rig({ capacity: 1 }); const held = deferred();
  const a = s.submit(request(), () => held.promise); await flush();
  const read = request({ kind: 'read', readKey: 'x', scope: 'window' });
  const b = s.submit(read, () => 1); const c = s.submit(request(), () => 2); const d = s.submit(read, () => 3);
  assert.notEqual(b.operation, d.operation); held.resolve();
  assert.deepEqual((await Promise.all([a, b, c, d].map(j => j.result))).slice(1).map(r => r.value), [1, 2, 3]);
});

test('queued cancellation and timeout send no input', async () => {
  const { scheduler: s, tick } = rig({ capacity: 1 }); const held = deferred(); let calls = 0;
  const a = s.submit(request(), () => held.promise); await flush();
  const b = s.submit(request(), () => calls++); b.cancel();
  const c = s.submit(request({ timeoutMs: 5 }), () => calls++); tick(5);
  assert.equal((await b.result).effect, 'prepared'); assert.equal((await c.result).code, 'WAIT_TIMEOUT');
  held.resolve(); await a.result; assert.equal(calls, 0);
});

test('client deadline and cancellation never free a dispatched mutation', async () => {
  for (const cancel of [false, true]) {
    const { scheduler: s, tick } = rig(); const held = deferred(); let calls = 0;
    const a = s.submit(request({ timeoutMs: 5 }), () => held.promise); await flush();
    if (cancel) a.cancel(); else tick(5);
    assert.equal((await a.result).effect, 'unknown'); assert.equal(s.snapshot().inFlight, 1);
    const b = s.submit(request({ session: 'b', runtime: 'r2' }), () => calls++);
    await flush(); assert.equal(calls, 0); held.resolve('settled'); await b.result; assert.equal(calls, 1);
  }
});

test('revoke takes priority over dispatch and suppresses late result delivery', async () => {
  const policy = deferred(); const { scheduler: s } = rig({ policy: () => policy.promise }); let calls = 0;
  const a = s.submit(request(), () => calls++); await flush(); s.revoke('a'); policy.resolve({ allowed: true, leaseValid: true });
  assert.equal((await a.result).code, 'REVOKED'); await flush(); assert.equal(calls, 0);
  const { scheduler: t } = rig(); const held = deferred();
  const b = t.submit(request(), () => held.promise); await flush(); t.revoke('a');
  assert.equal((await b.result).effect, 'unknown'); assert.equal(t.snapshot().inFlight, 1);
  held.resolve('private'); await flush(); assert.equal(t.snapshot().inFlight, 0);
  assert.equal((await t.submit(request(), () => calls++).result).code, 'REVOKED');
});

test('cancelled admission releases its slot even when the policy check never returns', async () => {
  const policy = deferred(); let checks = 0;
  const { scheduler: s } = rig({ capacity: 1, policy: () => ++checks === 1 ? policy.promise :
    { allowed: true, leaseValid: true } });
  const a = s.submit(request(), () => assert.fail('cancelled dispatch')); await flush(); a.cancel();
  await a.result;
  const b = s.submit(request({ session: 'b' }), () => 'ok');
  assert.equal((await b.result).value, 'ok'); policy.resolve({ allowed: true, leaseValid: true }); await flush();
});

test('automatic client timer retains dispatched reservations without a manual expire call', async () => {
  let fire; const { scheduler: s } = rig({ setTimer: callback => { fire = callback; return 1; }, clearTimer: () => {} });
  const held = deferred(); const a = s.submit(request(), () => held.promise); await flush();
  fire(); assert.equal((await a.result).code, 'WAIT_TIMEOUT'); assert.equal(s.snapshot().inFlight, 1);
  held.resolve(); await flush(); assert.equal(s.snapshot().inFlight, 0);
});

test('mutation serialization failure cannot strand an unresolved client or release unknown input', async () => {
  const { scheduler: s } = rig();
  const a = s.submit(request(), () => () => 'not serializable');
  assert.equal((await a.result).code, 'EFFECT_UNKNOWN'); assert.equal(s.snapshot().inFlight, 1);
});

test('dispatch rechecks authoritative lease and policy without acquiring a grant', async () => {
  let allowed = true; const { scheduler: s } = rig({ capacity: 1,
    policy: () => ({ allowed, leaseValid: allowed }) });
  const held = deferred(); let calls = 0;
  const a = s.submit(request(), () => held.promise); await flush();
  const b = s.submit(request({ session: 'b' }), () => calls++); allowed = false; held.resolve();
  await a.result; assert.equal((await b.result).code, 'LEASE_BUSY'); assert.equal(calls, 0);
});

test('an engine policy decline cannot be replaced by a valid broker lease', async () => {
  const { scheduler: s } = rig({ policy: () => ({ allowed: false, leaseValid: true }) }); let calls = 0;
  assert.equal((await s.submit(request(), () => calls++).result).code, 'DENIED'); assert.equal(calls, 0);
});

test('reads cannot pass an in-flight mutation on the same process', async () => {
  const { scheduler: s } = rig(); const held = deferred(); let reads = 0;
  const a = s.submit(request(), () => held.promise); await flush();
  const b = s.submit(request({ session: 'b', runtime: 'r2', target: target(10, 'w2'),
    kind: 'read', readKey: 'state', scope: 'window' }), () => reads++);
  await flush(); assert.equal(reads, 0); held.resolve(); await Promise.all([a.result, b.result]); assert.equal(reads, 1);
});

test('clipboard, desktop, modal and explicit handoff barriers exclude all other apps and surfaces', async () => {
  for (const changes of [{ resources: ['clipboard'] }, { resources: ['desktop'] },
    { resources: ['modal'] }, { kind: 'barrier', surface: 'browser' }]) {
    const { scheduler: s } = rig(); const held = deferred(); let calls = 0;
    const a = s.submit(request(changes), () => held.promise); await flush();
    const b = s.submit(request({ runtime: 'r2', session: 'b', target: target(20), surface: 'browser' }), () => calls++);
    await flush(); assert.equal(calls, 0); held.resolve(); await a.result; await b.result; assert.equal(calls, 1);
  }
});

test('an older exclusive barrier cannot starve behind newly submitted independent work', async () => {
  const { scheduler: s } = rig(); const held = deferred(); const order = [];
  const a = s.submit(request(), () => held.promise); await flush();
  const b = s.submit(request({ session: 'b', resources: ['clipboard'] }), () => order.push('barrier'));
  const c = s.submit(request({ session: 'c', runtime: 'r2', target: target(20) }), () => order.push('later'));
  await flush(); assert.deepEqual(order, []); held.resolve(); await Promise.all([a.result, b.result, c.result]);
  assert.deepEqual(order, ['barrier', 'later']);
});

test('mutation failure is indeterminate, reserved and never automatically replayed', async () => {
  const { scheduler: s } = rig(); let calls = 0;
  const a = s.submit(request(), () => { calls++; throw new Error('lost reply'); });
  assert.equal((await a.result).code, 'EFFECT_UNKNOWN'); assert.equal(s.snapshot().inFlight, 1);
  const b = s.submit(request({ session: 'b', runtime: 'r2' }), () => calls++);
  await flush(); assert.equal(calls, 1); b.cancel(); await b.result;
  assert.throws(() => s.confirmCompletion(a.operation, { collected: false, effect: 'observed' }));
  s.confirmCompletion(a.operation, { collected: true, effect: 'observed' }); assert.equal(s.snapshot().inFlight, 0);
  assert.deepEqual(s.snapshot().cleanupReceipts, [{ operation: a.operation, collected: true, effect: 'observed' }]);
});

test('first connection crash stops the cohort and keeps unknown effects and cleanup receipts', async () => {
  const { scheduler: s } = rig(); const held = deferred(); let calls = 0;
  const a = s.submit(request(), () => held.promise); await flush();
  const b = s.submit(request(), () => calls++); s.disconnect('r1');
  assert.equal((await a.result).effect, 'unknown'); assert.equal((await b.result).code, 'ENGINE_UNAVAILABLE');
  assert.equal((await s.submit(request({ runtime: 'r2' }), () => calls++).result).code, 'ENGINE_UNAVAILABLE');
  assert.equal(calls, 0); assert.equal(s.snapshot().failures, 1); held.resolve(); await flush();
  assert.equal(s.snapshot().stopped, true);
});

test('closed-pipe fake throws stop the cohort once without replaying the failed mutation', async () => {
  const { scheduler: s } = rig(); let calls = 0;
  const a = s.submit(request(), () => { calls++; throw Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' }); });
  assert.equal((await a.result).code, 'EFFECT_UNKNOWN'); assert.equal(calls, 1);
  assert.equal(s.snapshot().failures, 1); assert.equal(s.snapshot().stopped, true); assert.equal(s.snapshot().inFlight, 1);
});

test('admission receipts distinguish wait and public wall time; queue/service and host resources stay unknown', async () => {
  const { scheduler: s, tick } = rig({ capacity: 1 }); const held = deferred();
  const a = s.submit(request(), () => held.promise); await flush(); tick(20);
  const b = s.submit(request(), () => { tick(7); return 3; }); tick(10); held.resolve();
  await a.result; const r = await b.result;
  assert.equal(r.admissionWaitMs, 10); assert.equal(r.publicWallMs, 17);
  assert.equal(r.queueMs, null); assert.equal(r.serviceMs, null);
  assert.equal(s.snapshot().cpu, null); assert.equal(s.snapshot().rss, null);
});

test('queue bound and unknown request fields fail closed', async () => {
  const { scheduler: s } = rig({ capacity: 1, maxQueued: 1 }); const held = deferred();
  const a = s.submit(request(), () => held.promise); await flush(); const b = s.submit(request(), () => 1);
  assert.equal((await s.submit(request(), () => 2).result).code, 'QUEUE_FULL');
  assert.throws(() => s.submit(request({ approval: true }), () => 3));
  held.resolve(); await Promise.all([a.result, b.result]);
});

test('runtime experiment cap is separate from complete 1/4/13 claim qualification', () => {
  assert.throws(() => rig({ capacity: 3 }));
  assert.equal(stabilityGate({}).experimentAllowed, false);
  const proof = { supportedBuild: true, diagnosticApproved: true, cleanControls: true,
    addressable: true, independentRuntimes: 2, samples: [1, 4, 13].map(n => ({ n, complete: true,
      failures: 0, cleanup: true })) };
  assert.equal(stabilityGate(proof).experimentAllowed, true);
  assert.equal(stabilityGate(proof).parallelStabilityQualified, true);
  assert.equal(stabilityGate(proof).parallelSpeedClaimQualified, false);
  assert.equal(stabilityGate({ ...proof, samples: proof.samples.slice(0, 2) }).parallelStabilityQualified, false);
  assert.equal(stabilityGate({ ...proof, independentRuntimes: 4 }).experimentAllowed, false);
  assert.equal(stabilityGate({ ...proof, samples: [{ n: 1, complete: true, failures: 1, cleanup: true }] }).experimentAllowed, false);
});
