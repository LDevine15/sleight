#!/usr/bin/env node
// Scores the browser race from real-gate round folders with bench/claim-score.mjs's rules: per browser, arm and task the
// passes/runs, expected seconds (mean attempt / pass rate), median and range of passes, p90 at 5 runs, the pairs within 20%
// of sleight that still need 5 runs, and per browser how many tasks each arm is fastest on and its total.
// Each saved row is graded again offline: a pass needs the recorded outcome ok, at least one successful browser call by
// that arm (counted again from events.jsonl where it was saved) and the race's positive site evidence (real-gate-grade.mjs
// RACE_EXPECT). A round with harness-failure.json, or one where 10 or more of 12 tasks failed with one error class, is
// excluded with its reason. --mark writes harness-failure.json into a newly detected round's folder.
// Each task carries the ChatGPT engine version it ran on and its UTC dates: the round's engine.json when the gate recorded one,
// otherwise inferred from the task's recorded start and end against bench/engine-versions.json (bench/engine-version.mjs). A row
// without times takes the birth time of the round's commits.json, marked as an inferred date. Per browser, the output names each
// arm's versions with their dates and says when the arms that drive the engine ran on different versions.
//   node bench/fowl/race-score.mjs [round folders or <dir>/<prefix>*] [--json] [--mark]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claim, score } from '../claim-score.mjs';
import { browserEvidence, harnessFailure, raceProblems, runErrorClass } from './real-gate-grade.mjs';
import { currentTimeline, dayRange, engineForRun, engineMix, engineText, loadTimeline, mixText, summarizeEngines } from '../engine-version.mjs';

const DEFAULT = join(homedir(), 'Projects/sleight-wt/race-1017/*');
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
const readText = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const birthMs = file => { try { return statSync(file).birthtimeMs; } catch { return undefined; } };
const isDir = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const isRound = dir => ['results.json', 'browser.json', 'failure.json'].some(name => existsSync(join(dir, name)));

// A folder that is a round, a folder of rounds, or <dir>/<prefix>* (shells leave an unmatched glob as is).
export function expandRounds(args) {
  const out = [];
  for (const arg of args) {
    const name = basename(arg);
    if (name.includes('*')) {
      const re = new RegExp('^' + name.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      const parent = dirname(arg);
      if (isDir(parent)) out.push(...readdirSync(parent).filter(n => re.test(n)).sort().map(n => join(parent, n)).filter(isDir));
    } else if (isRound(arg)) out.push(arg);
    else if (isDir(arg)) out.push(...readdirSync(arg).sort().map(n => join(arg, n)).filter(d => isDir(d) && isRound(d)));
  }
  return [...new Set(out)];
}

// One saved row graded again. Problems already recorded stay; the new rules can only turn a pass into a failure.
export function regradeRow(row, { eventsText = '', stderr = '' } = {}) {
  const problems = row.outcome?.ok ? [] : [...(row.outcome?.problems?.length ? row.outcome.problems : [row.outcome?.cell ?? 'no outcome recorded'])];
  const calls = eventsText ? browserEvidence(eventsText).successfulCalls : row.successfulBrowserCalls ?? row.run?.evidence?.successfulCalls ?? null;
  if (!(calls >= 1) && !problems.includes('no successful browser tool call')) problems.push(calls == null ? 'browser calls not recorded' : 'no successful browser tool call');
  problems.push(...raceProblems({ task: row.task, site: row.site, answer: row.run?.result?.result }).filter(p => !problems.includes(p)));
  const passed = problems.length === 0;
  return { task: row.task.name, arm: row.surface, seconds: row.wallMs / 1000, passed, problems, successfulCalls: calls,
    recordedOk: row.outcome?.ok === true, errorClass: passed ? null : row.errorClass ?? runErrorClass({ eventsText, stderr }) };
}

let staticTimeline;
export function loadRound(dir, { timeline = staticTimeline ??= loadTimeline() } = {}) {
  const browser = readJson(join(dir, 'browser.json'))?.browser;
  let saved = readJson(join(dir, 'results.json'));
  if (!Array.isArray(saved)) saved = readdirSync(dir).map(n => readJson(join(dir, n, 'run.json'))).filter(r => r?.outcome && r.task);
  const span = readJson(join(dir, 'engine.json'));
  const born = span ? undefined : birthMs(join(dir, 'commits.json'));
  const when = row => (Number.isFinite(row.run?.started) ? { startMs: row.run.started, endMs: row.run.finished } : { startMs: born, dated: 'inferred' });
  const rows = saved.map(row => ({ ...regradeRow(row, { eventsText: readText(join(dir, row.task.name, 'events.jsonl')), stderr: readText(join(dir, row.task.name, 'stderr.txt')) }),
    engine: engineForRun({ recorded: row.engineVersion ?? span, ...when(row) }, timeline) }));
  const starts = saved.map(row => row.run?.started).filter(Number.isFinite), ends = saved.map(row => row.run?.finished).filter(Number.isFinite);
  const engine = engineForRun({ recorded: span, ...(starts.length ? { startMs: Math.min(...starts), endMs: Math.max(...ends) } : { startMs: born, dated: 'inferred' }) }, timeline);
  const marked = readJson(join(dir, 'harness-failure.json')), failure = readJson(join(dir, 'failure.json'));
  const detected = marked ? null : harnessFailure(rows.map(r => ({ task: r.task, ok: r.passed, errorClass: r.errorClass })), rows.length);
  const harness = marked ?? detected;
  return { dir, name: basename(dir), browser: browser ?? saved[0]?.task?.browser ?? 'unknown', arm: rows[0]?.arm ?? saved[0]?.surface ?? null,
    rows, failure: failure?.error ?? null, excluded: harness ? harness.reason : rows.length ? null : `no results${failure ? ` (${failure.error})` : ''}`,
    detected, commits: readJson(join(dir, 'commits.json')) ?? null, engine };
}

const sleightArm = browser => ['firefox', 'safari'].includes(browser) ? 'sleight' : 'sleight-turbo';

export function scoreRounds(rounds) {
  const browsers = {};
  for (const round of rounds) if (!round.excluded) for (const row of round.rows) (browsers[round.browser] ??= []).push({ ...row, file: round.name });
  const out = {};
  for (const [browser, rows] of Object.entries(browsers)) {
    const me = sleightArm(browser), tasks = [...new Set(rows.map(r => r.task))];
    const arms = [me, ...[...new Set(rows.map(r => r.arm))].filter(a => a !== me).sort()];
    const table = score(rows), verdict = claim(table, { tasks, arms }, me);
    const fastest = Object.fromEntries(arms.map(a => [a, []]));
    for (const task of tasks) {
      const ranked = arms.filter(a => table[a]?.[task]?.expected != null).sort((a, b) => table[a][task].expected - table[b][task].expected);
      if (ranked.length && (ranked.length === 1 || table[ranked[0]][task].expected < table[ranked[1]][task].expected)) fastest[ranked[0]].push(task);
    }
    const totals = Object.fromEntries(arms.map(a => [a, tasks.every(t => table[a]?.[t]?.expected != null) ? tasks.reduce((s, t) => s + table[a][t].expected, 0) : null]));
    const counted = summarizeEngines(rows), engines = Object.fromEntries(arms.filter(a => counted[a]).map(a => [a, counted[a]]));
    out[browser] = { me, tasks, arms, table, stats: verdict.stats, pairs: verdict.pairs, topUps: verdict.pairs.filter(p => p.short?.length), fastest, totals,
      engines, engineMix: engineMix(engines) };
  }
  return out;
}

// Rows that passed as recorded and fail under the race rules.
export const flipped = rounds => rounds.flatMap(r => r.rows.filter(row => row.recordedOk && !row.passed).map(row => ({ round: r.name, browser: r.browser, ...row })));

function print(rounds, scored) {
  const n = x => x == null ? '-' : x.toFixed(1), col = s => ' ' + String(s).padStart(36);
  console.log('Rounds:');
  const roundEngine = e => (e.version ? `engine ${e.version} ${e.provenance}` : `engine ${e.provenance}${e.candidates ? ` (${e.candidates.join(' or ')})` : ''}`) +
    (e.startedAt ? `, ${dayRange(e.startedAt, e.endedAt)}${e.dated === 'inferred' ? ' (date inferred)' : ''}` : ', no date');
  for (const r of rounds) console.log(`  ${r.name} (${r.browser}, ${r.arm ?? 'no arm'}, ${r.rows.length} rows${r.commits?.build?.commit ? `, build ${r.commits.build.commit.slice(0, 8)}` : ''}, ${roundEngine(r.engine)}): ${r.excluded ? `excluded, ${r.excluded}` : 'scored'}`);
  for (const [browser, s] of Object.entries(scored)) {
    console.log(`\n${browser}. Cell: expected s (passes/runs), median [min-max] of passes, p90 at 5+ runs.`);
    console.log('task'.padEnd(22) + s.arms.map(col).join(''));
    for (const task of s.tasks) console.log(task.padEnd(22) + s.arms.map(a => {
      const t = s.table[a]?.[task], st = s.stats[a]?.[task];
      if (!t) return col('no runs');
      if (!t.passes.length) return col(`never (0/${t.runs.length})`);
      return col(`${n(t.expected)} (${t.passes.length}/${t.runs.length}) ${n(st.median)} [${n(st.range[0])}-${n(st.range[1])}]${st.p90 != null ? ` p90 ${n(st.p90)}` : ''}`);
    }).join(''));
    console.log('fastest on'.padEnd(22) + s.arms.map(a => col(`${s.fastest[a].length} of ${s.tasks.length}`)).join(''));
    console.log('total expected s'.padEnd(22) + s.arms.map(a => col(s.totals[a] == null ? 'none (a task has no pass)' : n(s.totals[a]))).join(''));
    console.log(`Engine and UTC dates per arm (runs): ${s.arms.map(a => `${a} ${s.engines[a] ? engineText(s.engines[a], a) : 'no runs'}`).join(' | ')}.`);
    if (s.engineMix) console.log(mixText(s.engineMix));
    console.log(s.topUps.length ? `Within 20% of ${s.me}, need 5 runs: ${s.topUps.map(p => `${p.task}/${p.arm} (${p.short.join(', ')})`).join('; ')}` : `No pair within 20% of ${s.me} is short of 5 runs.`);
  }
  const flips = flipped(rounds);
  console.log(`\nPasses as recorded that fail under the race rules (${flips.length}):`);
  for (const f of flips) console.log(`  ${f.round} ${f.arm} ${f.task}: ${f.problems.join('; ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dirs = args.filter(a => !a.startsWith('--'));
  const timeline = currentTimeline();
  const rounds = expandRounds(dirs.length ? dirs : [DEFAULT]).map(dir => loadRound(dir, { timeline }));
  if (args.includes('--mark')) for (const r of rounds) if (r.detected) writeFileSync(join(r.dir, 'harness-failure.json'),
    JSON.stringify({ ...r.detected, decided: 'automatic (race-score --mark)', at: new Date().toISOString() }, null, 2));
  const scored = scoreRounds(rounds);
  if (args.includes('--json')) console.log(JSON.stringify({ rounds, browsers: scored, flipped: flipped(rounds) }, null, 1));
  else print(rounds, scored);
}
