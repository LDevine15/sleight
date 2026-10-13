import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_VERSION, defaultArmRoot, outsideGit } from '../browser.mjs';
import { interactivePlan } from './interactive.mjs';

export function setupPlan(target = join(defaultArmRoot(), 'claude-cu')) {
  target = resolve(target); outsideGit(target);
  target = interactivePlan({ armDir: target, prompt: 'setup only' }).armDir;
  if (basename(target) !== 'claude-cu') throw new Error('arm folder must be named claude-cu');
  const configDir = join(target, 'claude'), command = join(target, 'node_modules/.bin/claude');
  return { surface: 'claude-cu', supported: true, interactive: true, target, configDir,
    install: { command: 'npm', args: ['install', '--prefix', target, '--cache', join(target, 'npm-cache'), '--ignore-scripts',
      '--no-audit', '--no-fund', '--save-exact', `@anthropic-ai/claude-code@${CLAUDE_VERSION}`] },
    claudeInstaller: { command: process.execPath, args: [join(target, 'node_modules/@anthropic-ai/claude-code/install.cjs')] },
    versionCheck: { command, args: ['--version'] },
    ownerLogin: ['env', `CLAUDE_CONFIG_DIR=${configDir}`, command, 'auth', 'login'],
    permissions: ['Owner: use a Pro or Max direct-plan login in this isolated profile.',
      'Owner: grant Accessibility and Screen Recording to the requester macOS names. This lane has not observed its identity.',
      'Owner: workspace trust and each session app approval remain manual. The harness stops at these prompts.'],
    source: 'https://code.claude.com/docs/en/computer-use' };
}

export function installInteractive(plan, { dryRun = false, run = spawnSync } = {}) {
  if (dryRun) return;
  if (existsSync(plan.target)) throw new Error('interactive arm folder already exists');
  mkdirSync(plan.target, { recursive: true, mode: 0o700 });
  try {
    const env = interactivePlan({ armDir: plan.target, prompt: 'setup only' }).env;
    for (const step of [plan.install, plan.claudeInstaller, plan.versionCheck]) {
      const result = run(step.command, step.args, { cwd: plan.target, env, encoding: 'utf8', timeout: 180000 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`interactive arm setup exited ${result.status}`);
      if (step === plan.versionCheck && result.stdout?.trim() !== `${CLAUDE_VERSION} (Claude Code)`) throw new Error(`interactive arm requires Claude Code ${CLAUDE_VERSION}`);
    }
  } catch (error) { rmSync(plan.target, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [pin, ...args] = process.argv.slice(2);
    if (pin !== `@anthropic-ai/claude-code@${CLAUDE_VERSION}` || args.filter(a => a !== '--dry-run').length > 1 || args.some(a => a.startsWith('--') && a !== '--dry-run')) throw new Error('invalid interactive setup options or pin');
    const plan = setupPlan(args.find(a => a !== '--dry-run'));
    console.log(JSON.stringify(plan, null, 2)); installInteractive(plan, { dryRun: args.includes('--dry-run') });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
