// Read-only host observations, separate from extension tab ownership. Run
// intervals establish correlation, never causation when agents overlap.
import { spawn, execFile } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

async function launchObserver() {
  if (process.platform !== 'darwin') throw Error('macOS host observer unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'sleight-round-observer-'));
  try {
    const binary = join(dir, 'observer');
    await promisify(execFile)('/usr/bin/swiftc', ['-module-cache-path', join(dir, 'cache'),
      fileURLToPath(new URL('./host-monitor.swift', import.meta.url)), '-o', binary], { timeout: 120000 });
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.once('close', () => rmSync(dir, { recursive: true, force: true }));
    child.once('error', () => rmSync(dir, { recursive: true, force: true }));
    return child;
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}

// ignorePids, and ignore(pid) once a run has spawned it: the ghost hand host, whose panel is
// sleight's own overlay. The observer never watches it and reports it once as ignored.
export async function startHostMonitor(file, { launch = launchObserver, now = Date.now, ignorePids = [] } = {}) {
  const log = [];
  const write = event => {
    const entry = { t: now(), ...event };
    log.push(entry); appendFileSync(file, JSON.stringify(entry) + '\n');
  };
  let child;
  try { child = await launch(); }
  catch (error) {
    write({ kind: 'host-error', message: `host observer unavailable: ${error.message}` });
    return { log, ignore() {}, stop: async () => {} };
  }
  let pending = '', stopped, ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const done = new Promise(resolve => {
    child.once('close', exitCode => { write({ kind: 'host-stopped', exitCode }); ready(); resolve(); });
    child.once('error', error => { write({ kind: 'host-error', message: error.message }); ready(); resolve(); });
  });
  child.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n'); pending = lines.pop();
    if (pending.length > 65536) { pending = ''; write({ kind: 'host-error', message: 'host observer oversized line' }); }
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!['host-ready', 'host-front', 'host-space', 'host-window', 'host-window-watch', 'host-error'].includes(entry.kind) || !Number.isFinite(entry.t)) throw Error();
        if (entry.kind === 'host-window-watch' && (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 ||
            typeof entry.covered !== 'boolean' || typeof entry.pending !== 'boolean')) throw Error();
        write(entry);
        if (entry.kind === 'host-ready' || entry.kind === 'host-error') ready();
      } catch { write({ kind: 'host-error', message: 'malformed host observer record' }); ready(); }
    }
  });
  child.stderr.on('data', () => write({ kind: 'host-error', message: 'host observer wrote stderr' }));
  // A caller can await readiness before starting agents. Compilation is already
  // complete; a missing notification loop cannot silently pass a quiet run.
  const waitReady = async () => {
    let timer;
    try { await Promise.race([initialized, new Promise(resolve => { timer = setTimeout(() => {
      write({ kind: 'host-error', message: 'host observer readiness timeout' }); resolve();
    }, 5000); })]); } finally { clearTimeout(timer); }
  };
  const ignore = pid => { if (!stopped && Number.isSafeInteger(pid) && pid > 0) child.stdin.write(`ignore-pid ${pid}\n`); };
  for (const pid of ignorePids) ignore(pid);
  return { log, ready: waitReady, ignore, stop: () => stopped ??= (async () => {
    child.stdin.end();
    let timer;
    try {
      await Promise.race([done, new Promise(resolve => { timer = setTimeout(() => {
        write({ kind: 'host-error', message: 'host observer did not exit on EOF' });
        child.kill('SIGKILL'); resolve();
      }, 5000); })]);
      await done;
      if (pending) write({ kind: 'host-error', message: 'host observer truncated record' });
    } finally { clearTimeout(timer); }
  })() };
}

export function gradeHostMonitor(log, run, runs = [run]) {
  const end = run.finished;
  const ready = log.find(event => event.kind === 'host-ready' && event.t <= run.started);
  const stopped = log.find(event => event.kind === 'host-stopped');
  const windows = new Map();
  let windowGap = false;
  for (const event of [...log].sort((a, b) => a.t - b.t)) {
    if (event.kind !== 'host-window-watch' || event.t > end) continue;
    if (event.t <= run.started) windows.set(event.pid, event.covered === true && event.pending === false);
    else if (event.covered !== true || event.pending !== false) windowGap = true;
  }
  const coverage = Number.isFinite(run.started) && Number.isFinite(end) && end >= run.started &&
    ready?.app === true && ready?.space === true && ready?.window === true && stopped?.t >= end && stopped.exitCode === 0 &&
    !windowGap && [...windows.values()].every(Boolean) &&
    !log.some(event => event.kind === 'host-error' && event.t <= end);
  const events = log.filter(event => ['host-front', 'host-space', 'host-window'].includes(event.kind) &&
    !event.initial && event.t >= run.started && event.t <= end).map(event => ({ ...event,
    runs: runs.filter(other => event.t >= other.started && event.t <= other.finished).map(other => other.name) }));
  const problems = events.map(event => `${event.kind} at ${new Date(event.t).toISOString()} during ${event.runs.join(', ')} (interval attribution)`);
  if (!coverage) problems.unshift('host observer coverage incomplete; focus, Space and window checks are unqualified');
  return { ok: problems.length === 0, cell: !coverage ? 'unqualified' : events.length ? `FAIL: ${events.length}` : 'ok', events, problems };
}
