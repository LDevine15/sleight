#!/usr/bin/env node
// Offline aggregates only. Never prints page text, arguments, URLs or host identity.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const blocks = event => Array.isArray(event.message?.content) ? event.message.content : [];
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
const toolName = name => typeof name === 'string' ? name.split('__').at(-1) : '';
const names = new Set(['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs']);

function softFailure(name, text) {
  if (!names.has(name) || name === 'browser_read') return false;
  const lines = text.trim().split('\n');
  if (/^(?:Input|Operation) outcome is unconfirmed\./.test(lines[0])) return true;
  const ref = '(?:(?:f[0-9]+)?e[0-9]+|s[0-9]+)';
  const outcome = name === 'browser_fill' ? new RegExp(`^(?:${ref}|submit): (.*)$`)
    : name === 'browser_act' ? new RegExp(`^[0-9]+ [a-z]+(?: ${ref})?: (.*)$`) : undefined;
  if (!outcome) return false;
  // Only the leading tool outcome lines are trusted markers. A snapshot that
  // follows them may contain arbitrary page text with the same words.
  for (const line of lines) {
    const status = outcome.exec(line)?.[1];
    if (status === undefined) break;
    if (/^(?:failed|not reached|not run|(?:effect|submit) unconfirmed|unconfirmed)\b/.test(status)) return true;
  }
  return false;
}

export function censusEvents(events) {
  const calls = new Map(), completed = new Set();
  const row = { calls: 0, reads: 0, actionCalls: 0, readsPerAction: null, stepsRequested: 0,
    fieldsRequested: 0, submitsRequested: 0, characters: 0, errors: 0, softFailures: 0, gateFailures: 0, unresolved: 0,
    otherCalls: 0, toolSearch: 0, duplicateResults: 0, orphanResults: 0, tools: {} };
  for (const event of events) for (const block of blocks(event)) {
    if (event.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string' && !calls.has(block.id)) {
      const name = toolName(block.name), known = names.has(name);
      calls.set(block.id, known ? name : 'other'); row.calls++;
      const input = block.input ?? {};
      const tool = row.tools[known ? name : 'other'] ??= { calls: 0, characters: 0, results: 0, errors: 0, softFailures: 0 };
      tool.calls++;
      if (name === 'browser_read') row.reads++;
      if (name === 'browser_act' || name === 'browser_fill') row.actionCalls++;
      if (name === 'browser_act' && Array.isArray(input.steps)) row.stepsRequested += input.steps.length;
      if (name === 'browser_fill' && Array.isArray(input.fields)) row.fieldsRequested += input.fields.length;
      if (name === 'browser_fill' && typeof input.submit === 'string') row.submitsRequested++;
      if (!known) row.otherCalls++;
      if (name === 'ToolSearch') row.toolSearch++;
    }
    if (event.type !== 'user' || block?.type !== 'tool_result') continue;
    const id = block.tool_use_id;
    if (completed.has(id)) { row.duplicateResults++; continue; }
    completed.add(id);
    const name = calls.get(id);
    if (!name) { row.orphanResults++; continue; }
    const tool = row.tools[name], text = textOf(block.content), characters = [...text].length;
    tool.results++; tool.characters += characters; row.characters += characters;
    if (block.is_error === true) { row.errors++; tool.errors++; }
    else if (softFailure(name, text)) { row.softFailures++; tool.softFailures++; }
  }
  row.unresolved = [...calls.keys()].filter(id => !completed.has(id)).length;
  row.gateFailures = row.errors + row.softFailures;
  row.readsPerAction = row.actionCalls ? row.reads / row.actionCalls : null;
  return row;
}

export function observations(result, metrics = []) {
  const grade = result?.focusGrade, events = Array.isArray(grade?.events) ? grade.events.length : null;
  const focusEvents = grade && (grade.cell === 'ok' || /^FAIL: \d+$/.test(grade.cell)) ? events : null;
  const cleanup = metrics.filter(record => record.version === 3 && record.phase === 'cleanup').at(-1);
  // Failed session starts (v3-server.mjs recordStartupFailure): each failed attempt, and whether one was final for the task.
  const starts = metrics.filter(record => record.version === 3 && record.phase === 'startup-failed');
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { focusEvents, observedFocusEvents: events, turboTabsLeft: count(cleanup?.turboTabsLeft),
    tabsAfterBrowserClose: count(cleanup?.tabsAfterBrowserClose),
    // A turbo browser receipt cannot prove the companion's engine tab cleanup.
    tabsLeft: null, cleanupProved: cleanup?.browserClosed === true && cleanup?.profileDeleted === true && cleanup?.socketsClosed === true,
    startupFailures: starts.length, startupUnrecovered: starts.some(record => record.retrying !== true) };
}

function ordinary(file) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) throw Error(basename(file) + ' is a symbolic link');
  return stat;
}
function jsonLines(file) {
  if (!existsSync(file)) return [];
  if (!ordinary(file).isFile()) throw Error(basename(file) + ' is not a file');
  return readFileSync(file, 'utf8').split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    let event;
    try { event = JSON.parse(line); } catch { throw Error(basename(file) + ':' + (index + 1) + ' is invalid JSON'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw Error(basename(file) + ':' + (index + 1) + ' is not an object');
    return [event];
  });
}
export function censusRound(directory) {
  if (!ordinary(directory).isDirectory()) throw Error('round is not a directory');
  const resultsFile = join(directory, 'results.json');
  let results = [];
  if (existsSync(resultsFile)) {
    ordinary(resultsFile); results = JSON.parse(readFileSync(resultsFile, 'utf8'));
    if (!Array.isArray(results)) throw Error('results.json is not an array');
  }
  const byName = new Map();
  for (const result of results) {
    const name = result?.task?.name;
    if (typeof name !== 'string' || !name) throw Error('task name missing in results.json');
    if (byName.has(name)) throw Error('duplicate task in results.json');
    byName.set(name, result);
  }
  const missing = () => Object.fromEntries(Object.entries(censusEvents([])).map(([key, value]) =>
    [key, typeof value === 'number' ? null : value]));
  const tasks = Object.create(null);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw Error('round entry is a symbolic link');
    if (!entry.isDirectory()) continue;
    const dir = join(directory, entry.name), file = join(dir, 'events.jsonl');
    const metricFile = join(dir, 'turbo-metrics.jsonl'), available = existsSync(file);
    if (!available && !existsSync(metricFile)) continue;
    tasks[entry.name] = { transcriptAvailable: available, ...(available ? censusEvents(jsonLines(file)) : missing()),
      ...observations(byName.get(entry.name), jsonLines(metricFile)) };
  }
  for (const [name, result] of byName) if (!Object.hasOwn(tasks, name)) tasks[name] = {
    transcriptAvailable: false, ...missing(), ...observations(result) };
  return { round: basename(resolve(directory)), tasks };
}
export function renderCensus(rounds) {
  const value = number => number == null ? 'unavailable' : String(number);
  const lines = ['Reads/action = standalone browser_read calls / (browser_act + browser_fill calls), including failed and unfinished calls.',
    'Characters count Unicode code points in matched delivered text. Steps and fields are requested counts, not completion proof.',
    'Errors are is_error results for arm comparison. Soft failures count other v3 results with failure markers once per result. Gate failures = errors + soft failures.',
    'Focus counts cover the run interval (overlap is correlation). Turbo tabs are counted after module cleanup, before browser closure.',
    'Combined tabs left remain unavailable because turbo cannot measure the engine companion.'];
  for (const round of rounds) {
    lines.push('', round.round, '| Task | Reads | Actions | Reads/action | Characters | Errors | Soft failures | Gate failures | Calls | ToolSearch | Unresolved | Focus | Turbo tabs left | Combined tabs left | Cleanup |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const [task, row] of Object.entries(round.tasks)) lines.push(`| ${task.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')} | ${value(row.reads)} | ${value(row.actionCalls)} | ${row.readsPerAction === null ? 'unavailable' : row.readsPerAction.toFixed(3)} | ${value(row.characters)} | ${value(row.errors)} | ${value(row.softFailures)} | ${value(row.gateFailures)} | ${value(row.calls)} | ${value(row.toolSearch)} | ${value(row.unresolved)} | ${value(row.focusEvents)} | ${value(row.turboTabsLeft)} | unavailable | ${row.cleanupProved ? 'proved' : 'unavailable'} |`);
  }
  return lines.join('\n') + '\n';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), dirs = args.filter(arg => arg !== '--json');
    if (!dirs.length || dirs.some(arg => arg.startsWith('--'))) throw Error('usage: census.mjs [--json] <round directory>...');
    const rounds = dirs.map(censusRound);
    process.stdout.write(args.includes('--json') ? JSON.stringify({ rounds }, null, 2) + '\n' : renderCensus(rounds));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
