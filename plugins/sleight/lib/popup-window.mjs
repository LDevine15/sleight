// A page's pop-up (a sign-in window) opens as its own window. Safari's root line carries the window's ID
// (`ID: SafariWindow?...&UUID=...`), so after "Sign in with DemoID" Haiku saw a new ID, no tab bar and no profile
// control, said it could not tie the window to the dedicated one, and stopped before the consent click (Safari demoid
// b9-r2, 2026-10-19). The b10 runs went on in the pop-up and passed 3 of 3, and Firefox, whose root line has no ID,
// passed 3 of 3. The window note says where the new window came from, from the IDs the engine printed and one count:
// - The pop-up claim needs a census: an app read whose health probe counted one window, on every Space, which is the
//   window that read showed (a window no Space holds, ordered out and never shown, isn't counted). An action in that same
//   window that shows an ID no result has shown since is a window the action brought up. Any window that appeared in
//   between and was shown is seen, so it never gets the claim. Without the census, a window the session never read (the
//   owner's, brought forward by Cmd+` or a close) would look new.
//   The census is used once, and a probe that couldn't count or a stopped call drops it.
// - An app may give every window of a kind the same ID, so an equal ID never claims the same window, and the line for
//   the window a pop-up returns to states only that the IDs match.
import { windowFromText, documentLabel } from './document-scope.mjs';

const UUID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/i;

// The ID on the standard-window root line of the last tree in a result, or undefined. A UUID inside it stands for the
// whole ID: Safari's also carries `IsSecure=`, which may follow the page.
export function rootWindowId(text) {
  if (typeof text !== 'string') return;
  const start = text.lastIndexOf('Window: ');
  if (start < 0) return;
  const section = text.slice(start);
  const window = windowFromText(section);
  const root = /^0 .*$/m.exec(section)?.[0];
  if (!window || !root) return;
  const prefix = `0 standard window${window.title ? ' ' + window.title : ''}`;
  if (!root.startsWith(prefix)) return;
  const id = /^, ID: (.+?)(?=, (?:Secondary Actions|Help|Value|Description|Placeholder): |$)/.exec(root.slice(prefix.length))?.[1]?.trim();
  return id ? UUID.exec(id)?.[0].toUpperCase() ?? id : undefined;
}

// `trace(event)` records each census and each reason a candidate window doesn't get the line, for live checks: the
// first live check (FS2, 2026-10-19) showed no line and no way to tell which condition failed.
export function popupWindows(trace = () => {}) {
  const seen = new Set();
  const census = new Map(); // app -> the ID of its only window, from the last read that counted
  const openers = new Map(); // a pop-up's ID -> the window it came up from, with that window's ID
  const see = id => { if (id) seen.add(id); };
  return {
    see,
    // A read: `health` is its probe's answer (null when the probe gave none, undefined when the read had no probe), `id`
    // the window it showed.
    count(app, health, id) {
      if (!app) return;
      if (health === undefined) { trace({ event: 'census-unprobed', app, id: id ?? null, held: census.get(app) ?? null }); return; }
      // CGWindowList's count includes windows no Space holds (Safari keeps one from launch, SW1b); `spaceWindows` leaves
      // them out and keeps another Space's. One window on screen ties the one held window to the one AX window (with none on
      // screen, the held one could be another Space's). Without a Space count, a second window still stops the count.
      const counted = health?.status === 'responding' && health.windows === 1 &&
        (typeof health.allWindows !== 'number' || health.allWindows <= 1 || (health.spaceWindows === 1 && health.onScreen === 1));
      if (counted && id) census.set(app, id); else census.delete(app);
      trace({ event: 'census', app, id: id ?? null, counted: counted && !!id, status: health?.status ?? null,
        windows: health?.windows ?? null, allWindows: health?.allWindows ?? null, spaceWindows: health?.spaceWindows ?? null,
        onScreen: health?.onScreen ?? null });
    },
    // A failed or stopped call. One that shows the counted window (a lease stop after Cmd+T retitled it, FS2) keeps the
    // count: its window is the same, and a window it didn't show stays unseen. Anything else drops it.
    stopped(app, id) {
      if (!app || !census.has(app)) return;
      if (id && census.get(app) === id) { trace({ event: 'census-kept', app, id, reason: 'stop-shows-counted-window' }); return; }
      census.delete(app);
      trace({ event: 'census-dropped', app, id: id ?? null, reason: id ? 'stop-shows-other-window' : 'stop-shows-no-window-id' });
    },
    // The line to add to a window note for an action that acted on `from` and shows `to` now, then remember both IDs.
    note(from, to) {
      let line, reason;
      const fromId = from?.rootId, toId = to?.rootId;
      if (!toId) reason = to && from && to.app === from.app && fromId ? 'shown-window-has-no-id' : undefined;
      else if (fromId === toId) reason = undefined;
      else if (!fromId) reason = 'acted-on-window-has-no-id';
      else if (from.app !== to.app) reason = 'other-app';
      else if (openers.get(fromId)?.rootId === toId) {
        line = /* notice */ `It has the ID of ${documentLabel(openers.get(fromId))}, the pop-up's opener.`;
      } else if (seen.has(toId)) reason = 'shown-before';
      else if (!census.has(to.app)) reason = 'no-one-window-count';
      else if (census.get(to.app) !== fromId) reason = 'count-is-another-window';
      else {
        census.delete(to.app);
        openers.set(toId, from);
        // Notes count against the prompt budget (bench/prompt-budget.mjs): about 60 characters were left after these two.
        line = /* notice */ `An earlier read counted ${documentLabel(from)} as the app's only window, so this newer one belongs to its task (a pop-up, say).`;
      }
      if (reason) trace({ event: 'no-line', app: to?.app ?? null, from: fromId ?? null, to: toId ?? null, reason });
      see(fromId); see(toId);
      return line;
    },
  };
}
