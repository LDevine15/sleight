#!/usr/bin/env node
// One table per model for a world-suite run: FowlBrowser report.md rows plus bench/run.mjs
// results JSON. Wall time is median and p90 over passing runs. An arm that the suite
// lists as unsupported is "not supported", not 0 s. Home paths print as ~.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BROWSER = new Set([
  'form-travel', 'form-settings', 'form-checkout', 'form-settings-helium', 'shipping-link',
  'size-guide', 'demoid', 'mobile', 'handoff', 'takeover', 'inject-order', 'inject-mail',
  'wikipedia', 'mdn', 'invoice-preview', 'table-textedit', 'note-textedit',
]);

export const scrubHome = (text, home = homedir()) => String(text ?? '').split(home).join('~');

export function loadSuite(file = join(dirname(fileURLToPath(import.meta.url)), 'suite.json')) {
  if (!existsSync(file)) return { byTask: new Map() };
  const suite = JSON.parse(readFileSync(file, 'utf8'));
  const byTask = new Map();
  for (const half of ['browser', 'native', 'handoff']) {
    for (const task of suite[half] ?? []) byTask.set(task.task, task);
  }
  return { byTask, suite };
}
const SUITE = loadSuite();

const round1 = (n) => Math.round(n * 10) / 10;
const sorted = (values) => values.filter(Number.isFinite).sort((a, b) => a - b);
export function median(values) {
  const a = sorted(values), n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
export function p90(values) {
  const a = sorted(values), n = a.length;
  if (!n) return null;
  return a[Math.max(0, Math.ceil(0.9 * n) - 1)];
}

export function halfOf(run) {
  const fromSuite = SUITE.byTask.get(run.task);
  if (fromSuite?.half === 'cross-app') return 'cross-app';
  if (fromSuite?.half === 'native' || fromSuite?.half === 'browser') return fromSuite.half;
  if (run.half === 'native' || run.half === 'browser' || run.half === 'cross-app') return run.half;
  if (run.surface === 'native') return 'native';
  if (run.surface && run.surface !== 'native') return 'browser';
  return BROWSER.has(run.task) ? 'browser' : 'native';
}

function armSupported(task, armName) {
  const spec = SUITE.byTask.get(task);
  if (!spec?.support) return undefined;
  const base = String(armName).replace(/ \(.+\)$/, '');
  if (Object.prototype.hasOwnProperty.call(spec.support, base)) return !!spec.support[base];
  return undefined;
}

const tokensOf = (run) => {
  if (Number.isFinite(run.tokens)) return run.tokens;
  const u = run.usage;
  if (!u) return undefined;
  return (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
};

function overBudget(raw) {
  return raw.overBudget === true || /over.?budget/i.test(raw.reason ?? raw.outcome ?? '');
}

function callsOf(raw) {
  if (Number.isFinite(raw.calls)) return raw.calls;
  if (Number.isFinite(raw.toolCalls)) return raw.toolCalls;
  if (Array.isArray(raw.toolCalls)) return raw.toolCalls.length;
}

function timedOut(raw) {
  return raw.timedOut === true || /^(timeout|timed out)\b/i.test(String(raw.reason ?? ''));
}

export function parseFowlReport(text, { model, run = 1 } = {}) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!/^\| [a-z]/.test(line) || /^\| agent/.test(line)) continue;
    const raw = line.split('|').map(x => x.trim());
    if (raw[0] === '') raw.shift();
    if (raw.at(-1) === '') raw.pop();
    if (raw.length < 14) continue;
    const task = raw[0], arm = raw[1];
    const outcome = raw.slice(3, -10).join('|');
    const checks = raw.at(-10);
    const timeCol = raw.at(-4) ?? '';
    const time = Number(/^(\d+)/.exec(timeCol)?.[1]);
    const netBudget = /(\d+)\s*s net\s*\/\s*(\d+)/.exec(timeCol);
    const net = netBudget ? Number(netBudget[1]) : undefined;
    const limit = netBudget ? Number(netBudget[2]) : undefined;
    const overTime = Number.isFinite(net) && Number.isFinite(limit) && net > limit;
    const calls = Number(/(\d+)\s+calls/.exec(raw.at(-3) ?? '')?.[1]);
    const tokens = Number(/total (\d+)/.exec(raw.at(-2) ?? '')?.[1]);
    const cost = Number.parseFloat(raw.at(-1));
    const passed = /^(ok|pass)\b/i.test(outcome);
    const budget = overTime || /over.?budget/i.test(outcome) || /over.?budget/i.test(checks ?? '');
    rows.push({
      model, arm, task, run, half: 'browser',
      passed,
      overBudget: budget,
      clean: passed && /^(ok|pass)\b/i.test(checks ?? '') && !budget,
      seconds: Number.isFinite(time) ? time : undefined,
      calls: Number.isFinite(calls) ? calls : undefined,
      turns: undefined,
      tokens: Number.isFinite(tokens) ? tokens : undefined,
      costUsd: Number.isFinite(cost) ? cost : undefined,
    });
  }
  return rows;
}

export function variantFromDir(name) {
  const bits = [];
  if (/(?:^|-)min(?:-|$)/.test(name)) bits.push('min');
  else if (/(?:^|-)lean(?:-|$)/.test(name)) bits.push('lean');
  if (/(?:^|-)swap(?:-|$)/.test(name)) bits.push('swap');
  return bits.length ? bits.join(', ') : undefined;
}

function asRun(raw, fallback = {}) {
  if (!raw || raw.skipped || raw.dryRun || raw.phase) return;
  const task = raw.task ?? raw.name;
  const arm = raw.arm ?? raw.surface;
  if (!task || !arm) return;
  const variant = fallback.pool ? undefined : (raw.variant ?? raw.env?.SLEIGHT_ENGINE_DOCS ?? raw.order ?? fallback.variant);
  const tokens = tokensOf(raw);
  return {
    model: raw.model ?? fallback.model ?? 'unknown',
    arm: variant != null && variant !== '' ? `${arm} (${variant})` : arm, task, run: raw.run ?? fallback.run ?? 1,
    passed: raw.passed === true,
    clean: raw.clean === true || (raw.passed === true && raw.clean !== false && !overBudget(raw)),
    seconds: raw.seconds,
    calls: callsOf(raw),
    turns: Number.isFinite(raw.turns) ? raw.turns : Number.isFinite(raw.num_turns) ? raw.num_turns : undefined,
    tokens: Number.isFinite(tokens) ? tokens : undefined,
    costUsd: Number.isFinite(raw.costUsd) ? raw.costUsd : undefined,
    surface: raw.surface, half: raw.half, reason: raw.reason,
    variant, timedOut: timedOut(raw), overBudget: overBudget(raw),
  };
}

export function loadSources(paths, { pool = false, warn = console.error } = {}) {
  const rows = [];
  const warnings = [];
  const note = msg => { warnings.push(msg); warn(msg); };
  let fowlRun = 0;
  for (const path of paths) {
    if (path.endsWith('.log')) {
      throw new Error(`WORLD-REPORT: ${path} is a log file; pass report.md or results JSON`);
    }
    const st = statSync(path);
    if (st.isDirectory()) {
      const md = join(path, 'report.md');
      if (!existsSync(md)) {
        note(`WORLD-REPORT: no report.md in ${path}`);
        continue;
      }
      fowlRun += 1;
      const model = existsSync(join(path, 'model'))
        ? readFileSync(join(path, 'model'), 'utf8').trim()
        : modelFromEvents(path) ?? 'unknown';
      const variant = pool ? undefined : variantFromDir(basename(path));
      const parsed = parseFowlReport(readFileSync(md, 'utf8'), { model, run: fowlRun });
      for (const row of parsed) {
        if (variant) row.arm = `${row.arm} (${variant})`;
        row.variant = variant;
      }
      rows.push(...parsed);
      continue;
    }
    if (path.endsWith('.md')) {
      fowlRun += 1;
      rows.push(...parseFowlReport(readFileSync(path, 'utf8'), { model: 'unknown', run: fowlRun }));
      continue;
    }
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(raw.results) ? raw.results : Array.isArray(raw) ? raw : [];
    for (const item of list) {
      const row = asRun(item, { model: raw.model, run: item?.run, pool, variant: pool ? undefined : variantFromDir(basename(path)) });
      if (row) rows.push(row);
    }
  }
  rows.warnings = warnings;
  return rows;
}

function modelFromEvents(dir) {
  for (const name of readdirSync(dir)) {
    const events = join(dir, name, 'events.jsonl');
    if (!existsSync(events)) continue;
    for (const line of readFileSync(events, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        const models = Object.keys(event.modelUsage ?? event.message?.model ? { [event.message.model]: 1 } : {});
        if (event.model) return event.model;
        if (models[0]) return models[0];
      } catch { /* a truncated events line */ }
    }
  }
}

function summarize(group) {
  const passing = group.filter(r => r.passed);
  const seconds = passing.map(r => r.seconds).filter(Number.isFinite);
  const calls = passing.map(r => r.calls).filter(Number.isFinite);
  const turns = passing.map(r => r.turns).filter(Number.isFinite);
  const tokenVals = group.map(r => r.tokens).filter(Number.isFinite);
  const costVals = group.map(r => r.costUsd).filter(Number.isFinite);
  return {
    supported: true, passed: passing.length, runs: group.length,
    clean: group.filter(r => r.clean === true).length,
    medianSeconds: median(seconds), p90Seconds: p90(seconds),
    medianCalls: calls.length ? median(calls) : null,
    medianTurns: turns.length ? median(turns) : null,
    tokens: tokenVals.length ? tokenVals.reduce((s, n) => s + n, 0) : null,
    tokensKnown: tokenVals.length,
    costUsd: costVals.length ? Math.round(costVals.reduce((s, n) => s + n, 0) * 1000) / 1000 : null,
    costKnown: costVals.length,
  };
}

function emptyTotals() {
  return { runs: 0, passed: 0, medianSeconds: null, p90Seconds: null, tokens: null, costUsd: null,
    tokensKnown: 0, costKnown: 0 };
}

function addTotals(into, cell) {
  into.runs += cell.runs;
  into.passed += cell.passed;
  into.tokensKnown = (into.tokensKnown ?? 0) + (cell.tokensKnown ?? 0);
  into.costKnown = (into.costKnown ?? 0) + (cell.costKnown ?? 0);
  if (Number.isFinite(cell.tokens)) into.tokens = (into.tokens ?? 0) + cell.tokens;
  if (Number.isFinite(cell.costUsd)) {
    into.costUsd = Math.round(((into.costUsd ?? 0) + cell.costUsd) * 1000) / 1000;
  }
}

export function buildReport(rows, { warn = console.error } = {}) {
  const warnings = [...(rows.warnings ?? [])];
  const counted = rows.filter(r => r && !r.skipped && !r.dryRun && !r.phase)
    .map(r => ({
      ...r,
      half: halfOf(r),
      tokens: tokensOf(r),
      calls: callsOf(r) ?? r.calls,
      clean: r.clean === true || (r.passed === true && r.clean !== false && !overBudget(r)),
      costUsd: Number.isFinite(r.costUsd) ? r.costUsd : undefined,
      arm: r.variant != null && r.variant !== '' && !String(r.arm).includes(' (') ? `${r.arm} (${r.variant})` : r.arm,
    }))
    .filter(r => r.task && r.arm);
  const models = [...new Set(counted.map(r => r.model))];
  return {
    warnings,
    notRun: Object.entries(SUITE.suite?.notRun ?? {}).map(([arm, row]) => ({ arm, ...row })),
    models: models.map(model => {
      const ofModel = counted.filter(r => r.model === model);
      const arms = [...new Set(ofModel.map(r => r.arm))];
      const tasks = [...new Set(ofModel.map(r => r.task))];
      const cells = {};
      for (const task of tasks) {
        cells[task] = {};
        for (const arm of arms) {
          const group = ofModel.filter(r => r.task === task && r.arm === arm);
          if (group.length) cells[task][arm] = summarize(group);
          else {
            const listed = armSupported(task, arm);
            cells[task][arm] = { supported: listed !== false, passed: 0, runs: 0,
              medianSeconds: null, p90Seconds: null, medianCalls: null, medianTurns: null, tokens: null, costUsd: null };
            if (listed === false) cells[task][arm].supported = false;
          }
        }
      }
      const comparable = tasks.filter(task => arms.every(arm => cells[task][arm].runs > 0));
      const ns = arms.map(arm => comparable.reduce((s, task) => s + cells[task][arm].runs, 0));
      if (comparable.length && new Set(ns).size > 1) {
        const msg = `WORLD-REPORT: per-arm totals compare unequal run counts: ${arms.map((arm, i) => `${arm} N=${ns[i]}`).join(', ')}`;
        warnings.push(msg);
        warn(msg);
      }
      const armRows = arms.map((arm, i) => {
        const native = emptyTotals(), browser = emptyTotals(), cross = emptyTotals();
        const bucket = { native, browser, 'cross-app': cross };
        for (const task of comparable) {
          const cell = cells[task][arm];
          if (!cell.supported) continue;
          addTotals(bucket[halfOf(ofModel.find(r => r.task === task))] ?? native, cell);
        }
        for (const [name, half] of Object.entries(bucket)) {
          const halfRows = ofModel.filter(r => r.arm === arm && r.half === name && r.passed && comparable.includes(r.task));
          half.medianSeconds = median(halfRows.map(r => r.seconds));
          half.p90Seconds = p90(halfRows.map(r => r.seconds));
        }
        return { arm, native, browser, cross, n: ns[i] };
      });
      const failures = ofModel.filter(r => !r.passed && r.reason)
        .map(r => ({ arm: r.arm, task: r.task, run: r.run, reason: r.reason }));
      const timeouts = ofModel.filter(r => timedOut(r)).length;
      return { model, arms: armRows, tasks, cells, failures, timeouts, comparable };
    }),
  };
}

const fmt = (n) => (n == null ? '–' : Number.isInteger(n) ? String(n) : String(round1(n)));
const money = (n) => (n == null || !Number.isFinite(n) ? '–' : `$${n.toFixed(3)}`);
const partialSum = (value, known, runs, asMoney) => {
  if (value == null || !Number.isFinite(value)) return '–';
  if (known < runs) return asMoney ? `≥ $${value.toFixed(2)}, ${known} of ${runs} runs` : `≥ ${fmt(value)}, ${known} of ${runs} runs`;
  return asMoney ? money(value) : fmt(value);
};
const tokenCell = (cell) => partialSum(cell.tokens, cell.tokensKnown ?? cell.runs, cell.runs, false);
const costCell = (cell) => partialSum(cell.costUsd, cell.costKnown ?? cell.runs, cell.runs, true);
const passCell = (cell) => {
  const pass = `${cell.passed}/${cell.runs}`;
  if (cell.runs && cell.clean !== undefined && cell.clean !== cell.passed) return `${pass} (clean ${cell.clean}/${cell.runs})`;
  return pass;
};
const p90Cell = (cell) => {
  const n = cell.passed;
  if (!n) return '–';
  if (n < 10) return `n=${n}`;
  return `${fmt(cell.p90Seconds)} (nearest rank)`;
};

export function renderMarkdown(report) {
  const out = [];
  if (report.notRun?.length) {
    out.push('| Arm | Coverage | Reason |', '| --- | --- | --- |');
    for (const row of report.notRun) out.push(`| ${row.arm} | ${row.status} | ${row.reason} |`);
    out.push('');
  }
  if (report.warnings?.length) {
    for (const msg of report.warnings) out.push(msg);
    out.push('');
  }
  for (const table of report.models) {
    out.push(`# ${table.model}`, '',
      '| Task | Arm | Pass | Median s | p90 s | Calls | Turns | Tokens | Cost |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const task of table.tasks) {
      for (const arm of table.arms) {
        const cell = table.cells[task][arm.arm];
        if (!cell.supported) {
          out.push(`| ${task} | ${arm.arm} | not supported | not supported | not supported | not supported | not supported | not supported | not supported |`);
          continue;
        }
        if (cell.runs === 0) {
          out.push(`| ${task} | ${arm.arm} | not run | – | – | – | – | – | – |`);
          continue;
        }
        out.push(`| ${task} | ${arm.arm} | ${passCell(cell)} | ${fmt(cell.medianSeconds)} | ${p90Cell(cell)} | ${fmt(cell.medianCalls)} | ${fmt(cell.medianTurns)} | ${tokenCell(cell)} | ${costCell(cell)} |`);
      }
    }
    out.push('', table.comparable.length
      ? `Totals cover: ${table.comparable.join(', ')}`
      : 'Totals cover: no shared tasks');
    out.push('', '| Arm | Half | Pass | Median s | p90 s (nearest rank) | Tokens (sum) | Cost (sum) |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const arm of table.arms) {
      const halves = [['native', arm.native, 'Native'], ['browser', arm.browser, 'Browser']];
      if (arm.cross?.runs) halves.push(['cross-app', arm.cross, 'Cross-app']);
      const label = `${arm.arm} N=${arm.n ?? 0}`;
      for (const [, half, halfName] of halves) {
        if (!half.runs) {
          out.push(`| ${label} | ${halfName} | – | – | – | – | – |`);
          continue;
        }
        out.push(`| ${label} | ${halfName} | ${half.passed}/${half.runs} | ${fmt(half.medianSeconds)} | ${p90Cell(half)} | ${tokenCell(half)} | ${costCell(half)} |`);
      }
    }
    if (table.timeouts) out.push('', `Timeouts: ${table.timeouts}`);
    if (table.failures?.length) {
      out.push('', 'Failures:');
      for (const fail of table.failures) out.push(`- ${fail.arm} ${fail.task} #${fail.run}: ${fail.reason}`);
    }
    out.push('');
  }
  return scrubHome(out.join('\n'));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let out, pool = false;
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { out = argv[++i]; continue; }
    if (argv[i] === '--pool') { pool = true; continue; }
    paths.push(argv[i]);
  }
  if (!paths.length) {
    console.error('usage: node bench/world/report.mjs <results.json|round dir|report.md>... [--out table.md] [--pool]');
    process.exit(1);
  }
  try {
    const md = renderMarkdown(buildReport(loadSources(paths, { pool })));
    if (out) writeFileSync(out, md.endsWith('\n') ? md : md + '\n');
    else process.stdout.write(md.endsWith('\n') ? md : md + '\n');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
