// Bench transport only. Cooperative metadata cannot authorize input or establish native dispatch timing.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { guardedCode } from '../../plugins/sleight/lib/document-scope.mjs';
import { textOf } from '../compat/client.mjs';
import { collectOwnedGroup } from '../../plugins/sleight/lib/owned-group.mjs';
import { verifyGroupAbsent } from './event-channel-recovery.mjs';

const ATTEMPTS = [[0, 1], [1, 1], [1, 2], [2, 1]];
const STAGES = ['invoke', 'approval', 'fulfilled', 'rejected'];
const KEY = event => [event.epoch, event.call, event.action, event.attempt, event.stage].join('/');
const stamp = stat => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && (a.mode & 0o777) === b.mode;
const failure = error => ({ message: String(error?.message ?? error).slice(0, 500), code: error?.code ?? null });
function directory(path, expected) {
  if (realpathSync(path) !== path) throw Error('channel directory contains a symlink');
  const before = lstatSync(path);
  if (!before.isDirectory() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o700 || expected && !same(before, expected))
    throw Error('channel directory identity or ownership changed');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { if (!same(fstatSync(fd), stamp(before))) throw Error('channel directory descriptor identity changed'); }
  finally { closeSync(fd); }
  return stamp(before);
}
function slotIdentity(slot, fd) {
  const current = fd === undefined ? lstatSync(slot.path) : fstatSync(fd);
  if (!current.isFIFO() || !same(current, slot.file)) throw Error('channel slot identity or ownership changed (including symlink)');
}

/** One private bank, 16 FIFOs maximum. No scan or cleanup of shared tab-probe files. */
export function createChannel({ root, epoch, call } = {}) {
  if (![epoch, call].every(value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value))) throw Error('invalid immutable channel identity');
  const parent = directory(root);
  const path = mkdtempSync(join(root, 'channel-'));
  const owned = directory(path);
  const slots = ATTEMPTS.flatMap(([action, attempt]) => STAGES.map(stage => ({ epoch, call, action, attempt, stage,
    path: join(path, `${action}-${attempt}-${stage}.fifo`) })));
  const events = [], consumed = new Set();
  let creationError;
  try {
    execFileSync('/usr/bin/mkfifo', ['-m', '600', ...slots.map(slot => slot.path)], { stdio: 'pipe', timeout: 1000 });
  } catch (error) { creationError = failure(error); }
  // Record only files actually created. Partial creation is retained for diagnosis and owned cleanup.
  for (const slot of slots) {
    try {
      const stat = lstatSync(slot.path);
      if (!stat.isFIFO() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw Error('unsafe created channel slot');
      slot.file = Object.freeze(stamp(stat));
    } catch (error) { creationError ??= failure(error); }
    Object.freeze(slot);
  }
  const manifest = Object.freeze({ version: 1, epoch, call, directory: Object.freeze({ path, ...owned }),
    slots: Object.freeze(slots), stateKey: `__sleightHandChannel_${randomUUID().replaceAll('-', '')}` });
  const verify = () => { directory(root, parent); directory(path, owned); };
  return {
    manifest, events, creationError,
    poll() {
      verify();
      if (creationError) throw Error(`channel creation failed: ${creationError.message}`);
      for (const slot of slots) {
        slotIdentity(slot);
        if (consumed.has(KEY(slot))) continue;
        let fd;
        try {
          fd = openSync(slot.path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
          slotIdentity(slot, fd); slotIdentity(slot); verify();
          consumed.add(KEY(slot));
          events.push({ epoch, call, action: slot.action, attempt: slot.attempt, stage: slot.stage, receivedAt: Date.now() });
        } catch (error) { if (error.code !== 'ENXIO') throw error; }
        finally { if (fd !== undefined) closeSync(fd); }
      }
    },
    cleanup() {
      const errors = [];
      try { verify(); } catch (error) {
        if (error.code === 'ENOENT') return { ok: false, errors: [failure(error)] };
        return { ok: false, errors: [failure(error)] };
      }
      for (const slot of slots) {
        if (!slot.file) continue;
        try { slotIdentity(slot); unlinkSync(slot.path); }
        catch (error) { if (error.code !== 'ENOENT') errors.push(failure(error)); }
      }
      try { verify(); rmdirSync(path); } catch (error) { errors.push(failure(error)); }
      return { ok: errors.length === 0, errors };
    },
  };
}

/** No native handles. The real guard generator runs only against the three fake buttons. */
export function buildProbeCode(manifest, { approval = false, delivery = 'during', fault } = {}) {
  const window = { title: 'hand-channel-fake', app: 'Fixture', url: null };
  let guarded = guardedCode('await app.click(1); await app.click(2); await app.click(3);', window,
    'changed window', undefined, { focused: true, bind: true, handBindingMark: 'binding:' });
  const first = 'try { result = await value.apply(raw, args); } catch (error) {';
  const retry = 'try { result = await value.apply(raw, args); resent = true; } catch (again) {';
  if (guarded.split(first).length !== 3 || guarded.split(retry).length !== 2) throw Error('guard instrumentation sites changed; review probe before running');
  guarded = guarded.replaceAll(first,
    'try { __mark(attempt, "invoke"); result = await value.apply(raw, args); __mark(attempt, "fulfilled"); } catch (error) { __mark(attempt, "rejected");')
    .replace(retry, 'try { __mark(attempt, "invoke"); result = await value.apply(raw, args); __mark(attempt, "fulfilled"); resent = true; } catch (again) { __mark(attempt, "rejected");');
  // This is a normal submitted-code block. The single fs import is setup, never a per-event await.
  return `{
    const __manifest = ${JSON.stringify(manifest)};
    for (const slot of __manifest.slots) { Object.freeze(slot.file); Object.freeze(slot); }
    Object.freeze(__manifest.slots); Object.freeze(__manifest.directory); Object.freeze(__manifest);
    const __state = { fds: [], sent: [], boundaries: [], bindings: [], failure: null };
    globalThis[__manifest.stateKey] = __state;
    try {
      const __fs = await import('node:fs');
      const __seen = new Set(); let __current;
      const __same = (s, e) => s.dev === e.dev && s.ino === e.ino && s.uid === e.uid && (s.mode & 511) === e.mode;
      const __directory = () => {
        const p = __manifest.directory, s = __fs.lstatSync(p.path);
        if (!s.isDirectory() || !__same(s, p)) throw Error('sandbox directory identity changed');
        const fd = __fs.openSync(p.path, __fs.constants.O_RDONLY | __fs.constants.O_DIRECTORY | __fs.constants.O_NOFOLLOW);
        try { if (!__same(__fs.fstatSync(fd), p)) throw Error('sandbox directory descriptor identity changed'); }
        finally { __fs.closeSync(fd); }
      };
      const __emit = (a, stage, boundaryAt) => {
        if (__state.failure) return;
        let fd;
        try {
          const slot = __manifest.slots.find(s => s.action === a.index && s.attempt === a.probeAttempt && s.stage === stage);
          if (!slot) throw Error('unknown event identity');
          const key = [slot.action, slot.attempt, slot.stage].join('/');
          if (__seen.has(key)) throw Error('duplicate event demand');
          __seen.add(key);
          if (${JSON.stringify(fault)} === 'missing' && slot.action === 2 && stage === 'fulfilled') return;
          __directory();
          const check = s => { if (!s.isFIFO() || !__same(s, slot.file)) throw Error('sandbox slot identity changed'); };
          check(__fs.lstatSync(slot.path));
          fd = __fs.openSync(slot.path, __fs.constants.O_RDONLY | __fs.constants.O_NONBLOCK | __fs.constants.O_NOFOLLOW);
          check(__fs.fstatSync(fd)); check(__fs.lstatSync(slot.path)); __directory();
          __state.fds.push({ fd, slot }); fd = undefined;
          __state.sent.push({ epoch: slot.epoch, call: slot.call, action: slot.action, attempt: slot.attempt,
            stage, boundaryAt, sentAt: Date.now() });
        } catch (error) {
          if (fd !== undefined) try { __fs.closeSync(fd); } catch {}
          __state.failure = { message: String(error.message).slice(0, 500), code: error.code ?? null };
        }
      };
      const __mark = (attempt, stage) => {
        const boundaryAt = Date.now();
        if (stage === 'invoke') { attempt.probeAttempt = (attempt.probeAttempt ?? 0) + 1; __current = attempt; }
        __state.boundaries.push({ action: attempt.index, attempt: attempt.probeAttempt, stage, boundaryAt });
        __emit(attempt, stage, boundaryAt);
        if (${JSON.stringify(fault)} === 'duplicate' && attempt.index === 0 && stage === 'invoke') __emit(attempt, stage, boundaryAt);
      };
      const __attempts = new Map();
      const __tree = 'Window: "hand-channel-fake", App: Fixture.\\n0 standard window\\n\\t1 button First\\n\\t2 button Second\\n\\t3 button Third';
      const __fake = {
        getAXState: async () => __tree,
        click: async target => {
          const n = (__attempts.get(target) ?? 0) + 1; __attempts.set(target, n);
          if (${JSON.stringify(approval)}) __emit(__current, 'approval', Date.now());
          if (target === 2 && n === 1) throw Error('2 is an invalid element ID');
          // Artificial pacing belongs only to this transport measurement, not the production action path.
          if (${JSON.stringify(delivery)} === 'during') await new Promise(resolve => setTimeout(resolve, 60));
          else await Promise.resolve();
        },
      };
      await (async (app, cua, nodeRepl) => { ${guarded} })(__fake, { getApp: async () => __fake },
        { write: value => { if (typeof value === 'string' && value.startsWith('binding:')) __state.bindings.push(JSON.parse(value.slice(8)).index); } });
    } catch (error) { __state.failure ??= { message: String(error.message).slice(0, 500), code: error.code ?? null }; }
    nodeRepl.write('hand-channel-result:' + JSON.stringify({ epoch: __manifest.epoch, call: __manifest.call,
      sent: __state.sent, boundaries: __state.boundaries, bindings: __state.bindings, failure: __state.failure, openReaders: __state.fds.length }));
  }`;
}

export function cleanupCode(manifest) {
  return `{
    const fs = await import('node:fs'), key = ${JSON.stringify(manifest.stateKey)}, state = globalThis[key];
    const errors = []; let closed = 0;
    if (!state) errors.push('missing descriptor ledger');
    else for (const entry of state.fds) {
      try {
        const s = fs.fstatSync(entry.fd), e = entry.slot.file;
        if (!s.isFIFO() || s.dev !== e.dev || s.ino !== e.ino || s.uid !== e.uid || (s.mode & 511) !== e.mode) throw Error('reader descriptor identity changed');
        fs.closeSync(entry.fd); closed++;
      } catch (error) { errors.push(String(error.message).slice(0, 200)); }
    }
    if (!errors.length) delete globalThis[key];
    nodeRepl.write('hand-channel-cleanup:' + JSON.stringify({ ok: errors.length === 0, closed, errors }));
  }`;
}

function parsed(result, mark) {
  if (result?.isError) throw Error(`sandbox refused probe: ${textOf(result).slice(0, 500)}`);
  const lines = textOf(result).split('\n').filter(line => line.startsWith(mark));
  if (lines.length !== 1) throw Error(`missing or duplicate ${mark} receipt: ${textOf(result).slice(0, 500)}`);
  return JSON.parse(lines[0].slice(mark.length));
}
export async function bounded(operation, timeoutMs, signal) {
  signal?.throwIfAborted();
  let timer, abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? Error('cancelled'));
    timer = setTimeout(() => reject(Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); }), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

// close() collects the compatibility client's direct child. Its detached descendants need their own proof.
export async function closeOwnedClient(engine, { collect = collectOwnedGroup, absence = verifyGroupAbsent } = {}) {
  const cleanup = { clientPid: Number.isSafeInteger(engine?.pid) ? engine.pid : null, clientClosed: false, groupCollected: false };
  try { cleanup.clientClosed = await bounded(() => engine.close(), 12000) === true; }
  catch (error) { cleanup.clientCleanupFailure = failure(error); }
  if (!Number.isSafeInteger(cleanup.clientPid) || cleanup.clientPid <= 1 || cleanup.clientPid === process.pid)
    cleanup.groupCleanupFailure = { message: 'owned child PID unknown or invalid; group collection unproved', code: null };
  else try {
    await bounded(() => collect(cleanup.clientPid), 12000);
    cleanup.groupCollected = true;
  } catch (error) {
    cleanup.groupCleanupFailure = failure(error);
    // Darwin can report EPERM briefly after exit. A bounded, read-only ESRCH witness may resolve it.
    // Persistent EPERM and zombie hypotheses remain failures; this path never sends TERM or KILL.
    if (cleanup.clientClosed && (error.code === 'EPERM' || /\bEPERM\b/.test(String(error.message)))) try {
      cleanup.groupAbsenceProof = await bounded(() => absence(cleanup.clientPid), 2000);
      cleanup.groupCollected = cleanup.groupAbsenceProof?.gone === true;
    } catch (absentError) { cleanup.groupAbsenceFailure = failure(absentError); }
  }
  return cleanup;
}

/** Owns one client and bank. Failure keeps a diagnostic receipt; uncertain client cleanup keeps the bank too. */
export async function runProbe({ engine, root, approval = false, delivery = 'during', timeoutMs = 10000,
  pollMs = 5, signal, fault, onCreated = () => {}, collect = collectOwnedGroup } = {}) {
  const receipt = { version: 1, status: 'fail', approval, delivery, startedAt: Date.now(), sent: [], received: [],
    boundaries: [], clientPid: Number.isSafeInteger(engine?.pid) ? engine.pid : null,
    cleanup: { ok: false }, retainLiveLock: false, retainedDiagnostic: false };
  let channel, interval, result, readerCleanup, channelError;
  try {
    channel = createChannel({ root, epoch: randomUUID(), call: randomUUID() });
    receipt.manifest = channel.manifest; onCreated(channel.manifest);
    if (channel.creationError) throw Error(channel.creationError.message);
    const poll = () => { receipt.receiverStartedAt ??= Date.now(); try { channel.poll(); } catch (error) { channelError ??= error; } };
    if (delivery === 'during') interval = setInterval(poll, pollMs);
    const until = Date.now() + timeoutMs;
    result = parsed(await bounded(() => engine.call('js', { code: buildProbeCode(channel.manifest, { approval, delivery, fault }),
      timeout_ms: timeoutMs }, timeoutMs), timeoutMs, signal), 'hand-channel-result:');
    receipt.resultAt = Date.now();
    receipt.sent = result.sent; receipt.boundaries = result.boundaries; receipt.bindings = result.bindings;
    if (result.failure) throw Object.assign(Error(result.failure.message), { code: result.failure.code });
    if (result.epoch !== channel.manifest.epoch || result.call !== channel.manifest.call) throw Error('result identity mismatch');
    const expected = ATTEMPTS.flatMap(([action, attempt]) => ['invoke', ...(approval ? ['approval'] : []),
      action === 1 && attempt === 1 ? 'rejected' : 'fulfilled'].map(stage => KEY({ ...channel.manifest, action, attempt, stage })));
    if (result.sent.length !== expected.length || new Set(result.sent.map(KEY)).size !== expected.length ||
        expected.some(key => !result.sent.some(event => KEY(event) === key)) || JSON.stringify(result.bindings) !== '[0,1,2]')
      throw Error('missing or wrong sender event identity');
    if (delivery === 'after-result') await bounded(() => new Promise(resolve => setTimeout(resolve, pollMs)), timeoutMs, signal);
    while (channel.events.length < expected.length) {
      signal?.throwIfAborted(); poll();
      if (channelError) throw channelError;
      if (Date.now() >= until) throw Error('missing event timeout');
      if (channel.events.length < expected.length) await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    poll(); if (channelError) throw channelError;
    if (channel.events.length !== expected.length || channel.events.some(event => !expected.includes(KEY(event)))) throw Error('wrong receiver event identity');
    const first = channel.events.find(event => event.action === 0 && event.stage === 'fulfilled');
    if (delivery === 'during' && first.receivedAt >= receipt.resultAt) throw Error('first return arrived after result in paced case');
    receipt.status = 'pass';
  } catch (error) { receipt.failure = failure(error); receipt.retainedDiagnostic = true; }
  finally {
    clearInterval(interval);
    receipt.received = channel?.events ?? [];
    // A timed-out call can still be running. Both direct-child close and exact owned-group collection must finish.
    if (result) try {
      readerCleanup = parsed(await bounded(() => engine.call('js', { code: cleanupCode(channel.manifest), timeout_ms: 1000 }, 1000), 1500), 'hand-channel-cleanup:');
      if (!readerCleanup.ok || readerCleanup.closed !== result.openReaders) throw Error('reader cleanup count or identity mismatch');
    } catch (error) { receipt.readerCleanupFailure = failure(error); }
    Object.assign(receipt, await closeOwnedClient(engine, { collect }));
    receipt.readerCleanup = readerCleanup;
    receipt.cleanup = receipt.clientClosed && receipt.groupCollected && channel ? channel.cleanup()
      : { ok: false, errors: [{ message: 'child or owned-group cleanup unproved' }] };
    if (!receipt.cleanup.ok || receipt.readerCleanupFailure || !receipt.clientClosed || !receipt.groupCollected) {
      receipt.status = 'fail'; receipt.retainedDiagnostic = true; receipt.retainLiveLock = true;
      receipt.failure ??= { message: 'resource cleanup unproved', code: null };
    }
    receipt.finishedAt = Date.now();
  }
  return receipt;
}
