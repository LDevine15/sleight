// Run-owned infrastructure only, after the fixture app's own Quit and absence have been proved.
// Remember descendants before ending a parent, so reparenting to launchd cannot hide an adapter or helper.
import { realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { ELECTRON_PROCESS_ENV } from '../plugins/sleight/lib/direct-browser/electron-process-env.mjs';

const absoluteExecutable = value => typeof value === 'string' && isAbsolute(value) && normalize(value) === value && !/[\0\r\n]/.test(value);

// Apple's system Python launcher can exec a developer-toolchain interpreter that realpath alone cannot find.
// Probe only that interpreter, without loading an adapter. Launch and cleanup both use the expanded result.
export async function resolveRunPython(python, { exec, realpath = realpathSync }) {
  try {
    if (typeof python !== 'string' || !python || python.startsWith('-') || /[\0\r\n]/.test(python)) throw Error();
    const options = { timeout: 5000, cwd: '/', env: { ...ELECTRON_PROCESS_ENV }, maxBuffer: 16384 };
    const { stdout } = await exec('/usr/bin/which', [python], options);
    const selected = String(stdout).trim();
    if (!absoluteExecutable(selected)) throw Error();
    const expanded = await exec(selected, ['-I', '-B', '-c', 'import os, sys; print(os.path.realpath(sys.executable))'], options);
    const path = String(expanded.stdout).trim();
    if (!absoluteExecutable(path)) throw Error();
    const resolved = realpath(path);
    if (!absoluteExecutable(resolved)) throw Error();
    return resolved;
  } catch { throw Error('RUN_PYTHON_UNAVAILABLE'); }
}

export function createRunReaper(root, { list, pids = () => [], uid = process.getuid(), python,
  binaries = [process.execPath, '/usr/bin/osascript', python].filter(Boolean),
  signal = process.kill, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const owned = new Map();
  const namesRoot = row => row.uid === uid && binaries.some(binary => row.args === binary || row.args.startsWith(binary + ' ')) &&
    row.args.split(/\s+/).some(token => token === root || token.startsWith(root + '/'));
  async function scan() {
    const rows = await list();
    const present = new Map(rows.map(row => [row.pid, row]));
    const recorded = new Map(pids().filter(row => Number.isSafeInteger(row?.pid) && Number.isFinite(row.startedAtMs)).map(row => [row.pid, row.startedAtMs]));
    for (const row of rows) if (row.pid !== process.pid && !owned.has(row.pid) && row.uid === uid &&
        (namesRoot(row) || recorded.has(row.pid) && recorded.get(row.pid) === row.startedAtMs))
      owned.set(row.pid, row.startedAtMs);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (row.pid !== process.pid && row.uid === uid && !owned.has(row.pid) && owned.has(row.ppid) &&
          present.get(row.ppid)?.startedAtMs === owned.get(row.ppid)) {
        owned.set(row.pid, row.startedAtMs); changed = true;
      }
    }
    return rows.filter(row => row.uid === uid && owned.has(row.pid) && owned.get(row.pid) === row.startedAtMs);
  }
  return { scan, async reap() {
    // Without the launch executable an orphan adapter could be omitted from an apparently empty census.
    if (!absoluteExecutable(python)) return { confirmed: false, left: [], errors: ['RUN_PYTHON_UNRESOLVED'] };
    const errors = [], signalled = new Set();
    let left = await scan();
    for (const kind of ['SIGTERM', 'SIGKILL']) {
      for (let i = 0; left.length && i < 40; i++) {
        for (const row of left) {
          const key = `${row.pid}:${row.startedAtMs}:${kind}`;
          if (signalled.has(key)) continue;
          // Recheck the incarnation immediately before signaling a recorded PID.
          const fresh = (await list()).find(p => p.pid === row.pid);
          if (!fresh || fresh.uid !== uid || fresh.startedAtMs !== row.startedAtMs) continue;
          signalled.add(key);
          try { signal(row.pid, kind); } catch (error) { if (error.code !== 'ESRCH') errors.push('RUN_PROCESS_SIGNAL_FAILED'); }
        }
        await sleep(250);
        left = await scan();
      }
    }
    return { confirmed: left.length === 0 && errors.length === 0, left: left.map(row => row.pid), errors };
  } };
}
