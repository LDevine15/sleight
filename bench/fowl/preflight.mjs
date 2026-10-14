import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertLogin, assertSpend, assertFowlSocket, assertEngineSockets, quote } from '../preflight.mjs';
import { modelId } from './accounting.mjs';
import { runnableTasks } from './support.mjs';

export function selectedTasks(tasks, args) {
  return tasks.filter(task => (!args.only || args.only.split(',').includes(task.name)) && (args.gui || args.remote || !task.takeover))
    .map(task => ({ ...task, surface: task.surface ?? args.surface ?? 'fowlbrowser',
      ...(args.swap ? { browser: task.browser === 'helium' ? 'chrome' : 'helium' } : {}) }));
}

export async function fowlPreflight({ tasks, model = 'opus', world = false, remote, home = homedir(), env = process.env }, {
  spend = assertSpend, login = assertLogin, fowlSocket = assertFowlSocket, engineSockets = assertEngineSockets,
} = {}) {
  tasks = runnableTasks(tasks, { world, remote });
  const api = tasks.some(task => task.surface === 'browser-use') ||
    (!modelId(model).includes('opus') && tasks.some(task => task.surface !== 'claude-cu'));
  const account = task => task.surface === 'claude-cu' || (!api && task.surface !== 'browser-use');
  if (tasks.some(task => task.surface !== 'codex-agent' && !account(task))) {
    spend({ file: join(home, 'Library/Logs/sleight/bench-api-spend.json'), capUsd: 190 });
  }
  // Remote sockets are checked by the runner on that host, never against this Mac's sockets.
  if (!remote) {
    const browsers = [...new Set(tasks.filter(task => !['browser-use', 'sleight-turbo'].includes(task.surface)).map(task => task.browser))];
    for (const browser of browsers) await fowlSocket(browser, { home });
    if (tasks.some(task => ['sleight', 'codex', 'codex-agent'].includes(task.surface))) await engineSockets();
  }
  const seen = new Set();
  for (const task of tasks.filter(task => task.surface !== 'codex-agent' && account(task))) {
    const surface = task.surface, arm = join(home, '.config/sleight-bench/world/arms', surface);
    const ownCLI = world || ['sleight-turbo', 'claude-cu', 'claude-in-chrome', 'playwright-mcp', 'chrome-devtools-mcp'].includes(surface);
    const cliArm = surface === 'sleight-turbo' ? join(home, '.config/sleight-bench/world/arms/fowlbrowser') : arm;
    const command = ownCLI ? join(cliArm, 'node_modules/.bin/claude') : 'claude';
    const config = surface === 'claude-cu' ? join(arm, 'claude') : ownCLI ? join(arm, 'claude-config')
      : join(home, 'Library/Caches/sleight-bench/fowl-claude-config');
    const key = JSON.stringify([command, config]);
    if (seen.has(key)) continue;
    seen.add(key);
    login({ command, env: { ...env, CLAUDE_CONFIG_DIR: config } });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = {}, flags = new Set(['swap', 'keep-tabs', 'gui', 'remote-held', 'dry-run', 'world', 'funding-surfaces']);
  const values = process.argv.slice(2);
  for (let i = 0; i < values.length; i++) {
    const name = values[i].slice(2); args[name] = flags.has(name) ? true : values[++i];
  }
  if (args['funding-surfaces'] || !args['dry-run']) {
    try {
      const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
      const file = resolve(cache, args.tasks || 'tools/agents/example.json');
      if (!existsSync(file)) {
        const fix = !args.tasks && !existsSync(cache) ? ['git', 'clone', '-q', 'https://github.com/argofowl/FowlBrowser', cache]
          : ['nano', file];
        throw new Error(`Round task file is missing: ${file}.\nFix: ${fix.map(quote).join(' ')}`);
      }
      const tasks = selectedTasks(JSON.parse(readFileSync(file, 'utf8')), args);
      if (args['funding-surfaces']) {
        // Codex's own model does not use the Claude API key.
        console.log([...new Set(runnableTasks(tasks, args).filter(task => task.surface !== 'codex-agent').map(task => task.surface))].join('\n'));
      } else await fowlPreflight({ tasks, model: args.model, world: args.world, remote: args.remote });
    } catch (error) { console.error(`preflight failed: ${error.message}`); process.exitCode = 1; }
  }
}
