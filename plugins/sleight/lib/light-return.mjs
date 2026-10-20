import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOSE_COUNT_REASONS } from './close-count-reasons.mjs';

// After Return, Enter, Tab, Escape or Space, the guard read the whole tree before the next typeText or
// paste, and a read after input waits for the UI to settle: 26 to 31 reads at about 470 ms each in
// Excel's entry batch (2026-10-17 claim run). The engine has no cheaper read, and its sandbox can't open
// sockets or write files, but it reads them. So while such a call runs, the relay observes the leased
// window natively after each key press the engine asks approval for, and writes the observations to a
// file beside the lease. The guard skips the full read when two observations taken after the key show
// the same window, no sheet, and focus on a text or cell element in it. Anything else reads as before.
// Off by default until we measure live how late alerts and sheets appear after Return:
// SLEIGHT_GUARD_LIGHT_RETURN=1 turns it on.
export const lightReturnEnabled = (env = process.env) => env.SLEIGHT_GUARD_LIGHT_RETURN === '1';

const KEY = /\.pressKey\(\s*(['"`])(?:return|enter|tab|escape|esc|space)\1\s*\)/i;
export const lightReturnCode = code => typeof code === 'string' && KEY.test(code) && /\.(?:typeText|paste)\(/.test(code);

// waitMs: an observation counts only when it started this long after the key's pressKey returned, and
// two such observations must have started at least gapMs apart.
// freshMs: the newest of them must have ended this recently.
// windowMs: the observer runs this long after a key, so past it (from the key) the guard reads the whole tree.
// deadlineMs: past this (from the key), the guard stops waiting and reads the whole tree.
export const LIGHT_TIMING = { waitMs: 250, gapMs: 50, freshMs: 150, windowMs: 700, deadlineMs: 600, pollMs: 10 };

export function createLightReturn({ directory, observe, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  delayMs = 80, intervalMs = 25, timing = LIGHT_TIMING, burstMs = timing.windowMs ?? 700, keep = 8,
  continuous = false, maxFailures = Infinity, minGapMs = 0, failureBackoffMs = 0, project = observed => {
    const { status = 'unknown', matches, window, title, url, focus } = observed ?? {};
    return { status, matches, window, title, url, focus };
  } } = {}) {
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
      while (!call.ended && !call.stopped && now() < call.until) {
        const start = now();
        let observed;
        try { observed = await observe({ ...call.window, focus: true }); } catch { observed = undefined; }
        if (call.ended || call.stopped || now() >= call.until) break;
        const sample = project(observed);
        call.failures = sample.status === 'ok' ? 0 : (call.failures ?? 0) + 1;
        call.observations.push({ start, end: now(), ...sample });
        if (call.observations.length > keep) call.observations.shift();
        write(call);
        if (call.failures >= maxFailures) { call.stopped = true; break; }
        const backoff = failureBackoffMs && call.failures
          ? Math.min(failureBackoffMs, intervalMs * 2 ** Math.min(call.failures - 1, 8)) : 0;
        const wait = Math.min(call.until - now(), Math.max(backoff, minGapMs, intervalMs - (now() - start)));
        if (wait > 0) await new Promise(resolve => {
          call.wake = resolve;
          call.timer = setTimer(() => { call.timer = undefined; call.wake = undefined; resolve(); }, wait);
        });
      }
    } finally { call.running = false; }
  }
  return {
    // A guarded call that may take the light check. Returns what the guard needs, or undefined.
    begin(id, window) {
      if (!directory || !window?.appId || calls.has(id)) return undefined;
      const call = { path: join(directory, `light-${randomUUID()}.obs`), window, observations: [], until: continuous ? now() + burstMs : 0 };
      calls.set(id, call);
      write(call);
      if (continuous) call.timer = setTimer(() => run(call), 0);
      return { path: call.path, app: window.app, ...timing };
    },
    // The engine asks approval before each key press, naming the app's bundle ID.
    keyPressed(appId) {
      for (const call of calls.values()) {
        if (call.ended || call.stopped || call.window.appId !== appId) continue;
        call.until = Math.max(call.until, now() + burstMs);
        if (!call.running && call.timer === undefined) call.timer = setTimer(() => run(call), delayMs);
      }
    },
    pause(id) {
      const call = calls.get(id);
      if (!call) return;
      call.stopped = true;
      if (call.timer !== undefined) clearTimer(call.timer);
      call.timer = undefined;
      call.wake?.(); call.wake = undefined;
    },
    end(id) {
      const call = calls.get(id);
      if (!call) return;
      call.ended = true; calls.delete(id);
      if (call.timer !== undefined) clearTimer(call.timer);
      call.timer = undefined;
      call.wake?.(); call.wake = undefined;
      for (const path of [call.path, call.path + '.tmp']) { try { rmSync(path, { force: true }); } catch {} }
    },
    dispose() { for (const id of [...calls.keys()]) this.end(id); },
  };
}

// DP1 uses the same read-only file channel for fresh metadata after a close.
// Sampling lasts two seconds from begin or the last approved key in a close
// call. Non-ok replies back off to 400 ms. A decision or call end stops it sooner.
export function createCloseRead({ directory, observe, now, setTimer, clearTimer } = {}) {
  return createLightReturn({ directory, observe: window => observe({ ...window, closeCount: true }),
    now, setTimer, clearTimer, continuous: true, burstMs: 2000, failureBackoffMs: 400,
    intervalMs: 25, minGapMs: 25, timing: {}, project: observed => {
      const { status = 'unknown', unknownReason, appId, pid, processStart, running, windowCount, modalCount, closedWindowPresent } = observed ?? {};
      return { status, appId, pid, processStart, running, windowCount, modalCount, closedWindowPresent,
        ...(status === 'unknown' ? { unknownReason: CLOSE_COUNT_REASONS.includes(unknownReason) ? unknownReason : 'helper-error' } : {}) };
    } });
}
