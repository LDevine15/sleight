#!/usr/bin/env node
// Offline error counts and failed-call wall time. Transcripts remain private.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = /^(?:## Computer Use|# API Reference|# Other Browser)/;
const errorLine = /^(?:(?:Type|Syntax|Reference|Range)?Error:|Cannot |Tab not found|Timed out|CDP |Accessibility action requires|Browser (?:input requires|action|is not available|Use rejected)|Capability |Required documentation|Input lease|sleight(?: stopped|:)|\[\d+:\d+|.* is not a function|(?:require|document) is not defined)/;
function errorText(text) {
  if (!docs.test(text)) return text.split(/\n(?:## Computer Use|# API Reference|# Other Browser)/)[0];
  let fenced = false, offset = 0;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    else if (!fenced && errorLine.test(line)) return text.slice(offset).split('\n## ')[0];
    offset += line.length + 1;
  }
  return '';
}

export function classifyCause(text) {
  const body = errorText(text);
  if (!body && docs.test(text)) return 'initialization-gate';
  if (/sleight stopped this call before it ran:[\s\S]*no await/.test(body)) return 'unawaited-action';
  if (/Input lease:/.test(body)) return 'input-lease';
  if (/sleight stopped before|element .*(?:stale|missing)|detached accessibility element|capture belongs to a previous page/i.test(body)) return 'stale-element';
  if (/requested permissions to use|haven't granted|security policy|declined permission/i.test(body)) return 'permission-refusal';
  if (/interrupted by JavaScript (?:confirm|alert|prompt)/.test(body)) return 'dialog-interruption';
  if (/blocking automation|ERR_BLOCKED_BY_CLIENT/i.test(body)) return 'browser-blocked';
  if (/strict mode violation/.test(body)) return 'ambiguous-selector';
  if (/not a valid selector|invalid selector/i.test(body)) return 'invalid-selector';
  if (/Playwright selector deadline|Locator diagnostics:|Timed out after \d+ms (?:evaluating|waiting for) selector/.test(body)) return 'selector-timeout';
  if (/evaluate is read-only/.test(body) || /__playwrightEvaluate/.test(body) &&
      /insertBefore|appendChild|removeChild|replaceChild|setAttribute|createEvent|dispatchEvent|DragEvent|DataTransfer|FormData|CustomEvent|PointerEvent|MouseEvent|KeyboardEvent|\bEvent is not a constructor|Cannot set property|Cannot add property/.test(body)) return 'read-only-evaluate';
  if (/Tab not found|Browser is not available|getTab\(\{ url \}\) requires an explicit browser|reading 'id'/.test(body)) return 'stale-handle';
  if (/timed out|deadline|waiting for networkidle/i.test(body)) return 'engine-timeout';
  if (/Unexpected token|Invalid left-hand side|SyntaxError:/.test(body)) return 'syntax-error';
  if (/requires an element index|requires.*latest AX snapshot|Cannot use 'in' operator|Invalid app:/.test(body)) return 'invalid-input';
  if (/Cannot read properties of (?:null|undefined)/.test(body) && !/reading '(?:press|move|drag|domSnapshot|hover)'/.test(body)) return 'data-shape';
  if (/Capability is not available/.test(body)) return 'capability-unavailable';
  if (/Required documentation has not been read/.test(body)) return 'documentation-gate';
  if (/only supports/.test(body)) return 'api-limitation';
  if (/__playwrightEvaluate/.test(body) && /is not a function|is not a constructor/.test(body)) return 'evaluate-scope';
  if (/is not a function|is not defined|sleight:.*is unavailable|reading '(?:press|move|drag|domSnapshot|hover)'/.test(body)) return 'invented-api';
  return 'other';
}

const blocks = event => Array.isArray(event.message?.content) ? event.message.content : [];
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : '';
const timestamp = event => {
  if (typeof event.t === 'number' && Number.isFinite(event.t)) return event.t;
  const t = Date.parse(event.timestamp);
  return Number.isFinite(t) ? t : null;
};

export function censusEvents(events) {
  const pending = new Map(), completed = new Set(), errors = [];
  let explicitResets = 0, implicitResetErrors = 0;
  for (const event of events) {
    for (const block of blocks(event)) {
      if (event.type === 'assistant' && block?.type === 'tool_use' && block.id && !pending.has(block.id)) {
        pending.set(block.id, timestamp(event));
        if (/(?:^|__)js_reset$/.test(block.name ?? '')) explicitResets++;
      }
      if (event.type !== 'user' || block?.type !== 'tool_result') continue;
      const id = block.tool_use_id;
      if (id && completed.has(id)) continue;
      if (id) completed.add(id);
      if (!block.is_error) continue;
      const start = pending.get(id) ?? null, end = timestamp(event), text = textOf(block.content);
      const milliseconds = start !== null && end !== null && end >= start ? end - start : null;
      if (/kernel reset/i.test(errorText(text))) implicitResetErrors++;
      errors.push({ id: id ?? null, cause: classifyCause(text), milliseconds });
    }
  }
  const timedErrors = errors.filter(error => error.milliseconds !== null).length;
  return { errors, timedErrors, unknownTiming: errors.length - timedErrors,
    failedCallMs: errors.reduce((sum, error) => sum + (error.milliseconds ?? 0), 0), explicitResets, implicitResetErrors };
}

function ordinary(file) {
  if (lstatSync(file).isSymbolicLink()) throw new Error(`${basename(file)} is a symbolic link`);
}
function outcomes(file) {
  if (!existsSync(file)) return {};
  ordinary(file);
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (/^FAIL(?:\b|,)/.test(cells[3] ?? '')) out[cells[0]] = true;
    else if (/^ok(?:\b|,)/.test(cells[3] ?? '')) out[cells[0]] = false;
  }
  return out;
}

export function censusRound(directory) {
  ordinary(directory);
  const grades = outcomes(join(directory, 'report.md')), runs = {}, classes = {};
  let total = 0, failedCallMs = 0, timedErrors = 0, unknownTiming = 0, explicitResets = 0, implicitResetErrors = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('round entry is a symbolic link');
    if (!entry.isDirectory()) continue;
    const file = join(directory, entry.name, 'events.jsonl');
    if (!existsSync(file)) continue;
    ordinary(file);
    const events = readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
      if (!line.trim()) return [];
      let event;
      try { event = JSON.parse(line); } catch { throw new Error(`events.jsonl:${index + 1} is invalid JSON`); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error(`events.jsonl:${index + 1} is not an event object`);
      return [event];
    });
    const run = censusEvents(events), failed = grades[entry.name] ?? null;
    runs[entry.name] = { ...run, failed };
    total += run.errors.length; failedCallMs += run.failedCallMs; timedErrors += run.timedErrors;
    unknownTiming += run.unknownTiming; explicitResets += run.explicitResets; implicitResetErrors += run.implicitResetErrors;
    for (const error of run.errors) {
      const row = classes[error.cause] ??= { count: 0, failedCallMs: 0, timedErrors: 0, tasks: [], failedTasks: [], unknownOutcomeTasks: [] };
      row.count++; row.failedCallMs += error.milliseconds ?? 0; row.timedErrors += error.milliseconds !== null;
      if (!row.tasks.includes(entry.name)) row.tasks.push(entry.name);
      if (failed === true && !row.failedTasks.includes(entry.name)) row.failedTasks.push(entry.name);
      if (failed === null && !row.unknownOutcomeTasks.includes(entry.name)) row.unknownOutcomeTasks.push(entry.name);
    }
  }
  return { round: basename(resolve(directory)), total, failedCallMs, timedErrors, unknownTiming, explicitResets, implicitResetErrors, classes, runs };
}

export function renderCensus(rounds) {
  const lines = ['Failed-call seconds sum matched call-to-result intervals, which can overlap. Recovery time and avoidable time are unmeasured.',
    'Failed tasks had an error in this class. This does not establish which error caused their outcome.'];
  for (const report of rounds) {
    lines.push('', `${report.round}: ${report.total} errors, ${(report.failedCallMs / 1000).toFixed(3)} failed-call seconds, ${report.timedErrors}/${report.total} timed`,
      '| Cause | Errors | Failed-call seconds | Affected tasks | Failed tasks |', '| --- | ---: | ---: | --- | --- |');
    for (const [cause, row] of Object.entries(report.classes).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
      lines.push(`| ${cause} | ${row.count} | ${(row.failedCallMs / 1000).toFixed(3)} | ${row.tasks.join(', ')} | ${row.failedTasks.join(', ')} |`);
    }
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || args.some(arg => arg.startsWith('--') && arg !== '--json')) throw new Error('usage: error-census.mjs <round directory>... [--json]');
    const directories = args.filter(arg => arg !== '--json');
    if (!directories.length) throw new Error('a round directory is required');
    const rounds = directories.map(censusRound);
    console.log(args.includes('--json') ? JSON.stringify({ rounds }, null, 2) : renderCensus(rounds));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
