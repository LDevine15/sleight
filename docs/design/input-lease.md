# Input leases

The relay takes a lease before forwarding an action. A second session gets an
error naming the holder and seconds remaining. It never waits for that holder.
Start with a standalone `let app = await cua.getApp("TextEdit")` read. Any
identifier works with `let`, `const`, `var` or a plain reassignment. A bare
acquisition also restores the global `app` handle without assigning a lexical
`const app`.

A call that starts with an acquisition statement and goes on to act, such as
`let app = await cua.getApp("TextEdit"); await app.typeText("x")`, runs as two
engine calls, also for the app the lease already holds. The relay sends the
acquisition alone, takes the lease from its reply, then sends the rest under the
guard, and Claude gets both results as one. A failed acquisition stops before any
action, and another holder's lease refuses the rest as it would refuse a second
call. Document mode and a selected window keep the standalone acquisition.

Window keys hash the bundle ID and observed URL, or title when no URL exists.
The last completed full Window header and engine bundle ID identify the target.
Bundle IDs stay attached to known handles across full reads and screenshots.
After a guard stop, a full read restores the target. Reset clears handles and the
current target; an acquisition can reuse a bundle ID only for a known selector
and matching full window identity. Display names alone never supply a bundle ID.
Ambiguous or missing identity stops actions with exact recovery code.
`select_window` raises a window by title or AXDocument file URL through Accessibility,
without activating the app. Exact titles take precedence. If no exact title matches,
one unique title ending in the requested app may match at the title start or after
whitespace. The request must have at least 12 Unicode code points after `trim()`,
excluding format (`Cf`) and combining (`M`) characters from the count. Matching uses
the original request. Ambiguity stops selection and lists at most five titles, each
cut to 200 characters, with the number omitted. Selection holds an app lease and
requires a matching standalone `getApp` read before acting. Recovery hints repeat that selection.
An active selection adds an "outcome unconfirmed" note for changed or missing
action headers. Reset, failed reselection or a confirmed window change
clears it. Document mode keeps its document_scope guard.
Unknown JavaScript counts as an action. Standalone acquisition, inventory,
AX-state and screenshot reads take no lease and can read a held window.
Inventory expressions can inspect data with JSON output, filters, comparisons
and literal regex tests. Assignments, extra statements and unknown calls remain
actions. Each acquired handle receives the guard, including alternate and
`const` bindings. Reads and actions update the handle used for the final header.

Leases live in `~/Library/Application Support/sleight/leases/`. Each JSON file
stores a random ownership token, session name, target and expiry. A shared SQLite
coordinator serializes file changes with zero busy timeout. Each lease manager keeps one connection
until close, with a rollback after every transaction, including refusals. Each transaction recreates
a missing directory and compares the coordinator's device and inode with those recorded when it
opened. A changed path closes and reopens the connection. Another check after taking the lock
refuses replacement before the lease callback runs. Rollback failure closes the connection; failed
close blocks further transactions. Callbacks never replay after starting. The manager ends each
transaction before returning to the caller. The coordinator remains on disk
after JSON removal so processes always lock the same inode. This needs `node:sqlite`,
available in the current ChatGPT bundled Node 24 runtime.

Actions renew at admission, every five seconds while running, and on completion.
Without renewal the lease expires after 30 seconds. Turn end and normal process
exit remove owned JSON files. Abrupt crashes leave files that expire. Cleanup
checks ownership, so an old holder cannot remove its successor's lease.
Transient renewal contention retries, while persistent failures stop the owned engine.
Shutdown bounds draining and collects the engine before releasing active leases.

The injected app guard checks window identity and lease token before each usual
engine action. With change review on, same-app dialogs without file URLs pass the
window check, including sheets opened during a call. Token checks still apply.
Document approval mode retains its strict window check. Local drag reserves its resolved app since its helper can select
another window. A native read resolves the name or path to one running bundle ID.
Local target resolution and keyboard-tap scans each reuse their own lazy helper, with a 30-second
deadline for each dispatched request. A third helper handles app-health probes with a two-second
deadline. Each helper serializes its requests; a timeout collects only the active process and leaves
queued work for its replacement. A stuck tap scan cannot delay a target. App-health probes cannot
interrupt either slow operation. A failed target reports its helper's failure and says rereading will not help.
Menu and notification actions reserve the desktop and conflict with all leases.
Change review reserves the desktop while the user decides, then releases it.
Inventory reads still pass. These broader reservations can block unrelated work.

Only cooperating sleight relays using this directory participate. Codex computer
use, other tools, older relays and the user do not take these leases. The guard
runs in mutable JavaScript and can be bypassed or its observations forged.
Never remove or replace the coordinator during live use. Metadata checks recover replacement
between transactions, but they cannot prevent arbitrary filesystem changes throughout an operation.
Blank titles are valid full headers and share a conservative window key.
Equal unsaved titles share a key; Save As, dialogs and window changes can stop
valid actions. Checks cannot undo an event already delivered to the native helper.

Windows without a URL also require a native AX identity check at call admission. The existing
target helper retains AX window references, compared with `CFEqual`, and records its own epoch
plus the app's PID and launch time. A new helper or process cannot reuse the old identity. A full
engine read establishes the identity, and the next action call must still match it. The helper
loads this query only when needed. A failed observation refuses input.

Windows with the same title and no URL remain ambiguous, even after `select_window`: the
engine's tree doesn't identify which one it read. The selection helper reports AXWindowNumber
when available, but its absence is common and position alone cannot distinguish a same-frame
replacement. Selection requires one match and rechecks its title and document after AXRaise.
The shared lease key still groups equal titles across sessions. The native check is at each call
boundary, with the existing cooperative tree guard inside a batch. It cannot prevent a window
change between that observation and an event already dispatched.

`node bench/input-lease.mjs` uses two relays and a temporary TextEdit document
for five races. `--extended` also checks renewal, expiry, handoff and cleanup.
`--baseline` omits enforcement. Earlier attempts and raw replies are retained in
[the results](../benchmarks/2026-10-03-input-lease.json).

Before the rebase, macOS 27.0 (26A428) trials doubled 5/5 baseline markers;
enforcement left one marker and one refusal in 10/10 trials. Sandbox access stopped
two attempts before typing. A locked Mac stopped one. After integrating change review,
the fresh baseline doubled 5/5; enforcement left one marker and one refusal in
10/10. Final renewal (35 s), expiry (31 s), handoff and cleanup checks passed.
An earlier expiry check hit the autosave guard. An additional sandbox attempt failed.
Fresh sessions keep other sessions' saved edits outside their review attribution.

The October 4 repair passed 5/5 races after rebasing onto the opt-in change review
and flow rules. Both engines exited, snapshots were removed and no leases
remained. [Repair results](../benchmarks/2026-10-04-input-lease.md) include the failed attempts.
The general benchmark belongs to sleight-arch at merge.

The launcher and extended benchmark can force-kill an owned engine that does
not exit, but collecting that process leaves the shared native helper's health
unverified. The owner cleared the earlier helper timeouts by restarting ChatGPT.
We have no measurement that attributes that wedge to a shutdown.

## Windows a call opens itself

In the default mode, a call may move to a window its own action produced in the same app (owner's
call, 2026-10-09). The action must be a shortcut, Return or click. Accepted windows:

- the Save or Open panel (`ID: save-panel` or `open-panel`)
- a new untitled window with no file
- a document titled or saved with a name the call typed

Before, the lease stopped such calls in 10 of 12 TextEdit runs with
first-call batching. A window the user opens in that app at that moment passes too. Document scope and
change review still stop on any change.

A tab the call's own Cmd+T or Ctrl+T opens in the leased window also lets the
call go on, with the new tab's header. In the Firefox race round (2026-10-17) Cmd+T stopped the URL's typing
in 8 of 12 tasks. In the tree, the window has exactly one tab more than when Claude last read it
and that tab is selected. Focus is on a text field or combo box outside any page, with no sheet.
Then the helper checks twice, after the stop and just before the rest goes to the engine. The window
and process must be the ones from the call's start, and the window must still be focused. It must
have no sheet and a non-password field in focus with no web area above it, and no HID input since
the call began. A click on a new-tab button still stops, since its
focus stayed off the address field (4 of 4). `SLEIGHT_TAB_CONTINUATION=0` stops at the tab as before.
Replaying the round's 12 stops through the tree checks continues the 8 Cmd+T calls and refuses the 4
clicks. It hasn't run live.

## Dialogs and palettes

A dialog, sheet, palette, gallery, floating window or popover (`0 window`, `0 floating window`, `0 popover`) the lease moved to
remembers the standard window it covered. A call whose own action closes it goes on there (`dialogRemainder`).
`SLEIGHT_POPOVER_CONTINUATION=0` restores the earlier behavior: popovers aren't remembered, and an untitled palette closed
by a button isn't refused.

When such a window closed between calls and a degraded read dropped the lease, the next call's recovery re-acquisition used
to refuse it as stale ("it was Insert Table": 7 calls in the 2026-10-17 office runs). The covered window becomes the lease
instead (`parentLeaseRefusal`) only if all of these hold:

- Claude's last result showed it as a standard window, and this call's read shows it with that app, title and URL, a
  standard-window root and no sheet or dialog.
- The helper doesn't find a window with the dialog's title and URL, and finds the covered window focused, AXStandardWindow, without
  sheets, in the process it was seen in, with no HID input since it was last seen standard.
- It is the one window with that header, or the native window certified when it was read. A window without a URL needs that
  certification.
- The dialog had a title (or was a sheet), and the rest has no literal element numbers.

The rest is then admitted pinned to the native window just observed, for that call only. At that admission an unavailable
or ambiguous identity stops the call. `SLEIGHT_PARENT_LEASE=0` keeps the
refusal. LA1 adopted a window inside a call and failed two reviews for typing into a window it hadn't verified, so this applies
only between calls and only to the window the relay recorded under the dialog.
