import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareNativeArm } from '../world/native-arms.mjs';
import { worldAgentSetup } from '../world/arms/browser.mjs';
import { genericSettings } from '../plugin-arm.mjs';
import { mergeArmHooks } from '../arm-hooks.mjs';

export const NATIVE_SURFACES = ['lcu', 'cua', 'peekaboo'];
export function windowPrompt(browser) {
  if (!browser?.marker || !browser.profileRoot || !['chrome', 'helium'].includes(browser.browser)) throw Error('Isolated real browser required');
  return `Use only the dedicated ${browser.browser === 'chrome' ? 'Chrome' : 'Helium'} window initially titled "${browser.marker}"` +
    `${browser.pid ? `, browser PID ${browser.pid}` : ''}, profile ${browser.profileRoot}. Identify that window before acting, keep task pages in it, and never use any other browser window or profile. If it cannot be identified, stop. User activity still ends the input lease.\n\n`;
}
export function nativeBrowserSetup({ surface, repo, dir, realBrowser, dryRun = false,
  armHome = join(homedir(), 'Library/Caches/sleight-bench'), env = process.env }) {
  if (!NATIVE_SURFACES.includes(surface)) throw Error('Unknown native browser arm');
  const common = worldAgentSetup({ surface: 'fowlbrowser', dir, hostEnv: env });
  common.env.BENCH_SUITE = 'world';
  common.env.BENCH_ARM_SERVERS = JSON.stringify([surface]);
  let mcp, settings, identity;
  if (surface === 'lcu') {
    const cwd = join(armHome, 'lcu-arm');
    mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    if (JSON.stringify(Object.keys(mcp.mcpServers || {})) !== '["lcu"]') throw Error('LCU arm must contain only lcu');
    settings = mergeArmHooks(genericSettings({ servers: ['lcu'] }, repo), join(cwd, '.claude/settings.local.json'));
    common.env.PATH = `${join(repo, '.dev/py')}:${common.env.PATH ?? ''}`;
    common.env.CLAUDE_CONFIG_DIR = join(cwd, 'claude');
    identity = { kind: 'lcu', config: join(cwd, '.mcp.json'), ownHooks: join(cwd, '.claude/settings.local.json') };
  } else {
    const arm = prepareNativeArm(surface, { root: repo, armHome, env: common.env, dryRun });
    mcp = dryRun ? arm.mcp : JSON.parse(readFileSync(join(arm.cwd, 'mcp.json'), 'utf8'));
    settings = genericSettings({ servers: [surface] }, repo);
    Object.assign(common.env, arm.env);
    identity = arm.identity;
  }
  return { ...common, mcpServers: mcp.mcpServers, allowed: surface === 'lcu' ? 'mcp__lcu__js' : `mcp__${surface}`,
    args: [...common.args, '--no-chrome', '--no-session-persistence'], settings: { ...common.settings, ...settings },
    promptPrefix: common.promptPrefix + windowPrompt(realBrowser),
    metadata: { ...common.metadata, surface, identity, configDir: common.env.CLAUDE_CONFIG_DIR,
      browser: realBrowser.browser, profile: realBrowser.profileRoot, headless: false, focus: 'not measured' } };
}
