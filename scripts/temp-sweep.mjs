import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRoots, isHeld, listLeftovers, keepTemp, MAX_AGE_MS } from './temp-leftovers.mjs';

const RETAIN = new Set(['sleight-live.lock', 'sleight-real-evidence']);
const inClaim = path => /(?:^|\/)ledger\/claims(?:\/|$)/.test(path);
const retained = item => RETAIN.has(item.name) || /^sleight-.*-evidence/.test(item.name) || inClaim(item.path);

export function canonicalHolders(held) {
  return new Set([...held].map(path => { try { return realpathSync(path); } catch { return path; } }));
}

// An incomplete inventory must never turn a live folder into a deletion candidate.
export function readHeldPaths(run = spawnSync) {
  const result = run('/usr/sbin/lsof', ['-nP', '-F', 'n'], { encoding: 'utf8', timeout: 15000, maxBuffer: 80_000_000 });
  if (result.error || result.status !== 0 || result.stderr?.trim()) throw new Error('lsof unavailable or incomplete');
  return canonicalHolders(new Set(result.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))));
}

export function sweepTemp({ roots = defaultRoots(), now = Date.now(), held, inventory = readHeldPaths,
  dryRun = false, log = console.log } = {}) {
  const result = { freedBytes: 0, planned: [], removed: [] };
  if (keepTemp()) { log('temp sweep kept: SLEIGHT_KEEP_TEMP=1'); return result; }
  try {
    roots = [...canonicalHolders(roots)].filter(root => !inClaim(root));
    const refresh = held === undefined;
    held = canonicalHolders(held ?? inventory());
    const candidates = listLeftovers({ roots, now, held }).filter(item => !retained(item))
      .map(item => ({ ...item, info: lstatSync(item.path) }));
    const currentHeld = refresh && !dryRun ? canonicalHolders(inventory()) : held;
    for (const item of candidates) {
      result.planned.push(item.path);
      log(`${dryRun ? 'would delete' : 'delete'} ${item.path} (${item.size} bytes)`);
      if (dryRun) continue;
      try {
        // Recheck age, name, git ownership and holders immediately before removal.
        const info = lstatSync(item.path);
        if (retained(item) || !info.isDirectory() || info.dev !== item.info.dev || info.ino !== item.info.ino ||
          now - info.mtimeMs < MAX_AGE_MS || existsSync(join(item.path, '.git')) || isHeld(item.path, currentHeld)) continue;
        rmSync(item.path, { recursive: true, force: false });
        result.removed.push(item.path); result.freedBytes += item.size;
      } catch (error) { log(`temp sweep kept ${item.path}: ${error.message}`); }
    }
  } catch (error) { result.warning = error.message; log(`temp sweep skipped: ${error.message}`); }
  log(`temp sweep freed ${result.freedBytes} bytes`);
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--dry-run')) console.error('usage: temp-sweep.mjs [--dry-run]');
  else sweepTemp({ dryRun: process.argv.includes('--dry-run') });
}
