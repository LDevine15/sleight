// The ghost hand in benchmark arms. Arms run with it off (SLEIGHT_HAND=0), as the Firefox arms run with turbo off, so its
// panel and its page reads stay out of timing. SLEIGHT_BENCH_HAND=1 in the runner's environment turns it on for the cost pass
// (H6, bench/hand/cost-pass.mjs) and the turbo hidden-tab check (H8, bench/hand/h8-hidden-tab.mjs). Any other value stops
// the pass before it starts. On means only "not turned off": hand.json's opt-out still wins (lib/hand/settings.mjs).
export function benchHand(env = process.env) {
  const value = env.SLEIGHT_BENCH_HAND;
  if (value === undefined || value === '' || value === '0') return '0';
  if (value === '1') return '1';
  throw new Error(`SLEIGHT_BENCH_HAND must be 0 or 1, not ${JSON.stringify(String(value).slice(0, 20))}`);
}
