#!/usr/bin/env node
// Where a round's time, tokens and turns go, per arm. Reads each run's events.jsonl (Claude Code's stream-json, with
// the runner's `t` timestamps) and prints, per round directory:
// - turns, calls, model time (a result to the next model message), tool time (a call to its result), start (process
//   start to the first model message) and the rest of the wall time;
// - result characters by kind: the engine's docs by section, page or window trees, everything else;
// - final token mix and cost, with provisional first-block usage kept separately;
// - each call's class, and the turns that look avoidable: a read-only call right after an action call (the action's
//   result could have carried that read), two read-only calls in a row, and a call right after an error.
// Usage: node bench/fowl/anatomy.mjs <round dir>... [--runs] [--turns] [--json]
import fs from 'node:fs';
import path from 'node:path';

const DOC_HEAD = /^(## Computer Use|# Other Browser APIs|# API Reference|# Computer Use Confirmations Policy|# Browser Interaction Troubleshooting|<app_specific_instructions>|## Browser Computer Use)/;
const TREE_HEAD = /^(Browser tab: |Window: )/;
const ACTION = /\.(click|dblclick|fill|type|typeText|press|pressKey|pressSequentially|drag|dragTo|setValue|selectOption|check|uncheck|setChecked|goto|back|forward|reload|paste|performSecondaryAction|scroll|selectText|fillForm|accept|dismiss)\(|\bbrowser_(click|type|fill|press|select|drag|navigate|scroll)|\b(tab_open|click|type|fill_form|press_key|select_option|drag|navigate|scroll|tab_close|tab_handoff)\b/;
const SETUP = /\b(getBrowser|createBrowserTab|getApp|getTab|listTabs|listBrowsers|browser_list|tab_open)\b/;
const READ = /\b(getAXState|getAXStateAndScreenshot|getScreenshot|screenshot|evaluate|domSnapshot|innerText|textContent|allTextContents|title|url|getAttribute|count|isVisible|snapshot|read_page|find|get_text)\b/;

const textOf = (b) => (Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : String(b.content ?? ''));

// Splits a result's text into the engine's doc sections, trees and the rest, by character count.
export function resultKinds(text) {
  const kinds = { docs: {}, tree: 0, other: 0 };
  let kind = 'other'; let section = null;
  for (const line of text.split('\n')) {
    const doc = DOC_HEAD.exec(line);
    if (doc) { kind = 'docs'; section = doc[1].replace(/^#+ |^</, '').replace(/>$/, ''); }
    else if (TREE_HEAD.test(line)) kind = 'tree';
    else if (kind === 'tree' && line === '') kind = 'other';
    const n = line.length + 1;
    if (kind === 'docs') kinds.docs[section] = (kinds.docs[section] || 0) + n;
    else kinds[kind] += n;
  }
  return kinds;
}

// One call's class from its input: setup, read, action, action+read (the call reads after acting), or tool (other).
export function callClass(name, input) {
  if (/ToolSearch/.test(name)) return 'toolsearch';
  if (/js_reset/.test(name)) return 'reset';
  // A tool per intent (FowlBrowser's): the tool's own name says what it does.
  const tool = /^mcp__[^_]+(?:_[^_]+)*?__(\w+)$/.exec(name)?.[1];
  if (tool && !/^js$/.test(tool)) {
    if (/^(snapshot|read_page|get_text|find|screenshot|tab_list|browser_list|console|network)/.test(tool)) return /list/.test(tool) ? 'setup' : 'read';
    if (/^(tab_open|tab_select|browser_list)/.test(tool)) return 'setup';
    return 'action+read'; // FowlBrowser's acting tools return the state diff
  }
  const code = input?.code ?? JSON.stringify(input ?? {});
  const act = ACTION.test(code); const read = READ.test(code); const setup = SETUP.test(code);
  if (act && read) return 'action+read';
  if (act) return 'action';
  if (setup && !read) return 'setup';
  if (read) return 'read';
  return setup ? 'setup' : 'other';
}

// Complete assistant blocks are timestamped, not tokens or requests. Keep that distinction in the output.
function timingSplit(events) {
  const rows = events.filter((e) => Number.isFinite(e.t));
  const start = rows[0]?.t ?? 0;
  const result = rows.find((e) => e.type === 'result');
  const end = result?.t ?? rows.at(-1)?.t ?? start;
  const groups = new Map(); const calls = new Map(); const progress = [];
  for (const e of rows) {
    if (e.type === 'system' && e.subtype === 'thinking_tokens') progress.push(e.t);
    if (e.type === 'assistant' && e.message) {
      const id = e.message.id ?? e.uuid ?? `message-${groups.size}`;
      if (!groups.has(id)) groups.set(id, { id, firstAt: e.t, lastAt: e.t, cacheRead: 0, calls: [] });
      const g = groups.get(id); g.lastAt = Math.max(g.lastAt, e.t);
      g.cacheRead = Math.max(g.cacheRead, e.message.usage?.cache_read_input_tokens ?? 0);
      for (const b of e.message.content || []) if (b.type === 'tool_use' && !calls.has(b.id)) {
        const c = { at: e.t, end: null }; calls.set(b.id, c); g.calls.push(c);
      }
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b.type === 'tool_result') {
        const c = calls.get(b.tool_use_id);
        if (c && c.end == null) c.end = e.t;
      }
    }
  }
  const turns = [...groups.values()]; const intervals = [];
  const add = (a, b, kind, priority) => { if (b > a) intervals.push({ a, b, kind, priority }); };
  for (const c of calls.values()) add(c.at, c.end ?? end, 'toolMs', 4);
  const turnTimings = turns.map((g, i) => {
    const prev = turns[i - 1];
    const ready = prev ? Math.max(prev.lastAt, ...prev.calls.map((c) => c.end ?? end)) : null;
    const firstProgress = progress.find((t) => ready != null && t >= ready && t <= g.firstAt);
    add(g.firstAt, g.lastAt, 'blockEmissionMs', 3);
    if (ready != null) add(ready, g.firstAt, 'waitingMs', 2);
    return { turn: i + 1, id: g.id, firstAt: g.firstAt, lastAt: g.lastAt, cacheRead: g.cacheRead,
      waitingMs: ready == null ? null : Math.max(0, g.firstAt - ready), afterToolResult: !!prev?.calls.length,
      blockEmissionMs: g.lastAt - g.firstAt,
      firstProgressAfterResultMs: firstProgress == null || !prev.calls.length ? null : firstProgress - ready,
      ttftMs: null, streamingMs: null, requestOverheadMs: null };
  });
  add(start, turns[0]?.firstAt ?? end, 'startupMs', 1);
  const last = turns.at(-1);
  if (last) add(Math.max(last.lastAt, ...last.calls.map((c) => c.end ?? end)), end, 'tailMs', 1);
  const timing = { eventWallMs: Math.max(0, end - start), startupMs: 0, waitingMs: 0,
    blockEmissionMs: 0, toolMs: 0, tailMs: 0, unclassifiedMs: 0,
    durationDeltaMs: (result?.duration_ms ?? end - start) - (end - start), toolOverlapMs: 0 };
  const points = [...new Set([start, end, ...intervals.flatMap(({ a, b }) => [a, b])])]
    .filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const active = intervals.filter((x) => x.a <= a && x.b >= b).sort((x, y) => y.priority - x.priority);
    timing[active[0]?.kind ?? 'unclassifiedMs'] += b - a;
  }
  const toolSum = [...calls.values()].reduce((n, c) => n + Math.max(0, (c.end ?? end) - c.at), 0);
  timing.toolOverlapMs = toolSum - timing.toolMs;
  return { timing, turnTimings };
}

export function runAnatomy(events) {
  const provisionalUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const seenMsg = new Set(); const pending = new Map(); const calls = [];
  let model = 0, tool = 0, lastResultAt = null, firstModelAt = null;
  const kinds = { docs: {}, tree: 0, other: 0 };
  const t0 = events.find((e) => typeof e.t === 'number')?.t;
  for (const e of events) {
    if (e.type === 'assistant' && e.message) {
      const id = e.message.id ?? e.uuid ?? e;
      if (!seenMsg.has(id)) {
        seenMsg.add(id);
        const u = e.message.usage || {};
        provisionalUsage.input += u.input_tokens || 0; provisionalUsage.cacheWrite += u.cache_creation_input_tokens || 0;
        provisionalUsage.cacheRead += u.cache_read_input_tokens || 0; provisionalUsage.output += u.output_tokens || 0;
        if (firstModelAt == null) firstModelAt = e.t;
        if (lastResultAt != null) model += e.t - lastResultAt;
        lastResultAt = null;
      }
      for (const b of e.message.content || []) if (b.type === 'tool_use' && !pending.has(b.id)) {
        const c = { id: b.id, name: b.name, cls: callClass(b.name, b.input), at: e.t, error: false };
        calls.push(c); pending.set(b.id, c);
      }
    }
    if (e.type === 'user' && e.message) {
      for (const b of e.message.content || []) if (b.type === 'tool_result') {
        const c = pending.get(b.tool_use_id);
        if (c) { tool += e.t - c.at; c.error = !!b.is_error; c.chars = textOf(b).length; }
        const k = resultKinds(textOf(b));
        for (const [s, n] of Object.entries(k.docs)) kinds.docs[s] = (kinds.docs[s] || 0) + n;
        kinds.tree += k.tree; kinds.other += k.other;
      }
      lastResultAt = e.t;
    }
  }
  const result = events.find((e) => e.type === 'result') || {};
  const u = result.usage;
  const count = (n) => Number.isFinite(n) && n >= 0 ? n : null;
  const usage = { input: count(u?.input_tokens), cacheWrite: count(u?.cache_creation_input_tokens),
    cacheRead: count(u?.cache_read_input_tokens), output: count(u?.output_tokens),
    thinking: count(u?.output_tokens_details?.thinking_tokens) };
  const usageCoverage = { finalRuns: u ? 1 : 0, missingFinalRuns: u ? 0 : 1 };
  const wall = result.duration_ms ?? (events.length ? events.at(-1)?.t - t0 : 0);
  const avoidable = { readAfterAction: 0, readAfterRead: 0, afterError: 0 };
  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1]; const cur = calls[i];
    if (prev.error) avoidable.afterError++;
    else if (cur.cls === 'read' && prev.cls === 'action') avoidable.readAfterAction++;
    else if (cur.cls === 'read' && prev.cls === 'read') avoidable.readAfterRead++;
  }
  const classes = {};
  for (const c of calls) classes[c.cls] = (classes[c.cls] || 0) + 1;
  return {
    turns: seenMsg.size, calls: calls.length, errors: calls.filter((c) => c.error).length, classes, avoidable,
    wallMs: wall, startMs: firstModelAt != null ? firstModelAt - t0 : 0, modelMs: model, toolMs: tool,
    chars: kinds, usage, provisionalUsage, usageCoverage, cost: result.total_cost_usd ?? 0,
    ...timingSplit(events),
  };
}

export function sumRuns(runs) {
  const add = (a, b) => { for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v)) continue;
    if (v === null || a[k] === null) a[k] = null;
    else a[k] = typeof v === 'object' ? add(a[k] || {}, v) : (a[k] || 0) + v;
  } return a; };
  return runs.reduce((acc, r) => add(acc, r), {});
}

export function loadRoundEvents(dir) {
  const runs = {};
  for (const task of fs.readdirSync(dir).sort()) {
    const entry = fs.lstatSync(path.join(dir, task));
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = path.join(dir, task, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    const record = fs.lstatSync(file);
    if (!record.isFile() || record.isSymbolicLink()) continue;
    const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    runs[task] = events;
  }
  return runs;
}

function loadRound(dir) {
  return Object.fromEntries(Object.entries(loadRoundEvents(dir)).map(([task, events]) => [task, runAnatomy(events)]));
}

const k = (n) => `${Math.round(n / 1000)}K`;
const s = (ms) => `${Math.round(ms / 1000)} s`;

function print(name, runs) {
  const t = sumRuns(Object.values(runs));
  const docs = Object.values(t.chars.docs || {}).reduce((a, b) => a + b, 0);
  console.log(`\n${name}: ${Object.keys(runs).length} runs, ${t.turns} turns, ${t.calls} calls, ${t.errors || 0} errors, $${(t.cost || 0).toFixed(2)}`);
  console.log(`  legacy intervals (may overlap): wall ${s(t.wallMs)} = start ${s(t.startMs)} + model ${s(t.modelMs)} + tool ${s(t.toolMs)} + rest ${s(t.wallMs - t.startMs - t.modelMs - t.toolMs)}`);
  const z = t.timing;
  console.log(`  event clock: ${s(z.eventWallMs)} = startup/initial wait ${s(z.startupMs)} + inter-turn wait ${s(z.waitingMs)} + completed assistant-block intervals ${s(z.blockEmissionMs)} + tool union ${s(z.toolMs)} + finalization ${s(z.tailMs)} + unclassified ${s(z.unclassifiedMs)}`);
  console.log(`  duration_ms minus event clock: ${(z.durationDeltaMs / 1000).toFixed(3)} s; overlapping tool time: ${(z.toolOverlapMs / 1000).toFixed(3)} s`);
  console.log('  Per-turn request overhead, TTFT and true token streaming: unavailable. Waiting includes request overhead, transport, model wait/thinking and block buffering.');
  console.log(`  results: docs ${k(docs)}, trees ${k(t.chars.tree)}, other ${k(t.chars.other)}`);
  for (const [sec, n] of Object.entries(t.chars.docs || {}).sort((a, b) => b[1] - a[1])) console.log(`    ${sec}: ${k(n)}`);
  const tokens = (n) => n == null ? 'unavailable' : String(n);
  console.log(`  final tokens (${t.usageCoverage.finalRuns} runs with usage, ${t.usageCoverage.missingFinalRuns} missing): cache write ${tokens(t.usage.cacheWrite)}, cache read ${tokens(t.usage.cacheRead)}, output ${tokens(t.usage.output)}, thinking (included in output) ${tokens(t.usage.thinking)}, input ${tokens(t.usage.input)}`);
  const p = t.provisionalUsage;
  console.log(`  provisional first-block tokens: cache write ${p.cacheWrite}, cache read ${p.cacheRead}, output ${p.output}, input ${p.input}`);
  console.log(`  calls by class: ${Object.entries(t.classes || {}).map(([c, n]) => `${c} ${n}`).join(', ')}`);
  console.log(`  avoidable-looking turns: read right after an action ${t.avoidable.readAfterAction}, read after read ${t.avoidable.readAfterRead}, after an error ${t.avoidable.afterError}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirs = args.filter((a) => !a.startsWith('--'));
  const all = Object.fromEntries(dirs.map((d) => [path.basename(d), loadRound(d)]));
  if (args.includes('--json')) { console.log(JSON.stringify(all, null, 1)); process.exit(0); }
  for (const [name, runs] of Object.entries(all)) {
    print(name, runs);
    if (args.includes('--runs')) for (const [task, r] of Object.entries(runs)) {
      console.log(`    ${task.padEnd(22)} turns ${String(r.turns).padStart(3)}  calls ${String(r.calls).padStart(3)}  wall ${s(r.wallMs).padStart(6)}  start ${s(r.startMs)}  $${r.cost.toFixed(3)}  ${Object.entries(r.classes).map(([c, n]) => `${c} ${n}`).join(', ')}  avoidable ${r.avoidable.readAfterAction}/${r.avoidable.readAfterRead}/${r.avoidable.afterError}`);
    }
    if (args.includes('--turns')) for (const [task, r] of Object.entries(runs)) for (const t of r.turnTimings) {
      console.log(`    ${task} turn ${t.turn}: wait ${t.waitingMs == null ? 'initial' : `${t.waitingMs} ms`}, completed-block interval ${t.blockEmissionMs} ms, cache read ${t.cacheRead}, first thinking-progress after result ${t.firstProgressAfterResultMs ?? 'unavailable'} ms; TTFT/request overhead/streaming unavailable`);
    }
  }
}
