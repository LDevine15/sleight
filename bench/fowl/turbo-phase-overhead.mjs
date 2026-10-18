// Offline microbenchmark of the two steady-state markers per bridge call. No worker, helper or browser starts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createWorkerTrace } from '../../plugins/sleight/lib/direct-browser/worker.mjs';

const dir = mkdtempSync(join(tmpdir(), 'sleight-phase-overhead-')), calls = 10000;
let on;
try {
  const off = createWorkerTrace({ setting: '', relayPid: 42 });
  on = createWorkerTrace({ setting: dir, relayPid: 42 });
  const measure = trace => {
    const start = performance.now();
    for (let call = 1; call <= calls; call++) { trace('call-start', 1, call); trace('call-result', 1, call); }
    return (performance.now() - start) / calls;
  };
  measure(off); measure(on);
  const rounds = Array.from({ length: 5 }, (_, i) => {
    let disabledMs, enabledMs;
    if (i % 2) { enabledMs = measure(on); disabledMs = measure(off); }
    else { disabledMs = measure(off); enabledMs = measure(on); }
    return { disabledMs, enabledMs, addedMs: Math.max(0, enabledMs - disabledMs) };
  });
  console.log(JSON.stringify({ callsPerRound: calls, markersPerCall: 2, rounds,
    maxAddedMs: Math.max(...rounds.map(row => row.addedMs)), targetMs: 0.1 }, null, 2));
} finally { on?.close?.(); rmSync(dir, { recursive: true, force: true }); }
