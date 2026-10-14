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
import * as launch from '../plugins/sleight/lib/launch.mjs';

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
  const socket = { sessionId: 'root', on(name) { assert.equal(name, 'event'); }, off() {},
    send(method, params, route) {
      assert.ok(['Page.createIsolatedWorld', 'Input.dispatchMouseEvent'].includes(method), 'unsupported command ' + method);
      assert.notEqual(method, 'Page.bringToFront'); assert.notEqual(method, 'Target.activateTarget');
      calls.push({ method, params, route });
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
  return { session, broker, calls, ui, packageState };
}
const wheel = { name: 'browser_act', arguments: { tab: 't1', op: 'scroll', ref: 'r1', dy: 120 } };
const read = { name: 'browser_read', arguments: { tab: 't1' } };
test('real host creates compact frontend only after a distinct authenticated opt-in', async t => {
  const f = await fixture(t), session = f.session('first');
  const pending = session.enable();
  assert.equal(f.calls.length, 0); f.ui.answer('enable'); const frontend = await pending;
  assert.equal(surface.isFrontend(frontend), true);
  const receipt = await frontend.call(wheel);
  assert.equal(receipt.effect, 'verified', JSON.stringify(receipt)); assert.equal(receipt.observation.value, '[redacted]');
  assert.equal(f.calls.length, 1); assert.equal((await frontend.call(wheel)).completed, 1);
  await session.end(); assert.equal(f.broker.status().state, 'connected'); assert.equal(f.broker.status().clients, 0);
});
test('declined opt-in never constructs a route or queues future input', async t => {
  const f = await fixture(t), session = f.session('first'), pending = session.enable();
  f.ui.answer('cancel'); assert.equal(await pending, null); assert.equal(f.calls.length, 0);
  await session.end(); await assert.rejects(session.enable(), /LEASE_LOST/);
});
test('two real host sessions revoke only their own reads and authority', async t => {
  const f = await fixture(t), first = f.session('first'), second = f.session('second');
  const a = first.enable(); f.ui.answer('enable'); const frontA = await a;
  const b = second.enable(); f.ui.answer('enable'); const frontB = await b;
  const r = await frontA.call(read); assert.equal(r.completed, 1, JSON.stringify(r)); assert.equal((await frontB.call(read)).completed, 1);
  const ending = first.end();
  assert.equal(f.broker.status().clients, 1); await ending;
  assert.equal((await frontA.call(wheel)).error.code, 'LEASE_LOST');
  assert.equal((await frontB.call(wheel)).completed, 1); await second.end();
});
test('package update during private opt-in cannot advertise direct tools', async t => {
  const f = await fixture(t), session = f.session('first'), pending = session.enable();
  writeFileSync(join(f.packageState.root, 'host.mjs'), 'changed');
  f.ui.answer('enable'); assert.equal(await pending, null); assert.equal(f.calls.length, 0); await session.end();
});
test('unbranded host dependencies never create a browser session', () => {
  assert.throws(() => surface.createBrokerFrontendSession({ broker: {}, authority: {}, transportOwner: {} }), /TRUSTED_ROUTE_REQUIRED/);
});

test('empty host remote-object cleanup does not prove unjoined semantic journals closed', async t => {
  const f = await fixture(t), session = f.session('first'), enabling = session.enable();
  f.ui.answer('enable'); await enabling;
  const receipt = await session.end();
  assert.equal(receipt.revoked, false);
  assert.equal(receipt.cleanup.find(row => row.resource === 'semantic-journals').status, 'retained');
  assert.equal(receipt.cleanup.find(row => row.resource === 'semantic-journals').code, 'SEMANTIC_LIFECYCLE_UNJOINED');
});

test('bound semantic cleanup revokes synchronously and retains its exact journal receipt', async t => {
  const f = await fixture(t); let revoked = 0, cleaned = 0;
  const session = f.session('first', { session: 'first', revoke() { revoked++; return true; },
    cleanup() { cleaned++; return { cleanup: [{ target: 'target-first', resource: 'owned-target', status: 'retained' }] }; } });
  const enabling = session.enable(); f.ui.answer('enable'); await enabling;
  const pending = session.end(); assert.equal(revoked, 1);
  const receipt = await pending;
  assert.equal(receipt.revoked, true); assert.equal(receipt.cleanup[0].target, 'target-first');
  assert.equal(receipt.cleanup[0].status, 'retained'); assert.equal(cleaned, 1);
  await session.end(); assert.equal(revoked, 1); assert.equal(cleaned, 2);
});
test('semantic cleanup cannot be borrowed from another session', async t => {
  const f = await fixture(t);
  assert.throws(() => f.session('first', { session: 'second', revoke: () => true, cleanup: () => ({ cleanup: [] }) }), /TRUSTED_ROUTE_REQUIRED/);
  assert.equal(f.broker.status().clients, 0);
});
test('asynchronous semantic revocation cannot prove revocation or authorize cleanup', async t => {
  const f = await fixture(t); let cleaned = false;
  const session = f.session('first', { session: 'first', revoke: () => Promise.resolve(true),
    cleanup: () => { cleaned = true; return { cleanup: [] }; } });
  const receipt = await session.end();
  assert.equal(receipt.revoked, false); assert.equal(cleaned, false);
  assert.equal(receipt.cleanup[0].code, 'SEMANTIC_REVOCATION_UNPROVED');
});
test('installed launcher consumes the branded host opt-in with an exact private turn channel', async t => {
  const f = await fixture(t), session = f.session('first', { session: 'first', revoke: () => true, cleanup: () => ({ cleanup: [] }) });
  assert.equal(typeof launch.prepareDirectBrowser, 'function', 'installed opt-in join is absent');
  const read = new PassThrough(), write = new PassThrough(), frames = [];
  write.on('data', bytes => frames.push(JSON.parse(bytes)));
  const pending = launch.prepareDirectBrowser({ directSession: session,
    directTurnHook: { read, write, session: 'first', turn: 'turn', brokerEpoch: 1 } });
  assert.equal(f.calls.length, 0); f.ui.answer('enable'); const prepared = await pending;
  assert.equal(surface.isFrontend(prepared.directBrowser), true);
  read.write(JSON.stringify({ ...frames[0], event: 'end' }) + '\n');
  const receipt = await prepared.turnHook.close(); assert.equal(receipt.revoked, true);
  assert.equal(f.broker.status().clients, 0); assert.equal(f.broker.status().state, 'connected');
});
test('installed launcher refuses a forged session and never invokes its callback', async () => {
  let invoked = false;
  assert.equal(typeof launch.prepareDirectBrowser, 'function', 'installed opt-in join is absent');
  await assert.rejects(launch.prepareDirectBrowser({ directSession: { enable() { invoked = true; } } }), /TRUSTED_ROUTE_REQUIRED/);
  assert.equal(invoked, false);
});
test('private turn descriptors cannot be borrowed from another authenticated host session', async t => {
  const f = await fixture(t), session = f.session('first'), enabling = session.enable();
  f.ui.answer('enable'); const frontend = await enabling;
  assert.throws(() => launch.directBrowserTurnHook(frontend, { read: new PassThrough(), write: new PassThrough(),
    session: 'second', turn: 'turn', brokerEpoch: 1 }), /TRUSTED_ROUTE_REQUIRED/);
  assert.throws(() => launch.directBrowserTurnHook(frontend, { read: new PassThrough(), write: new PassThrough(),
    session: 'first', turn: 'old', brokerEpoch: 1 }), /TRUSTED_ROUTE_REQUIRED/);
  assert.throws(() => launch.directBrowserTurnHook(frontend, { read: new PassThrough(), write: new PassThrough(),
    session: 'first', turn: 'turn', brokerEpoch: 2 }), /TRUSTED_ROUTE_REQUIRED/);
  await session.end();
});
for (const forbidden of ['Page.bringToFront', 'Target.activateTarget']) {
  test('background frontend never sends ' + forbidden + ' even from a mistaken semantic dispatcher', async t => {
    const f = await fixture(t, { forbidden }), session = f.session('first'), enabling = session.enable();
    f.ui.answer('enable'); const frontend = await enabling;
    const result = await frontend.call(read);
    assert.equal(result.error.effect, 'none'); assert.equal(f.calls.length, 0);
    assert.ok(!f.calls.some(call => ['Page.bringToFront', 'Target.activateTarget'].includes(call.method)));
    await session.end();
  });
}
