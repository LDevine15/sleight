import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export const ARMS = ['browser-use'];
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const KEY_DIR = '~/.config/sleight-bench';
export const TELEMETRY = {
  ANONYMIZED_TELEMETRY: 'false',
  BROWSER_USE_ANONYMIZED_TELEMETRY: 'false',
  BROWSER_USE_CLOUD_SYNC: 'false',
  DO_NOT_TRACK: '1',
};

export function armDir(arm) {
  return join(ROOT, 'bench/world/arms', arm);
}

export function armCommand({ arm, out, prompt, model = 'opus', effort = 'medium', fake = false, result = '', budgetSeconds = 600 }) {
  if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`);
  const dir = armDir(arm);
  const script = join(dir, 'run.py');
  const args = ['run', '--python', '3.12'];
  if (fake) args.push('--no-project');
  else args.push('--frozen', '--project', dir);
  args.push('--', 'python', script, '--arm', arm, '--out', out, '--prompt', prompt, '--model', model, '--effort', effort,
    '--budget-seconds', String(budgetSeconds));
  if (result) args.push('--result', result);
  if (fake) args.push('--fake');
  return { command: 'uv', args, cwd: dir, env: { ...TELEMETRY, PYTHONPATH: join(ROOT, 'bench/world/arms/lib') } };
}

export function runArm(opts) {
  const { command, args, env, cwd } = armCommand(opts);
  const timeout = opts.timeoutMs ?? (opts.fake ? 30000 : (opts.budgetSeconds ?? 600) * 1000);
  return spawnSync(command, args, {
    encoding: 'utf8', cwd, env: { ...process.env, ...env }, timeout, killSignal: 'SIGKILL',
    detached: !opts.fake,
  });
}

export function parseEvents(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function resultEvent(events) {
  const found = events.filter(e => e.type === 'result').at(-1);
  if (!found) throw new Error('no result event');
  return found;
}

export function hasLockfile(arm) {
  return existsSync(join(armDir(arm), 'uv.lock'));
}
