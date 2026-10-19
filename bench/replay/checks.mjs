import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resultText } from './mapping.mjs';

function dragOrder(events) {
  const phases = events.filter(e => e.direction === 'drag-phase').map(e => e.msg);
  if (!phases.length) return { verdict: 'skip', reason: 'Selected build lacks DP2 drag-phase events; use the DPc build with SLEIGHT_TRACE enabled' };
  const stack = [], axStarts = [], axEnds = [];
  let previous = -Infinity;
  const helperPid = phases[0]?.helperPid;
  for (const [index, event] of phases.entries()) {
    if (!event || !['ax-move', 'raise', 'settle', 'posted-press'].includes(event.phase) ||
        !['start', 'end'].includes(event.edge) || !Number.isFinite(event.monoMs) || event.monoMs < 0 || event.monoMs < previous ||
        !Number.isSafeInteger(helperPid) || helperPid < 1 || event.helperPid !== helperPid)
      return { verdict: 'fail', failures: ['Invalid or mixed-helper DP2 phase evidence'] };
    previous = event.monoMs;
    if (event.edge === 'start') stack.push(event.phase);
    else if (stack.pop() !== event.phase) return { verdict: 'fail', failures: ['Unpaired DP2 phase events'] };
    if (event.phase === 'ax-move') (event.edge === 'start' ? axStarts : axEnds).push(index);
  }
  if (stack.length || axStarts.length !== 1 || axEnds.length !== 1)
    return { verdict: 'fail', failures: ['Incomplete or ambiguous DP2 AX-move phase evidence'] };
  if (phases.some((e, i) => e.phase === 'raise' && i < axEnds[0]))
    return { verdict: 'fail', failures: ['DP2 raised the window before AX-move completed'] };
  if (phases.some(e => e.phase === 'posted-press'))
    return { verdict: 'fail', failures: ['Accessibility drag emitted posted-press evidence'] };
  return { verdict: 'pass' };
}

export function checkEvidence(spec, replay, trace = []) {
  const calls = replay.calls.filter(row => (!spec.tool || row.name === spec.tool) &&
    (!spec.argumentPattern || new RegExp(spec.argumentPattern, 'i').test(JSON.stringify(row.recordedArguments))));
  if (!calls.length) return { verdict: 'inconclusive', reason: 'Replay stopped before the check target, or recording has no such call' };
  const failures = [];
  const skipped = [];
  const selectedEvents = [];
  for (const row of calls) {
    const text = resultText(row.result);
    const events = trace.filter(e => e.t >= row.startedAt && e.t <= row.finishedAt);
    selectedEvents.push(...events);
    if (spec.needsInternalOrder) {
      const order = dragOrder(events);
      if (order.verdict === 'fail') failures.push(...order.failures.map(f => `call ${row.index}: ${f}`));
      if (order.verdict === 'skip') skipped.push(`call ${row.index}: ${order.reason}`);
    }
    const responses = events.filter(e => e.direction === 'from-server' || e.direction === 'guard-read');
    if (spec.resultIncludes && !new RegExp(spec.resultIncludes, 'i').test(text)) failures.push(`call ${row.index}: expected result evidence missing`);
    if (spec.alsoResultIncludes && !new RegExp(spec.alsoResultIncludes, 'i').test(text)) failures.push(`call ${row.index}: second result evidence missing`);
    if (spec.resultExcludes && new RegExp(spec.resultExcludes, 'i').test(text)) failures.push(`call ${row.index}: forbidden result`);
    if (spec.toolMsBelow !== undefined && row.toolMs >= spec.toolMsBelow) failures.push(`call ${row.index}: ${row.toolMs.toFixed(1)} ms >= ${spec.toolMsBelow} ms`);
    if (spec.traceIncludes && !events.some(e => e.direction && e.direction !== 'to-server' && new RegExp(spec.traceIncludes, 'i').test(JSON.stringify(e)))) failures.push(`call ${row.index}: required trace evidence missing`);
    if (spec.traceExcludes && responses.some(e => new RegExp(spec.traceExcludes, 'i').test(JSON.stringify(e)))) failures.push(`call ${row.index}: forbidden trace read`);
    if (spec.tabProbeChain) {
      const probes = events.filter(e => e.direction === 'tab-probe').map(e => e.msg);
      if (probes.filter(p => p.decision === 'probe').length < 2 || !probes.some(p => p.transition === true && p.decision === 'probe'))
        failures.push(`call ${row.index}: original tab chain probe evidence missing`);
      if (probes.some(p => p.decision === 'read') || events.filter(e => e.direction === 'guard-read' && e.msg?.phase === 'before-action').length > 1)
        failures.push(`call ${row.index}: intermediate tab-chain tree read`);
    }
  }
  if (spec.traceIncludesAny && !selectedEvents.some(e => e.direction && e.direction !== 'to-server' && new RegExp(spec.traceIncludesAny, 'i').test(JSON.stringify(e))))
    failures.push('No selected call emitted the required trace evidence');
  if (spec.fixturePass && replay.lifecycle?.taskPassed !== true) failures.push('Benchmark fixture check did not pass');
  if (failures.length) return { verdict: 'fail', failures };
  if (skipped.length) return { verdict: 'skip', reason: skipped.join('; ') };
  return { verdict: 'pass', coveredCalls: calls.map(c => c.index) };
}

export function assertCheck(spec, replay, dir) {
  const trace = readdirSync(dir).filter(name => /^trace-\d+\.jsonl$/.test(name)).flatMap(name =>
    readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  return { id: spec.id, ...checkEvidence(spec, replay, trace) };
}
