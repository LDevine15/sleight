#!/usr/bin/env node
// Release orchestration only. Existing runners own their live lock and cleanup.
// Exact turbo and claim arguments come from sleight-arch after qualification.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEY_FILE, LEDGER_FILE, readKey } from './api-auth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDS = ['native', 'gate-normal', 'gate-swap', 'opus', 'claim'];
const HAIKU = 'claude-haiku-5-5', OPUS = 'claude-opus-5-5';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function scrubText(text, home = homedir(), names = []) {
  text = String(text).replace(new RegExp(escape(home), 'giu'), '~');
  for (const name of [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`, 'giu'), '<user>');
  }
  // Logs can contain another spelling of a home or credentials from a failed runner.
  return text.replace(/\/(?:Users|home)\/[^/\s"\\]+/g, '~')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/((?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)["']?\s*[:=]\s*["']?)[^\s"',}]+/g, '$1<redacted>');
}

function option(args, name) { return args[args.indexOf(name) + 1]; }
function problems(stage, conditions) {
  const issues = [];
  if (!stage.args) issues.push('sleight-arch must supply exact runner arguments and artifact roots');
  if (conditions.liveLock !== false) issues.push('live lock held or unreadable');
  if (conditions.hold !== false) issues.push('hold file present or unreadable');
  if (conditions.ownerAway !== true) issues.push('owner-away window not confirmed');
  if (stage.id === 'opus' ? conditions.loginReady !== true : conditions.apiReady !== true) {
    issues.push(stage.id === 'opus' ? 'isolated login not verified' : 'API key or spend admission not ready');
  }
  if (stage.id !== 'native' && conditions.extensionsReady !== true) issues.push('extension sockets and connection not verified');
  if (stage.id.startsWith('gate') || stage.id === 'opus') {
    if (conditions.productionTurboReady !== true) issues.push('production turbo not qualified; prototype cannot be the release gate');
  }
  if (stage.id === 'claim' && conditions.loginReady !== true) issues.push('claim login arms not verified');
  return issues;
}

function validateStage(stage) {
  if (!IDS.includes(stage.id)) throw new Error('Unknown release stage');
  if (!['native', 'fowl'].includes(stage.runner)) throw new Error('Use an existing native or fowl runner');
  if (!Array.isArray(stage.args) || stage.args.some(arg => typeof arg !== 'string' || /\0|\n/.test(arg))) throw new Error('Runner arguments must be strings');
  const args = stage.args;
  const model = stage.id === 'opus' ? OPUS : HAIKU;
  if (args.filter(arg => arg === '--model').length !== 1 || option(args, '--model') !== model) throw new Error('Pin the stage model id');
  if (args.filter(arg => arg === '--effort').length !== 1 || option(args, '--effort') !== (stage.id === 'opus' ? 'medium' : 'high')) throw new Error('Pin the stage effort');
  if (args.some(arg => ['--plan', '--dry-run', '--setup-only', '--owner-present', '--remote', '--remote-held'].includes(arg))) throw new Error('Release stages must use local live runners');
  if (stage.runner === 'native' && (option(args, '--auth') !== (stage.id === 'opus' ? 'login' : 'api') || !args.includes('--owner-away'))) throw new Error('Native stages require explicit funding and --owner-away');
  if (stage.id === 'native' && (stage.runner !== 'native' || option(args, '--suite') !== 'default' || option(args, '--arm') !== 'sleight')) throw new Error('Native release suite uses sleight default');
  if (stage.id === 'claim' && stage.runner === 'native' && option(args, '--suite') !== 'world') throw new Error('Claim requires world suite');
  if (stage.id.startsWith('gate') && stage.runner !== 'fowl') throw new Error('Gate uses the Fowl runner');
  if (stage.id === 'opus' && stage.runner !== 'fowl') throw new Error('Opus head-to-head uses the Fowl runner');
  if (stage.id === 'gate-swap' && !args.includes('--swap') || stage.id === 'gate-normal' && args.includes('--swap')) throw new Error('Gate order does not match stage');
  if (stage.runner === 'fowl' && (!args.includes('--out') || !option(args, '--out'))) throw new Error('Fowl stages require --out');
  if (stage.runner === 'fowl' && !args.includes('--world')) throw new Error('Fowl stages require isolated --world arms and their verified login');
  if (!Array.isArray(stage.artifacts) || !stage.artifacts.length || stage.artifacts.some(p => typeof p !== 'string' || !p)) throw new Error('List every result and event artifact root');
  if (!Array.isArray(stage.expectedModels) || !stage.expectedModels.includes(model) || stage.expectedModels.some(m => typeof m !== 'string')) throw new Error('List exact expected event models');
}

export function createPlan({ root = ROOT, stages, conditions = {} } = {}) {
  const supplied = stages ?? [{ id: 'native', runner: 'native', args: ['--suite', 'default', '--arm', 'sleight', '--runs', '1',
    '--model', HAIKU, '--effort', 'high', '--auth', 'api', '--owner-away'], artifacts: ['bench/results'], expectedModels: [HAIKU] },
  ...IDS.slice(1).map(id => ({ id, runner: id === 'claim' ? 'native' : 'fowl' }))];
  if (!supplied.length || new Set(supplied.map(s => s.id)).size !== supplied.length) throw new Error('Select unique release stages');
  return { root, stages: supplied.map(stage => {
    if (!IDS.includes(stage.id)) throw new Error('Unknown release stage');
    if (stage.args) validateStage(stage);
    const issues = problems(stage, conditions);
    return { ...stage, command: stage.args ? (stage.runner === 'native' ? 'node' : 'sh') : undefined,
      commandArgs: stage.args ? [stage.runner === 'native' ? 'bench/run.mjs' : 'bench/fowl/rounds.sh', ...stage.args] : undefined,
      issues, ready: issues.length === 0 };
  }) };
}

// A fresh operator receipt records live login/connection checks without storing credentials.
// File and socket existence alone never prove a working login or extension connection.
export function inspectConditions({ ownerAway = false, receipt, keyFile = KEY_FILE, ledgerFile = LEDGER_FILE, now = new Date() } = {}) {
  const fresh = receipt && typeof receipt.expiresAt === 'string' && Date.parse(receipt.expiresAt) > now.getTime() &&
    Date.parse(receipt.expiresAt) <= now.getTime() + 60 * 60 * 1000;
  let apiReady = false;
  try {
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    const spent = ledger.month === now.toISOString().slice(0, 7) ? ledger.usd : 0;
    apiReady = !ledger.unpriced && Number.isFinite(spent) && spent >= 0 && spent < 190 && !!readKey(keyFile);
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
    if (event.type === 'result') for (const model of Object.keys(event.modelUsage ?? {})) found.add(model);
  }
  const models = [...found].sort();
  return { models, verified: !malformed && models.length > 0 && expected.every(m => found.has(m)) && models.every(m => expected.includes(m)), malformed };
}

function safePath(path) {
  if (process.platform === 'darwin') path = resolve(path).replace(/^\/tmp(?=\/|$)/, '/private/tmp');
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
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
function summary(rows) {
  const cell = text => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  return '# Release pass\n\nEvery selected stage and failure is retained. Missing event models leave a stage unqualified.\n\n' +
    '| Stage | Status | Exit | Passed/total | Event models | Evidence |\n| --- | --- | --- | --- | --- | --- |\n' +
    rows.map(row => `| ${row.id} | ${row.status} | ${row.code ?? 'not run'} | ${row.passed ?? 0}/${row.total ?? 0} | ${cell(row.models?.models.join(', ') || 'unverified')} | [files](${row.id}/) |`).join('\n') + '\n';
}

// No shell, no environment inherited from a Claude session, no cleanup signaling.
// The child runner owns its process tree and live-lock receipt. Interrupt is forwarded.
export function runStage(stage, { root }) {
  const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  return new Promise((resolveRun, reject) => {
    const child = spawn(stage.command, stage.commandArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const interrupt = () => child.kill('SIGINT');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    const detach = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); };
    child.once('error', error => { detach(); reject(error); });
    child.once('close', (code, signal) => { detach(); resolveRun({ code: code ?? 1, signal, stdout, stderr }); });
  });
}

export async function executePass(plan, { root = plan.root, date = new Date().toISOString().slice(0, 10),
  home = homedir(), names = [], conditions, run = runStage } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use a YYYY-MM-DD date');
  if (!names.filter(Boolean).length) throw new Error('Owner names required for publication scrubbing');
  root = realpathSync(root);
  const out = safePath(join(root, 'docs/benchmarks', `${date}-release-pass`));
  if (existsSync(out)) throw new Error('Release pass output exists; refusing overwrite');
  mkdirSync(out, { recursive: true });
  const rows = [];
  const clean = text => scrubText(text, home, names);
  const save = () => {
    writeFileSync(join(out, 'manifest.json'), clean(JSON.stringify({ stages: rows }, null, 2)) + '\n');
    writeFileSync(join(out, 'summary.md'), clean(summary(rows)));
  };
  for (const stage of plan.stages) {
    const folder = join(out, stage.id);
    mkdirSync(folder);
    const row = { id: stage.id, status: 'blocked', issues: problems(stage, await conditions(stage)), files: [] };
    rows.push(row);
    if (row.issues.length) { save(); continue; }
    validateStage(stage);
    let before;
    try { before = inventory(root, stage.artifacts); }
    catch (error) { row.issues.push(error.message); save(); continue; }
    // Never collect published output back into itself.
    if (stage.artifacts.some(p => { const path = safePath(resolve(root, p)); return out === path || out.startsWith(path + sep) || path.startsWith(out + sep); })) {
      row.issues.push('artifact roots overlap publication output'); save(); continue;
    }
    writeFileSync(join(folder, 'command.txt'), clean([stage.command, ...stage.commandArgs].map(quote).join(' ')) + '\n');
    row.status = 'running'; save();
    let result;
    try { result = await run(stage, { root }); }
    catch (error) { result = { code: 1, stderr: error.message }; }
    row.code = result.code;
    writeFileSync(join(folder, 'stdout.log'), clean(result.stdout ?? ''));
    writeFileSync(join(folder, 'stderr.log'), clean(result.stderr ?? ''));
    const eventTexts = [];
    const eventChecks = [];
    row.total = 0; row.passed = 0;
    try {
      for (const [file, identity] of inventory(root, stage.artifacts)) {
        if (before.get(file) === identity) continue;
        // Publish all new result text; images/binaries cannot be scrubbed and are explicitly recorded.
        if (!/\.(?:json|jsonl|md|txt|log|csv|html)$/.test(file)) { row.issues.push(`non-text artifact requires owner review: ${relative(root, file)}`); continue; }
        const text = readFileSync(file, 'utf8');
        if (text.includes('\0')) { row.issues.push('binary artifact requires owner review'); continue; }
        const rel = stage.artifacts.map(p => safePath(resolve(root, p))).find(p => file === p || file.startsWith(p + sep));
        const index = stage.artifacts.findIndex(p => safePath(resolve(root, p)) === rel);
        const dest = join(folder, stage.artifacts.length === 1 ? basename(rel) : `artifacts-${index}`,
          file === rel ? basename(file) : relative(rel, file));
        if (!dest.startsWith(folder + sep)) throw new Error('Artifact destination escaped stage');
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, clean(text)); row.files.push(relative(out, dest));
        if (file.endsWith('.jsonl')) {
          eventTexts.push(text);
          if (/\/(?:events|transcript)\.jsonl$/.test(file)) eventChecks.push(verifyModels([text], stage.expectedModels));
        }
        if (file.endsWith('.json')) {
          try {
            const data = JSON.parse(text);
            const runs = Array.isArray(data) ? data : data.results;
            if (Array.isArray(runs)) { row.total += runs.length; row.passed += runs.filter(r => r.passed === true || r.outcome?.cell === 'ok').length; }
          } catch { row.issues.push(`malformed result retained: ${relative(root, file)}`); }
        }
      }
    } catch (error) { row.issues.push(error.message); }
    row.models = verifyModels(eventTexts, stage.expectedModels);
    row.models.coveredRuns = eventChecks.length;
    if (eventChecks.length < row.total || !eventChecks.length || eventChecks.some(check => check.malformed || !check.models.length ||
      check.models.some(model => !stage.expectedModels.includes(model)))) row.models.verified = false;
    const after = await conditions(stage);
    row.cleanup = after.liveLock === false ? 'runner returned and live lock absent; inspect runner cleanup evidence' : 'live lock retained or unreadable';
    row.status = result.code !== 0 ? 'failed' : row.issues.length || !row.models.verified || !row.total || after.liveLock !== false ? 'unqualified' : 'complete';
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
  const plan = createPlan({ stages: config.stages, conditions: conditions() });
  if (selected) {
    if (selected.some(id => !plan.stages.some(stage => stage.id === id))) throw new Error('Unknown selected stage');
    plan.stages = plan.stages.filter(stage => selected.includes(stage.id));
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
