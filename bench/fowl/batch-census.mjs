#!/usr/bin/env node
// Saved-trace candidates for owner review, never guard or speed proof.
import path from 'node:path';
import { loadRoundEvents, callClass } from './anatomy.mjs';

const ts = await import('typescript').then(module => module.default).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
export const hasSourceParser = !!ts;
export const textOf = block => typeof block.content === 'string' ? block.content :
  Array.isArray(block.content) ? block.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : '';

// Identical stream replays count once. Conflicting replays invalidate an exchange.
export function toolExchanges(events) {
  const calls = new Map(), results = new Map(), conflicts = new Set();
  let malformed = 0, position = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object' || !Array.isArray(event.message?.content)) {
      if (!event || typeof event !== 'object' || !event.type || ['assistant', 'user'].includes(event.type)) malformed++;
      continue;
    }
    for (const block of event.message.content) {
      const use = event.type === 'assistant' && block?.type === 'tool_use';
      const result = event.type === 'user' && block?.type === 'tool_result';
      if (!use && !result) continue;
      const id = use ? block.id : block.tool_use_id;
      if (typeof id !== 'string' || !id) { malformed++; continue; }
      const bank = use ? calls : results, signature = JSON.stringify(block);
      if (bank.has(id)) {
        if (bank.get(id).signature !== signature) conflicts.add(id);
        continue;
      }
      bank.set(id, { block, at: Number.isFinite(event.t) ? event.t : null, position: position++, signature });
    }
  }
  return { malformed, orphanResults: [...results.keys()].filter(id => !calls.has(id)).length,
    calls: [...calls].map(([id, call]) => ({ id, ...call, result: results.get(id), conflict: conflicts.has(id) })) };
}

export function intervalUnion(intervals) {
  const ordered = intervals.filter(([a, b]) => a !== null && b !== null && Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, start, end;
  for (const [a, b] of ordered) {
    if (end === undefined) { start = a; end = b; }
    else if (a <= end) end = Math.max(end, b);
    else { total += end - start; start = a; end = b; }
  }
  return total + (end === undefined ? 0 : end - start);
}

function observation(text) {
  const engine = /^Browser tab: ([^,\n]+), Title: "[^\n]*", URL: "([^\n]+)"\.\n/m.exec(text);
  const fowl = /^Browser: [^\n]+ · Tab: ([^ ·\n]+) · [^\n]+ · (https?:\/\/[^\n]+)\n/m.exec(text);
  const head = engine || fowl;
  if (!head || /The following is a diff|browser tree lines omitted|Snapshot truncated/i.test(text) ||
      (!engine && !/\nSnapshot \d+ of this tab:\n```yaml\n/.test(text))) return;
  const rows = [];
  for (const line of text.split('\n')) {
    if (engine) {
      const row = /^\t*(\d+) (text field|checkbox|radio button|combo box)\b(.*)$/.exec(line);
      if (!row) continue;
      const id = /\bID: ([^,\n]+)/.exec(row[3])?.[1];
      const name = row[3].replace(/\(settable\)/g, '').replace(/^.*?Description: /, '').split(/, (?:Value|ID|Help):/)[0].trim();
      rows.push({ ref: row[1], id, name, role: row[2] });
    } else {
      const row = /^\s*- (textbox|checkbox|radio|combobox)\b(?: ("(?:[^"\\]|\\.)*"))?[^\n]*\[ref=([^\]]+)\]/.exec(line);
      if (!row) continue;
      let name;
      try { name = row[2] ? JSON.parse(row[2]) : ''; } catch { return; }
      rows.push({ ref: row[3], name, role: row[1] });
    }
  }
  if ((text.match(/^Browser tab: |^Browser: /gm) ?? []).length !== 1) return;
  return { tab: head[1], url: head[2], rows };
}

function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
}

function sourcePlan(code) {
  if (!ts || typeof code !== 'string') return { reason: 'source-parser-unavailable' };
  const file = ts.createSourceFile('saved.mjs', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) return { reason: 'unknown-code' };
  let opened;
  const setup = file.statements.every(statement => {
    if (ts.isExpressionStatement(statement) && ts.isIdentifier(statement.expression)) return statement.expression.text === opened?.open;
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return false;
    const declaration = statement.declarationList.declarations[0];
    const call = declaration.initializer && ts.isAwaitExpression(declaration.initializer) ? declaration.initializer.expression : null;
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(declaration.name)) return false;
    let nested = false;
    const inspect = node => { if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node)) nested = true; ts.forEachChild(node, inspect); };
    for (const argument of call.arguments) inspect(argument);
    if (nested) return false;
    if (call.expression.getText(file) === 'cua.getBrowser') return true;
    if (call.expression.getText(file) !== 'cua.createBrowserTab' || opened) return false;
    opened = { open: declaration.name.text, url: call.arguments[1] && literal(call.arguments[1]) };
    return typeof opened.url === 'string';
  });
  if (setup && opened) return opened;
  if (file.statements.length !== 1) return { reason: 'mixed-code' };
  const statement = file.statements[0];
  if (ts.isVariableStatement(statement)) return { reason: 'setup-or-unknown' };
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return { reason: 'unknown-code' };
  const call = statement.expression.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || call.questionDotToken) return { reason: 'unknown-code' };
  const method = call.expression.name.text, receiver = call.expression.expression;
  if (ts.isIdentifier(receiver) && method === 'setValue' && call.arguments.length === 2) {
    const ref = literal(call.arguments[0]), value = literal(call.arguments[1]);
    if (Number.isInteger(ref) && typeof value === 'string') return { root: receiver.text, targets: [{ ref: String(ref) }] };
  }
  if (method !== 'fill' || call.arguments.length !== 1 || typeof literal(call.arguments[0]) !== 'string' || !ts.isCallExpression(receiver) ||
      !ts.isPropertyAccessExpression(receiver.expression)) return { reason: 'action-or-read-barrier' };
  const chooser = receiver.expression, name = chooser.name.text, base = chooser.expression.getText(file);
  const root = /^([A-Za-z_$][\w$]*)\.playwright$/.exec(base)?.[1];
  const target = receiver.arguments[0] && literal(receiver.arguments[0]);
  if (!root || typeof target !== 'string') return { reason: 'unknown-target' };
  if (name === 'locator' && receiver.arguments.length === 1 && /^#[A-Za-z_][\w-]*$/.test(target)) return { root, targets: [{ id: target.slice(1) }] };
  if (name === 'getByLabel' && receiver.arguments.length === 2) {
    const options = receiver.arguments[1];
    if (ts.isObjectLiteralExpression(options) && options.properties.length === 1 && ts.isPropertyAssignment(options.properties[0]) &&
        options.properties[0].name.getText(file) === 'exact' && literal(options.properties[0].initializer) === true) {
      return { root, targets: [{ name: target }] };
    }
  }
  return { reason: 'unknown-target' };
}

function plan(block) {
  const tool = /^mcp__fowlbrowser__(\w+)$/.exec(block.name)?.[1], input = block.input;
  if (tool === 'tab_open') return { open: true, url: input?.url };
  if (tool === 'type' && typeof input?.tab === 'string' && typeof input?.ref === 'string' && typeof input?.text === 'string') {
    return { tab: input.tab, targets: [{ ref: input.ref }] };
  }
  if (tool === 'fill_form' && typeof input?.tab === 'string' && Array.isArray(input.fields) && input.fields.length &&
      input.fields.every(field => typeof field?.ref === 'string' && ['string', 'number', 'boolean'].includes(typeof field.value))) {
    return { tab: input.tab, targets: input.fields.map(field => ({ ref: field.ref })) };
  }
  if (/^mcp__plugin_sleight_computer__js$/.test(block.name)) return sourcePlan(input?.code);
  return { reason: 'barrier-' + callClass(block.name ?? '', input) };
}

function identities(view, targets) {
  const selected = [];
  for (const target of targets) {
    const [key, value] = Object.entries(target)[0];
    const matches = view?.rows.filter(row => row[key] === value) ?? [];
    if (matches.length !== 1) return;
    const row = matches[0];
    if (!row.name && !row.id) return;
    const identity = JSON.stringify([row.role, row.name, row.id]);
    if (view.rows.filter(other => JSON.stringify([other.role, other.name, other.id]) === identity).length !== 1) return;
    selected.push(identity);
  }
  return selected;
}

export function batchCensus(events) {
  const exchanges = toolExchanges(events), owned = new Set(), roots = new Map(), views = new Map();
  const out = { calls: exchanges.calls.length, candidates: 0, candidateCalls: 0, gapMs: 0, toolMs: 0,
    unknownTiming: 0, malformed: exchanges.malformed, orphanResults: exchanges.orphanResults,
    reasons: {}, verifiedSavingsMs: 0, candidateOnly: true };
  const intervals = [], gaps = [], included = new Set();
  const pending = new Map(), timeline = exchanges.calls.flatMap(exchange => [
    { position: exchange.position, exchange, dispatch: true },
    ...(exchange.result ? [{ position: exchange.result.position, exchange }] : []),
  ]).sort((a, b) => a.position - b.position);
  let previous;
  const finish = current => {
    const { exchange, operation, tab, before, identity } = current;
    const result = exchange.result, text = result ? textOf(result.block) : '', fresh = observation(text);
    const failed = exchange.conflict || !result || result.position < exchange.position || result.block.is_error ||
      /permission|refus|denied|failed|error|interrupted|not found|unverified/i.test(text) ||
      [...text.matchAll(/Filled (\d+) of (\d+) fields/g)].some(match => match[1] !== match[2]);
    let reason = failed ? 'failed-or-unconfirmed-result' : current.overlap ? 'overlapping-call' : operation.reason;
    if (!reason && operation.open) {
      if (fresh && fresh.url === operation.url) { owned.add(fresh.tab); if (typeof operation.open === 'string') roots.set(operation.open, fresh.tab); }
      reason = 'setup';
    }
    if (!reason && (!owned.has(tab) || !before || !identity?.length)) reason = 'unknown-observed-identity';
    if (!reason && (!fresh || fresh.tab !== tab || fresh.url !== before.url)) reason = 'missing-or-changed-observation';
    const afterIdentity = !reason && identities(fresh, operation.targets);
    if (!reason && (!afterIdentity || JSON.stringify(identity) !== JSON.stringify(afterIdentity))) reason = 'changed-control';
    if (reason) { out.reasons[reason] = (out.reasons[reason] ?? 0) + 1; previous = undefined; }
    else {
      const predecessor = current.previous;
      if (predecessor && predecessor.exchange.result.position < exchange.position && predecessor.tab === tab &&
          predecessor.before.url === before.url && current.identity.every(key =>
        predecessor.before.rows.filter(row => JSON.stringify([row.role, row.name, row.id]) === key).length === 1)) {
        out.candidates++;
        const a = predecessor.exchange, b = exchange;
        for (const item of [a, b]) { included.add(item.id); intervals.push([item.at, item.result.at]); }
        if ([a.at, a.result.at, b.at, b.result.at].some(value => value === null) || a.result.at < a.at || b.result.at < b.at) out.unknownTiming++;
        else if (b.at >= a.result.at) gaps.push([a.result.at, b.at]);
      }
      previous = current;
    }
    if (fresh && !failed && !current.overlap) views.set(fresh.tab, fresh); else if (tab) views.delete(tab);
  };
  for (const entry of timeline) {
    const { exchange } = entry;
    if (entry.dispatch) {
      const operation = plan(exchange.block), tab = operation.tab ?? roots.get(operation.root), before = views.get(tab);
      const current = { exchange, operation, tab, before, identity: identities(before, operation.targets ?? []),
        previous, overlap: pending.size > 0 };
      // Dispatch invalidates the old view. Results establish evidence only when they arrive.
      for (const active of pending.values()) active.overlap = true;
      pending.set(exchange.id, current); previous = undefined;
      if (tab) views.delete(tab);
    } else {
      const current = pending.get(exchange.id); if (!current) continue;
      pending.delete(exchange.id); finish(current);
    }
  }
  for (const current of pending.values()) finish(current);
  out.candidateCalls = included.size; out.gapMs = intervalUnion(gaps); out.toolMs = intervalUnion(intervals);
  return out;
}

export function roundBatchCensus(dir) {
  const runs = Object.values(loadRoundEvents(dir)).map(batchCensus);
  const total = { runs: runs.length, calls: 0, candidates: 0, candidateCalls: 0, gapMs: 0, toolMs: 0, unknownTiming: 0,
    malformed: 0, orphanResults: 0, reasons: {}, verifiedSavingsMs: 0, candidateOnly: true };
  for (const run of runs) {
    for (const key of ['calls', 'candidates', 'candidateCalls', 'gapMs', 'toolMs', 'unknownTiming', 'malformed', 'orphanResults']) total[key] += run[key];
    for (const [key, value] of Object.entries(run.reasons)) total.reasons[key] = (total.reasons[key] ?? 0) + value;
  }
  return total;
}

if (import.meta.main) {
  const rows = process.argv.slice(2).filter(arg => arg !== '--json').map(dir => ({ round: path.basename(dir), ...roundBatchCensus(dir) }));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else for (const row of rows) console.log(`${row.round}: ${row.candidates} review-candidate pairs, ${row.candidateCalls}/${row.calls} calls, ${row.gapMs} ms recorded gaps, ${row.toolMs} ms tool-interval union, ${row.unknownTiming} unknown timing; verified savings 0`);
}
