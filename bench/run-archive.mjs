import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isHeld, keepTemp } from '../scripts/temp-leftovers.mjs';
import { canonicalHolders, readHeldPaths } from '../scripts/temp-sweep.mjs';

const IMAGE_AGE_MS = 7 * 24 * 3600 * 1000;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/;
const stampTime = name => Date.parse(name.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));

// Protect even partial timestamp references in reports and claim exclusions. No symlink traversal.
export function pruneRunImages({ roots, docsDir, exclusionsFile, now = Date.now(), held,
  inventory = readHeldPaths, dryRun = false, log = console.log } = {}) {
  const result = { planned: [], removed: [], freedBytes: 0 };
  if (keepTemp()) { log('image retention kept: SLEIGHT_KEEP_TEMP=1'); return result; }
  try {
    held = canonicalHolders(held ?? inventory());
    let references = readFileSync(exclusionsFile, 'utf8');
    const rules = JSON.parse(references);
    const repo = dirname(dirname(exclusionsFile));
    const readReferences = path => {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error('symlinked reference path');
      if (info.isDirectory()) for (const entry of readdirSync(path)) readReferences(join(path, entry));
      else if (info.isFile()) references += '\n' + readFileSync(path, 'utf8');
    };
    readReferences(docsDir);
    for (const path of ['docs/benchmark.md', 'docs/design', 'docs/status', 'README.md', 'CHANGELOG.md']) {
      const file = join(repo, path);
      if (existsSync(file)) readReferences(file);
    }
    const resultsDir = join(repo, 'bench/results'), claimRuns = new Set();
    if (existsSync(resultsDir)) for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
      const stamp = entry.name.replace(/\.json$/, '');
      if (entry.isFile() && entry.name.endsWith('.json') && STAMP.test(stamp) &&
          (typeof rules.since !== 'string' || stamp >= rules.since)) claimRuns.add(stamp);
    }
    const cited = references.match(/\d{4}-\d\d-\d\dT\d\d(?:-\d\d(?:-\d\d(?:-\d{3}Z)?)?)?/g) ?? [];
    const walk = (path, runTime) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) {
          // Chess archives can contain timestamped runs inside their unique bank.
          if (STAMP.test(entry.name)) visit(file, entry.name);
          else walk(file, runTime);
        } else if (entry.isFile() && runTime != null && now - runTime > IMAGE_AGE_MS && /\.(png|jpe?g)$/i.test(entry.name)) {
          result.planned.push(file); log(`${dryRun ? 'would delete' : 'delete'} ${file}`);
          if (dryRun) continue;
          const info = lstatSync(file);
          if (!info.isFile() || isHeld(file, held)) continue;
          unlinkSync(file); result.removed.push(file); result.freedBytes += info.size;
        }
      }
    };
    const visit = (path, name) => {
      if (cited.some(prefix => name.startsWith(prefix)) || isHeld(path, held)) return;
      if (claimRuns.has(name) && now - stampTime(name) <= 30 * 24 * 3600 * 1000) return;
      const time = stampTime(name);
      if (Number.isFinite(time) && now - time > IMAGE_AGE_MS) walk(path, time);
    };
    for (const root of canonicalHolders(roots)) {
      if (!existsSync(root) || !lstatSync(root).isDirectory()) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(root, entry.name);
        if (STAMP.test(entry.name)) visit(path, entry.name);
        else if (/^chess-drag-/.test(entry.name)) walk(path, null);
      }
    }
  } catch (error) { result.warning = `retention reference/inventory scan failed: ${error.message}`; log(result.warning); }
  log(`image retention removed ${result.removed.length} files (${result.freedBytes} bytes)`);
  return result;
}

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
