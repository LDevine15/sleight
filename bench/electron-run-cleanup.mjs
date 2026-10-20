// Run-owned infrastructure only, after the fixture app's own Quit and absence have been proved.
// Remember descendants before ending a parent, so reparenting to launchd cannot hide an adapter or helper.
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Resolve without running the interpreter or an adapter. ps can show the symlink's expanded executable path.
export async function resolveRunPython(python, { exec, realpath = realpathSync }) {
  try {
    if (typeof python !== 'string' || !python || python.startsWith('-') || /[\0\r\n]/.test(python)) throw Error();
    const { stdout } = await exec('/usr/bin/which', [python], { timeout: 5000 });
    const path = String(stdout).trim();
    if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw Error();
    return realpath(path);
  } catch { throw Error('RUN_PYTHON_UNAVAILABLE'); }
}

export function createRunReaper(root, { list, pids = () => [], uid = process.getuid(), python = 'python3', pythonPath = python,
  binaries = [process.execPath, '/usr/bin/osascript', python, pythonPath],
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
