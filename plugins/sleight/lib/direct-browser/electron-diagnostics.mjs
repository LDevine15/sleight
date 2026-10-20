// Qualification-only sink, passed explicitly at host startup. No environment path, channel or page can select it.
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

export function qualificationDiagnostic(path) {
  const safe = s => s.isFile() && s.uid === process.getuid?.() && (s.mode & 0o777) === 0o600 && s.nlink === 1;
  let original;
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) return;
    original = lstatSync(path);
    if (!safe(original)) return;
  } catch { return; }
  const record = row => {
    let fd;
    try {
      if (realpathSync(path) !== path) return;
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const current = fstatSync(fd);
      if (!safe(current) || current.dev !== original.dev || current.ino !== original.ino) return;
      const bounded = value => typeof value === 'string' ? value.slice(0, 64) : 'unknown';
      writeSync(fd, JSON.stringify({ at: Date.now(), hostPid: process.pid, method: bounded(row.method), code: Number.isSafeInteger(row.code) || row.code === 'CDP_HOST_QUEUE_FULL' ? row.code : null,
        message: String(row.message ?? '').slice(0, 300), sessionKind: bounded(row.sessionKind),
        targetType: bounded(row.targetType), frameType: bounded(row.frameType),
        ...(row.method === 'park' && row.expected === true ? { expected: true } : {}) }) + '\n');
    } catch { /* Diagnostics never alter a command or report raw text anywhere else. */ }
    finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  };
  record({ method: 'sink-open', message: 'qualification diagnostics installed', sessionKind: 'host' });
  return record;
}
