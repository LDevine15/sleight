#!/usr/bin/env node
// Final integrated build gate. Historical validation banks are read-only inputs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, readdirSync, appendFileSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, sha } from './audit-140.mjs';
import { buildHarnessEvidence, harnessAt, verifyRunPins, readReceipt, readRows, safeResult,
  roundCommand, child, verifyEngine, waitGate, waitForRoundApps, stopGuard } from './validation-140.mjs';
import { score } from '../claim-score.mjs';

const json = file => JSON.parse(readFileSync(file, 'utf8'));
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const git = (root, ...args) => execFileSync('/usr/bin/git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim();
const driver = path => path.startsWith('bench/validation/');
const taskFiles = inventory => Object.fromEntries(Object.entries(inventory.files).filter(([path]) => !driver(path)));
const below = (parent, path) => { const r = relative(parent, path); return r === '' || !isAbsolute(r) && r !== '..' && !r.startsWith('../'); };

function commit(root, build) {
  if (!/^[a-f0-9]{40}$/.test(build ?? '')) throw Error('Full recorded commit pin required');
  if (git(root, 'rev-parse', `${build}^{commit}`) !== build) throw Error('Recorded commit pin differs');
}

function ordinary(path, directory = false) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || !(directory ? s.isDirectory() : s.isFile())) throw Error(`Evidence must be ordinary: ${path}`);
}

// Pin every scorer input, including per-task browser events and stderr used by loadRound.
function pinTree(path, pins, directories) {
  ordinary(path, lstatSync(path).isDirectory());
  if (lstatSync(path).isDirectory()) {
    directories[path] = readdirSync(path).sort();
    for (const name of directories[path]) pinTree(join(path, name), pins, directories);
  }
  else pins[path] = sha(readFileSync(path));
}

function checkRows(rows, tasks, count) {
  if (rows.length !== tasks.length * count || tasks.some(task => {
    const own = rows.filter(r => r.task === task);
    return own.length !== count || new Set(own.map(r => r.round)).size !== count ||
      own.some(r => !Number.isFinite(r.seconds) || r.seconds < 0 || typeof r.passed !== 'boolean');
  })) throw Error('Missing, duplicate or invalid task measurements');
}

function browserIdentity(result, tasks, build) {
  const commits = json(join(result, 'commits.json')), raw = json(join(result, 'results.json'));
  if (commits.harness?.commit !== build || !/^[a-f0-9]{40}$/.test(commits.fowlbrowser?.commit ?? '') ||
    !Number.isInteger(commits.fowlbrowser.dirty) || tasks.some(task => !raw.find(r => r.task.name === task)?.task.prompt))
    throw Error('Browser prompt, harness or upstream provenance missing');
  return { upstream: { commit: commits.fowlbrowser.commit, dirty: commits.fowlbrowser.dirty },
    taskSpecs: Object.fromEntries(tasks.map(task => [task, sha(canonical(raw.find(r => r.task.name === task).task))])) };
}

export function verifyInputs(plan) {
  for (const [dir, entries] of Object.entries(plan.inputDirectories)) {
    ordinary(dir, true);
    if (canonical(readdirSync(dir).sort()) !== canonical(entries)) throw Error(`Baseline evidence changed: ${dir}`);
  }
  for (const [file, hash] of Object.entries(plan.inputHashes)) {
    ordinary(file);
    if (sha(readFileSync(file)) !== hash) throw Error(`Baseline evidence changed: ${file}`);
  }
  if (existsSync(join(plan.baseline, '.active-run'))) throw Error('Baseline writer is active');
}

export function makeRemeasurePlan({ baseline, tasks, build, engine, out, repository = ROOT }) {
  if (!baseline || !out || !engine) throw Error('Require --baseline, --out and --engine');
  baseline = resolve(baseline); out = resolve(out); repository = resolve(repository);
  ordinary(baseline, true);
  const actualOut = join(realpathSync(dirname(out)), basename(out));
  if (below(realpathSync(baseline), actualOut) || below(actualOut, realpathSync(baseline)) || below(realpathSync(repository), actualOut))
    throw Error('Use a separate fresh output bank outside the repository and baseline');
  if (existsSync(out)) throw Error('Re-measure output already exists; retain it and choose a fresh bank');
  if (existsSync(join(baseline, '.active-run'))) throw Error('Baseline writer is active');
  const saved = json(join(baseline, 'plan.json'));
  if (saved.schema !== 1 || realpathSync(saved.out) !== realpathSync(baseline) || saved.engine !== engine || saved.blockers?.length)
    throw Error('Baseline plan schema, location, engine or blockers incompatible');
  for (const pin of [saved.aBuild, saved.bBuild, build]) commit(repository, pin);
  verifyRunPins(saved, saved, repository);
  const fullCheck = json(join(baseline, 'full-check.receipt.json'));
  if (fullCheck.code !== 0 || fullCheck.signal !== null || fullCheck.build !== saved.bBuild)
    throw Error('Baseline full-check receipt failed or build pin differs');
  const staged = buildHarnessEvidence(saved, repository);
  if (staged.hash !== saved.harnessHash || canonical(staged) !== canonical(json(join(baseline, 'harness.json'))))
    throw Error('Baseline staged harness or recorded Git provenance incompatible');
  const oldHarness = harnessAt(saved.bBuild, repository), finalHarness = harnessAt(build, repository);
  if (canonical(taskFiles(oldHarness)) !== canonical(taskFiles(finalHarness)))
    throw Error('Task/prompt/harness changed since recorded A rounds; run a new compatible A/B, retain old evidence');
  const selected = typeof tasks === 'string' ? tasks.split(',') : tasks;
  if (!selected?.length || selected.some(t => !/^[a-z0-9-]+:[a-z0-9-]+$/.test(t)) || new Set(selected).size !== selected.length)
    throw Error('Select unique named tasks as group:task');
  const inputHashes = {}, inputDirectories = {}, groups = [];
  for (const file of ['plan.json', 'harness.json', 'full-check.receipt.json', 'full-check.log', 'validate-140.log', 'run-identity.json']) {
    if (file === 'run-identity.json' && !existsSync(join(baseline, file))) continue;
    pinTree(join(baseline, file), inputHashes, inputDirectories);
  }
  for (const id of new Set(selected.map(t => t.split(':')[0]))) {
    const matches = saved.groups.filter(g => g.id === id), group = matches[0];
    const wanted = selected.filter(t => t.startsWith(`${id}:`)).map(t => t.split(':')[1]);
    if (matches.length !== 1 || wanted.some(t => !group.tasks.includes(t)) || new Set(group.tasks).size !== group.tasks.length ||
      !['native', 'browser'].includes(group.runner) || !group.model || !Number.isInteger(group.rounds) || group.rounds < 3)
      throw Error(`${id}: missing or incompatible task/model/round inventory (A needs at least 3 rounds)`);
    const sources = [], rows = [];
    let browserPin;
    for (let n = 1; n <= group.rounds; n++) {
      const fresh = saved.rounds.filter(r => r.group === id && r.side === 'A' && r.n === n);
      const reused = (group.reuse ?? []).filter(r => r.n === n);
      if (fresh.length + reused.length !== 1) throw Error(`${id} A r${n}: missing or ambiguous baseline`);
      const source = fresh[0] ?? reused[0];
      if (canonical(source.tasks) !== canonical(group.tasks)) throw Error(`${id}: original task selection differs`);
      let result, sourceBuild, name;
      if (fresh.length) {
        if (!/^[a-zA-Z0-9_-]+$/.test(source.id) || source.runner !== group.runner || source.model !== group.model || source.browser !== group.browser)
          throw Error(`${id}: round identity incompatible`);
        const receiptFile = join(baseline, `${source.id}.receipt.json`);
        const receipt = readReceipt(baseline, saved, source);
        for (const key of ['id', 'group', 'side', 'n', 'runner', 'browser', 'model', 'tasks'])
          if (canonical(receipt[key]) !== canonical(source[key])) throw Error(`${id}: receipt round identity differs`);
        if (![0, 1].includes(receipt.code) || receipt.signal) throw Error(`${id}: round exit incompatible`);
        pinTree(receiptFile, inputHashes, inputDirectories);
        result = receipt.result; sourceBuild = saved.aBuild; name = source.id;
      } else {
        if (!source.fileHash || sha(readFileSync(source.path)) !== source.fileHash) throw Error(`${id}: historical A evidence hash changed`);
        result = group.runner === 'browser' ? dirname(source.path) : source.path;
        sourceBuild = source.build; name = source.name;
        commit(repository, sourceBuild);
      }
      if (!safeResult(result, group.runner, group.tasks, engine, group.model, sourceBuild)) throw Error(`${id}: A identity or cleanup incompatible`);
      if (group.runner === 'browser') {
        const identity = browserIdentity(result, group.tasks, sourceBuild);
        if (browserPin && canonical(browserPin) !== canonical(identity)) throw Error(`${id}: A prompt or upstream provenance differs across rounds`);
        browserPin = identity;
      }
      pinTree(result, inputHashes, inputDirectories);
      sources.push({ n, name, result, build: sourceBuild });
      rows.push(...readRows(result, group.runner, wanted, 'A', name));
    }
    checkRows(rows, wanted, group.rounds);
    if (Object.values(score(rows.map(r => ({ ...r, arm: 'A' }))).A).some(t => t.expected === null))
      throw Error(`${id}: A has no passing speed baseline`);
    groups.push({ id, runner: group.runner, browser: group.browser, model: group.model,
      tasks: group.tasks, selectedTasks: wanted, aRounds: sources, aRows: rows, ...(browserPin ? { browserPin } : {}) });
  }
  const rounds = groups.flatMap(g => [1, 2, 3].map(n => ({ id: `${g.id}-final-r${n}`, group: g.id,
    side: 'B', n, runner: g.runner, browser: g.browser, model: g.model, tasks: g.tasks })));
  const plan = { schema: 1, kind: 'final-build-remeasure', repository, baseline, out,
    aBuild: saved.aBuild, baselineBuild: saved.bBuild, build, engine, effort: 'high', roundsPerTask: 3,
    pluginTree: git(repository, 'rev-parse', `${build}:plugins`), harnessHash: finalHarness.hash,
    taskHarnessHash: sha(canonical(taskFiles(finalHarness))), inputHashes, inputDirectories, groups, rounds,
    gate: 'B expected seconds <= A expected seconds and B pass rate >= A pass rate, for every selected task' };
  verifyInputs(plan);
  return plan;
}

export function verifyFinalBuild(plan) {
  if (git(plan.repository, 'rev-parse', 'HEAD') !== plan.build ||
    git(plan.repository, 'status', '--porcelain', '--untracked-files=all', '--', '.',
      ':(exclude)node_modules', ':(exclude).vale', ':(exclude)bench/results'))
    throw Error('Final build HEAD changed or working tree is dirty');
  if (harnessAt(plan.build, plan.repository).hash !== plan.harnessHash ||
    git(plan.repository, 'rev-parse', `${plan.build}:plugins`) !== plan.pluginTree) throw Error('Final build provenance changed');
}

export function compareRemeasure(plan, bRows) {
  const groups = plan.groups.map(group => {
    const rows = bRows.filter(r => r.group === group.id);
    checkRows(rows, group.selectedTasks, 3);
    const table = score([...group.aRows, ...rows].map(r => ({ ...r, arm: r.side })));
    const tasks = group.selectedTasks.map(task => {
      const a = table.A[task], b = table.B[task];
      const speedRegression = b.expected === null || b.expected > a.expected;
      const passRegression = b.passes.length / b.runs.length < a.passes.length / a.runs.length;
      return { task, a, b, speedRegression, passRegression, passed: !speedRegression && !passRegression };
    });
    return { id: group.id, aRounds: group.aRounds, tasks, passed: tasks.every(t => t.passed) };
  });
  return { build: plan.build, baselineBuild: plan.baselineBuild, engine: plan.engine, groups,
    passed: groups.every(g => g.passed), complete: true };
}

// Offline tests replace only host/process boundaries. The same plan, pins, receipts and scorer run.
export async function runRemeasure(plan, { run = child, gate = waitGate, apps = waitForRoundApps, engine = verifyEngine } = {}) {
  const overrides = Object.keys(process.env).filter(k => /^(SLEIGHT_|AS3_|BENCH_ARM_HOME$)/.test(k));
  if (overrides.length) throw Error(`Unset benchmark overrides first: ${overrides.join(', ')}`);
  verifyInputs(plan); verifyFinalBuild(plan);
  if (existsSync(plan.out)) throw Error('Re-measure output already exists');
  mkdirSync(plan.out, { mode: 0o700 });
  const save = (name, data) => writeFileSync(join(plan.out, name), JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
  const record = (event, data) => appendFileSync(join(plan.out, 'remeasure.log'), `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`);
  save('plan.json', plan);
  const stop = stopGuard(), rows = [];
  try {
    for (const round of plan.rounds) {
      await gate(plan.out, stop.signal);
      await apps(round, record, { signal: stop.signal });
      await gate(plan.out, stop.signal);
      stop.check(); verifyInputs(plan); verifyFinalBuild(plan); engine(plan);
      const stem = join(plan.out, round.id), log = `${stem}.log`;
      const invocation = roundCommand(round, plan.repository, stem);
      record('round-start', { ...round, ...invocation, build: plan.build });
      let exit;
      try { exit = await run(invocation.command, invocation.args, plan.repository, log); }
      catch (error) { record('round-error', { id: round.id, error: error.message }); throw error; }
      record('round-exit', { id: round.id, ...exit });
      let result, safe = false, error;
      try {
        const source = round.runner === 'browser' ? stem : /^results: (.+)$/m.exec(readFileSync(log, 'utf8'))?.[1];
        if (source && round.runner === 'native') {
          result = `${stem}.json`;
          writeFileSync(result, readFileSync(source), { flag: 'wx', mode: 0o600 });
        } else result = source;
        safe = [0, 1].includes(exit.code) && !exit.signal && !!result &&
          safeResult(result, round.runner, round.tasks, plan.engine, round.model, plan.build);
        if (safe && round.runner === 'browser') {
          const expected = plan.groups.find(g => g.id === round.group).browserPin;
          if (canonical(browserIdentity(result, round.tasks, plan.build)) !== canonical(expected))
            throw Error('Browser task/prompt or upstream provenance changed');
        }
      } catch (e) { safe = false; error = e.message; }
      save(`${round.id}.receipt.json`, { ...round, ...exit, result, safe, error,
        build: plan.build, engine: plan.engine, harnessHash: plan.harnessHash });
      if (!safe) throw Error(`${round.id}: incomplete evidence or unproved cleanup; retain this output bank`);
      verifyInputs(plan); verifyFinalBuild(plan); engine(plan); stop.check();
      const selected = plan.groups.find(g => g.id === round.group).selectedTasks;
      rows.push(...readRows(result, round.runner, selected, 'B', round.id).map(r => ({ ...r, group: round.group })));
    }
    verifyInputs(plan); verifyFinalBuild(plan);
    const compared = compareRemeasure(plan, rows);
    save('comparison.json', compared); record('done', { passed: compared.passed });
    return compared;
  } catch (error) { record('stopped', { error: error.message }); throw error; }
  finally { stop.close(); }
}

export async function main(args = process.argv.slice(2)) {
  const o = {};
  for (let n = 0; n < args.length; n++) {
    const key = args[n];
    if (Object.hasOwn(o, key)) throw Error(`Duplicate option: ${key}`);
    if (['--run', '--owner-away'].includes(key)) o[key] = true;
    else if (['--baseline', '--tasks', '--build', '--engine', '--out'].includes(key) && args[n + 1] && !args[n + 1].startsWith('--')) o[key] = args[++n];
    else throw Error(`Unknown or incomplete option: ${key}`);
  }
  if (o['--run'] && !o['--owner-away']) throw Error('--run requires --owner-away');
  const plan = makeRemeasurePlan({ baseline: o['--baseline'], tasks: o['--tasks'], build: o['--build'], engine: o['--engine'], out: o['--out'] });
  if (!o['--run']) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  const result = await runRemeasure(plan);
  console.log(JSON.stringify(result, null, 2));
  return result.passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
