import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRows, scoreSide } from '../bench/ab-score.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const row = (task, passed, turns, model = 'claude-haiku-5-5') => ({ arm: 'sleight', task, passed, seconds: turns, turns,
  timing: { totalMs: turns * 1000, modelMs: turns * 800 }, usage: { input: 1, cacheRead: 10, cacheWrite: 5, output: turns * 100 }, models: [model] });

test('the A/B score splits claim and held-out tasks and drops rows from another model', t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ab-score-')));
  writeFileSync(join(dir, '2026-10-17T02-00-00.json'), JSON.stringify({ results: [row('calculator-click', true, 3), row('calculator-click', false, 5),
    row('calculator-click', true, 4), row('finder-rename', true, 6), row('finder-rename', true, 9, 'claude-haiku-4-5'), { ...row('chess-drag', false, 0), seconds: null }] }));
  writeFileSync(join(dir, '2026-10-16T00-00-00.json'), JSON.stringify({ results: [row('calculator-click', true, 99)] }));
  const { rows, dropped } = readRows(dir, '2026-10-17T00-00', 'claude-haiku-5-5');
  assert.deepEqual(dropped, { 'model claude-haiku-4-5': 1, skipped: 1 });
  const side = scoreSide(rows, ['calculator-click']);
  assert.deepEqual(side.claim['calculator-click'], { runs: 3, passes: 2, turns: 4, totalS: 4, modelS: 3.2, output: 400, prompt: 16 });
  assert.equal(side.heldOut.total.passes, 1);
  assert.equal(side.heldOut['finder-rename'].turns, 6);
});

test('round totals pair one results file per round, failures included', async () => {
  const { roundTotals } = await import('../bench/ab-score.mjs');
  const rows = [{ ...row('calculator-click', true, 3), round: 'b' }, { ...row('finder-rename', false, 5), round: 'b' },
    { ...row('calculator-click', true, 4), round: 'a' }];
  assert.deepEqual(roundTotals(rows), [{ runs: 1, passes: 1, totalS: 4, modelS: 3.2, turns: 4 }, { runs: 2, passes: 1, totalS: 8, modelS: 6.4, turns: 8 }]);
});
