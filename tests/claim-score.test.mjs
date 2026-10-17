import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { excluded, score } from '../bench/claim-score.mjs';

const rules = JSON.parse(readFileSync(new URL('../bench/claim-exclusions.json', import.meta.url), 'utf8'));

test('the claim score drops each written exclusion with its reason and keeps the rest', () => {
  assert.equal(excluded({ task: 'local-wikipedia', seconds: 9 }, '2026-10-16T20-00.json', rules), 'not a claim task');
  assert.match(excluded({ task: 'finder-move', arm: 'cua', seconds: 0, reason: 'Fixture setup failed: x' }, '2026-10-16T20-00.json', rules), /setup failed/);
  assert.match(excluded({ task: 'calculator-click', arm: 'lcu', seconds: 6 }, '2026-10-16T17-43-02.json', rules), /PreToolUse/);
  assert.equal(excluded({ task: 'calculator-click', arm: 'sleight', seconds: 6 }, '2026-10-16T17-43-02.json', rules), undefined);
  assert.match(excluded({ task: 'textedit-drag', arm: 'sleight', seconds: 30 }, '2026-10-16T18-53.json', rules), /overlay/);
  assert.equal(excluded({ task: 'textedit-drag', arm: 'sleight', seconds: 30 }, '2026-10-16T20-23.json', rules), undefined);
});

test('expected time is the mean attempt divided by the pass rate, and never-passed tasks have none', () => {
  const table = score([
    { arm: 'a', task: 't', seconds: 10, passed: true }, { arm: 'a', task: 't', seconds: 30, passed: false },
    { arm: 'b', task: 't', seconds: 5, passed: false },
  ]);
  assert.equal(table.a.t.expected, 40);
  assert.equal(table.a.t.median, 10);
  assert.equal(table.b.t.expected, null);
});

test('a window exclusion with an arm drops only that arm\'s rows', () => {
  const own = { tasks: ['excel-edit'], reasons: [], files: [], windows: [{ tasks: ['excel-edit'], arm: 'sleight', before: '2026-10-17T10-51', why: 'pre-fix' }] };
  assert.equal(excluded({ task: 'excel-edit', arm: 'sleight', seconds: 60 }, '2026-10-17T10-25-49.json', own), 'pre-fix');
  assert.equal(excluded({ task: 'excel-edit', arm: 'codex', seconds: 60 }, '2026-10-17T04-43-59.json', own), undefined);
  assert.equal(excluded({ task: 'excel-edit', arm: 'sleight', seconds: 60 }, '2026-10-17T10-51-44.json', own), undefined);
});
