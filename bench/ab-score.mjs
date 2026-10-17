#!/usr/bin/env node
// Scores a sleight-vs-sleight A/B (bench/ab-sleight.sh) from each side's bench/results, split into the claim tasks and the
// held-out tasks: passes/runs, and per side the median turns, total s, model s, output tokens and prompt tokens of each task,
// summed over tasks. Rows whose model isn't --model are counted and left out, with the same reason rules as claim-score.
//   node bench/ab-score.mjs --old <results dir> --new <results dir> --since <stamp> [--model claude-haiku-5-5] [--json]
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const METRICS = {
  turns: r => r.turns, totalS: r => r.timing?.totalMs / 1000, modelS: r => r.timing?.modelMs / 1000,
  output: r => r.usage?.output, prompt: r => (r.usage?.input ?? 0) + (r.usage?.cacheRead ?? 0) + (r.usage?.cacheWrite ?? 0),
};

export function scoreSide(rows, claimTasks) {
  const tasks = {};
  for (const row of rows) (tasks[row.task] ??= []).push(row);
  const groups = { claim: {}, heldOut: {} };
  for (const [task, list] of Object.entries(tasks)) {
    const g = claimTasks.includes(task) ? groups.claim : groups.heldOut;
    g[task] = { runs: list.length, passes: list.filter(r => r.passed).length,
      ...Object.fromEntries(Object.entries(METRICS).map(([k, f]) => [k, median(list.map(f).filter(Number.isFinite))])) };
  }
  for (const g of Object.values(groups)) {
    const list = Object.values(g);
    g.total = { runs: 0, passes: 0, ...Object.fromEntries(Object.keys(METRICS).map(k => [k, 0])) };
    for (const t of list) for (const k of Object.keys(g.total)) g.total[k] += t[k] ?? 0;
  }
  return groups;
}

export function readRows(dir, since, model, reasons = []) {
  const rows = [], dropped = {};
  for (const file of readdirSync(dir).filter(f => /^\d{4}-.*\.json$/.test(f) && f >= since).sort()) {
    for (const row of JSON.parse(readFileSync(join(dir, file), 'utf8')).results ?? []) {
      if (row.arm !== 'sleight') continue;
      const why = row.skipped || row.seconds == null ? 'skipped'
        : !(row.models ?? []).every(m => m === model) ? `model ${(row.models ?? []).join('+') || 'unknown'}`
        : reasons.find(r => new RegExp(r.match, 'i').test(row.reason ?? ''))?.why;
      if (why) dropped[why] = (dropped[why] ?? 0) + 1; else rows.push(row);
    }
  }
  return { rows, dropped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const since = arg('--since'), model = arg('--model') ?? 'claude-haiku-5-5';
  if (!since || !arg('--old') || !arg('--new')) { console.error('usage: --old <dir> --new <dir> --since <stamp>'); process.exit(2); }
  const claim = readFileSync(join(root, 'bench/claim-tasks.txt'), 'utf8').trim().split(',');
  const reasons = JSON.parse(readFileSync(join(root, 'bench/claim-exclusions.json'), 'utf8')).reasons;
  const sides = Object.fromEntries(['old', 'new'].map(side => {
    const { rows, dropped } = readRows(arg(`--${side}`), since, model, reasons);
    return [side, { ...scoreSide(rows, claim), dropped }];
  }));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(sides, null, 1)); process.exit(0); }
  const fmt = v => v == null ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(1);
  for (const group of ['claim', 'heldOut']) {
    console.log(`\n${group}: task | old passes, turns, total s, model s, output, prompt | new ...`);
    const tasks = [...new Set([...Object.keys(sides.old[group]), ...Object.keys(sides.new[group])])].filter(t => t !== 'total').sort();
    for (const task of [...tasks, 'total']) {
      const cell = side => { const t = sides[side][group][task]; return t ? `${t.passes}/${t.runs}, ${['turns', 'totalS', 'modelS', 'output', 'prompt'].map(k => fmt(t[k])).join(', ')}` : '-'; };
      console.log(`${task} | ${cell('old')} | ${cell('new')}`);
    }
  }
  for (const side of ['old', 'new']) if (Object.keys(sides[side].dropped).length) console.log(`${side} dropped:`, JSON.stringify(sides[side].dropped));
}
