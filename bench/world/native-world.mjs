import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORLD_CLAUDE_VERSION = '2.1.289';
export const worldCLI = armHome => join(armHome, 'world-cli/node_modules/.bin/claude');
const isolatedEnv = () => ({ ...Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'TERM']
  .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
  DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' });
export function worldArm(arm, name) {
  return { ...arm, world: true, args: [...arm.args, ...(arm.args.includes('--no-chrome') ? [] : ['--no-chrome'])],
    env: { ...arm.env, CLAUDE_CONFIG_DIR: join(arm.cwd, 'claude'), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DO_NOT_TRACK: '1' },
    identity: { ...arm.identity, name, claudeVersion: WORLD_CLAUDE_VERSION, configSource: 'isolated world suite config' } };
}
export const worldSettings = settings => ({ ...settings, autoMemoryEnabled: false, claudeMdExcludes: ['**', '**/.claude/**', '**/.claude/**/.*'],
  pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'managed-only' } } } });
export function assertWorldCLI(command, run = execFileSync) {
  const version = run(command, ['--version'], { encoding: 'utf8', timeout: 10000,
    env: isolatedEnv() }).trim();
  if (!version.startsWith(WORLD_CLAUDE_VERSION + ' ') && version !== WORLD_CLAUDE_VERSION) {
    throw new Error(`world suite requires Claude Code ${WORLD_CLAUDE_VERSION}, got ${version}`);
  }
  return WORLD_CLAUDE_VERSION;
}
export function worldSetupPlan(dir = join(process.env.BENCH_ARM_HOME || join(homedir(), 'Library/Caches/sleight-bench'), 'world-cli')) {
  dir = resolve(dir);
  let parent = dir;
  while (!existsSync(parent)) parent = dirname(parent);
  parent = realpathSync(parent);
  for (;;) {
    if (existsSync(join(parent, '.git'))) throw new Error('world CLI setup must be outside git');
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  return { dir, version: WORLD_CLAUDE_VERSION, install: ['npm', 'install', '--prefix', dir, '--cache', join(dir, 'npm-cache'),
    '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `@anthropic-ai/claude-code@${WORLD_CLAUDE_VERSION}`],
    lifecycle: [process.execPath, join(dir, 'node_modules/@anthropic-ai/claude-code/install.cjs')],
    command: join(dir, 'node_modules/.bin/claude') };
}
export async function installWorldCLI(plan, { dryRun = false, run = execFileSync } = {}) {
  if (dryRun) return;
  if (existsSync(plan.dir)) throw new Error('world CLI folder already exists; use a fresh folder');
  mkdirSync(plan.dir, { recursive: true, mode: 0o700 });
  try {
    const options = { cwd: plan.dir, stdio: 'inherit', timeout: 180000,
      env: { ...isolatedEnv(), CLAUDE_CONFIG_DIR: join(plan.dir, 'claude') } };
    run(plan.install[0], plan.install.slice(1), options);
    run(plan.lifecycle[0], plan.lifecycle.slice(1), options);
    assertWorldCLI(plan.command, run);
  } catch (error) { rmSync(plan.dir, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let setup = false, dryRun = false, dir;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--setup') setup = true;
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--dir' && args[i + 1] && !args[i + 1].startsWith('--')) dir = args[++i];
    else throw new Error(`unknown or incomplete option ${args[i]}`);
  }
  if (!setup) throw new Error('use --setup, optionally --dry-run and --dir PATH');
  const plan = worldSetupPlan(dir);
  console.log(JSON.stringify(plan, null, 2));
  await installWorldCLI(plan, { dryRun });
}
