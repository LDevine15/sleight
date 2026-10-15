# Known problems

What doesn't work, or works only partly, with the measurements behind it. We found all of these in
our own runs. Dates and engine versions are given where they matter.

## Approvals and guards

- The preapproval loader proves file ownership, not who wrote it. The mod refuses Claude's file edits
  and common shell writes to it (unit-tested, 2026-10-12), but any other process running as you can
  write it, and a path built at run time gets past the check.
- `claude -p` can't answer approval prompts. List apps in the user's [preapproval file](settings.md#preapproved-apps) before starting.
- `sleight-mcp setup` (unreleased) hasn't had a full live run: macOS permissions always need the user's click.
- The engine refuses terminals (Terminal, iTerm2) and OpenAI's own apps (ChatGPT, Codex, Atlas, with
  their beta builds). The list is in the helper; [a setting](settings.md#driving-apps-the-engine-refuses)
  lifts it. sleight's `blocked_app` path was removed on 2026-10-11.

## The pointer, drags and hover

- Anything moving your real pointer in the app interrupts it. The engine watches real mouse and keyboard
  input to notice a person taking over, then makes Claude re-read the app. Another agent driving in the
  foreground counts too. Background sessions share the helper, with leases coordinating sleight's actions.
- Accessibility moves write plain text: on 2026-10-11, 3/3 background moves of a bold red word in a
  covered TextEdit window came out plain black Helvetica. Text whose formatting differs from its
  paragraph's now takes the posted or foreground drag instead (unit-tested, 2026-10-12). A paragraph
  formatted the same throughout still goes through the plain write, and whether the posted drag keeps
  formatting is unmeasured.
- With the Claude app's window over the board (2026-10-09), the engine's `app.drag` moved a pawn
  (1/1) where `drag`'s background posts at the same points didn't (0/2). `drag` now refuses a covered
  drag that has no selected text and points to `app.drag`. On that board `drag` took 11 to 14 s, 9.4 s
  of it reading the window's elements through System Events. That scan now uses the Accessibility API
  with a 0.5 s deadline (unit-tested, 2026-10-12). Its live timing is unmeasured.
- After an Accessibility text write, TextEdit's next Cmd+S deadlocked on the document's save lock in 10
  of 13 probe trials with the file opened through the Open panel (0 of 3 opened with `open -g`), the
  same hang as `setValue` on 2026-10-05. One Shift press and release posted to TextEdit's process after
  the write prevents it: 0 hangs in 10 trials that edited, against 5 in 8 without it, and then 10
  `drag` moves in a row saved with no hang (2026-10-09). We don't know why the event helps, or what
  held the lock. A Cmd+S posted to a background TextEdit's PID doesn't start a save. The 2026-10-08 hangs
  came through the engine's `pressKey("super+s")`.
- Posted events repair the verified space after a text move. Posting only works when no other app's window covers the drag
  points, because macOS picks the drop target from what's on screen there: 3/3 TextEdit moves with
  the window uncovered, 0/3 with this Claude window over it (2026-10-05).
- Safari's web text areas ignored Accessibility text writes (1/1 on 2026-10-09), so the mouse
  paths remain necessary when an app ignores the edits.
- `CGEventSetWindowLocation` is a private macOS API. Missing symbols, invalid events or coordinates that fail the
  round trip skip background posting and select foreground. Future macOS updates may break this path.
- The foreground drag is the last resort. On 2026-10-08 it took the owner's focus mid-sentence
  during a pass, and a typed space went into TextEdit, so it now waits for 2 s without any input (up
  to 10 s), and stops if keys are typed once it has taken focus.
- There's no background hover, since engine events go to the app and the real pointer never moves.
  Hover captures screen pixels in the selected window's rectangle. A window spanning displays could
  include another app in that rectangle, as a Chess trial showed, so hover now refuses one.
- When you work in a full-screen or Split View Space, apps sleight drives in the background are on
  another Space. Clicks and typing still reach them, but the engine's `app.drag` answers
  `noWindowsAvailable`, sleight's `drag` refuses the off-screen window, and TextEdit's reads timed
  out. A pass with the Claude app in Split View failed 8 of 21 runs, all in TextEdit, Chess and the
  simulator (`docs/benchmarks/2026-10-08-await-split-view.json`). Moving a window into a full-screen
  Space needs private macOS APIs, so leave full screen while sleight drags.

- The benchmark's drag audit (`bench/world/method-check.mjs`) credits a drag that follows a nested labeled block whose inner
  `break` targets the outer label (`outer: { inner: { break outer; } await app.drag() }`), though that drag never runs. A peer
  review found it on 2026-10-13. No recorded run wrote such code.

## Browsers

- A page that opens a popup from its own script can still take the screen during a browser session. Since 2026-10-13 sleight opens
  links and forms that target a new tab or window as background tabs, but it keeps the page's own click for inline handlers,
  links that need `window.opener`, downloads and anything a script opens, because the engine's read-only page access can't see
  or stop those. The extension's own popup interception sits behind a remote OpenAI flag with no local switch. Before the change,
  sleight's arm took focus 7 times in a 13-task Haiku round on 2026-10-12, against 2 for FowlBrowser's. The rerun is pending.

- In a browser started with `--remote-debugging-port`, such as the benchmark's own headless Chromium, a page's speculation rules
  (prefetch, prerender, or rules a script inserts) can request the DevTools HTTP endpoint and close another tab through
  `/json/close`. Turbo's Fetch guards never see those requests, and in a 2026-10-15 probe no per-page control stopped them
  (prerendering off, blocked URLs, cache off, data saver). Turning off Chrome's Preload pages setting stopped all three in Chrome,
  while the headless shell ignored that setting. A browser connected through Chrome's own remote debugging consent, the way turbo
  connects to the user's browser, answers 404 on `/json/version`, `/json/list`, `/json/close` and `/json/new`, so there it has nothing to reach.
- Turbo relies on Chrome refusing page WebSockets to the debug port by their Origin. A Chrome started with
  `--remote-allow-origins=*` would let a page drive another tab that way. sleight doesn't check for that flag.

On FowlBrowser's own 13 tasks (2026-10-12), sleight passed 23/26 in 2,109 s against FowlBrowser's 26/26
in 972 s ([results](benchmarks/2026-10-12-fowlbrowser-h2h.md)). Still open from that list:

- Chrome and Helium both report as "Chrome" in `listBrowsers`.
- A session never closes the tabs it opened.
- A web page's tree is capped in a result, but the first browser result of a session, with the engine's docs,
  still came to 55,450 characters on one article, over the 45,000 sleight aims for.
- A payment the user didn't ask for in their own message still stops for confirmation, by design. One the user asked for, naming what to pay and with what, goes through (`SLEIGHT_CONFIRM_PAYMENTS=always` restores the stop).

Fixed since: tab calls no longer take the native input lease, `SLEIGHT_SURFACES=browser` works, and a tab's tree
is capped with a note on how to read the rest.

Engine behavior that sleight works around or can't change:

- `tab.drag` doesn't drop on an HTML5 drag-and-drop target when aimed at the target's center (0 drops in 14
  trials in Chrome and Helium). It moves in 8 equal steps, and the page sees `dragover`, which a drop needs,
  only when two moves in a row are inside the target. Aimed 3 px inside the target's edge nearest the source,
  it dropped 6/6 (`bench/fowl/drag-probe.mjs`).
- After `tab.click` on a download link, no download prompt appears, and every later download in that tab times
  out, `downloadMedia` and `waitForEvent("download")` alike (2/2 each, raw engine and sleight). Without that
  click both returned in under 0.4 s. A new tab downloads normally (`bench/fowl/download-probe.mjs`).
- The page's `evaluate` is read-only: it can't dispatch events, assign globals or watch the page's network.
- The engine opens tabs one at a time. A tab took 0.9 s to open alone, and 1.3 to 2.9 s each when 6 sessions opened
  one at once, about 0.3 s more per session in line (`bench/fowl/coldstart-probe.mjs`). In a round that starts 13 sessions at
  once, the first call's median was 4.8 s.

## Clipboard

- Preservation cannot snapshot unreadable formats, file promises or more than 64 MiB, and macOS has
  no atomic compare-and-restore, so a failed Copy/Cut leaves new clipboard data alone.

## The engine and its helper

- An action called without `await` that fails used to end the engine's JavaScript session, and every
  handle with it (`app.click(1); "x"` on a disabled Calculator element, 3/3 on 2026-10-07). The guard
  now attaches a handler to each action's promise and tells Claude which action failed. With
  `const p = app.click(99999)` and more code after it, 1.0.0 reset the session (1/1) and the fix
  kept it with the failure reported (3/3, Chess, 2026-10-09). The relay refuses a call whose
  action, or a `.then` chain off it, is neither awaited nor last (unit-tested for chains, 2026-10-12).
- The engine's service crashes now and then. `SkyComputerUseService` (26.1005.1001425) segfaulted 4
  times from 2026-10-05 to 2026-10-11, each time at address 0 inside its handler for WindowServer
  notifications, on the main thread: during benchmark runs on TextEdit and Calculator (3) and during
  a Codex `getApp` call with no sleight call in flight (1). The call in flight
  fails with "native pipe closed before response", and the service is back within seconds. We don't
  know what triggers it, and it is the engine's bug for every client. sleight sends a read that met
  the crash again once (unit-tested only). A call with actions isn't resent.
- The engine's helper can stop answering. On 2026-10-04 every `cua.getApp` timed out
  (`-10005 timeoutReached`) for about 25 minutes, with the Mac unlocked and in use, until ChatGPT was
  restarted. We don't know the cause. After two consecutive `timeoutReached` failures on standalone
  reads of one app, the relay checks target AX, another acquired app's AX and a fresh engine read of
  that control app. ChatGPT restart advice requires both AX processes to respond with windows and an
  actual engine control timeout.
- The AX check of the target app waits 0.5 s, which a busy Mac can miss. On 2026-10-09, with a load
  average of 101 from other processes, TextEdit, Safari and Calculator missed it in 5 of 5 probes and
  answered in 0.27 to 0.52 s with a 6 s deadline. sleight now probes once more with a 3 s deadline
  before calling an app hung (unit-tested, 2026-10-12).
- The 29.475 s first Calculator acquisition on 2026-10-09 spent 27.683 s inside the engine after
  approval. Browser discovery had already ended, so its removal does not explain or fix that wait.
- The helper can also fail to start. On 2026-10-05 it quit normally when doctor's session ended, and
  every later launch failed with "Sky Computer Use service startup request failed" for at least five
  minutes: launchd still held the old job and answered "Operation already in progress". Removing that
  job with `launchctl remove` fixed it at once, without restarting ChatGPT, and the next four helper
  launches worked. We don't know what left the job behind. Doctor and a failed call now print the
  command for the user to run.
- ChatGPT updates can break it. The version lookup handles the folder moving around, but not the API
  changing. Run `--doctor` first when something stops working.
- The engine has no access to an app's icon in the menu bar or to notification banners: its inventory has
  no Control Center or Notification Center, and `getApp("com.apple.controlcenter")` times out (engine
  26.930.31730, 2026-10-03). Nor can it acquire an app that lives only in the menu bar (`LSUIElement`):
  Codex's own computer use got `-10005 timeoutReached` after 5 to 6 s on 2 of 2 `getApp` calls on
  OpenUsage (2026-10-11), with sleight not involved. sleight's `menu_bar` and `notifications` tools
  cover those instead (see [How it works](how-it-works.md)), and a `getApp` timeout on a
  menu-bar-only app points Claude to `menu_bar` at once. They work in the foreground: an open menu shows on screen and takes
  the keyboard until sleight closes it. Icons that open a SwiftUI window (`MenuBarExtra` in window
  style) ignore the accessibility press, so sleight clicks them for real and puts the pointer back.
  Controls without a label, tooltip or identifier get names such as `Button at (10, 20)`, measured
  from the window's top-left corner, or `Button 3` if AX has no position. Their element numbers
  remain the arguments to `press`. The fallback names and press mapping have unit tests; an
  unnamed live popover button has not been checked with an approved app.
- Exact window selection is unavailable on macOS. Engine docs say `getApp({ windowId })` is for Linux
  and Windows; macOS takes an app name, path or bundle ID.
- The native guard still needs full AX reads after preceding actions. On 2026-10-08, Calculator reads
  after Escape took median 413 to 437 ms, against 29 to 48 ms idle.
- Literal numbers only: a call that computes an element number is refused in that state.
- Same-title replacement of a window cannot be detected (the engine doesn't give window ids).
- `/sleight stop` collects owned engine and helpers, then leaves the shared computer-use helper running.
- The engine keeps two keyboard event taps ("ChatGPT Computer Use") from its first key action until
  its process exits. Measured 2026-10-10 on engine 26.1007.21159 with Calculator: a turn end didn't
  remove them within 30 s, with or without `js_reset`.

## Specific apps

- Slack, Firefox and WhatsApp expose thin engine trees (2026-10-10, one read each, no input):
  Slack 15 elements and 483 characters, Firefox 24 / 898, WhatsApp 19 / 940. None of the three had a
  text field, and Discord wasn't thin (251 elements). Whether a settings switch expands them is unverified.
- A Save or Open sheet showing a folder with many items reads as a very large tree: 198 file rows
  made one read of TextEdit's Save sheet 57,000 characters (2026-10-10), past Claude Code's tool
  output limit, so Claude saw only a pointer to a file, and every guard read of it took 1.4 to
  2.3 s. The benchmark now moves runs older than 6 hours out of its folder. Engine 26.1007.21159
  still has no root, depth, filter or element-query on `getAXState`, so a read that leaves out the
  browser rows is unbuilt. Filtering the text after a full walk would not cut the walk. Under `SLEIGHT_RESULT_TRIM=1` sleight
  drops long runs of sibling rows from such a result (A/B not yet run).
- Go to Folder in a background TextEdit's Save panel puts TextEdit's windows over the user's window
  for about 0.4 s (owner's report and a window-order capture, 2026-10-11: 05:23:13.249 to 13.680 UTC).
- Electron apps build their Accessibility tree some seconds after launch: a raw walk of Discord 12 s
  after `open -g` found 11 nodes, and one after the engine's read found 509, with
  AXManualAccessibility and AXEnhancedUserInterface still off (2026-10-11). A read right after a
  launch can see an almost empty window. `SLEIGHT_LAUNCH_REREAD=1` reads once more after 2.5 s (A/B
  not yet run).
- Finishing a File > Open panel brought TextEdit to the front for about a second in 3 of about 21
  textedit-edit runs while the owner worked (2026-10-10, WindowServer log).
- In a TextEdit typing probe on 2026-10-08, select-all followed by `typeText("engine01")` and save
  left `Engine01engine01` instead of replacing the text. Part of it is macOS auto-capitalization.
- TextEdit hung 3 times on 2026-10-05, each time after Claude set a document's text with `setValue`
  and then pressed a save shortcut. Its main thread waits forever on the document's save lock. The
  skill tells Claude to select and type in TextEdit instead of using `setValue`.
- On 2026-10-06 TextEdit timed out every engine read after an AppleScript `close every document
  saving no`. It still answered AppleScript, but its only window was an orphan "Save Panel Accessory
  View" that Accessibility didn't list. A read now identifies a possible orphan when macOS lists only
  that title and the probed app has zero AX windows. Reproduced on 2026-10-11 through the engine:
  the next engine read didn't time out, so the orphan alone doesn't explain the 2026-10-06 timeouts.
- In the iPhone simulator (2026-10-07), Claude's paste fallback inserted other text: the simulator
  shares the Mac's clipboard.
- On 2026-10-09 the owner's keyboard stopped working, while the trackpad still did, after a
  head-to-head pass ran the simulator task on both arms. Device Hub, left open after those runs,
  held a keyboard event filter tap whose last key had taken 40 s, and a filter tap holds up every
  key on the Mac. Quitting Device Hub fixed it at once. When a turn ends, sleight now names any app
  it acted on in the session that holds a keyboard filter tap, once per session.
- On 2026-10-11 the engine's read of the owner's Helium (one process since 2026-10-10, about ten
  windows) timed out twice with `-10005 timeoutReached`, 30 s and 60 s. The input lease needs that read
  before `cua.getBrowser`. Whether the window count causes it is unmeasured.
- iPhone Mirroring (2026-10-11, one owner-present run): `app.scroll` at 0.3, 0.6 and 1 page left
  the Settings list unmoved (3 tries). sleight now turns `scroll` into a swipe on a window whose tree
  is only chrome (unit-tested, 2026-10-12). A tap during a page animation opened Personal Hotspot instead of General.
  The tree is the Mac window and menu bar, so the engine's settle wait cannot see the iPhone screen.
  After an action in an app whose tree is window chrome only, the relay waits for two matching
  screenshots, up to 1.5 s, and records the wait in the trace. Unverified: live
  `iphone-mirroring-settings` ×3 with no tap outside Settings > General > About.

## Hosts and platform

- The desktop app's command picker still says "/sleight isn't a command here", though the mod handles it.
- It's macOS on Apple Silicon only. The engine's JavaScript has Linux and Windows instructions, but
  the helper that clicks and types comes only with the Mac ChatGPT app, and there's no ChatGPT desktop
  app for Linux (checked 2026-10-04). We haven't checked the Windows app.
- Cursor and generic MCP clients can use sleight's native approval panel and idle turn cleanup
  (unreleased). The panel shows the client's name (Cursor) in other
  hosts and Claude under Claude Code. It is unit-tested only: no live approval in another host has been
  checked. Unanswered relay forms expire after five minutes.
- A name lookup can still launch an app that exited between the native check and `getApp`.

## Desktop replay

- Recording only supports initially empty TextEdit fields, and checks using constructed events do not
  prove app notification delivery.
- A pane replay is untested in Auto mode, where the classifier may refuse the mod's `replay` call
  because the mod doesn't approve it (the classifier refused the pane's snapshot on 2026-10-08).

- `sleight.pickFromList` throws "needs a browser tab" on a real browser tab: it calls `tab.scroll`, which the engine's Tab doesn't have.
  Its search also gives up before rows past about index 360 of a 1,000-row virtualized list. Found 2026-10-12 with real Playwright on
  FowlBrowser's travel page. The fix is in progress.
- After a kernel reset, sleight restores `tab` and `b` only for calls whose source it can parse: 87 of 403 recorded browser calls (21.6%)
  aren't tracked, and a name the call assigns isn't restored.
