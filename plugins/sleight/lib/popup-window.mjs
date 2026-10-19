// A page's pop-up (a sign-in window) opens as its own window. Safari's root line carries the window's ID
// (`ID: SafariWindow?...&UUID=...`), so after "Sign in with DemoID" Haiku saw a new ID, no tab bar and no profile
// control, said it could not tie the window to the dedicated one, and stopped before the consent click (Safari demoid
// b9-r2, 2026-10-19). The b10 runs went on in the pop-up and passed 3 of 3, and Firefox, whose root line has no ID,
// passed 3 of 3. The window note says where the new window came from, from the IDs the engine printed and one count:
// - The pop-up claim needs a census: an app read whose health probe counted one window, on every Space, which is the
//   window that read showed. An action in that same window that shows an ID no result has shown since is a window the
//   action brought up. Any window that appeared in between and was shown is seen, so it never gets the claim. Without
//   the census, a window the session never read (the owner's, brought forward by Cmd+` or a close) would look new.
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

export function popupWindows() {
  const seen = new Set();
  const census = new Map(); // app -> the ID of its only window, from the last read that counted
  const openers = new Map(); // a pop-up's ID -> the window it came up from, with that window's ID
  const see = id => { if (id) seen.add(id); };
  return {
    see,
    // A read: `health` is its probe's answer (null when the probe gave none, undefined when the read had no probe), `id`
    // the window it showed.
    count(app, health, id) {
      if (!app || health === undefined) return;
      const counted = health?.status === 'responding' && health.windows === 1 &&
        (typeof health.allWindows !== 'number' || health.allWindows <= 1);
      if (counted && id) census.set(app, id); else census.delete(app);
    },
    // A stopped or failed call: nothing it showed counts as a census.
    drop(app) { if (app) census.delete(app); },
    // The line to add to a window note for an action that acted on `from` and shows `to` now, then remember both IDs.
    note(from, to) {
      let line;
      const fromId = from?.rootId, toId = to?.rootId;
      if (fromId && toId && fromId !== toId && from.app === to.app) {
        const opener = openers.get(fromId);
        if (opener?.rootId === toId) {
          line = /* notice */ `It has the ID of ${documentLabel(opener)}, the pop-up's opener.`;
        } else if (!seen.has(toId) && census.get(to.app) === fromId) {
          census.delete(to.app);
          openers.set(toId, from);
          // Notes count against the prompt budget (bench/prompt-budget.mjs): about 60 characters were left after these two.
          line = /* notice */ `An earlier read counted ${documentLabel(from)} as the app's only window, so this newer one belongs to its task (a pop-up, say).`;
        }
      }
      see(fromId); see(toId);
      return line;
    },
  };
}
