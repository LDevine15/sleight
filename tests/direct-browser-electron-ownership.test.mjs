import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, createJournal, privateDirectory, reconcile } from '../plugins/sleight/lib/direct-browser/electron-ownership.mjs';
import { connectWorker, fakeAdapter, fakeWorld, makeHost, tick, until } from './direct-browser-electron-host-fixture.mjs';

const launchCalls = h => h.adapter.calls.filter(([cmd]) => ['reserve', 'spawn'].includes(cmd)).length;
const read = dir => JSON.parse(readFileSync(join(dir, 'ownership.json'), 'utf8')).record;

async function crashed() {
  const first = await makeHost();
  await first.host.start({ build: 'fake-build' });
  first.host._crashForTest();                         // the process vanishes: no journal write, no collect
  return first;
}
const restart = (first, options = {}) => makeHost({ world: first.world, dir: first.state.dir, ...options });

test('a launch writes a sealed journal before anything else relies on the app; it is private and exact', async () => {
  const h = await makeHost();
  assert.equal(h.host.status().ownership.state, 'free');
  await h.host.start({ build: 'fake-build' });
  const record = read(h.state.dir);
  assert.equal(record.state, 'running');
  assert.equal(record.build, 'fake-build');
  assert.equal(record.pid, 4100);
  assert.equal(record.nonce, h.world.lock.nonce);
  assert.equal(record.hostId, h.host.hostId);
  assert.equal(statSync(join(h.state.dir, 'ownership.json')).mode & 0o077, 0);
  assert.equal(statSync(join(h.state.dir, 'host.key')).mode & 0o077, 0);
  assert.equal(statSync(h.state.dir).mode & 0o077, 0);
  assert.equal(h.host.status().ownership.state, 'owned');
  h.world.descendants = [{ pid: 4101, birth: 'kid' }];
  await h.host.broker.inspect();
  assert.deepEqual(read(h.state.dir).observed, [[4101, 'kid']], 'descendants are durable the moment they are seen');
  h.host._crashForTest(); h.state.remove();
});

test('a resident crash reports possible app exit and the restarted host refuses a second launch', async () => {
  const first = await crashed();
  const second = await restart(first);
  const status = second.host.status();
  assert.equal(status.ownership.state, 'unresolved');
  assert.equal(status.ownership.reason, 'host-crash-possible-app-exit');
  assert.equal(status.ownership.possibleAppExit, true);
  await assert.rejects(second.host.start({ build: 'fake-build' }), /ownership unresolved: host-crash-possible-app-exit/);
  assert.equal(launchCalls(second), 0, 'no reservation or spawn was even attempted');
  assert.equal(first.world.apps.length, 1);
  second.host._crashForTest(); first.state.remove();
});

test('a closed host with an app owned is refused, and an unsafe stop is recorded as abandoned only by the crash path', async () => {
  const h = await makeHost();
  await h.host.start({ build: 'fake-build' });
  await assert.rejects(h.host.close(), /app owned/);
  assert.equal(h.host.broker.state, 'ready');
  h.host._crashForTest(); h.state.remove();
});

test('a recreated journal is not proof: deleted, unsealed, sealed-empty or key-less journals all leave the lock in charge', async () => {
  const variants = {
    deleted: dir => unlinkSync(join(dir, 'ownership.json')),
    unsealed: dir => writeFileSync(join(dir, 'ownership.json'), JSON.stringify({ record: { state: 'none' }, sealed: 'AAAA' }), { mode: 0o600 }),
    garbage: dir => writeFileSync(join(dir, 'ownership.json'), 'not json', { mode: 0o600 }),
    sealedNone: dir => createJournal({ dir }).write({ state: 'none' }),          // someone holding the key writes an empty record
    keyLost: dir => { unlinkSync(join(dir, 'host.key')); },
  };
  const reasons = { deleted: 'lock-without-journal', unsealed: 'journal-unsealed', garbage: 'journal-unsealed', sealedNone: 'lock-without-journal', keyLost: 'journal-unsealed' };
  for (const [name, tamper] of Object.entries(variants)) {
    const first = await crashed();
    tamper(first.state.dir);
    const second = await restart(first);
    assert.equal(second.host.status().ownership.state, 'unresolved', name);
    assert.equal(second.host.status().ownership.reason, reasons[name], name);
    await assert.rejects(second.host.start({ build: 'fake-build' }), /unresolved/, name);
    // The journal alone changes nothing, even when asked to reconcile with the app still running.
    first.world.alive = true;
    const refused = await second.host.reconcile({ acceptDiskEvidence: true });
    assert.equal(refused.resolved, false, name);
    assert.ok(first.world.lock, name + ': the lock stays while the app may be running');
    second.host._crashForTest(); first.state.remove();
  }
});

test('reconciliation needs disk evidence and a complete census: running app, mismatched nonce, moved directories and an unaccepted journal all refuse', async () => {
  const first = await crashed();
  first.world.alive = true;                             // the app survived the host
  const second = await restart(first);
  assert.deepEqual((await second.host.reconcile()).reason, 'processes-or-census-unproved');
  assert.match(second.host.status().ownership.lastAttempt, /processes-or-census-unproved/);
  assert.ok(first.world.lock);
  first.world.alive = false;
  first.world.descendants = [{ pid: 4999, birth: 'orphan' }];
  assert.equal((await second.host.reconcile()).resolved, false, 'an orphaned descendant keeps the ownership');
  first.world.descendants = [];
  first.world.complete = false;
  assert.equal((await second.host.reconcile()).resolved, false, 'an incomplete census is not absence');
  first.world.complete = true;
  first.world.inodeMatches = false;
  assert.equal((await second.host.reconcile()).reason, 'recovery-evidence-refused', 'a lookalike directory is not the launch\'s directory');
  first.world.inodeMatches = true;
  const realNonce = first.world.lock.nonce;
  first.world.lock.nonce = 'forged-nonce';
  assert.equal((await second.host.reconcile()).reason, 'journal-contradicts-disk');
  first.world.lock.nonce = realNonce;
  await assert.rejects(second.host.start({ build: 'fake-build' }), /unresolved/);
  assert.equal((await second.host.reconcile()).resolved, true, 'with every proof in place the ownership is cleared');
  assert.equal(first.world.lock, undefined);
  assert.equal(second.host.status().ownership.state, 'free');
  assert.equal(read(first.state.dir).state, 'none');
  await second.host.start({ build: 'fake-build' });
  assert.equal(first.world.apps.length, 2, 'only now can a new launch happen');
  second.host._crashForTest(); first.state.remove();
});

test('without a trusted journal, a person must accept the disk evidence, and the lock must agree with its own profile', async () => {
  const first = await crashed();
  unlinkSync(join(first.state.dir, 'ownership.json'));
  const second = await restart(first);
  assert.equal((await second.host.reconcile()).reason, 'no-trusted-journal');
  first.world.lock.markerNonce = 'someone-else';
  assert.equal((await second.host.reconcile({ acceptDiskEvidence: true })).reason, 'lock-evidence-incoherent');
  first.world.lock.markerNonce = undefined;
  first.world.alive = false;
  assert.equal((await second.host.reconcile({ acceptDiskEvidence: true })).resolved, true);
  assert.equal(first.world.lock, undefined);
  second.host._crashForTest(); first.state.remove();
});

test('interrupted cleanup keeps ownership: the retained result is journaled as owned and finishes after a restart', async () => {
  const h = await makeHost();
  await h.host.start({ build: 'fake-build' });
  h.world.collectBlocked = 'profile removal interrupted';
  const receipt = await h.host.quit(async () => true);
  assert.equal(receipt.cleanup, 'retained');
  assert.match(receipt.reason, /interrupted/);
  assert.equal(h.world.lock !== undefined, true);
  assert.equal(read(h.state.dir).state, 'running', 'the journal still says an app was owned');
  assert.equal(h.host.status().ownership.state, 'owned');
  await assert.rejects(h.host.start({ build: 'fake-build' }), /retained ownership/);
  await assert.rejects(h.host.close(), /app owned/);
  h.host._crashForTest();                                // and now the host dies mid-cleanup
  const second = await restart(h);
  assert.equal(second.host.status().ownership.state, 'unresolved');
  assert.equal((await second.host.reconcile()).resolved, false, 'the cleanup is still blocked');
  h.world.collectBlocked = undefined;
  assert.equal((await second.host.reconcile()).resolved, true);
  assert.equal(h.world.lock, undefined);
  second.host._crashForTest(); h.state.remove();
});

test('an uncertain launch keeps its reservation: no automatic retry, no second launch', async () => {
  const world = fakeWorld();
  const h = await makeHost({ world });
  const original = h.adapter.rpc.bind(h.adapter);
  h.adapter.rpc = async (cmd, payload) => { if (cmd === 'spawn') throw Error('RuntimeError: PID incarnation unavailable; retain ownership'); return original(cmd, payload); };
  await assert.rejects(h.host.start({ build: 'fake-build' }), /incarnation/);
  assert.equal(h.host.status().ownership.state, 'unresolved');
  assert.equal(h.host.status().ownership.reason, 'launch-uncertain');
  assert.equal(read(h.state.dir).state, 'reserved');
  await assert.rejects(h.host.start({ build: 'fake-build' }), /unresolved: launch-uncertain/);
  assert.equal(h.adapter.calls.filter(([cmd]) => cmd === 'reserve').length, 1);
  h.host._crashForTest(); h.state.remove();
});

test('a refused or interrupted approval reserves nothing', async () => {
  const refused = await makeHost({ hostOptions: { authorizeLaunch: async () => false } });
  await assert.rejects(refused.host.start({ build: 'fake-build' }), /launch authority required/);
  assert.equal(launchCalls(refused), 0);
  assert.equal(refused.host.status().ownership.state, 'free');
  assert.equal(existsSync(join(refused.state.dir, 'ownership.json')), false);
  await assert.rejects(refused.host.start({ build: 'fake-build' }), /authority/, 'asking again asks again');
  refused.host._crashForTest(); refused.state.remove();
});

test('losing the adapter while the app runs stops commands and leaves ownership to a person, not to a respawn', async () => {
  const h = await makeHost();
  await h.host.start({ build: 'fake-build' });
  const { connection } = await connectWorker(h.host);
  h.adapter.events.emit('lost');
  assert.equal(h.host.broker.state, 'parked');
  assert.equal(h.host.status().broker.parked.resumable, false);
  assert.equal(h.host.status().ownership.reason, 'adapter-lost');
  assert.equal(h.app.input.destroyed, false, 'the app\'s pipe is not closed');
  await assert.rejects(connection.session.send('Runtime.evaluate', {}));
  await assert.rejects(h.host.start({ build: 'fake-build' }), /unresolved|retained/);
  h.host._crashForTest(); h.state.remove();
});

test('state directory and key files must be private to this user', () => {
  const root = mkdtempSync(join(tmpdir(), 'eown-'));
  try {
    const open = join(root, 'open'); mkdirSync(open, { mode: 0o755 }); chmodSync(open, 0o755);
    assert.throws(() => privateDirectory(open), /UNSAFE/);
    const target = join(root, 'target'); mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, 'link'));
    assert.throws(() => privateDirectory(join(root, 'link')), /UNSAFE/);
    assert.throws(() => privateDirectory('relative/dir'), /UNSAFE/);
    assert.throws(() => privateDirectory(root + '/a/../open'), /UNSAFE/);
    assert.equal(privateDirectory(join(root, 'fresh')), join(root, 'fresh'));
    const dir = join(root, 'keys'); privateDirectory(dir);
    createJournal({ dir });
    chmodSync(join(dir, 'host.key'), 0o644);
    assert.throws(() => createJournal({ dir }), /KEY_FILE_UNSAFE/);
    chmodSync(join(dir, 'host.key'), 0o600);
    writeFileSync(join(dir, 'host.key'), Buffer.alloc(8), { mode: 0o600 });
    assert.throws(() => createJournal({ dir }), /KEY_FILE_UNSAFE/);
    assert.throws(() => createJournal({ dir: join(root, 'open') }), /UNSAFE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify and reconcile are pure about what they trust', async () => {
  const lock = (nonce = 'n1') => ({ build: 'b', state: { exists: true, nonce, markerNonce: nonce } });
  const trusted = record => ({ status: 'trusted', record });
  assert.deepEqual(classify({ journal: { status: 'absent' }, locks: [{ build: 'b', state: { exists: false } }] }), { state: 'free' });
  assert.deepEqual(classify({ journal: trusted({ state: 'none' }), locks: [] }), { state: 'free' });
  assert.equal(classify({ journal: trusted({ state: 'none' }), locks: [lock()] }).reason, 'lock-without-journal');
  assert.equal(classify({ journal: trusted({ state: 'abandoned', build: 'b', nonce: 'n1' }), locks: [lock()] }).reason, 'host-closed-with-app-owned');
  assert.equal(classify({ journal: { status: 'untrusted', reason: 'journal-unsealed' }, locks: [] }).possibleAppExit, true);
  const adapter = { rpc: async cmd => cmd === 'collect' ? { cleanup: 'removed' } : {} };
  const unresolved = classify({ journal: trusted({ state: 'running', build: 'b', nonce: 'n1' }), locks: [lock()] });
  assert.equal((await reconcile({ unresolved, adapter })).resolved, true);
  assert.equal((await reconcile({ unresolved: { ...unresolved, lock: undefined }, adapter })).reason, 'lock-missing');
  assert.equal((await reconcile({ unresolved: { ...unresolved, lock: lock('n2') }, adapter })).reason, 'journal-contradicts-disk');
  const throwing = { rpc: async cmd => { if (cmd === 'collect') throw Error('ADAPTER_LOST'); return {}; } };
  assert.equal((await reconcile({ unresolved, adapter: throwing })).reason, 'collect-failed');
});
