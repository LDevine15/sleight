#!/usr/bin/env node
// Refreshes the benchmark hub (bench/results-hub.mjs: collect, then render) once after a runner has saved a completed pass.
// bench/run.mjs, bench/fowl/rounds.sh, bench/validation/validation-140.mjs and bench/validation/remeasure.mjs call it at the end.
//   node bench/hub-refresh.mjs [--exit <code>] [--saved <folder>] [--dry-run] [--no-hub] [--wt <dir>] [--out <dir>] [--bank <dir>] [--timeout-ms <n>]
// It skips, with one log line, when the pass did not succeed (--exit other than 0), saved nothing (--saved names a missing folder),
// was a dry run, was started with --no-hub or SLEIGHT_NO_HUB=1 (tests and A/B runs that must not publish), or when a live round is
// running (/tmp/sleight-live.lock) or another project's timed window is open (/tmp/sleight-hold). A hub error, a crash or a timeout
// logs one line and the exit status stays 0, so the pass is never failed or held up by the hub. It never waits for a lock.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVE_LOCK = '/tmp/sleight-live.lock';
export const HOLD = '/tmp/sleight-hold';
export const DEFAULT_TIMEOUT_MS = 120_000;
const HUB = join(dirname(fileURLToPath(import.meta.url)), 'results-hub.mjs');

// Why the hub should not run now, or null when it should.
export function skipReason({ exitCode = 0, saved, dryRun = false, noHub = false, env = process.env, exists = existsSync, lock = LIVE_LOCK, hold = HOLD } = {}) {
  if (noHub || /^(1|true|yes)$/i.test(env.SLEIGHT_NO_HUB ?? '')) return 'no-hub flag or SLEIGHT_NO_HUB';
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

export function main(argv = process.argv.slice(2), log = console.log) {
  let result;
  try { result = refreshHub(parse(argv)); }
  catch (error) { result = { status: 'failed', line: `hub: refresh failed (${oneLine(error.message)})` }; }
  log(result.line);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main();
