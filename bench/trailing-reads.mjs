#!/usr/bin/env node
// CC6's live check (codex-vs-cc-1019): per round folder, how many calls end an action with getAXState() (from each task's
// events.jsonl), and from the relay traces (SLEIGHT_TRACE, `<round>.trace/*.jsonl`) the time of one-action calls that end on
// the action against those that end on a read. A one-action call is one with three approval elicitations (read, action,
// read). Usage: node bench/trailing-reads.mjs <round folder>...
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ACTION = /\.\s*(?:click|setValue|selectText|performSecondaryAction|scroll|drag|pressKey|typeText|paste|pickFromList)\s*\(/;
const TRAILING = /\.\s*getAXState\s*\([^)]*\)\s*;?\s*(?:nodeRepl\.write\([^;]*\)\s*;?\s*)*$/;
const lines = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; };

export function trailingReads(events) {
  let calls = 0, trailing = 0;
  for (const event of events) for (const item of event?.message?.content ?? []) {
    if (item?.type !== 'tool_use' || typeof item.input?.code !== 'string') continue;
    calls++;
    if (ACTION.test(item.input.code) && TRAILING.test(item.input.code.trim())) trailing++;
  }
  return { calls, trailing };
}

export function callTimes(rows) {
  const open = new Map(), ended = [], read = [];
  let current;
  for (const { t, direction, msg } of rows) {
    if (!msg || typeof msg !== 'object') continue;
    if (direction === 'to-server' && msg.method === 'tools/call' && Number.isInteger(msg.id)) {
      open.set(msg.id, { start: Date.parse(t), phases: [], approvals: 0 }); current = msg.id;
    } else if (direction === 'from-server' && msg.method === 'elicitation/create' && open.has(current)) open.get(current).approvals++;
    else if (direction === 'guard-read' && open.has(msg.id)) open.get(msg.id).phases.push(msg.phase);
    else if (direction === 'to-client' && msg.result && open.has(msg.id)) {
      const call = open.get(msg.id), ms = Date.parse(t) - call.start, phases = call.phases.join(',');
      open.delete(msg.id);
      if (call.approvals !== 3) continue;
      if (phases === 'before-action,after-call') ended.push(ms);
      else if (phases === 'before-action') read.push(ms);
    }
  }
  return { ended, read };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const round of process.argv.slice(2)) {
    const tasks = readdirSync(round).filter(name => existsSync(join(round, name, 'events.jsonl')));
    for (const task of tasks) {
      const { calls, trailing } = trailingReads(lines(join(round, task, 'events.jsonl')));
      console.log(`${round}\t${task}\tcalls ${calls}\ttrailing reads ${trailing}`);
    }
    const traces = `${round.replace(/\/$/, '')}.trace`;
    if (!existsSync(traces) || !statSync(traces).isDirectory()) continue;
    const ended = [], read = [];
    for (const file of readdirSync(traces).filter(name => name.endsWith('.jsonl'))) {
      const times = callTimes(lines(join(traces, file)));
      ended.push(...times.ended); read.push(...times.read);
    }
    console.log(`${round}\tone-action calls ending on the action: n=${ended.length} median ${median(ended)} ms; ending on a read: n=${read.length} median ${median(read)} ms`);
  }
}
