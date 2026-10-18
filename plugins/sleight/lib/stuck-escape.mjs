// One Escape posted to the leased app's pid when a menu stays stuck in menu tracking (owner, 2026-10-18, WK4).
// A menu-bar title stayed selected with no menu while 13 and 8 calls typed into the app (word-edit-1, 2026-10-17), and
// neither the engine's Escape, a click nor Cancel freed it; one Escape posted to the pid did (2026-10-17 cleanup).
// Like the Shift settle in settle-text-write.js, it goes to one verified pid. SLEIGHT_STUCK_ESCAPE=0 turns it off.
import { verifyWindowIdentity } from './window-identity.mjs';

// The engine's own typeText and pressKey reset macOS's HID idle time (3 of 3, docs/known-problems.md), so idle can't
// cover a call that typed. It must cover the time since the stuck result arrived, and the helper waits up to WAIT_S
// for QUIET_S with no key or mouse input before posting, as drag.js does before its foreground path.
const QUIET_S = 0.5, WAIT_S = 1.5;
const POSTED_MARK = '[sleight:stuck-escape-posted]';

// Per app: how many results in a row showed the stuck state, whether this episode had its try, and whether an Escape
// went out that no real read has since shown cleared. Result text is only a trigger, since Claude's code can print a
// tree: the helper reads the app's own menu bar before posting, and only its read re-arms a spent app (`confirm`).
// `stuck`: a selected menu-bar item and no menu in front. `cleared`: a whole tree with neither.
export function createStuckEscapes() {
  const apps = new Map();
  const state = appId => apps.get(appId) ?? apps.set(appId, { streak: 0, tried: false, spent: false, checking: false }).get(appId);
  return {
    // 'escape' when a try is due, 'confirm' when a spent app's menu bar should be read, else undefined.
    observe(appId, { stuck = false, cleared = false } = {}) {
      if (!appId) return;
      const app = state(appId);
      if (cleared) {
        app.streak = 0;
        if (!app.spent) { app.tried = false; return; }
        if (app.checking) return;
        app.checking = true;
        return 'confirm';
      }
      if (!stuck) { app.streak = 0; return; }
      app.streak++;
      return app.streak >= 2 && !app.tried && !app.spent ? 'escape' : undefined;
    },
    tried(appId) { state(appId).tried = true; },
    // The helper's read after its Escape: an item still selected, or no read, keeps the app spent.
    posted(appId, selected) { state(appId).spent = selected !== false; },
    confirmed(appId, menu) {
      const app = state(appId);
      app.checking = false;
      if (menu?.selected === false && menu.open === false) { app.spent = false; app.tried = false; }
    },
  };
}

const verified = async (target, identity) => {
  const observed = await identity(target);
  return { observed, checked: verifyWindowIdentity(target, observed) };
};

// `target` is the lease's window; the pid is the one its identity check names, and the helper checks the running
// app, its launch time and the lease file again before posting. `since` is when the stuck result arrived.
export async function sendStuckEscape(target, grant, { identity, run, since, clock = () => performance.now() }) {
  if (typeof identity !== 'function' || typeof run !== 'function') return { posted: false, reason: 'helper unavailable' };
  if (!Number.isFinite(since)) return { posted: false, reason: 'result time unknown' };
  let observed, checked;
  try { ({ observed, checked } = await verified(target, identity)); }
  catch (error) { return { posted: false, reason: String(error?.message ?? error) }; }
  if (!(observed.hidIdleSeconds >= (clock() - since) / 1000)) return { posted: false, reason: 'user input since the result' };
  let result;
  try {
    result = await run('stuck-escape.js', { appId: target.appId, pid: checked.pid, processStart: checked.processStart, lease: grant,
      quietSeconds: QUIET_S, waitSeconds: WAIT_S });
  } catch (error) { return { posted: false, reason: String(error?.message ?? error) }; }
  if (result?.ok === true && result.posted === true) return { posted: true, selected: typeof result.selected === 'boolean' ? result.selected : null };
  // A helper killed after its key-down wrote the mark first.
  if (result?.posted === true || String(result?.error ?? '').includes(POSTED_MARK)) return { posted: true, selected: null };
  return { posted: false, reason: result?.error ?? 'helper failed' };
}

// The app's own menu bar ({ selected, open }), or undefined when it can't be read.
export async function checkStuckMenu(target, { identity, run }) {
  try {
    const { checked } = await verified(target, identity);
    const result = await run('stuck-escape.js', { op: 'check', appId: target.appId, pid: checked.pid, processStart: checked.processStart });
    return result?.ok === true ? { selected: result.selected ?? null, open: result.open ?? null } : undefined;
  } catch { return undefined; }
}

export function stuckEscapeOption(env, { identity, run }) {
  if (env.SLEIGHT_STUCK_ESCAPE === '0') return;
  return {
    send: (target, grant, { since, clock } = {}) => sendStuckEscape(target, grant, { identity, run, since, ...(clock ? { clock } : {}) }),
    check: target => checkStuckMenu(target, { identity, run }),
  };
}
