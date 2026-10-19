// A page's pop-up (a sign-in window) opens as its own window. Safari's root line carries the window's ID
// (`ID: SafariWindow?...&UUID=...`), so after "Sign in with DemoID" Haiku saw a new ID, no tab bar and no profile
// control, said it could not tie the window to the dedicated one, and stopped before the consent click (Safari demoid
// b9-r2, 2026-10-19). The b10 runs went on in the pop-up and passed 3 of 3, and Firefox, whose root line has no ID,
// passed 3 of 3. The window note says where the new window came from, from the IDs the engine printed and one count:
// - The pop-up claim needs a census. The app's last counted read (getApp's health probe) showed one window, the one
//   whose ID that read printed, so any other ID in front later came up after that read. Without it, a window the
//   session never read (the owner's, brought forward by Cmd+` or a close) would look new, and the note says nothing.
// - An app may give every window of a kind the same ID, so an equal ID never claims the same window, and the line for
//   the window a pop-up returns to states only that the IDs match.
import { windowFromText, documentLabel } from './document-scope.mjs';

// The ID on the standard-window root line of the last tree in a result, or undefined.
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
  const id = /^, ID: (.+?)(?=, (?:Secondary Actions|Help|Value|Description|Placeholder): |$)/.exec(root.slice(prefix.length))?.[1];
  return id?.trim() || undefined;
}

export function popupWindows() {
  const seen = new Set();
  const counted = new Map(); // app -> whether its last counted read showed one window, with an ID
  const openers = new Map(); // a pop-up's ID -> the window it came up from, with that window's ID
  return {
    // A read whose health probe counted the app's windows. `title` is the window the read showed, which must be among them.
    count(app, health, title, id) {
      if (!app || health?.status !== 'responding' || !Array.isArray(health.windowTitles)) return;
      counted.set(app, health.windows === 1 && health.windowTitles.length === 1 && health.windowTitles[0] === title && !!id);
    },
    // The line to add to a window note for an action that acted on `from` and shows `to` now, then remember both IDs.
    note(from, to) {
      let line;
      const fromId = from?.rootId, toId = to?.rootId;
      if (fromId && toId && fromId !== toId && from.app === to.app) {
        const opener = openers.get(fromId);
        if (opener?.rootId === toId) {
          line = /* notice */ `It has the window ID of ${documentLabel(opener)}, the pop-up's opener.`;
        } else if (!seen.has(toId) && counted.get(to.app)) {
          openers.set(toId, from);
          // Every note counts against the prompt budget (bench/prompt-budget.mjs), which had about 220 characters left.
          line = /* notice */ `Your last read showed the app's only window, so an action since opened this one (a pop-up, say), part of the task in ${documentLabel(from)}.`;
        }
      }
      this.see(fromId); this.see(toId);
      return line;
    },
    see(id) { if (id) seen.add(id); },
  };
}
