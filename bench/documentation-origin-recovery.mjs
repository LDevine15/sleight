#!/usr/bin/env node
// One historical documentation-bootstrap lock. No caller-selected paths, engine calls or termination signals.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmdirSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectLiveLock, verifyGroupAbsent } from './hand/event-channel-recovery.mjs';

const INPUT = '/private/tmp/sleight-docs-raw-host-20261021T0148Z.json';
const EXPECTED = '73e29565b8ec97823419d88f0d2060ef1e9a9b5a155f231dd6d446fca6dd9e1f';
const OUTPUT = '/private/tmp/sleight-docs-raw-host-20261021T0148Z-recovery';
const LOCK = '/tmp/sleight-live.lock';
const PID = 7822;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.birthtimeMs === b.birthtimeMs;

function readFixedReceipt() {
  const fd = openSync(INPUT, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o022) || before.size > 65536)
      throw Error('historical receipt ownership or size differs');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (!same(before, after) || !same(after, lstatSync(INPUT)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw Error('historical receipt identity changed');
    return bytes;
  } finally { closeSync(fd); }
}
function fixedWriter() {
  mkdirSync(OUTPUT, { mode: 0o700 });
  const directory = inspectLiveLock(OUTPUT), path = OUTPUT + '/recovery.json';
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const file = fstatSync(fd);
  return {
    save(record) {
      if (!same(directory, inspectLiveLock(OUTPUT)) || !same(file, fstatSync(fd)) || !same(file, lstatSync(path)))
        throw Error('recovery output identity changed');
      const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
      ftruncateSync(fd, 0);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (written <= 0) throw Error('recovery receipt write did not advance');
        offset += written;
      }
      fsyncSync(fd);
    },
    close() { closeSync(fd); },
  };
}

export async function recoverDocumentationOrigin({ recover = false, read = readFixedReceipt, inspect = inspectLiveLock,
  entries = readdirSync, absent = verifyGroupAbsent, writer = fixedWriter, remove = rmdirSync } = {}) {
  const result = { id: 'documentation-origin-recovery', status: 'fail', startedAt: Date.now(), lockRetained: true,
    originalPath: INPUT, originalSha256: EXPECTED, childPid: PID, receiptPath: OUTPUT + '/recovery.json' };
  if (!recover) return { ...result, status: 'refused', reason: 'requires exactly --recover' };
  let sink;
  const checkReceipt = () => {
    const bytes = read();
    if (createHash('sha256').update(bytes).digest('hex') !== EXPECTED) throw Error('historical receipt SHA-256 differs');
    const data = JSON.parse(bytes);
    if (data.id !== 'documentation-bootstrap' || data.status !== 'fail' || data.completed !== true || data.lockRetained !== true ||
        data.cleanup?.started !== true || data.cleanup.childPid !== PID || data.cleanup.groupId !== PID ||
        data.cleanup.childCollected !== true || data.cleanup.groupCollected !== false) throw Error('historical cleanup coordinates differ');
  };
  const checkLock = () => {
    const lock = inspect(LOCK);
    if (lock.dev !== 16777232 || lock.ino !== 2259500286 || lock.uid !== 501 || lock.mode !== 0o755 ||
        Math.floor(lock.birthtimeMs / 1000) !== 1792547223 || entries(LOCK).length !== 0)
      throw Error('attested empty lock identity differs');
    const after = inspect(LOCK);
    if (!same(lock, after)) throw Error('lock changed during empty-directory check');
    return lock;
  };
  try {
    sink = writer(); sink.save(result);
    checkReceipt(); result.lock = checkLock();
    result.absence = await absent(PID, { attempts: 4, delayMs: 50 });
    if (result.absence?.gone !== true || result.absence.state !== 'absent' || result.absence.samples?.at(-1)?.code !== 'ESRCH')
      throw Error('group absence unproved; retain lock for operator inspection');
    checkLock(); checkReceipt();
    result.status = 'pass'; result.lockRetained = false; result.finishedAt = Date.now();
    result.lockRelease = { state: 'eligible-after-terminal-save', confirmed: false }; sink.save(result);
    checkLock(); remove(LOCK); result.lockReleased = true;
    // The receipt intentionally does not claim a release that would require a post-unlock write.
  } catch (error) {
    result.status = 'fail'; result.lockRetained = true; result.finishedAt = Date.now();
    result.failure = String(error.message).slice(0, 500); result.lockRelease = { state: 'retained-or-unconfirmed', confirmed: false };
    try { sink?.save(result); } catch (writeError) { result.receiptFailure = String(writeError.message).slice(0, 500); }
  } finally {
    try { sink?.close(); } catch (closeError) { result.receiptCloseFailure = String(closeError.message).slice(0, 500); }
  }
  return result;
}

export async function main(args) {
  if (args.length !== 1 || args[0] !== '--recover') { console.error('Usage: node bench/documentation-origin-recovery.mjs --recover'); return 2; }
  const result = await recoverDocumentationOrigin({ recover: true });
  console.log(JSON.stringify(result));
  return result.status === 'pass' ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
