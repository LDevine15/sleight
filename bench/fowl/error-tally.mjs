#!/usr/bin/env node
// Count a round's tool errors by the batch H classes. Reads each task's events.jsonl
// (Claude Code stream-json). Usage: node bench/fowl/error-tally.mjs <round dir>... [--json]
import fs from 'node:fs';
import path from 'node:path';

export const CLASSES = [
  'unawaited', 'input-lease', 'playwright-strict', 'playwright-deadline',
  'evaluate-write', 'lost-handle', 'invented-api', 'other',
];

const WRITE = /insertBefore|appendChild|removeChild|replaceChild|setAttribute|createEvent|dispatchEvent|DragEvent|DataTransfer|FormData|CustomEvent|PointerEvent|MouseEvent|KeyboardEvent|\bEvent is not a constructor|Cannot set property|Cannot add property on/;
const INVENTED = /\b(?:tab|cua|pw|playwright)\.\w+ is not a function|\.(?:dragTo|hover|boundingBox|focus|drag|press|evaluate) is not a function|require is not defined|document is not defined|Cannot read properties of undefined \(reading '(?:press|move|drag|domSnapshot|hover)'\)/;

export function errorBody(text) {
  if (/^(?:# API Reference|## Computer Use|# Other Browser)/.test(text)) {
    const fence = text.lastIndexOf('\n```');
    if (fence !== -1) return text.slice(fence + 4).trim();
  }
  return text;
}

export function classifyError(text) {
  const body = errorBody(typeof text === 'string' ? text : '');
  if (/sleight stopped this call before it ran:[\s\S]*no await/.test(body)) return 'unawaited';
  if (/Input lease: a bundle ID/.test(body)) return 'input-lease';
  if (/strict mode violation/.test(body)) return 'playwright-strict';
  if (/Playwright selector deadline|Locator diagnostics:|Timed out after \d+ms (?:evaluating|waiting for) selector/.test(body)) {
    return 'playwright-deadline';
  }
  if (/__playwrightEvaluate/.test(body) && WRITE.test(body)) return 'evaluate-write';
  if (/Tab not found|getTab\(\{ url \}\) requires an explicit browser|Cannot read properties of undefined \(reading 'id'\)/.test(body)) {
    return 'lost-handle';
  }
  if (INVENTED.test(body)) return 'invented-api';
  return 'other';
}

export function collectErrors(events) {
  const out = [];
  for (const event of events) {
    if (event.type !== 'user' || !event.message) continue;
    for (const block of event.message.content || []) {
      if (block.type !== 'tool_result' || !block.is_error) continue;
      const text = Array.isArray(block.content)
        ? block.content.map((part) => part.text || '').join('\n')
        : String(block.content ?? '');
      out.push(text);
    }
  }
  return out;
}

function emptyCounts() {
  return Object.fromEntries(CLASSES.map((name) => [name, 0]));
}

export function tallyErrors(texts) {
  const classes = emptyCounts();
  const examples = Object.fromEntries(CLASSES.map((name) => [name, []]));
  for (const text of texts) {
    const cls = classifyError(text);
    classes[cls]++;
    if (examples[cls].length < 3) {
      const line = errorBody(text).split('\n')[0].slice(0, 160);
      if (!examples[cls].includes(line)) examples[cls].push(line);
    }
  }
  return { total: texts.length, classes, examples };
}

function loadRound(dir) {
  const tasks = {};
  for (const task of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, task, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return {}; }
    });
    tasks[task] = tallyErrors(collectErrors(events));
  }
  return tasks;
}

export function sumRound(tasks) {
  const classes = emptyCounts();
  const examples = Object.fromEntries(CLASSES.map((name) => [name, []]));
  let total = 0;
  for (const task of Object.values(tasks)) {
    total += task.total;
    for (const name of CLASSES) {
      classes[name] += task.classes[name];
      for (const line of task.examples[name]) {
        if (examples[name].length < 3 && !examples[name].includes(line)) examples[name].push(line);
      }
    }
  }
  return { total, classes, examples };
}

function printRound(name, tasks) {
  const sum = sumRound(tasks);
  console.log(`\n${name}: ${Object.keys(tasks).length} tasks, ${sum.total} errors`);
  for (const cls of CLASSES) console.log(`  ${cls} ${sum.classes[cls]}`);
  for (const [task, tally] of Object.entries(tasks)) {
    const parts = CLASSES.filter((cls) => tally.classes[cls]).map((cls) => `${cls} ${tally.classes[cls]}`);
    console.log(`  ${task}: ${tally.total} (${parts.join(', ') || 'none'})`);
  }
  for (const cls of CLASSES) {
    if (!sum.examples[cls].length) continue;
    console.log(`  examples ${cls}:`);
    for (const line of sum.examples[cls]) console.log(`    ${line}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirs = args.filter((arg) => !arg.startsWith('--'));
  const all = Object.fromEntries(dirs.map((dir) => [path.basename(dir), loadRound(dir)]));
  if (args.includes('--json')) {
    console.log(JSON.stringify({
      rounds: Object.fromEntries(Object.entries(all).map(([name, tasks]) => [name, { tasks, ...sumRound(tasks) }])),
    }, null, 1));
    process.exit(0);
  }
  for (const [name, tasks] of Object.entries(all)) printRound(name, tasks);
  const combined = Object.values(all).flatMap((tasks) => Object.values(tasks));
  if (Object.keys(all).length > 1) {
    const sum = combined.reduce((acc, task) => {
      acc.total += task.total;
      for (const cls of CLASSES) acc.classes[cls] += task.classes[cls];
      return acc;
    }, { total: 0, classes: emptyCounts() });
    console.log(`\ncombined: ${sum.total} errors`);
    for (const cls of CLASSES) console.log(`  ${cls} ${sum.classes[cls]}`);
  }
}
