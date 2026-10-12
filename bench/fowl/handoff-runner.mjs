import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupNative } from './grade.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ARMS = ['fowlbrowser', 'sleight', 'fowl+sleight'];
const IDS = 'chrome=7a356c11-c3ba-4fd3-88ff-2f891496ba7e,helium=2f6fb307-288b-46d7-9fc2-5262c30ea852';
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";

export function snapshotDownloads(dir) {
  const files = new Map();
  let names;
  try { names = readdirSync(dir); } catch (err) { if (err.code === 'ENOENT') return files; throw err; }
  for (const name of names) {
    try { files.set(name, lstatSync(join(dir, name))); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return files;
}

export function cleanupDownloads({ dir, before, name, started, ended }) {
  if (!/^invoice-[a-zA-Z0-9-]+\.pdf$/.test(name)) throw new Error('invalid owned download name');
  const after = snapshotDownloads(dir);
  const stem = name.slice(0, -4);
  const ownedName = new RegExp('^' + stem + '(?: \\(\\d+\\))?\\.pdf$');
  for (const [candidate, stat] of after) {
    if (!ownedName.test(candidate) || before.has(candidate) || !stat.isFile()) continue;
    if (stat.mtimeMs < started || stat.mtimeMs > ended || stat.birthtimeMs < started || stat.birthtimeMs > ended) continue;
    const file = join(dir, candidate);
    try {
      const current = lstatSync(file);
      if (current.isFile() && current.ino === stat.ino && current.dev === stat.dev
        && current.mtimeMs === stat.mtimeMs && current.size === stat.size) unlinkSync(file);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

function runRound({ out, args }) {
  return new Promise((resolve, reject) => {
    const fd = openSync(out + '.log', 'wx');
    const child = spawn(join(DIR, 'rounds.sh'), args, { stdio: ['ignore', fd, fd] });
    const interrupt = () => child.kill('SIGINT');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closeSync(fd);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      resolve(signal ? 130 : code);
    });
  });
}

export async function runHandoffs({
  outRoot = '/tmp/fb-rounds', downloads = join(homedir(), 'Downloads'),
  stamp = new Date().toISOString().replace(/[:.]/g, '-'), run = runRound,
} = {}) {
  const tasks = JSON.parse(readFileSync(join(DIR, 'handoff.json'), 'utf8'));
  const results = [];
  mkdirSync(outRoot, { recursive: true });
  for (const arm of ARMS) {
    const out = join(outRoot, 'handoff-' + stamp + '-' + arm);
    mkdirSync(out);
    const downloadName = 'invoice-' + randomUUID() + '.pdf';
    const before = snapshotDownloads(downloads);
    const started = Date.now() - 1;
    const serve = 'node ' + quote(join(DIR, 'site/server.mjs')) + ' --download-name ' + downloadName;
    const args = ['--surface', arm, '--tasks', join(DIR, 'handoff.json'), '--serve', serve,
      '--codex-browsers', IDS, '--out', out];
    let code;
    let error;
    try { code = await run({ arm, out, downloadName, args }); }
    catch (err) { code = 1; error = err.message; }
    finally {
      try { for (const task of tasks) cleanupNative(join(out, task.name)); }
      finally { cleanupDownloads({ dir: downloads, before, name: downloadName, started, ended: Date.now() + 1 }); }
    }
    results.push({ arm, out, code, ...(error ? { error } : {}) });
    if (code === 130) break;
  }
  return results;
}

if (import.meta.main) {
  const results = await runHandoffs();
  for (const result of results) console.log(JSON.stringify(result));
  process.exitCode = results.some((r) => r.code !== 0) ? 1 : 0;
}
