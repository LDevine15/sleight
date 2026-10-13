#!/usr/bin/env node
// Adds token-priced FowlBrowser results to sleight's monthly API spend ledger.
// Usage: node bench/fowl/add-spend.mjs <report.md> <ledger.json>
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokenCost } from './accounting.mjs';

export function roundCost(input) {
  const dir = statSync(input).isDirectory() ? input : dirname(input);
  const summary = join(dir, 'results.json');
  let loginOnly;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const events = join(dir, entry.name, 'events.jsonl');
    const runFile = join(dir, entry.name, 'run.json');
    const fundingFile = join(dir, entry.name, 'funding.json');
    const metadataFile = existsSync(fundingFile) ? fundingFile : runFile;
    if (!existsSync(events) && !existsSync(metadataFile)) continue;
    const run = existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile, 'utf8')) : {};
    if (run.funding === 'login') continue;
    if (run.funding === undefined) {
      if (run.surface === 'claude-cu' ||
          (run.agentConfig?.interactive === true && run.agentConfig.auth === 'isolated direct-plan login') ||
          run.result?.auth === 'isolated direct-plan login') continue;
      // Older tasks may need the final summary; durable funding does not.
      if (!loginOnly) {
        const rows = existsSync(summary) ? JSON.parse(readFileSync(summary, 'utf8')) : [];
        loginOnly = new Set(rows.filter(row => row.surface === 'claude-cu').map(row => row.task.name));
      }
      if (loginOnly.has(entry.name)) continue;
    }
    if (!existsSync(events)) {
      if (existsSync(metadataFile)) throw new Error(`Token cost unavailable for ${entry.name}: missing event transcript`);
      continue;
    }
    const results = readFileSync(events, 'utf8').split('\n').flatMap(line => {
      try { const value = JSON.parse(line); return value.type === 'result' ? [value] : []; } catch { return []; }
    });
    const cost = tokenCost(results.at(-1), run.model);
    if (!Number.isFinite(cost)) throw new Error(`Token cost unavailable for ${entry.name}: missing result, token counts or model price`);
    total += cost;
  }
  return Math.round(total * 1e7) / 1e7;
}

export function addRoundSpend(report, ledger, { now = new Date() } = {}) {
  const month = now.toISOString().slice(0, 7);
  let j; try { j = JSON.parse(readFileSync(ledger, 'utf8')); } catch { j = { month, usd: 0 }; }
  if (j.unpriced) throw new Error('Reconcile the previous round token cost before adding spend');
  if (j.month !== month) j = { ...j, month, usd: 0 };
  let cost;
  try { cost = roundCost(report); }
  catch (error) {
    writeFileSync(ledger, JSON.stringify({ ...j, unpriced: true, unpricedRound: report }));
    throw error;
  }
  j.usd = Math.round((Math.round(j.usd * 1e7) + Math.round(cost * 1e7)) / 10) / 1e6;
  writeFileSync(ledger, JSON.stringify(j));
  return j.usd;
}

if (import.meta.main) addRoundSpend(...process.argv.slice(2));
