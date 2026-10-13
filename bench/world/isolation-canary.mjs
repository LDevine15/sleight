import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOwned } from '../preapproved-process.mjs';
import { genericSettings } from '../plugin-arm.mjs';
import { readKey } from '../api-auth.mjs';
import { worldArm, worldCLI, worldSettings, assertWorldCLI, worldSetupPlan } from './native-world.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function canaryPlan({ arm = 'sleight', armHome = join(homedir(), 'Library/Caches/sleight-bench'), home = homedir(),
  root, marker, mode = 'isolated', model = 'claude-haiku-5-5', effort = 'high' } = {}) {
  if (!/^(?:sleight|lcu|cua|peekaboo|mcp:[a-z0-9_-]+)$/.test(arm)) throw new Error('canary requires a local Claude arm');
  if (!/^SLEIGHT_[A-Z0-9_]{8,100}$/.test(marker ?? '')) throw new Error('pass --marker SLEIGHT_<unique uppercase marker>');
  if (!['control', 'glob', 'isolated'].includes(mode)) throw new Error('mode must be control, glob or isolated');
  home = resolve(home); armHome = resolve(armHome);
  const label = arm.replaceAll(':', '-');
  root = resolve(root ?? join(home, `sleight-isolation-canary-${label}`));
  if (dirname(root) !== home || !/^sleight-isolation-canary-[a-z0-9_-]+$/.test(basename(root))) throw new Error('canary root must be its own named folder directly under home');
  worldSetupPlan(root);
  const cwd = join(root, 'work'), canaryFile = join(cwd, '.claude/CLAUDE.md');
  const armDir = join(armHome, ['cua', 'peekaboo'].includes(arm) ? `mcp-${arm}-arm` : arm.startsWith('mcp:') ? `mcp-${arm.slice(4)}-arm` : `${arm}-arm`);
  const server = arm === 'sleight' ? 'plugin:sleight:computer' : arm.replace(/^mcp:/, '');
  const prepared = worldArm({ cwd: armDir, args: [], env: {}, servers: [server] }, arm);
  const receipt = randomBytes(12).toString('hex');
  const settings = join(root, 'arm-settings.json');
  const prompt = `Report local instruction-file text supplied to this session, without using tools or revealing provider system prompts or credentials. ` +
    `Return only JSON with instructions (a string, or null if none) and receipt exactly "${receipt}".`;
  return { arm, armHome, home, root, cwd, canaryFile, marker, mode, model, effort, receipt, settings,
    settingsTemplate: worldSettings(genericSettings(prepared, fileURLToPath(new URL('../../', import.meta.url)))),
    armSettings: join(armDir, 'bench-settings.json'), keyFile: join(home, '.config/sleight-bench/anthropic-api-key'),
    fixtureText: `Local instruction marker: ${marker}\n`,
    command: worldCLI(armHome), env: { ...prepared.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    args: ['-p', prompt, '--model', model, '--effort', effort, '--max-turns', '1', '--output-format', 'json', '--strict-mcp-config',
      '--mcp-config', join(root, 'empty-mcp.json'), '--settings', settings, '--setting-sources', '', '--tools', '', '--no-chrome',
      '--disable-slash-commands', '--no-session-persistence', '--permission-prompts', 'none'],
  };
}

function regular(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error('canary paths must not be symlinks');
  return info;
}
function writePrivate(path, value) {
  if (existsSync(path) && !regular(path).isFile()) throw new Error('canary output must be a regular file');
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function ancestorExclusions(cwd, canaryFile) {
  const paths = [];
  for (let dir = cwd;; dir = dirname(dir)) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) {
      const path = join(dir, name); if (path !== canaryFile) paths.push(path);
    }
    if (dirname(dir) === dir) break;
  }
  return paths;
}

export async function runCanary(plan, { dryRun = false, run = runOwned, verify = assertWorldCLI, signal, env = process.env } = {}) {
  if (dryRun) return { dryRun: true, plan };
  worldSetupPlan(plan.root);
  for (let path = plan.env.CLAUDE_CONFIG_DIR; path === plan.armHome || path.startsWith(plan.armHome + '/'); path = dirname(path)) {
    if (existsSync(path) && !regular(path).isDirectory()) throw new Error('arm profile must be a directory');
    if (path === plan.armHome) break;
  }
  for (const path of [plan.root, plan.cwd, dirname(plan.canaryFile)]) if (!regular(path).isDirectory()) throw new Error('prepare the canary fixture directories first');
  const info = regular(plan.canaryFile);
  if (!info.isFile() || info.size > 16384) throw new Error('canary instruction file must be a small regular file');
  const fixture = readFileSync(plan.canaryFile, 'utf8');
  if (!fixture.includes(plan.marker)) throw new Error('the fixture does not contain the expected marker');
  const settings = plan.settingsTemplate;
  if (settings.autoMemoryEnabled !== false || settings.pluginConfigs?.['cc-plugin-agents-md@builtin']?.options?.instructionFiles !== 'managed-only' ||
    !Array.isArray(settings.claudeMdExcludes)) throw new Error('canary requires world arm instruction settings');
  const version = verify(plan.command);
  const binding = hash(JSON.stringify([hash(fixture), hash(JSON.stringify(settings)), version, plan.command, plan.arm, plan.model, plan.effort]));
  const controlFile = join(plan.root, 'control-receipt.json');
  if (plan.mode !== 'control') {
    let control;
    try { if (regular(controlFile).isFile()) control = JSON.parse(readFileSync(controlFile, 'utf8')); } catch {}
    if (!control?.passed || !control.markerSeen || control.binding !== binding) return { passed: false, reason: 'run a matching positive control first' };
  }
  writePrivate(plan.settings, settings);
  const args = [...plan.args];
  if (plan.mode !== 'isolated') {
    const configured = JSON.parse(JSON.stringify(settings));
    configured.pluginConfigs['cc-plugin-agents-md@builtin'].options.instructionFiles = 'claude-md';
    configured.claudeMdExcludes = [...ancestorExclusions(plan.cwd, plan.canaryFile), ...(plan.mode === 'glob' ? ['**'] : [])];
    const path = join(plan.root, `${plan.mode}-settings.json`);
    writePrivate(path, configured); args[args.indexOf('--settings') + 1] = path;
  }
  writePrivate(join(plan.root, 'empty-mcp.json'), { mcpServers: {} });
  const key = readKey(plan.keyFile);
  if (!key) throw new Error('canary requires the private benchmark API key file');
  const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
  const response = await run(plan.command, args, { cwd: plan.cwd,
    env: { ...inherited, ...plan.env, ANTHROPIC_API_KEY: key }, timeoutMs: 60000, signal });
  let output, answer;
  try { output = JSON.parse(response.stdout); answer = JSON.parse(output.result); } catch {}
  const protocol = response.groupClean === true && response.exit?.code === 0 && !response.timedOut && !response.cancelled &&
    !output?.is_error && output?.num_turns === 1 && answer?.receipt === plan.receipt &&
    (answer.instructions === null || typeof answer.instructions === 'string');
  const markerSeen = protocol && Boolean(answer.instructions?.includes(plan.marker));
  const result = { arm: plan.arm, mode: plan.mode, binding, claudeVersion: version, markerSeen, calls: 1,
    passed: Boolean(protocol && (plan.mode === 'control' ? markerSeen : !markerSeen)),
    ...(!protocol && { reason: 'canary reply or process protocol was invalid' }) };
  writePrivate(plan.mode === 'control' ? controlFile : join(plan.root, `${plan.mode}-receipt.json`), result);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = {}, argv = process.argv.slice(2);
    let live = false, dryRun = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--run') live = true;
      else if (argv[i] === '--dry-run') dryRun = true;
      else if (['--arm', '--arm-home', '--root', '--marker', '--mode', '--model', '--effort'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        const key = argv[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); values[key] = argv[++i];
      } else throw new Error('unknown or incomplete canary option');
    }
    if (live && dryRun) throw new Error('choose --run or --dry-run');
    const plan = canaryPlan(values);
    if (!live) console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    else {
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
      const result = await runCanary(plan, { signal: controller.signal });
      console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
