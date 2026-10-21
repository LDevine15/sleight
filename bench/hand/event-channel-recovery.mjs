#!/usr/bin/env node
// Root-only recovery of this bench's retained FIFO bank. No engine, renderer, TERM or KILL operation.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const PROBES = ['bench/hand/event-channel.mjs', 'bench/hand/event-channel-live.mjs', 'tests/hand-event-channel.test.mjs',
  'bench/hand/event-channel-recovery.mjs', 'tests/hand-event-channel-recovery.test.mjs'];
const DEPS = ['plugins/sleight/lib/document-scope.mjs', 'plugins/sleight/lib/launch.mjs',
  'plugins/sleight/lib/owned-group.mjs', 'bench/compat/client.mjs', 'bench/live-lock.mjs'];
const LEGACY_SHA = '1281b8f27603acc6aa3647d557f3bd3cb0f2407e9a6965893c7c7e507ce95341';
const LEGACY_PATH = '/private/tmp/sleight-p141-hand-channel-host-20261021T0129Z/receipt.json';
const LEGACY_SOURCE = {
  'bench/hand/event-channel.mjs': 'd37cbd7b2db3c45e2eb9b0611757a044b310872699a9b17330302bc9a6627330',
  'bench/hand/event-channel-live.mjs': 'bf1e68afc2682a4155f1edaee87f4f3b74b6d29066983cbb6f724a6a46b4d109',
  'tests/hand-event-channel.test.mjs': '5695764facdc67a45dc7604c18107165fc8d80630221ce98ef9cebcb04956f2f',
  'plugins/sleight/lib/document-scope.mjs': '8f9636383adac52dd5615f522a83a77153883680eb11898aa06f25e3a0d45328',
  'plugins/sleight/lib/launch.mjs': 'ef7e69dcccff14eff9b8df3d557a3fbff84724063aa9c57f57d9e923b542c7d8',
  'plugins/sleight/lib/owned-group.mjs': '503a9f3e1437597a0b1c67dc3824d47a044a7955a68b4eed4df45dd7ac2e658f',
  'bench/compat/client.mjs': 'b61210fd974b07eb461e73050902f07ed5333b597c70aeda41a8f5fe89496981',
  'bench/live-lock.mjs': '12c92f67f052d858c61c9f14ba455d2eb26c32d01a3a2d92497b70ed73f67248',
};
const stamp = s => ({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode & 0o777, birthtimeMs: s.birthtimeMs });
const same = (s, expected) => s.dev === expected.dev && s.ino === expected.ino && s.uid === expected.uid &&
  (s.mode & 0o777) === expected.mode && (expected.birthtimeMs === undefined || s.birthtimeMs === expected.birthtimeMs);
const detail = error => ({ message: String(error?.message ?? error).slice(0, 500), code: error?.code ?? null });

export function captureRecoverySource() {
  const hashes = paths => Object.freeze(Object.fromEntries(paths.map(path => {
    const file = join(ROOT, path), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== process.getuid()) throw Error('source file identity is invalid');
      const digest = sha256(readFileSync(fd)), after = fstatSync(fd);
      if (!same(after, stamp(before)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !same(lstatSync(file), stamp(before)))
        throw Error('source file changed while hashing');
      return [path, digest];
    } finally { closeSync(fd); }
  })));
  return Object.freeze({ head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 1000 }).trim(), probes: hashes(PROBES), dependencies: hashes(DEPS) });
}

/** ESRCH proves absence. EPERM, zombies and inspector failures never become absence by inference. */
export async function verifyGroupAbsent(pid, { attempts = 4, delayMs = 50, probe = process.kill,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid > 2147483647) throw Error('invalid recorded group PID');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 8 || !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 250)
    throw Error('invalid bounded absence budget');
  const result = { pid, gone: false, state: 'unknown', samples: [] };
  for (let n = 0; n < attempts; n++) {
    try { probe(-pid, 0); result.samples.push({ at: Date.now(), state: 'present' }); result.state = 'present'; return result; }
    catch (error) {
      result.samples.push({ at: Date.now(), code: error.code ?? null });
      if (error.code === 'ESRCH') { result.gone = true; result.state = 'absent'; return result; }
      if (error.code !== 'EPERM') return result;
    }
    if (n + 1 < attempts) await sleep(delayMs);
  }
  return result;
}

function checkDirectory(path, expected, mode = 0o700) {
  const canonical = realpathSync(path), stat = lstatSync(path);
  // /tmp itself is the operating system's alias. All private banks and outputs must use canonical paths.
  if (canonical !== path && path !== '/tmp/sleight-live.lock') throw Error('directory path contains a symlink');
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode || expected && !same(stat, expected))
    throw Error('directory identity or ownership changed');
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { if (!same(fstatSync(fd), stamp(stat))) throw Error('directory descriptor identity changed'); }
  finally { closeSync(fd); }
  return stamp(stat);
}
export function inspectLiveLock(path = '/tmp/sleight-live.lock') {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || ![0o700, 0o755].includes(stat.mode & 0o777))
    throw Error('live lock is not an owned ordinary directory');
  checkDirectory(path, stamp(stat), stat.mode & 0o777);
  return { path, ...stamp(stat) };
}
function readOriginal(path) {
  if (resolve(path) !== path || !path.startsWith('/private/tmp/')) throw Error('original receipt path must be private and normalized');
  const parent = checkDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600 || before.size > 1 << 20)
      throw Error('original receipt ownership, mode or size is invalid');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (!same(after, stamp(before)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !same(lstatSync(path), stamp(before)))
      throw Error('original receipt changed while reading');
    checkDirectory(dirname(path), parent);
    return { data: JSON.parse(bytes), sha256: sha256(bytes), file: stamp(before), parent };
  } finally { closeSync(fd); }
}
function verifySource(source, receiptHash, path) {
  const current = captureRecoverySource();
  if (source?.head !== current.head) throw Error('recorded source HEAD differs');
  const entries = { ...source.probes, ...source.dependencies };
  if (receiptHash === LEGACY_SHA && path === LEGACY_PATH && source.head === '9d4733e45ae56f85a156c955df83373e8c80e7d8' &&
      Object.keys(entries).length === 8 && Object.entries(LEGACY_SOURCE).every(([file, digest]) => entries[file] === digest))
    return 'reviewed-p141-initial-source';
  if (JSON.stringify(source) !== JSON.stringify(current)) throw Error('recorded source hashes differ');
  return 'current-source-bytes';
}
function validateManifest(manifest, runRoot) {
  const dir = manifest?.directory;
  if (manifest?.version !== 1 || !dir || dirname(dir.path) !== runRoot || !/^channel-[a-zA-Z0-9]+$/.test(dir.path.slice(runRoot.length + 1)) ||
      ![manifest.epoch, manifest.call].every(x => typeof x === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(x)) ||
      !Array.isArray(manifest.slots) || manifest.slots.length !== 16) throw Error('recorded manifest is invalid');
  const keys = new Set(), files = new Set();
  for (const slot of manifest.slots) {
    const pair = `${slot.action}-${slot.attempt}`, key = `${pair}-${slot.stage}`;
    if (!['0-1', '1-1', '1-2', '2-1'].includes(pair) || !['invoke', 'approval', 'fulfilled', 'rejected'].includes(slot.stage) ||
        slot.epoch !== manifest.epoch || slot.call !== manifest.call || slot.path !== join(dir.path, key + '.fifo') || keys.has(key) ||
        !slot.file || slot.file.uid !== process.getuid() || slot.file.mode !== 0o600 || !Number.isSafeInteger(slot.file.dev) ||
        !Number.isSafeInteger(slot.file.ino) || files.has(`${slot.file.dev}/${slot.file.ino}`)) throw Error('recorded slot identity is invalid');
    keys.add(key); files.add(`${slot.file.dev}/${slot.file.ino}`);
  }
}
function checkSlot(slot) {
  const stat = lstatSync(slot.path);
  if (!stat.isFIFO() || !same(stat, slot.file)) throw Error('recorded FIFO identity changed');
  const fd = openSync(slot.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try { if (!same(fstatSync(fd), slot.file) || !same(lstatSync(slot.path), slot.file)) throw Error('FIFO descriptor identity changed'); }
  finally { closeSync(fd); }
}

/** apply requires explicit opt-in; the CLI exposes only the fixed shared lock, never caller-selected cleanup roots. */
export async function recoverChannel({ recover = false, receipt, out, expectedSha256, lockPath = '/tmp/sleight-live.lock',
  groupProbe = process.kill, attempts = 4, delayMs = 50, unlink = unlinkSync } = {}) {
  const result = { version: 1, status: 'fail', startedAt: Date.now(), removed: [], retainLiveLock: true,
    operatorAction: 'Retain the lock for operator inspection if group absence or ownership is unproved.' };
  if (!recover) return { ...result, status: 'refused', failure: { message: 'requires explicit --recover' } };
  let fd, outOwned, receiptOwned;
  const persist = () => {
    if (fd === undefined) return;
    checkDirectory(out, outOwned);
    if (!same(lstatSync(result.receiptPath), receiptOwned) || !same(fstatSync(fd), receiptOwned)) throw Error('recovery receipt identity changed');
    const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    ftruncateSync(fd, 0);
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fsyncSync(fd);
  };
  try {
    if (typeof receipt !== 'string' || resolve(receipt) !== receipt || !receipt.startsWith('/private/tmp/'))
      throw Error('original receipt path must be private and normalized');
    const receiptRoot = dirname(receipt), canonicalLock = realpathSync(lockPath);
    if (realpathSync(receiptRoot) !== receiptRoot) throw Error('original receipt directory contains a symlink');
    if (!out || resolve(out) !== out || !out.startsWith('/private/tmp/') || realpathSync(dirname(out)) !== dirname(out))
      throw Error('recovery output must be an absent private normalized directory');
    if (out === receiptRoot || out.startsWith(receiptRoot + '/') || out === canonicalLock || out.startsWith(canonicalLock + '/'))
      throw Error('recovery output must be separate from the retained run and lock');
    mkdirSync(out, { mode: 0o700 }); outOwned = checkDirectory(out);
    result.receiptPath = join(out, 'recovery.json');
    fd = openSync(result.receiptPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    receiptOwned = stamp(fstatSync(fd)); persist();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) throw Error('requires reviewed original SHA-256');
    const original = readOriginal(receipt);
    result.original = { path: receipt, sha256: original.sha256, file: original.file };
    if (original.sha256 !== expectedSha256) throw Error('original receipt SHA-256 differs');
    const run = original.data;
    if (run.version !== 1 || run.status !== 'fail' || run.retainLiveLock !== true || run.receiptPath !== receipt ||
        run.lockRelease?.state !== 'retained' || run.activeManifest || run.activeClientPid || !Array.isArray(run.cases) ||
        run.cases.length < 1 || run.cases.length > 4) throw Error('original run is not an eligible retained cleanup');
    result.sourceVerification = verifySource(run.identity?.source, original.sha256, receipt);
    result.recoverySource = captureRecoverySource();
    const pending = run.cases.filter(row => row.cleanup?.ok !== true);
    if (pending.length !== 1) throw Error('recovery requires exactly one retained bank');
    const row = pending[0];
    if (row.clientClosed !== true || row.groupCollected !== false || row.retainLiveLock !== true || row.readerCleanup?.ok !== true ||
        !Number.isSafeInteger(row.clientPid) || row.clientPid <= 1) throw Error('recorded child or reader cleanup is uncertain');
    for (const other of run.cases) if (other !== row && (other.clientClosed !== true || other.groupCollected !== true || other.cleanup?.ok !== true))
      throw Error('another case has uncertain cleanup');
    let lock = run.liveLock;
    if (!lock && original.sha256 === LEGACY_SHA && receipt === LEGACY_PATH) {
      lock = { path: '/tmp/sleight-live.lock', dev: 16777232, ino: 2259440967, uid: 501, mode: 0o755 };
      const current = inspectLiveLock(lockPath);
      if (Math.floor(current.birthtimeMs / 1000) !== 1792545900 || Math.floor(run.startedAt / 1000) !== 1792545900)
        throw Error('legacy live-lock birth time differs');
      result.legacyLockAttestation = { birthSeconds: 1792545900, runStartedAt: run.startedAt };
    }
    if (!lock || lock.path !== lockPath || ![0o700, 0o755].includes(lock.mode)) throw Error('recorded live-lock identity is missing');
    result.liveLock = lock;
    const checkLock = () => checkDirectory(lockPath, lock, lock.mode);
    checkLock();
    validateManifest(row.manifest, dirname(receipt));
    const bank = row.manifest.directory;
    result.manifest = row.manifest; result.clientPid = row.clientPid;
    const checkBank = () => { checkDirectory(dirname(receipt), original.parent); checkDirectory(bank.path, bank); };
    checkBank();
    if (JSON.stringify(readdirSync(bank.path).sort()) !== JSON.stringify(row.manifest.slots.map(slot => slot.path.slice(bank.path.length + 1)).sort()))
      throw Error('bank contains unknown or missing files');
    for (const slot of row.manifest.slots) checkSlot(slot);
    const group = async () => {
      const proof = await verifyGroupAbsent(row.clientPid, { probe: groupProbe, attempts, delayMs });
      (result.groupChecks ??= []).push(proof);
      if (!proof.gone) throw Error('group absence unproved; operator inspection required');
    };
    await group(); checkLock(); checkBank(); persist();
    // Revalidate the original receipt before any deletion. No recovery result changes its bytes.
    if (readOriginal(receipt).sha256 !== original.sha256) throw Error('original receipt changed before cleanup');
    for (const slot of row.manifest.slots) {
      checkLock(); checkBank(); checkSlot(slot); unlink(slot.path); result.removed.push(slot.path); persist();
    }
    checkBank(); rmdirSync(bank.path); result.bankRemoved = true;
    await group(); checkLock();
    result.status = 'pass'; result.retainLiveLock = false; result.finishedAt = Date.now();
    result.lockRelease = { state: 'eligible-after-terminal-save', confirmed: false }; persist();
    checkLock(); rmdirSync(lockPath); result.lockReleased = true;
    // Successful lock release is reported only in the return/CLI, never through a post-release write.
  } catch (error) {
    result.status = 'fail'; result.retainLiveLock = true; result.failure = detail(error); result.finishedAt = Date.now();
    result.lockRelease = { state: 'retained-or-unconfirmed', confirmed: false };
    try { persist(); } catch (writeError) { result.diagnosticFailure = detail(writeError); }
  } finally { if (fd !== undefined) closeSync(fd); }
  return result;
}

export async function main(args) {
  let recover = false, receipt, out, expectedSha256;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--recover') recover = true;
    else if (args[i] === '--receipt') receipt = args[++i];
    else if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--original-sha256') expectedSha256 = args[++i];
    else { console.error('Unknown recovery argument'); return 2; }
  }
  const result = await recoverChannel({ recover, receipt, out, expectedSha256 });
  console.log(JSON.stringify({ status: result.status, receipt: result.receiptPath, lockReleased: result.lockReleased === true,
    retainLiveLock: result.retainLiveLock, failure: result.failure, operatorAction: result.status === 'pass' ? undefined : result.operatorAction }));
  return result.status === 'pass' ? 0 : result.status === 'refused' ? 2 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
