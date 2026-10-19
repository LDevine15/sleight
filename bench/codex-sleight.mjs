// The sleight-in-Codex arms (LAWS, 2026-10-18): sleight's MCP server runs as Codex's plugin, from a Codex home of its own
// (~/.codex-bench-sleight) whose config.toml lists only sleight's servers. codex-sleight asks for gpt-6-luna and
// codex-sleight-sol for gpt-6.1-sol, both at effort high, on the same login as the codex arm. Other Codex arms drive the
// engine's own computer-use server from ~/.codex-bench (bench/codex-arm.mjs); this one never starts it.
//
// Approvals: `codex exec` has no hook and cannot answer an MCP form, and without a form capability sleight falls back to
// its native panel. The server therefore runs behind bench/codex-sleight-proxy.mjs, which answers sleight's approval forms
// from the benchmark's own allowlists (the race's origin-hook.mjs, the claim's approve.mjs) and nothing else. It cannot
// write the owner's preapproved.json (an "Always allow" needs a `remember` answer the proxy never gives), and
// SLEIGHT_APPROVAL_PROMPT=client means sleight cancels rather than open its panel if the proxy were missing.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEX_HOME } from './codex-arm.mjs';
import { CODEX_SLEIGHT_ARM_MODELS } from './fowl/support.mjs';

export const CODEX_SLEIGHT_HOME = process.env.CODEX_SLEIGHT_BENCH_HOME || join(homedir(), '.codex-bench-sleight');
const root = fileURLToPath(new URL('..', import.meta.url));
export const PROXY = join(root, 'bench/codex-sleight-proxy.mjs');
export const SLEIGHT_MCP = join(root, 'plugins/sleight/bin/sleight-mcp');
// What Codex hands a stdio server beyond the explicit env: the same short list the Claude-hosted arms get.
const HOST_ENV = ['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'TERM'];

// Codex names a server's tools mcp__<server>__<tool>. Claude's plugin server key has colons, so it maps to the
// underscored name its tools already carry in Claude Code (the skill text names mcp__plugin_sleight_computer__js).
export const codexServerKey = name => name.replace(/[^A-Za-z0-9_-]/g, '_');

export const tomlString = value => JSON.stringify(String(value)).replace(/\u007f/g, '\\u007f');
const tomlList = values => `[${values.map(tomlString).join(', ')}]`;

// Features that would put another computer-use or browser surface beside sleight in this home; the arm's model must see
// sleight's tools alone. (None of them is configured in a fresh home, so this only pins the defaults off.)
const FEATURES_OFF = ['apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'memories'];

export function codexSleightToml({ model, effort = 'high', servers = {}, comment }) {
  const out = [
    '# sleight inside Codex, benchmark arm (LAWS, 2026-10-18). Written by bench/codex-sleight.mjs for one run; not the owner\'s config.',
    ...(comment ? [`# ${comment}`] : []),
    `model = ${tomlString(model)}`, `model_reasoning_effort = ${tomlString(effort)}`,
    'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"', '',
    '[features]', ...FEATURES_OFF.map(name => `${name} = false`), '',
  ];
  for (const [key, server] of Object.entries(servers)) {
    out.push(`[mcp_servers.${key}]`, `command = ${tomlString(server.command)}`, `args = ${tomlList(server.args ?? [])}`,
      'startup_timeout_sec = 120', 'tool_timeout_sec = 300',
      // Codex's own tool gate stays out of the way; sleight's approvals are the proxy's.
      'default_tools_approval_mode = "approve"',
      ...(server.enabledTools?.length ? [`enabled_tools = ${tomlList(server.enabledTools)}`] : []),
      `env_vars = ${tomlList(HOST_ENV)}`, '', `[mcp_servers.${key}.env]`,
      ...Object.entries(server.env ?? {}).map(([name, value]) => `${name} = ${tomlString(value)}`), '');
  }
  return out.join('\n');
}

// A Claude-shaped arm (the mcpServers and allowedTools the sleight / sleight-turbo arms build) as Codex servers. The
// sleight server goes behind the proxy; any other server (the turbo bench server) is started as it is.
export function codexSleightServers({ mcpServers, allowed, dir, policy, gateWindow = false, turboBrowser, extraEnv = {}, node = process.execPath, proxy = PROXY }) {
  const tools = String(allowed).split(',').filter(Boolean);
  const servers = {};
  for (const [name, spec] of Object.entries(mcpServers)) {
    const key = codexServerKey(name), prefix = `mcp__${key}__`;
    const enabledTools = tools.filter(tool => tool.startsWith(prefix)).map(tool => tool.slice(prefix.length));
    if (name === 'plugin:sleight:computer') {
      servers[key] = { command: node, enabledTools,
        args: [proxy, '--policy', policy, '--log', join(dir, 'approvals.jsonl'), ...(gateWindow ? ['--gate-window'] : []),
          ...(turboBrowser ? ['--turbo-guard', turboBrowser] : []), '--', spec.command, ...(spec.args ?? [])],
        // Codex passes a server only env_vars and this env, so the ghost hand's off switch goes here; an arm can set it on.
        env: { SLEIGHT_HAND: '0', ...spec.env, ...extraEnv, SLEIGHT_APPROVAL_PROMPT: 'client' } };
    } else servers[key] = { command: spec.command, args: spec.args ?? [], env: spec.env ?? {}, enabledTools };
  }
  return servers;
}

// What the proxy decided for one run (its approvals.jsonl): counts, and every declined or refused prompt by text, so a prompt
// outside the allowlist shows in the run's record as it does in the Claude arms' declined-prompts log.
const LOG_FIELDS = ['t', 'kind', 'action', 'message', 'tool'];
export function approvalSummary(file, { log = false } = {}) {
  const entries = [];
  try { for (const line of readFileSync(file, 'utf8').split('\n')) if (line) try { entries.push(JSON.parse(line)); } catch { /* a cut line */ } } catch { /* no log: no prompt was asked */ }
  const asked = entries.filter(entry => entry.kind === 'elicitation');
  return { accepted: asked.filter(entry => entry.action === 'accept').length,
    declined: asked.filter(entry => entry.action !== 'accept').map(entry => entry.message),
    toolsRefused: entries.filter(entry => entry.kind === 'tool-refused').map(entry => entry.tool),
    // With log, the decisions themselves go into the run's row (the run folder is temporary): prompt text, never a hook's reason.
    ...(log && { log: entries.map(entry => Object.fromEntries(Object.entries(entry).filter(([key]) => LOG_FIELDS.includes(key)))) }) };
}

// A sleight-in-Codex home is never the owner's ~/.codex or the codex arm's engine-only ~/.codex-bench.
// Paths compare after symlinks resolve (through the parent when the folder doesn't exist yet), and without case on macOS.
const canonical = path => {
  let out = resolve(path);
  try { out = realpathSync(out); } catch { try { out = join(realpathSync(dirname(out)), basename(out)); } catch { /* neither exists yet */ } }
  return process.platform === 'darwin' ? out.toLowerCase() : out;
};
export function assertArmHome(home) {
  const target = canonical(home);
  for (const [other, name] of [[join(homedir(), '.codex'), "the owner's Codex home"], [CODEX_HOME, "the codex arm's home"]])
    if (target === canonical(other)) throw Error(`the sleight-in-Codex home ${home} is ${name}; set CODEX_SLEIGHT_BENCH_HOME to a folder of its own`);
  return resolve(home);
}

// After a run's config is written: the home must list exactly the servers that run planned, so nothing else reaches the model.
export function assertOnlyServers(found, planned) {
  if (found.length !== planned.length || found.some((name, i) => name !== planned[i]))
    throw Error(`the sleight-in-Codex home configures ${found.join(', ') || 'no servers'}, not only ${planned.join(', ')}`);
}

// The world and claim runner's version of the same arm: sleight's local tools behind the proxy with the claim's approve.mjs
// policy, and the env the Claude-hosted sleight arm's server gets from bench/run.mjs (armEnv) for the same pass.
const LOCAL_TOOLS = ['js', 'js_reset', 'drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'open_file'];
export function codexSleightRunConfig({ model, effort = 'high', dir, suite, worldTasks = [], ownerPresent = false, surfaces, trace, repo = root, home = CODEX_SLEIGHT_HOME, node = process.execPath, hostEnv = process.env }) {
  const env = { ...(hostEnv.SLEIGHT_RS === '0' || hostEnv.SLEIGHT_RS === '1' ? { SLEIGHT_RS: hostEnv.SLEIGHT_RS } : {}), BENCH_ROOT: repo, BENCH_SUITE: suite, ...(ownerPresent ? { BENCH_OWNER_PRESENT: '1' } : {}),
    ...(suite === 'world' ? { BENCH_WORLD_TASKS: JSON.stringify(worldTasks) } : {}),
    ...(surfaces ? { SLEIGHT_SURFACES: surfaces } : {}), ...(trace ? { SLEIGHT_TRACE: trace } : {}) };
  const servers = codexSleightServers({ node, dir, policy: 'bench',
    mcpServers: { 'plugin:sleight:computer': { command: join(repo, 'plugins/sleight/bin/sleight-mcp'), env } },
    allowed: LOCAL_TOOLS.map(tool => `mcp__plugin_sleight_computer__${tool}`).join(',') });
  return { home, servers: Object.keys(servers), toml: codexSleightToml({ model, effort, servers, comment: `${suite} suite` }) };
}

// The home's one-time setup: a private folder, the login copied from the codex arm's home (never changed there), and
// a config with no servers so `codex login` and `codex mcp list` work. Idempotent. Returns what it did, or why it cannot.
export function ensureCodexSleightHome({ home = CODEX_SLEIGHT_HOME, loginHome = CODEX_HOME } = {}) {
  const did = [];
  try { assertArmHome(home); } catch (error) { return { ok: false, home, did, problem: error.message }; }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const auth = join(home, 'auth.json');
  if (!existsSync(auth)) {
    const source = join(loginHome, 'auth.json');
    if (!existsSync(source)) return { ok: false, home, did, problem: `no Codex login in ${loginHome} to copy: run CODEX_HOME=${home} codex login` };
    copyFileSync(source, auth); chmodSync(auth, 0o600); did.push(`login copied from ${loginHome}`);
  }
  const config = join(home, 'config.toml');
  if (!existsSync(config)) { writeFileSync(config, codexSleightToml({ model: 'gpt-6-luna', comment: 'no servers until a run writes them' }), { mode: 0o600 }); did.push('base config.toml'); }
  return { ok: true, home, did };
}

// Writes one run's config. Rounds run one at a time under the live lock, so the home holds one run's servers at a time.
// copyTo names a file in the run's folder that keeps the same text as evidence.
export function writeCodexSleightConfig(toml, home = CODEX_SLEIGHT_HOME, copyTo) {
  const file = join(assertArmHome(home), 'config.toml');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(file, toml, { mode: 0o600 });
  if (copyTo) writeFileSync(copyTo, toml, { mode: 0o600 });
  return file;
}

export const codexSleightModel = surface => {
  const model = CODEX_SLEIGHT_ARM_MODELS[surface];
  if (!model) throw Error(`Unknown sleight-in-Codex arm: ${surface}`);
  return model;
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] !== 'setup') { console.error('usage: node bench/codex-sleight.mjs setup'); process.exit(2); }
  const result = ensureCodexSleightHome();
  console.log(result.ok ? `${result.home}: ${result.did.length ? result.did.join('; ') : 'already set up'}` : result.problem);
  process.exitCode = result.ok ? 0 : 1;
}
