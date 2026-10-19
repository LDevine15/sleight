import { performance } from 'node:perf_hooks';
import { divergence, refreshCode, resultText, TargetMapper } from './mapping.mjs';
export { parseEnv } from './switches.mjs';

export async function replayCalls(calls, { call, mapper = new TargetMapper(), beforeCall = () => {}, record = () => {} } = {}) {
  const rows = [];
  let verdict = 'pass', reason;
  for (const [index, original] of calls.entries()) {
    const startedAt = new Date().toISOString();
    let args, result, mappingMs = 0, toolMs = 0;
    try {
      await beforeCall();
      try { args = mapper.arguments(original.arguments); }
      catch (error) {
        // Never retry an action. Refresh only before sending it, on an already acquired handle.
        if (!/refresh required/.test(error.message)) throw error;
        const native = original.name === 'js';
        if (!native && original.server !== 'sleight-turbo') throw error;
        const refresh = native ? { code: refreshCode(original.arguments), title: 'Replay target refresh' }
          : { tab: mapper.arguments({ tab: original.arguments.tab }).tab, max_chars: 40000 };
        const start = performance.now();
        const fresh = await call(original.server, native ? 'js' : 'browser_read', refresh);
        mappingMs = performance.now() - start;
        record({ event: 'mapping-read', index, arguments: refresh, result: fresh, ms: mappingMs });
        if (fresh.isError) throw Error('Target refresh failed');
        mapper.after = resultText(fresh);
        mapper.refresh(mapper.after, original.arguments);
        args = mapper.arguments(original.arguments);
      }
      await beforeCall();
      const start = performance.now();
      try { result = await call(original.server, original.name, args); }
      finally { toolMs = performance.now() - start; }
      mapper.observe(resultText(original.result), resultText(result), original.arguments, original);
      reason = divergence(original.result, result, mapper, original.arguments);
    } catch (error) { reason = error.message; }
    const row = { index, id: original.id, server: original.server, name: original.name, arguments: args,
      recordedArguments: original.arguments, expected: original.result, result, toolMs, mappingMs, startedAt, finishedAt: new Date().toISOString(),
      verdict: reason ? 'diverge' : 'pass', ...(reason ? { reason } : {}) };
    rows.push(row); record({ event: 'call', ...row });
    if (reason) { verdict = 'diverge'; break; }
  }
  return { verdict, reason, plannedCalls: calls.length, calls: rows,
    totalToolMs: rows.reduce((n, row) => n + row.toolMs, 0), totalMappingMs: rows.reduce((n, row) => n + row.mappingMs, 0) };
}

export function schedule(repeat, variants) {
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) throw Error('--repeat must be 1 to 100');
  return Array.from({ length: repeat }, (_, iteration) => variants
    .map(variant => ({ iteration: iteration + 1, ...variant }))).flat();
}
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}
export function summarize(runs) {
  return [...new Set(runs.map(r => r.variant))].map(variant => {
    const group = runs.filter(r => r.variant === variant), complete = group.filter(r => r.verdict === 'pass');
    return { variant, runs: group.length, passing: complete.length,
      totalToolMedianMs: median(complete.map(r => r.totalToolMs)),
      // Keep divergent prefixes visible, but never present their short totals as a speed win.
      calls: Array.from({ length: Math.max(0, ...group.map(r => r.calls.length)) }, (_, index) => {
        const rows = group.flatMap(r => r.calls[index] ? [r.calls[index]] : []);
        return { index, samples: rows.length, passing: rows.filter(r => r.verdict === 'pass').length,
          toolMedianMs: median(rows.map(r => r.toolMs)), mappingMedianMs: median(rows.map(r => r.mappingMs)) };
      }) };
  });
}
