import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createUiChannel } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { createTransportOwner } from '../plugins/sleight/lib/direct-browser/transport-owner.mjs';

async function fixture(t, changes = {}) {
  const { createSessionHost, createPackageInventory } = await import('../plugins/sleight/lib/direct-browser/session-host.mjs');
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-package-host-')); trackTemp(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'native'));
  const files = ['host.mjs', 'native/peer-host.c', 'native/consent-host.swift', 'playwright-files.json'].map(path => {
    const source = path + ' fixture'; writeFileSync(join(root, path), source, { mode: 0o600 });
    return { path, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') };
  });
  const inventory = createPackageInventory({ root, receipt: { accepted: true, protocol: 1, node: process.version,
    helperMode: 'source', files } });
  const read = new PassThrough(), write = new PassThrough(), frames = []; write.on('data', data => frames.push(JSON.parse(data)));
  const ui = createUiChannel({ read, write }); t.after(() => ui.close());
  const calls = []; let state = 'connected', revoked = false, clean = false;
  const host = createSessionHost({ session: 'client', client: { request(frame) { calls.push(frame);
    return Promise.resolve({ completed: 1, effect: 'verified', observation: { value: 'private' },
      results: [{ effect: 'verified', observation: { value: 'private' } }], untouched: 2, tab: 'topened' }); } },
    ui, packageInventory: inventory, status: () => ({ state, epoch: 1 }),
    revoke() { revoked = true; return true; }, cleanup: () => ({ cleanup: [{ target: 'target', status: clean ? 'closed' : 'retained' }] }),
    redact: value => value === null ? null : { ...value, value: '[redacted]' }, ...changes });
  const answer = choice => { const frame = frames.at(-1); read.write(JSON.stringify({ id: frame.id, nonce: frame.nonce, choice }) + '\n'); };
  return { host, calls, frames, root, ui, inventory, answer, setState(value) { state = value; }, revoked: () => revoked, cleaned() { clean = true; } };
}
test('frontend requests preserve exact prefix receipts and redact every observation', async t => {
  const f = await fixture(t);
  const receipt = await f.host.client.request({ id: 'request', operation: 'browser_read', args: { tab: 't1' } });
  assert.equal(receipt.completed, 1); assert.equal(receipt.effect, 'verified'); assert.equal(receipt.untouched, 2);
  assert.equal(receipt.tab, 'topened'); assert.equal(receipt.observation.value, '[redacted]');
  assert.equal(receipt.results[0].observation.value, '[redacted]');
});
for (const frame of [
  { id: 'bad', operation: 'Runtime.evaluate', args: {} },
  { id: 'bad', operation: 'browser_read', args: { tab: 't1', source: 'secret' } },
  { id: 'bad', operation: 'browser_act', args: { tab: 't1', op: 'click', ref: 'r1', force: true } },
  { id: 'bad', operation: 'browser_fill', args: { tab: 't1', fields: [{ ref: 'r1', value: { files: ['/model/path'] } }] } },
  { id: 'bad', operation: 'browser_open', args: { browser: 'b1', url: 'file:///private/fixture' } },
  { id: 'bad', operation: 'browser_read', args: { tab: 't1' }, approve: true },
]) test('session host refuses closed request schema ' + JSON.stringify(frame).slice(0, 100), async t => {
  const f = await fixture(t); await assert.rejects(f.host.client.request(frame), /INVALID_ARGUMENT/);
  assert.equal(f.calls.length, 0);
});
test('opt-in and resume consume distinct authentic session-bound user events', async t => {
  const f = await fixture(t);
  assert.equal(f.host.verifyOptIn({ enabled: true }), false);
  const pending = f.host.requestOptIn(); f.answer('enable'); const proof = await pending;
  assert.equal(f.host.verifyOptIn(proof), true); assert.equal(f.host.verifyOptIn(proof), false);
  const later = f.host.requestResume(); f.answer('resume'); const resume = await later;
  assert.equal(f.host.verifyOptIn(resume), false); assert.equal(f.host.verifyResume(resume), true);
  assert.equal(f.host.verifyResume(resume), false);
  f.setState('paused'); f.setState('connected'); assert.equal(f.host.verifyResume({ state: 'connected' }), false);
});
test('package verification is synchronous and rejects replaced accepted files', async t => {
  const f = await fixture(t);
  assert.equal(f.host.packageCurrent(), true);
  writeFileSync(join(f.root, 'native/peer-host.c'), 'replacement');
  assert.equal(f.host.packageCurrent(), false);
  await assert.rejects(f.host.client.request({ id: 'request', operation: 'browser_read', args: { tab: 't1' } }), /VERSION_MISMATCH/);
  assert.equal(f.calls.length, 0);
});
test('endSession revokes before its promise and retains exact cleanup uncertainty', async t => {
  const f = await fixture(t);
  const pending = f.host.endSession(); assert.equal(f.revoked(), true);
  assert.deepEqual(await pending, { revoked: true, cleanup: [{ target: 'target', status: 'retained' }] });
  await assert.rejects(f.host.client.request({ id: 'request', operation: 'browser_read', args: { tab: 't1' } }), /LEASE_LOST/);
  f.cleaned(); assert.deepEqual(await f.host.endSession(), { revoked: true, cleanup: [{ target: 'target', status: 'closed' }] });
});
test('asynchronous or throwing revocation never reports revoked true', async t => {
  for (const revoke of [() => Promise.resolve(true), () => { throw Error('failure'); }, () => false]) {
    const f = await fixture(t, { revoke });
    assert.equal((await f.host.endSession()).revoked, false);
  }
});
test('session end during a broker request prevents observation delivery', async t => {
  let finish;
  const f = await fixture(t, { client: { request() { return new Promise(resolve => { finish = resolve; }); } } });
  const request = f.host.client.request({ id: 'request', operation: 'browser_read', args: { tab: 't1' } });
  const ending = f.host.endSession();
  finish({ completed: 1, effect: 'verified', observation: { value: 'private' } });
  await assert.rejects(request, /LEASE_LOST/); await ending;
});
test('concrete session join rejects unbranded broker and semantic owner lookalikes', async t => {
  const { createBrokerSessionHost } = await import('../plugins/sleight/lib/direct-browser/session-host.mjs');
  const f = await fixture(t);
  const scope = { browser: 'browser', broker: 1, session: 'client', turn: 'turn', target: 'target', lease: 1,
    frame: 'frame', document: 1, ref: 'ref', origin: 'https://fixture.invalid' };
  const authority = createAuthority({ checkTarget: () => ({ present: true, visible: true, enabled: true, same: true }), current: () => scope, classify: value => value, authenticate: () => false });
  assert.throws(() => createBrokerSessionHost({ authority, ui: f.ui, packageInventory: f.inventory, redact: value => value,
    identity: { session: 'client' }, broker: { attach: () => ({ request() {}, disconnect() {} }), status: () => ({ state: 'connected' }) },
    transportOwner: { revokeSession: () => true, cleanupSession: () => ({ cleanup: [] }) } }), /TRUSTED_ROUTE_REQUIRED/);
});
test('actual broker session host joins wheel target authority, read baselines, redaction and synchronous revoke', async t => {
  const { createBrokerSessionHost } = await import('../plugins/sleight/lib/direct-browser/session-host.mjs');
  const f = await fixture(t), secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000, user = {};
  const scope = { browser: 'browser', broker: 1, session: 'client', turn: 'turn', target: 'target', lease: 1,
    frame: 'frame', document: 1, ref: 'ref', origin: 'https://fixture.invalid' };
  const lease = { target: scope.target, cdpSessionId: 'page', frame: scope.frame, document: 1, epoch: 1, origin: scope.origin,
    browserIncarnation: scope.browser, brokerEpoch: 1, clientSession: scope.session, turn: scope.turn };
  let snapshots = 0, revokeAt = Infinity; const calls = [], listeners = new Set();
  const authority = createAuthority({ checkTarget: () => ({ present: true, visible: true, enabled: true, same: true }), current: () => scope, now: () => 100, authenticate: event => event === user,
    classify: value => value, snapshot() {
      if (++snapshots === revokeAt) authority.user(user, 'revoke', { session: scope.session });
      return { scope, time: 100 };
    } });
  const session = { sessionId: 'root', on(name, fn) { assert.equal(name, 'event'); listeners.add(fn); }, off(name, fn) { listeners.delete(fn); },
    send(method, params, route) {
      assert.ok(['Input.dispatchMouseEvent', 'Page.createIsolatedWorld'].includes(method));
      calls.push({ method, params, route });
      return Promise.resolve(method === 'Page.createIsolatedWorld' ? { executionContextId: 9 } : {});
    } };
  const owner = createTransportOwner({ session, checkLease: () => true, helpers: {} });
  t.after(() => owner.close());
  const transportAuthority = createTransportAuthority({ authority, resolveOperation(plan, context, command) {
    assert.equal(command.route, lease.cdpSessionId);
    return { id: context.operation, kind: plan.operationName === 'browser_read' ? 'read' : 'scroll',
      args: plan.operationName === 'browser_read' ? {} : { deltaX: 0, deltaY: 120 }, scope, consequence: 'ordinary' };
  } });
  const broker = createBroker({ uid, secret, browserIncarnation: scope.browser, idlePolicy: 'retain', connect: () => session,
    verifyConnection: () => true, disconnect: () => true, currentTurn: () => scope.turn,
    validateRequest: value => value, prepare: () => ({ target: scope.target }), authorize: () => true,
    dispatchFence: () => true, transportAuthority, endSession: () => true, redact: value => value,
    dispatch: (plan, context) => owner.run(lease, context, async view => {
      const reader = owner.reader(lease, 'baseline', () => ({ reads: 0, dispose() {} }));
      if (plan.operationName === 'browser_read') {
        if (reader.reads++ === 0) await view.send('Page.createIsolatedWorld', { frameId: lease.frame, worldName: 'sleight-state' });
      } else await view.input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 120 });
      return { effect: 'verified', observation: { complete: true, reads: reader.reads, value: 'private' } };
    }) });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  const host = createBrokerSessionHost({ broker, identity: { version: 1, uid, secret, session: scope.session, incarnation: 'p1-v1' },
    authority, transportOwner: owner, ui: f.ui, packageInventory: f.inventory, redact: value => ({ ...value, value: '[redacted]' }) });
  const act = id => ({ id, operation: 'browser_act', args: { tab: 't1', op: 'scroll', ref: 'r1', dy: 120 } });
  assert.equal((await host.client.request(act('wheel'))).effect, 'verified'); assert.equal(snapshots, 1);
  const read = await host.client.request({ id: 'read', operation: 'browser_read', args: { tab: 't1' } });
  assert.equal(read.observation.value, '[redacted]'); assert.equal(read.observation.reads, 1);
  const later = await host.client.request({ id: 'baseline', operation: 'browser_read', args: { tab: 't1' } });
  assert.equal(later.observation.reads, 2); assert.equal(calls.length, 2);
  revokeAt = snapshots + 1;
  assert.equal((await host.client.request(act('revoked'))).effect, 'none'); assert.equal(calls.length, 2);
  const ending = host.endSession();
  await assert.rejects(host.client.request(act('after-end')), /LEASE_LOST/);
  assert.equal((await ending).revoked, true);
  assert.equal(broker.status().state, 'connected'); assert.equal(broker.status().clients, 0);
});
