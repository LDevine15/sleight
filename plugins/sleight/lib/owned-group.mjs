import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function groupMembers(pid) {
  const mac = process.platform === 'darwin';
  try {
    const { stdout } = await exec('/bin/ps', mac ? ['-g', String(pid), '-o', 'stat='] : ['-eo', 'pgid=,stat='],
      { timeout: 1000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    const rows = stdout.trim().split('\n').filter(Boolean).map(line => line.trim());
    return mac ? rows : rows.filter(line => line.split(/\s+/)[0] === String(pid)).map(line => line.split(/\s+/)[1]);
  } catch (error) {
    if (mac && error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return [];
    throw error;
  }
}

// Call only for a detached child this process spawned. Relay leader exit can begin
// collection before pipe closure, since surviving descendants may retain those pipes.
export async function collectOwnedGroup(pid, { graceMs = 5000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  alive = () => { try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } },
  signal = name => { try { process.kill(-pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } },
  members = groupMembers,
} = {}) {
  if (!pid) return;
  try {
    for (const name of ['SIGTERM', 'SIGKILL']) {
      if (!alive()) return;
      signal(name);
      const deadline = now() + graceMs;
      while (alive() && now() < deadline) await sleep(20);
    }
    if (!alive()) return;
    throw new Error('process group still exists');
  } catch (error) {
    if (error.code === 'EPERM') {
      try {
        const states = await members(pid);
        // macOS returns EPERM for an exited group waiting for its parent to reap it.
        if (Array.isArray(states) && states.every(state => typeof state === 'string' && /^Z\S*$/.test(state))) return;
      } catch { /* An unavailable inspection cannot confirm collection. */ }
    }
    throw Object.assign(new Error(`owned group cleanup unconfirmed: ${error.message}`), { cleanupUnconfirmed: true });
  }
}
