#!/usr/bin/env node
// Release comparison orchestration. Existing runners own app lifecycles and the live lock.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, EVIDENCE, HARNESS_PATHS, git, sha } from './audit-140.mjs';
import { readValidationData, validationDataDir } from './data.mjs';
import { score } from '../claim-score.mjs';
import { loadRound } from '../fowl/race-score.mjs';

const DEFAULT_OUT = join(EVIDENCE, 'validation-140-runs');

export function reuseProblems(a, b) {
  const out = [];
  for (const key of ['promptHash', 'harnessHash', 'model', 'effort', 'engine'])
    if (!a[key] || !b[key] || a[key] !== b[key]) out.push(`${key} missing or changed`);
  if (a.clean !== true) out.push('A source was dirty or unverified');
  if (JSON.stringify(a.tasks) !== JSON.stringify(b.tasks)) out.push('task selection changed');
  return out;
}

export function classifiedReuseProblems(round, audit, classification, { tasks, model, engine }) {
  const problems = [];
  if (!classification || classification.bHarnessHash !== audit.bHarness.hash) return ['missing or stale B harness classification'];
  if (!classification.bPromptSources) return ['missing B prompt-source fingerprints'];
  for (const [path, hash] of Object.entries(classification.bPromptSources)) {
    try {
      if (sha(git('show', `${audit.bBuild}:${path}`)) !== hash) problems.push(`${path}: B prompt source changed`);
    } catch { problems.push(`${path}: B prompt source missing`); }
  }
  const entries = classification.rounds.filter(r => r.name === round.name);
  const proof = entries.length === 1 ? entries[0] : null;
  if (!proof || proof.fileHash !== round.fileHash || proof.harnessCommit !== round.harnessCommit)
    return ['missing or changed A evidence classification'];
  const files = classification.profiles[proof.profile]?.files ?? {};
  for (const path of round.changedHarnessFiles) {
    const file = files[path];
    if (file?.classification !== 'NOT' || !file.trace?.length || !file.reason)
      problems.push(`${path}: ${file?.classification ?? 'unclassified'}`);
  }
  if (round.clean !== true || round.engineChanged !== false) problems.push('A source or engine unverified');
  if (!engine || round.engine !== engine) problems.push('engine missing or changed');
  if (JSON.stringify(round.tasks.map(t => t.task)) !== JSON.stringify(tasks)) problems.push('task selection changed');
  for (const task of round.tasks) {
    const prompts = proof.prompts?.filter(p => p.task === task.task) ?? [];
    const prompt = prompts.length === 1 ? prompts[0] : null;
    if (!prompt?.aRenderedHash || prompt.aRenderedHash !== prompt.bRenderedHash) problems.push(`${task.task}: rendered prompt missing or changed`);
    if (task.models?.length !== 1 || task.models[0] !== model || task.effort !== 'high') problems.push(`${task.task}: model or effort missing or changed`);
    if (task.task === 'demoid') problems.push('demoid requires both sides');
  }
  return problems;
}

export function estimateCC(tasks, samples = [], model = 'claude-haiku-5-5') {
  const missing = [], perTask = {};
  for (const task of tasks) {
    const rows = samples.filter(r => r.task === task && r.model === model && r.effort === 'high' && Number.isFinite(r.seconds) && r.seconds >= 0);
    if (!rows.length) missing.push(task);
    else perTask[task] = { samples: rows.length, meanSeconds: rows.reduce((s, r) => s + r.seconds, 0) / rows.length };
  }
  const measuredSeconds = Object.values(perTask).reduce((s, r) => s + r.meanSeconds * 6, 0);
  return { seconds: missing.length ? null : measuredSeconds, measuredSeconds, perTask, missing };
}

export function planGroups(groups) {
  const rounds = [];
  for (const group of groups) for (let n = 1; n <= group.rounds; n++) {
    for (const side of (n % 2 ? ['A', 'B'] : ['B', 'A'])) {
      const tasks = side === 'A' ? group.freshA?.[n - 1] ?? group.both : group.tasks;
      if (tasks.length) rounds.push({ id: `${group.id}-${side}-r${n}`, group: group.id, side, n, tasks,
        runner: group.runner, browser: group.browser, model: group.model, expectedSeconds: group.seconds * tasks.length / group.tasks.length });
    }
  }
  return { groups, rounds, measuredEstimateSeconds: rounds.reduce((sum, r) => sum + r.expectedSeconds, 0) };
}

export function makePlan(audit, { out = DEFAULT_OUT, engine = '26.1013.40934', classification } = {}) {
  const groups = [];
  const as3Catalog = JSON.parse(readFileSync(join(ROOT, 'bench/world/tasks/browser-open-heldout.json')));
  const group = (id, kind, select, extra = {}) => {
    const old = audit.rounds.filter(select), historicalTasks = [...new Set(old.flatMap(r => r.tasks.map(t => t.task)))];
    const tasks = id.startsWith('as3-') ? as3Catalog.map(t => t.name) : historicalTasks;
    const count = extra.rounds ?? 3, reuse = [], decisions = [], freshA = [];
    for (let n = 1; n <= count; n++) {
      const round = old[n - 1];
      const problems = round ? classifiedReuseProblems(round, audit, classification, { tasks, model: extra.model ?? 'claude-haiku-5-5', engine }) : ['missing historical round'];
      decisions.push({ n, name: round?.name, problems });
      freshA.push(problems.length ? tasks : []);
      if (!problems.length) reuse.push({ n, name: round.name, path: round.path, fileHash: round.fileHash, build: round.build, tasks });
    }
    const both = tasks.filter(task => freshA.some(selected => selected.includes(task)));
    groups.push({ id, runner: kind, tasks, both, freshA, reuse, decisions, rounds: 3, a: old.map(r => r.path), historicalTasks,
      newTasks: tasks.filter(t => !historicalTasks.includes(t)), retiredTasks: historicalTasks.filter(t => !tasks.includes(t)),
      seconds: old.length ? old.reduce((s, r) => s + r.durationSeconds, 0) / old.length : 0,
      model: 'claude-haiku-5-5', ...extra });
  };
  group('release-haiku', 'browser', r => r.kind === 'release-haiku', { rounds: 5, browser: 'chrome' });
  group('release-opus', 'browser', r => r.kind === 'release-opus', { rounds: 1, browser: 'chrome', model: 'claude-opus-5-5' });
  group('native', 'native', r => r.kind === 'native' && r.flags.SLEIGHT_FS === '0');
  for (const browser of ['safari', 'firefox']) {
    group(`race-${browser}`, 'browser', r => r.kind === 'race' && r.name.startsWith(browser) && r.flags.SLEIGHT_FS === '0', { browser });
    group(`as3-${browser}`, 'browser', r => r.kind === 'as3' && r.name.includes(browser) && r.flags.SLEIGHT_BROWSER_CORE === '0', { browser });
  }
  const cc = readFileSync(join(ROOT, 'bench/cc-held-out-tasks.txt'), 'utf8').split('\n').map(t => t.trim()).filter(t => t && !t.startsWith('#'));
  // A round per task makes Safari's cold start and every task's exit individually visible.
  const ccEstimate = estimateCC(cc, classification?.ccMeasurements);
  for (const task of cc) groups.push({ id: task, runner: 'native', tasks: [task], both: [task], a: [], rounds: 3,
    model: 'claude-haiku-5-5', seconds: ccEstimate.perTask[task]?.meanSeconds ?? 0,
    ...(ccEstimate.missing.includes(task) ? { estimateMissing: 'No recorded CC task duration.' } : {}) });
  const p = planGroups(groups);
  return { schema: 1, live: false, root: ROOT, out: resolve(out), aBuild: audit.rounds.find(r => r.kind === 'release-haiku')?.build,
    bBuild: audit.bBuild, engine, harnessHash: audit.bHarness.hash,
    fullCheck: { side: 'B', command: ['npm', 'run', 'check'], estimateMissing: 'No comparable full-check timing in the A-round evidence.' },
    ...p, blockers: [...audit.problems, ...groups.filter(g => !g.tasks.length).map(g => `${g.id}: missing task inventory`)],
    classification: classification ? { bBuild: classification.bBuild, bHarnessHash: classification.bHarnessHash } : null,
    estimate: { measuredSeconds: p.measuredEstimateSeconds, cc: ccEstimate,
      totalSeconds: ccEstimate.seconds === null ? null : p.measuredEstimateSeconds,
      summary: `${(p.measuredEstimateSeconds / 3600).toFixed(3)} h measured/proxy rounds; CC ${ccEstimate.seconds === null ? 'unknown (no complete measured sample)' : `${ccEstimate.seconds.toFixed(1)} s`}; full check and outside-span overhead unknown`,
      missing: ['full check', ...(ccEstimate.missing.length ? ['CC measured durations'] : []), 'AS-3 replacement lookups (old five-task round duration is a proxy)',
        'fixture and login overhead outside recorded spans', 'analytics, Pages and Codex rechecks outside VP1'] },
    safari: 'Before every Safari or CC Safari round the existing owner check requires Safari quit. It refuses a running Safari; reset/stop quits only the process it launched. Never quit an unowned Safari.',
    scoring: ['node', join(ROOT, 'bench/validation/validation-140.mjs'), '--score', '--out', resolve(out)] };
}

export function compareRows(rows, tasks, count) {
  const table = score(rows.map(row => ({ ...row, arm: row.side })));
  const complete = tasks.every(t => ['A', 'B'].every(s => {
    const own = rows.filter(r => r.side === s && r.task === t);
    return own.length === count && new Set(own.map(r => r.round)).size === count && own.every(r => Number.isFinite(r.seconds) && r.seconds >= 0);
  }));
  return { table, complete, aRounds: [...new Set(rows.filter(r => r.side === 'A').map(r => r.round))] };
}

function options(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--plan', '--run', '--score', '--owner-away'].includes(a)) out[a.slice(2)] = true;
    else if (['--out', '--b-build', '--engine', '--classification', '--data'].includes(a) && args[i + 1] && !args[i + 1].startsWith('--')) out[a.slice(2)] = args[++i];
    else throw Error(`Unknown or incomplete option: ${a}`);
  }
  if (['plan', 'run', 'score'].filter(k => out[k]).length > 1) throw Error('Choose --plan, --run or --score');
  return out;
}

function readRows(path, runner, tasks, side, name) {
  if (runner === 'browser') {
    const r = loadRound(path);
    if (r.excluded) throw Error(`${name}: ${r.excluded}`);
    return r.rows.filter(row => tasks.includes(row.task)).map(row => ({ ...row, side, round: name }));
  }
  const raw = JSON.parse(readFileSync(path));
  return raw.results.filter(row => row.arm === 'sleight' && tasks.includes(row.task)).map(row => ({ ...row,
    passed: !!(row.passed || row.cleanupContained && row.taskPassed), side, round: name }));
}

export function scoreOutput(out) {
  const plan = JSON.parse(readFileSync(join(out, 'plan.json'))), summary = [];
  let complete = true;
  for (const group of plan.groups) {
    const rows = [], errors = [];
    for (const round of plan.rounds.filter(r => r.group === group.id)) {
      try {
        const receipt = JSON.parse(readFileSync(join(out, `${round.id}.receipt.json`)));
        if (!receipt.safe || receipt.harnessHash !== plan.harnessHash || receipt.build !== (round.side === 'A' ? plan.aBuild : plan.bBuild) || receipt.engine !== plan.engine)
          throw Error('receipt identity, cleanup or engine mismatch');
        if (!safeResult(receipt.result, round.runner, round.tasks, plan.engine, round.model, receipt.build))
          throw Error('saved build, model, engine or cleanup evidence mismatch');
        rows.push(...readRows(receipt.result, round.runner, round.tasks, round.side, receipt.result));
      } catch (error) { errors.push(`${round.id}: ${error.message}`); }
    }
    const reused = group.reuse ?? group.a.map(path => ({ path, tasks: group.tasks.filter(t => !group.both.includes(t)) }));
    for (const { path: file, tasks, fileHash, build } of reused) if (tasks.length) {
      try {
        if (fileHash && sha(readFileSync(file)) !== fileHash) throw Error('historical A evidence hash changed');
        const result = group.runner === 'browser' ? dirname(file) : file;
        if (fileHash && !safeResult(result, group.runner, tasks, plan.engine, group.model, build))
          throw Error('historical A model, engine, build or cleanup evidence mismatch');
        rows.push(...readRows(result, group.runner, tasks, 'A', file));
      }
      catch (error) { errors.push(`${file}: ${error.message}`); }
    }
    const got = compareRows(rows, group.tasks, group.rounds);
    complete &&= got.complete && !errors.length;
    summary.push({ id: group.id, ...got, errors });
    console.log(`\n${group.id}: task | A passes/runs, expected s | B passes/runs, expected s`);
    console.log(`Historical A candidates: ${group.a.join(', ') || '(none, new task)'}`);
    console.log(`A rounds: ${got.aRounds.join(', ') || '(missing)'}`);
    for (const task of group.tasks) {
      const cell = side => { const r = got.table[side]?.[task]; return r ? `${r.passes.length}/${r.runs.length}, ${r.expected == null ? 'no pass' : r.expected.toFixed(1)}` : 'missing'; };
      console.log(`${task} | ${cell('A')} | ${cell('B')}`);
    }
    for (const error of errors) console.log(`INCOMPLETE ${error}`);
  }
  const check = JSON.parse(readFileSync(join(out, 'full-check.receipt.json')));
  complete &&= check.code === 0 && check.build === plan.bBuild;
  console.log(`\nFull check exit ${check.code}; comparison ${complete ? 'complete' : 'INCOMPLETE'}. Failures count in expected time.`);
  return { complete, groups: summary };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitGate(out = EVIDENCE) {
  while (['/tmp/sleight-hold', '/tmp/sleight-live.lock', join(out, 'pause')].some(existsSync)) await delay(20000);
}
const runGit = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });

async function child(command, args, cwd, log) {
  // Every check and runner gets its own throwaway outer Claude config. World arms keep their isolated account logins.
  const config = mkdtempSync('/tmp/lane-claude-');
  try {
    return await new Promise((done, fail) => {
      const p = spawn(command, args, { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', data => appendFileSync(log, data)); p.stderr.on('data', data => appendFileSync(log, data));
      p.once('error', fail); p.once('close', (code, signal) => done({ code, signal }));
      // Remain in the caller's foreground process group. The terminal's Ctrl-C reaches this child too.
    });
  } finally { rmSync(config, { recursive: true, force: true }); }
}

export function safeResult(result, runner, tasks, engine, model, build) {
  if (runner === 'browser') {
    const cleanup = JSON.parse(readFileSync(join(result, 'cleanup.json')));
    const raw = JSON.parse(readFileSync(join(result, 'results.json')));
    const e = JSON.parse(readFileSync(join(result, 'engine.json')));
    const commits = build ? JSON.parse(readFileSync(join(result, 'commits.json'))) : null;
    return cleanup.browserClosed === true && e.changed === false && e.version === engine &&
      (!build || commits.build?.commit === build) &&
      raw.length === tasks.length && tasks.every(task => raw.filter(r => r.task.name === task).length === 1) &&
      raw.every(r => r.run?.groupClean === true && Object.keys(r.run?.result?.modelUsage ?? {}).length === 1 && r.run.result.modelUsage[model]);
  }
  const raw = JSON.parse(readFileSync(result));
  return (!build || raw.sleight?.commit === build) && raw.engine?.version === engine && raw.engine?.changed === false && raw.model === model && raw.effort === 'high' && raw.results.length === tasks.length &&
    tasks.every(task => raw.results.filter(r => r.task === task).length === 1) && raw.results.every(r => r.groupClean === true && !r.cancelled && (!r.cleanupError || r.cleanupContained)) &&
    raw.results.every(r => r.models?.length === 1 && r.models[0] === model) &&
    Array.isArray(raw.leftWindows) && !raw.leftWindows.length && Array.isArray(raw.hygiene?.errors) && !raw.hygiene.errors.length &&
    Array.isArray(raw.hygiene?.trackingErrors) && !raw.hygiene.trackingErrors.length;
}

export function roundCommand(round, root, stem) {
  const args = round.runner === 'native'
    ? ['bench/run.mjs', '--suite', 'world', '--arm', 'sleight', '--tasks', round.tasks.join(','), '--runs', '1', '--model', round.model,
      '--effort', 'high', '--auth', 'login', '--real-profile', 'fresh', '--owner-away']
    : ['bench/fowl/rounds.sh', '--world', '--real-browser', round.browser, '--surface', round.browser === 'chrome' ? 'sleight-turbo' : 'sleight',
      '--model', round.model, '--effort', 'high', '--only', round.tasks.join(','), '--out', stem, '--tasks',
      join(root, round.group.startsWith('as3-') ? 'bench/world/tasks/browser-open-heldout.json' : 'bench/world/tasks/fowlbrowser.json')];
  return { command: round.runner === 'native' ? 'node' : '/bin/sh', args };
}

export function sharedHarnessSource(text, path, helperRoot) {
  const imports = [];
  // Only module specifiers change. Command paths and the plugin server launched by A stay relative to A.
  const source = text.replace(/((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"])(\.[^'"]*\/plugins\/[^'"]+)(['"])/g,
    (match, before, specifier, after) => {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!target.startsWith('plugins/')) throw Error(`Harness import escapes its source tree: ${path}`);
      imports.push(target);
      return before + pathToFileURL(join(helperRoot, target)).href + after;
    });
  return { source, imports };
}

async function execute(plan) {
  if (plan.blockers.length) throw Error(plan.blockers.join('\n'));
  if (!/^[a-f0-9]{40}$/.test(plan.aBuild ?? '') || !/^[a-f0-9]{40}$/.test(plan.bBuild)) throw Error('Build pin missing');
  if (git('rev-parse', 'HEAD').trim() !== plan.bBuild || git('status', '--porcelain', '--untracked-files=no').trim()) throw Error('Run from the clean, pinned B build');
  if (existsSync(plan.out)) throw Error('Output already exists; choose a new --out. Existing evidence is never removed or overwritten.');
  // No inherited tuning switches: validate exactly the product defaults on both builds.
  const inherited = Object.keys(process.env).filter(k => k !== 'SLEIGHT_VALIDATION_DATA' && /^(SLEIGHT_|AS3_|BENCH_ARM_HOME$)/.test(k));
  if (inherited.length) throw Error(`Unset benchmark overrides first: ${inherited.join(', ')}`);
  mkdirSync(plan.out, { recursive: true, mode: 0o700 });
  writeFileSync(join(plan.out, 'plan.json'), JSON.stringify(plan, null, 2));
  const log = join(plan.out, 'validate-140.log');
  const record = (id, result) => appendFileSync(log, `${new Date().toISOString()} ${id} ${JSON.stringify(result)}\n`);
  const staging = mkdtempSync('/tmp/lane-vp1-');
  const aRoot = join(staging, 'A'); let registered = false, unsafe = false;
  try {
    await waitGate();
    record('full-check-start', { build: plan.bBuild });
    const check = await child('npm', ['run', 'check'], ROOT, join(plan.out, 'full-check.log'));
    record('full-check-exit', check);
    writeFileSync(join(plan.out, 'full-check.receipt.json'), JSON.stringify({ ...check, build: plan.bBuild }));
    if (check.code !== 0) throw Error('Full check failed; stopped before live rounds');
    runGit(ROOT, 'worktree', 'add', '--detach', aRoot, plan.aBuild); registered = true;
    // The A plugin is unchanged. Both arms use B's identical tracked harness and fixtures, including the new CC tasks.
    for (const dir of ['bench', 'scripts']) rmSync(join(aRoot, dir), { recursive: true, force: true });
    const files = git('ls-tree', '-r', plan.bBuild, '--', ...HARNESS_PATHS).trim().split('\n').filter(l => l && !l.includes('\tbench/results/'));
    const stagedFiles = {}, helperImports = {};
    for (const line of files) {
      const [meta, path] = line.split('\t'), target = join(aRoot, path);
      if (!meta.startsWith('100')) throw Error(`Harness contains a non-file: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      const original = execFileSync('/usr/bin/git', ['-C', ROOT, 'show', `${plan.bBuild}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
      const shared = /\.(?:mjs|js)$/.test(path) ? sharedHarnessSource(original.toString('utf8'), path, ROOT) : null;
      const bytes = shared?.source ?? original;
      if (shared?.imports.length) helperImports[path] = shared.imports;
      writeFileSync(target, bytes);
      stagedFiles[path] = sha(bytes);
      if (meta.startsWith('100755')) chmodSync(target, 0o755);
    }
    symlinkSync(join(ROOT, 'node_modules'), join(aRoot, 'node_modules'));
    if (runGit(aRoot, 'diff', plan.aBuild, '--', 'plugins').trim()) throw Error('A plugin changed during harness staging');
    writeFileSync(join(plan.out, 'harness.json'), JSON.stringify({ hash: plan.harnessHash, aBuild: plan.aBuild, bBuild: plan.bBuild,
      aPluginTree: runGit(aRoot, 'rev-parse', `${plan.aBuild}:plugins`).trim(), bPluginTree: git('rev-parse', `${plan.bBuild}:plugins`).trim(),
      sharedHelperRoot: join(ROOT, 'plugins'), helperImports, stagedFiles,
      note: 'A uses B harness modules and B helper imports, with A plugin command paths. Native results mark A dirty for the staged harness. Plugin trees and transformed file hashes are separate.' }, null, 2));
    for (const round of plan.rounds) {
      await waitGate();
      const root = round.side === 'A' ? aRoot : ROOT, stem = join(plan.out, round.id), path = `${stem}.log`;
      if (git('rev-parse', 'HEAD').trim() !== plan.bBuild || git('status', '--porcelain', '--untracked-files=no').trim() ||
          runGit(aRoot, 'diff', plan.aBuild, '--', 'plugins').trim()) throw Error('Build changed during the window');
      if (Object.entries(stagedFiles).some(([path, hash]) => sha(readFileSync(join(aRoot, path))) !== hash)) throw Error('Staged A harness changed during the window');
      const { command, args } = roundCommand(round, root, stem);
      record(`${round.id}-start`, { build: round.side === 'A' ? plan.aBuild : plan.bBuild, command: args });
      unsafe = true;
      const exit = await child(command, args, root, path);
      record(`${round.id}-exit`, exit);
      let result, safe = false;
      try {
        result = round.runner === 'browser' ? stem : /^results: (.+)$/m.exec(readFileSync(path, 'utf8'))?.[1];
        safe = [0, 1].includes(exit.code) && !!result && safeResult(result, round.runner, round.tasks, plan.engine, round.model,
          round.side === 'A' ? plan.aBuild : plan.bBuild);
        if (result && round.runner === 'native') {
          const durable = `${stem}.json`;
          writeFileSync(durable, readFileSync(result), { flag: 'wx', mode: 0o600 });
          result = durable;
        }
      } catch { /* Partial artifacts always stop the window. */ }
      writeFileSync(`${stem}.receipt.json`, JSON.stringify({ ...round, ...exit, result, safe, engine: plan.engine,
        build: round.side === 'A' ? plan.aBuild : plan.bBuild, harnessHash: plan.harnessHash }, null, 2));
      if (!safe) { unsafe = true; throw Error(`${round.id}: incomplete evidence, engine change or unproved cleanup; stopped. Keep ${aRoot}`); }
      unsafe = false;
    }
    const scored = scoreOutput(plan.out);
    writeFileSync(join(plan.out, 'score.json'), JSON.stringify(scored, null, 2));
    if (!scored.complete) throw Error('Comparison incomplete');
    record('done', { complete: true });
  } finally {
    // Never remove the staging bank while any round's app or subprocess cleanup is unproved.
    if (!unsafe) {
      if (registered) runGit(ROOT, 'worktree', 'remove', '--force', aRoot);
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const o = options(args);
  if (o.run && (!o['owner-away'] || !/^[a-f0-9]{40}$/.test(o['b-build'] ?? '') || !o.engine))
    throw Error('--run requires --owner-away, --b-build FULL_SHA and --engine VERSION');
  if (o.score) return scoreOutput(resolve(o.out ?? DEFAULT_OUT)).complete ? 0 : 1;
  const data = validationDataDir(o.data);
  const audit = readValidationData('validation-140-a.json', data);
  if (o['b-build'] && audit.bBuild !== o['b-build']) throw Error('Audit B build differs from --b-build; regenerate the audit first');
  const classificationPath = o.classification ?? join(data, 'validation-140-classification.json');
  const classification = existsSync(classificationPath) ? JSON.parse(readFileSync(classificationPath)) : null;
  if (o.classification && !classification) throw Error('Classification file missing');
  const plan = makePlan(audit, { out: o.out, engine: o.engine, classification });
  if (!o.run) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  await execute(plan); return 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
