// Synthetic scheduler overhead only. Never connects to an engine or app.
import { NativeScheduler } from './scheduler.mjs';

const target = { pid: 1, processStart: 'synthetic', window: 'w1', document: 'd1',
  leaseGeneration: 1, policyGeneration: 1 };
const scheduler = new NativeScheduler({
  runtimes: [{ id: 'fake', epoch: 1, processes: [target] }],
  policy: () => ({ allowed: true, leaseValid: true }),
});
const request = { session: 'fixture', runtime: 'fake', epoch: 1, target,
  kind: 'mutation', surface: 'native', resources: [], timeoutMs: 1000 };
for (let i = 0; i < 100; i++) await scheduler.submit(request, () => null).result;
const start = performance.now();
const cpuStart = process.cpuUsage();
const receipts = [];
for (let i = 0; i < 1000; i++) receipts.push(await scheduler.submit(request, () => null).result);
const wallMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const state = scheduler.snapshot();
console.log(JSON.stringify({ scope: 'synthetic scheduler process, no native calls', warmup: 100, samples: 1000,
  admissionWaitMs: { p50: percentile(receipts.map(r => r.admissionWaitMs), 0.5),
    p90: percentile(receipts.map(r => r.admissionWaitMs), 0.9) },
  publicWallMs: { p50: percentile(receipts.map(r => r.publicWallMs), 0.5),
    p90: percentile(receipts.map(r => r.publicWallMs), 0.9) },
  cohortWallMs: wallMs, throughputPerSecond: 1000000 / wallMs,
  cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, rssBytes: process.memoryUsage().rss,
  failures: state.failures, cleanup: { queued: state.queued, inFlight: state.inFlight },
  nativeQueueMs: null, nativeServiceMs: null, nativeCpu: null, nativeRss: null,
  nativeSpeedupQualified: false }, null, 2));
