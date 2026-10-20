// Only the two qualification entrypoints supply this path. It never comes from a tool argument or page.
import { chmodSync, closeSync, constants, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { scrubReceipt } from './electron-qualification.mjs';

export async function withQualificationDiagnostics(out, work, { mkdtemp = mkdtempSync, write = writeFileSync } = {}) {
  mkdirSync(out, { recursive: true });
  out = realpathSync(out);
  const summaryFd = openSync(join(out, 'summary.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let dir, source;
  try {
    dir = mkdtemp(join(out, '.electron-diag-'));
    source = join(dir, 'upstream.jsonl');
    write(source, '', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    closeSync(summaryFd);
    try { rmSync(join(out, 'summary.json')); } catch {}
    try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {}
    throw error;
  }
  let result;
  try { result = await work(source); return result; }
  finally {
    const destination = join(out, basename(dir).slice(1) + '.jsonl');
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      let first, invalid = false;
      for (const line of readFileSync(destination, 'utf8').split('\n').filter(Boolean)) {
        try {
          const row = JSON.parse(line);
          if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.method !== 'string' ||
              typeof row.message !== 'string' || !(row.code === null || Number.isSafeInteger(row.code) || row.code === 'CDP_HOST_QUEUE_FULL') ||
              row.expected !== undefined && (row.expected !== true || row.method !== 'park')) throw Error('invalid diagnostic record');
          if (row.method !== 'sink-open' && !(row.method === 'park' && row.expected === true) && !first) first = row;
        }
        catch { invalid = true; }
      }
      // Raw upstream text is private receipt evidence. Never pass it to the logger or a model-facing receipt.
      const summary = { ...scrubReceipt(result?.summary ?? { kind: 'electron-qualification', code: result ?? 1 }),
        diagnostics: destination, firstCDPFailure: first ? { method: first.method, code: first.code, message: first.message } : null,
        ...(invalid ? { diagnosticsError: 'INVALID_DIAGNOSTIC_RECORD' } : {}) };
      writeFileSync(summaryFd, JSON.stringify(summary, null, 2) + '\n');
      if (result !== undefined && (typeof result === 'number' ? result === 0 : !result.keep)) rmSync(dir, { recursive: true });
    } finally { closeSync(summaryFd); }
  }
}
