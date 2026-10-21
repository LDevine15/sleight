// Test measurement only. The caller times the complete action and drains deferred work outside that interval.
export const LATENCY_ORDER = Object.freeze(['off', 'on', 'on', 'off', 'on', 'off', 'off', 'on']);
export const LATENCY_CYCLES = 75;
export const LATENCY_LIMIT_MS = 0.1;
export const BOOTSTRAP_SEED = 0x4f1bbcdc;
export const BOOTSTRAP_RESAMPLES = 2000;

export async function collectLatencyCycles(measure) {
  const cycles = [];
  for (let i = 0; i < LATENCY_CYCLES; i++) {
    const cycle = { off: [], on: [] };
    for (const side of LATENCY_ORDER) cycle[side].push(await measure(side));
    cycles.push(cycle);
  }
  return cycles;
}

// Match the original test's upper middle order statistic for its even sample count.
export const latencyMedian = values => [...values].sort((a, b) => a - b)[values.length >> 1];
export function assessLatencyCycles(cycles) {
  if (!Array.isArray(cycles) || cycles.length !== LATENCY_CYCLES) throw Error('LATENCY_SAMPLES_INVALID');
  for (let i = 0; i < LATENCY_CYCLES; i++) {
    if (!Object.hasOwn(cycles, i)) throw Error('LATENCY_SAMPLES_INVALID');
    for (const side of ['off', 'on']) {
      const values = cycles[i]?.[side];
      if (!Array.isArray(values) || values.length !== 4) throw Error('LATENCY_SAMPLES_INVALID');
      for (let j = 0; j < 4; j++) {
        if (!Object.hasOwn(values, j) || !Number.isFinite(values[j]) || values[j] < 0) throw Error('LATENCY_SAMPLES_INVALID');
      }
    }
  }
  const off = cycles.flatMap(c => c.off), on = cycles.flatMap(c => c.on);
  const deltaMs = latencyMedian(on) - latencyMedian(off);
  let state = BOOTSTRAP_SEED;
  const pick = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    return Math.floor(state / 0x100000000 * cycles.length);
  };
  const bootstrap = [];
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
    const sampledOff = [], sampledOn = [];
    for (let i = 0; i < cycles.length; i++) { const cycle = cycles[pick()]; sampledOff.push(...cycle.off); sampledOn.push(...cycle.on); }
    bootstrap.push(latencyMedian(sampledOn) - latencyMedian(sampledOff));
  }
  bootstrap.sort((a, b) => a - b);
  const upper95Ms = bootstrap[Math.ceil(BOOTSTRAP_RESAMPLES * 0.95) - 1];
  const summary = values => ({ median: latencyMedian(values), p95: [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] });
  return { off: summary(off), on: summary(on), deltaMs, upper95Ms, samplesPerCondition: off.length,
    cycles: cycles.length, resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED,
    pass: deltaMs < LATENCY_LIMIT_MS && upper95Ms < LATENCY_LIMIT_MS };
}
