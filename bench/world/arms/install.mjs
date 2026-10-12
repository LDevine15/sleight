import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultArmRoot, setupPlan, CLAUDE_VERSION, worldAgentSetup } from './browser.mjs';

export function installArm(plan, { run = spawnSync } = {}) {
  if (!plan.supported) return 0;
  fs.mkdirSync(plan.target, { recursive: true });
  const { env } = worldAgentSetup({ surface: plan.surface, dir: plan.target, armRoot: path.dirname(plan.target) });
  for (const step of [plan.install, plan.claudeInstaller]) {
    const result = run(step.command, step.args, { cwd: plan.target, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${step.command} exited ${result.status ?? result.signal ?? 'without a status'}`);
  }
  const result = run(plan.versionCheck.command, plan.versionCheck.args, { cwd: plan.target, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout?.trim() !== `${CLAUDE_VERSION} (Claude Code)`) {
    throw new Error(`Expected Claude Code ${CLAUDE_VERSION}; executable check failed: ${result.stderr || result.stdout || result.status}`);
  }
  return 0;
}

if (import.meta.main) {
  const [surface, pin, claudePin, ...args] = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const target = args.find(arg => arg !== '--dry-run') || path.join(defaultArmRoot(), surface);
  try {
    const plan = setupPlan(surface, target, pin, claudePin);
    console.log(JSON.stringify(plan, null, 2));
    if (!dryRun) process.exitCode = installArm(plan);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
