#!/usr/bin/env node
// Scores the native claim from bench/results/*.json with the exclusions written in bench/claim-exclusions.json, so anyone can
// rerun the table. Per arm and task: runs, passes, median seconds of passing runs, mean seconds per attempt, and expected seconds
// to a correct result (mean per attempt divided by pass rate). A task an arm never passed has no expected time.
//   node bench/claim-score.mjs [--since 2026-10-16T15-34] [--results <dir>] [--json]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(readFileSync(join(root, 'bench/claim-exclusions.json'), 'utf8'));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };

export function excluded(row, file, rules) {
  if (!rules.tasks.includes(row.task)) return 'not a claim task';
  if (row.skipped || row.seconds == null) return 'skipped';
  for (const r of rules.reasons) if (new RegExp(r.match, 'i').test(row.reason ?? '')) return r.why;
  for (const f of rules.files) if (file.startsWith(f.prefix) && (!f.arm || f.arm === row.arm)) return f.why;
  for (const w of rules.windows) if (w.tasks.includes(row.task) && file < w.before) return w.why;
  return undefined;
}

export function score(rows) {
  const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const out = {};
  for (const { arm, task, seconds, passed } of rows) (((out[arm] ??= {})[task] ??= { runs: [], passes: [] }).runs.push(seconds), passed && out[arm][task].passes.push(seconds));
  for (const tasks of Object.values(out)) for (const t of Object.values(tasks)) {
    t.mean = t.runs.reduce((a, b) => a + b, 0) / t.runs.length;
    t.median = median(t.passes);
    t.expected = t.passes.length ? t.mean / (t.passes.length / t.runs.length) : null;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const since = arg('--since') ?? rules.since, dir = arg('--results') ?? join(root, 'bench/results'), rows = [], dropped = {};
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json') && f >= since).sort()) {
    for (const row of JSON.parse(readFileSync(join(dir, file), 'utf8')).results ?? []) {
      const why = excluded(row, file, rules);
      if (why) { if (why !== 'not a claim task') dropped[why] = (dropped[why] ?? 0) + 1; continue; }
      rows.push({ arm: row.arm, task: row.task, seconds: row.seconds, passed: !!(row.passed || (row.cleanupContained && row.taskPassed)) });
    }
  }
  const table = score(rows);
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ since, dropped, table }, null, 1)); process.exit(0); }
  const arms = rules.arms.filter(a => table[a]);
  console.log(`Claim score since ${since}. Cell: expected s to a correct result (passes/runs), median of passes in brackets.`);
  console.log('task'.padEnd(20) + arms.map(a => a.padStart(22)).join(''));
  for (const task of rules.tasks) console.log(task.padEnd(20) + arms.map(a => {
    const t = table[a]?.[task];
    return (!t ? 'no runs' : !t.passes.length ? `never (0/${t.runs.length})` : `${t.expected.toFixed(0)} (${t.passes.length}/${t.runs.length}) [${t.median}]`).padStart(22);
  }).join(''));
  console.log('completed'.padEnd(20) + arms.map(a => `${rules.tasks.filter(t => table[a]?.[t]?.passes.length).length}/${rules.tasks.length}`.padStart(22)).join(''));
  console.log('Excluded rows:', JSON.stringify(dropped));
}
