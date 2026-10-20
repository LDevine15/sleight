#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This function also runs inside the container, with only Node built-ins in scope.
export function runContainerChecks({ spawn = spawnSync, env = process.env,
  makeConfig = () => mkdtempSync(join(tmpdir(), 'lane-claude-')),
  removeConfig = directory => rmSync(directory, { recursive: true, force: true }),
} = {}) {
  const config = makeConfig();
  try {
    for (const args of [['ci', '--ignore-scripts'], ['test']]) {
      const result = spawn('npm', args, { stdio: 'inherit', shell: false,
        env: { ...env, CLAUDE_CONFIG_DIR: config } });
      if (result.error || result.signal || !Number.isInteger(result.status)) return 1;
      if (result.status !== 0) return result.status;
    }
    return 0;
  } finally { removeConfig(config); }
}

export const containerProgram = `
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const runContainerChecks = ${runContainerChecks.toString()};
process.exitCode = runContainerChecks();
`;

export function linuxPreflightPlan(worktree = fileURLToPath(new URL('..', import.meta.url))) {
  const root = resolve(worktree);
  // Docker's volume syntax cannot represent a colon inside a host path.
  if (/[:\r\n\0]/.test(root)) throw new Error('worktree path contains a Docker volume separator or control character');
  return { command: 'docker', args: ['run', '--rm', '-v', `${root}:/w`, '-v', '/w/node_modules',
    '-w', '/w', 'node:24', 'node', '--input-type=module', '-e', containerProgram], cwd: root };
}

export function runLinuxPreflight({ worktree, spawn = spawnSync, log = message => console.error(message) } = {}) {
  const { command, args, cwd } = linuxPreflightPlan(worktree);
  const result = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) log(`Linux preflight could not start: ${result.error.message}`);
  else if (result.signal) log(`Linux preflight stopped by ${result.signal}`);
  if (result.error || result.signal || !Number.isInteger(result.status)) return 1;
  return result.status;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--worktree')) {
    console.error('Usage: node scripts/linux-preflight.mjs [--worktree PATH]');
    process.exitCode = 2;
  } else {
    try { process.exitCode = runLinuxPreflight({ worktree: args[1] }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
