import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Lifecycle } from '../lifecycle.mjs';
import { TakeoverControls } from '../takeover.mjs';
import { NativeHandoff } from '../handoff.mjs';

export const browser = { incarnation: 'browser-1', brokerEpoch: 'broker-1', endpoint: 'ws://127.0.0.1:9222/devtools/browser/one' };
export const identity = (extra = {}) => ({ ...browser, session: 's1', turn: 'turn-1', targetId: 'page-1',
  targetGeneration: 1, leaseGeneration: 1, frame: 'frame-1', document: 'doc-1', origin: 'https://example.test', ...extra });
const grant = Object.freeze({ from: 'fixture host authority' });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

export class FakeCDP extends EventEmitter {
  calls = [];
  targets = new Set(['page-1', 'user-page', 'kept-page']);
  sessionId = 'fake-browser-session';
  closeAccepted = true;
  removeOnClose = true;
  async send(method, args = {}) {
    this.calls.push({ method, args });
    if (method === 'Target.closeTarget') {
      if (this.closeAccepted && this.removeOnClose) this.targets.delete(args.targetId);
      return { success: this.closeAccepted };
    }
    if (method === 'Target.getTargets') return { targetInfos: [...this.targets].map((targetId) => ({ targetId })) };
    if (method === 'Input.dispatchKeyEvent') return {};
    throw new Error(`unsupported fake CDP method: ${method}`);
  }
}

async function setup(extra = {}) {
  const cdp = new FakeCDP();
  const current = new Map([['page-1', identity()]]);
  const dispatched = [];
  let journal;
  const lane = new Lifecycle({
    verifyAuthority: async (proof) => proof === grant,
    verifyConnection: async (proof) => proof === grant,
    observeTarget: async (id) => cdp.targets.has(id) ? current.get(id) : null,
    dispatch: async (operation) => { dispatched.push(operation); return { phase: 'verified', effect: 'verified', completed: [0] }; },
    saveJournal: (value) => { journal = structuredClone(value); return true; },
    timeoutMs: 50,
    ...extra,
  });
  await lane.connect(cdp, browser, grant);
  const hook = lane.beginTurn('s1', 'turn-1', 'frontend-1');
  const lease = lane.track(identity(), { owned: true, ephemeral: true });
  return { lane, cdp, current, dispatched, hook, lease, journal: () => journal };
}

const operation = { operation: 'op-1', op: 'key', args: { key: 'Enter' } };

test('default connection and authority adapters refuse, never infer browser consent', async () => {
  const lane = new Lifecycle();
  await assert.rejects(lane.connect(new FakeCDP(), browser, { approved: true }), /CONNECTION_APPROVAL_REQUIRED/);
});

test('receipt separates preparation, dispatch, verification and untouched suffix', async () => {
  const { lane, lease, dispatched } = await setup();
  const token = lane.prepare(lease, { ...operation, count: 2 });
  assert.equal(lane.receipt(token).phase, 'prepared');
  assert.equal(lane.receipt(token).effect, 'none');
  const result = await lane.dispatch(token, grant);
  assert.equal(result.phase, 'verified');
  assert.deepEqual(result.completed, [0]);
  assert.deepEqual(result.notAttempted, [1]);
  assert.equal(dispatched.length, 1);
});

for (const reason of ['broker-crash', 'browser-restart', 'setting-off', 'permission-revoke', 'ipc-replacement', 'socket-loss']) {
  test(`${reason} fences prepared work and invalidates refs and leases`, async () => {
    const { lane, lease, dispatched } = await setup();
    const token = lane.prepare(lease, operation);
    lane.loseConnection(reason);
    assert.equal((await lane.dispatch(token, grant)).effect, 'none');
    assert.equal(dispatched.length, 0);
    assert.throws(() => lane.prepare(lease, { ...operation, operation: 'new' }), /LEASE_LOST/);
    assert.equal(lane.state.connection, 'disconnected');
    assert.equal(lane.state.needsChromeConsent, true);
    assert.equal(lane.state.refEpoch, 1);
  });
}

test('unknown dispatched effect survives a late receipt and reconnect without replay', async () => {
  const pending = deferred();
  const { lane, lease, cdp } = await setup({ dispatch: () => pending.promise });
  const token = lane.prepare(lease, operation);
  const running = lane.dispatch(token, grant);
  await new Promise((r) => setImmediate(r));
  assert.equal(lane.receipt(token).phase, 'dispatched');
  cdp.emit('disconnected');
  pending.resolve({ phase: 'verified', effect: 'verified', completed: [0] });
  assert.equal((await running).effect, 'unknown');
  const replacement = new FakeCDP();
  await assert.rejects(lane.connect(replacement, { ...browser, brokerEpoch: 'broker-2' }, { approved: true }), /CONNECTION_APPROVAL_REQUIRED/);
  await lane.connect(replacement, { ...browser, brokerEpoch: 'broker-2' }, grant);
  assert.equal((await lane.dispatch(token, grant)).effect, 'unknown');
  assert.equal(replacement.calls.length, 0);
});

test('slow authority cannot let queued dispatch cross a pause fence', async () => {
  const decision = deferred();
  const { lane, lease, dispatched } = await setup({ verifyAuthority: () => decision.promise });
  const token = lane.prepare(lease, operation);
  const running = lane.dispatch(token, grant);
  lane.pause('native-pause');
  decision.resolve(true);
  assert.equal((await running).effect, 'none');
  assert.equal(dispatched.length, 0);
});

test('operation authority binds immutable exact args; raw CDP and forged tokens refuse', async () => {
  const { lane, lease, dispatched } = await setup();
  const args = { key: 'Enter' };
  const token = lane.prepare(lease, { ...operation, args });
  args.key = 'Delete';
  await lane.dispatch(token, grant);
  assert.equal(dispatched[0].args.key, 'Enter');
  assert.throws(() => lane.prepare(lease, { ...operation, op: 'Runtime.evaluate' }), /UNSUPPORTED_OPERATION/);
  await assert.rejects(lane.dispatch({ operation: 'op-1', approved: true }, grant), /UNKNOWN_OPERATION/);
  assert.throws(() => lane.prepare(lease, { ...operation, args: { key: 'Delete' } }), /OPERATION_ID_REUSED/);
});

test('denied action does not dispatch or leak private args into receipts', async () => {
  const { lane, lease, dispatched } = await setup();
  const token = lane.prepare(lease, { ...operation, args: { value: 'fixture-private-value' } });
  const result = await lane.dispatch(token, { approved: true });
  assert.equal(result.code, 'PERMISSION_REQUIRED');
  assert.equal(dispatched.length, 0);
  assert.equal(JSON.stringify(result).includes('fixture-private-value'), false);
});

test('native Pause is authenticated; page isTrusted cannot claim human takeover', async () => {
  const { lane, lease } = await setup();
  const controls = new TakeoverControls(lane);
  assert.equal(controls.pageInput({ isTrusted: true }).automaticTakeover, false);
  assert.equal((await controls.handle('pause', { approved: true })).accepted, false);
  assert.equal(lane.state.connection, 'connected');
  await controls.handle('pause', grant);
  assert.throws(() => lane.prepare(lease, operation), /LEASE_LOST/);
  assert.equal(lane.state.connection, 'paused');
});

test('explicit resume needs fresh state and issues a new lease epoch', async () => {
  const { lane, lease, current } = await setup();
  lane.pause('native-pause');
  await assert.rejects(lane.resume(lease, { approved: true }), /PERMISSION_REQUIRED/);
  current.set('page-1', identity({ document: 'doc-2' }));
  const fresh = await lane.resume(lease, grant);
  assert.equal(lane.describe(fresh).leaseGeneration, 2);
  assert.equal(lane.describe(fresh).document, 'doc-2');
  assert.throws(() => lane.prepare(lease, operation), /LEASE_LOST/);
  assert.equal((await lane.dispatch(lane.prepare(fresh, operation), grant)).effect, 'verified');
});

test('frontend death parks its targets and fences work without dropping shared socket', async () => {
  const { lane, lease } = await setup();
  lane.frontendLost('s1', 'frontend-1');
  assert.throws(() => lane.prepare(lease, operation), /LEASE_LOST/);
  assert.equal(lane.state.connection, 'connected');
  assert.equal(lane.records[0].status, 'parked');
});

test('stale, forged and cross-session turn hooks cannot close targets', async () => {
  const { lane, cdp, hook } = await setup();
  for (const bad of [{ ...hook, nonce: 'forged' }, { ...hook, session: 'other' }, { ...hook, brokerEpoch: 'old' }]) {
    await assert.rejects(lane.endTurn(bad), /STALE_HOOK/);
  }
  lane.beginTurn('s1', 'turn-2', 'frontend-1');
  await assert.rejects(lane.endTurn(hook), /STALE_HOOK/);
  assert.equal(cdp.calls.length, 0);
});

test('cleanup preserves user/kept/parked tabs and another session', async () => {
  const { lane, cdp, hook } = await setup();
  lane.track(identity({ targetId: 'user-page' }), { owned: false });
  const kept = lane.track(identity({ targetId: 'kept-page' }), { owned: true, ephemeral: true });
  lane.keep(kept);
  lane.beginTurn('s2', 'turn-1', 'frontend-2');
  lane.track(identity({ session: 's2', targetId: 'other-page' }), { owned: true, ephemeral: true });
  const receipts = await lane.endTurn(hook);
  assert.equal(receipts.find((r) => r.targetId === 'page-1').status, 'closed');
  assert.equal(receipts.find((r) => r.targetId === 'user-page').status, 'released');
  assert.equal(receipts.find((r) => r.targetId === 'kept-page').status, 'released');
  assert.deepEqual(cdp.calls.filter((c) => c.method === 'Target.closeTarget').map((c) => c.args.targetId), ['page-1']);
  assert.ok(lane.records.some((r) => r.session === 's2'));
});

for (const mode of ['denied', 'still-present', 'already-gone', 'reused-id']) {
  test(`cleanup ${mode} distinguishes close request from exact absence proof`, async () => {
    const { lane, cdp, current, hook } = await setup();
    if (mode === 'denied') cdp.closeAccepted = false;
    if (mode === 'still-present') cdp.removeOnClose = false;
    if (mode === 'already-gone') cdp.targets.delete('page-1');
    if (mode === 'reused-id') current.set('page-1', identity({ targetGeneration: 2 }));
    const [result] = await lane.endTurn(hook);
    assert.equal(result.status, mode === 'already-gone' ? 'already-gone' : 'retained');
    assert.equal(lane.records.length, mode === 'already-gone' ? 0 : 1);
    if (['already-gone', 'reused-id'].includes(mode)) assert.equal(cdp.calls.filter((c) => c.method === 'Target.closeTarget').length, 0);
  });
}

test('lost socket during close retains ownership, even with a late successful reply', async () => {
  const { lane, cdp, hook } = await setup();
  const pending = deferred();
  cdp.send = async (method) => {
    assert.equal(method, 'Target.closeTarget');
    cdp.emit('disconnected');
    return pending.promise;
  };
  const cleanup = lane.endTurn(hook);
  await new Promise((r) => setImmediate(r));
  pending.resolve({ success: true });
  const [receipt] = await cleanup;
  assert.equal(receipt.effect, 'unknown');
  assert.equal(lane.records.length, 1);
});

test('bounded hung dispatch returns unknown and keeps pending loss evidence', async () => {
  const { lane, lease } = await setup({ dispatch: () => new Promise(() => {}) });
  const result = await lane.dispatch(lane.prepare(lease, operation), grant);
  assert.equal(result.code, 'EFFECT_UNKNOWN');
  assert.equal(result.effect, 'unknown');
});

test('late creation after Stop retains intent, cleanup proof and no published lease', async () => {
  const { lane, hook } = await setup();
  const intent = lane.creationIntent('s1', 'turn-1');
  await lane.endTurn(hook);
  const result = lane.commitCreation(intent, identity({ targetId: 'late-page' }));
  assert.equal(result.lease, null);
  assert.equal(result.status, 'cleanup-required');
  assert.ok(lane.records.some((r) => r.targetId === 'late-page'));
});

test('late creation after connection loss keeps provenance from the original browser epoch', async () => {
  const { lane } = await setup();
  const intent = lane.creationIntent('s1', 'turn-1');
  lane.loseConnection('broker-crash');
  await lane.connect(new FakeCDP(), { ...browser, brokerEpoch: 'broker-2' }, grant);
  const result = lane.commitCreation(intent, identity({ targetId: 'late-page' }));
  assert.equal(result.lease, null);
  assert.equal(lane.records.find((r) => r.targetId === 'late-page').brokerEpoch, 'broker-1');
});

test('disconnect fences synchronously and never claims physical close without adapter proof', async () => {
  const pending = deferred();
  const { lane, lease } = await setup({ closeConnection: () => pending.promise });
  const controls = new TakeoverControls(lane);
  const result = controls.handle('disconnect', grant);
  await new Promise((r) => setImmediate(r));
  assert.throws(() => lane.prepare(lease, operation), /LEASE_LOST/);
  pending.resolve(false);
  assert.equal((await result).connectionClosed, false);
});

test('close identity lookup timeout is bounded and retains the exact ownership journal', async () => {
  const { lane, hook } = await setup({ observeTarget: () => new Promise(() => {}) });
  const [receipt] = await lane.endTurn(hook);
  assert.equal(receipt.status, 'retained');
  assert.equal(receipt.code, 'IDENTITY_UNAVAILABLE');
  assert.equal(lane.records.length, 1);
});

test('out-of-order cleanup cannot close targets that a later turn parked', async () => {
  const before = deferred();
  const { lane, cdp, hook } = await setup({ observeTarget: () => before.promise });
  const running = lane.endTurn(hook);
  lane.beginTurn('s1', 'turn-2', 'frontend-1');
  before.resolve(identity());
  assert.equal((await running)[0].code, 'LEASE_LOST');
  assert.equal(cdp.calls.length, 0);
  assert.equal(lane.records.length, 1);
});

test('unknown partial effect credits only known completed prefix, never claims untouched suffix', async () => {
  const { lane, lease } = await setup({ dispatch: async () => ({ phase: 'dispatched', effect: 'unknown', completed: [0] }) });
  const result = await lane.dispatch(lane.prepare(lease, { ...operation, count: 3 }), grant);
  assert.deepEqual(result.completed, [0]);
  assert.deepEqual(result.notAttempted, []);
});

test('broker replacement restores durable unknown receipts but never authority or live leases', async () => {
  const pending = deferred();
  const { lane, lease, journal } = await setup({ dispatch: () => pending.promise });
  const running = lane.dispatch(lane.prepare(lease, operation), grant);
  await new Promise((r) => setImmediate(r));
  const saved = JSON.parse(JSON.stringify(journal()));
  const replacement = new Lifecycle({ recovery: saved });
  assert.equal(replacement.retainedReceipt('s1', 'turn-1', 'op-1').effect, 'unknown');
  assert.equal(replacement.state.needsChromeConsent, true);
  assert.equal(replacement.records[0].status, 'parked');
  assert.equal(JSON.stringify(saved).includes('Enter'), false);
  lane.loseConnection('broker-crash');
  pending.resolve({ phase: 'verified', effect: 'verified', completed: [0] });
  assert.equal((await running).effect, 'unknown');
});

test('journal failure before dispatch refuses with no input sent', async () => {
  let writable = true;
  const { lane, lease, dispatched } = await setup({ saveJournal: () => writable });
  writable = false;
  const result = await lane.dispatch(lane.prepare(lease, operation), grant);
  assert.equal(result.code, 'JOURNAL_UNAVAILABLE');
  assert.equal(result.effect, 'none');
  assert.equal(dispatched.length, 0);
});

test('target detach invalidates refs and does not treat page disappearance as takeover proof', async () => {
  const { lane, cdp, lease } = await setup();
  cdp.emit('Target.detachedFromTarget', { targetId: 'page-1', sessionId: 'target-session' });
  assert.throws(() => lane.prepare(lease, operation), /LEASE_LOST/);
  assert.equal(lane.records[0].status, 'parked');
  assert.equal(lane.state.connection, 'connected');
});

test('fake workload records shutdown, pending-loss and idle timing separately', async (t) => {
  const shutdown = [], loss = [], idle = [];
  for (let i = 0; i < 30; i++) {
    const { lane, hook, cdp } = await setup();
    let start = performance.now();
    assert.equal(lane.state.connection, 'connected');
    assert.equal(cdp.calls.length, 0);
    idle.push(performance.now() - start);
    start = performance.now();
    await lane.endTurn(hook);
    shutdown.push(performance.now() - start);
    start = performance.now();
    const queued = await setup();
    const token = queued.lane.prepare(queued.lease, operation);
    start = performance.now();
    queued.lane.loseConnection('fixture-loss');
    loss.push(performance.now() - start);
    assert.equal(queued.lane.receipt(token).effect, 'none');
  }
  const summarize = (raw) => {
    const sorted = [...raw].sort((a, b) => a - b);
    return { rawMs: raw, p50Ms: sorted[14], p90Ms: sorted[26] };
  };
  t.diagnostic(JSON.stringify({ workload: 'fake CDP, 30 independent samples per cell; no browser/UI/model',
    shutdown: summarize(shutdown), pendingLoss: summarize(loss), idleStateRead: summarize(idle) }));
});

const artifact = { kind: 'download', handle: 'download-1', canonicalPath: '/fixture/invoice.pdf',
  origin: 'https://example.test', targetId: 'page-1', operation: 'download-op', state: 'completed' };
const app = { bundleId: 'org.fixture.viewer', windowId: 'window-1', title: 'fixture invoice' };

test('handoff parks browser without granting native authority; revalidation is separate', async () => {
  const { lane, lease, hook } = await setup();
  const nativeCalls = [];
  const handoff = new NativeHandoff(lane, {
    verifyArtifact: async (a) => a.handle === 'download-1',
    acquire: async (request) => { nativeCalls.push(request); return { identity: app, authority: 'native-session-only' }; },
    complete: async () => ({ identity: app, status: 'completed' }),
    revalidate: async () => ({ verified: true }),
  });
  const receipt = await handoff.prepare(lease, { artifact, targetApp: app }, grant);
  assert.equal(receipt.status, 'browser-parked');
  assert.equal(nativeCalls.length, 0);
  assert.throws(() => lane.prepare(lease, operation), /LEASE_LOST/);
  const cleanup = await lane.endTurn(hook);
  assert.equal(cleanup[0].status, 'parked');
  assert.equal((await handoff.run(receipt.id)).status, 'native-completed');
  assert.equal(nativeCalls[0].browserConsent, undefined);
  assert.equal((await handoff.revalidate(receipt.id, grant)).status, 'browser-revalidated');
});

test('handoff cannot report browser revalidation after socket loss or target reuse', async () => {
  for (const changed of ['socket-loss', 'target-reuse']) {
    const { lane, lease, current } = await setup();
    const handoff = new NativeHandoff(lane, { verifyArtifact: () => true,
      acquire: () => ({ identity: app, authority: 'native-only' }), complete: () => ({ identity: app, status: 'completed' }),
      revalidate: () => ({ verified: true }) });
    const receipt = await handoff.prepare(lease, { artifact, targetApp: app }, grant);
    await handoff.run(receipt.id);
    if (changed === 'socket-loss') lane.loseConnection('socket-loss');
    else current.set('page-1', identity({ targetGeneration: 2 }));
    await assert.rejects(handoff.revalidate(receipt.id, grant), /LEASE_LOST|IDENTITY_MISMATCH/);
  }
});

for (const problem of ['missing-native-authority', 'uncertain-download', 'wrong-app', 'wrong-window', 'native-timeout']) {
  test(`handoff ${problem} preserves exact artifact and stays resumable without browser replay`, async () => {
    const { lane, lease, dispatched } = await setup();
    const handoff = new NativeHandoff(lane, {
      verifyArtifact: async () => problem !== 'uncertain-download',
      acquire: async () => problem === 'native-timeout' ? new Promise(() => {}) : {
        identity: problem === 'wrong-app' ? { ...app, bundleId: 'org.fixture.other' } : app,
        authority: problem === 'missing-native-authority' ? null : 'native-authority',
      },
      complete: async () => ({ identity: problem === 'wrong-window' ? { ...app, windowId: 'other' } : app, status: 'completed' }),
      timeoutMs: 20,
    });
    if (problem === 'uncertain-download') {
      await assert.rejects(handoff.prepare(lease, { artifact, targetApp: app }, grant), /ARTIFACT_UNVERIFIED/);
    } else {
      const receipt = await handoff.prepare(lease, { artifact, targetApp: app }, grant);
      const result = await handoff.run(receipt.id);
      assert.equal(result.status, 'native-unresolved');
      assert.equal(result.artifactOrProtocol.handle, 'download-1');
      assert.equal(lane.records[0].status, 'parked');
    }
    assert.equal(dispatched.length, 0);
  });
}

test('revoked authority after observation leaves the entire batch untouched', async () => {
  let permitted = true, checks = 0;
  const { lane, lease, dispatched } = await setup({
    verifyAuthority: () => { checks++; return permitted; },
    observeTarget: () => { permitted = false; return identity(); },
  });
  const receipt = await lane.dispatch(lane.prepare(lease, { ...operation, count: 3 }), grant);
  assert.equal(dispatched.length, 0);
  assert.equal(checks, 2);
  assert.equal(receipt.code, 'PERMISSION_REQUIRED');
  assert.equal(receipt.phase, 'prepared');
  assert.equal(receipt.effect, 'none');
  assert.deepEqual(receipt.notAttempted, [0, 1, 2]);
});

for (const change of ['pause', 'socket-loss']) {
  test(`${change} during final authority verification prevents dispatch`, async () => {
    const decision = deferred(); let checks = 0;
    const { lane, lease, dispatched } = await setup({ verifyAuthority: () => ++checks === 1 ? true : decision.promise });
    const running = lane.dispatch(lane.prepare(lease, operation), grant);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 2);
    if (change === 'pause') lane.pause('native-pause');
    else lane.loseConnection(change);
    decision.resolve(true);
    assert.equal((await running).effect, 'none');
    assert.equal(dispatched.length, 0);
  });
}

test('concurrent connection approval preserves the installed socket and its loss listener', async () => {
  const decisions = [deferred(), deferred()]; let requests = 0;
  const lane = new Lifecycle({ verifyConnection: () => decisions[requests++].promise });
  const firstCDP = new FakeCDP(), secondCDP = new FakeCDP();
  const first = lane.connect(firstCDP, browser, grant);
  const second = lane.connect(secondCDP, browser, grant);
  const rejection = assert.rejects(second, /CONNECTION_ALREADY_PRESENT/);
  decisions[0].resolve(true); await first;
  decisions[1].resolve(true); await rejection;
  secondCDP.emit('disconnected');
  assert.equal(lane.state.connection, 'connected');
  assert.equal(lane.state.refEpoch, 0);
  firstCDP.emit('disconnected');
  assert.equal(lane.state.connection, 'disconnected');
  assert.equal(lane.state.refEpoch, 1);
});

test('denied concurrent connection cannot discard the accepted connection', async () => {
  const decisions = [deferred(), deferred()]; let requests = 0;
  const lane = new Lifecycle({ verifyConnection: () => decisions[requests++].promise });
  const first = lane.connect(new FakeCDP(), browser, grant);
  const second = lane.connect(new FakeCDP(), browser, grant);
  const rejection = assert.rejects(first, /CONNECTION_APPROVAL_REQUIRED/);
  decisions[0].resolve(false); await rejection;
  decisions[1].resolve(true); await second;
  assert.equal(lane.state.connection, 'connected');
});

test('timed-out connection approval leaves a subsequent approved connection available', async () => {
  let requests = 0;
  const lane = new Lifecycle({ timeoutMs: 10,
    verifyConnection: () => ++requests === 1 ? new Promise(() => {}) : true });
  await assert.rejects(lane.connect(new FakeCDP(), browser, grant), /CONNECTION_APPROVAL_REQUIRED/);
  assert.equal(lane.state.connection, 'disconnected');
  await lane.connect(new FakeCDP(), browser, grant);
  assert.equal(lane.state.connection, 'connected');
});

test('connection loss while approval is pending requires fresh consent', async () => {
  const decision = deferred();
  const lane = new Lifecycle({ verifyConnection: () => decision.promise });
  const pending = lane.connect(new FakeCDP(), browser, grant);
  const rejection = assert.rejects(pending, /CONNECTION_APPROVAL_REQUIRED/);
  lane.loseConnection('socket-loss');
  decision.resolve(true); await rejection;
  assert.equal(lane.state.connection, 'disconnected');
  assert.equal(lane.state.needsChromeConsent, true);
});
