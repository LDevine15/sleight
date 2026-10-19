// Offline only: what SLEIGHT_OUTCOMES=1 adds to recorded native results, in characters. No transcript code is evaluated.
//   node bench/outcome-chars.mjs [--show] <transcript.jsonl or events.jsonl, or folders holding them>...
// Each window's tree is rebuilt from the recorded full trees and "lines changed" diffs (added lines go at the end, so
// order is approximate). Each call's literal actions are grouped by the guard's read rule (a key, text or coordinate
// action right after typing, setValue or a plain key skips its read) and every group is compared from the window
// before the call to the window after it, since a recording keeps no reads in between. Removed: the call-level
// "UI changed (...)" or "UI unverified (...)" field the outcome lines replace. Rereads: read-only calls (a read or an
// acquisition, no action) right after a call that acted, the turns outcome lines are meant to save.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { actionOutcome, outcomeRecord, renderOutcomes } from '../plugins/sleight/lib/action-outcomes.mjs';
import { promptNotice } from '../plugins/sleight/lib/prompt-notice.mjs';

const files = paths => paths.flatMap(path => statSync(path).isDirectory()
  ? readdirSync(path).flatMap(name => files([join(path, name)])) : /(?:transcript|events)\.jsonl$/.test(path) ? [path] : []);
const textOf = content => typeof content === 'string' ? content : (content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
const ACTIONS = /\.(click|setValue|selectText|performSecondaryAction|scroll|drag|pressKey|typeText|paste)\s*\(\s*([^)]*)\)/g;
const key = line => line.replace(/^(\t*)\d+ /, '$1');

// The window's lines after this result: a full tree replaces them, a diff edits them.
function apply(trees, text) {
  const at = text.lastIndexOf('Window: ');
  if (at < 0) return;
  const block = text.slice(at).split('\n'), window = block[0];
  const diff = block.findIndex(line => /^sleight: (?:lines changed|no change) since/.test(line));
  if (diff < 0) { trees.set(window, block.filter(line => !/^sleight:/.test(line))); return window; }
  const lines = [...(trees.get(window) ?? block.slice(0, 2))];
  lines[1] = block[1];
  for (const line of block.slice(diff + 1)) {
    if (line.startsWith('- ')) { const i = lines.findIndex(old => key(old) === line.slice(2) || old === line.slice(2)); if (i > 1) lines.splice(i, 1); }
    else if (line.startsWith('+ ')) lines.push(line.slice(2));
  }
  trees.set(window, lines);
  return window;
}

function records(code, before, after) {
  const recs = [];
  for (const [, a, args] of String(code).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, s => s.replace(/[()]/g, ' ')).matchAll(ACTIONS)) {
    const literal = /^\s*["'`]([^"'`]*)["'`]/.exec(args)?.[1], number = /^\s*(\d+)\s*(?:,|$)/.exec(args)?.[1];
    const rec = { a };
    if (number !== undefined) rec.n = Number(number);
    if (a === 'pressKey' && literal && (/^(?:return|enter|escape|esc|tab|space|backspace|delete|left|right|up|down)$/i.test(literal) || /(?:super|cmd|command|ctrl|control)\+/i.test(literal))) rec.k = literal;
    const typed = a === 'setValue' ? /,\s*["'`]([^"'`]*)["'`]/.exec(args)?.[1] : ['typeText', 'paste'].includes(a) ? literal : undefined;
    if (typed !== undefined) { rec.c = typed.length; if (a === 'setValue') rec.want = typed; }
    const tree = before?.join('\n') ?? '';
    if (rec.n !== undefined) rec.body = new RegExp(`^\\t*${rec.n} (.*)$`, 'm').exec(tree)?.[1];
    else if (typed !== undefined && a !== 'setValue') {
      const focus = /^The focused UI element is (\d+) (.*)$/m.exec(tree);
      if (focus) { rec.focus = Number(focus[1]); rec.body = focus[2]; }
    }
    recs.push(rec);
  }
  if (!recs.length) return;
  const quiet = rec => ['typeText', 'paste', 'setValue'].includes(rec.a) || rec.a === 'pressKey' && !rec.k;
  const treeFree = rec => ['pressKey', 'typeText', 'paste'].includes(rec.a) || rec.n === undefined && ['click', 'drag', 'scroll'].includes(rec.a) && !rec.body;
  let group = [];
  recs.forEach((rec, i) => {
    group.push(rec);
    const next = recs[i + 1];
    if (next && quiet(rec) && treeFree(next)) { rec.g = true; return; }
    rec.f = actionOutcome(group, before?.join('\n'), after?.join('\n')).facts;
    group = [];
  });
  return recs.map(outcomeRecord);
}

const rows = [], rereads = [];
const show = process.argv.includes('--show');
for (const file of files(process.argv.slice(2).filter(arg => arg !== '--show'))) {
  const uses = new Map(), trees = new Map();
  let acted = false, count = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block.type === 'tool_use') uses.set(block.id, block);
      if (block.type !== 'tool_result') continue;
      const use = uses.get(block.tool_use_id), text = textOf(block.content);
      if (!/__js$/.test(use?.name ?? '')) continue;
      const code = String(use.input?.code ?? ''), acts = new RegExp(ACTIONS.source).test(code);
      if (acted && !acts && /\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\(|\bcua\.getApp\(/.test(code)) count++;
      acted = acts;
      const window = text.lastIndexOf('Window: ') >= 0 ? text.slice(text.lastIndexOf('Window: ')).split('\n')[0] : undefined;
      const before = window && trees.get(window) && [...trees.get(window)];
      apply(trees, text);
      const outcomes = records(use.input?.code, before, window && trees.get(window));
      if (!outcomes) continue;
      const shown = renderOutcomes({ outcomes });
      const ui = /sleight: (UI (?:changed|unverified) \([^)]*\))(?:(; )|\.)/.exec(text);
      const removed = !ui ? 0 : ui[2] ? ui[1].length + 2 : ui[0].length + 1;
      if (show) console.log(`# ${use.input.code.slice(0, 200)}\n${shown}\n`);
      rows.push({ file, actions: outcomes.length, added: shown.length + 1, lean: promptNotice(shown, 'lean').length + 1, removed });
    }
  }
  rereads.push(count);
}
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b), sum = sorted.reduce((n, v) => n + v, 0);
  return { mean: +(sum / (sorted.length || 1)).toFixed(1), median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p90: sorted[Math.floor(sorted.length * 0.9)] ?? 0, max: sorted.at(-1) ?? 0, total: sum };
};
console.log(JSON.stringify({ transcripts: rereads.length, rereads: stats(rereads), results: rows.length,
  actions: stats(rows.map(row => row.actions)), added: stats(rows.map(row => row.added)), addedLean: stats(rows.map(row => row.lean)),
  removed: stats(rows.map(row => row.removed)), net: stats(rows.map(row => row.added - row.removed)),
  netLean: stats(rows.map(row => row.lean - row.removed)) }, null, 1));
