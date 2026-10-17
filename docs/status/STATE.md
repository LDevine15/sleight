# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-17 11:40 UTC, owner preparing a clear; three Fable studies and two lanes in flight)

OWNER ASLEEP since 2026-10-17T02:19:48Z (/goodnight). Night Shift on. Read "vaya con dios" after the boot report's "waiting for
your go" as the go, and pinged the phone with that reading. At the owner's request (from bed), sleight-arch closed the two
Microsoft Error Reporting dialogs with their restart boxes unticked first, so neither Word nor Excel restarted.

Goal (owner): release 1.3.0, then the native claim and the video, then maintenance and benchmarking (owner, 2026-10-16: "I don't
want to work on sleight forever"). ROADMAP.md is the plan. Read it whole, especially 1b and 2.4.

**The overnight sitting** (Puddle window w-overnight-1017, HOLD sent 02:36:22Z, cap 420 min, auto-release about 09:36Z; release
earlier with one fresh touch of `/tmp/sleight-bench-done`). Scripts and logs in `~/Projects/sleight-wt/sitting-1017/`.
1. Done: HID idle. Engine background clicks left it untouched in 10 of 10, as menu continuation assumes. Keys reset it:
   `typeText` 3 of 3, `pressKey` 3 of 3 right after a click and 0 of 4 right after a key. Navigation by key can still stop. The
   CHANGELOG navigation entry and known-problems say so (`hid-probe.mjs`, `hid-probe.json`). textedit-drag and chess-drag run
   inside the A/B instead of a separate check.
2. Done: the A/B (since `2026-10-17T02-41`, `bench/ab-score.mjs` output in `sitting-1017/ab-score.txt`). Claim tasks: new 22/24
   passes in 272.6 s summed per-task means against old 20/23 in 319.0 s, 74 turns against 84. Outside the claim suite: new 19/25
   in 395.3 s against old 19/23 in 461.9 s. Paired round totals: -99.5 s, -167.7 s, +90.0 s (round 3's new side ran 4 more tasks).
   Both sides lost runs to the harness: the two-window fixture's cleanup stopped a pass on each side ("Owned document lost focus"),
   and Word was left stuck in an AX-opened menu loop (old side, round 3).
3. Done: triage (two Sonnet-high trace reads of every new-side failure). One sleight regression: TT3's endpoint check refused every
   Chess drag on the board's right half, because Chess reports parent frames that miss the point. Fixed in `1933db78` (2 tests
   failed first, a review's text-field hole fixed too, full check 5,879 tests exit 0) and checked live: chess-drag 2/2, with the
   drag that was refused before now delivered in the background. excel-edit's failures are an Excel tab reorder after a rename
   (also seen before both builds; known-problems), finder-rename and finder-create-folder were model variance. FC1 (`024c4c5a`,
   merged) makes the two-window cleanup close by the window's own button after a cold launch. It needs a live check.
4. Done 04:03 to 06:54: the native claim run on the release build (`since 2026-10-17T04-03`, score in
   `sitting-1017/claim-score.txt`). Expected seconds to a correct result (passes/runs), 5 runs where sleight and an arm were
   within 20%:

   | task | sleight | lcu | codex | cua | peekaboo |
   |---|---|---|---|---|---|
   | calculator-click | **8** (3/3) | 11 (3/3) | 13 (3/3) | 40 (3/3) | 24 (3/3) |
   | calculator-menu | **11** (3/3) | 15 (3/3) | 68 (1/3) | 40 (3/3) | 43 (3/3) |
   | textedit-save | 12 (5/5) | **11** (5/5) | 21 (3/3) | 541 (1/3) | never (0/3) |
   | textedit-drag | **38** (3/3) | never | never | never | never |
   | finder-move | **38** (5/5) | 154 (1/3) | 40 (5/5) | 66 (3/3) | 76 (1/3) |
   | preview-read | 6 (5/5) | 6 (5/5) | 8 (3/3) | 7 (5/5) | **4** (3/3) |
   | textedit-calculator | 47 (3/3) | **33** (3/3) | 58 (3/3) | 77 (3/3) | never |
   | word-edit | **82** (3/3) | 120 (3/3) | 137 (2/3) | 733 (1/3) | never |
   | excel-edit | 153 (2/5) | 150 (3/5) | **136** (4/5) | 331 (2/3) | never |

   sleight completed 9/9 tasks (lcu, codex and cua 8/9, peekaboo 4/9), has the lowest expected time on 5 of 9 and the only
   finite total (395 s), which meets the LAWS rule for "fastest" on this suite. Disclosures owed with it: the suite is sleight's
   own, skill fix `14327dd4` was tuned on claim-task failures, competitors ran their defaults, and Claude's own computer use
   (claude-cu, needs the owner present) hasn't run, so the claim isn't complete. excel-edit losses are the Excel tab swap
   (sleight 3 of 5 runs, lcu too). The harness stopped competitor passes five times after results were recorded (Word or Excel
   left modified, two TextEdit processes from cua), and single-task reruns finished each (`cua-rest.sh`, `fill.sh`,
   `peekaboo-rest.command` from Terminal). cua's first stopped pass is excluded in bench/claim-exclusions.json. At 04:42 an
   Apple-event quit of Excel raised a macOS prompt ("claude wants access to control Microsoft Excel"). It was left unanswered and
   closed by itself once Excel quit. Office now quits through NSRunningApplication, then Escape and Cmd+Q posted to its pid, then
   its own Don't Save sheet or dialog.
5. FC1's live check failed (07:00, textedit-two-windows): the second fixture's lease is "already-running" in the TextEdit the
   first lease launched, so it took the File-menu path and refused on lost focus. FC1R carries the run's launch receipt (pid,
   bundle, process start) to later leases, and the live recheck passed 3/3 with no cleanup stop (merged, full check 5,893 exit 0).
6. Firefox gate: the dry run plans 12 tasks (mobile and takeover not supported). The live round stopped before launch because the
   world sleight arm isn't logged in (owner items). Checkout `~/Projects/sleight-wt/br2c-live`.
8. Owner (morning): make sleight win preview-read, textedit-calculator and excel-edit. Sonnet-high trace studies found:
   - preview-read: sleight's first result is 24,849 chars, 17,355 of them the engine's own API docs passed through, against
     Peekaboo's 4,628 plus an image. Turn 2 takes 1.96 s against 1.30 s. Holding the docs back estimates about 0.65 s.
   - textedit-calculator: runs 1 and 3 lost about 8 and 19 turns to sleight's own results. A cross-app stop that didn't say the
     Copy already ran, select_window's exact-line handshake, a deadlock where the relay refused the menu Cancel its own text
     advised (open menu header has no URL), and a false "saved: not confirmed (mixed save targets)" that also cost textedit-save's
     slow run.
   - excel-edit: all 3 failures were the tab swap from clicking Inventory after the rename. RW1R's note would have fired on none
     (a click-only gate, and the tabs' parent line changes with the active sheet). Codex and lcu passed by never clicking the old
     tab or by repairing the order with Move or Copy.
   Lanes PR1 (docs held back until the first js call), TC1 (stop message, select_window, menu Cancel, same-window menu) and SW1
   (save classification, swap note on RW1R) are running. Then review, merge, full check, and a sleight-only claim rerun (LAWS:
   a sleight fix round reruns only that arm).
11. In flight at the owner's clear (no new subagents after these, owner):
   - Fable study A (a6fc500f): why the claude-cu arm doesn't call tools, and whether its approvals can come from the allowlist.
     Told to wait for "go live" before any live session, and it may ask. Scratch /private/tmp/claude-501/fable-cu/.
   - Fable study B (a4434178): token and turn waste across all 9 claim tasks, replays only. Scratch /private/tmp/claude-501/fable-audit/.
   - Fable study C (aa709f2d): how the engine delivers background clicks and keys, the cause of Excel's tab swap and Word's
     misplaced typing, offline (Ghidra at nice 20). Scratch /private/tmp/claude-501/fable-input/.
   - Lanes SH1 (screenshot with open_file's first read, flag SLEIGHT_OPEN_SHOT=1) and JD1 (every tool description under 2,048
     chars; Claude Code truncates sleight's js description from 3,511) on codex/sh1 and codex/jd1. Review, merge, full check.
   - Puddle window w-flagab-1017 (cap 75) queued behind Puddle's own measurement (~11:50Z): sleight-only claim rerun on the new
     build (exclude sleight's 10-25 to 10-51 rows first, by file prefix with arm sleight), then an A/B of SLEIGHT_WARM_ENGINE=1,
     SLEIGHT_OPEN_FAST=1 and SLEIGHT_OPEN_SHOT=1 on preview-read, calculator-click and textedit-save. If nobody is ready at the
     HOLD, release it with a fresh touch of /tmp/sleight-bench-done and tell puddle arch.
   - The first Fable study (preview-read): the extra thinking comes from text-only results. Haiku checks the tree when it is the
     only source. A consistent screenshot took turn-2 thinking to 0 in 5/6 replays (output 478 to 312). Its harness is in
     /private/tmp/claude-501/fable-why/.
   - Merged since the rerun (full check 6,247 exit 0, pushed at `7909da1d` plus CHANGELOG): WM1/WM1R stuck-menu and misplaced-
     typing warnings, PW1/PW1R opt-in latency flags, BR2S/BR2SR Safari gate (refuses on any window without profile evidence. A
     fresh Safari likely opens a default window and refuses, and the read-only probe needs a Safari with no owner windows).
10. Fix round merged (PR1+PR1R docs held for open_file, TC1+TC1R stop wording and select_window and menu Cancel and
   handle-bound reads, RW1+RW1R+SW1+SW1R save classification and sibling-swap note, then `5a6ba6c0` narrowing the swap note's
   sort guard after Excel's ribbon "Sort & Filter" hid it), each reviewed by Sonnet-high agents, full check 6,191 exit 0.
   sleight's arm reran in Puddle window w-rerun-1017 (10:25 to 10:59Z, released early). Pre-fix sleight rows are excluded in
   bench/claim-exclusions.json (window exclusions can now name one arm). Score (`sitting-1017/claim-score-rerun.txt`): sleight
   fastest on 6 of 9 (calculator-click 7, calculator-menu 12, textedit-drag 44, finder-move 34, textedit-calculator 31 against
   lcu 33, excel-edit 89 at 4/5 against Codex 136), textedit-save tied with lcu at 11, preview-read lost (6 against Peekaboo 4),
   word-edit lost (509 at 1/3 against lcu 120). A study found word-edit's failures were model variance on two existing Word and
   engine behaviors (typing after a click landing in the body, and an AX-opened menu loop with no warning). WM1 (lane) adds both
   warnings. A preview-read study of Peekaboo's `see` is running. A leftover Calculator from the claude-cu test blocked the first
   Calculator setups, which were rerun.
9. Claude computer-use hook test (owner away, 09:19 to 09:26 UTC): inconclusive. In the native claude-cu arm (Claude Code
   2.1.289) Haiku 5.5 didn't call a tool in three tries, even when told to call ToolSearch first; the CLI also warns that
   "claude-haiku-5-5" isn't in its model catalog. The PermissionRequest hook didn't run. The arm itself needs fixing before the
   hook question can be answered.
7. Released the Puddle window at 07:03:52Z (fresh `/tmp/sleight-bench-done`), 2.5 hours early. The Terminal windows opened for
   the Peekaboo arm are still open, with their commands finished.

**The build is frozen** at `1933db78` for plugin code: `ef833641` plus the Chess drag fix. Since then only bench and docs
changed: FC1, FC1R, the browser gate (BR1 to BR2C) and FC2/FC2R, all merged at `047fd344` with the full check exit 0 on 6,056
tests. The CHANGELOG 1.3.0 section lists the fixes, and the A/B above is their first live measurement.

**In flight.**
- Merged after the sitting: the real-window browser gate (BR1, BR1F, BR1G for Chrome and Helium; BR2A, BR2B, BR2C for Firefox),
  each round reviewed by a Sonnet-high agent with its findings fixed test-first, and FC2/FC2R (fixture cleanup that discards only
  the run's own fixture document and quits only processes the run recorded). None is run live yet. BR2 went STALE for Safari, because
  Safari's WebDriver automation windows block the native input the other arms need (owner items).
- RW1 tells Claude when a click swapped two siblings (the Excel tab case). A review found it missed the engine's `Selected, `
  prefix and fired on deliberate sorts. RW1R fixed both (`private/codex/rw1r` `a7d292d4`, 767 tests). Plugin code, so not
  merged: after the tag unless the owner pulls it in, then an A/B on excel-edit.
- Lane launch command: `nohup codex exec -m
  gpt-6.1-sol -c model_reasoning_effort=high -c sandbox_workspace_write.network_access=true -C ~/Projects/sleight-wt
  --skip-git-repo-check --add-dir ~/Projects/sleight --add-dir ~/Library/Caches --add-dir /private/tmp --add-dir /tmp - <
  ledger/lane-runs/prompt-<id>.md`, with the prompt made from `prompt-tt4.md` by replacing TT4 and tt4.
- Not ours: PID 41395, a read-only `codex exec` started 2026-10-16 01:46 local. Leave it.

**Browser decisions (owner, 2026-10-17, in LAWS and ROADMAP).** Browser tasks race only turbo, so the native claim suite is 9 tasks.
The headline "fastest plugin on macOS" needs the real-window race against lcu, Cua, Peekaboo and Codex in Chrome and Helium (BR1),
plus Safari and Firefox (BR2), before the launch post, not before the tag. Brave 155.1.97.56, Edge 155.0.4283.45, Vivaldi
8.2.4133.84 and Chrome Beta 157.0.8103.6 were installed by Homebrew cask for qualification and never launched. The studies found
Firefox turbo impossible without a relaunch flag today, and Safari's only fit is a hybrid behind Develop > Allow JavaScript from
Apple Events. Both are post-1.3.0 options.

**Where the claim stands.** Step 4's table (2026-10-17, release build) replaces the 2026-10-16 numbers. Fable's review
(2026-10-17) found skill fix `14327dd4` was tuned on the claim's own failures: say so in the publication, with the A/B's 11 tasks
outside the claim suite as the check (new 19/25 against old 19/23). Codex runs gpt-6-luna, not Haiku. Publish pass counts and
median-of-passes beside expected time.

**Release path.** Turbo live check with the owner (about 10 min; the release pass refuses the gate without it), then the slimmed
release pass, then the tag. The CHANGELOG 1.3.0 drag entry carries its live measurement. Turbo in `claude -p` never activates,
because the mod's `prompt.submit` hook doesn't fire there, and the gate measured turbo through a bench-only server
(`bench/turbo/v3-server.mjs`) on headless Chromium. BR1 adds the real-window race with a Codex arm.

**After the tag.** `arch/epv3-2` `2817c762` (EPV3-2, inert; EPV3-3 next in `ledger/electron-v3-plan.md`), `arch/epv3-1` `f9e1e919`
(consent run owed with the owner), `arch/q1-int` `c0aa885c` (Q1 error messages), the ghost hand (ROADMAP 2.7; LoC's architect has the
design request queued), the speed items in ROADMAP 2.4.

**Video.** No film work until the claim is measured (owner). Storyboard `docs/design/video-storyboard.md`; LoC's draft paint round
waits on LoC trunk. Message "loc arch" when the claim run is scored.

**Owner items.** Read the claim table in step 4 and decide on publishing; Claude's own computer-use arm still has to run with you
present. Log in the world sleight arm once (opens a browser login), so the real-window browser race can run:
`env -i HOME="$HOME" USER="$USER" PATH="/opt/homebrew/bin:/usr/bin:/bin" CLAUDE_CONFIG_DIR="$HOME/.config/sleight-bench/world/arms/sleight/claude-config" "$HOME/.config/sleight-bench/world/arms/sleight/node_modules/.bin/claude" auth login`.
Pick Safari's isolation for its race. The one option found so far that native arms can drive is a Safari profile you make
once (Safari > Settings > Profiles), with Safari quit before each round as for Chrome. Then the turbo live check, EPV3-1's
consent run, each Chromium browser's qualification, and the tag.

**Machine notes from 2026-10-16.** Office was cleared by hand three times: arms leave Word or Excel behind dialogs (Find and Replace)
and a force-quit leaves a "Recovered" fixture. Before an Office window, check that Word and Excel aren't running, and close any
`Report-*` or `Inventory-*` recovered document with Word scripting (`close ... saving no`), never AX presses. Puddle gives 10-minute
gaps between windows and wants 15 minutes' notice before a long one. Its spin guard renices spinning waiters (nice 20).

How work runs. Sonnet-high agents build and review, and sleight-arch integrates and runs one full check per merge (`npm run check`,
with `PATH="$HOME/.local/bin:$PATH"` so `claude plugin validate` uses 2.1.289). Every real-page test needs `SLEIGHT_LIVE_DOM_TEST=1`.
Benchmark windows come from Puddle's architect. Ask with a length and a cap, start on "HOLD live", and release with one fresh
touch of `/tmp/sleight-bench-done`. The scripts in `ledger/claims/GATE2/` (gate5.sh with `REPO`, `SPECS`, `PREFIX` and `MODEL`) do the touch.

This session works in `.claude/worktrees/boot-sleight-arch-*`, because a hook refuses edits in the main checkout: commit there,
`git push private HEAD:pane/auto-mode`, then `git -C ~/Projects/sleight merge --ff-only <branch>`. A release also pushes
`HEAD:refs/heads/main` and the tag to `origin` with `SLEIGHT_RELEASE_PUSH=1` (owner's call), then `gh release create` from the
CHANGELOG section. Public CI is Linux, without `npm install`, on Claude Code 2.1.288. Released so far: `v1.2.0` to `v1.2.5`
(2026-10-11, public `main` `b2eb9d8`). The owner's install is 1.2.5. Public `origin/pane/auto-mode` stays at `332e3ca`.

Bench setup: every Claude arm runs on the owner's login in its own config (`node bench/world/login-readiness.mjs` reads all five
native arms as logged in, 2026-10-16). The gate uses `--world` (both arms on the pinned Claude Code 2.1.289). Hand-run arm CLIs need
`DISABLE_AUTOUPDATER=1`: an arm's updater most likely removed `~/.local/bin/claude` on 2026-10-16 (restored as a symlink to
`~/.local/share/claude/versions/2.1.289`). FowlBrowser's extension is unpacked in Chrome's "sleight benchmark" profile and in Helium.

The away-sitting tool reads its steps from the list below, pinned by hash in `bench/away-sitting.mjs`.
Its first step (live checks with the owner present) is older than the Next list above.

Next, in order:
1. Live checks with the owner present: lease-broker with Codex, unsaved-review, and track 0's
   background ones (scale note, orphan panel, recording, flow rule). The skill A/B rerun.
2. Then ask the owner for the one away sitting (owner: no partial windows), with the run order and
   length (about 75 to 90 min): the Codex head-to-head with clean arms and the owner's setup,
   textedit-drag, Chess with computed points, simulator-form x3, the save-lock experiment
   (`--delivery-check`, then the full run), select-all (`bench/small-fixes-textedit.mjs --quick`),
   live-checks-1-1 (`stale-number`, `menu-bar`), the shop smoke tasks, Best Buy (lease-select's live
   check), the quiet-box CPU comparison.
3. With the owner watching, run Mail, Mimestream and the chat tasks once each with `--owner-present`,
   and lease-select's Helium Console check.
4. If the gate is met, the full release pass and the release (ROADMAP 5b), including README's
   release-pass numbers, then update the owner's installed copy and confirm its `gitCommitSha`.

## Machine state outside the repo

- The native claude-cu arm root `~/Library/Caches/sleight-bench/claude-cu` (Claude Code 2.1.289, installed 2026-10-16) is logged in
  on the owner's account, with onboarding, folder trust and `/mcp` computer-use enabled in its `work` folder.
- `~/Library/Application Support/sleight/turbo.json` (0600, Helium, enabled) was written 2026-10-16 12:49 UTC by the dev build.
- The FowlBrowser world arm's pinned Claude Code 2.1.289 is at `~/.config/sleight-bench/world/arms/fowlbrowser` (installed
  2026-10-14 for the prototype rounds, `node bench/world/arms/install.mjs fowlbrowser claude-only @anthropic-ai/claude-code@2.1.289`).
- Benchmark arms installed 2026-10-14 (owner's 2026-10-12 OK, pinned with checksums). Cua 0.34.0 is at
  `~/Library/Caches/sleight-bench/mcp-cua-arm` (the grants are on CuaDriver.app itself). Peekaboo
  4.9.2 is at `mcp-peekaboo-arm`, and its grants go to Terminal.app (owner's pick), so Peekaboo passes run from a Terminal window. Runtime
  folders `~/.cua-driver` and `~/.peekaboo`. Removal steps are in each arm's setup plan (`bench/world/native-setup.mjs`).
- Playwright's Chromium 1248 and its headless shell in `~/Library/Caches/ms-playwright` (installed 2026-10-14 on the owner's OK)
  for real-page tests with FowlBrowser's playwright-core 1.64. Builds 1228 and 1234 are still there.
- Remote debugging is on in the Chrome "sleight benchmark" profile and in Helium (`chrome://inspect/#remote-debugging`, turned on
  by the owner 2026-10-13) for turbo's qualification. The owner turns it off on the same page.
- The Claude in Chrome arm's pinned Claude Code 2.1.289 (`~/.config/sleight-bench/world/arms/claude-in-chrome/node_modules`) was
  rebuilt with its install script approved (`npm approve-scripts @anthropic-ai/claude-code`, 2026-10-13). Its login is stored
  in that arm's `claude-config` (Max plan).
- `~/.codex/browser/config.toml` `[origins] allowed` holds `http://127.0.0.1:*` (owner's request, 2026-10-13), the engine's own
  store for "always" site approvals, read for every browser it drives. Backup: `config.toml.before-localhost-20261013T031052Z`
  beside it. Remove that line to undo.
- Daily launchd job `com.landoclusters.sleight-watch` (9:00, `scripts/watch.sh`), daily since
  2026-10-10 on the owner's OK because a competitor hinted at an engine change; weekly with
  `npm run watch:install`. It saves the engine's API docs, without sleight's skill since 2026-10-10
  (`~/Library/Logs/sleight/engine-api-26.1007.30912.md` is the latest), and diffs them on an engine
  update. Remove with `npm run watch:remove`.
- `~/Library/Application Support/sleight/preapproved.json` lists Calculator (owner, 2026-10-04), Helium (`net.imput.helium` and
  `Helium`, owner's order 2026-10-05, kept 2026-10-08) and five always-allow entries from the owner's clicks: `dev.zcode.app`,
  `com.todesktop.230313mzl4w4u92` (2026-10-11), `com.apple.ScreenContinuity`, `com.anysphere.sand`, `com.google.Chrome` (2026-10-12).
  The list before Helium is `.dev/tools/preapproved.before-helium.json`.
- `ComputerUseAllowForbiddenTargets` is on (`defaults write -g`, set by the owner 2026-10-05, kept on
  2026-10-08 so agents can drive terminals for tests). Terminals and OpenAI's apps go through the engine
  for every engine client, Codex included. Off: `defaults delete -g ComputerUseAllowForbiddenTargets`.
- `.dev/tools/`: probe and timing clients for sleight's launcher, the CNN trial, transcript
  dumpers, and `dialogs.swift` (lists permission dialogs on screen).
- LCU 0.11.2 runtime-only at `~/.local/share/lcu` (installed 2026-10-10 on the owner's OK, with 0.8.8 kept
  in `releases/`). The benchmark's arm is `~/Library/Caches/sleight-bench/lcu-arm`, made by
  `node bench/lcu-arm-setup.mjs`.
- Chrome profile "sleight benchmark" (account-less, made by the owner 2026-10-12 18:40 EDT) holds Claude in Chrome, signed in
  with the owner's Claude account, for the benchmark's Claude in Chrome arm. Never drive the owner's main Chrome profile.
- REA (`rea-agents` 6.4.0, CLI only, `npm install --global`, no `rea setup`, so no agent configs changed) and Homebrew `ghidra`
  12.1.4 with `openjdk@21`, on the owner's OK (2026-10-12). `~/.zprofile` exports `GHIDRA_INSTALL_DIR`. Hopper and IDA aren't
  installed. Clean-room rule in LAWS.
- Homebrew: `vale`, `ffmpeg`, and the `codex` cask 0.160 (0.153 rejected gpt-6.1-sol).
  `~/.local/bin/claude` 2.1.289. The desktop app's Code tab offers Claude Code 2.1.288 (checked
  2026-10-06).
- Xcode 27 at `/Applications/Xcode.app` (xcode-select still points at the Command Line Tools, so
  `simctl` needs `DEVELOPER_DIR`; `bench/tasks.mjs` sets it). The iOS 27.0 simulator runtime (8 GB)
  was downloaded on the owner's OK, 2026-10-07. Xcode 27 shows simulators in DeviceHub, not
  Simulator.app. DeviceHub also lists the owner's own iPhone, so crop it out of any capture.
- `.dev/passes/`: the pass scripts (`pass-one.sh <name>` runs one full pass under `nohup`) and logs.
- `~/.codex-bench`: the Codex arm's home, with the owner's bench login (2026-10-08) and a config with
  only the engine server. During a pass with the Codex arm, the runner sets ChatGPT's "Always allow"
  list to the benchmark apps (owner's OK, 2026-10-09) and restores it on exit; a killed runner leaves
  it changed, so restore from the newest `~/Library/Logs/sleight/ComputerUseAppApprovals.before-*`.
  The list holds 6 apps of the owner's (TextEdit among them, written 2026-07-26).
- `~/Library/Caches/sleight-bench/keyboard-taps`: compiled from `bench/keyboard-taps.swift`, lists
  keyboard filter taps. The runner builds it if missing.
- The watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1007.71326 (checked 2026-10-14).
- `~/.config/sleight-bench/anthropic-api-key` (0600): the owner's API key for benchmark runs
  (2026-10-10). Spend ledger: `~/Library/Logs/sleight/bench-api-spend.json`.
- `.git/hooks/pre-push` (shared by every worktree): refuses pushes to the public repo without
  `SLEIGHT_RELEASE_PUSH=1`.
- `~/Library/Caches/sleight-bench/runs-archive`: benchmark runs older than 6 hours, traces kept.
  `~/Library/Caches/sleight-bench/swift-module-cache`: the shared module cache for helper compiles.
- `.dev/passes/front-watch.sh`: logs every frontmost-app change during a pass.
- `~/Library/Caches/sleight-bench/sleight-arm`: the benchmark's sleight arm folder.
- Scratch clients are gone after the clear. A relay probe: `bench/double-keys-client.mjs`
  (`probeClient`, `relay: true`, and `relayOptions: { changeReview: false, spaceProbe }` to match the
  launcher, whose change review is off by default while the library's is on).
- `.dev/` (untracked): test CLI, old `sleight-arm` and `lcu-arm` bench folders, `DragProbe.app`, the
  compiled `textedit-drag-fixture`, pseudo-terminal harnesses, research, prompts.
- Direct drag test: open a temp file with `open -g -a TextEdit`, run
  `.dev/textedit-drag-fixture <path> select-drag`, run `.dev/tools/drag-direct.mjs` with the from/to
  points and window id, then `<fixture> <path> read`. Use `select-drag`, never `select`: plain
  `select` drops in the title bar.

## Waiting on the owner

- Safari fixture windows, Preview `Pages-*.pdf`, Word and Excel fixture documents were left on
  their screen on 2026-10-09. Check the iCloud TextEdit files only by exact content, never by browsing.
- The OpenAI key note is theirs to handle. Don't raise it again (owner, 2026-10-09).

## Reading list

- `docs/status/ROADMAP.md`: everything we intend, in order. Any correction from the owner about the
  plan is written there in the same turn, and a question about the plan is answered from it whole.
- `README.md` for install and the pitch; `docs/how-it-works.md`, `docs/known-problems.md`,
  `docs/settings.md` and `docs/benchmark.md` for the rest.
- `CLAUDE.md`: checks and writing rules.
- `plugins/sleight/lib/relay.mjs`: the relay, with the reasons for each thing it adds.
- `plugins/sleight/lib/drag.js`: background and foreground drag paths and their guards.
