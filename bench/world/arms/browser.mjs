import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeArmPlan, chromeHooks } from './chrome.mjs';

export const BROWSER_SURFACES = ['playwright-mcp', 'chrome-devtools-mcp', 'claude-in-chrome', 'claude-cu'];
export const CLAUDE_VERSION = '2.1.289';
export const PINS = { 'playwright-mcp': '@playwright/mcp@0.0.83', 'chrome-devtools-mcp': 'chrome-devtools-mcp@1.10.1', 'claude-in-chrome': '1.0.100', 'claude-cu': 'unsupported' };
export const COMPUTER_USE_UNSUPPORTED = 'Claude computer use requires an interactive session and is not available with -p: https://code.claude.com/docs/en/computer-use';
export const defaultArmRoot = () => path.join(os.homedir(), '.config/sleight-bench/world/arms');
export const WORLD_SURFACES = ['sleight', 'fowl+sleight', 'fowlbrowser', 'codex', 'devtools', ...BROWSER_SURFACES];
export const WORLD_PROMPT_PREFIX = 'Complete the task using only this arm\'s computer-use tools. Open your own task pages. Follow the task\'s instructions for tabs left open.\n\n';

export function worldAgentSetup({ surface, dir, armRoot = defaultArmRoot(), hostEnv = process.env }) {
  if (!WORLD_SURFACES.includes(surface)) throw new Error(`${surface}: not a Claude Code world arm`);
  const arm = path.join(armRoot, surface);
  outsideGit(arm);
  outsideGit(dir);
  const env = Object.fromEntries(Object.entries(hostEnv).filter(([key]) => !key.startsWith('CLAUDE')));
  env.CLAUDE_CONFIG_DIR = path.join(arm, 'claude-config');
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.DISABLE_TELEMETRY = '1';
  env.ENABLE_TOOL_SEARCH = 'false';
  return { command: path.join(arm, 'node_modules/.bin/claude'), env,
    args: ['--setting-sources', '', '--disable-slash-commands'],
    settings: { claudeMdExcludes: ['**'], autoMemoryEnabled: false },
    metadata: { claudeVersion: CLAUDE_VERSION, versionVerified: false, configDir: env.CLAUDE_CONFIG_DIR, settingSources: '',
      instructions: 'claudeMdExcludes=**; managed policy cannot be excluded', autoMemory: false, toolLoading: 'eager' }, promptPrefix: WORLD_PROMPT_PREFIX };
}

export function outsideGit(dir) {
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) current = path.dirname(current);
  current = fs.realpathSync(current);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) throw new Error(`Benchmark arm folders must be outside any git repository: ${dir}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function browserArmSetup({ surface, task, dir, remote, armRoot = defaultArmRoot(), hostEnv = process.env, chromeFiles }) {
  if (!BROWSER_SURFACES.includes(surface)) throw new Error(`Unknown browser arm: ${surface}`);
  if (surface === 'claude-cu') throw new Error(COMPUTER_USE_UNSUPPORTED);
  if (remote) throw new Error(`${surface}: remote browser setup is not supported`);
  if (!['chrome', 'helium'].includes(task.browser)) throw new Error(`${surface}: unknown browser ${task.browser}`);
  const arm = path.join(armRoot, surface);
  outsideGit(arm);
  outsideGit(dir);
  const bin = path.join(arm, 'node_modules/.bin');
  const world = worldAgentSetup({ surface, dir, armRoot, hostEnv });
  const env = world.env;
  const args = [...world.args, '--tools', 'ToolSearch'];
  if (surface === 'claude-in-chrome') {
    if (hostEnv.ANTHROPIC_API_KEY || hostEnv.ANTHROPIC_AUTH_TOKEN) throw new Error('Claude in Chrome: API-key or setup-token authentication is not supported; use an isolated direct-plan login, never a fallback arm');
    if (task.browser !== 'chrome') throw new Error('Claude in Chrome: select Chrome in the isolated account before the run; other browser routing is not supported');
    const chrome = chromeArmPlan(chromeFiles);
    const stateFile = path.join(dir, 'chrome-device.json');
    return { command: path.join(bin, 'claude'), env: { ...env, ENABLE_TOOL_SEARCH: 'false' }, args: [...args, '--chrome'], mcpServers: {}, allowed: 'mcp__claude-in-chrome',
      chrome, stateFile, metadata: { ...world.metadata, chrome: { deviceId: chrome.deviceId, profileFolder: chrome.profileFolder, confirmed: false } },
      settings: { ...world.settings, hooks: chromeHooks(stateFile, chrome.deviceId) }, promptPrefix: WORLD_PROMPT_PREFIX,
      setupPrefix: `Make your first tool call select_browser with device ID ${chrome.deviceId}, using the tool's device-ID argument. Wait for its result. If it does not confirm that device is in use, retry select_browser or list_connected_browsers for up to 10 seconds until that exact device has inUse true. Task tools must wait for confirmation. Stop when the gate refuses or another browser is in use.\n\n` };
  }
  const executable = task.browser === 'helium' ? '/Applications/Helium.app/Contents/MacOS/Helium' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browserArgs = ['--executable-path', executable, '--user-data-dir', path.join(dir, 'browser-profile')];
  const server = surface === 'playwright-mcp'
    ? { command: path.join(bin, 'playwright-mcp'), args: ['--browser', 'chrome', ...browserArgs, '--output-dir', path.join(dir, 'artifacts')] }
    : { command: path.join(bin, 'chrome-devtools-mcp'), args: [...browserArgs, '--no-usage-statistics', '--no-performance-crux'],
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' } };
  return { command: path.join(bin, 'claude'), env, args: [...args, '--no-chrome'], mcpServers: { [surface]: server }, allowed: `mcp__${surface}`,
    metadata: world.metadata, settings: world.settings, promptPrefix: WORLD_PROMPT_PREFIX };
}

export function setupPlan(surface, target, pin, claudePin) {
  if (!WORLD_SURFACES.includes(surface) || pin !== (PINS[surface] || 'claude-only') || claudePin !== `@anthropic-ai/claude-code@${CLAUDE_VERSION}`) throw new Error(`Unexpected package pin for ${surface}`);
  target = path.resolve(target);
  outsideGit(target);
  if (path.basename(target) !== surface) throw new Error(`The arm folder must be named ${surface}`);
  if (surface === 'claude-cu') return { surface, supported: false, reason: COMPUTER_USE_UNSUPPORTED, install: null };
  const packages = [claudePin, ...(pin === 'claude-only' || surface === 'claude-in-chrome' ? [] : [pin])];
  const plan = { surface, supported: true, target, install: { command: 'npm', args: ['install', '--prefix', target, '--cache', path.join(target, 'npm-cache'),
    '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...packages] },
    claudeInstaller: { command: process.execPath, args: [path.join(target, 'node_modules/@anthropic-ai/claude-code/install.cjs')] },
    versionCheck: { command: path.join(target, 'node_modules/.bin/claude'), args: ['--version'], expected: CLAUDE_VERSION },
    configDir: path.join(target, 'claude-config'), permissions: [] };
  if (surface === 'claude-in-chrome') {
    plan.extension = { id: 'fcoeoabgfenejglbffodgkkbkcdhcgfn', version: pin,
      url: 'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn' };
    plan.permissions = ['Owner: install and verify Claude in Chrome extension 1.0.100 in the benchmark Chrome profile; grant local benchmark site access.',
      'Owner: log in to a direct Anthropic plan using this arm\'s CLAUDE_CONFIG_DIR. API keys and setup-token credentials cannot enable --chrome.',
      'First --chrome use writes a browser native-messaging manifest under ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/. Sleight-arch coordinates this with the owner.'];
  }
  return plan;
}
