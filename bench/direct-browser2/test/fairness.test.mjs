import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCell } from '../perf.mjs';

const sample = (client, trial, extra = {}) => ({ client, processIncarnation: `fixture-${client}`, trial,
  concurrency: 4, workload: 'mixed', stage: 'warm-complete-tool', wallMs: 10 + client,
  queueMs: client, outcome: 'verified', policyEnabled: true, unrelatedEffects: 0, cleanupConfirmed: true,
  cpuMs: null, rssBytes: null, ...extra });
const records = () => Array.from({ length: 4 }, (_, client) => sample(client, 0));
test('synthetic process identities never qualify real multi-process performance', () => {
  const result = summarizeCell(records(), { concurrency: 4, trials: 1, evidence: 'synthetic' });
  assert.equal(result.qualified, false);
  assert.equal(result.p50Ms, 11);
  assert.equal(result.p90Ms, 13);
  assert.equal(result.cpuMs, null); assert.equal(result.rssBytes, null);
});
test('missing clients, duplicate samples and shared processes cannot form a complete cell', () => {
  for (const rows of [records().slice(1), [...records(), sample(0, 0)], records().map(r => ({ ...r, processIncarnation: 'same' }))]) {
    const result = summarizeCell(rows, { concurrency: 4, trials: 1, evidence: 'host' });
    assert.equal(result.qualified, false);
    assert.equal(result.complete, false);
    assert.equal(result.eligibleForHostReview, false);
  }
});
test('failed and unknown operations retain their time and prevent qualification', () => {
  const rows = records(); rows[0] = sample(0, 0, { wallMs: 100, outcome: 'unknown', cleanupConfirmed: false });
  const result = summarizeCell(rows, { concurrency: 4, trials: 1, evidence: 'host' });
  assert.equal(result.totalMs, 136);
  assert.equal(result.failures, 1);
  assert.equal(result.qualified, false);
  assert.equal(result.eligibleForHostReview, false);
});
test('disabled policy, unrelated effects and missing clocks cannot disappear from the result', () => {
  for (const extra of [{ policyEnabled: false }, { unrelatedEffects: 1 }, { wallMs: null }, { queueMs: -1 }]) {
    const rows = records(); rows[0] = sample(0, 0, extra);
    const result = summarizeCell(rows, { concurrency: 4, trials: 1, evidence: 'host' });
    assert.equal(result.qualified, false);
    assert.equal(result.eligibleForHostReview, false);
  }
});
test('mixed clocks, workloads and invalid matrix sizes are refused', () => {
  for (const extra of [{ stage: 'human-consent' }, { workload: 'other' }, { concurrency: 13 }]) {
    const rows = records(); rows[0] = sample(0, 0, extra);
    assert.throws(() => summarizeCell(rows, { concurrency: 4, trials: 1, evidence: 'host' }), /MIXED_CELL/);
  }
  assert.throws(() => summarizeCell([], { concurrency: 2, trials: 1 }), /INVALID_CELL/);
});
test('raw samples are preserved without mutating input and queue tails stay separate', () => {
  const rows = records(), before = structuredClone(rows);
  const result = summarizeCell(rows, { concurrency: 4, trials: 1, evidence: 'synthetic' });
  result.samples[0].wallMs = 900;
  assert.deepEqual(rows, before);
  assert.equal(result.queueP90Ms, 3);
  assert.equal(result.expected, 4);
});
test('complete host metadata is reviewable but never grants release qualification', () => {
  const result = summarizeCell(records(), { concurrency: 4, trials: 1, evidence: 'host' });
  assert.equal(result.complete, true);
  assert.equal(result.eligibleForHostReview, true);
  assert.equal(result.qualified, false);
});
test('unknown page data and accessor fields are rejected without serialization', () => {
  const rows = records(); rows[0].pageText = 'synthetic-private';
  assert.throws(() => summarizeCell(rows, { concurrency: 4, trials: 1 }), /INVALID_SAMPLE/);
  delete rows[0].pageText;
  let executions = 0;
  Object.defineProperty(rows[0], 'wallMs', { get() { executions++; return 10; } });
  assert.throws(() => summarizeCell(rows, { concurrency: 4, trials: 1 }), /INVALID_SAMPLE/);
  assert.equal(executions, 0);
  const accessor = [];
  Object.defineProperty(accessor, '0', { get() { executions++; return sample(0, 0); } });
  assert.throws(() => summarizeCell(accessor, { concurrency: 4, trials: 1 }), /INVALID_CELL/);
  const custom = records(); custom.map = () => { executions++; return []; };
  assert.throws(() => summarizeCell(custom, { concurrency: 4, trials: 1 }), /INVALID_CELL/);
  assert.equal(executions, 0);
});
