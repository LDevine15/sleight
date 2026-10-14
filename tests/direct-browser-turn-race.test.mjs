import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createUiChannel } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { createPackageInventory } from '../plugins/sleight/lib/direct-browser/session-host.mjs';
import { createBroker } from '../plugins/sleight/lib/direct-browser/broker.mjs';
import { createAuthority, createTransportAuthority } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { createTransportOwner } from '../plugins/sleight/lib/direct-browser/transport-owner.mjs';
import * as surface from '../plugins/sleight/lib/direct-browser/surface.mjs';
import { Lifecycle, bindSemanticAdapter } from '../plugins/sleight/lib/direct-browser/lifecycle.mjs';

// No native helper or socket is launched. These streams exercise the real
// nonce/authentication protocol with synthetic data; they are not user consent.
function packageFixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-p3-host-')); trackTemp(root);
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(join(root, 'native'));
  const files = ['host.mjs', 'native/peer-host.c', 'native/consent-host.swift', 'playwright-files.json'].map(path => {
    const bytes = Buffer.from('offline ' + path); writeFileSync(join(root, path), bytes, { mode: 0o600 });
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { root, inventory: createPackageInventory({ root, receipt: { accepted: true, protocol: 1,
    node: process.version, helperMode: 'source', files } }) };
}
function uiFixture(t) {
  const read = new PassThrough(), write = new PassThrough(), frames = [];
  write.on('data', bytes => frames.push(JSON.parse(bytes)));
  const ui = createUiChannel({ read, write }); t.after(() => ui.close());
  return { ui, frames, answer(choice) {
    const frame = frames.at(-1); read.write(JSON.stringify({ id: frame.id, nonce: frame.nonce, choice }) + '\n');
  } };
}
async function fixture(t, options = {}) {
  assert.equal(typeof surface.createBrokerFrontendSession, 'function', 'closed host frontend entry is absent');
  const packageState = packageFixture(t), user = {}, calls = [], scopes = new Map(), ui = uiFixture(t);
  const scopeFor = id => scopes.get(id);
  let currentScope;
  const authority = createAuthority({ current: () => currentScope, classify: value => value,
    authenticate: event => event === user, now: () => 100,
    snapshot: () => ({ scope: currentScope, time: 100 }) });
  const socket = { sessionId: 'root', on(name) { assert.ok(['event', 'disconnected', 'close', 'Target.targetDestroyed', 'Target.detachedFromTarget'].includes(name)); }, off() {},
    send(method, params, route) {
      assert.ok(['Page.createIsolatedWorld', 'Input.dispatchMouseEvent', 'Target.closeTarget', 'Target.getTargets'].includes(method), 'unsupported command ' + method);
      assert.notEqual(method, 'Page.bringToFront'); assert.notEqual(method, 'Target.activateTarget');
      calls.push({ method, params, route });
      if (method === 'Target.closeTarget') return Promise.resolve({ success: true });
      if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: [] });
      if (method === 'Input.dispatchMouseEvent' && options.pending) return options.pending;
      return Promise.resolve(method === 'Page.createIsolatedWorld' ? { executionContextId: 9 } : {});
    } };
  const transportAuthority = createTransportAuthority({ authority, resolveOperation(plan, context) {
    const scope = scopeFor(context.session); currentScope = scope;
    return { id: context.operation, kind: plan.operationName === 'browser_read' ? 'read' : 'scroll',
      args: plan.operationName === 'browser_read' ? {} : { deltaX: 0, deltaY: 120 }, scope, consequence: 'ordinary' };
  } });
  const secret = 'a'.repeat(64), uid = process.getuid?.() ?? 1000;
  const owner = createTransportOwner({ session: socket, checkLease: () => true, helpers: {} });
  t.after(() => owner.close());
  const broker = createBroker({ uid, secret, browserIncarnation: 'browser', idlePolicy: 'retain', connect: () => socket,
    verifyConnection: () => true, disconnect: () => true, currentTurn: () => 'turn',
    validateRequest: value => value, prepare: (args, context) => ({ target: scopeFor(context.session).target }),
    authorize: () => true, dispatchFence: () => true, transportAuthority, endSession: () => true, redact: value => value,
    dispatch(plan, context) {
      const scope = scopeFor(context.clientSession), lease = { target: scope.target, cdpSessionId: 'page-' + scope.session,
        frame: scope.frame, document: 1, epoch: 1, origin: scope.origin, browserIncarnation: 'browser',
        brokerEpoch: 1, clientSession: scope.session, turn: scope.turn };
      return owner.run(lease, context, async view => {
        if (options.forbidden) await view.send(options.forbidden, {});
        if (plan.operationName === 'browser_read') await view.send('Page.createIsolatedWorld', { frameId: scope.frame, worldName: 'sleight-state' });
        else await view.input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 120 });
        return { effect: 'verified', observation: { complete: true, value: 'private', session: scope.session } };
      });
    } });
  t.after(() => broker.shutdown()); await broker.connect({ userInitiated: true });
  function session(id, semanticLifecycle) {
    const scope = { browser: 'browser', broker: 1, session: id, turn: 'turn', target: 'target-' + id,
      lease: 1, frame: 'frame-' + id, document: 1, ref: 'ref', origin: 'https://fixture.invalid' };
    scopes.set(id, scope);
    return surface.createBrokerFrontendSession({ broker, authority, transportOwner: owner, ui: ui.ui,
      packageInventory: packageState.inventory, selectedBrowser: 'b1', turn: 'turn', semanticLifecycle, identity: { version: 1, uid, secret, session: id, incarnation: 'p1-v1' },
      redact: value => value === null ? null : { ...value, value: '[redacted]' } });
  }
  return { session, broker, calls, ui, packageState, owner, socket };
}
for (const late of ['verified', 'rejected']) test(`Stop retains dispatched input across a late ${late} reply and repeated collection`, async t => {
  let finish, reject;
  const pending = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  t.after(() => finish({}));
  const f = await fixture(t, { pending });
  const browser = { incarnation: 'browser', brokerEpoch: 1, endpoint: 'ws://127.0.0.1:1/devtools/browser/fixture' };
  const target = { ...browser, session: 'first', turn: 'turn', targetId: 'target-first', targetGeneration: 1,
    leaseGeneration: 1, frame: 'frame-first', document: 1, origin: 'https://fixture.invalid' };
  const lease = { browserIncarnation: 'browser', brokerEpoch: 1, clientSession: 'first', turn: 'turn',
    epoch: 1, target: 'target-first', cdpSessionId: 'page-first', frame: 'frame-first', document: 1, origin: 'https://fixture.invalid' };
  const otherTarget = { ...target, session: 'second', targetId: 'target-second', frame: 'frame-second' };
  const journals = [];
  const lifecycle = new Lifecycle({ verifyConnection: () => true,
    observeTarget: id => id === target.targetId ? target : otherTarget,
    saveJournal: value => { journals.push(value); return true; } });
  await lifecycle.connect(f.socket, browser, {});
  const hook = lifecycle.beginTurn('first', 'turn', 'frontend'); lifecycle.track(target, { owned: true, ephemeral: true });
  const bound = bindSemanticAdapter({ session: 'first', adapter: { delivered: () => false,
    cleanupSession: async id => ({ ...await f.owner.cleanupSession(id), retained: 0 }) },
    transportOwner: f.owner, lifecycle, hook, leaseFor: () => lease });
  const session = f.session('first', bound), enabling = session.enable(); f.ui.answer('enable');
  const frontend = await enabling;
  const otherHook = lifecycle.beginTurn('second', 'turn', 'other-frontend');
  lifecycle.track(otherTarget, { owned: true, ephemeral: true });
  const otherBound = bindSemanticAdapter({ session: 'second', adapter: { delivered: () => false,
    cleanupSession: async id => ({ ...await f.owner.cleanupSession(id), retained: 0 }) },
    transportOwner: f.owner, lifecycle, hook: otherHook,
    leaseFor: () => ({ ...lease, clientSession: 'second', target: 'target-second', frame: 'frame-second' }) });
  const otherSession = f.session('second', otherBound), otherEnabling = otherSession.enable(); f.ui.answer('enable');
  await otherEnabling;
  const action = frontend.call({ name: 'browser_act', arguments: { tab: 't1', op: 'scroll', ref: 'r1', dy: 120 } });
  for (let i = 0; i < 20 && !f.calls.some(c => c.method === 'Input.dispatchMouseEvent'); i++) await new Promise(r => setImmediate(r));
  assert.ok(f.calls.some(c => c.method === 'Input.dispatchMouseEvent'), 'input entered the real broker');
  const receipt = await session.end();
  const response = await action;
  const closed = id => f.calls.filter(c => c.method === 'Target.closeTarget' && c.params.targetId === id);
  assert.equal(closed('target-first').length, 0, 'unknown input target must remain owned and open');
  assert.equal(response.receipt.effect, 'unknown');
  assert.ok(receipt.cleanup.some(row => row.targetId === 'target-first' && row.status === 'parked'));
  const otherReceipt = await otherSession.end();
  assert.equal(closed('target-second').length, 1);
  assert.ok(otherReceipt.cleanup.some(row => row.targetId === 'target-second' && row.absenceVerified === true));
  for (let i = 0; i < 2; i++) {
    assert.ok((await session.end()).cleanup.some(row => row.targetId === 'target-first' && row.status === 'parked'));
    assert.equal(closed('target-first').length, 0);
  }
  if (late === 'verified') finish({}); else reject(Error('late rejected input'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(frontend.receipt(response.receipt.operation), response.receipt);
  assert.equal((await session.end()).cleanup.find(row => row.targetId === 'target-first').status, 'parked');
  assert.equal(closed('target-first').length, 0);
  assert.equal(journals.at(-1).records.find(row => row.targetId === 'target-first').kept, true);
});
