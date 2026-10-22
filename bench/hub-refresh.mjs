#!/usr/bin/env node
// Refreshes the benchmark hub (bench/results-hub.mjs: collect, then render) once after a runner has saved a completed pass.
// bench/run.mjs, bench/fowl/rounds.sh, bench/validation/validation-140.mjs and bench/validation/remeasure.mjs call it at the end.
//   node bench/hub-refresh.mjs [--exit <code>] [--saved <folder>] [--dry-run] [--no-hub] [--wt <dir>] [--out <dir>] [--bank <dir>] [--timeout-ms <n>]
// It skips, with one log line, when the pass did not succeed (--exit other than 0), saved nothing (--saved names a missing folder),
// was a dry run, was started with --no-hub or SLEIGHT_NO_HUB=1 (tests and A/B runs that must not publish), a live round holds
// /tmp/sleight-live.lock, or another project's timed window is open (/tmp/sleight-hold). It also refuses, whatever the flags say,
// when this checkout is not on a Git branch or is a validation or A/B staging root (the structural guard for callers that forget
// --no-hub). A hub error, a crash or a timeout logs one line and the exit status stays 0, so the pass is never failed or held up
// by the hub. It never waits for a lock.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVE_LOCK = '/tmp/sleight-live.lock';
export const HOLD = '/tmp/sleight-hold';
export const DEFAULT_TIMEOUT_MS = 120_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUB = join(ROOT, 'bench', 'results-hub.mjs');

// A checkout the hub must never rewrite, whatever the flags say: a detached HEAD (a pinned build under validation or an A/B), a
// staging root the validation drivers make (/tmp/lane-vp1-*, /tmp/lane-ab-*), or an A/B worktree (ab-old, ab-new). Returns the
// reason, or null for a checkout on a branch.
const STAGING = /(?:^|\/)(?:lane-(?:vp|ab)[a-z0-9]*-[^/]*|ab-(?:old|new))(?:\/|$)/;
export function checkoutBlock({ root = ROOT, git = (...args) => spawnSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' }), real = path => realpathSync(path) } = {}) {
  let path = root;
  try { path = real(root); } catch { /* an unreadable path is judged by its name */ }
  if (STAGING.test(path)) return `${path.split('/').pop()} is a validation or A/B staging checkout`;
  const head = git('symbolic-ref', '-q', 'HEAD');
  if (head.error || head.status !== 0) return 'the checkout is on a detached HEAD or has no Git branch';
  return null;
}

// Why the hub should not run now, or null when it should. `checkout` is checkoutBlock()'s answer; tests pass null or a reason.
export function skipReason({ exitCode = 0, saved, dryRun = false, noHub = false, env = process.env, exists = existsSync, lock = LIVE_LOCK, hold = HOLD, checkout } = {}) {
  if (noHub || /^(1|true|yes)$/i.test(env.SLEIGHT_NO_HUB ?? '')) return 'no-hub flag or SLEIGHT_NO_HUB';
  const blocked = checkout === undefined ? checkoutBlock() : checkout;
  if (blocked) return blocked;
  if (dryRun) return 'dry run';
  if (exitCode !== 0) return `the pass did not succeed (exit ${exitCode})`;
  if (saved !== undefined && !exists(saved)) return 'the pass saved no results folder';
  if (exists(lock)) return `a live round holds ${lock}`;
  if (exists(hold)) return `${hold} marks another project's timed window`;
  return null;
}

const oneLine = (text, max = 160) => String(text ?? '').split('\n').map(line => line.trim()).find(Boolean)?.split(homedir()).join('~').slice(0, max) ?? '';

// Runs collect and render in a child process, so a crash or process.exit inside the hub cannot reach the caller. Returns the log
// line; never throws.
export function refreshHub({ hubArgs = [], timeoutMs = DEFAULT_TIMEOUT_MS, run = spawnSync, hub = HUB, ...decision } = {}) {
  try {
    const why = skipReason(decision);
    if (why) return { status: 'skipped', line: `hub: skipped, ${why}` };
    const started = Date.now();
    const child = run(process.execPath, [hub, ...hubArgs], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
    if (child.error) return { status: 'failed', line: `hub: refresh failed (${oneLine(child.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs} ms` : child.error.message)})` };
    if (child.status !== 0) return { status: 'failed', line: `hub: refresh failed (exit ${child.status}${child.signal ? `, ${child.signal}` : ''}: ${oneLine(child.stderr) || oneLine(child.stdout)})` };
    return { status: 'refreshed', line: `hub: refreshed (${((Date.now() - started) / 1000).toFixed(1)} s): ${oneLine(String(child.stdout).trim().split('\n').at(-1))}` };
  } catch (error) {
    return { status: 'failed', line: `hub: refresh failed (${oneLine(error?.message)})` };
  }
}

// The validation and re-measure drivers refuse a changed pinned checkout. A hub refresh rewrites docs/results and the README's
// generated blocks, so changes there are tolerated only while the tree matches what `results-hub --render-only` renders from its own
// data files (`--check` exits 0). Any other edit to those paths, and every change elsewhere, still counts. `status` is the text of
// `git status --porcelain`, trimmed or not; `fresh` answers whether the hub output is consistent, and runs only if such a path changed.
export const isHubPath = path => path === 'README.md' || path.startsWith('docs/results/');
export function pendingChanges(status, fresh) {
  const lines = String(status).split('\n').filter(Boolean);
  const hubOnly = line => !/ -> /.test(line) && isHubPath(line.replace(/^[ MADRCTU?!]{1,2}\s/, '').replace(/^"|"$/g, ''));
  if (!lines.some(hubOnly)) return lines;
  const consistent = fresh();
  return lines.filter(line => !(consistent && hubOnly(line)));
}
export function hubIsFresh(root = ROOT, run = spawnSync) {
  const check = run(process.execPath, [join(root, 'bench', 'results-hub.mjs'), '--render-only', '--check'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return check.status === 0;
}

function parse(argv) {
  const out = { hubArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = () => argv[++i];
    if (flag === '--exit') out.exitCode = Number(value());
    else if (flag === '--saved') out.saved = resolve(value());
    else if (flag === '--dry-run') out.dryRun = true;
    else if (flag === '--no-hub') out.noHub = true;
    else if (flag === '--wt' || flag === '--out' || flag === '--bank') out.hubArgs.push(flag, value());
    else if (flag === '--timeout-ms') out.timeoutMs = Number(value());
    else throw new Error(`unknown option ${flag}`);
  }
  if (out.exitCode !== undefined && !Number.isInteger(out.exitCode)) throw new Error('--exit needs a number');
  return out;
}

export function main(argv = process.argv.slice(2), log = console.log, extra = {}) {
  let result;
  try { result = refreshHub({ ...parse(argv), ...extra }); }
  catch (error) { result = { status: 'failed', line: `hub: refresh failed (${oneLine(error.message)})` }; }
  log(result.line);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main();
