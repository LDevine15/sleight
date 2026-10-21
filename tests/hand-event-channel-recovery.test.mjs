import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createChannel, closeOwnedClient } from '../bench/hand/event-channel.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const test = (name, body) => nodeTest(name, { skip: process.platform !== 'darwin' && 'macOS private FIFO recovery only' }, body);

const load = () => import('../bench/hand/event-channel-recovery.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const absent = () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); };
const denied = () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); };
const stamp = path => { const s = lstatSync(path); return { path, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode & 0o777, birthtimeMs: s.birthtimeMs }; };

async function fixture() {
  const module = await load();
  // Resolve the OS alias to the one private temporary root accepted by this macOS bench.
  const root = trackTemp(mkdtempSync(join(realpathSync('/tmp'), 'sleight-hand-recovery-test-')));
  const run = join(root, 'run'), lockPath = join(root, 'live.lock');
  mkdirSync(run, { mode: 0o700 }); mkdirSync(lockPath, { mode: 0o755 });
  const channel = createChannel({ root: run, epoch: 'recovery-epoch', call: 'recovery-call' });
  const receipt = join(run, 'receipt.json');
  const original = { version: 1, status: 'fail', retainLiveLock: true, startedAt: Date.now(),
    receiptPath: receipt, lockRelease: { state: 'retained', confirmed: false }, liveLock: stamp(lockPath),
    identity: { source: JSON.parse(JSON.stringify(module.captureRecoverySource())) },
    cases: [{ status: 'fail', clientPid: 424242, clientClosed: true, groupCollected: false,
      cleanup: { ok: false }, retainLiveLock: true, readerCleanup: { ok: true, closed: 8, errors: [] },
      sent: Array.from({ length: 8 }), manifest: channel.manifest }],
  };
  const save = () => { const bytes = JSON.stringify(original); writeFileSync(receipt, bytes, { mode: 0o600 }); return hash(bytes); };
  return { root, run, lockPath, channel, original, receipt, save,
    options: { recover: true, receipt, out: join(root, 'recovery'), lockPath, groupProbe: absent, attempts: 2, delayMs: 1 } };
}

test('group absence retries EPERM using signal zero only and requires ESRCH', async () => {
  const { verifyGroupAbsent } = await load();
  const calls = [];
  const result = await verifyGroupAbsent(424242, { attempts: 3, delayMs: 1, probe: (pid, signal) => {
    calls.push([pid, signal]); if (calls.length === 1) denied(); else absent();
  } });
  assert.equal(result.gone, true);
  assert.deepEqual(calls, [[-424242, 0], [-424242, 0]]);
  const unknown = await verifyGroupAbsent(424242, { attempts: 2, delayMs: 1, probe: denied });
  assert.equal(unknown.gone, false); assert.equal(unknown.samples.length, 2);
  const present = await verifyGroupAbsent(424242, { probe: () => {} });
  assert.equal(present.gone, false); assert.equal(present.state, 'present');
});

test('recovery removes only the exact recorded bank after group absence and preserves original receipt', async () => {
  const { recoverChannel } = await load(), f = await fixture();
  const expectedSha256 = f.save(), bytes = readFileSync(f.receipt);
  writeFileSync(join(f.run, 'foreign'), 'leave this alone');
  try {
    const result = await recoverChannel({ ...f.options, expectedSha256 });
    assert.equal(result.status, 'pass', JSON.stringify(result));
    assert.equal(result.lockReleased, true);
    assert.equal(existsSync(f.lockPath), false);
    assert.equal(existsSync(f.channel.manifest.directory.path), false);
    assert.deepEqual(readFileSync(f.receipt), bytes);
    assert.equal(readFileSync(join(f.run, 'foreign'), 'utf8'), 'leave this alone');
    assert.equal(result.removed.length, 16);
    const saved = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
    assert.equal(saved.original.sha256, expectedSha256);
    assert.equal(saved.lockRelease.confirmed, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('present or uninspectable group retains every bank path and the lock', async () => {
  const { recoverChannel } = await load();
  for (const groupProbe of [() => {}, denied]) {
    const f = await fixture(), expectedSha256 = f.save();
    try {
      const result = await recoverChannel({ ...f.options, expectedSha256, groupProbe });
      assert.equal(result.status, 'fail');
      assert.equal(result.retainLiveLock, true);
      assert.match(result.operatorAction, /operator/);
      assert.equal(readdirSync(f.channel.manifest.directory.path).length, 16);
      assert.equal(existsSync(f.lockPath), true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('receipt hash, source hash, slot replacement and lock replacement all fail before deletion', async () => {
  const { recoverChannel } = await load();
  for (const fault of ['receipt', 'source', 'slot', 'lock', 'extra-file']) {
    const f = await fixture();
    let expectedSha256 = f.save();
    if (fault === 'receipt') writeFileSync(f.receipt, JSON.stringify({ ...f.original, startedAt: 0 }));
    if (fault === 'source') { f.original.identity.source.probes['bench/hand/event-channel.mjs'] = '0'.repeat(64); expectedSha256 = f.save(); }
    if (fault === 'slot') {
      const path = f.channel.manifest.slots[0].path;
      renameSync(path, path + '.original'); symlinkSync(path + '.original', path);
    }
    if (fault === 'lock') { renameSync(f.lockPath, f.lockPath + '.original'); mkdirSync(f.lockPath); }
    if (fault === 'extra-file') writeFileSync(join(f.channel.manifest.directory.path, 'foreign'), 'leave this alone');
    try {
      const result = await recoverChannel({ ...f.options, expectedSha256 });
      assert.equal(result.status, 'fail', fault);
      assert.deepEqual(result.removed, []);
      assert.equal(existsSync(f.lockPath), true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('partial deletion failure records exact progress and retains the lock', async () => {
  const { recoverChannel } = await load(), f = await fixture(), expectedSha256 = f.save();
  let removals = 0;
  try {
    const result = await recoverChannel({ ...f.options, expectedSha256, unlink: path => {
      if (++removals === 3) throw Error('injected unlink refusal');
      unlinkSync(path);
    } });
    assert.equal(result.status, 'fail');
    assert.equal(result.removed.length, 2);
    assert.equal(readdirSync(f.channel.manifest.directory.path).length, 14);
    assert.equal(existsSync(f.lockPath), true);
    const repeated = await recoverChannel({ ...f.options, out: join(f.root, 'second-recovery'), expectedSha256 });
    assert.equal(repeated.status, 'fail');
    assert.deepEqual(repeated.removed, []);
    assert.match(repeated.failure.message, /unknown or missing files/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('future client cleanup may qualify an EPERM retry only on positive group absence proof', async () => {
  const probes = [];
  const result = await closeOwnedClient({ pid: 424242, close: async () => true }, {
    collect: async () => { throw Error('owned group cleanup unconfirmed: kill EPERM'); },
    absence: async pid => { probes.push(pid); return { gone: true, samples: [{ code: 'ESRCH' }] }; },
  });
  assert.equal(result.groupCollected, true);
  assert.deepEqual(probes, [424242]);
  assert.equal(result.groupAbsenceProof.gone, true);
  for (const absence of [async () => ({ gone: false, state: 'unknown', samples: [{ code: 'EPERM' }] }),
    async () => { throw Error('read-only absence unavailable'); }]) {
    let collections = 0;
    const uncertain = await closeOwnedClient({ pid: 424242, close: async () => true }, {
      collect: async () => { collections++; throw Error('owned group cleanup unconfirmed: kill EPERM'); }, absence,
    });
    assert.equal(uncertain.groupCollected, false);
    assert.equal(collections, 1);
    assert.match(uncertain.groupCleanupFailure.message, /EPERM/);
  }
});

test('recovery output cannot mutate the retained bank before absence verification', async () => {
  const { recoverChannel } = await load(), f = await fixture(), expectedSha256 = f.save();
  let probes = 0;
  try {
    const result = await recoverChannel({ ...f.options, expectedSha256,
      out: join(f.channel.manifest.directory.path, 'recovery'), groupProbe: () => { probes++; absent(); } });
    assert.equal(result.status, 'fail');
    assert.equal(probes, 0);
    assert.equal(readdirSync(f.channel.manifest.directory.path).length, 16);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('canonical lock aliases and nonnormalized receipt paths reject before output creation', async () => {
  const { recoverChannel } = await load();
  for (const fault of ['lock-alias', 'receipt-traversal']) {
    const f = await fixture(), expectedSha256 = f.save();
    const options = { ...f.options, expectedSha256 };
    if (fault === 'lock-alias') {
      const alias = join(f.root, 'alias'); symlinkSync(f.root, alias);
      options.lockPath = join(alias, 'live.lock'); options.out = join(f.lockPath, 'recovery');
    } else options.receipt = join(f.run, '..') + '/run/../run/receipt.json';
    try {
      const result = await recoverChannel(options);
      assert.equal(result.status, 'fail');
      assert.equal(existsSync(options.out), false);
      assert.equal(readdirSync(f.lockPath).length, 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
