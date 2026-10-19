#!/usr/bin/env node
// The benchmark hub: one generator for docs/results/. It runs in two stages.
//   collect: reads the raw results (docs/benchmarks, and the claim and race folders under ~/Projects/sleight-wt) and writes one
//            scrubbed data file per family to docs/results/data/. A family whose raw folder is missing on this Mac keeps the
//            data file already in the repo, so the pages rebuild anywhere.
//   render:  reads only those data files and writes the index (README.md, index.html), one Markdown page per family,
//            release-passes.html, and explore.html with the data inlined (fetch from file:// fails in browsers).
// Scores come from the scorers themselves: bench/claim-score.mjs for the claims and every per-task table, and
// bench/fowl/race-score.mjs for the browser race rounds. Nothing in the output depends on the clock. Every arm's numbers name the
// ChatGPT engine versions they ran on with their UTC dates, read from the results or inferred (bench/engine-version.mjs).
//   node bench/results-hub.mjs [--wt ~/Projects/sleight-wt] [--out docs/results] [--render-only] [--check]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claim, excluded, regradeFor, score, warnings } from './claim-score.mjs';
import { loadRound, scoreRounds } from './fowl/race-score.mjs';
import { currentTimeline, engineMix, engineText, loadTimeline, mixText, passRowEngine, summarizeEngines } from './engine-version.mjs';
import { buildPage, loadResults, perArm, renderHtml as renderReleaseHtml, renderMarkdown as renderReleaseMarkdown, summarize } from './results-page.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(ROOT, 'docs', 'benchmarks');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const tryJson = file => { try { return readJson(file); } catch { return undefined; } };
const isDir = path => { try { return statSync(path).isDirectory(); } catch { return false; } };
const uniq = list => [...new Set(list.filter(value => value !== undefined && value !== null && value !== ''))];
const sortedUniq = list => uniq(list).sort();

// ---------------------------------------------------------------------------------------------------------------------------
// Scrubbing. Published data shows the home folder as ~ and never the owner's account or full name (LAWS).

// Paths are scrubbed everywhere, render included. Owner names are scrubbed only in collect(), on strings copied from raw data,
// so rendering never depends on which account runs it (on CI the account is 'runner', a word the pages use).
let nameParts;
function ownerNames() {
  if (nameParts) return nameParts;
  const names = [];
  if (process.platform === 'darwin') {
    names.push(userInfo().username);
    try { names.push(...execFileSync('id', ['-F'], { encoding: 'utf8' }).trim().split(/\s+/)); } catch { /* no full name */ }
  }
  nameParts = uniq(names.filter(name => name && name.length >= 3));
  return nameParts;
}
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function scrubPaths(value) {
  return String(value ?? '').split(homedir()).join('~')
    .replace(/(?:\/private)?\/var\/folders\/[^\s"'`)\],;:]+/g, '$TMPDIR')
    .replace(/\/Users\/[^/\s"'`)\],;:]+/g, '~');
}
export function scrub(value) {
  let text = scrubPaths(value);
  for (const name of ownerNames()) text = text.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'gi'), '[owner]');
  return text;
}
const tilde = path => scrub(path);

// ---------------------------------------------------------------------------------------------------------------------------
// Shared study shape. Every family's data file holds studies; a study is one scored comparison with its runs and its cells.
//   { id, family, title, date, browser, me, arms, tasks, models, effort, runs: [...], cells: [...], verdict }
// cells come from claim-score's score() and claim(), the same functions both scorers use.

// '2026-10-18 to 2026-10-18' reads as one day; times are UTC.
export function dateRange(first, last) {
  if (!first) return null;
  const day = value => value.slice(0, 10), time = value => value.slice(11, 16).replace('-', ':');
  if (!last || day(first) === day(last)) return time(first) && time(last ?? first) ? `${day(first)}, ${time(first)} to ${time(last ?? first)} UTC` : day(first);
  return `${day(first)} to ${day(last)}`;
}

const round1 = value => (value === null || value === undefined ? null : Math.round(value * 1000) / 1000);
export function cellsFor(runs, tasks, arms, me) {
  const table = score(runs.map(run => ({ arm: run.arm, task: run.task, seconds: run.seconds, passed: run.passed })));
  const verdict = claim(table, { tasks, arms }, me);
  const cells = [];
  for (const task of tasks) for (const arm of arms) {
    const t = table[arm]?.[task];
    if (!t) continue;
    const s = verdict.stats[arm]?.[task];
    cells.push({ task, arm, runs: t.runs.length, passes: t.passes.length, expected: round1(t.expected), median: round1(t.median),
      min: s?.range ? round1(s.range[0]) : null, max: s?.range ? round1(s.range[1]) : null, p90: round1(s?.p90 ?? null) });
  }
  return { table, verdict, cells };
}

// A task counts as lost when another arm has the lower expected time or a faster passing run (LAWS, owner 2026-10-18).
export function lossRule(table, tasks, arms, me) {
  const lost = [];
  for (const task of tasks) {
    const mine = table[me]?.[task];
    const myBest = mine?.passes.length ? Math.min(...mine.passes) : null;
    const by = [];
    for (const arm of arms.filter(a => a !== me)) {
      const other = table[arm]?.[task];
      if (!other?.passes.length) continue;
      const lowerExpected = mine?.expected == null || other.expected < mine.expected;
      const fasterRun = myBest == null || Math.min(...other.passes) < myBest;
      if (lowerExpected || fasterRun) by.push({ arm, lowerExpected, fasterRun });
    }
    if (by.length) lost.push({ task, by });
  }
  return lost;
}

function summarizeVerdict(table, verdict, tasks, arms, me) {
  const fastest = Object.fromEntries(arms.map(arm => [arm, []]));
  for (const task of tasks) {
    const ranked = arms.filter(a => table[a]?.[task]?.expected != null).sort((a, b) => table[a][task].expected - table[b][task].expected);
    if (ranked.length && (ranked.length === 1 || table[ranked[0]][task].expected < table[ranked[1]][task].expected)) fastest[ranked[0]].push(task);
  }
  return {
    me, wording: verdict.wording, lowest: verdict.lowest, reasons: verdict.reasons,
    totals: Object.fromEntries(Object.entries(verdict.totals).map(([arm, total]) => [arm, round1(total)])),
    fastest, lost: lossRule(table, tasks, arms, me),
    topUps: verdict.pairs.filter(pair => pair.short?.length).map(pair => ({ task: pair.task, arm: pair.arm, short: pair.short })),
  };
}

const scrubVerdict = verdict => ({ ...verdict, wording: scrub(verdict.wording), reasons: verdict.reasons.map(scrub) });

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: native claim and app claim (bench/claim-score.mjs, its CLI loop over a results folder).

export function scoreClaimDir(dir, rules, since, timeline = loadTimeline()) {
  const rows = [], dropped = {}, files = [];
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json') && name >= since).sort()) {
    const raw = readJson(join(dir, file)), mtimeMs = statSync(join(dir, file)).mtimeMs;
    let kept = 0;
    for (const row of raw.results ?? []) {
      const why = excluded(row, file, rules);
      if (why) { if (why !== 'not a claim task') dropped[why] = (dropped[why] ?? 0) + 1; continue; }
      const passed = !!(row.passed || (row.cleanupContained && row.taskPassed)), g = !passed && regradeFor(row, file, rules);
      rows.push({ arm: row.arm, task: row.task, seconds: row.seconds, passed, file, run: row.run,
        ...(!passed && { reason: (g && g.reason) || (row.reason ?? 'no reason recorded'), ...(g && { recorded: row.reason, regraded: g.why }) }),
        models: row.models ?? [], engine: passRowEngine(raw, row, { file, mtimeMs, timeline }) });
      kept += 1;
    }
    files.push({ file, raw, kept });
  }
  const table = score(rows), verdict = claim(table, rules), warned = warnings(rows, rules, since);
  return { rows, dropped, files, table, verdict, warnings: warned };
}

function armVersions(raw) {
  const out = {};
  for (const [arm, meta] of Object.entries(raw.armMetadata ?? {})) {
    const bits = [];
    if (meta.claudeVersion) bits.push(`Claude Code ${meta.claudeVersion}`);
    for (const server of Object.values(meta.servers ?? {})) for (const artifact of server.artifacts ?? []) {
      if (artifact.name && artifact.version) bits.push(`${artifact.name} ${artifact.version}`);
    }
    if (bits.length) out[arm] = bits;
  }
  return out;
}

function collectClaim({ id, title, dir, rulesFile, since, sinceNote, timeline }) {
  const rules = readJson(rulesFile);
  const result = scoreClaimDir(dir, rules, since ?? rules.since, timeline);
  const arms = rules.arms.filter(arm => result.table[arm]);
  const tasks = rules.tasks;
  const { cells, verdict, table } = cellsFor(result.rows, tasks, arms, 'sleight');
  const versions = {}, effort = [], auth = [], stamps = [];
  for (const { file, raw, kept } of result.files) {
    if (!kept) continue;
    stamps.push(file.slice(0, 16));
    if (raw.effort) effort.push(raw.effort);
    if (raw.auth) auth.push(raw.auth);
    for (const [arm, bits] of Object.entries(armVersions(raw))) versions[arm] = sortedUniq([...(versions[arm] ?? []), ...bits]);
  }
  const models = {};
  for (const row of result.rows) models[row.arm] = sortedUniq([...(models[row.arm] ?? []), ...row.models]);
  const runs = result.rows.map(row => ({ task: row.task, arm: row.arm, run: row.run, round: null, seconds: row.seconds, passed: row.passed,
    problem: row.passed ? null : scrub(row.reason).slice(0, 200), regraded: row.regraded ? scrub(row.regraded) : undefined, file: row.file }));
  return {
    family: id, title,
    source: { results: tilde(dir), rules: tilde(rulesFile).replace(tilde(ROOT) + '/', ''), since: since ?? rules.since, sinceNote: scrub(sinceNote ?? rules.sinceReason ?? '') || null,
      files: result.files.filter(f => f.kept).map(f => ({ file: f.file, arm: (f.raw.arms ?? []).join(','), kept: f.kept })) },
    studies: [{
      id, family: id, title, browser: null, me: 'sleight', arms, tasks,
      date: stamps.length ? dateRange(sortedUniq(stamps)[0], sortedUniq(stamps).at(-1)) : null,
      models, effort: sortedUniq(effort), auth: sortedUniq(auth), versions, ...enginesFor(result.rows, arms),
      runs, cells, verdict: scrubVerdict(summarizeVerdict(table, verdict, tasks, arms, 'sleight')),
      excluded: Object.entries(result.dropped).sort(([a], [b]) => (a < b ? -1 : 1)).map(([why, count]) => ({ why: scrub(why), count })),
      warnings: result.warnings.map(scrub),
    }],
  };
}

// Per arm, the engine versions and UTC dates of its counted runs, in the table's arm order, and the mix among engine arms.
function enginesFor(rows, arms) {
  const counted = summarizeEngines(rows.filter(row => row.engine));
  const engines = Object.fromEntries(arms.filter(arm => counted[arm]).map(arm => [arm, counted[arm]]));
  return { engines, engineMix: engineMix(engines) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: the real-window browser race (bench/fowl/race-score.mjs over round folders).

const ROUND_NAME = /^(chrome|helium|safari|firefox)-(.+?)-r(\d+)(f?)(?:-([a-z][a-z-]*))?$/;
const cap = word => word[0].toUpperCase() + word.slice(1);
const sleightArmFor = browser => (['firefox', 'safari'].includes(browser) ? 'sleight' : 'sleight-turbo');

export function listRaceRounds(raceDir) {
  if (!isDir(raceDir)) return [];
  return readdirSync(raceDir).sort().filter(name => ROUND_NAME.test(name) && isDir(join(raceDir, name))).map(name => {
    const [, browser, label, round, rerun, suffix] = ROUND_NAME.exec(name);
    return { name, dir: join(raceDir, name), browser, label, round: Number(round), rerun: rerun === 'f', suffix: suffix ?? null, done: existsSync(join(raceDir, name, 'results.json')) };
  });
}

function roundFacts(dir) {
  const raw = tryJson(join(dir, 'results.json')) ?? [];
  const started = raw.map(row => row.run?.started).filter(Number.isFinite);
  const models = new Set(), effort = new Set(), claude = new Set();
  for (const row of raw) {
    for (const model of Object.keys(row.run?.result?.modelUsage ?? {})) models.add(model);
    const text = JSON.stringify(row.run ?? {});
    for (const match of text.matchAll(/"model":"(gpt-[^"]+)"/g)) models.add(match[1]);
    for (const match of text.matchAll(/"effort":"([a-z]+)"/g)) effort.add(match[1]);
    if (row.agentConfig?.claudeVersion) claude.add(row.agentConfig.claudeVersion);
  }
  const browser = tryJson(join(dir, 'browser.json')) ?? {};
  const commits = tryJson(join(dir, 'commits.json')) ?? {};
  return {
    first: started.length ? new Date(Math.min(...started)).toISOString().slice(0, 16) + 'Z' : null,
    last: started.length ? new Date(Math.max(...started)).toISOString().slice(0, 16) + 'Z' : null,
    models: [...models].sort(), effort: [...effort].sort(), claude: [...claude].sort(),
    browserVersion: browser.version ?? null, build: commits.build?.commit?.slice(0, 8) ?? null, fowlbrowser: commits.fowlbrowser?.commit?.slice(0, 8) ?? null,
  };
}

export function collectRace({ raceDir, browsers, family, title, timeline = loadTimeline() }) {
  // Folder names pick the candidates; a round's own browser.json decides where it is scored, as in race-score.mjs.
  const listed = listRaceRounds(raceDir).filter(round => browsers.includes(round.browser));
  const marked = listed.filter(round => !round.done && existsSync(join(round.dir, 'harness-failure.json')));
  const inProgress = listed.filter(round => !round.done && !marked.includes(round)).map(round => round.name);
  const loaded = listed.filter(round => round.done).map(round => ({ ...round, loaded: loadRound(round.dir, { timeline }), facts: roundFacts(round.dir) }));
  const excludedRounds = [...loaded.filter(round => round.loaded.excluded).map(round => ({ round: round.name, reason: scrub(round.loaded.excluded) })),
    ...marked.map(round => ({ round: round.name, reason: scrub(tryJson(join(round.dir, 'harness-failure.json'))?.reason ?? 'marked as a harness failure') }))]
    .sort((a, b) => (a.round < b.round ? -1 : 1));
  const usable = loaded.filter(round => !round.loaded.excluded);
  const studies = [], partial = [];
  for (const browser of browsers) {
    const me = sleightArmFor(browser);
    const mine = usable.filter(round => round.loaded.browser === browser && round.loaded.arm === me);
    const others = usable.filter(round => round.loaded.browser === browser && round.loaded.arm !== me);
    if (!mine.length) continue;
    const tasks = sortedUniq(others.flatMap(round => round.loaded.rows.map(row => row.task)));
    const labels = sortedUniq(mine.map(round => round.label));
    for (const label of labels) {
      const set = mine.filter(round => round.label === label);
      const counts = {};
      for (const round of set) for (const row of round.loaded.rows) counts[row.task] = (counts[row.task] ?? 0) + 1;
      const short = tasks.filter(task => (counts[task] ?? 0) < 3);
      if (short.length) {
        partial.push({ browser, label, rounds: set.map(round => round.name), runs: Object.values(counts).reduce((a, b) => a + b, 0), needed: tasks.length * 3 });
        continue;
      }
      const rounds = [...set, ...others];
      const scored = scoreRounds(rounds.map(round => round.loaded))[browser];
      const arms = scored.arms;
      const { cells, verdict, table } = cellsFor(rounds.flatMap(round => round.loaded.rows), scored.tasks, arms, me);
      const runs = rounds.flatMap(round => round.loaded.rows.map(row => ({
        task: row.task, arm: row.arm, round: round.name, run: null, seconds: round1(row.seconds), passed: row.passed,
        problem: row.passed ? null : scrub(row.problems.join('; ')).slice(0, 200), file: round.name })));
      const models = {}, effort = {}, versions = {};
      for (const round of rounds) {
        const arm = round.loaded.arm;
        models[arm] = sortedUniq([...(models[arm] ?? []), ...round.facts.models]);
        effort[arm] = sortedUniq([...(effort[arm] ?? []), ...round.facts.effort]);
        versions[arm] = sortedUniq([...(versions[arm] ?? []), ...round.facts.claude.map(v => `Claude Code ${v}`)]);
      }
      const starts = sortedUniq(rounds.map(round => round.facts.first)), ends = sortedUniq(rounds.map(round => round.facts.last));
      const mineStarts = sortedUniq(set.map(round => round.facts.first));
      studies.push({
        id: `${family}-${browser}-${label}`, family, title: `${cap(browser)}, sleight rounds \`${browser}-${label}-r*\``, started: mineStarts[0] ?? null,
        browser, label, me, arms, tasks: scored.tasks, models, effort, versions, ...enginesFor(rounds.flatMap(round => round.loaded.rows), arms),
        date: starts.length ? dateRange(starts[0], ends.at(-1)) : null,
        builds: Object.fromEntries(arms.map(arm => [arm, sortedUniq(rounds.filter(r => r.loaded.arm === arm).map(r => r.facts.build))])),
        browserVersion: sortedUniq(rounds.map(round => round.facts.browserVersion)),
        rounds: rounds.map(round => ({ round: round.name, arm: round.loaded.arm, rows: round.loaded.rows.length, first: round.facts.first, build: round.facts.build })),
        runs, cells,
        verdict: { ...summarizeVerdict(table, verdict, scored.tasks, arms, me), raceFastest: scored.fastest, raceTotals: Object.fromEntries(Object.entries(scored.totals).map(([a, t]) => [a, round1(t)])) },
      });
    }
  }
  // The newest complete set per browser leads its page.
  for (const study of studies) study.latest = !studies.some(other => other.browser === study.browser && other !== study && (other.started ?? '') > (study.started ?? ''));
  return { family, title, source: { race: tilde(raceDir), browsers }, inProgress, excludedRounds, partial, studies };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: FowlBrowser-runner round reports (Markdown tables) in docs/benchmarks/<study>/.

const RUNNER_HEAD = /^\| agent \| surface \| browser \| outcome \|/;
const SESSION = /^((?:[a-z]+\d*-)?\d{8}-\d{4}|\d\d-\d\d|[a-z]*\d[a-z0-9]*)-/;

export function parseRunnerReport(text) {
  const rows = [], problems = {};
  let inTable = false, inProblems = false;
  for (const line of text.split('\n')) {
    if (RUNNER_HEAD.test(line)) { inTable = true; continue; }
    if (inTable && line.startsWith('|---')) continue;
    if (inTable && line.startsWith('| ')) {
      const cols = line.slice(2, -2).split(' | ');
      const time = /^(\d+(?:\.\d+)?) s/.exec(cols[10] ?? '');
      const calls = /(\d+) calls?(?:, \d+ actions)?(?:, (\d+) errors?)?/.exec(cols[11] ?? '');
      rows.push({ task: cols[0], surface: cols[1], browser: cols[2], ok: /^ok\b/.test(cols[3] ?? ''), outcome: cols[3],
        seconds: time ? Number(time[1]) : null, calls: calls ? Number(calls[1]) : null, errors: calls?.[2] ? Number(calls[2]) : 0 });
      continue;
    }
    inTable = false;
    if (/^ROUND NOT CLEAN/.test(line)) { inProblems = true; continue; }
    if (inProblems) {
      const item = /^- ([\w-]+) · ([^·]+) · (.+)$/.exec(line);
      if (item) (problems[item[1]] ??= []).push(`${item[2].trim()}: ${item[3].trim()}`);
      else if (line.trim() && !line.startsWith('- ')) inProblems = false;
    }
  }
  return { rows, problems };
}

export function variantOf(stem) {
  let label = stem.replace(/-(normal|swap)(?=-|$)/, '').replace(/-\d{4}$/, '');
  const order = /-(swap)(?=-|$)/.test(stem) ? 'swap' : 'normal';
  const session = SESSION.exec(label);
  if (session) label = label.slice(session[0].length);
  return { variant: label, session: session ? session[1] : null, order };
}

// Owner's scoring (LAWS): a run that stops before a payment the prompt didn't price counts as done. The runner grades a
// form-checkout run that submitted nothing as a failure; here that run passes, and the runner's grade is kept beside it.
export function ownerPass(row, problems) {
  if (row.ok) return true;
  const outcome = problems.filter(p => p.startsWith('outcome:'));
  return row.task === 'form-checkout' && outcome.length > 0 && outcome.every(p => /nothing submitted/.test(p));
}

// The write-up of a round folder: <study>.md, or the write-up whose section links to <study>/ (later sessions such as
// 2026-10-16-gate-3 are written up as a section of 2026-10-16-gate.md). Model and effort come from that section first.
let writeUps;
function writeUpFacts(study) {
  writeUps ??= readdirSync(BENCH).filter(name => name.endsWith('.md')).sort().map(name => ({ name, lines: readFileSync(join(BENCH, name), 'utf8').split('\n') }));
  const own = writeUps.find(w => w.name === `${study}.md`);
  const linking = own ? undefined : writeUps.find(w => w.lines.some(line => line.includes(`](${study}/)`)));
  const doc = own ?? linking;
  if (!doc) return { model: null, effort: null, writeUp: null, title: study };
  let section = doc.lines, title = /^# (.+)$/.exec(doc.lines.find(line => /^# /.test(line)) ?? '')?.[1] ?? study;
  if (linking) {
    const at = doc.lines.findIndex(line => line.includes(`](${study}/)`));
    let from = at;
    while (from > 0 && !/^#{1,3} /.test(doc.lines[from])) from -= 1;
    let to = at + 1;
    while (to < doc.lines.length && !/^#{1,3} /.test(doc.lines[to])) to += 1;
    section = doc.lines.slice(from, to);
    title = doc.lines[from].replace(/^#+ /, '');
  }
  const find = text => ({
    model: /\b(claude-(?:haiku|opus|sonnet)-\d+-\d+)\b/.exec(text)?.[1] ?? (/\bHaiku 5\.5\b/.test(text) ? 'claude-haiku-5-5' : /\bOpus 5\.5\b/.test(text) ? 'claude-opus-5-5' : null),
    effort: /\bat (high|medium|low) effort\b/.exec(text)?.[1] ?? /--effort (high|medium|low)/.exec(text)?.[1] ?? null,
  });
  const near = find(section.join('\n')), whole = find(doc.lines.join('\n'));
  return { model: near.model ?? whole.model, effort: near.effort ?? whole.effort, writeUp: doc.name, title: scrub(title) };
}

export function collectRunnerStudies() {
  const studies = [];
  for (const study of readdirSync(BENCH).sort().filter(name => /^2026-\d\d-\d\d-/.test(name) && isDir(join(BENCH, name)))) {
    const files = [];
    const walk = (dir, round) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (isDir(path)) walk(path, /^round-(\d+)$/.exec(name)?.[1] ?? round);
        else if (name.endsWith('.md')) files.push({ path, name, round });
      }
    };
    walk(join(BENCH, study), null);
    const runs = [];
    for (const file of files) {
      const text = readFileSync(file.path, 'utf8');
      if (!RUNNER_HEAD.test(text.split('\n').find(line => RUNNER_HEAD.test(line)) ?? '')) continue;
      const { rows, problems } = parseRunnerReport(text);
      const { variant, session, order } = variantOf(file.name.replace(/\.md$/, ''));
      const roundId = file.round ? `round ${file.round}` : session ?? '1';
      for (const row of rows) {
        if (row.seconds === null) continue;
        const own = problems[row.task] ?? [];
        runs.push({ task: row.task, arm: variant, round: roundId, order, run: null, seconds: row.seconds, passed: ownerPass(row, own), runnerOk: row.ok,
          browser: row.browser, calls: row.calls, errors: row.errors, problem: own.length ? scrub(own.join('; ')).slice(0, 200) : row.ok ? null : scrub(row.outcome).slice(0, 120),
          file: relative(BENCH, file.path) });
      }
    }
    if (!runs.length) continue;
    const facts = writeUpFacts(study);
    const arms = sortedUniq(runs.map(run => run.arm));
    const me = arms.find(arm => /^(sleight-turbo|sleight|baseline|default)$/.test(arm)) ?? arms.find(arm => arm.startsWith('sleight')) ?? arms[0];
    const orderedArms = [me, ...arms.filter(arm => arm !== me)];
    const tasks = sortedUniq(runs.map(run => run.task));
    const { cells, verdict, table } = cellsFor(runs, tasks, orderedArms, me);
    const rounds = [];
    for (const roundId of sortedUniq(runs.map(run => run.round))) for (const arm of orderedArms) {
      const list = runs.filter(run => run.round === roundId && run.arm === arm);
      if (!list.length) continue;
      rounds.push({ round: roundId, arm, runs: list.length, passed: list.filter(r => r.passed).length, runnerOk: list.filter(r => r.runnerOk).length,
        seconds: list.reduce((sum, r) => sum + r.seconds, 0), calls: list.reduce((sum, r) => sum + (r.calls ?? 0), 0), errors: list.reduce((sum, r) => sum + r.errors, 0) });
    }
    studies.push({
      id: study, family: /-ab(-|$)/.test(study) ? 'ab-tests' : 'browser-turbo', title: facts.title, date: study.slice(0, 10), browser: sortedUniq(runs.map(r => r.browser)).join(', '),
      me, arms: orderedArms, tasks, models: facts.model ? Object.fromEntries(orderedArms.map(arm => [arm, [facts.model]])) : {},
      modelSource: facts.model ? 'write-up' : null, effort: facts.effort ? [facts.effort] : [], writeUp: facts.writeUp,
      runs, cells, rounds, verdict: summarizeVerdict(table, verdict, tasks, orderedArms, me),
    });
  }
  return studies;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: A/B studies saved as JSON in docs/benchmarks ({ study, rounds: [{ arm, results }] } or { study, sides: [{ side, results }] }).

// The study's first sentence, or the whole text (cut at 160) when that sentence is too short to name the study.
const abTitle = (text, file) => {
  const first = text.split(/(?<=[.:;])\s/)[0];
  return (first.length >= 25 ? first : text).slice(0, 160) || file.replace(/\.json$/, '');
};

export function collectJsonAbs() {
  const studies = [];
  for (const name of readdirSync(BENCH).sort().filter(file => file.endsWith('.json'))) {
    const raw = tryJson(join(BENCH, name));
    const parts = Array.isArray(raw?.rounds) ? raw.rounds.map(r => ({ variant: r.arm ?? r.side, round: r.round, results: r.results, model: r.model, effort: r.effort }))
      : Array.isArray(raw?.sides) ? raw.sides.map(s => ({ variant: s.side ?? s.arm, round: s.round, results: s.results, model: s.model, effort: s.effort })) : null;
    if (!parts || !parts.every(part => Array.isArray(part.results) && part.variant)) continue;
    const runs = parts.flatMap(part => part.results.filter(row => Number.isFinite(row.seconds)).map(row => ({
      task: row.task, arm: part.variant, round: `round ${part.round ?? 1}`, run: row.run ?? null, seconds: row.seconds, passed: row.passed === true,
      turns: row.turns ?? null, problem: row.passed ? null : scrub(row.reason ?? 'failed').slice(0, 200), models: row.models ?? [], file: name })));
    if (!runs.length) continue;
    const arms = uniq(parts.map(part => part.variant));
    const me = arms[0];
    const tasks = sortedUniq(runs.map(run => run.task));
    const { cells, verdict, table } = cellsFor(runs, tasks, arms, me);
    const models = {};
    for (const run of runs) models[run.arm] = sortedUniq([...(models[run.arm] ?? []), ...run.models]);
    const effort = sortedUniq([...parts.map(p => p.effort), /\b(high|medium|low)\b/.exec(raw.model ?? '')?.[1]]);
    studies.push({
      id: name.replace(/\.json$/, ''), family: 'ab-tests', title: abTitle(scrub(raw.study ?? ''), name), date: raw.date ?? name.slice(0, 10),
      browser: null, me, arms, tasks, models, effort, commit: raw.commit ?? null, json: name,
      writeUp: existsSync(join(BENCH, name.replace(/\.json$/, '.md'))) ? name.replace(/\.json$/, '.md') : mentionedIn(name),
      runs: runs.map(({ models: _m, ...run }) => run), cells, verdict: summarizeVerdict(table, verdict, tasks, arms, me),
    });
  }
  return studies;
}

// The first write-up that names a data file, for studies whose write-up has another name.
function mentionedIn(file) {
  for (const name of readdirSync(BENCH).filter(n => n.endsWith('.md')).sort()) if (readFileSync(join(BENCH, name), 'utf8').includes(file)) return name;
  return readFileSync(join(ROOT, 'docs/benchmark.md'), 'utf8').includes(file) ? '../benchmark.md' : null;
}

// Every write-up in docs/benchmarks, for the catalog of measurements that have no structured data on the hub.
export function writeUpCatalog() {
  return readdirSync(BENCH).sort().filter(name => name.endsWith('.md')).map(name => {
    const text = readFileSync(join(BENCH, name), 'utf8');
    return { file: name, date: /^\d{4}-\d\d-\d\d/.exec(name)?.[0] ?? null, title: scrub(/^# (.+)$/m.exec(text)?.[1] ?? name.replace(/\.md$/, '')) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Collect: release passes and the earlier native head-to-heads (bench/results-page.mjs).

export const RELEASE_RIVALS = ['2026-10-10-h2h-5.json', '2026-10-03-sleight-vs-lcu.json'];

export function collectReleases({ timeline = loadTimeline() } = {}) {
  const standard = [];
  for (const name of readdirSync(BENCH).sort().filter(file => file.endsWith('.json'))) {
    const raw = tryJson(join(BENCH, name));
    if (!raw) continue;
    const passes = Array.isArray(raw.passes) ? raw.passes : undefined;
    const last = passes ? passes.at(-1) : raw;
    if (!Array.isArray(last?.results) || !last.results.length || !last.results.every(row => row.arm && row.task)) continue;
    const writeUp = existsSync(join(BENCH, name.replace(/\.json$/, '.md'))) ? name.replace(/\.json$/, '.md') : undefined;
    // A file's mtime here is the checkout's, so an older pass is placed from its stamp and its runs' seconds.
    standard.push({ ...loadResults(name, raw, writeUp), engines: summarizeEngines(last.results.map(row => ({ arm: row.arm, engine: passRowEngine(raw.stamp ? raw : last, row, { file: name, timeline }) }))) });
  }
  const toRow = file => {
    const arms = Object.values(perArm(file.results)).map(stats => ({ arm: stats.arm, runs: stats.runs, passed: stats.passed, seconds: stats.seconds, turns: stats.turns, models: stats.models }));
    return { name: file.name, date: file.date, kind: file.kind, version: file.version ?? null, model: file.model ?? null, effort: file.effort ?? null, suite: file.suite ?? null,
      passes: file.passes, writeUp: file.writeUp ? basename(file.writeUp) : null, arms,
      engines: Object.fromEntries(arms.map(a => [a.arm, engineText(file.engines[a.arm], a.arm)])) };
  };
  const releaseNames = standard.filter(file => file.kind === 'release' || RELEASE_RIVALS.includes(file.name)).map(file => file.name);
  const runs = standard.filter(file => releaseNames.includes(file.name)).flatMap(file => file.results.map(row => ({
    task: row.task, arm: row.arm, run: row.run ?? null, round: null, seconds: row.seconds ?? null, passed: row.passed === true, turns: row.turns ?? null,
    problem: row.passed ? null : scrub(row.reason ?? (row.cancelled ? 'cancelled' : 'failed')).slice(0, 200), file: file.name })));
  return { family: 'release-passes', title: 'Release passes and the earlier head-to-heads', releaseInputs: releaseNames, files: standard.map(toRow), runs };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Rendering helpers.

const DASH = 'n/a';
const f1 = value => (value === null || value === undefined ? DASH : (Math.round(value * 10) / 10).toFixed(1));
const f0 = value => (value === null || value === undefined ? DASH : Math.round(value).toLocaleString('en-US'));
const mdCell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();
export const mdTable = (head, rows) => ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |', ...rows.map(row => '| ' + row.map(mdCell).join(' | ') + ' |')].join('\n');
const list = items => items.map(item => `- ${item}`).join('\n');
const joinAnd = items => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const ARM_NAMES = { sleight: 'sleight', 'sleight-turbo': 'sleight turbo', lcu: 'LCU', codex: 'Codex', cua: 'Cua', peekaboo: 'Peekaboo', 'claude-cu': 'Claude computer use',
  fowlbrowser: 'FowlBrowser', 'claude-in-chrome': 'Claude in Chrome' };
const armName = arm => ARM_NAMES[arm] ?? arm;

// One cell per arm and task: expected seconds, then passes/runs.
export const cellText = cell => (!cell ? 'no runs' : cell.passes === 0 ? `never (0/${cell.runs})` : `${f1(cell.expected)} (${cell.passes}/${cell.runs})`);
// Task names, file names and recorded reasons are data, so the pages show them as code.
const code = value => '`' + String(value ?? '').replace(/`/g, "'") + '`';

export function taskMatrix(study) {
  const head = ['Task', ...study.arms.map(armName)];
  const rows = study.tasks.map(task => [code(task), ...study.arms.map(arm => cellText(study.cells.find(c => c.task === task && c.arm === arm)))]);
  rows.push(['Lowest expected time on', ...study.arms.map(arm => `${study.verdict.fastest[arm]?.length ?? 0} of ${study.tasks.length}`)]);
  rows.push(['Total expected s', ...study.arms.map(arm => (study.verdict.totals[arm] == null ? 'none (a task has no pass)' : f1(study.verdict.totals[arm])))]);
  return mdTable(head, rows);
}

function spreadTable(study) {
  const head = ['Task', ...study.arms.map(armName)];
  const rows = study.tasks.map(task => [code(task), ...study.arms.map(arm => {
    const cell = study.cells.find(c => c.task === task && c.arm === arm);
    if (!cell) return 'no runs';
    if (!cell.passes) return 'no passes';
    return `${f1(cell.median)} [${f1(cell.min)} to ${f1(cell.max)}]${cell.p90 != null ? `, p90 ${f1(cell.p90)}` : ''}`;
  })]);
  return mdTable(head, rows);
}

// Per arm: the model ids its runs recorded, effort, the versions the files name and, for data collected since engine versions were
// tracked (2026-10-19), the ChatGPT engine versions with their UTC dates. Older data files render as before.
function armTable(study, { builds = false, scriptEffort = null } = {}) {
  const engines = !!study.engines;
  const head = ['Arm', 'Model ids in the runs', 'Effort', 'Versions recorded', ...(engines ? ['ChatGPT engine and UTC dates'] : []), ...(builds ? ['Build'] : [])];
  const recorded = arm => (Array.isArray(study.effort) ? study.effort : study.effort?.[arm] ?? []);
  const effortOf = arm => (recorded(arm).length ? recorded(arm) : scriptEffort ? [scriptEffort] : []);
  const table = mdTable(head, study.arms.map(arm => [armName(arm), study.models?.[arm]?.length ? study.models[arm].map(code).join(', ') : 'not recorded',
    effortOf(arm).join(', ') || 'not recorded', study.versions?.[arm]?.join(', ') || 'not recorded',
    ...(engines ? [engineText(study.engines[arm], arm)] : []),
    ...(builds ? [study.builds?.[arm]?.map(code).join(', ') || 'not recorded'] : [])]));
  return engines ? `${table}\n\n${study.engineMix ? mixText(study.engineMix) : 'The arms that drive the engine ran on one engine version.'} ${ENGINE_NOTE}` : table;
}
const ENGINE_NOTE = 'A version is "recorded" when the runner read it and "inferred" from the timeline in `bench/engine-versions.json` otherwise, and ' +
  'a date is inferred when it comes from a file\'s stamp or modification time. LCU, Cua, Peekaboo, FowlBrowser, Claude in Chrome and Claude\'s computer use don\'t use the engine.';

function lostTable(study) {
  if (!study.verdict.lost.length) return `By the loss rule, ${armName(study.me)} didn't lose a task.`;
  const how = b => (b.lowerExpected && b.fasterRun ? 'lower expected time and a faster passing run' : b.lowerExpected ? 'lower expected time' : 'faster passing run');
  return `By the loss rule, ${armName(study.me)} lost ${study.verdict.lost.length} of ${study.tasks.length} tasks.\n\n` +
    mdTable(['Task', 'Arm ahead', 'How'], study.verdict.lost.flatMap(l => l.by.map(b => [code(l.task), armName(b.arm), how(b)])));
}

function topUpTable(study) {
  if (!study.verdict.topUps.length) return `No pair within 20% of ${armName(study.me)} is short of 5 runs.`;
  return `Pairs within 20% of ${armName(study.me)} that still need 5 runs:\n\n` +
    mdTable(['Task', 'Arm', 'Runs so far'], study.verdict.topUps.map(t => [code(t.task), armName(t.arm), t.short.join(', ')]));
}

const writeUpLink = name => (name.startsWith('../') ? name : `../benchmarks/${name}`);
const failureRows = study => study.runs.filter(run => !run.passed).map(run => [code(run.task), armName(run.arm), code(run.round ?? run.file), f1(run.seconds), run.problem ? code(run.problem) : DASH]);

const SCORING = 'Expected time is the mean seconds per attempt divided by the pass rate (`bench/claim-score.mjs`). A failed run adds its time ' +
  'to the mean and lowers the rate. A task an arm never passed has no expected time, and that arm then has no total. Median and range ' +
  'are over passing runs, and p90 (nearest rank) appears only at 5 or more runs.';
const LAWS_RULES = 'The rules come from [LAWS](../status/LAWS.md). Each arm gets 3 runs per task, or 5 where sleight and another arm are within 20% ' +
  '(the difference over the slower expected time). "Fastest" needs the lowest expected time on a majority of tasks and the lowest total, ' +
  'with those 5 runs in place. Otherwise the wording is "completed every task, fastest on N". A task counts as lost when another arm ' +
  'has the lower expected time or a faster passing run.';
const DATA_LINE = name => `[data/${name}.json](data/${name}.json) has every counted run and the scored cells. [explore.html](explore.html) charts them.\n`;

// ---------------------------------------------------------------------------------------------------------------------------
// Family pages.

function renderClaimPage(data, { name, intro }) {
  const study = data.studies[0];
  const out = [`# ${data.title}\n`, intro + '\n', '## Method\n'];
  out.push(list([
    `${study.runs.length} runs counted, from ${data.source.files.length} results files dated ${study.date}, on the owner's account login (auth ${code(study.auth.join(', ') || 'not recorded')}).`,
    SCORING,
    LAWS_RULES,
    `Rows come from ${code(data.source.results)} with the exclusions in ${code(data.source.rules)}. Scoring starts at file stamp ${code(data.source.since)}` +
      (data.source.sinceNote ? `, and the reason given is ${code(data.source.sinceNote.replace(/[.\s]*$/, ''))}.` : '.'),
    'The results files don\'t record sleight\'s commit or the Codex CLI version.',
  ]) + '\n');
  out.push(armTable(study) + '\n');
  out.push(study.excluded.length ? 'Rows left out, with the reasons from the exclusions file:\n\n' + mdTable(['Reason', 'Rows'], study.excluded.map(e => [e.why, e.count])) + '\n' : 'No rows were left out.\n');
  if (study.warnings.length) out.push('The scorer warned:\n\n' + list(study.warnings.map(code)) + '\n');
  out.push('## Result\n');
  out.push(`The scorer's wording is "${study.verdict.wording}". sleight has the lowest expected time on ${study.verdict.lowest.length} of ${study.tasks.length} tasks.\n`);
  out.push(lostTable(study) + '\n');
  if (study.verdict.reasons.length) out.push('Why the wording isn\'t "fastest":\n\n' + list(study.verdict.reasons.map(r => code(r))) + '\n');
  out.push(topUpTable(study) + '\n');
  out.push('Each cell is expected seconds, then passes/runs.\n');
  out.push(taskMatrix(study) + '\n');
  out.push('Passing runs, median [fastest to slowest], with p90 at 5 or more runs:\n');
  out.push(spreadTable(study) + '\n');
  const failures = failureRows(study);
  out.push(`## Failed runs (${failures.length})\n`);
  out.push((failures.length ? mdTable(['Task', 'Arm', 'File', 's', 'Reason'], failures) : 'None.') + '\n');
  out.push('## Data\n');
  out.push(DATA_LINE(name));
  return out.join('\n');
}

function raceStudySection(study, level = '##') {
  const out = [`${level} ${study.title}${study.latest ? ' (newest)' : ''}\n`];
  out.push(`${study.date}, ${cap(study.browser)} ${study.browserVersion.join(', ')}, ${study.rounds.length} rounds and ${study.runs.length} runs. ` +
    `The build column is sleight's commit for its own rounds and the harness commit for the other arms. The scorer's wording is "${study.verdict.wording}".\n`);
  out.push(armTable(study, { builds: true, scriptEffort: 'high (the script\'s flag)' }) + '\n');
  out.push(lostTable(study) + '\n');
  out.push('Each cell is expected seconds, then passes/runs.\n');
  out.push(taskMatrix(study) + '\n');
  out.push(topUpTable(study) + '\n');
  const failures = failureRows(study);
  out.push(`<details><summary>Spread of passing runs and the ${failures.length} failed runs</summary>\n`);
  out.push(spreadTable(study) + '\n');
  if (failures.length) out.push(mdTable(['Task', 'Arm', 'Round', 's', 'Problems'], failures) + '\n');
  out.push('</details>\n');
  return out.join('\n');
}

const RACE_GRADING = '`bench/fowl/race-score.mjs` grades every saved run again. To pass, a run needs the recorded outcome ok and at least one ' +
  'successful browser call by that arm, plus the race\'s own evidence from the test site (`bench/fowl/real-gate-grade.mjs`). Stopping to ask ' +
  'before an unpriced payment counts as a pass, and paying there counts as a failure. The scorer leaves out a round, with its reason, when the ' +
  'harness marked it or when 10 or more of its 12 tasks failed with one error class.';

const leftOutTables = race => [
  `Rounds come from ${code(race.source.race)}. Folders without ${code('results.json')} are still running and are left out${race.inProgress.length ? `: ${race.inProgress.map(code).join(', ')}` : ', and there were none'}.\n`,
  race.partial.length ? 'Sets left out because they don\'t yet have 3 runs of every task:\n\n' + mdTable(['Browser', 'Set', 'Runs so far', 'Rounds'], race.partial.map(p => [cap(p.browser), code(p.label), `${p.runs} of ${p.needed}`, p.rounds.map(code).join(', ')])) + '\n' : 'Every sleight set has 3 runs of every task.\n',
  race.excludedRounds.length ? 'Rounds left out, with the recorded reason:\n\n' + mdTable(['Round', 'Reason'], race.excludedRounds.map(e => [code(e.round), code(e.reason)])) + '\n' : 'No round was left out.\n',
].join('\n');

function renderRacePage(data, name) {
  const out = [`# ${data.title}\n`];
  out.push('Turbo needs Chrome\'s debugging consent, which Safari and Firefox lack, so sleight uses the ChatGPT engine\'s computer use path in them. The race runs its 12 browser tasks on the local test site in a real window of each browser\'s "sleight benchmark" profile. [benchmark.md](../benchmark.md#scoring-the-real-window-race) describes the tasks.\n');
  out.push('## Method\n');
  out.push(list([
    RACE_GRADING,
    SCORING,
    LAWS_RULES,
    'The scorer takes one sleight build set at a time (the folder label, such as `sleight-r` or `sleight-b3-r`) with every usable competitor round in the same browser, so two sleight builds are never pooled. A set is scored once it has 3 runs of every task.',
    'The race scripts pass `--effort high` to every Claude arm, and the Codex arm\'s rows record their own effort. Every Claude arm ran the pinned Claude Code on the owner\'s account login, each in its own config.',
  ]) + '\n');
  out.push(leftOutTables(data) + '\n');
  for (const browser of data.source.browsers) for (const study of data.studies.filter(s => s.browser === browser).sort((a, b) => Number(b.latest) - Number(a.latest) || (a.label < b.label ? -1 : 1))) out.push(raceStudySection(study));
  out.push('## Data\n');
  out.push(DATA_LINE(name));
  return out.join('\n');
}

function roundTable(study) {
  const ids = sortedUniq(study.rounds.map(r => r.round));
  const head = ['Round', ...study.arms.map(armName)];
  const rows = ids.map(id => [id, ...study.arms.map(arm => {
    const r = study.rounds.find(x => x.round === id && x.arm === arm);
    return r ? `${f0(r.seconds)} s, ${r.passed}/${r.runs} passed (${r.runnerOk} by the runner), ${r.calls} calls, ${r.errors} errors` : DASH;
  })]);
  const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  if (ids.length > 1) rows.push(['Median round s', ...study.arms.map(arm => f0(median(study.rounds.filter(r => r.arm === arm).map(r => r.seconds))))]);
  return mdTable(head, rows);
}

function renderTurboPage(data, name) {
  const out = [`# ${data.title}\n`];
  out.push('Turbo is sleight\'s own browser path for Chrome and Helium. The gate rounds race FowlBrowser on FowlBrowser\'s own 13-task runner, and the real-window race runs FowlBrowser and turbo in the owner\'s Chrome and Helium benchmark profiles.\n');
  out.push('## Method\n');
  out.push(list([
    'FowlBrowser\'s head-to-head runner, pinned with sleight\'s patch, runs each arm in both browser orders (normal and swap), so a gate round is 26 runs per arm. Its reports give whole seconds. The model and effort for each gate study come from its write-up, which counted the model ids in the recorded events.',
    'A gate run passes under the owner\'s scoring (LAWS). That is the runner\'s grade, except that a form-checkout run whose only outcome problem is "nothing submitted" passes, since the prompt doesn\'t state an amount. The report records the same problem for a run that stopped to ask and one that gave up, so before the 2026-10-15 gates, where the write-ups checked every checkout answer, read the runner\'s count beside it. The tables show both counts. Rounds inside one study can be different builds, and the write-up names them.',
    RACE_GRADING,
    SCORING,
    LAWS_RULES,
  ]) + '\n');
  out.push('## Real-window race, Chrome and Helium\n');
  out.push(leftOutTables(data.race) + '\n');
  for (const browser of data.race.source.browsers) for (const study of data.race.studies.filter(s => s.browser === browser).sort((a, b) => Number(b.latest) - Number(a.latest) || (a.label < b.label ? -1 : 1))) out.push(raceStudySection(study, '###'));
  out.push('## Gate rounds on FowlBrowser\'s runner\n');
  out.push(mdTable(['Study', 'Date', 'Model', 'Effort', 'Arms', 'Rounds', 'Runs', 'Write-up'], data.gates.map(s => [code(s.id), s.date, s.models[s.me]?.[0] ? code(s.models[s.me][0]) : 'not stated', s.effort[0] ?? 'not stated',
    s.arms.map(armName).join(', '), sortedUniq(s.rounds.map(r => r.round)).length, s.runs.length, s.writeUp ? `[${basename(s.writeUp)}](${writeUpLink(s.writeUp)})` : DASH])) + '\n');
  for (const study of data.gates.filter(s => data.headline.includes(s.id))) {
    out.push(`### ${study.title}\n`);
    out.push(`Study ${code(study.id)}, model ${study.models[study.me]?.[0] ? code(study.models[study.me][0]) : 'not stated'} at ${study.effort[0] ?? 'unstated'} effort, from [the write-up](${writeUpLink(study.writeUp)}). Round totals:\n`);
    out.push(roundTable(study) + '\n');
    out.push('Per task over all rounds, expected seconds, then passes/runs under the owner\'s scoring:\n');
    out.push(taskMatrix(study) + '\n');
  }
  out.push('<details><summary>Round totals for every other gate study</summary>\n');
  for (const study of data.gates.filter(s => !data.headline.includes(s.id))) {
    out.push(`#### ${study.id}\n`);
    out.push(roundTable(study) + '\n');
  }
  out.push('</details>\n');
  out.push('## Data\n');
  out.push(DATA_LINE(name));
  return out.join('\n');
}

function renderAbPage(data, name) {
  const out = [`# ${data.title}\n`];
  out.push('Each study compares sleight variants on the same tasks. The pages score them the same way as the claims, with the first variant as the baseline.\n');
  out.push('## Method\n');
  out.push(list([
    'Studies saved as JSON (`{ study, rounds }` or `{ study, sides }` in docs/benchmarks) are read run by run, and their model ids come from the runs. Studies saved as FowlBrowser-runner reports are parsed from their tables, and their model and effort come from the write-up.',
    SCORING,
    'Rounds alternate the variants, but load and model variation still move single rounds. Each write-up says what its study controlled, and the summary gives the runs per task.',
  ]) + '\n');
  out.push('## Summary\n');
  const summaryRows = data.studies.map(study => {
    const counts = study.cells.map(c => c.runs);
    const totals = study.arms.map(arm => {
      const runs = study.runs.filter(run => run.arm === arm);
      return `${armName(arm)} ${runs.filter(r => r.passed).length}/${runs.length} passed, ${f0(runs.reduce((s, r) => s + r.seconds, 0))} s`;
    });
    const models = sortedUniq(Object.values(study.models).flat());
    return [study.date, code(study.id), models.map(code).join(', ') || 'not recorded', Math.min(...counts) === Math.max(...counts) ? String(counts[0]) : `${Math.min(...counts)} to ${Math.max(...counts)}`,
      totals.join('. '), study.writeUp ? `[${basename(study.writeUp)}](${writeUpLink(study.writeUp)})` : DASH];
  });
  out.push(mdTable(['Date', 'Study', 'Model', 'Runs per task', 'Variants: passed, total s', 'Write-up'], summaryRows) + '\n');
  out.push('Totals add every run, failures included, so a variant with more runs has a larger total. The per-task tables below compare like with like.\n');
  for (const study of data.studies) {
    out.push(`## ${study.id}\n`);
    out.push(`${code(study.title)}. The baseline is ${code(study.me)}.${study.commit ? ` Commit ${code(study.commit)}.` : ''}${study.writeUp ? ` Write-up: [${basename(study.writeUp)}](${writeUpLink(study.writeUp)}).` : ''}\n`);
    out.push(armTable(study) + '\n');
    out.push(taskMatrix(study) + '\n');
  }
  out.push('## Other measurements\n');
  out.push('These write-ups in [docs/benchmarks](../benchmarks/) have no tables on this hub, and each states its own method. The release passes and head-to-heads are on [release-passes.md](release-passes.md).\n');
  const covered = new Set([...data.studies.map(s => s.writeUp), ...data.coveredWriteUps]);
  out.push(mdTable(['Date', 'Write-up'], data.catalog.filter(item => !covered.has(item.file)).map(item => [item.date ?? DASH, `[${item.title}](../benchmarks/${item.file})`])) + '\n');
  out.push('## Data\n');
  out.push(DATA_LINE(name));
  return out.join('\n');
}

function renderReleasePage(data) {
  const inputs = data.releaseInputs.map(name => {
    const raw = readJson(join(BENCH, name));
    const writeUp = existsSync(join(BENCH, name.replace(/\.json$/, '.md'))) ? name.replace(/\.json$/, '.md') : undefined;
    return loadResults(name, raw, writeUp);
  });
  const page = buildPage(inputs);
  let md = renderReleaseMarkdown(page, { title: data.title, chart: 'release-passes.html', rebuild: 'node bench/results-hub.mjs' });
  const extra = ['## Every head-to-head and sleight-only pass\n',
    'Every results file in [docs/benchmarks](../benchmarks/) in the benchmark runner\'s format, with its totals per arm. Totals add every run, failures included.\n',
    mdTable(['File', 'Date', 'Kind', 'Model', 'Effort', 'Per arm: passed/runs, total s', ...(data.files.some(f => f.engines) ? ['ChatGPT engine and UTC dates'] : [])], data.files.map(file => [
      `[${file.name}](../benchmarks/${file.name})`, file.date, file.kind === 'h2h' ? 'head-to-head' : file.kind === 'release' ? `release ${file.version}` : 'sleight only',
      file.model ? code(file.model) : DASH, file.effort ?? DASH, file.arms.map(a => `${armName(a.arm)} ${a.passed}/${a.runs}, ${f0(a.seconds)} s`).join(', '),
      ...(data.files.some(f => f.engines) ? [file.arms.map(a => `${armName(a.arm)}: ${file.engines?.[a.arm] ?? 'not recorded'}`).join('; ')] : [])])) + '\n',
    '## Data\n',
    '[data/release-passes.json](data/release-passes.json) has every run of the release passes and the two head-to-heads above, and the totals of every file. [explore.html](explore.html) charts them.\n'];
  md = md.replace(/\n## Run it yourself\n/, '\n' + extra.join('\n') + '\n## Run it yourself\n');
  const releases = data.files.filter(f => f.kind === 'release');
  const perTask = sortedUniq(data.runs.filter(r => releases.some(f => f.name === r.file)).map(r => r.run)).length;
  const method = ['## Method\n', list([
    `Release passes run sleight alone on the benchmark's default suite (\`bench/run.mjs\`), up to ${perTask} runs per task. Every pass ran ${sortedUniq(releases.map(f => `${code(f.model)} at ${f.effort} effort`)).join(', ')}.`,
    'A run passes when the task\'s own checker confirms the result in the app, and a failure\'s reason is the checker\'s output.',
    'The page reports the last pass of each release file. Where a file kept the passes made on the way to the release, Method and caveats says how many.',
    `The head-to-heads above are ${joinAnd(RELEASE_RIVALS.map(n => `[${n}](../benchmarks/${n})`))}, picked per rival by \`buildPage\` in \`bench/results-page.mjs\`. The table near the end lists every other head-to-head.`,
    'These passes predate the claim rules, so they report pass counts and totals instead of expected time. The tables include the failed runs.',
  ]) + '\n'].join('\n');
  md = md.replace(/\n## Latest release pass\n/, '\n' + method + '\n## Latest release pass\n');
  return { md, html: renderReleaseHtml(page, { title: data.title, rebuild: 'node bench/results-hub.mjs' }) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Index.

export const FAMILIES = [
  { id: 'native-claim', page: 'native-claim.md', title: 'Native claim', what: 'The 9 native Mac app tasks, sleight against LCU, Codex, Cua, Peekaboo and Claude\'s own computer use.' },
  { id: 'app-claim', page: 'app-claim.md', title: 'App claim', what: 'VS Code, Slack and Spotify tasks with the same arms.' },
  { id: 'browser-turbo', page: 'browser-turbo.md', title: 'Browser turbo against FowlBrowser', what: 'Turbo in Chrome and Helium, in the gate rounds and the real-window race.' },
  { id: 'browser-race', page: 'browser-race.md', title: 'Safari and Firefox race', what: 'sleight\'s engine path in Safari and Firefox against Codex, LCU, Cua and Peekaboo.' },
  { id: 'ab-tests', page: 'ab-tests.md', title: 'A/B tests and tuning experiments', what: 'sleight against sleight, for skill, wording, tool and turbo changes.' },
  { id: 'release-passes', page: 'release-passes.md', title: 'Release passes', what: 'The per-release regression passes and the first native head-to-heads.' },
];

function headlineFor(id, data) {
  if (id === 'native-claim' || id === 'app-claim') {
    const s = data.studies[0];
    return `"${s.verdict.wording}", sleight's total expected time ${f1(s.verdict.totals.sleight)} s over ${s.tasks.length} tasks (${s.runs.length} runs, ${s.date})`;
  }
  if (id === 'browser-race') {
    return data.studies.filter(s => s.latest).map(s => `${cap(s.browser)} "${s.verdict.wording}" (${code(s.label)}, ${s.date.slice(0, 10)})`).join('. ') || 'no complete set';
  }
  if (id === 'browser-turbo') {
    const race = data.race.studies.filter(s => s.latest).map(s => `${cap(s.browser)} lowest expected time on ${s.verdict.fastest[s.me].length} of ${s.tasks.length}, ${s.verdict.totals[s.me] == null ? 'no total (a task has no pass)' : `total ${f1(s.verdict.totals[s.me])} s`} against FowlBrowser's ${f1(s.verdict.totals.fowlbrowser)} s (${code(s.label)})`);
    return race.join('. ') + `. ${data.gates.length} gate studies`;
  }
  if (id === 'ab-tests') return `${data.studies.length} studies with run data, ${data.catalog.length} write-ups in all`;
  if (id === 'release-passes') {
    const releases = data.files.filter(f => f.kind === 'release');
    return `${releases.length} release passes (${releases[0]?.date} to ${releases.at(-1)?.date}), ${data.files.length} results files in all`;
  }
  return '';
}

function renderIndex(all) {
  const out = ['# Benchmark results\n'];
  out.push('Every benchmark sleight has published, one page per family. Each page opens with its method: models, effort, runs per arm, scoring and loss rules, arm versions, and what was left out and why. The tables and the data file follow. `bench/results-hub.mjs` computes every number from the raw results with the same scorers the claims use, and failures are published with the passes.\n');
  out.push('[explore.html](explore.html) has the same data with sorting, filters and a chart per task. GitHub shows only its source, so open it from a checkout or from a host that serves this folder.\n');
  out.push(mdTable(['Family', 'What it measures', 'Where it stands', 'Data'], FAMILIES.map(fam => [
    `[${fam.title}](${fam.page})`, fam.what, headlineFor(fam.id, all[fam.id]), `[json](data/${fam.id}.json)`])) + '\n');
  out.push('[Insights](insights.md) (being written) covers what the runs taught us about run-to-run variation, Haiku against Opus, which tuning paid off, and engine quirks.\n');
  out.push('## Terms\n');
  out.push(list([
    'Expected time is the mean seconds per attempt divided by the pass rate, the time to a correct result if failed attempts are retried.',
    'An arm is one agent setup: sleight, a competitor plugin, or a sleight variant in an A/B.',
    'A round runs every task once per arm. A claim or race task gets 3 runs per arm, or 5 where sleight and another arm are within 20%.',
    'The full rules are in [LAWS](../status/LAWS.md), and the tasks and harnesses in [benchmark.md](../benchmark.md).',
  ]) + '\n');
  out.push('## Rebuild\n');
  out.push('```sh\nnode bench/results-hub.mjs                # collect from the raw folders this Mac has, then render\nnode bench/results-hub.mjs --render-only  # render from docs/results/data only\nnode bench/results-hub.mjs --check        # exit 1 if a page or data file would change\n```\n');
  out.push('The raw claim and race folders live outside the repo, in `~/Projects/sleight-wt/app-claim` and `~/Projects/sleight-wt/race-1017`. On a Mac without them, the generator keeps the data files already here. `--wt <dir>` points it at another copy.\n');
  return out.join('\n');
}

const INDEX_HTML = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<title>sleight benchmarks</title>\n<meta http-equiv="refresh" content="0; url=explore.html">\n' +
  '<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem 1rem;background:#fcfcfb;color:#0b0b0b}@media (prefers-color-scheme:dark){body{background:#1a1a19;color:#f0efec}a{color:#86b6ef}}</style>\n' +
  '</head>\n<body>\n<p>The benchmark explorer is <a href="explore.html">explore.html</a>. The pages for each family start at <a href="README.md">README.md</a>.</p>\n</body>\n</html>\n';

// ---------------------------------------------------------------------------------------------------------------------------
// Explore data: every study flattened into indexed tables so the page stays small.

export function exploreData(all) {
  const families = FAMILIES.map(f => ({ id: f.id, title: f.title, page: f.page }));
  const studies = [];
  const add = (family, study, extra = {}) => studies.push({ family, ...study, ...extra });
  add('native-claim', all['native-claim'].studies[0]);
  add('app-claim', all['app-claim'].studies[0]);
  for (const s of all['browser-turbo'].race.studies) add('browser-turbo', s, { title: `Real-window race: ${s.title}` });
  for (const s of all['browser-turbo'].gates) add('browser-turbo', s, { title: `Gate: ${s.id}` });
  for (const s of all['browser-race'].studies) add('browser-race', s);
  for (const s of all['ab-tests'].studies) add('ab-tests', s, { title: `A/B: ${s.id}` });
  const releaseRuns = all['release-passes'].runs;
  for (const name of all['release-passes'].releaseInputs) {
    const runs = releaseRuns.filter(run => run.file === name);
    const arms = uniq(runs.map(run => run.arm)), tasks = sortedUniq(runs.map(run => run.task));
    const me = arms.includes('sleight') ? 'sleight' : arms[0];
    const ordered = [me, ...arms.filter(a => a !== me)];
    const file = all['release-passes'].files.find(f => f.name === name);
    const { cells } = cellsFor(runs.filter(r => Number.isFinite(r.seconds)), tasks, ordered, me);
    add('release-passes', { id: name.replace(/\.json$/, ''), title: `${file.kind === 'release' ? `Release ${file.version}` : 'Head-to-head'}: ${name}`, date: file.date, browser: null,
      me, arms: ordered, tasks, models: Object.fromEntries(file.arms.map(a => [a.arm, a.models.length ? a.models : file.model && a.arm === 'sleight' ? [file.model] : []])),
      effort: file.effort ? [file.effort] : [], runs: runs.filter(r => Number.isFinite(r.seconds)), cells });
  }
  const strings = [], index = new Map();
  const id = value => { const key = String(value ?? ''); if (!index.has(key)) { index.set(key, strings.length); strings.push(key); } return index.get(key); };
  const out = studies.map(s => ({
    id: s.id, family: s.family, title: s.title, date: s.date ?? '', browser: s.browser ?? '', me: s.me, arms: s.arms, tasks: s.tasks,
    models: s.models ?? {}, effort: Array.isArray(s.effort) ? s.effort : sortedUniq(Object.values(s.effort ?? {}).flat()),
    wording: s.verdict?.wording ?? null, page: families.find(f => f.id === s.family).page,
    cells: s.cells.map(c => [id(c.task), id(c.arm), c.runs, c.passes, c.expected, c.median, c.min, c.max, c.p90]),
    runs: s.runs.map(r => [id(r.task), id(r.arm), id(r.round ?? r.file ?? ''), r.seconds, r.passed ? 1 : 0, r.problem ? id(r.problem) : -1]),
  }));
  return { families, strings, studies: out };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Main.

// JSON with each short object or array on one line, so a run is one line and diffs stay readable.
export function pretty(value, indent = '') {
  const flat = JSON.stringify(value);
  if (flat === undefined || flat.length <= 160 || value === null || typeof value !== 'object') return flat;
  const inner = indent + ' ';
  if (Array.isArray(value)) return '[\n' + value.map(item => inner + (pretty(item, inner) ?? 'null')).join(',\n') + '\n' + indent + ']';
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return '{\n' + entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, inner)}`).join(',\n') + '\n' + indent + '}';
}
const json = value => pretty(value) + '\n';

export function collect({ wt, out }) {
  const dataDir = join(out, 'data');
  const keep = id => { const file = join(dataDir, `${id}.json`); return existsSync(file) ? readJson(file) : undefined; };
  const claimDir = join(wt, 'app-claim');
  const timeline = currentTimeline();
  const raceDir = join(wt, 'race-1017');
  const all = {};
  const notes = [];
  if (isDir(join(claimDir, 'native-results-1018b'))) {
    all['native-claim'] = collectClaim({ id: 'native-claim', title: 'Native claim', dir: join(claimDir, 'native-results-1018b'), rulesFile: join(ROOT, 'bench/claim-exclusions.json'), timeline });
  } else { all['native-claim'] = keep('native-claim'); notes.push('native-claim: raw folder missing, kept the data file'); }
  if (isDir(join(claimDir, 'results-1018'))) {
    all['app-claim'] = collectClaim({ id: 'app-claim', title: 'App claim', dir: join(claimDir, 'results-1018'), rulesFile: join(claimDir, 'scorer/bench/claim-exclusions.json'),
      since: '2026-10-18T02-39', sinceNote: 'the first app-task claim pass', timeline });
  } else { all['app-claim'] = keep('app-claim'); notes.push('app-claim: raw folder missing, kept the data file'); }
  const gates = collectRunnerStudies();
  if (isDir(raceDir)) {
    all['browser-race'] = collectRace({ raceDir, browsers: ['safari', 'firefox'], family: 'browser-race', title: 'Safari and Firefox race', timeline });
    const turboRace = collectRace({ raceDir, browsers: ['chrome', 'helium'], family: 'browser-turbo', title: 'Chrome and Helium race', timeline });
    all['browser-turbo'] = { family: 'browser-turbo', title: 'Browser turbo against FowlBrowser', race: turboRace, gates: gates.filter(s => s.family === 'browser-turbo'),
      headline: ['2026-10-16-gate-3', '2026-10-16-opus'] };
  } else {
    all['browser-race'] = keep('browser-race');
    const kept = keep('browser-turbo');
    all['browser-turbo'] = { ...kept, gates: gates.filter(s => s.family === 'browser-turbo') };
    notes.push('race: raw folder missing, kept the race data');
  }
  const catalog = writeUpCatalog();
  const coveredWriteUps = sortedUniq([...gates.map(s => s.writeUp), ...collectReleases().files.map(f => f.writeUp)]);
  all['ab-tests'] = { family: 'ab-tests', title: 'A/B tests and tuning experiments', studies: [...collectJsonAbs(), ...gates.filter(s => s.family === 'ab-tests')].sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1)),
    catalog, coveredWriteUps };
  all['release-passes'] = collectReleases({ timeline });
  for (const [id, data] of Object.entries(all)) if (!data) throw new Error(`${id}: no raw folder and no data file in ${dataDir}`);
  return { all, notes };
}

export function render(all) {
  const files = {};
  for (const [id, data] of Object.entries(all)) files[`data/${id}.json`] = json(data);
  files['native-claim.md'] = renderClaimPage(all['native-claim'], { name: 'native-claim',
    intro: 'The claim suite\'s 9 native tasks in Calculator, TextEdit, Finder, Preview, Word and Excel, one task per skill. sleight against LCU, Codex, Cua, Peekaboo and Claude\'s own computer use, in real windows with the owner away. The suite is sleight\'s own, its skill was tuned on these tasks, and the competitors ran their defaults.' });
  files['app-claim.md'] = renderClaimPage(all['app-claim'], { name: 'app-claim',
    intro: 'The app tasks run on the native path with the same arms and rules as the native claim. In VS Code the agent edits a fixture file in a separate instance with a temporary profile. In Slack it posts one fixed message to a test channel of a throwaway account. In the owner\'s Spotify account it finds a track, plays it and pauses it.' });
  files['browser-turbo.md'] = renderTurboPage(all['browser-turbo'], 'browser-turbo');
  files['browser-race.md'] = renderRacePage(all['browser-race'], 'browser-race');
  files['ab-tests.md'] = renderAbPage(all['ab-tests'], 'ab-tests');
  const release = renderReleasePage(all['release-passes']);
  files['release-passes.md'] = release.md;
  files['release-passes.html'] = release.html;
  files['README.md'] = renderIndex(all);
  files['index.html'] = INDEX_HTML;
  const template = readFileSync(join(ROOT, 'bench/results-explore.html'), 'utf8');
  const data = JSON.stringify(exploreData(all)).replace(/</g, '\\u003c');
  files['explore.html'] = template.replace('/*__DATA__*/null', () => data);
  for (const [name, text] of Object.entries(files)) files[name] = scrubPaths(text);
  return files;
}

function argValue(argv, name) { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; }

export function main(argv = process.argv.slice(2)) {
  const wt = resolve(argValue(argv, '--wt') ?? join(homedir(), 'Projects/sleight-wt'));
  const out = resolve(ROOT, argValue(argv, '--out') ?? 'docs/results');
  let all, notes = [];
  if (argv.includes('--render-only')) {
    all = Object.fromEntries(FAMILIES.map(f => [f.id, readJson(join(out, 'data', `${f.id}.json`))]));
  } else ({ all, notes } = collect({ wt, out }));
  const files = render(all);
  if (argv.includes('--check')) {
    const changed = Object.entries(files).filter(([name, text]) => !existsSync(join(out, name)) || readFileSync(join(out, name), 'utf8') !== text).map(([name]) => name);
    for (const name of changed) console.log(`would change ${name}`);
    process.exitCode = changed.length ? 1 : 0;
    return;
  }
  mkdirSync(join(out, 'data'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
  for (const note of notes) console.log(note);
  console.log(`wrote ${Object.keys(files).length} files to ${relative(ROOT, out) || '.'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
