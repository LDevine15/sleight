// Run11 admission only. Owner decisions about native multi-window setup and host-kill focus remain open.
// This entrypoint never writes turbo acceptance, compiles helpers or changes the qualification rules.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { main as run, parseRunnerArgs } from './electron-live-runner.mjs';
import { HOLD, LOCK } from './electron-qualification.mjs';
import { turboAcceptance } from './electron-qualification-live.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

export function parseRun11Args(argv) {
  const args = [...argv], index = args.indexOf('--commit');
  if (index < 0 || !/^[a-f0-9]{40}$/.test(args[index + 1] ?? '')) throw Error('RUN11_COMMIT_REQUIRED');
  const [, commit] = args.splice(index, 2);
  const options = parseRunnerArgs(args);
  if (options.mode !== 'live' || !options.out) throw Error('RUN11_LIVE_OUTPUT_REQUIRED');
  return { args, commit, options };
}

export async function admitRun11({ commit, options }, {
  git = async args => (await execute('/usr/bin/git', ['-C', root, ...args], { timeout: 5000 })).stdout.trim(),
  accepted = turboAcceptance, exists = existsSync,
} = {}) {
  if (await git(['rev-parse', 'HEAD']) !== commit) throw Error('RUN11_COMMIT_MISMATCH');
  // Include the harness and every tracked file. Added package or harness files also invalidate the pinned build.
  if (await git(['diff', '--name-only', 'HEAD', '--']) ||
      await git(['ls-files', '--others', '--exclude-standard', '--', 'plugins/sleight', 'bench'])) throw Error('RUN11_BUILD_DIRTY');
  if (!await accepted()) throw Error('RUN11_TURBO_RECEIPT_REQUIRED');
  if (exists(resolve(options.out))) throw Error('RUN11_OUTPUT_EXISTS');
  // These are fresh launch checks, never stale-lock removal or a substitute for the runner's exclusive acquisition.
  if (exists(HOLD)) throw Error('RUN11_HOLD_PRESENT');
  if (exists(LOCK)) throw Error('RUN11_LOCK_PRESENT');
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const plan = parseRun11Args(argv);
  await admitRun11(plan, deps);
  return (deps.run ?? run)(plan.args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
