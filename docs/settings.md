# Settings

You don't need any of these. They change approvals, guards, receipts, review or experimental behavior.

## Front app after launch

Front restoration is on by default. Set `SLEIGHT_FRONT_RESTORE=0` to turn it off for an A/B.
When a literal `cua.getApp(...)` acquisition launches an app and it takes the front, sleight gives
the front back to the user's earlier app once, if that process is still running. It leaves the
pointer alone. A focus change before dispatch, a click during the call, a different front app
afterward or a failed call cancels restoration. Typing during the launch doesn't, since that typing is
what the restore protects. The result and trace say when restoration happened.

## Receipts and unsaved review

Set `SLEIGHT_RECEIPTS=1` to write a private JSON receipt after each used turn to
`~/Library/Logs/sleight/receipts/`. The pane shows the latest receipt's path. It lists the observed app
and window, recognized actions and targets, the call's outcome and changes in the returned reads.
Typed and pasted text and literal values become length markers. Raw code, accessibility trees,
screenshots and error text stay out of the file. A computed input has an unknown length.

Receipts are off by default. Window titles become length markers by default; the app name and
a document's file name from its `file://` URL remain, with the account's username and full name scrubbed.
`SLEIGHT_RECEIPT_REDACT_TITLES=0` keeps scrubbed titles, which can contain other private data.
Single printable keys become length markers too. Named keys and shortcuts with modifiers remain.
Each write prunes writer-owned receipt files to seven days or 200 files, whichever is fewer.
The directory is private to your account (0700), and each
file is readable and writable only by you (0600).

Set `SLEIGHT_STATE_REVIEW=1` to show changed or modified windows at turn end. This is off by
default and independent of saved-file change review. It uses reads the relay already received.
You can leave the window as it is, or use a native Undo or Revert To Saved control when one was
observed. The review tells you which control was available. You use it in the app yourself.
Missing reads, failed or overlapping calls, and turns over 2,000 calls report uncertainty.
An accessibility change doesn't prove that a file is saved or unsaved. See the
[design and limits](design/review-receipts.md).

## Text drags

`drag` tries Accessibility text edits first in every app, then background posted events,
then the foreground fallback when the earlier attempts didn't change the text. Both points must
share one text area or field with a non-blank selection. Non-text drags use the content-area
check and require readback to confirm delivery.

Accessibility text moves can lose rich formatting. The app-specific rich-text option was
removed on 2026-10-11. Drag no longer stages text on the clipboard.
See [drag limits](known-problems.md).

## Clipboard

Set `SLEIGHT_CLIPBOARD=preserve` to keep Copy and Cut in a session-private clipboard that sleight
puts back after the action, so sleight never leaves your clipboard replaced. Off by default: a copy
meant for you can't reach menu Paste, `pbpaste` or a browser paste from sleight's private copy, and
each preserved call takes about 230 ms longer. [The design](design/clipboard.md).

## Payments you asked for

Payments explicitly requested in the user's own message count as confirmed when that message
specifies what to buy or pay, the amount and the payment details. This includes the page's confirmation dialog
for that same item, amount and payee. A payment whose amount the message doesn't state asks, even when the page
shows a total. Other payments still require confirmation, and page content never grants permission.
Set `SLEIGHT_CONFIRM_PAYMENTS=always` to keep the engine's rule that requires confirmation immediately
before every financial transaction. Set `SLEIGHT_CONFIRM_PAYMENTS=never` to also skip turbo's one remaining check (a money figure
on the checkout larger than the amount in your message) for a payment your message named with its amount. A payment you didn't
ask for, a second payment in the same request and a mismatched amount still ask. Only you set it, as an environment variable of
the MCP server. The default rewrites only the exact engine policy measured on 2026-10-12. Changed policy text is forwarded unchanged and records a trace entry when tracing is enabled.

## Approval scope

Saying yes to an app approval allows that app for the rest of the Claude Code session. Claude Code's
prompt doesn't mention that, but sleight's own panel does.

The engine asks before every action on an app and doesn't remember a session's answers. In Codex, the app
around the engine remembers "Allow for this session" and answers the repeats. Claude Code's prompt only
has accept and decline, so without help you'd get asked on every click. The relay does the remembering:

- After you accept an app, the relay answers later requests for the same app at the same risk level for
  the rest of the session.
- A different app, a riskier request for the same app, or a new Claude Code session asks you again.
- It never remembers a decline or a cancel.

You can also pick "Always allow", with the third button in sleight's panel or the *Always* option
of *Remember this choice* in Claude Code's form. It adds the app, at that risk level and with the date, to your
pre-approved list, so later sessions don't ask. Terminals and OpenAI's apps never offer it.
`sleight-mcp allow list` shows the list and `sleight-mcp allow remove <app>` takes an app off.

Apps you marked "Always allow" in Codex or ChatGPT are the exception. The engine keeps that list in
`~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`
and approves those apps itself, so sleight never sees a prompt for them: TextEdit, listed there,
opened with no prompt, while Calculator asked (2026-10-08). sleight doesn't change that file. To be
asked again, remove the app from "Always allow" in ChatGPT's computer-use settings.

To get asked on every action instead, set `SLEIGHT_APPROVAL_SCOPE=once` in Claude Code's environment.
The `env` block of `~/.claude/settings.json` works.

Set `SLEIGHT_APPROVAL_SCOPE=document` to approve a document or window for the session instead.
First call `js` with only `let app = await cua.getApp("TextEdit")`, then call `document_scope`:
the prompt specifies the observed window
and document URL. A different window stops further actions until you read it and ask the user again;
`drag`, `hover`, `menu_bar`, `notifications`, `open_file` and resets are unavailable in this mode.
`cua.getApp({ windowId: 123 })` does not work on macOS, so it cannot select a document here.
For several windows, call `select_window` with `app` and an exact file `url` or `title`,
then acquire the app and check its full Window and URL before `document_scope`.
`SLEIGHT_SELECT_WINDOW=0` leaves the selection tool out.
`SLEIGHT_OPEN_FILE=0` leaves out `open_file`, which opens a file in an approved app in the background.
This guards mistakes in cooperative code. [The design](design/document-scope.md) lists what
the relay enforces and how arbitrary JavaScript can bypass the checks.

In the desktop app's Code tab, sleight asks with its own prompt instead: a small panel with
sleight's icon, Allow and Don't Allow. It plays a sound and opens on the display under the pointer,
over full-screen apps too. The Code tab (Claude 2.19675.0) declines MCP prompts without
showing them, so a forwarded prompt would always come back as no. Return does nothing in sleight's
panel, Escape means no, and it gives up after five minutes. Session memory works the same way.
`SLEIGHT_APPROVAL_PROMPT=dialog` or `client` overrides the choice.

In other MCP clients, sleight reads `initialize.params.capabilities.elicitation`. Form support
(`form: {}`, or the older empty elicitation object) uses the client's prompt. Missing elicitation
or URL-only support uses sleight's panel for app and browser approvals and its own tools' prompts.
The relay tells the engine it can answer forms itself. It remembers accepted apps with the same
risk and session limits. A failed panel never approves an app. A forced `client` setting without
form support cancels the request without opening a panel. Put these environment settings in your
client's server configuration.

The panel keeps Claude wording when `initialize.params.clientInfo.name` is `claude-code`. If
`clientInfo` is absent, `CLAUDE_CODE_ENTRYPOINT` supplies that identity. Other hosts get generic
wording. If the panel cannot be shown, the call reports that failure rather than a user decline.
Forms generated by the relay for local tools, documents, flow exceptions and change review expire
after five minutes without granting approval. A late answer cannot change that decision.

## Turns without a hook

The Claude Code mod ends the engine's turn when Claude finishes. Other clients can omit the mod
and `turn_ended`: after 30 seconds with no pending tool call, the relay ends a used turn itself.
It keeps the session's accepted approvals and gives the next call a new turn ID. Disconnecting
also ends the open turn. This releases engine turn resources; it does not cancel a running call
or quit an app.

`SLEIGHT_IDLE_TURN_END_MS` changes that wait in milliseconds, and `0` disables it. Keep the default
when your client has no turn hook. The wait restarts on each completed call, so several model turns
can share one engine turn. Approvals last for the server process,
so a client that keeps one server across conversations also keeps its approval session.

Rejected turn cleanup retries at that interval, with three total attempts per turn. After the third
rejection, sleight logs one warning and drops that turn's cleanup. A later turn has its own budget.
This bounds retries. It cannot confirm that an engine which rejects cleanup released its resources.

## Screenshot scale note

Any app's screenshot with a long edge over 2000 pixels gets a note with the engine's pixel frame,
the shown size and the multiplier between them. The 2000-pixel size comes from one observation on
2026-10-10: 2200 × 1600 shown at 2000 × 1455. The note is on by default; its existing setting,
`SLEIGHT_SIM_FOCUS_NOTE=0`, turns it off. Coordinates are unchanged. A large window in an app other
than Simulator or Device Hub still needs a live check.

## Demonstration recording

`sleight-mcp record --watch org.example.editor task.json` selects an app by bundle ID. Open one
window yourself before recording. Editable native text areas and fields need an empty baseline
before observation. Existing text is never recorded. Replay keeps its app approval checks.

## Local tools

The `menu_bar` and `notifications` tools, the `drag` and `hover` fallbacks, `select_window` and
`open_file` are sleight's own, outside the engine. All are on by default. `SLEIGHT_MENU_BAR=0`
leaves the menu bar and notification tools out, `SLEIGHT_DRAG=0` the drag tool, and
`SLEIGHT_HOVER=0` the hover tool. `SLEIGHT_SELECT_WINDOW=0` and `SLEIGHT_OPEN_FILE=0` are under
[Approval scope](#approval-scope).

## Browser surface

`SLEIGHT_SURFACES` picks what the engine gets. Unset, the default, it is automatic: `computer` plus
`browser` when a cached discovery less than six hours old reports a connected ChatGPT browser
extension, otherwise `computer` only. Set it to `computer` or `browser,computer` to fix the choice.
An engine started from ChatGPT.app, when there's no Codex plugin, is computer-only unless you set
it. [How it works](how-it-works.md#browser-surface).

## Turbo

Turbo, the direct Chrome DevTools path for browsers, is on by default. At startup sleight writes
`~/Library/Application Support/sleight/turbo.json` when it is missing, and rewrites it when the plugin
files or the node version no longer match it. The file records the browser, its profile folder and a
hash of the installed plugin. A file with `enabled: false` is your opt-out, and sleight never
overwrites it. Claude's own file edits and shell commands can't write the file or run `turbo on` and
`turbo off`.

- `sleight-mcp turbo status` prints whether turbo is on, the browser, its profile folder and whether
  remote debugging is on (the profile's `DevToolsActivePort` file exists while the browser runs with it).
- `sleight-mcp turbo off` writes the opt-out. Turbo stays off until you run `turbo on`.
- sleight's glove sits in the menu bar when turbo is connected, paused or waiting for cleanup, or when a request waits
  for you. The menu shows the state and browser beside a coloured dot, the host the session runs in with its version (as
  the MCP client introduced itself, and never a model, since no host reports one), how the payment check is set, Pause (or how a pause
  ends), Disconnect, Turn Turbo Off…, Settings & Help… and the version. Turn Turbo Off asks once, then writes the same
  opt-out as `turbo off`, and every session's turbo stops within a minute. With turbo disconnected and nothing waiting,
  the icon is hidden.
- `SLEIGHT_TURBO=0` in the MCP server's environment keeps that one server on the engine path without touching the file.
  It can only turn turbo off. The Firefox and Safari benchmark arms and sleight's Codex plugin set it.
- `sleight-mcp turbo on` turns turbo on. `--browser chrome` or `--browser helium` picks the browser.
  Without it, Google Chrome is first and Helium second. A browser whose executable others can write is
  skipped, because the connection refuses it. The exception is Chrome or Helium with a group-writable
  executable (mode 775, the result of a drag install), which turbo accepts when its code signature
  checks out as Google's or imput's. Mode 777 is always refused.
- Without a supported browser the launcher doesn't write the file and prints one line with the reason.
- Remote debugging stays your step: turn it on at `chrome://inspect/#remote-debugging`. The browser
  asks you to allow each connection.

`sleight-mcp --doctor` starts with a turbo section. It reports the config state, the browser and whether
the receipt is current, then whether the native helpers are compiled and whether remote debugging is on,
each with the one fix. It only reads.

## Preapproved apps

Write `~/Library/Application Support/sleight/preapproved.json` yourself to allow selected apps without
an approval prompt. This applies to interactive sessions too, including the desktop app's Code tab.
Sample file:

```json
{
  "version": 1,
  "apps": [
    { "app": "com.apple.calculator", "riskLevel": "low" },
    { "app": "Calculator", "riskLevel": "low" }
  ]
}
```

Create the parent folder first and set the file's permissions to `600`. sleight refuses symlinks,
files owned by someone else, and group- or world-writable files. Invalid files stop startup.
It reads this fixed path once at startup. Edits take effect in a new session. No environment variable,
project `settings.json` or plugin setting can select another file or add apps.

App identifiers match exactly, including case. List the bundle ID in the engine's prompt and the name
or path you use with local tools separately. There are no wildcards or inferred aliases.
`riskLevel` is a ceiling: `low`, `medium`, then `high`. Higher, missing or unknown request levels still
ask. `high` accepts every engine approval request for that app at a known risk level.
Local `drag` and `menu_bar` approvals require `high`, since they can move the real
pointer. This list does not approve notifications, document scope, change reviews or flow exceptions,
and it cannot override the engine's app blocks.

The list also applies with `SLEIGHT_APPROVAL_SCOPE=once`. Each grant goes to stderr and a grant audit,
and the tool result tells Claude that the app was pre-approved by the user's list, even if the action
fails. Each relay's audit at `~/Library/Logs/sleight/preapproved-<pid>.jsonl` contains grant fields only.
It rotates at 64 KiB and keeps one prior file per process.
Full relay tracing is separate and off by default: set `SLEIGHT_TRACE` to `1` (which writes
`trace-<pid>.jsonl` under `~/Library/Logs/sleight/`) or to a directory path. It cuts long strings to
300 characters; `SLEIGHT_TRACE_CUT` changes that length, and `SLEIGHT_TRACE_CODE=1` adds Claude's
code, up to 4,000 characters.
An audit write failure falls back to asking. List grants never send an engine persistence setting.

## Review changes

Set `SLEIGHT_CHANGE_REVIEW=1` to turn this on. It's off by default: with it on, both benchmark tasks that open a
TextEdit file through the Open dialog were refused before editing (0/2 on 2026-10-03 and again on 2026-10-04).
Read the intended window with a standalone `let app = await cua.getApp("TextEdit")` before editing.
For a document with a `file://` URL, sleight saves a private copy before the first possible edit.
Open dialogs and same-app sheets can proceed without a copy. If a file was first seen after an
action, a fresh standalone read takes a later copy, and review shows where undo starts.
Call `review_changes` with `op: "list"` to see text diffs or size/date summaries, or `op: "review"`
to choose Keep, Undo or Later for each document in sleight's prompt. Only your prompt response can
decide. Undo restores the saved copy if the file still matches the last agent action, then you
must reopen it in the app. Snapshots last until the session ends.

## Careful guard

The native guard skips the first read for keys, text and coordinates, lets typing follow edit shortcuts or field clicks without
another read, and uses one capture's element numbers until an opener or explicit read replaces it. It still reads for the first
element lookup, after actions that can open a panel, and at the end of an acting call. In the 2026-10-14 A/B this default passed
15/15 against 14/15, with tool time 35% less and guard-read time 5.7 s against 17.3 s.
Set `SLEIGHT_GUARD=careful` to read before every action. Document scope (`SLEIGHT_APPROVAL_SCOPE=document`) and change review keep
their reads.

Set `SLEIGHT_GUARD_LIGHT_RETURN=1` to replace the full read before typing right after Return, Enter, Tab, Escape or Space with
a native check of the leased window (see [guard reads](design/guard-reads.md#light-check-after-return-2026-10-17)). It is off by
default and hasn't run live: we haven't measured how late alerts and sheets appear after Return.

`SLEIGHT_TAB_CONTINUATION=0` (A/B baseline) stops a call at a tab its own Cmd+T opened as before, instead of typing the
rest there ([input leases](design/input-lease.md#windows-a-call-opens-itself)).

`SLEIGHT_POPOVER_CONTINUATION=0` (A/B baseline) restores the earlier behavior. When the call closes a dialog, sheet, palette,
gallery or floating window, the rest of the call still goes to the window under it. A popover stops it, and an untitled
palette closed by a button isn't refused. `SLEIGHT_PARENT_LEASE=0` (A/B baseline) keeps the "window changed
since the last call" refusal when a dialog closed between calls ([input leases](design/input-lease.md#dialogs-and-palettes)).

## First-call batching

The engine's tool description tells Claude to send only the app's acquisition in its first call.
sleight rewrites that sentence so Claude can put the first actions after the acquisition in the
same call, since the guard checks the window before they run. It also names `cua.getApp` for an app
Claude can name, which took the first-call `getState` from 8 of 11 runs to 0 of 12 (2026-10-11). Set
`SLEIGHT_FIRST_CALL_BATCH=0` to keep the engine's wording. `SLEIGHT_FIRST_CALL_BATCH=merge` also
asks Claude to chain later calls such as save and close into one, which happened in 0 of 24 runs.
`SLEIGHT_FIRST_CALL_BATCH=nosavestop` (for an A/B, not yet run) drops the instruction to end a call
after Cmd+S and says sleight waits for the sheet a shortcut opens.

## Result size

`SLEIGHT_RESULT_TRIM=1` (under A/B) leaves a split acquisition's tree out of a result when the same
call returned a newer full one. It tied the default (24.8 s against 23.8 s a run, 2026-10-11). It
also drops runs of 20 or more sibling rows from a result over 25,000 characters, keeping selected
rows, folders and rows matching the window title or file name (unit-tested, not yet measured live).

A call that reads one window more than twice shows only its last read of that window, plus a line
saying how many were left out. The code still gets every read, and errors, notices and other windows'
trees stay. Travel's 40-read airport search in Firefox (2026-10-17) returned 140,778 characters and
spilled to a file; replayed, it is 3,620. `SLEIGHT_CALL_TREES=all` (A/B baseline) shows every read.
A sheet, dialog or menu read under the same title stays. After three calls in a row, none of them a
loop, scroll the same list the same way, a note suggests searching it in one call with a capped
loop that checks for progress and verifies the selection. In a live probe without a model, one such call
found and selected the airport in 33 s, against 88.7 s over 15 calls. `SLEIGHT_SCROLL_NOTE=0` (A/B baseline) leaves the note out. Neither
is measured end to end yet.

`SLEIGHT_COMPACT_REACQUIRE=1` (opt-in) compacts the tree of a window Claude acquires again after
seeing it whole, sending "no change" or the changed lines as a read does. It cut
prompt tokens 9% but lost its 2026-10-17 A/B on excel-edit and word-edit (156.3 s against 149.4 s
over 5 rounds, 9/10 against 10/10 passes).

`SLEIGHT_RULES_FIRST=0` (A/B baseline) puts the skill's rules after the first window tree in a
result instead of before it. `SLEIGHT_TEXTLESS_HINT=0` (A/B baseline) leaves out the note that a
document area doesn't show text values and should be read with a screenshot.

When the window `open_file` opened is such a document (a sheet with no cell values, a page with no
body text, from a file that isn't empty), its result also includes the window's screenshot, taken by
one more engine read, in place of that note. It comes only where the note would, and only when the
window's URL is the opened file, so `SLEIGHT_TEXTLESS_HINT=0` leaves it out too. In 10 of 10 excel-edit and word-edit runs (2026-10-17),
Claude spent two turns on a second read and a screenshot before its first edit.
`SLEIGHT_OPEN_AUTO_SHOT=0` (A/B baseline) leaves the screenshot out. `SLEIGHT_OPEN_SHOT=1` adds one to
every `open_file` result.

`SLEIGHT_OPEN_RULES=short` (for an A/B, off by default) gives an `open_file` result the skill's rules
without the lines about acquiring an app, choosing a window, tap coordinates, the drag, hover and
banner tools, and the doctor (4,897 characters down to 3,605). It keeps every safety passage word for
word. The whole skill comes with Claude's first `js` result. Haiku thought before its answer in 18/18
sleight preview-read runs, each given the whole skill in its first result, against 2/5 Peekaboo runs (2026-10-17).
That is a correlation, and the A/B has not run.

## Launch re-read

`SLEIGHT_LAUNCH_REREAD=1` (for an A/B, not yet run): when an acquisition launched the app and its
tree has 1 to 19 elements, sleight waits 2.5 s, reads once more and keeps the fuller tree if it shows
the same window. Electron apps build their tree seconds after launch. Off by default.

## Doctor app reads

`sleight-mcp --doctor` checks the helper's inventory. Add a running app name or bundle ID, such as
`sleight-mcp --doctor Calculator`, to check that app's accessibility read too. Doctor reports elapsed
milliseconds and whether it received a window header. It skips missing or ambiguous apps and declines
approval requests without showing a prompt, except when the user's pre-approved list covers that
app and risk. It uses the same fixed list and grant audit as a session, without engine persistence.
Doctor only reads. A failed app read exits 1; a skipped
app read leaves a successful inventory check at exit 0.

## Flow rules

Write `~/Library/Application Support/sleight/flow-rules.json` yourself, outside the project, then set
`SLEIGHT_FLOW_RULES=1` in Claude Code's environment. An absolute path selects another user-owned file.
The relay reads it once before starting. Edits take effect in the next session. A sample file:

```json
{
  "version": 1,
  "rules": [
    { "id": "contacts-mail", "kind": "source", "sources": ["Contacts"], "destinations": ["Mail"] },
    { "id": "private-site", "kind": "source", "sources": ["site:*.internal.example.com"], "destinations": ["site:public.example.com"] },
    { "id": "ssns", "kind": "pattern", "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b", "destinations": ["*"], "except": ["1Password"] },
    { "id": "cards", "kind": "pattern", "pattern": "\\b(?:\\d[ -]?){13,19}\\b", "destinations": ["*"], "except": ["1Password"] }
  ]
}
```

Rules stop matching literal transfers before forwarding and tell Claude which rule matched.
`flow_exception` shows the exact stopped call for your decision. Allow Once permits one identical
retry. Another call cancels it. Claude cannot grant an exception through tool arguments. Pattern
rules accept optional regex `flags` (i/m/s/u). App names and observed bundle IDs ignore case.
Source rules remember text fields and emitted values, then match exact substrings sent later.
Use `site:example.com` in `sources`, `destinations` or `except` to select one HTTP or HTTPS host,
across schemes and ports. `site:*.example.com` selects subdomains, excluding the bare host. Site
names ignore case and use ASCII DNS labels (or punycode) or canonical IPv4 addresses. Other wildcard
forms, URLs, paths and ports in selectors are refused. App names, bundle IDs, `browser` and `*` keep
their existing meaning.

Sites come from the engine's window or tab URL header. Saved tab handles keep separate observations,
and source text keeps the host where it was read. Unknown browser sites remain subject to site
destination rules and cannot use a site exception. Missing or conflicting headers clear the current
site. A navigation call clears its earlier site until the next header arrives. Native browsers share
one observed window per app. A person's navigation between reads can leave an observation stale.
At startup, enabled flow rules read LaunchServices registrations for both HTTP and HTTPS. The
registered bundle IDs and app names identify browsers even before a URL header arrives. The
existing browser list is the fallback when registration lookup fails. Registrations are read once
per session. Relaunch sleight after installing a browser.
[The design](design/flow-rules.md) explains the gaps in literal checks and source attribution.

## Driving apps the engine refuses

The engine's helper refuses terminals (Terminal, iTerm2) and OpenAI's own apps (ChatGPT, Codex,
Atlas, and their beta builds) before any approval prompt. That refusal is OpenAI's code, and sleight
never modifies or wraps it. When Claude reaches one of these apps, the result says so and names the
one setting that lifts the refusal. Only you can turn it on, and sleight never sets it:

```bash
defaults write -g ComputerUseAllowForbiddenTargets -bool YES
```

The setting belongs to OpenAI's helper, so Codex loses the refusal too. The helper reads it when it
starts (it quits after about 20 seconds idle), and `--doctor` shows whether it's on. Then these apps
get the same approval card as any other app (Always allow, Allow, Decline), with one added line
saying the app could be dangerous: a terminal runs commands, and another AI app has its own approval
buttons Claude could press.

sleight still refuses actions in these apps' settings windows. The relay checks the title of the
window Claude last read against Terminal's pane names (General, Profiles and others) and the words
Settings and Preferences. Like the other window guards, this check runs in cooperative code
and is not a security boundary. To turn the setting back off:

```bash
defaults delete -g ComputerUseAllowForbiddenTargets
```

We tested it live on 2026-10-05 with engine 26.930.31730. Terminal ran an `echo` in the background
2/2 and never came to the front. The prompt included the warning above. An action in Terminal's
settings window was refused 1/1. OpenAI's apps reached the engine's approval prompt instead of its
refusal, but driving them this way is untested. The setting is undocumented, so an engine update
can remove it.

## Benchmark and development settings

`SLEIGHT_BENCH_API_CAP_USD` caps a benchmark pass's model spend for the month in dollars; the pass
refuses to start at the cap (default 200). `SLEIGHT_ARM_DIR` moves the benchmark's sleight arm
folder (default `~/Library/Caches/sleight-bench/sleight-arm`). `SLEIGHT_STUB_OSASCRIPT=1` stubs
`osascript` and `open` in the startup-cost measurement scripts. A measurement then doesn't run a
real app. `SLEIGHT_CHATGPT_APP` points `bin/sleight-mcp` and `sleight-mcp setup` at another ChatGPT copy
(default `/Applications/ChatGPT.app`).
