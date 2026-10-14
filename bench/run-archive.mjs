import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// TextEdit's Save sheet lists the folder it opens in, and every run saves inside the benchmark's
// temp folder: with 135 old runs there, one read of the sheet was 57,000 characters, over Claude
// Code's tool output limit (2026-10-10). Older runs move to an archive, traces kept for studies.
export function archiveOldRuns(benchDir, archiveDir, { maxAgeMs = 6 * 3600 * 1000, now = Date.now() } = {}) {
  if (!existsSync(benchDir)) return [];
  const moved = [];
  for (const name of readdirSync(benchDir)) {
    if (!/^\d{4}-\d\d-\d\dT[\d-]+Z$/.test(name)) continue;
    const from = join(benchDir, name);
    let info;
    try { info = statSync(from); } catch { continue; }
    if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
    mkdirSync(archiveDir, { recursive: true });
    try { renameSync(from, join(archiveDir, name)); moved.push(name); } catch {}
  }
  return moved;
}

// Chess remembers the last Save directory across launches. Remove earlier task directories
// from that location so a new arm cannot save into a previous arm's folder by basename alone.
// Keep their traces and saved games in a unique archive bank, never replacing old evidence.
export function archiveChessRuns(currentDir, {
  benchDir = join(tmpdir(), 'sleight-bench'),
  archiveDir = join(homedir(), 'Library', 'Caches', 'sleight-bench', 'runs-archive'),
} = {}) {
  const stampPattern = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
  const taskPattern = /^(?:[a-z][a-z0-9-]*|(?:mcp|plugin):[a-z0-9][a-z0-9_-]*)-chess-drag-[1-9]\d*$/;
  const root = realpathSync(benchDir), current = realpathSync(currentDir);
  if (dirname(dirname(current)) !== root || !stampPattern.test(basename(dirname(current))) || !taskPattern.test(basename(current))) {
    throw new Error('Current Chess target is not a benchmark run folder');
  }
  const moved = [];
  let bank;
  for (const pass of readdirSync(root, { withFileTypes: true })) {
    if (!pass.isDirectory() || !stampPattern.test(pass.name)) continue;
    for (const task of readdirSync(join(root, pass.name), { withFileTypes: true })) {
      if (!task.isDirectory() || !taskPattern.test(task.name)) continue;
      const from = join(root, pass.name, task.name);
      if (from === current) continue;
      if (!bank) {
        mkdirSync(archiveDir, { recursive: true });
        bank = mkdtempSync(join(archiveDir, 'chess-drag-'));
      }
      const destination = join(bank, pass.name);
      mkdirSync(destination, { recursive: true });
      const to = join(destination, task.name);
      renameSync(from, to); // A failure stops setup before Chess starts; never discard evidence.
      moved.push({ from, to });
    }
  }
  return moved;
}
