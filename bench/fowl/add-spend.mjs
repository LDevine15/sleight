#!/usr/bin/env node
// Adds a FowlBrowser rounds report's cost (Claude Code's usage per run) to sleight's monthly API spend ledger.
// Usage: node bench/fowl/add-spend.mjs <report.md> <ledger.json>
import { readFileSync, writeFileSync } from 'node:fs';

export function reportCost(text) {
  return text.split('\n').filter((l) => /^\| [a-z]/.test(l) && !/^\| agent/.test(l))
    .reduce((sum, l) => { const c = l.split('|').map((x) => x.trim()); const v = parseFloat(c[c.length - 2]); return sum + (Number.isFinite(v) ? v : 0); }, 0);
}

if (import.meta.main) {
  const [report, ledger] = process.argv.slice(2);
  const month = new Date().toISOString().slice(0, 7);
  let j; try { j = JSON.parse(readFileSync(ledger, 'utf8')); } catch { j = { month, usd: 0 }; }
  if (j.month !== month) j = { month, usd: 0 };
  j.usd = +(j.usd + reportCost(readFileSync(report, 'utf8'))).toFixed(6);
  writeFileSync(ledger, JSON.stringify(j));
}
