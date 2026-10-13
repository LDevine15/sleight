import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, realpathSync,
  mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize, parse, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const keys = ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn', 'leaseGeneration',
  'target', 'frame', 'document', 'origin', 'operation', 'ref'];
function bindingKey(binding) {
  if (!binding || keys.some(k => !['string', 'number'].includes(typeof binding[k])))
    throw new Error('Incomplete file authority binding');
  const url = new URL(binding.origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== binding.origin)
    throw new Error('Unsupported file destination');
  return JSON.stringify(keys.map(k => binding[k]));
}
function snapshot(path, includeData = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0'))
    throw new Error('File path must be absolute and normalized');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not file capabilities');
  }
  if (realpathSync(path) !== path) throw new Error('File path changed');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 64n * 1024n * 1024n) throw new Error('Unsupported file');
    const data = readFileSync(fd);
    const digest = createHash('sha256').update(data).digest('hex');
    const after = fstatSync(fd, { bigint: true });
    const stat = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':');
    if (stat(before) !== stat(after)) throw new Error('File changed while checking');
    return { path, signature: `${stat(after)}:${digest}`, ...(includeData ? { data } : {}) };
  } finally { closeSync(fd); }
}

// Trusted broker/UI adapter only. Page and model JSON cannot mint these opaque handles.
// CDP can read paths lazily after dispatch. Scoped adapters should transfer the
// checked byte payloads into browser-owned Files before staging cleanup, rather
// than retaining a File backed by a soon-deleted path. Same-user hostile
// software remains outside this local-process trust boundary.
export function createFileAuthority({ approve, now = Date.now, ttlMs = 30_000 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 30_000 || typeof now !== 'function')
    throw new Error('Invalid file authority freshness');
  const clock = () => {
    let time;
    try { time = now(); } catch { throw new Error('Unreadable file authority freshness'); }
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - ttlMs)
      throw new Error('Invalid file authority freshness');
    return time;
  };
  const fresh = cap => {
    const time = clock();
    if (!Number.isFinite(cap.expires) || time < cap.issued || time >= cap.expires)
      throw new Error('Invalid file capability freshness');
  };
  const capabilities = new WeakMap();
  return Object.freeze({
    async issue(paths, binding) {
      clock();
      const key = bindingKey(binding);
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 16 || new Set(paths).size !== paths.length)
        throw new Error('Expected exact file list');
      const files = paths.map(snapshot);
      if (typeof approve !== 'function' || await approve({ binding: structuredClone(binding), paths: [...paths] }) !== true)
        throw new Error('Exact user file approval required');
      // Approval may take time. Check again before publishing the capability.
      if (paths.some((p, i) => snapshot(p).signature !== files[i].signature)) throw new Error('Approved file changed');
      const token = Object.freeze({});
      const issued = clock();
      capabilities.set(token, { key, files, issued, expires: issued + ttlMs });
      return token;
    },
    consume(token, binding) {
      const cap = token && capabilities.get(token);
      if (!cap || cap.key !== bindingKey(binding)) throw new Error('Invalid file capability');
      capabilities.delete(token); // Fail closed, even if the file check fails.
      fresh(cap);
      if (cap.files.some(f => snapshot(f.path).signature !== f.signature)) throw new Error('Approved file changed');
      fresh(cap);
      return cap.files.map(f => f.path);
    },
    stage(token, binding) {
      const cap = token && capabilities.get(token);
      if (!cap || cap.key !== bindingKey(binding)) throw new Error('Invalid file capability');
      capabilities.delete(token);
      fresh(cap);
      const files = cap.files.map(f => {
        const read = snapshot(f.path, true);
        if (read.signature !== f.signature) throw new Error('Approved file changed');
        return read;
      });
      fresh(cap);
      const directory = mkdtempSync(join(realpathSync(tmpdir()), 'bp2-7-upload-'));
      const cleanup = () => rmSync(directory, { recursive: true, force: true });
      try {
        const paths = files.map((file, index) => {
          const parent = join(directory, String(index)); mkdirSync(parent, { mode: 0o700 });
          const path = join(parent, basename(file.path));
          writeFileSync(path, file.data, { flag: 'wx', mode: 0o600 });
          return path;
        });
        const staged = paths.map(p => snapshot(p));
        fresh(cap);
        // Private adapter data, never a model-visible capability or receipt.
        // Empty MIME lets the qualified upload adapter infer it from the name.
        const payloads = files.map(file => Object.freeze({ name: basename(file.path), mimeType: '', buffer: file.data }));
        return { paths, payloads, snapshot: staged, cleanup };
      } catch (error) { cleanup(); throw error; }
    },
    checkPaths(paths) { return paths.map(snapshot); },
    unchanged(before) { return before.every(f => snapshot(f.path).signature === f.signature); },
  });
}
