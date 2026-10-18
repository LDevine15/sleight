import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { api as identity, instance, recipe, file, bind as bindFixture } from './fixtures/electron-app.mjs';
// Missing module is the expected failure against the old web-only join.
const api = await import('../plugins/sleight/lib/direct-browser/electron-consent.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});
const session = 's1', turn = 't1';

function fixture(options = {}) {
  assert.equal(typeof api.createElectronConsent, 'function', 'separate debugger consent is required');
  const events = new WeakSet(), presented = []; let clock = 1000, engine = 'approved';
  const ui = { revoked: 0, authenticate: event => events.delete(event),
    present(id, data, choices, deliver, opts) { presented.push({ id, data, choices, deliver, opts }); },
    revoke() { ui.revoked++; } };
  const store = options.store ?? api.createGrantStore();
  const consent = api.createElectronConsent({ ui, store, now: () => clock, engineApproval: () => engine, ...options.consent });
  const click = (index, choice, extra = {}) => { const event = { id: presented[index].id, choice, ...extra }; events.add(event); presented[index].deliver(event); return event; };
  return { consent, ui, store, presented, click, events, tick: ms => { clock += ms; }, engine: value => { engine = value; },
    forge: (index, choice) => presented[index].deliver({ id: presented[index].id, choice }) };
}
const pipe = () => ({ parked: 0, closed: 0, park() { this.parked++; }, close() { this.closed++; } });
const temporary = () => mkdtempSync(join(realpathSync(tmpdir()), 'epv3-consent-'));
async function relaunchTicket(f, where = { session, turn }) {
  const index = f.presented.length, pending = f.consent.requestRelaunch(instance, where); f.click(index, 'relaunch');
  const result = await pending; assert.equal(result.status, 'approved'); return result.ticket;
}
const ask = (f, extra = instance, scope = {}) => f.consent.requestDebugger(extra, { session, turn, ...scope });

test('the debugger card is its own card with exact app facts and the four choices', async () => {
  const f = fixture(), pending = ask(f);
  assert.equal(f.presented.length, 1); const { data, choices } = f.presented[0];
  assert.equal(data.kind, 'debugger'); assert.deepEqual(choices, ['once', 'session', 'always', 'cancel']);
  assert.deepEqual(Object.keys(data).sort(), ['app', 'epoch', 'kind', 'session', 'turn']);
  assert.deepEqual(data.app, instance); assert.equal(data.session, session); assert.equal(data.turn, turn);
  assert.ok(f.presented[0].opts.deadline > 1000);
  f.click(0, 'cancel'); assert.deepEqual(await pending, { status: 'declined' });
});
test('once grants this process for this turn and ends with the turn', async () => {
  const f = fixture(), connection = pipe(), pending = ask(f); f.click(0, 'once');
  const result = await pending; assert.equal(result.status, 'granted'); assert.equal(result.grant.scope, 'once'); assert.equal(result.persisted, false);
  result.grant.onRevoke(() => connection.park());
  assert.equal(result.grant.current(), true);
  assert.equal(f.consent.grantFor(instance, { session, turn: 't2' }), undefined, 'a later turn does not inherit a once grant');
  assert.equal(f.consent.grantFor(instance, { session, turn }), result.grant);
  const later = ask(f, instance, { turn: 't2' }); assert.equal(f.presented.length, 2, 'a later turn asks again'); f.click(1, 'cancel'); await later;
  f.consent.endTurn(session, turn);
  assert.equal(result.grant.current(), false); assert.equal(connection.parked, 1); assert.equal(connection.closed, 0);
  assert.equal(f.store.list().length, 0);
});
test('session grants cross turns for the same session and exact process only', async () => {
  const f = fixture(), connection = pipe(), pending = ask(f); f.click(0, 'session');
  const { grant } = await pending; grant.onRevoke(() => connection.park());
  assert.equal(grant.scope, 'session'); assert.equal(grant.turn, null);
  assert.equal((await ask(f, instance, { turn: 't2' })).grant, grant); assert.equal(f.presented.length, 1, 'no second card');
  const other = ask(f, instance, { session: 's2' }); assert.equal(f.presented.length, 2, 'another session asks'); f.click(1, 'cancel'); await other;
  const restarted = ask(f, { ...instance, pid: 4243 }); assert.equal(f.presented.length, 3, 'a new process asks'); f.click(2, 'cancel'); await restarted;
  const reborn = ask(f, { ...instance, pidBirth: '1760009999.1' }); assert.equal(f.presented.length, 4, 'a recycled PID asks'); f.click(3, 'cancel'); await reborn;
  f.consent.endTurn(session, turn); assert.equal(grant.current(), true);
  f.consent.revokeSession(session);
  assert.equal(grant.current(), false); assert.equal(connection.parked, 1, 'revocation parks the connection'); assert.equal(connection.closed, 0, 'and never closes the pipe');
});
test('Always allow is written only by an authenticated click and follows build and profile, not the process', async t => {
  const directory = temporary(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'grants', 'turbo-electron.json'), f = fixture({ store: api.createGrantStore({ path }) });
  assert.equal(f.store.list().length, 0); const pending = ask(f);
  f.forge(0, 'always'); assert.equal(f.store.list().length, 0, 'an unauthenticated reply writes nothing'); assert.equal(f.consent.pending(), 1, 'and leaves the real card pending');
  const event = f.click(0, 'always'), result = await pending;
  assert.equal(result.status, 'granted'); assert.equal(result.grant.scope, 'always'); assert.equal(result.persisted, true);
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(f.store.list().length, 1);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.version, 2); assert.match(saved.grants[0].seal, /^[A-Za-z0-9_-]{43}$/, 'every record carries its seal');
  assert.deepEqual(Object.keys(saved.grants[0].record).sort(), ['bundleId', 'cdhash', 'executable', 'key', 'name', 'profile', 'runtime', 'signer', 'version'], 'no process facts persist');
  assert.equal(f.ui.authenticate(event), false, 'the event is spent'); f.presented[0].deliver(event); assert.equal(f.store.list().length, 1);
  // A fresh host process: same file, no card for the same build and profile, any PID.
  const g = fixture({ store: api.createGrantStore({ path }) });
  const again = await ask(g, { ...instance, pid: 99, pidBirth: '1770000000.5' }); assert.equal(again.status, 'granted'); assert.equal(again.grant.scope, 'always'); assert.equal(g.presented.length, 0);
  for (const change of [{ version: '1.2.4' }, { signer: 'OTHERTEAM' }, { runtime: 'electron/40.0.0' }, { profile: '/Users/fixture/Other' }, { bundleId: 'invalid.fixture.other' },
    { cdhash: 'b'.repeat(40) }, { executable: '/Applications/Copy.app/Contents/MacOS/Fixture' }]) {
    const before = g.presented.length, pendingChange = ask(g, { ...instance, ...change });
    assert.equal(g.presented.length, before + 1, 'changed ' + Object.keys(change)[0] + ' asks again'); g.click(before, 'cancel'); await pendingChange;
  }
  g.consent.revokeApp(instance); assert.equal(g.store.list().length, 0); assert.equal(api.createGrantStore({ path }).list().length, 0);
  const asked = ask(g, { ...instance, pid: 7 }); assert.equal(g.presented.length, 8, 'after revocation it asks again'); g.click(7, 'cancel'); await asked;
});
test('an Always grant stops when its record is removed elsewhere, without waiting for the session', async () => {
  const f = fixture(), connection = pipe(), pending = ask(f); f.click(0, 'always'); const { grant } = await pending; grant.onRevoke(() => connection.park());
  assert.equal(grant.current(), true); f.store.remove(identity.appKey(instance));
  assert.equal(grant.current(), true, 'recheck is cached for two seconds'); f.tick(2001);
  assert.equal(grant.current(), false); assert.equal(connection.parked, 1); assert.equal(connection.closed, 0);
  assert.equal(f.consent.grantFor(instance, { session, turn }), undefined, 'and it is not offered again');
});
test('a temporary profile never offers or stores Always', async () => {
  const f = fixture(), pending = ask(f, { ...instance, temporary: true });
  assert.deepEqual(f.presented[0].choices, ['once', 'session', 'cancel']);
  f.click(0, 'always'); const result = await pending;
  assert.deepEqual([result.status, result.code], ['refused', 'INVALID_CHOICE']); assert.equal(f.store.list().length, 0);
});
test('a hand-written or altered Always record is refused; only a record the store sealed counts', async t => {
  const directory = temporary(); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'grants.json'), record = { key: identity.appKey(instance), name: instance.name, bundleId: instance.bundleId, signer: instance.signer,
    version: instance.version, runtime: instance.runtime, profile: instance.profile, executable: instance.executable, cdhash: instance.cdhash };
  // The old unsealed format and a new-format record with a made-up seal: both written by hand, both refused.
  writeFileSync(path, JSON.stringify({ version: 1, grants: [record] }), { mode: 0o600 });
  assert.equal(api.createGrantStore({ path }).list().length, 0, 'an unsealed record is not consent');
  writeFileSync(path, JSON.stringify({ version: 2, grants: [{ record, seal: createHmac('sha256', Buffer.alloc(32, 1)).update(JSON.stringify(record)).digest('base64url') }] }), { mode: 0o600 });
  const open = fixture({ store: api.createGrantStore({ path }) });
  assert.equal(open.store.list().length, 0, 'a seal under some other key is not consent'); assert.equal(open.consent.grantFor(instance, { session, turn }), undefined);
  rmSync(path);
  // A real click: the store seals it, and a new store on the same file trusts it.
  const sealed = fixture({ store: api.createGrantStore({ path }) }), pending = ask(sealed); sealed.click(0, 'always'); assert.equal((await pending).persisted, true);
  assert.equal(api.createGrantStore({ path }).list().length, 1);
  const saved = readFileSync(path, 'utf8'), envelope = JSON.parse(saved);
  writeFileSync(path, JSON.stringify({ ...envelope, grants: [{ ...envelope.grants[0], record: { ...envelope.grants[0].record, cdhash: 'f'.repeat(40) } }] }), { mode: 0o600 });
  assert.equal(api.createGrantStore({ path }).list().length, 0, 'changing a sealed field breaks the seal');
  writeFileSync(path, saved, { mode: 0o600 });
  assert.equal(api.createGrantStore({ path, keyPath: join(directory, 'other.key') }).list().length, 0, 'another key does not verify it');
  // File safety still holds: group-readable or linked files are not trusted, and an unsafe file is never overwritten.
  chmodSync(path, 0o644); const unsafe = fixture({ store: api.createGrantStore({ path }) });
  assert.equal(unsafe.store.list().length, 0, 'group-readable file is not trusted');
  const degraded = ask(unsafe); unsafe.click(0, 'always'); const result = await degraded;
  assert.equal(result.grant.scope, 'session', 'the click degrades to a session grant when it cannot persist'); assert.equal(result.persisted, false);
  assert.equal(readFileSync(path, 'utf8'), saved, 'file untouched');
  const link = join(directory, 'link.json'); symlinkSync(path, link); chmodSync(path, 0o600);
  assert.equal(api.createGrantStore({ path: link }).list().length, 0, 'symlinks are not trusted');
  assert.equal(statSync(join(directory, 'grant-seal.key')).mode & 0o777, 0o600);
});
test('the store takes a write only with a receipt from an authenticated Always click', () => {
  const store = api.createGrantStore(), record = { key: identity.appKey(instance), name: instance.name, bundleId: instance.bundleId, signer: instance.signer,
    version: instance.version, runtime: instance.runtime, profile: instance.profile, executable: instance.executable, cdhash: instance.cdhash };
  for (const receipt of [undefined, null, {}, Object.freeze({}), { receipt: true }, 'click']) assert.throws(() => store.put(receipt, record), /AUTHENTICATED_CLICK_REQUIRED/);
  assert.equal(store.list().length, 0); assert.equal(Object.isFrozen(store), true);
});
test('expired, forged and wrong-card replies never grant', async () => {
  const f = fixture(), expired = ask(f); f.tick(120001); f.click(0, 'always');
  assert.deepEqual((await expired).status, 'expired'); assert.equal(f.store.list().length, 0); assert.equal(f.consent.grantFor(instance, { session, turn }), undefined);
  const wrong = ask(f); f.click(1, 'relaunch'); assert.deepEqual([(await wrong).status, (await wrong).code], ['refused', 'INVALID_CHOICE']);
  const typo = ask(f); f.click(2, 'ALWAYS'); assert.equal((await typo).status, 'refused');
  const object = ask(f); f.click(3, 'once', { approved: true, extra: 'x' }); assert.equal((await object).status, 'granted', 'extra reply fields are ignored, never promoted');
  const forged = ask(f, instance, { session: 's9' }); f.forge(4, 'session'); f.forge(4, 'always'); assert.equal(f.consent.pending(), 1);
  f.consent.revokeAll(); assert.equal((await forged).status, 'revoked');
});
test('engine app approval is a precondition and keeps applying', async () => {
  const f = fixture(); f.engine('refused');
  assert.deepEqual(await ask(f), { status: 'refused', code: 'ENGINE_APP_APPROVAL_REQUIRED' }); assert.equal(f.presented.length, 0, 'no card for a refused app');
  f.engine('unknown'); assert.equal((await ask(f)).status, 'refused'); assert.equal((await f.consent.requestRelaunch(instance, { session, turn })).status, 'refused');
  f.engine('approved'); const pending = ask(f); f.click(0, 'session'); const { grant } = await pending; assert.equal(grant.current(), true);
  f.engine('refused'); assert.equal(grant.current(), false, 'a later engine refusal stops the grant'); assert.equal(f.consent.grantFor(instance, { session, turn }), undefined);
  // The engine can also refuse between the click and the grant.
  f.engine('approved'); const raced = ask(f, instance, { session: 's2' }); f.engine('refused'); f.click(1, 'always');
  assert.equal((await raced).status, 'refused'); assert.equal(f.store.list().length, 0);
});
test('requests are closed data: extra keys, relative profiles and bad scopes are refused before any card', async () => {
  const f = fixture();
  for (const bad of [{ ...instance, approved: true }, { ...instance, profile: 'relative' }, { ...instance, pid: -1 }, { ...instance, temporary: undefined }, null])
    assert.equal((await f.consent.requestDebugger(bad, { session, turn })).code, 'INVALID_REQUEST');
  for (const scope of [{ session: 'bad session', turn }, { session, turn: '' }, {}]) assert.equal((await f.consent.requestDebugger(instance, scope)).code, 'INVALID_REQUEST');
  assert.equal(f.presented.length, 0);
});
test('concurrent identical requests share one card', async () => {
  const f = fixture(), first = ask(f), second = ask(f); assert.equal(f.presented.length, 1); f.click(0, 'session');
  const [a, b] = await Promise.all([first, second]); assert.equal(a.grant, b.grant);
});
test('relaunch is its own card, exact to the process, session and turn, and spent once', async () => {
  const f = fixture(), connection = pipe();
  const debuggerAsk = ask(f); f.click(0, 'always'); const { grant } = await debuggerAsk; grant.onRevoke(() => connection.park());
  const relaunch = f.consent.requestRelaunch(instance, { session, turn });
  assert.equal(f.presented.length, 2, 'an Always debugger grant does not stand in for a relaunch'); assert.equal(f.presented[1].data.kind, 'relaunch');
  assert.deepEqual(f.presented[1].choices, ['relaunch', 'cancel']);
  f.click(1, 'relaunch'); const { status, ticket } = await relaunch; assert.equal(status, 'approved');
  const receipt = f.consent.consumeRelaunch(ticket, instance, { session, turn });
  assert.equal(receipt.action, 'quit-and-relaunch'); assert.equal(receipt.pid, 4242);
  assert.throws(() => f.consent.consumeRelaunch(ticket, instance, { session, turn }), /RELAUNCH_NOT_AUTHORIZED/, 'a spent ticket stays spent');
  assert.equal(grant.current(), true); assert.equal(connection.closed, 0, 'the relaunch decision never touches the pipe');
  const changes = { build: { version: '1.2.4' }, profile: { profile: '/Users/fixture/Other' }, pid: { pid: 4243 }, birth: { pidBirth: '1760000009.9' }, signer: { signer: 'OTHERTEAM' } };
  for (const [label, change] of Object.entries(changes)) {
    const spare = await relaunchTicket(f);
    assert.throws(() => f.consent.consumeRelaunch(spare, { ...instance, ...change }, { session, turn }), /RELAUNCH_NOT_AUTHORIZED/, label);
  }
  for (const [label, where] of [['turn', { session, turn: 't2' }], ['session', { session: 's2', turn }]]) {
    const spare = await relaunchTicket(f);
    assert.throws(() => f.consent.consumeRelaunch(spare, instance, where), /RELAUNCH_NOT_AUTHORIZED/, label);
  }
});
test('relaunch tickets expire, and cancel or an unapproved app never produce one', async () => {
  const f = fixture(), expiring = await relaunchTicket(f); f.tick(60001);
  assert.throws(() => f.consent.consumeRelaunch(expiring, instance, { session, turn }), /RELAUNCH_NOT_AUTHORIZED/);
  const pending = f.consent.requestRelaunch(instance, { session, turn }); f.click(f.presented.length - 1, 'cancel');
  assert.deepEqual(await pending, { status: 'declined' });
  const live = await relaunchTicket(f); f.engine('refused');
  assert.throws(() => f.consent.consumeRelaunch(live, instance, { session, turn }), /RELAUNCH_NOT_AUTHORIZED/, 'engine refusal after the click');
  for (const forged of [undefined, {}, Object.freeze({}), 'ticket']) assert.throws(() => f.consent.consumeRelaunch(forged, instance, { session, turn }), /RELAUNCH_NOT_AUTHORIZED/);
});
test('a grant binds a typed app binding only for its own process, and revocation fences the binding', async () => {
  const f = fixture(), pending = ask(f); f.click(0, 'session'); const { grant } = await pending;
  const options = { window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe };
  for (const forged of [{ current: () => true, scope: 'session' }, Object.freeze({ ...grant }), null, undefined])
    assert.throws(() => f.consent.bindApp({ grant: forged, instance, ...options }), /DEBUGGER_GRANT_REQUIRED/);
  assert.throws(() => f.consent.bindApp({ grant, instance: { ...instance, pid: 1 }, ...options }), /DEBUGGER_GRANT_REQUIRED/);
  assert.throws(() => f.consent.bindApp({ grant, instance: { ...instance, version: '9' }, ...options }), /DEBUGGER_GRANT_REQUIRED/);
  let alive = true; const app = f.consent.bindApp({ grant, instance, ...options, verify: () => alive });
  assert.equal(identity.isAppBinding(app), true); assert.equal(app.session, session); assert.equal(app.turn, null); assert.equal(app.current(), true);
  alive = false; assert.equal(app.current(), false, 'a failed PID or window recheck fences the binding'); alive = true; assert.equal(app.current(), true);
  assert.equal(app.classify(file('a.html'), 'null').principal.app.pid, 4242);
  f.consent.revokeSession(session); assert.equal(app.current(), false);
  assert.throws(() => f.consent.bindApp({ grant, instance, ...options }), /DEBUGGER_GRANT_REQUIRED/, 'a revoked grant binds nothing');
});
test('a once grant binds with its turn; revoke-all cancels cards and spends nothing on the pipe', async () => {
  const f = fixture(), connection = pipe(), pending = ask(f); f.click(0, 'once'); const { grant } = await pending;
  const app = f.consent.bindApp({ grant, instance, window: { id: 7, epoch: 1 }, brokerEpoch: 1, recipe }); assert.equal(app.turn, turn);
  grant.onRevoke(() => connection.park());
  const waiting = ask(f, instance, { session: 's2' }); assert.equal(f.consent.pending(), 1);
  f.consent.revokeAll();
  assert.equal((await waiting).status, 'revoked'); assert.equal(app.current(), false); assert.equal(f.ui.revoked, 1);
  assert.deepEqual([connection.parked, connection.closed], [1, 0]);
  f.click(1, 'session'); assert.equal(f.consent.grantFor(instance, { session: 's2', turn }), undefined, 'a reply after revoke grants nothing');
  grant.onRevoke(() => connection.park()); assert.equal(connection.parked, 2, 'a hook added after revocation fires at once');
});
