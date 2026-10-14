import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureGradeDescriptor } from '../world/fowl-fixture-grade.mjs';
import { cleanupNative } from './grade.mjs';
import { INVOICE_ID, INVOICE_TOTAL, NOTE, ROSTER } from './data.mjs';
import { modelId } from './accounting.mjs';
import { matrixOptions, roundArguments } from '../world/fowl-options.mjs';

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

const UNTITLED_CONTENT = new Set([
  `${INVOICE_ID} ${INVOICE_TOTAL}`,
  `${NOTE.title}\n${NOTE.body}`,
  ...['\t', ' '].flatMap((sep) => [
    ROSTER.map((r) => [r.name, r.role, r.hours].join(sep)).join('\n'),
    ROSTER.map((r) => [r.name, r.hours].join(sep)).join('\n'),
  ]),
]);

export function findUntitled({ dir, before, started, ended }) {
  const found = [];
  for (const [name, stat] of snapshotDownloads(dir)) {
    if (!/^Untitled(?: \d+)?(?:\.txt)?$/.test(name) || before.has(name) || !stat.isFile() || stat.size > 65536) continue;
    if (stat.birthtimeMs < started || stat.birthtimeMs > ended || stat.mtimeMs < started || stat.mtimeMs > ended) continue;
    const file = join(dir, name);
    const body = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replace(/\n$/, '');
    if (UNTITLED_CONTENT.has(body)) found.push(file);
  }
  return found.sort();
}

export function runRound({ out, args, fixture }) {
  return new Promise((resolve, reject) => {
    const fd = openSync(out + '.log', 'wx');
    let child, gradeFd;
    try {
      gradeFd = fixture ? fixtureGradeDescriptor(fixture) : undefined;
      child = spawn(join(DIR, 'rounds.sh'), args, { stdio: ['ignore', fd, fd, ...(gradeFd === undefined ? [] : [gradeFd])] });
    } catch (error) { closeSync(fd); throw error; }
    finally { if (gradeFd !== undefined) closeSync(gradeFd); }
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

// The apps the hand-off tasks drive. A round that leaves one running that wasn't running before quits it (LAWS: a run
// quits every app it launched). A TextEdit left by one round wedged the engine's reads for every later round (2026-10-12).
const TASK_APPS = ['TextEdit', 'Preview'];
function appsRunning() {
  return new Set(TASK_APPS.filter((name) => spawnSync('/usr/bin/pgrep', ['-x', name]).status === 0));
}
function quitApp(name) {
  spawnSync('/usr/bin/osascript', ['-e', `tell application "${name}" to quit saving no`], { timeout: 10000 });
  for (let i = 0; i < 10 && spawnSync('/usr/bin/pgrep', ['-x', name]).status === 0; i++) spawnSync('/bin/sleep', ['0.5']);
  if (spawnSync('/usr/bin/pgrep', ['-x', name]).status === 0) spawnSync('/usr/bin/pkill', ['-TERM', '-x', name]);
}

export async function runHandoffs({
  outRoot = '/tmp/fb-rounds', downloads = join(homedir(), 'Downloads'),
  icloud = join(homedir(), 'Library/Mobile Documents/com~apple~TextEdit/Documents'), cleanup = cleanupNative,
  stamp = new Date().toISOString().replace(/[:.]/g, '-'), run = runRound, running = appsRunning, quit = quitApp,
  model = 'opus', effort = 'medium', world = false, runs = 1, dryRun = false, swap = false,
} = {}) {
  const options = matrixOptions({ model, effort, runs, dryRun, swap, world });
  const tasks = JSON.parse(readFileSync(join(DIR, 'handoff.json'), 'utf8'));
  const results = [];
  if (dryRun) return Array.from({ length: options.runs }, (_, index) => ARMS.flatMap(arm => tasks.map(task => {
    const out = join(outRoot, `handoff-${stamp}-${index + 1}-${arm}`, 'r-' + task.name);
    return { arm, run: index + 1, out, dryRun: true,
      args: roundArguments(options, ['--surface', arm, '--tasks', join(DIR, 'handoff.json'), '--only', task.name,
        '--serve', 'node ' + quote(join(DIR, 'site/server.mjs')) + ' --download-name invoice-PLAN.pdf', '--codex-browsers', IDS, '--out', out]) };
  }))).flat();
  mkdirSync(outRoot, { recursive: true });
  for (let repetition = 1; repetition <= options.runs; repetition++) for (const arm of ARMS) {
    const out = join(outRoot, 'handoff-' + stamp + (options.runs === 1 ? '' : '-' + repetition) + '-' + arm);
    mkdirSync(out);
    const downloadName = 'invoice-' + randomUUID() + '.pdf';
    const before = snapshotDownloads(downloads);
    const cleanupErrors = [];
    let untitledBefore;
    try { untitledBefore = snapshotDownloads(icloud); }
    // Advisory: an unreadable iCloud folder is reported, never counted as a failed arm.
    catch (err) { console.error(`Untitled snapshot skipped: ${err.message}`); }
    const started = Date.now() - 1;
    const serve = 'node ' + quote(join(DIR, 'site/server.mjs')) + ' --download-name ' + downloadName;
    // One task at a time: native steps share one Mac, and sleight's input lease lets one session type into an
    // app at a time, so two TextEdit tasks started together waited on each other (2026-10-12).
    let code = 0;
    let error;
    let untitled = [];
    try {
      for (const task of tasks) {
        const args = roundArguments(options, ['--surface', arm, '--tasks', join(DIR, 'handoff.json'), '--only', task.name, '--serve', serve,
          '--codex-browsers', IDS, '--out', join(out, 'r-' + task.name)]);
        const was = running();
        let one;
        try { one = await run({ arm, out: join(out, 'r-' + task.name), downloadName, args }); }
        finally { for (const name of running()) if (!was.has(name)) quit(name); }
        if (one !== 0) code = one;
        if (one === 130) break;
      }
    }
    catch (err) { code = 1; error = err.message; }
    finally {
      const ended = Date.now() + 1;
      for (const task of tasks) {
        const dir = join(out, 'r-' + task.name, task.name);
        try { cleanup(dir); } catch (err) { cleanupErrors.push(`${dir}: ${err.message}`); }
      }
      try { cleanupDownloads({ dir: downloads, before, name: downloadName, started, ended }); }
      catch (err) { cleanupErrors.push(`Downloads cleanup: ${err.message}`); }
      if (untitledBefore) {
        try { untitled = findUntitled({ dir: icloud, before: untitledBefore, started, ended }); }
        catch (err) { console.error(`Untitled scan skipped: ${err.message}`); }
      }
    }
    results.push({ arm, out, code: cleanupErrors.length && code === 0 ? 1 : code, untitled,
      ...(error ? { error } : {}), ...(cleanupErrors.length ? { cleanupErrors } : {}) });
    if (code === 130) return results;
  }
  return results;
}

export function handoffOptions(args) {
  const result = { world: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--world', '--dry-run', '--swap'].includes(flag)) result[flag === '--dry-run' ? 'dryRun' : flag.slice(2)] = true;
    else if (['--out', '--model', '--effort', '--runs'].includes(flag)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
      result[flag === '--out' ? 'outRoot' : flag.slice(2)] = args[++i];
    } else throw new Error(`Unknown handoff option ${flag}`);
  }
  return { ...result, ...matrixOptions({ model: modelId(result.model ?? 'opus'), effort: result.effort ?? 'medium', runs: result.runs ?? 1,
    world: result.world, dryRun: result.dryRun, swap: result.swap }) };
}

if (import.meta.main) {
  const results = await runHandoffs(handoffOptions(process.argv.slice(2)));
  for (const result of results) console.log(JSON.stringify(result));
  process.exitCode = results.some((r) => r.code !== undefined && r.code !== 0) ? 1 : 0;
}
