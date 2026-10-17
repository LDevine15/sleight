import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeBrowserSetup, windowPrompt } from './native-setup.mjs';
import { turboSetup } from '../turbo/setup.mjs';
import { codexExecPlan } from '../codex-arm.mjs';
import { modelId } from './accounting.mjs';
import { worldAgentSetup } from '../world/arms/browser.mjs';
import { genericSettings } from '../plugin-arm.mjs';

import { REAL_BROWSER_ARMS } from './support.mjs';
export const REAL_SURFACES = REAL_BROWSER_ARMS;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const codexHome = () => join(homedir(), '.codex-bench');
export function codexBrowserSetup({ dir, prompt, realBrowser }) {
  prompt = windowPrompt(realBrowser) + prompt;
  return { command: 'codex', args: codexExecPlan(prompt, { cwd: dir, model: 'gpt-6-luna', effort: 'high' }),
    prompt, mcpConfig: null, mcpConfigFile: join(codexHome(), 'config.toml'), env: { CODEX_HOME: codexHome() }, metadata: { model: 'gpt-6-luna', effort: 'high',
      configDir: codexHome(), browser: realBrowser.browser, profile: realBrowser.profileName || realBrowser.profileRoot, headless: false, focus: 'not measured' } };
}
export function realAgentSetup({ task, surface, dir, realBrowser, armHome, dryRun = false, repo = repoRoot,
  model = 'haiku', effort = 'high', settings = join(dir, 'settings.json') }) {
  if (!REAL_SURFACES.includes(surface)) throw Error(`Unknown real-browser arm: ${surface}`);
  const browserName = { chrome: 'Chrome', helium: 'Helium', firefox: 'Firefox', safari: 'Safari' }[realBrowser.browser];
  const prompt = task.prompt.replaceAll('{browser}', browserName).replaceAll('{repo}', repo).replaceAll('{out}', dir) +
    `\n\nEnd your answer with one line starting with RESULT: that states ${task.result}.`;
  if (surface === 'codex') return codexBrowserSetup({ dir, prompt, realBrowser });
  const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'TERM'].flatMap(key =>
    typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []));
  const engine = surface === 'sleight';
  const computer = ['firefox', 'safari'].includes(realBrowser.browser);
  if ((engine && !computer) || (surface === 'sleight-turbo' && computer)) throw Error('Firefox/Safari use plain sleight; Chrome/Helium use sleight-turbo');
  const common = engine ? worldAgentSetup({ surface: 'sleight', dir, hostEnv: env }) : null;
  const arm = engine ? { ...common,
    settings: { ...common.settings, ...genericSettings({ servers: ['plugin:sleight:computer'] }, repo) },
    mcpServers: { 'plugin:sleight:computer': { command: join(repo, 'plugins/sleight/bin/sleight-mcp'), env: { SLEIGHT_SURFACES: 'computer' } } },
    allowed: 'mcp__plugin_sleight_computer__js,mcp__plugin_sleight_computer__js_reset,mcp__plugin_sleight_computer__open_file',
    metadata: { ...common.metadata, surface, connectionMode: 'engine-computer' } }
    : surface === 'sleight-turbo' ? turboSetup({ task: { ...task, browser: realBrowser.browser }, repo, dir, prompt, realBrowser, env })
    : nativeBrowserSetup({ surface, repo, dir, realBrowser, armHome, dryRun, env });
  const fullPrompt = arm.promptPrefix + (engine || surface === 'sleight-turbo' ? windowPrompt(realBrowser) : '') + prompt;
  const args = ['-p', '--model', modelId(model), '--effort', effort, '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', join(dir, 'mcp.json'), '--settings', settings,
    '--allowedTools', arm.allowed, '--tools', '', '--no-chrome', ...arm.args,
    ...(engine || surface === 'sleight-turbo' ? ['--plugin-dir', join(repo, 'plugins/sleight')] : [])];
  return { command: arm.command, args, prompt: fullPrompt, mcpConfig: { mcpServers: arm.mcpServers },
    settingsOverrides: engine || surface === 'sleight-turbo' ? { ...arm.settings, hooks: { ...arm.settings.hooks,
      Elicitation: [{ matcher: 'plugin:sleight:computer', hooks: [{ type: 'command', timeout: 5,
        command: `node "${join(repo, 'bench/fowl/origin-hook.mjs')}"` }] }] } } : arm.settings, env: { ...arm.env, ANTHROPIC_SMALL_FAST_MODEL: modelId(model) }, allowed: arm.allowed,
    metadata: { ...arm.metadata, browser: realBrowser.browser, profile: realBrowser.profileName || realBrowser.profileRoot,
      headless: false, focus: surface === 'sleight-turbo' ? 'host monitor' : 'not measured' } };
}
