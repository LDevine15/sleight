#!/usr/bin/env node
// Release orchestration only. Existing runners own their live lock and cleanup.
// Default vectors: sleight-arch's RP2 handoff, 2026-10-14 22:41 UTC.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEY_FILE, LEDGER_FILE, readKey } from './api-auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDS = ['native', 'gate-normal', 'gate-swap', 'opus', 'claim'];
const HAIKU = 'claude-haiku-5-5', OPUS = 'claude-opus-5-5';
const CODEX = 'gpt-6-luna';
// Every Claude arm runs on the owner's account login, never API credits (owner, 2026-10-15, LAWS).
const NATIVE_ARGS = ['--arm', 'sleight,codex', '--runs', '3', '--owner-away', '--auth', 'login'];
const DROPPED = ['codex-cu', 'devtools'].map(arm => ({ arm, status: 'not run', reason: 'bridge code not in the repo (owner decision, 2026-10-14)' }));
const kind = id => IDS.includes(id) ? id : /^gate-(normal|swap)-r[12]-(sleight-turbo|fowlbrowser)$/.exec(id)?.[1]
  ? id.startsWith('gate-normal') ? 'gate-normal' : 'gate-swap'
  : /^opus-(normal|swap)-r1-(sleight-turbo|fowlbrowser)$/.test(id) ? 'opus' : undefined;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ownerAliases(home, names) {
  const patterns = [...names, basename(home)].filter(Boolean).flatMap(name =>
    ['NFC', 'NFD'].map(form => name.normalize(form).split(/[\s._-]+/u).filter(Boolean).map(escape).join('[\\s._-]*')));
  const aliases = [...new Set(patterns.filter(Boolean))].sort((a, b) => b.length - a.length);
  return aliases.length ? new RegExp(`<user>|(?<![\\p{L}\\p{M}])(?:${aliases.join('|')})(?![\\p{L}\\p{M}])`, 'giu') : undefined;
}
export function scrubText(text, home = homedir(), names = []) {
  text = String(text).replace(new RegExp(escape(home), 'giu'), '~');
  const aliases = ownerAliases(home, names);
  if (aliases) text = text.replace(aliases, '<user>');
  // Logs can contain another spelling of a home or credentials from a failed runner.
  return text.replace(/\/(?:Users|home)\/[^/\s"\\]+/g, '~')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/((?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)["']?\s*[:=]\s*["']?)[^\s"',}]+/g, '$1<redacted>');
}

function option(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function problems(stage, conditions) {
  const issues = [];
  const group = kind(stage.id);
  if (!stage.args) issues.push(stage.blockedReason ?? 'sleight-arch must supply exact runner arguments and artifact roots');
  if (conditions.liveLock !== false) issues.push('live lock held or unreadable');
  if (conditions.hold !== false) issues.push('hold file present or unreadable');
  if (conditions.ownerAway !== true) issues.push('owner-away window not confirmed');
  if (conditions.loginReady !== true) issues.push('isolated login not verified');
  if (stage.id !== 'native' && conditions.extensionsReady !== true) issues.push('extension sockets and connection not verified');
  if (stage.id.startsWith('gate') || group === 'opus') {
    if (conditions.productionTurboReady !== true) issues.push('production turbo not qualified; prototype cannot be the release gate');
  }
  if (stage.id === 'claim' && conditions.loginReady !== true) issues.push('claim login arms not verified');
  if (stage.id === 'native' && option(stage.args ?? [], '--arm')?.includes('codex') && conditions.loginReady !== true) issues.push('Codex benchmark login not verified');
  return issues;
}

function validateStage(stage) {
  const group = kind(stage.id);
  if (!group) throw new Error('Unknown release stage');
  if (!['native', 'fowl'].includes(stage.runner)) throw new Error('Use an existing native or fowl runner');
  if (!Array.isArray(stage.args) || stage.args.some(arg => typeof arg !== 'string' || /\0|\n/.test(arg))) throw new Error('Runner arguments must be strings');
  const args = stage.args;
  const model = group === 'opus' ? OPUS : HAIKU;
  const approvedNative = stage.id === 'native' && JSON.stringify(args) === JSON.stringify(NATIVE_ARGS);
  if (!approvedNative && (args.filter(arg => arg === '--model').length !== 1 || ![model, ...(stage.runner === 'fowl' ? [group === 'opus' ? 'opus' : 'haiku'] : [])].includes(option(args, '--model')))) throw new Error('Pin the stage model id');
  if (!approvedNative && (args.filter(arg => arg === '--effort').length !== 1 || option(args, '--effort') !== 'high')) throw new Error('Pin the stage effort');
  if (args.some(arg => ['--plan', '--dry-run', '--setup-only', '--owner-present', '--remote', '--remote-held'].includes(arg))) throw new Error('Release stages must use local live runners');
  if (!approvedNative && stage.runner === 'native' && (option(args, '--auth') !== 'login' || !args.includes('--owner-away'))) throw new Error('Native stages require explicit funding and --owner-away');
  if (stage.id === 'native' && (stage.runner !== 'native' || !approvedNative && (option(args, '--suite') !== 'default' || option(args, '--arm') !== 'sleight'))) throw new Error('Native release suite uses sleight default');
  if (stage.id === 'claim' && stage.runner === 'native' && option(args, '--suite') !== 'world') throw new Error('Claim requires world suite');
  if (stage.id.startsWith('gate') && stage.runner !== 'fowl') throw new Error('Gate uses the Fowl runner');
  if (group === 'opus' && stage.runner !== 'fowl') throw new Error('Opus head-to-head uses the Fowl runner');
  if (group === 'gate-swap' && !args.includes('--swap') || group === 'gate-normal' && args.includes('--swap')) throw new Error('Gate order does not match stage');
  if (stage.runner === 'fowl' && (!args.includes('--out') || !option(args, '--out'))) throw new Error('Fowl stages require --out');
  if (stage.runner === 'fowl' && !args.includes('--world')) throw new Error('Fowl stages require isolated --world arms and their verified login');
  if (!Array.isArray(stage.artifacts) || !stage.artifacts.length || stage.artifacts.some(p => typeof p !== 'string' || !p)) throw new Error('List every result and event artifact root');
  if (!Array.isArray(stage.expectedModels) || !stage.expectedModels.includes(model) || stage.expectedModels.some(m => typeof m !== 'string')) throw new Error('List exact expected event models');
  if (approvedNative && !stage.expectedModels.includes(CODEX)) throw new Error('Native comparison must verify the Codex model too');
}

function defaults({ home, scratch, date }) {
  const stages = [{ id: 'native', runner: 'native', args: [...NATIVE_ARGS], artifacts: ['bench/results', join(scratch, 'sleight-bench'),
    join(home, 'Library/Caches/sleight-bench/claude-config/projects'), join(home, '.codex-bench/sessions')], expectedModels: [HAIKU, CODEX] }];
  for (const model of ['haiku', 'opus']) for (let round = 1; round <= (model === 'haiku' ? 2 : 1); round++) {
    for (const surface of ['sleight-turbo', 'fowlbrowser']) for (const order of ['normal', 'swap']) {
      const id = `${model === 'haiku' ? 'gate' : 'opus'}-${order}-r${round}-${surface}`;
      const out = join(scratch, `sleight-release-${date}`, id);
      stages.push({ id, runner: 'fowl', args: ['--surface', surface, '--world', '--tasks',
        join(home, 'Library/Caches/sleight-bench/fowlbrowser/tools/agents/codex-h2h.json'), '--serve', 'node test/demo/server.mjs --all',
        '--model', model, '--effort', 'high', '--out', out, ...(order === 'swap' ? ['--swap'] : [])], artifacts: [out], expectedModels: [model === 'haiku' ? HAIKU : OPUS] });
    }
  }
  stages.push({ id: 'claim', runner: 'native', blockedReason: 'waiting on CS3: exact full-matrix vectors are not supplied' });
  return stages;
}
export function createPlan({ root = ROOT, stages, conditions = {}, home = homedir(), scratch = tmpdir(), date = new Date().toISOString().slice(0, 10) } = {}) {
  const supplied = stages ?? defaults({ home, scratch, date });
  if (!supplied.length || new Set(supplied.map(s => s.id)).size !== supplied.length) throw new Error('Select unique release stages');
  return { root, stages: supplied.map(stage => {
    if (!kind(stage.id)) throw new Error('Unknown release stage');
    if (stage.args) validateStage(stage);
    const issues = problems(stage, conditions);
    return { ...stage, command: stage.args ? (stage.runner === 'native' ? 'node' : 'sh') : undefined,
      commandArgs: stage.args ? [stage.runner === 'native' ? 'bench/run.mjs' : 'bench/fowl/rounds.sh', ...stage.args] : undefined,
      issues, ready: issues.length === 0 };
  }), coverage: DROPPED };
}

// A fresh operator receipt records live login/connection checks without storing credentials.
// File and socket existence alone never prove a working login or extension connection.
export function inspectConditions({ ownerAway = false, receipt, keyFile = KEY_FILE, ledgerFile = LEDGER_FILE, now = new Date() } = {}) {
  const fresh = receipt && typeof receipt.expiresAt === 'string' && Date.parse(receipt.expiresAt) > now.getTime() &&
    Date.parse(receipt.expiresAt) <= now.getTime() + 60 * 60 * 1000;
  let apiReady = false;
  try {
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    const month = now.toISOString().slice(0, 7);
    if (ledger && !Array.isArray(ledger) && typeof ledger.month === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(ledger.month) &&
        ledger.month <= month && Number.isFinite(ledger.usd) && ledger.usd >= 0) {
      const spent = ledger.month === month ? ledger.usd : 0;
      apiReady = !ledger.unpriced && spent < 190 && !!readKey(keyFile);
    }
  } catch {}
  let socketsReady = false;
  try { socketsReady = receipt?.sockets?.length > 0 && receipt.sockets.every(p => lstatSync(p).isSocket()); } catch {}
  return { liveLock: existsSync('/tmp/sleight-live.lock'), hold: existsSync('/tmp/sleight-hold'),
    ownerAway: ownerAway && fresh && receipt.ownerAway === true, apiReady,
    loginReady: !!fresh && receipt.loginVerified === true,
    extensionsReady: !!fresh && socketsReady && receipt.extensionsVerified === true,
    productionTurboReady: !!fresh && receipt.productionTurboVerified === true };
}

export function verifyModels(texts, expected) {
  const found = new Set();
  let malformed = false;
  for (const text of texts) for (const line of text.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { malformed = true; continue; }
    if (event.type === 'assistant' && typeof event.message?.model === 'string') found.add(event.message.model);
    if (event.type === 'turn_context' && typeof event.payload?.model === 'string') found.add(event.payload.model);
    if (event.type === 'result') for (const model of Object.keys(event.modelUsage ?? {})) found.add(model);
  }
  const models = [...found].sort();
  return { models, verified: !malformed && models.length > 0 && expected.every(m => found.has(m)) && models.every(m => expected.includes(m)), malformed };
}

function safePath(path) {
  if (process.platform === 'darwin') path = resolve(path).replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1');
  let cursor = resolve(path);
  for (;;) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Artifact or output path contains a symlink');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolve(path);
}
function inventory(root, paths) {
  const files = new Map();
  const visit = path => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('Artifact symlink refused');
    if (info.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (info.isFile()) files.set(path, `${info.size}:${info.mtimeMs}:${info.ino}`);
    else throw new Error('Artifact must be a regular file or directory');
  };
  for (const path of paths) {
    const full = safePath(resolve(root, path));
    if (existsSync(full)) visit(full);
  }
  return files;
}
function publicationPaths(folder, home, names) {
  const key = path => path.normalize('NFC').toLowerCase();
  const used = new Set(['command.txt', 'stdout.log', 'stderr.log'].map(name => key(join(folder, name))));
  const mapped = new Map();
  return (index, parts) => {
    let parent = folder;
    for (let i = 0; i < parts.length; i++) {
      const source = JSON.stringify([index, ...parts.slice(0, i + 1)]);
      if (mapped.has(source)) { parent = mapped.get(source); continue; }
      const name = scrubText(parts[i].normalize('NFC'), home, names);
      if (!name || name === '.' || name === '..' || name.includes(sep) || name.includes('\0')) throw new Error('Artifact destination escaped stage');
      const extension = i === parts.length - 1 ? extname(name) : '';
      const stem = extension ? name.slice(0, -extension.length) : name;
      let dest = join(parent, name);
      for (let n = 2; used.has(key(dest)); n++) dest = join(parent, stem + '-' + n + extension);
      used.add(key(dest)); mapped.set(source, dest); parent = dest;
    }
    return parent;
  };
}
function accountFunding(stage, root) {
  if (kind(stage.id) !== 'opus') return;
  for (const flag of ['--tasks', '--surface']) if (stage.args.filter(arg => arg === flag).length > 1)
    throw new Error('Opus account funding needs unambiguous task and surface choices');
  const surface = option(stage.args, '--surface') ?? 'fowlbrowser';
  let surfaces = [surface];
  if (stage.args.includes('--tasks')) {
    const path = option(stage.args, '--tasks');
    if (!path || path.startsWith('--')) throw new Error('Opus account funding needs a tasks file');
    const tasks = JSON.parse(readFileSync(safePath(resolve(root, path)), 'utf8'));
    if (!Array.isArray(tasks) || !tasks.length || tasks.some(task => !task || typeof task !== 'object' || Array.isArray(task)))
      throw new Error('Opus account funding needs a nonempty task list');
    surfaces = tasks.map(task => task.surface ?? surface);
  }
  if (surfaces.some(value => typeof value !== 'string' || !value || /[\s\0]/u.test(value)))
    throw new Error('Opus account funding needs valid surface names');
  // rounds.sh chooses the API key if any effective surface is browser-use,
  // even on Opus. Refuse that vector before the runner can read a credential.
  if (surfaces.includes('browser-use')) throw new Error('Opus must use the owner account; browser-use requires API funding');
}
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
function summary(rows) {
  const cell = text => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  return '# Release pass\n\nEvery selected stage and failure is retained. Missing event models leave a stage unqualified.\n\n' +
    '| Stage | Status | Exit | Passed/total | Event models | Evidence |\n| --- | --- | --- | --- | --- | --- |\n' +
    rows.map(row => `| ${row.id} | ${row.status} | ${row.code ?? 'not run'} | ${row.passed ?? 0}/${row.total ?? 0} | ${cell(row.models?.models.join(', ') || 'unverified')} | [files](${row.id}/) |`).join('\n') +
    '\n\n| Dropped arm | Coverage | Reason |\n| --- | --- | --- |\n' + DROPPED.map(row => `| ${row.arm} | ${row.status} | ${row.reason} |`).join('\n') + '\n';
}

// No shell, no environment inherited from a Claude session, no cleanup signaling.
// The child runner owns its process tree and live-lock receipt. Interrupt is forwarded.
export function runStage(stage, { root }) {
  const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  // No stage refreshes the hub, and nothing refreshes it after the pass either: the pass publishes its evidence under
  // docs/benchmarks/<date>-release-pass, which the hub doesn't read, so a refresh here would collect nothing new (bench/hub-refresh.mjs).
  env.SLEIGHT_NO_HUB = '1';
  return new Promise((resolveRun, reject) => {
    const child = spawn(stage.command, stage.commandArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', interrupted = false;
    const interrupt = () => { interrupted = true; child.kill('SIGINT'); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    const detach = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); };
    child.once('error', error => { detach(); reject(error); });
    child.once('close', (code, signal) => { detach(); resolveRun({ code: code ?? 1, signal, interrupted, stdout, stderr }); });
  });
}

export async function executePass(plan, { root = plan.root, date = new Date().toISOString().slice(0, 10),
  home = homedir(), names = [], conditions, run = runStage } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use a YYYY-MM-DD date');
  if (!names.filter(Boolean).length) throw new Error('Owner names required for publication scrubbing');
  root = realpathSync(root);
  const out = safePath(join(root, 'docs/benchmarks', `${date}-release-pass`));
  const page = safePath(join(root, 'docs/results', `${date}-release-pass.md`));
  if (existsSync(out)) throw new Error('Release pass output exists; refusing overwrite');
  if (existsSync(page)) throw new Error('Release pass page exists; refusing overwrite');
  mkdirSync(out, { recursive: true });
  mkdirSync(dirname(page), { recursive: true });
  const rows = [];
  let interrupted = false;
  const clean = text => scrubText(text, home, names);
  const save = () => {
    const manifest = JSON.parse(clean(JSON.stringify({ stages: rows, coverage: DROPPED })));
    // These paths already identify scrubbed destinations. Scrubbing them again
    // could change a literal placeholder or collision suffix in a file name.
    for (const [i, row] of manifest.stages.entries()) row.files = rows[i].files;
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(out, 'summary.md'), clean(summary(rows)));
    writeFileSync(page, clean(summary(rows).replace(/\]\(([^)]+)\)/g, `](../benchmarks/${date}-release-pass/$1)`)));
  };
  for (const stage of plan.stages) {
    const folder = join(out, stage.id);
    mkdirSync(folder);
    const destination = publicationPaths(folder, home, names);
    const row = { id: stage.id, status: 'blocked', issues: problems(stage, await conditions(stage)), files: [] };
    rows.push(row);
    if (interrupted) row.issues.push('release pass interrupted; later stages were not run');
    if (row.issues.length) { save(); continue; }
    validateStage(stage);
    let before;
    try { accountFunding(stage, root); before = inventory(root, stage.artifacts); }
    catch (error) { row.issues.push(error.message); save(); continue; }
    if (stage.runner === 'fowl' && [...stage.artifacts, option(stage.args, '--out')].some(p => existsSync(safePath(resolve(root, p))))) {
      row.issues.push('browser round bank already exists; refusing overwrite'); save(); continue;
    }
    // Never collect published output back into itself.
    if (stage.artifacts.some(p => { const path = safePath(resolve(root, p)); return out === path || out.startsWith(path + sep) || path.startsWith(out + sep); })) {
      row.issues.push('artifact roots overlap publication output'); save(); continue;
    }
    writeFileSync(join(folder, 'command.txt'), clean([stage.command, ...stage.commandArgs].map(quote).join(' ')) + '\n');
    row.status = 'running'; save();
    let result;
    try { result = await run(stage, { root }); }
    catch (error) { result = { code: 1, stderr: error.message }; }
    interrupted = result.interrupted === true || ['SIGINT', 'SIGTERM'].includes(result.signal) || [130, 143].includes(result.code);
    row.code = result.code;
    writeFileSync(join(folder, 'stdout.log'), clean(result.stdout ?? ''));
    writeFileSync(join(folder, 'stderr.log'), clean(result.stderr ?? ''));
    const eventTexts = [];
    const eventChecks = [];
    const runs = [];
    row.total = 0; row.passed = 0;
    try {
      for (const [file, identity] of inventory(root, stage.artifacts)) {
        if (before.get(file) === identity) continue;
        const rel = stage.artifacts.map(p => safePath(resolve(root, p))).find(p => file === p || file.startsWith(p + sep));
        const index = stage.artifacts.findIndex(p => safePath(resolve(root, p)) === rel);
        const dest = destination(index, [stage.artifacts.length === 1 ? basename(rel) : `artifacts-${index}`,
          ...(file === rel ? [basename(file)] : relative(rel, file).split(sep))]);
        if (!dest.startsWith(folder + sep)) throw new Error('Artifact destination escaped stage');
        const published = relative(out, dest);
        // Publish all new result text; images/binaries cannot be scrubbed and are explicitly recorded.
        if (!/\.(?:json|jsonl|md|txt|log|csv|html)$/.test(file)) { row.issues.push(`non-text artifact not published, requires owner review: ${published}`); continue; }
        const text = readFileSync(file, 'utf8');
        if (text.includes('\0')) { row.issues.push('binary artifact requires owner review'); continue; }
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, clean(text), { flag: 'wx' }); row.files.push(relative(out, dest));
        if (file.endsWith('.jsonl')) {
          eventTexts.push(text);
          const check = verifyModels([text], stage.expectedModels);
          if (check.models.length) eventChecks.push(check);
        }
        if (file.endsWith('.json')) {
          try {
            const data = JSON.parse(text);
            const results = Array.isArray(data) ? data : data.results;
            if (Array.isArray(results)) { runs.push(...results); row.total += results.length; row.passed += results.filter(r => r.passed === true || r.outcome?.ok === true || r.outcome?.cell === 'ok').length; }
            if (data.passCleanupErrors?.length) row.issues.push('native runner reported incomplete pass cleanup');
          } catch { row.issues.push(`malformed result retained: ${published}`); }
        }
      }
    } catch (error) { row.issues.push(error.message); }
    row.models = verifyModels(eventTexts, stage.expectedModels);
    row.models.coveredRuns = eventChecks.length;
    if (eventChecks.length < row.total || !eventChecks.length || eventChecks.some(check => check.malformed || !check.models.length ||
      check.models.some(model => !stage.expectedModels.includes(model)))) row.models.verified = false;
    if (stage.id === 'native' && stage.expectedModels.includes(CODEX)) {
      for (const [arm, model] of [['sleight', HAIKU], ['codex', CODEX]]) {
        const expectedRuns = runs.filter(r => r.arm === arm).length;
        if (!expectedRuns || eventChecks.filter(check => check.models.includes(model)).length < expectedRuns) row.models.verified = false;
      }
    }
    const after = await conditions(stage);
    row.cleanup = after.liveLock === false ? 'runner returned and live lock absent; inspect runner cleanup evidence' : 'live lock retained or unreadable';
    row.status = result.code !== 0 || row.passed < row.total ? 'failed' : row.issues.length || !row.models.verified || !row.total || after.liveLock !== false ? 'unqualified' : 'complete';
    save();
  }
  return { stages: rows, exitCode: rows.every(r => r.status === 'complete') ? 0 : 1, out };
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--plan', '--run', '--config', '--receipt', '--stages', '--date', '--owner-away']);
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key)) throw new Error('Unknown release-pass option');
    if (['--plan', '--run', '--owner-away'].includes(key)) values[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Option needs a value'); values[key] = args[++i]; }
  }
  if (values['--plan'] && values['--run']) throw new Error('Choose --plan or --run');
  const config = values['--config'] ? JSON.parse(readFileSync(values['--config'], 'utf8')) : {};
  const receipt = () => {
    try { return values['--receipt'] ? JSON.parse(readFileSync(values['--receipt'], 'utf8')) : undefined; }
    catch { return undefined; }
  };
  const conditions = () => inspectConditions({ ownerAway: values['--owner-away'] === true, receipt: receipt() });
  const selected = values['--stages']?.split(',');
  const plan = createPlan({ stages: config.stages, conditions: conditions(), date: values['--date'] });
  if (selected) {
    if (selected.some(id => !plan.stages.some(stage => stage.id === id || kind(stage.id) === id))) throw new Error('Unknown selected stage');
    plan.stages = plan.stages.filter(stage => selected.includes(stage.id) || selected.includes(kind(stage.id)));
  }
  if (!values['--run']) { console.log(scrubText(JSON.stringify(plan, null, 2))); return 0; }
  let fullName = '';
  try { fullName = execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8' }).trim(); } catch {}
  if (!fullName) throw new Error('Owner name lookup unavailable; refusing publication');
  const result = await executePass(plan, { date: values['--date'], names: [fullName, userInfo().username], conditions });
  console.log(scrubText(summary(result.stages), homedir(), [fullName, userInfo().username]));
  return result.exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(scrubText(error.message)); process.exitCode = 1; }
}
