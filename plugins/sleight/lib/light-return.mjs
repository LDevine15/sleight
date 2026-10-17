import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// After Return, Enter, Tab, Escape or Space, the guard read the whole tree before the next typeText or
// paste, and a read after input waits for the UI to settle: 26 to 31 reads at about 470 ms each in
// Excel's entry batch (2026-10-17 claim run). The engine has no cheaper read, and its sandbox can't open
// sockets or write files, but it reads them. So while such a call runs, the relay observes the leased
// window natively after each key press the engine asks approval for, and writes the observations to a
// file beside the lease. The guard skips the full read when two observations taken after the key show
// the same window, no sheet, and focus on a text or cell element in it. Anything else reads as before.
// SLEIGHT_GUARD_LIGHT_RETURN=0 turns it off, for the A/B baseline.
export const lightReturnEnabled = (env = process.env) => env.SLEIGHT_GUARD_LIGHT_RETURN !== '0';

const KEY = /\.pressKey\(\s*(['"`])(?:return|enter|tab|escape|esc|space)\1\s*\)/i;
export const lightReturnCode = code => typeof code === 'string' && KEY.test(code) && /\.(?:typeText|paste)\(/.test(code);

// waitMs: an observation counts only when it started this long after the key's pressKey returned.
// deadlineMs: past this (from the same moment), the guard reads the whole tree.
export const LIGHT_TIMING = { waitMs: 100, deadlineMs: 400, pollMs: 10 };

export function createLightReturn({ directory, observe, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  delayMs = 80, intervalMs = 25, burstMs = 700, keep = 8, timing = LIGHT_TIMING } = {}) {
  const calls = new Map();
  const write = call => {
    try {
      writeFileSync(call.path + '.tmp', JSON.stringify({ observations: call.observations }), { mode: 0o600 });
      renameSync(call.path + '.tmp', call.path);
    } catch { /* The guard reads the whole tree without a fresh file. */ }
  };
  async function run(call) {
    call.timer = undefined;
    if (call.running || call.ended) return;
    call.running = true;
    try {
      while (!call.ended && now() < call.until) {
        const start = now();
        let observed;
        try { observed = await observe({ ...call.window, focus: true }); } catch { observed = undefined; }
        if (call.ended) break;
        const { status = 'unknown', matches, window, title, url, focus } = observed ?? {};
        call.observations.push({ start, end: now(), status, matches, window, title, url, focus });
        if (call.observations.length > keep) call.observations.shift();
        write(call);
        const wait = intervalMs - (now() - start);
        if (wait > 0) await new Promise(resolve => setTimer(resolve, wait));
      }
    } finally { call.running = false; }
  }
  return {
    // A guarded call that may take the light check. Returns what the guard needs, or undefined.
    begin(id, window) {
      if (!directory || !window?.appId || calls.has(id)) return undefined;
      const call = { path: join(directory, `light-${randomUUID()}.obs`), window, observations: [], until: 0 };
      calls.set(id, call);
      write(call);
      return { path: call.path, app: window.app, ...timing };
    },
    // The engine asks approval before each key press, naming the app's bundle ID.
    keyPressed(appId) {
      for (const call of calls.values()) {
        if (call.ended || call.window.appId !== appId) continue;
        call.until = Math.max(call.until, now() + burstMs);
        if (!call.running && !call.timer) call.timer = setTimer(() => run(call), delayMs);
      }
    },
    end(id) {
      const call = calls.get(id);
      if (!call) return;
      call.ended = true; calls.delete(id);
      if (call.timer) clearTimer(call.timer);
      for (const path of [call.path, call.path + '.tmp']) { try { rmSync(path, { force: true }); } catch {} }
    },
    dispose() { for (const id of [...calls.keys()]) this.end(id); },
  };
}
