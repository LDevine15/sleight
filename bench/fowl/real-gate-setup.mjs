import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeBrowserSetup, windowPrompt } from './native-setup.mjs';
import { turboSetup } from '../turbo/setup.mjs';
import { codexExecPlan } from '../codex-arm.mjs';
import { modelId } from './accounting.mjs';
import { worldAgentSetup, browserArmSetup, defaultArmRoot } from '../world/arms/browser.mjs';
import { genericSettings } from '../plugin-arm.mjs';
import { withManifestBackup } from '../world/arms/chrome.mjs';
import { claudeHostManifest } from './real-browser.mjs';

const defaultMcpRoot = () => join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
// The two extension arms run in the round's own browser, which is the whole browser process: no window prompt.
// FowlBrowser keeps the previous gate's world prompt and Stop hook; Claude in Chrome keeps its world arm's device pin.
export function extensionArmSetup({ task, surface, dir, realBrowser, env, mcpRoot = defaultMcpRoot(), armRoot = defaultArmRoot(), chromeFiles }) {
  if (surface === 'claude-in-chrome') {
    if (realBrowser.browser !== 'chrome' || realBrowser.profileMode !== 'benchmark-copy') throw Error('Claude in Chrome needs Chrome with --real-profile benchmark');
    const arm = browserArmSetup({ surface, task: { ...task, browser: 'chrome' }, dir, armRoot, hostEnv: env, chromeFiles });
    const { launch, ...chrome } = arm.chrome; // the gate launches its own copy, never `open` on the default folder
    return { ...arm, chrome, args: [...arm.args.filter((arg, i, all) => arg !== '--tools' && all[i - 1] !== '--tools'), '--no-session-persistence'],
      promptPrefix: arm.promptPrefix + arm.setupPrefix, metadata: { ...arm.metadata, surface, connectionMode: 'extension (Claude Code --chrome)' } };
  }
  const common = worldAgentSetup({ surface: 'fowlbrowser', dir, armRoot, hostEnv: env });
  const label = `🧪 ${task.name}`;
  return { ...common, args: [...common.args, '--no-session-persistence'],
    mcpServers: { fowlbrowser: { command: join(mcpRoot, 'mcp/bin/fowlbrowser-mcp'), env: { FOWLBROWSER_LABEL: label, FOWLBROWSER_RECORD: dir } } },
    allowed: 'mcp__fowlbrowser',
    settings: { ...common.settings, hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${join(mcpRoot, 'mcp/bin/turn-ended.mjs')}"`, timeout: 5 }] }] } },
    promptPrefix: common.promptPrefix + `When cua.createBrowserTab is available, open tabs with cua.createBrowserTab(browserId, url, { sessionName: '${label}' }). Other tools accepting sessionName use the same label.\n\n`,
    metadata: { ...common.metadata, surface, mcpRoot, connectionMode: 'extension (FowlBrowser native host)' } };
}

// Claude Code writes its native-host manifest under Chrome's default folder on every --chrome start and, when none was
// there, opens its reconnect page in the running Chrome (the round's window). An existing manifest stops that page; the
// world arm's backup puts the folder back as it was afterwards.
export async function withClaudeManifest(plan, run, { backup = withManifestBackup } = {}) {
  const { manifest, backupDir } = plan.chrome;
  return backup(manifest, backupDir, async () => {
    if (!existsSync(manifest)) {
      mkdirSync(dirname(manifest), { recursive: true });
      writeFileSync(manifest, JSON.stringify(claudeHostManifest(join(plan.env.CLAUDE_CONFIG_DIR, 'chrome/chrome-native-host')), null, 2), { mode: 0o644, flag: 'wx' });
    }
    return run();
  });
}

import { REAL_BROWSER_ARMS } from './support.mjs';
export const REAL_SURFACES = REAL_BROWSER_ARMS;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const codexHome = () => join(homedir(), '.codex-bench');
export function codexBrowserSetup({ dir, prompt, realBrowser }) {
  prompt = windowPrompt(realBrowser) + prompt;
  return { command: 'codex', args: codexExecPlan(prompt, { cwd: dir, model: 'gpt-6-luna', effort: 'high' }),
    prompt, mcpConfig: null, mcpConfigFile: join(codexHome(), 'config.toml'), env: { CODEX_HOME: codexHome() }, metadata: { model: 'gpt-6-luna', effort: 'high',
      configDir: codexHome(), browser: realBrowser.browser, profile: realBrowser.profileName || realBrowser.profileRoot,
      profileMode: realBrowser.profileMode || 'fresh', browserVersion: realBrowser.version ?? null, headless: false, focus: 'not measured' } };
}
// The names select_window may use for the round's own browser (origin-hook.mjs gateWindow), and its marker title.
export function gateWindowApps(realBrowser) {
  const names = { firefox: ['Firefox', 'org.mozilla.firefox'], safari: ['Safari', 'com.apple.Safari'] }[realBrowser.browser];
  if (!names || !realBrowser.marker) throw Error('Gate window selection needs Firefox or Safari with a marker');
  const app = /^(\/.+?\.app)\//.exec(realBrowser.executable ?? '')?.[1];
  return { apps: [...names, ...(app ? [app] : [])], title: realBrowser.marker };
}
export function realAgentSetup({ task, surface, dir, realBrowser, armHome, dryRun = false, repo = repoRoot,
  model = 'haiku', effort = 'high', settings = join(dir, 'settings.json'), mcpRoot, armRoot, chromeFiles }) {
  if (!REAL_SURFACES.includes(surface)) throw Error(`Unknown real-browser arm: ${surface}`);
  const browserName = { chrome: 'Chrome', helium: 'Helium', firefox: 'Firefox', safari: 'Safari' }[realBrowser.browser];
  const prompt = task.prompt.replaceAll('{browser}', browserName).replaceAll('{repo}', repo).replaceAll('{out}', dir) +
    `\n\nEnd your answer with one line starting with RESULT: that states ${task.result}.`;
  if (surface === 'codex') return codexBrowserSetup({ dir, prompt, realBrowser });
  const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'TERM'].flatMap(key =>
    typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []));
  const engine = surface === 'sleight';
  const extension = ['fowlbrowser', 'claude-in-chrome'].includes(surface);
  const computer = ['firefox', 'safari'].includes(realBrowser.browser);
  if ((engine && !computer) || (surface === 'sleight-turbo' && computer)) throw Error('Firefox/Safari use plain sleight; Chrome/Helium use sleight-turbo');
  const common = engine ? worldAgentSetup({ surface: 'sleight', dir, hostEnv: env }) : null;
  const arm = extension ? extensionArmSetup({ task, surface, dir, realBrowser, env, mcpRoot,
    ...(armRoot ? { armRoot } : {}), ...(chromeFiles ? { chromeFiles } : {}) })
    : engine ? { ...common,
    settings: { ...common.settings, ...genericSettings({ servers: ['plugin:sleight:computer'] }, repo) },
    // Turbo off: the round's Firefox or Safari is reachable only on the engine path, and a turbo.json in HOME would add
    // browser_* tools that point at the owner's Chrome or Helium (real round 2026-10-17: 5 of 12 tasks stopped on them).
    mcpServers: { 'plugin:sleight:computer': { command: join(repo, 'plugins/sleight/bin/sleight-mcp'), env: { SLEIGHT_SURFACES: 'computer', SLEIGHT_TURBO: '0' } } },
    env: { ...common.env, SLEIGHT_TURBO: '0', FOWL_GATE_WINDOW: JSON.stringify(gateWindowApps(realBrowser)) },
    allowed: 'mcp__plugin_sleight_computer__js,mcp__plugin_sleight_computer__js_reset,mcp__plugin_sleight_computer__open_file,mcp__plugin_sleight_computer__drag,mcp__plugin_sleight_computer__select_window',
    metadata: { ...common.metadata, surface, connectionMode: 'engine-computer' } }
    : surface === 'sleight-turbo' ? turboSetup({ task: { ...task, browser: realBrowser.browser }, repo, dir, prompt, realBrowser, env })
    : nativeBrowserSetup({ surface, repo, dir, realBrowser, armHome, dryRun, env });
  const fullPrompt = arm.promptPrefix + (engine || surface === 'sleight-turbo' ? windowPrompt(realBrowser) : '') + prompt;
  // Pinned: the same login reported "default" at 17:03 and "auto" from 20:05 on 2026-10-17, and under auto Claude in
  // Chrome sent every page action to a prompt in Chrome that nobody answers. allowedTools still lists each arm's tools.
  const args = ['-p', '--model', modelId(model), '--effort', effort, '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', join(dir, 'mcp.json'), '--settings', settings,
    '--allowedTools', arm.allowed, '--tools', '', ...(surface === 'claude-in-chrome' ? [] : ['--no-chrome']), ...arm.args,
    ...(engine || surface === 'sleight-turbo' ? ['--plugin-dir', join(repo, 'plugins/sleight')] : [])];
  return { command: arm.command, args, prompt: fullPrompt, mcpConfig: { mcpServers: arm.mcpServers },
    settingsOverrides: engine || surface === 'sleight-turbo' ? { ...arm.settings, hooks: { ...arm.settings.hooks,
      Elicitation: [{ matcher: 'plugin:sleight:computer', hooks: [{ type: 'command', timeout: 5,
        command: `node "${join(repo, 'bench/fowl/origin-hook.mjs')}"` }] }],
      ...(engine ? { PreToolUse: [{ matcher: 'mcp__plugin_sleight_computer__select_window', hooks: [{ type: 'command', timeout: 5,
        command: `node "${join(repo, 'bench/fowl/origin-hook.mjs')}"` }] }] } : {}) } } : arm.settings, env: { ...arm.env, ANTHROPIC_SMALL_FAST_MODEL: modelId(model) }, allowed: arm.allowed,
    ...(arm.chrome ? { chrome: arm.chrome } : {}),
    metadata: { ...arm.metadata, browser: realBrowser.browser, profile: realBrowser.profileName || realBrowser.profileRoot,
      profileMode: realBrowser.profileMode || 'fresh', ...(realBrowser.profileFolder ? { profileFolder: realBrowser.profileFolder } : {}),
      browserVersion: realBrowser.version ?? null, permissionMode: 'default', headless: false, focus: surface === 'sleight-turbo' ? 'host monitor' : 'not measured' } };
}
