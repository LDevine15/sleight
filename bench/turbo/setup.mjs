import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { browserTools } from '../../plugins/sleight/lib/direct-browser/tools.mjs';
import { worldAgentSetup } from '../world/arms/browser.mjs';

export const SURFACE = 'sleight-turbo';
export const MEASUREMENT = 'v3 tools and worker boundary plus engine companion; V10 runtime join excluded';
export function fixturePolicy(origins) {
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => {
    try { const u = new URL(origin); return u.origin !== origin || u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' || !u.port || u.username || u.password; } catch { return true; }
  })) throw Error('Runner fixture origins required');
  const allowed = new Set(origins);
  return url => {
    try { const u = new URL(url); return u.protocol === 'http:' && !u.username && !u.password && allowed.has(u.origin); }
    catch { return false; }
  };
}
export function fixtureOrigins(task) {
  const urls = [...String(task.prompt).matchAll(/https?:\/\/[^\s"'<>),]+/g)].map(match => match[0]);
  if (task.grade) urls.push(task.grade);
  if (task.site?.log) urls.push(task.site.log);
  return [...new Set(urls.flatMap(value => {
    try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === '127.0.0.1' &&
      u.port && !u.username && !u.password ? [u.origin] : []; } catch { return []; }
  }))];
}
export function turboSetup({ task, repo, dir, prompt, env = process.env }) {
  const origins = fixtureOrigins(task); if (origins.length) fixturePolicy(origins);
  // Like the installed surface, the arm shows an opaque browser id, never the task's browser name.
  const browser = 'bbench';
  // Keep setup synchronous for the pinned runner's require(). launch.mjs has
  // top-level await, so read its same skill body without importing the launcher.
  const rules = readFileSync(new URL('../../plugins/sleight/skills/drive-mac-apps/'
    + (env.SLEIGHT_PROMPT === 'lean' ? 'SKILL.lean.md' : 'SKILL.md'), import.meta.url), 'utf8')
    .replace(/^---\n[\s\S]*?\n---\n+/, '').trim();
  const section = /## Browsers\n[\s\S]*?(?=\n## |$)/;
  const browserRules = readFileSync(new URL('../../plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md', import.meta.url), 'utf8')
    .trimEnd().replace('{browser}', browser);
  if (!section.test(rules)) throw Error('Installed browser skill is missing');
  const installed = rules.replace(section, browserRules + '\n');
  const common = worldAgentSetup({ surface: 'fowlbrowser', dir, hostEnv: env });
  const configDir = join(dirname(dirname(common.env.CLAUDE_CONFIG_DIR)), SURFACE, 'claude-config');
  const guard = { matcher: 'mcp__plugin_sleight_computer__js', hooks: [{ type: 'command', timeout: 5,
    command: `node "${join(repo, 'bench/turbo/engine-browser-guard.mjs')}" ${browser}` }] };
  return { command: common.command, args: common.args, settings: { ...common.settings, hooks: { PreToolUse: [guard] } },
    mcpServers: { 'plugin:sleight:computer': { command: join(repo, 'plugins/sleight/bin/sleight-mcp'),
      env: { SLEIGHT_SURFACES: 'browser,computer', SLEIGHT_SKILL: 'none' } },
      'sleight-turbo': { command: process.execPath, args: [join(repo, 'bench/turbo/v3-server.mjs')],
      env: { SLEIGHT_TURBO_ORIGINS: JSON.stringify(origins), SLEIGHT_TURBO_TASK: prompt, SLEIGHT_TURBO_METRICS: join(dir, 'turbo-metrics.jsonl') } } },
    allowed: [...browserTools(browser).map(tool => 'mcp__sleight-turbo__' + tool.name),
      'mcp__plugin_sleight_computer__js', 'mcp__plugin_sleight_computer__js_reset', 'mcp__plugin_sleight_computer__open_file'].join(','),
    promptPrefix: installed + '\n\n',
    env: { ...common.env, CLAUDE_CONFIG_DIR: configDir },
    metadata: { ...common.metadata, configDir, surface: SURFACE, measurement: MEASUREMENT,
      path: 'model-selected', turboVersion: 3, runtime: 'V10 join required', playwright: '1.64.0', profile: 'owned-temporary', headless: true,
      safety: 'turbo fixture-only; engine approvals and guards; engine browser calls refused by a bench hook', focus: 'host monitor' } };
}
