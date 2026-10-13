#!/usr/bin/env node
// Offline payload forms, not page semantics. No links or saved code are followed.
// Usage: node bench/fowl/browser-result-census.mjs [--json] [--shared-clock] <round dir>...
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

const kinds = ['fullTree', 'delta', 'artifactLink', 'actionNotice', 'codeEcho', 'docs', 'unknown'];
const zero = () => Object.fromEntries(kinds.map(kind => [kind, 0]));
const utf8 = value => Buffer.byteLength(value);
const jsonBytes = value => utf8(JSON.stringify(value) ?? 'null');
const blocks = event => Array.isArray(event?.message?.content) ? event.message.content : [];
const family = name => {
  name = String(name ?? '').replaceAll('-', '_');
  if (/^mcp__.*playwright[^]*__/.test(name)) return 'playwright';
  if (/^mcp__.*chrome_devtools[^]*__/.test(name)) return 'devtools';
  if (/^mcp__fowlbrowser__/.test(name)) return 'fowlbrowser';
  if (/^mcp__.*sleight[^]*__/.test(name)) return 'sleight';
  return 'unknown';
};
const treeJSON = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.role === 'string' &&
  (value.children === undefined || Array.isArray(value.children) && value.children.every(treeJSON));

export function classifyBrowserText(arm, text) {
  const result = zero();
  if (typeof text !== 'string') { result.unknown = jsonBytes(text); return result; }
  if (!['playwright', 'devtools', 'fowlbrowser', 'sleight'].includes(arm)) { result.unknown = utf8(text); return result; }
  if (/^\s*[{[]/.test(text)) {
    let kind = 'unknown';
    try {
      const value = JSON.parse(text);
      if (arm === 'devtools' && treeJSON(value)) kind = 'fullTree';
      if (arm === 'playwright' && value && typeof value === 'object' && Object.keys(value).length === 1) {
        const snapshot = value.snapshot;
        if (snapshot && typeof snapshot === 'object' && Object.keys(snapshot).length === 1 && typeof snapshot.file === 'string') kind = 'artifactLink';
        else if (treeJSON(snapshot) || Array.isArray(snapshot) && snapshot.every(treeJSON)) kind = 'fullTree';
        else if (typeof snapshot === 'string' && /^\s*- \w/.test(snapshot)) kind = 'fullTree';
        else if (typeof value['ran playwright code'] === 'string') kind = 'codeEcho';
      }
    } catch {}
    result[kind] = utf8(text); return result;
  }
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let kind = 'unknown', fenced = false, browser = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/, ''), next = (lines[i + 1] ?? '').trim();
    if (fenced) {
      result[kind] += utf8(lines[i]);
      if (/^```\s*$/.test(line)) { fenced = false; if (kind !== 'docs') kind = 'unknown'; }
      continue;
    }
    if (arm === 'playwright' && /^### /.test(line)) {
      if (line === '### Ran Playwright code') kind = 'codeEcho';
      else if (line === '### Snapshot') kind = /^- \[Snapshot\]\([^)]+\)$/.test(next) ? 'artifactLink' :
        /^```(?:yaml|json)$/.test(next) ? 'fullTree' : 'unknown';
      else kind = /^### (?:Page|Open tabs|Modal state|Error)$/.test(line) ? 'actionNotice' : 'unknown';
    } else if (arm === 'fowlbrowser') {
      if (/^Browser: .+ · Tab: .+ · /.test(line)) { browser = true; kind = 'actionNotice'; }
      else if (browser && /^Snapshot (?:\d+ of this tab|of [\w-]+):$/.test(line) && next === '```yaml') kind = 'fullTree';
      else if (browser && /^(?:Changes|No changes) since snapshot \d+ of this tab[; ]/.test(line)) kind = 'delta';
    } else if (arm === 'devtools') {
      if (line === '## Latest page snapshot') kind = /^uid=|^\{/.test(next) ? 'fullTree' : 'unknown';
      else if (i === 0 && /^uid=[\w-]+ /.test(line)) kind = 'fullTree';
      else if (/^Saved snapshot to .+\.$/.test(line)) kind = 'artifactLink';
      else if (/^## /.test(line)) kind = 'unknown';
    } else if (arm === 'sleight') {
      if (/^Browser tab: \d+, Title: "(?:[^"\\]|\\.)*", URL: "(?:[^"\\]|\\.)*"\.$/.test(line)) { browser = true; kind = 'fullTree'; }
      else if (/^Window: /.test(line)) { browser = false; kind = 'unknown'; }
      else if (browser && /^sleight: (?:lines changed since|no change since) the last full tree/.test(line)) kind = 'delta';
      else if ((i === 0 || kind === 'docs') && /^(?:## Computer Use|# Other Browser APIs|# API Reference|# Computer Use Confirmations Policy|# Browser Interaction Troubleshooting|## Browser Computer Use|<app_specific_instructions>)/.test(line)) kind = 'docs';
      else if (!line && kind !== 'docs') kind = 'unknown';
    }
    if (kind === 'unknown' && /^(?:Successfully (?:clicked|filled|typed|pressed|dragged)|sleight: )/.test(line)) {
      result.actionNotice += utf8(lines[i]); continue;
    }
    if (/^```/.test(line)) fenced = true;
    result[kind] += utf8(lines[i]);
  }
  return result;
}

const unionMs = intervals => {
  let total = 0, end = -Infinity;
  for (const [start, finish] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, finish - Math.max(start, end)); end = Math.max(end, finish);
  }
  return total;
};
const usageFields = { input: ['input_tokens', 'inputTokens'], output: ['output_tokens', 'outputTokens'],
  cacheRead: ['cache_read_input_tokens', 'cacheReadInputTokens'], cacheWrite: ['cache_creation_input_tokens', 'cacheCreationInputTokens'] };
const emptyUsage = () => Object.fromEntries(Object.keys(usageFields).map(key => [key, null]));
const empty = () => ({ results: 0, duplicateResults: 0, conflictingResults: 0, missingIntervals: 0,
  imageBlocks: 0, imageJsonBytes: 0, otherBlocks: 0, otherBlockJsonBytes: 0,
  textBytes: zero(), resultKinds: { ...zero(), image: 0 } });

function analyze(events) {
  const requests = new Map(), receipts = new Map(), arms = new Set(), intervals = [], r = empty();
  let finalUsage = emptyUsage();
  for (const event of events) {
    if (event?.type === 'assistant') for (const block of blocks(event)) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
      const fingerprint = JSON.stringify(block), existing = requests.get(block.id);
      if (existing) { if (existing.fingerprint !== fingerprint) existing.conflict = true; continue; }
      const arm = family(block.name); if (arm !== 'unknown') arms.add(arm);
      requests.set(block.id, { arm, at: event.t, fingerprint });
    }
    if (event?.type === 'user') for (const block of blocks(event)) {
      if (block?.type !== 'tool_result') continue;
      const id = block.tool_use_id ?? Symbol(), fingerprint = createHash('sha256').update(JSON.stringify(block.content) ?? 'null').digest('hex');
      const existing = receipts.get(id);
      if (existing) {
        r.duplicateResults++;
        if (existing.fingerprint !== fingerprint) existing.conflict = true;
      } else receipts.set(id, { content: block.content, fingerprint, at: event.t, request: requests.get(id) });
    }
    if (event?.type === 'result') {
      for (const [key, [field, modelField]] of Object.entries(usageFields)) {
        const value = event.usage?.[field], models = event.modelUsage && typeof event.modelUsage === 'object' ? Object.values(event.modelUsage).map(item => item?.[modelField]) : [];
        finalUsage[key] = Number.isFinite(value) && value >= 0 ? value : models.length && models.every(item => Number.isFinite(item) && item >= 0) ? models.reduce((a, b) => a + b, 0) : null;
      }
    }
  }
  for (const receipt of receipts.values()) {
    r.results++; const flags = new Set();
    if (receipt.conflict) r.conflictingResults++;
    const content = typeof receipt.content === 'string' ? [{ type: 'text', text: receipt.content }] : Array.isArray(receipt.content) ? receipt.content : [receipt.content];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const classified = classifyBrowserText(receipt.conflict || receipt.request?.conflict ? 'unknown' : receipt.request?.arm, block.text);
        for (const kind of kinds) { r.textBytes[kind] += classified[kind]; if (classified[kind]) flags.add(kind); }
      } else if (block?.type === 'image') { r.imageBlocks++; r.imageJsonBytes += jsonBytes(block); flags.add('image'); }
      else { r.otherBlocks++; r.otherBlockJsonBytes += jsonBytes(block); flags.add('unknown'); }
    }
    for (const kind of flags) r.resultKinds[kind]++;
    if (!receipt.conflict && !receipt.request?.conflict && Number.isFinite(receipt.request?.at) && Number.isFinite(receipt.at) && receipt.at >= receipt.request.at)
      intervals.push([receipt.request.at, receipt.at]);
    else r.missingIntervals++;
  }
  const textTotal = Object.values(r.textBytes).reduce((a, b) => a + b, 0);
  const arm = arms.size === 2 && arms.has('sleight') && arms.has('fowlbrowser') ? 'fowl+sleight' : [...arms].sort().join('+') || 'unknown';
  return { summary: { ...r, arm, textTotal, textCoverage: textTotal ? (textTotal - r.textBytes.unknown) / textTotal : null,
    toolUnionMs: intervals.length ? unionMs(intervals) : null, finalUsage, perCallTokens: null, perCallTransportMs: null }, intervals };
}

export const resultCensus = events => analyze(events).summary;

export function roundResultCensus(dir, { sharedClock = false } = {}) {
  const files = [], groups = {}, arms = {}; let malformedLines = 0;
  const visit = folder => {
    if (!lstatSync(folder).isDirectory()) return;
    const file = join(folder, 'events.jsonl');
    if (existsSync(file) && lstatSync(file).isFile()) { files.push(file); return; }
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) if (entry.isDirectory()) visit(join(folder, entry.name));
  };
  visit(dir);
  for (const file of files) {
    const events = readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { malformedLines++; return []; }
    });
    const run = analyze(events), arm = run.summary.arm;
    (groups[arm] ??= []).push(run);
  }
  for (const [arm, runs] of Object.entries(groups).sort()) {
    const aggregate = { runs: runs.length, ...empty() }, usageKnown = Object.fromEntries(Object.keys(usageFields).map(key => [key, 0]));
    const knownUsage = { ...usageKnown };
    for (const { summary } of runs) {
      for (const key of Object.keys(empty())) {
        if (typeof aggregate[key] === 'number') aggregate[key] += summary[key];
        else for (const field of Object.keys(aggregate[key])) aggregate[key][field] += summary[key][field];
      }
      for (const key of Object.keys(usageFields)) if (summary.finalUsage[key] !== null) { usageKnown[key]++; knownUsage[key] += summary.finalUsage[key]; }
    }
    const intervals = runs.flatMap(run => run.intervals), textTotal = Object.values(aggregate.textBytes).reduce((a, b) => a + b, 0);
    arms[arm] = { ...aggregate, textTotal, textCoverage: textTotal ? (textTotal - aggregate.textBytes.unknown) / textTotal : null,
      toolUnionMs: intervals.length && (sharedClock || runs.length === 1) ? unionMs(intervals) : null,
      finalUsage: Object.fromEntries(Object.keys(usageFields).map(key => [key, usageKnown[key] === runs.length ? knownUsage[key] : null])),
      usageKnown, knownUsage, perCallTokens: null, perCallTransportMs: null };
  }
  return { round: basename(dir), runs: files.length, sharedClock, malformedLines, arms };
}

if (import.meta.main) {
  const args = process.argv.slice(2), sharedClock = args.includes('--shared-clock');
  const rounds = args.filter(arg => !['--json', '--shared-clock'].includes(arg)).map(dir => roundResultCensus(dir, { sharedClock }));
  if (args.includes('--json')) console.log(JSON.stringify(rounds, null, 2));
  else {
    console.log('| Round | Arm | Results | Text bytes | Classified % | Full tree | Delta | Artifact links | Code echo | Images | Tool union ms |');
    console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const round of rounds) for (const [arm, r] of Object.entries(round.arms))
      console.log(`| ${round.round} | ${arm} | ${r.results} | ${r.textTotal} | ${r.textCoverage === null ? 'unknown' : (100 * r.textCoverage).toFixed(2)} | ${r.textBytes.fullTree} | ${r.textBytes.delta} | ${r.textBytes.artifactLink} | ${r.textBytes.codeEcho} | ${r.imageBlocks} | ${r.toolUnionMs ?? 'unknown'} |`);
  }
}
