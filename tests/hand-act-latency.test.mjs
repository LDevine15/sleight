import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLatencyCycles, collectLatencyCycles, latencyMedian, LATENCY_CYCLES, LATENCY_ORDER } from './fixtures/hand-act-latency.mjs';

const drift = overhead => { let i = 0; return side => 1 + i++ * 0.002 + (side === 'on' ? overhead : 0); };
test('separate off/on blocks confound a known 0.02 ms hand cost with deterministic drift', () => {
  const measure = drift(0.02), off = [], on = [];
  for (let i = 0; i < 300; i++) off.push(measure('off'));
  for (let i = 0; i < 300; i++) on.push(measure('on'));
  assert.ok(latencyMedian(on) - latencyMedian(off) > 0.1, 'the original order rejects a subthreshold known cost');
});
test('counterbalanced cycles remove order confounding while timing all 300 samples per side', async () => {
  const measure = drift(0.02), order = [];
  const cycles = await collectLatencyCycles(side => { order.push(side); return measure(side); });
  const result = assessLatencyCycles(cycles);
  assert.equal(result.samplesPerCondition, 300); assert.equal(result.pass, true, JSON.stringify(result));
  assert.ok(Math.abs(result.deltaMs - 0.02) < 0.01);
  assert.deepEqual(order, Array.from({ length: LATENCY_CYCLES }, () => [...LATENCY_ORDER]).flat());
});
test('a known hand cost over 0.1 ms still fails in the presence of common drift', async () => {
  const result = assessLatencyCycles(await collectLatencyCycles(drift(0.15)));
  assert.ok(result.deltaMs >= 0.1); assert.equal(result.pass, false);
});
test('fixed whole-cycle bootstrap rejects uncertainty even when the observed median difference passes', () => {
  const cycles = Array.from({ length: LATENCY_CYCLES }, (_, i) => ({ off: Array(4).fill(1), on: Array(4).fill(i < 40 ? 1.05 : 1.15) }));
  const first = assessLatencyCycles(cycles), second = assessLatencyCycles(cycles);
  assert.deepEqual(first, second, 'seed and resample count are fixed before measuring');
  assert.equal(first.seed, 0x4f1bbcdc); assert.equal(first.resamples, 2000);
  assert.ok(first.deltaMs < 0.1); assert.ok(Math.abs(first.upper95Ms - 0.15) < 1e-12); assert.equal(first.pass, false);
});
test('resampling whole cycles preserves large common-mode variation on both sides', () => {
  const cycles = Array.from({ length: LATENCY_CYCLES }, (_, i) => ({ off: Array(4).fill(i * 2), on: Array(4).fill(i * 2 + 0.02) }));
  const result = assessLatencyCycles(cycles);
  assert.ok(Math.abs(result.deltaMs - 0.02) < 1e-12); assert.ok(Math.abs(result.upper95Ms - 0.02) < 1e-12);
  assert.equal(result.pass, true); assert.equal(result.samplesPerCondition, 300);
});
test('the original upper-median definition and strict 0.1 ms boundary remain', () => {
  assert.equal(latencyMedian([1, 2, 3, 4]), 3);
  const result = assessLatencyCycles(Array.from({ length: LATENCY_CYCLES }, () => ({ off: Array(4).fill(0), on: Array(4).fill(0.1) })));
  assert.equal(result.deltaMs, 0.1); assert.equal(result.pass, false);
});
test('missing, nonfinite or negative samples cannot qualify', () => {
  const good = () => Array.from({ length: LATENCY_CYCLES }, () => ({ off: [1, 1, 1, 1], on: [1, 1, 1, 1] }));
  for (const change of [c => c.pop(), c => c[0].on.pop(), c => { c[0].off[0] = NaN; }, c => { c[0].on[0] = -1; }]) {
    const cycles = good(); change(cycles); assert.throws(() => assessLatencyCycles(cycles), /LATENCY_SAMPLES_INVALID/);
  }
});
test('sparse inner samples cannot qualify', () => {
  const cycles = Array.from({ length: LATENCY_CYCLES }, () => ({ off: [1, 1, 1, 1], on: [1, 1, 1, 1] }));
  delete cycles[0].on[0];
  assert.throws(() => assessLatencyCycles(cycles), /LATENCY_SAMPLES_INVALID/);
});
test('sparse outer cycles cannot qualify', () => {
  const cycles = Array.from({ length: LATENCY_CYCLES }, () => ({ off: [1, 1, 1, 1], on: [1, 1, 1, 1] }));
  delete cycles[0];
  assert.throws(() => assessLatencyCycles(cycles), /LATENCY_SAMPLES_INVALID/);
});
