// Read-only phase split for one saved round. Copy trace files into each task (or task/traces),
// or pass --trace-dir for a shared SLEIGHT_TRACE directory. Shared sessions must fit wholly inside a task's run timestamps.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function traces(dir) {
  try { return readdirSync(dir).filter(name => /^trace-\d+\.jsonl$/.test(name)).sort().map(name => ({
    name, rows: readFileSync(join(dir, name), 'utf8').split('\n').flatMap(line => {
      try {
        const row = JSON.parse(line), at = Date.parse(row.t);
        return row.direction === 'turbo-phase' && typeof row.msg?.phase === 'string' && Number.isFinite(at)
          ? [{ at, phase: row.msg.phase, turn: row.msg.turn, call: row.msg.call }] : [];
      } catch { return []; }
    }),
  })); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const delta = (end, start) => Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : null;

export function splitSession({ name, rows }, run = {}) {
  const first = phase => rows.find(row => row.phase === phase)?.at;
  const firstAt = (list, phase) => list.find(row => row.phase === phase)?.at;
  const turns = [...new Set(rows.filter(row => Number.isSafeInteger(row.turn) && row.turn > 0).map(row => row.turn))].map(turn => {
    const own = rows.filter(row => row.turn === turn), calls = own.filter(row => row.call === 1);
    const start = firstAt(calls, 'call-start'), result = firstAt(calls, 'call-result');
    const setup = rows.filter(row => row.at >= start && row.at <= result);
    const lastResult = own.findLast(row => row.phase === 'call-result')?.at;
    const requested = firstAt(own, 'turn-end-requested'), ended = firstAt(own, 'turn-end');
    return { turn, firstAdmissionGapMs: delta(firstAt(own, 'first-call-admitted'), firstAt(own, 'turn-begin') ?? first('tools-registered')),
      firstCallMs: delta(result, start), connectionMs: delta(firstAt(setup, 'connection-end'), firstAt(setup, 'connection-start')),
      runtimeReadyMs: delta(firstAt(setup, 'runtime-ready'), start), lastResultToEndRequestMs: delta(requested, lastResult),
      turnCleanupMs: delta(ended, requested), lastResultToTurnEndMs: delta(ended, lastResult) };
  });
  return { trace: name, startup: {
    launchToSpawnMs: delta(first('worker-spawn-start'), run.started), spawnMs: delta(first('worker-spawned'), first('worker-spawn-start')),
    workerLoadMs: delta(first('worker-entry'), first('worker-spawned')), helperCheckMs: delta(first('helpers-check-end'), first('helpers-check-start')),
    connectionSelectMs: delta(first('connection-select-end'), first('connection-select-start')), workerReadyMs: delta(first('worker-ready'), first('worker-entry')),
    registrationGapMs: delta(first('tools-registered'), first('bridge-ready')),
  }, turns, turnEndToProcessExitMs: delta(run.finished, rows.findLast(row => row.phase === 'turn-end')?.at) };
}

export function splitRound(root, traceDir) {
  const results = JSON.parse(readFileSync(join(root, 'results.json'), 'utf8')), shared = traceDir ? traces(traceDir) : [];
  return results.map(row => {
    const task = row.task?.name;
    if (typeof task !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(task)) throw Error('invalid task directory');
    const local = [...traces(join(root, task)), ...traces(join(root, task, 'traces'))].filter(trace => trace.rows.length);
    const files = local.length ? local : shared.filter(trace => trace.rows.length && Number.isFinite(row.run?.started) && Number.isFinite(row.run?.finished)
      && trace.rows.some(event => event.phase === 'worker-spawn-start')
      && trace.rows.every(event => event.at >= row.run.started && event.at <= row.run.finished));
    return { task, sessions: files.map(trace => splitSession(trace, row.run)),
      ...(!files.length ? { missing: 'no correlated turbo-phase trace; record SLEIGHT_TRACE for this task' } : {}) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [round, flag, dir, ...extra] = process.argv.slice(2);
  if (!round || extra.length || flag !== undefined && (flag !== '--trace-dir' || !dir)) {
    console.error('usage: node bench/fowl/turbo-phase-split.mjs ROUND [--trace-dir DIR]'); process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(splitRound(round, dir), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
