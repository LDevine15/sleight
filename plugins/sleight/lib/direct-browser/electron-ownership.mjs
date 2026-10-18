// Durable ownership record for the resident Electron host, and the reconciliation rules that
// read it after a host restart. Used only by electron-host.mjs.
//
// The host owns an app only through pipes held in memory. If the host process dies, the app sees
// its pipe close and may quit (Electron exits on pipe EOF), possibly with unsaved work. So the
// record below can only ever say "an app was owned": it can never prove the app is gone or that
// its directories are clean. A restarted host therefore treats any record, any missing or
// untrusted record, and any leftover build lock as unresolved ownership, refuses a second
// launch, and clears it only with proof gathered from outside the journal (see reconcile()).
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  writeSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';

const fail = code => { throw Error(code); };
const states = new Set(['none', 'reserved', 'running', 'closing', 'abandoned']);
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** A directory only this user can enter. Created if missing; refused if it is anything else. */
export function privateDirectory(path, uid = process.getuid?.()) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path) fail('STATE_DIR_UNSAFE');
  try { mkdirSync(path, { mode: 0o700, recursive: false }); } catch (error) { if (error.code !== 'EEXIST') fail('STATE_DIR_UNSAFE'); }
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== uid || (status.mode & 0o077)) fail('STATE_DIR_UNSAFE');
  return path;
}

function writeFileDurably(path, bytes, mode = 0o600) {
  const temporary = path + '.next';
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(join(path, '..'), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function secretFile(path, uid) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code !== 'ENOENT') fail('KEY_FILE_UNSAFE'); }
  if (fd !== undefined) {
    try {
      const status = fstatSync(fd);
      if (!status.isFile() || status.uid !== uid || (status.mode & 0o077) || status.size !== 32) fail('KEY_FILE_UNSAFE');
      return readFileSync(fd);
    } finally { closeSync(fd); }
  }
  const key = randomBytes(32);
  writeFileDurably(path, key);
  return key;
}

/** A 32-byte secret in a file only this user can read (created on first use). */
export function privateSecret(dir, name, uid = process.getuid?.()) {
  privateDirectory(dir, uid);
  return secretFile(join(dir, name), uid);
}

/** The sealed journal. A record is accepted only if its seal verifies under host.key. */
export function createJournal({ dir, uid = process.getuid?.() }) {
  privateDirectory(dir, uid);
  const keyPath = join(dir, 'host.key'), journalPath = join(dir, 'ownership.json');
  // A key recreated next to an old journal cannot verify its seal: that journal reads as untrusted.
  const key = secretFile(keyPath, uid);
  const seal = record => createHmac('sha256', key).update(canonical(record)).digest('base64url');
  function read() {
    let text;
    try {
      const status = lstatSync(journalPath);
      if (!status.isFile() || status.uid !== uid || (status.mode & 0o077) || status.size > 65536) return { status: 'untrusted', reason: 'journal-unsafe' };
      text = readFileSync(journalPath, 'utf8');
    } catch (error) { return error.code === 'ENOENT' ? { status: 'absent' } : { status: 'untrusted', reason: 'journal-unreadable' }; }
    try {
      const envelope = JSON.parse(text);
      const { record, sealed } = envelope;
      if (!record || typeof record !== 'object' || typeof sealed !== 'string' || Object.keys(envelope).length !== 2) throw Error();
      const expected = Buffer.from(seal(record)), actual = Buffer.from(sealed);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { status: 'untrusted', reason: 'journal-unsealed' };
      if (!states.has(record.state)) return { status: 'untrusted', reason: 'journal-unsealed' };
      return { status: 'trusted', record };
    } catch { return { status: 'untrusted', reason: 'journal-unsealed' }; }
  }
  function write(record) {
    if (!states.has(record?.state)) fail('JOURNAL_RECORD_INVALID');
    const bytes = Buffer.from(JSON.stringify({ record, sealed: seal(record) }));
    if (bytes.length > 65536) fail('JOURNAL_RECORD_INVALID');
    writeFileDurably(journalPath, bytes);
  }
  return Object.freeze({ read, write, path: journalPath });
}

/**
 * What a restarted host knows before it touches anything.
 *   journal  : result of journal.read()
 *   locks    : [{ build, state }] where state is the adapter's read-only lockstate for each reviewed build
 * Returns { state: 'free' } or { state: 'unresolved', reason, possibleAppExit, record?, lock? }.
 * Only 'free' permits a launch.
 */
export function classify({ journal, locks }) {
  const held = locks.filter(item => item.state?.exists === true);
  if (journal.status === 'untrusted') {
    return { state: 'unresolved', reason: journal.reason, possibleAppExit: true, lock: held[0] };
  }
  const record = journal.status === 'trusted' ? journal.record : undefined;
  if (!record || record.state === 'none') {
    return held.length ? { state: 'unresolved', reason: 'lock-without-journal', possibleAppExit: true, lock: held[0] } : { state: 'free' };
  }
  // A sealed record of an owned app, written by a host that is no longer running this process.
  // The pipe is gone, so the app may already have quit.
  const lock = held.find(item => item.build === record.build);
  const reason = record.state === 'abandoned' ? 'host-closed-with-app-owned' : 'host-crash-possible-app-exit';
  return { state: 'unresolved', reason, possibleAppExit: true, record, lock };
}

/**
 * Proof gathered outside the journal, in order. Any step that cannot be proved returns
 * { resolved: false, reason } and leaves everything in place.
 *   adapter.recover({build, nonce})  : the on-disk lock, owner file and profile root must still be the
 *                                      original inodes the launch recorded, and name this nonce
 *   adapter.collect()                : needs a complete census with every recorded incarnation absent
 */
export async function reconcile({ unresolved, adapter, acceptDiskEvidence = false, holds = false }) {
  const record = unresolved.record;
  let nonce, build = record?.build;
  if (record) {
    if (!unresolved.lock?.state?.exists) return { resolved: false, reason: 'lock-missing' };
    nonce = unresolved.lock.state.nonce;
    if (nonce !== record.nonce) return { resolved: false, reason: 'journal-contradicts-disk' };
  } else {
    // No trusted record: a leftover lock is the only evidence. It names its own nonce on disk and
    // the profile marker must agree with it, but a person has to accept that explicitly.
    if (!acceptDiskEvidence || !unresolved.lock?.state?.exists) return { resolved: false, reason: 'no-trusted-journal' };
    nonce = unresolved.lock.state.nonce; build = unresolved.lock.build;
    if (!nonce || unresolved.lock.state.markerNonce !== nonce) return { resolved: false, reason: 'lock-evidence-incoherent' };
  }
  // An adapter that still holds this very launch (the host did not restart) needs no recovery, only the census.
  if (!holds) try { await adapter.rpc('recover', { build, nonce }); }
  catch (error) { return { resolved: false, reason: 'recovery-evidence-refused', detail: String(error.message).slice(0, 200) }; }
  let result;
  try { result = await adapter.rpc('collect', {}); }
  catch (error) { return { resolved: false, reason: 'collect-failed', detail: String(error.message).slice(0, 200) }; }
  if (result?.cleanup !== 'removed') return { resolved: false, reason: 'processes-or-census-unproved', detail: String(result?.reason ?? '').slice(0, 200) };
  return { resolved: true };
}
