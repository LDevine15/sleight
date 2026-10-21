// Run-owned control files, independent of MCP/stdout. An ACK proves a closed admission gate and checked drain, never exit alone.
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { checkRunSignal } from './electron-run-cancellation.mjs';

export function createArmCancellation({ stateDir, session, cancelNonce }) {
  if (!isAbsolute(stateDir) || normalize(stateDir) !== stateDir || realpathSync(stateDir) !== stateDir ||
      typeof session !== 'string' || !session || !/^[a-f0-9]{64}$/.test(cancelNonce ?? '')) throw Error('ARM_CANCEL_CONFIG_INVALID');
  const safe = s => s.uid === process.getuid() && !(s.mode & 0o077);
  const directory = lstatSync(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || !safe(directory)) throw Error('ARM_CANCEL_STATE_UNSAFE');
  const sameDirectory = () => {
    let now;
    try { now = lstatSync(stateDir); } catch { throw Error('ARM_CANCEL_STATE_CHANGED'); }
    if (!now.isDirectory() || now.isSymbolicLink() || !safe(now) || now.dev !== directory.dev || now.ino !== directory.ino || realpathSync(stateDir) !== stateDir)
      throw Error('ARM_CANCEL_STATE_CHANGED');
  };
  const binding = { version: 1, session, nonce: cancelNonce };
  const markerPath = join(stateDir, `cancel-${cancelNonce}.json`), ackPath = join(stateDir, `drained-${cancelNonce}.json`);
  const read = (path, ack = false) => {
    let fd;
    try {
      sameDirectory();
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || !safe(stat) || stat.size > 2048) throw Error('ARM_CANCEL_FILE_UNSAFE');
      const row = JSON.parse(readFileSync(fd, 'utf8'));
      sameDirectory();
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(Object.keys(ack ? { ...binding, status: 'drained' } : binding).sort()) ||
          row.version !== 1 || row.session !== session || row.nonce !== cancelNonce || ack && row.status !== 'drained') throw Error('ARM_CANCEL_BINDING_CHANGED');
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  const publish = (path, row, ack) => {
    let fd, staged;
    const temporary = `${path}.writing-${process.pid}`;
    try {
      sameDirectory();
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); staged = true;
      writeFileSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd);
      sameDirectory(); linkSync(temporary, path); // atomic, with no replacement of an existing control file
    } catch (error) { if (error.code !== 'EEXIST' || !read(path, ack)) throw error; }
    finally { if (fd !== undefined) closeSync(fd); if (staged) { sameDirectory(); unlinkSync(temporary); } }
    sameDirectory();
    const dir = openSync(stateDir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  };
  const drained = () => { try { return read(ackPath, true); } catch { return false; } };
  return {
    markerPath, ackPath,
    requested: () => read(markerPath),
    request: () => publish(markerPath, binding, false),
    acknowledge: () => publish(ackPath, { ...binding, status: 'drained' }, true),
    drained,
    async waitForDrain({ lifecycle, timeoutMs = 5000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
      const deadline = now() + timeoutMs;
      while (lifecycle.cleanupAllowed !== false) {
        if (drained()) return true;
        if (now() >= deadline) break;
        await sleep(Math.min(50, Math.max(1, deadline - now())));
      }
      lifecycle.cleanupAllowed = false; lifecycle.unsettled = true; lifecycle.effectUnknown = true;
      return false;
    },
  };
}

export function createArmDrain({ protocol, control, uncertain = () => false }) {
  let stopping;
  return { stop() {
    // close() sets the protocol's admission flag synchronously, before its first await.
    return stopping ??= protocol.close().then(result => {
      if (uncertain() || result !== undefined && (result.revoked !== true || !Array.isArray(result.cleanup) || result.cleanup.length)) return false;
      control.acknowledge(); return true;
    }).catch(() => false);
  } };
}

export async function runArmWithCancellation(work, { control, signal, lifecycle, waitMs = 45_000 }) {
  checkRunSignal(signal);
  const model = new AbortController();
  const request = () => {
    try { control.request(); }
    catch { lifecycle.cleanupAllowed = false; lifecycle.unsettled = true; lifecycle.effectUnknown = true; }
  };
  let cancellationDrain;
  const cancel = () => {
    request();
    cancellationDrain ??= control.waitForDrain({ lifecycle, timeoutMs: waitMs }).finally(() => model.abort());
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let result;
  try {
    try {
      result = await work(model.signal);
      lifecycle.modelGroup = { confirmed: result?.groupClean === true,
        signalErrors: (result?.signalErrors ?? []).map(row => ({ code: /^[A-Z0-9_]{1,40}$/.test(row.code ?? '') ? row.code : 'UNKNOWN' })) };
    }
    finally {
      request();
      if (!await (cancellationDrain ?? control.waitForDrain({ lifecycle, timeoutMs: Math.min(waitMs, 5000) }))) throw Error('ARM_DRAIN_UNCONFIRMED');
    }
    if (result?.groupClean !== true) {
      lifecycle.cleanupAllowed = false; lifecycle.unsettled = true; lifecycle.modelGroupUnconfirmed = true;
      throw Error('ARM_GROUP_UNCONFIRMED');
    }
    checkRunSignal(signal);
    return result;
  } finally { signal?.removeEventListener('abort', cancel); }
}
