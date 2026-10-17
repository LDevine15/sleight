// SLEIGHT_PROMPT=lean wording for sleight's notices. relay.mjs re-exports it; the read compactor
// imports it here, since relay.mjs imports the compactor.
// Applied only at sleight-authored notice sites, never to engine text or user data.
export function promptNotice(text, prompt) {
  if (prompt !== 'lean') return text;
  return text
    .replace('send numbered actions on one handle per call. Read that window before acting.', 'numbered actions need one handle. Read it first.')
    .replace('REPL preparation was stopped before this call ran.', 'REPL setup stopped. Call skipped.')
    .replace('the window changed before this call\'s actions ran, so nothing after the acquisition was sent. Act again with the numbers above, or with { id } or { label }.', 'window changed first; actions not sent. Use the numbers above, { id } or { label }.')
    .replace('For browser work, use cua.getBrowser(...) and its tab handle, or cua.listTabs() for inventory. cua.getApp(...) acquires a native app.', 'Browser work: use cua.getBrowser(...) and its tab, or cua.listTabs() for inventory.')
    .replace('of the same image. getScreenshot() already shows its picture, so don\'t pass it to nodeRepl.emitImage too.', 'of an image; getScreenshot() already displays it. Omit emitImage.')
    .replace('Escape doesn\'t always close a menu in a background app; ', 'Close it with ')
    .replace('a menu may be stuck open; keys and clicks may not reach the document. Try one Escape; if it stays, click its menu-bar item by number', 'Menu may trap input. Escape once, then click menu-bar item')
    .replace('; if it still stays, tell the user.', '; if still stuck, tell the user.')
    .replace(', and keys may be swallowed while it is. Check that typing landed (a value or count in the tree changed), and switch route (a toolbar or ribbon control, or a keyboard shortcut) instead of repeating Escape or clicks.', '; keys may be lost. Check typing landed, then use a toolbar control or shortcut, not more Escape or clicks.')
    .replace('` does.', '`.')
    .replace('A failed action without await can end the engine\'s session and lose every handle. ', '')
    .replace('sleight: screenshot added, the tree has no document text. ', 'Screenshot added: no text in tree. ')
    .replace(', already acquired. Use it in place of `app`.', ', acquired; use it for `app`.')
    .replace(', already acquired (`let app = ', ', acquired (`let app = ')
    .replace('sleight will make it a full read because automatic recovery consumed the engine\'s UI diff.', '')
    .replace('Change review: an action is still pending, so this read cannot take a later copy. ', 'Change review: pending action. ')
    .replace(/Numbers in this window changed since your last full read, and .*? isn't one you've seen since\. /, '')
    .replace(/this call computes an element number \(.*?\), and numbers in this window changed since your last full read\. /, 'Computed stale number. ')
    .replace(/The SkyComputerUseService read path appears stuck: .*?answer Accessibility, but the control app's engine read also timed out\. /, 'Helper read path appears stuck. ')
    .replace(/Reads of .*? timed out twice\. The app and helper cause was not determined; sleight could not distinguish them with its independent checks\. /, 'Read timeout; cause unknown. ')
    .replace(/, while a fresh engine read of .*? responds\. /, '. ')
    .replace('The helper answered the control read.', '')
    .replace(/sleight: .*? has no Accessibility document windows, but macOS still lists "Save Panel Accessory View", a possible orphan Save panel\. /, 'sleight: possible orphan Save panel. ')
    .replace(/sleight: the user is in a full-screen or Split View Space, and none of .*?'s windows are on it\. /, 'sleight: off-Space windows. ')
    .replace('The engine and the drag tool read coordinates in these screenshot pixels. Claude Code shows this image smaller, at ', 'Shown at ')
    .replace(', engine screenshot ', ', ')
    .replace('Computer use recovered for ', 'Recovered: ')
    .replace('Change review could not take a later copy: ', 'Change review unavailable: ')
    .replace('Use the documented arguments; waitFor polls the window for an element or text.', 'Use API signatures.')
    .replace(/(Native API names: [^\n]+)\. Use API signatures\./, (_, names) => names.replaceAll(', ', ',') + '. Use API signatures.')
    .replace("sleight: the app has no windows left, so the window this call closed was its last. Nothing more to read.", 'sleight: last window closed; nothing more to read.')
    .replace("sleight: noWindowsAvailable means the engine found no window of this app on the current desktop. If the app has a window, it's on another Space (the user may be in full screen or Split View), minimized or hidden. Clicks may still reach it, but drags and some reads won't. ", 'sleight: noWindowsAvailable. ')
    .replace("sleight: the engine's JavaScript session restarted before this call, so handles from earlier calls (such as `app`) are gone. An action that fails without `await` can end the session. ", 'sleight: JS restarted. ')
    .replace("sleight: the engine couldn't reach its helper (SkyComputerUseService), so this call never reached an app. The helper quits after about 20 seconds idle and restarts on the next call, which can race. sleight already sent this call again once. ", 'sleight: helper failed; retry sent. ')
    .replace("sleight: the engine's helper (SkyComputerUseService) crashed during this call; that is the engine's bug, and macOS restarts the helper within seconds. ", 'sleight: helper crashed. ')
    .replace('sleight reconnected after a ChatGPT engine update.', 'sleight: engine reconnected.')
    .replace("sleight: the fresh engine still couldn't reach its helper after one reconnection. Stop and tell the user; `sleight-mcp --doctor` prints a fix when macOS won't relaunch the helper.", 'sleight: fresh engine helper failed. Stop; tell the user to run `sleight-mcp --doctor`.')
    // The read compactor's notes (compact-reads.mjs) and the stop notes (menu-continuation.mjs).
    .replace('sleight: 3 calls in a row scrolled this list. One call can search it: loop up to a fixed count, scroll, read with getAXState(), and stop when the target shows or the rows stop changing. Then click it and check the last read shows it selected.',
      'sleight: 3 scroll calls in a row. In one call, loop scroll and getAXState() a fixed number of times until the target shows or rows stop changing, then click it and check it reads selected.')
    .replace(' earlier reads of the same window in this call left out; the last is shown. Element numbers refer to the last tree.', ' earlier reads of this window omitted; numbers refer to the last tree.')
    .replace("if that wasn't intended, Undo (Cmd+Z) restores the order; a move dialog is the fallback.", 'if unintended, Cmd+Z (or a move dialog) restores the order.')
    .replace(" To switch tabs, use the app's next/previous-tab key or go-to control, not a click.", ' Switch tabs with the next/previous-tab key or a go-to control, not a click.')
    .replace(/ \(its file on disk changed during this call\)/g, ' (file changed on disk)')
    .replace(/\(no document save state change seen\)/g, '(no save state change)')
    .replace('(modified state cleared; cause unknown)', '(modified cleared; cause unknown)')
    .replace('document identity unavailable', 'no document identity')
    .replace(': engine returned no error text', ': no error text')
    .replace(/; the stopped (.+?) and everything after it were not sent\./, '; not sent: the stopped $1 onward.')
    .replace('sleight: lines changed since the last full tree you saw for this window (- removed, + added; numbers on + lines are current):', 'sleight: lines changed since your last full tree of this window (- removed, + added with current numbers):')
    .replace(' other elements have new numbers. Use numbers from + lines above or from a full read. Read the window', ' other elements have new numbers. Read the window')
    .replace(' button lines returned fewer attributes. Their unique IDs still match; missing descriptions and help are unavailable in this read.', ' button lines returned fewer attributes; IDs still match, descriptions and help are missing.')
    // The document guard's stops (document-scope.mjs).
    .replace(', an [x, y] point, a label or ID string, or { id: "<ID>" }, { label: "<label>" }, both together, or { line: "<whole line after the number>" }.', ', an [x, y] point, a label or ID string, or an { id }, { label } or { line } object.')
    .replace(' Use an element number or another ID from the window below.', ' Use a number or ID from the window below.')
    .replace('. Use the current numbers in the window below.', '. Use the current numbers below.')
    .replace('For one window of an app, call select_window with the app and its exact title or file URL, then', 'For one window, call select_window with its app and exact title or file URL, then')
    .replace(". Send the actions that didn't run in a new call that starts with let <handle> = await cua.getApp(", '. Send the rest in a new call starting with let <handle> = await cua.getApp(')
    .replace(") and acts through that handle, without select_window. One call acts in one app: to switch apps, end the call and start the next with that app's getApp.", ') that acts through that handle, without select_window. One call acts in one app.')
    // Relay stops and notices.
    .replace('Native access stopped: use the handle returned by cua.getApp directly, after a standalone native app read. No native lease for this browser call.',
      'Native access stopped: after a standalone native app read, act through its cua.getApp handle; this browser call has no native lease.')
    .replace('Native access stopped: send a standalone native app read before acting. Cannot snapshot before acting: ', 'Native access stopped: no snapshot; send a standalone native app read first: ')
    .replace('Copy/Cut used the native clipboard. Its contents were not restored by sleight; a successful copy remains available to menu Paste, pbpaste and browser pastes.',
      'Copy/Cut used the native clipboard, unrestored; menu Paste, pbpaste and browser pastes get a successful copy.')
    .replace(" sleight can't see whether Cut took effect: an app that disables Cut for the selection ignores the key, and its Edit menu shows Cut disabled. Copy works there.",
      " sleight can't see whether Cut worked: an app ignores it when its Edit menu shows Cut disabled. Copy works there.");
}
