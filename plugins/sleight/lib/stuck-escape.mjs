// One Escape posted to the leased app's pid when a menu stays stuck in menu tracking (owner, 2026-10-18, WK4).
// A menu-bar title stayed selected with no menu while 13 and 8 calls typed into the app (word-edit-1, 2026-10-17), and
// neither the engine's Escape, a click nor Cancel freed it; one Escape posted to the pid did (2026-10-17 cleanup).
// Like the Shift settle in settle-text-write.js, it goes to one verified pid. SLEIGHT_STUCK_ESCAPE=0 turns it off.
import { verifyWindowIdentity } from './window-identity.mjs';

// The engine's own typeText and pressKey reset macOS's HID idle time (3 of 3, docs/known-problems.md), so idle can't
// cover a call that typed. It must cover the time since the stuck result arrived, and the helper waits up to WAIT_S
// for QUIET_S with no key or mouse input before posting, as drag.js does before its foreground path.
const QUIET_S = 0.5, WAIT_S = 1.5;

// Per app and window: how many results in a row showed the stuck state, and whether this episode had its Escape.
// `stuck`: a selected menu-bar item and no menu in front. `cleared`: a whole tree with neither, which ends the episode.
// Anything else (an open menu, a diff) breaks the run of stuck results but keeps the episode's one try spent.
export function createStuckEscapes() {
  const episodes = new Map();
  return {
    observe(key, { stuck = false, cleared = false } = {}) {
      if (!key) return false;
      if (cleared) { episodes.delete(key); return false; }
      const episode = episodes.get(key);
      if (!stuck) { if (episode) episode.streak = 0; return false; }
      const next = { streak: (episode?.streak ?? 0) + 1, tried: episode?.tried === true };
      episodes.set(key, next);
      return next.streak >= 2 && !next.tried;
    },
    tried(key) { const episode = episodes.get(key); if (episode) episode.tried = true; },
  };
}

// `target` is the lease's window; the pid is the one its identity check names, and the helper checks the running
// app, its launch time and the lease file again before posting. `since` is when the stuck result arrived.
export async function sendStuckEscape(target, grant, { identity, run, since, clock = () => performance.now() }) {
  if (typeof identity !== 'function' || typeof run !== 'function') return { posted: false, reason: 'helper unavailable' };
  if (!Number.isFinite(since)) return { posted: false, reason: 'result time unknown' };
  let observed, checked;
  try { observed = await identity(target); checked = verifyWindowIdentity(target, observed); }
  catch (error) { return { posted: false, reason: String(error?.message ?? error) }; }
  if (!(observed.hidIdleSeconds >= (clock() - since) / 1000)) return { posted: false, reason: 'user input since the result' };
  let result;
  try {
    result = await run('stuck-escape.js', { appId: target.appId, pid: checked.pid, processStart: checked.processStart, lease: grant,
      quietSeconds: QUIET_S, waitSeconds: WAIT_S });
  } catch (error) { return { posted: false, reason: String(error?.message ?? error) }; }
  if (result?.ok === true && result.posted === true) return { posted: true, selected: typeof result.selected === 'boolean' ? result.selected : null };
  return { posted: result?.posted === true, reason: result?.error ?? 'helper failed' };
}

export function stuckEscapeOption(env, { identity, run }) {
  if (env.SLEIGHT_STUCK_ESCAPE === '0') return;
  return (target, grant, { since, clock } = {}) => sendStuckEscape(target, grant, { identity, run, since, ...(clock ? { clock } : {}) });
}
