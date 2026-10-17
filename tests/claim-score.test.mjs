import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claim, excluded, regradeFor, score, warnings } from '../bench/claim-score.mjs';

const rules = JSON.parse(readFileSync(new URL('../bench/claim-exclusions.json', import.meta.url), 'utf8'));

test('the claim score drops each written exclusion with its reason and keeps the rest', () => {
  assert.equal(excluded({ task: 'local-wikipedia', seconds: 9 }, '2026-10-16T20-00.json', rules), 'not a claim task');
  assert.match(excluded({ task: 'finder-move', arm: 'cua', seconds: 0, reason: 'Fixture setup failed: x' }, '2026-10-16T20-00.json', rules), /setup failed/);
  assert.match(excluded({ task: 'calculator-click', arm: 'lcu', seconds: 6 }, '2026-10-16T17-43-02.json', rules), /PreToolUse/);
  assert.equal(excluded({ task: 'calculator-click', arm: 'sleight', seconds: 6 }, '2026-10-16T17-43-02.json', rules), undefined);
  assert.match(excluded({ task: 'textedit-drag', arm: 'sleight', seconds: 30 }, '2026-10-16T18-53.json', rules), /overlay/);
  assert.equal(excluded({ task: 'textedit-drag', arm: 'sleight', seconds: 30 }, '2026-10-16T20-23.json', rules), undefined);
});

test('expected time is the mean attempt divided by the pass rate, and never-passed tasks have none', () => {
  const table = score([
    { arm: 'a', task: 't', seconds: 10, passed: true }, { arm: 'a', task: 't', seconds: 30, passed: false },
    { arm: 'b', task: 't', seconds: 5, passed: false },
  ]);
  assert.equal(table.a.t.expected, 40);
  assert.equal(table.a.t.median, 10);
  assert.equal(table.b.t.expected, null);
});

test('a window exclusion with an arm drops only that arm\'s rows', () => {
  const own = { tasks: ['excel-edit'], reasons: [], files: [], windows: [{ tasks: ['excel-edit'], arm: 'sleight', before: '2026-10-17T10-51', why: 'pre-fix' }] };
  assert.equal(excluded({ task: 'excel-edit', arm: 'sleight', seconds: 60 }, '2026-10-17T10-25-49.json', own), 'pre-fix');
  assert.equal(excluded({ task: 'excel-edit', arm: 'codex', seconds: 60 }, '2026-10-17T04-43-59.json', own), undefined);
  assert.equal(excluded({ task: 'excel-edit', arm: 'sleight', seconds: 60 }, '2026-10-17T10-51-44.json', own), undefined);
});

test('sleight exclusions name exact files, so a new run in the same hour is kept', () => {
  assert.equal(rules.files.some(f => f.prefix && (!f.arm || f.arm === 'sleight') && f.prefix >= rules.since), false);
  assert.match(excluded({ task: 'word-edit', arm: 'sleight', seconds: 80 }, '2026-10-17T15-20-09-591Z.json', rules), /experiment runs/);
  assert.equal(excluded({ task: 'word-edit', arm: 'sleight', seconds: 80 }, '2026-10-17T16-30-00-000Z.json', rules), undefined);
  assert.equal(excluded({ task: 'word-edit', arm: 'sleight', seconds: 80 }, '2026-10-17T15-20-09-592Z.json', rules), undefined);
});

const runs = (arm, task, secs, fails = 0) => secs.map((seconds, i) => ({ arm, task, seconds, passed: i >= fails }));
const own = { tasks: ['t1', 't2', 't3'], arms: ['sleight', 'a', 'b'] };
const base = () => [
  ...runs('sleight', 't1', [10, 10, 10, 10, 10]), ...runs('a', 't1', [11.5, 11.5, 11.5, 11.5, 11.5]), ...runs('b', 't1', [50, 50, 50]),
  ...runs('sleight', 't2', [10, 10, 10]), ...runs('a', 't2', [20, 20, 20]), ...runs('b', 't2', [50, 50, 50]),
  ...runs('sleight', 't3', [10, 10, 10]), ...runs('a', 't3', [30, 30, 30]), ...runs('b', 't3', [40, 40, 40], 3),
];

test('the claim says "fastest" with the majority, the lowest total and 5 runs on every close pair', () => {
  const c = claim(score(base()), own);
  assert.equal(c.wording, 'fastest');
  assert.deepEqual(c.reasons, []);
  assert.deepEqual(c.lowest, ['t1', 't2', 't3']);
  assert.deepEqual(c.totals, { sleight: 30, a: 61.5, b: null });
  const t1 = c.pairs.find(p => p.task === 't1' && p.arm === 'a');
  assert.ok(t1.withinMin && t1.withinMax);
  assert.deepEqual(t1.short, []);
  assert.equal(c.stats.sleight.t1.p90, 10);
  assert.equal(c.stats.sleight.t2.p90, null);
  assert.deepEqual(c.stats.sleight.t2.range, [10, 10]);
  assert.equal(c.stats.b.t3.passes, 0);
});

test('a pair within 20% only under /max needs the 5-run top-up, and its absence blocks "fastest"', () => {
  const rows = base().filter(r => !(r.arm === 'a' && r.task === 't2')).concat(runs('a', 't2', [12.4, 12.4, 12.4]));
  const c = claim(score(rows), own), p = c.pairs.find(p => p.task === 't2' && p.arm === 'a');
  assert.equal(c.strict, 'max');
  assert.equal(p.withinMin, false);
  assert.equal(p.withinMax, true);
  assert.deepEqual(p.short, ['sleight 3/5', 'a 3/5']);
  assert.equal(c.wording, 'completed every task, fastest on 3 of 3');
  assert.equal(c.reasons.length, 1);
  assert.match(c.reasons[0], /5 runs missing on 1 pair.*t2\/a \(sleight 3\/5, a 3\/5\)/);
  assert.equal(c.pairs.find(p => p.task === 't2' && p.arm === 'b').short, null);
});

test('without the majority or the lowest total the wording counts tasks, and a sleight never cell leaves no total', () => {
  const rows = base().filter(r => !(r.arm === 'a' && r.task !== 't1')).concat(runs('a', 't2', [5, 5, 5]), runs('a', 't3', [5, 5, 5]));
  const c = claim(score(rows), own);
  assert.deepEqual(c.lowest, ['t1']);
  assert.equal(c.wording, 'completed every task, fastest on 1 of 3');
  assert.match(c.reasons.join('\n'), /lowest expected time on 1 of 3; "fastest" needs 2/);
  assert.match(c.reasons.join('\n'), /total 30 s is not the lowest: a 22 s/);
  const never = claim(score(base().filter(r => !(r.arm === 'sleight' && r.task === 't3')).concat(runs('sleight', 't3', [10, 10, 10], 3))), own);
  assert.equal(never.totals.sleight, null);
  assert.match(never.wording, /^completed 2 of 3 tasks, fastest on 2 of 3/);
});

test('warnings flag sleight rows from more than one pass, same-hour prefixes and stale regrades', () => {
  const g = { file: 'f1.json', arm: 'claude-cu', task: 't1', run: 1, reason: 'r', why: 'w' };
  const rr = { reasons: [], files: [{ prefix: '2026-10-17T16', arm: 'sleight', why: 'x' }, { prefix: '2026-10-16T16', why: 'old' }], windows: [], regrades: [g] };
  const rows = [{ arm: 'sleight', file: 'f1.json' }, { arm: 'sleight', file: 'f1.json' }, { arm: 'sleight', file: 'f2.json' },
    { arm: 'claude-cu', task: 't1', run: 1, file: 'f1.json', passed: true }];
  const w = warnings(rows, rr, '2026-10-17T04-03');
  assert.equal(w.length, 3);
  assert.match(w[0], /prefix 2026-10-17T16 can catch/);
  assert.match(w[1], /from 2 passes: f1.json \(2\), f2.json \(1\)/);
  assert.match(w[2], /regrade f1.json claude-cu t1 #1 matches no included failed run/);
  assert.deepEqual(warnings([{ arm: 'sleight', file: 'f1.json' }, { arm: 'claude-cu', task: 't1', run: 1, file: 'f1.json', passed: false }], rr, '2026-10-18'), []);
});

test('a regrade replaces only the shown reason of the one run it names, and never excludes it', () => {
  const row = { arm: 'claude-cu', task: 'textedit-drag', run: 1, seconds: 40.8, passed: false, reason: 'approval required' };
  const file = '2026-10-17T15-51-43-164Z.json';
  assert.equal(excluded(row, file, rules), undefined);
  assert.match(regradeFor(row, file, rules).reason, /not moved/);
  assert.match(regradeFor(row, file, rules).why, /96e9347d/);
  assert.equal(regradeFor({ ...row, run: 2 }, file, rules), undefined);
  assert.equal(regradeFor(row, '2026-10-17T15-57-44-594Z.json', rules), undefined);
});

test('a run exclusion drops only the named run of that arm, task and file', () => {
  const rules = { tasks: ['textedit-calculator'], reasons: [], files: [], windows: [],
    runs: [{ file: 'f.json', arm: 'claude-cu', task: 'textedit-calculator', run: 2, why: 'harness stop' }] };
  assert.equal(excluded({ arm: 'claude-cu', task: 'textedit-calculator', run: 2, seconds: 6.9 }, 'f.json', rules), 'harness stop');
  for (const [row, file] of [[{ run: 1 }, 'f.json'], [{ run: 2 }, 'g.json'], [{ run: 2, arm: 'lcu' }, 'f.json']])
    assert.equal(excluded({ arm: 'claude-cu', task: 'textedit-calculator', seconds: 7, ...row }, file, rules), undefined);
});
