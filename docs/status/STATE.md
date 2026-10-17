# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-17 15:45 UTC)

Goal (owner): release 1.3.0, then the native claim and the video. No shortcuts on the claim (owner, 2026-10-17): every fix the
live runs surface lands before sleight's final claim run, then the tag (ROADMAP 1b). The owner shut Puddle down at ~14:37Z and gave
sleight the Mac. Build lanes today are Claude subagents, Opus high for builds, Sonnet high for reviews (owner, 2026-10-17); Codex
lanes already running finish where they are.

**Merged and pushed** (`d4755720`, full check 6,603 tests, 0 fail). WD1 fixes the window-drag grader. DG1 with DG1R adds drag by element or
selection. IT2 with IT2R (before typing after a field click, read the engine's focused-element line; a different focused element
stops the call with a setValue hint; replayed on 15 real cases, 11 allowed, 4 stopped, all true mismatches). FL1 with FL1R (repeated
notices don't mention an API, folds only where the document exposes text, and the screenshot hint shows once per window). HY1B to HY1E (pass hygiene: closes
only windows that appeared in touched apps, quits what it launched, never answers a prompt, snapshots only between tasks, temp
sweep, 7-day screenshot retention). claude-cu fixes through `2e1c` and `5d4144f1` (tool search on, card parser).

**Building.** CUVT (Opus): a virtual terminal for the claude-cu arm; live runs at 15:23 and 15:25Z reached the approval card and
pressed Down, then lost the card because Claude Code redraws by cursor moves (raw tail in `sitting-1017c/approval-block-cu4.json`).
XD1R (Opus) fixes what XD1's review found in the cross-window drag. Its probe had sent Apple events to TextEdit. XL1B (Codex): the Excel tab-reorder
post-check and its probe. Then: XD1 and XL1 probes live, claude-cu live, sleight's final claim run, competitor top-ups, the claude-cu
claim run, the browser race, the release pass and the tag.

**Live results today** (`~/Projects/sleight-wt/sitting-1017b/`, `sitting-1017c/`): the flag A/B and the per-flag Office runs (n=3,
pre-FL1 build). RB1's fold made word-edit ~40% slower (99, 133, 118 s against 48, 91, 82); SK1 alone ran excel-edit at 50 to 53 s
(no flags: fail, 79, 61). SH1 and CP1 are within noise. No flag becomes a default yet; SK1 on Excel is rechecked in the final claim
run. textedit-window-drag, graded for the first time, failed 0/2: sleight had no cross-window drag (XD1). IT1's 250 ms wait didn't
fix field focus (replaced by IT2).

**The native claim** (9 tasks in bench/claim-tasks.txt; `node bench/claim-score.mjs`, exclusions in bench/claim-exclusions.json).
Competitor rows are from 2026-10-17 04:03 to 06:54Z. sleight on the newest build is fastest on 6 of 9, expected seconds against
the best other arm: calculator-click 10 (lcu 11), calculator-menu 12 (lcu 15), textedit-drag 67 at 2/3 (nobody else passes),
finder-move 31 (Codex 40), word-edit 85 at 3/3 (lcu 120; it was 509 at 1/3 on the build before), excel-edit 110 (Codex 136).
It loses textedit-save 14 (lcu 11, with one run at 21.9 s and the others at 8.8 and 10.7), preview-read 7 (Peekaboo 4, lcu 6) and
textedit-calculator 40 (lcu 33, with runs of 39.7, 25.2 and 53.6). Against the build before, calculator-click (7), textedit-save (11),
textedit-drag (44, 3/3) and textedit-calculator (31) got slower, within these tasks' run-to-run spread at 3 runs.
sleight is the only arm with a time on all 9 (lcu, Codex, Cua 8/9, Peekaboo 4/9), so its total is lowest. "Fastest" also needs 5
runs where sleight and an arm are within 20% (calculator-click, preview-read against lcu, textedit-calculator, and borderline
calculator-menu, textedit-save, excel-edit), so today's wording is "completed every task, fastest on 6 of 9". The post discloses that
the suite is sleight's own and which claim-task traces its fixes came from. Competitors ran defaults, and Codex runs gpt-6-luna.
Claude's own computer use hasn't run (item CU1), so the claim isn't complete. No post has gone out, and the film waits (owner).

**Opt-in flags** (not defaults): `SLEIGHT_WARM_ENGINE=1`, `SLEIGHT_OPEN_FAST=1`, `SLEIGHT_OPEN_SHOT=1`, `SLEIGHT_SKILL=screenshot`,
`SLEIGHT_COMPACT_TOOLBARS=1`, `SLEIGHT_COMPACT_CONFIRMATIONS=1` (wording approved by the owner). WARM_ENGINE and OPEN_FAST saved
~1 s per task with no downside seen (Fable); they become defaults with the final claim build unless the claim run says otherwise.

**Studies of 2026-10-17** (reports in that session's transcript; scratch folders kept):
- Fable, preview-read (`/private/tmp/claude-501/fable-why/`): with only a text tree, Haiku spends ~160 turn-2 thinking tokens
  checking it; a matching screenshot took that to 0 in 5/6 replays, output 478 to 312 tokens. SH1 follows from it.
- Fable, token audit (`/private/tmp/claude-501/fable-audit/`): on 8 of 9 tasks Haiku with sleight already uses fewer turns and
  less thinking than any Claude competitor. Largest costs per suite pass: document text the tree doesn't expose, with no screenshot
  path (~33 s, word-edit), big ribbon results (~31 s, correlational), recovery turns (~14 s), drag coordinates (~10 s), the 5.9 KB
  confirmations policy (~8 s). Items SK1, RB1, RF1, DG1, CP1.
- Fable, engine input (`/private/tmp/claude-501/fable-input/`): the engine posts events to the app's pid and doesn't set focus.
  Word typing goes to the body because Office's field takes focus after the click returns (high confidence). Excel's tab swap is a
  stale mouseDown after the rename (medium). Item IT1, plus a live probe (a balancing leftMouseUp before the tab click, 3 runs).
- Fable, claude-cu arm (`/private/tmp/claude-501/fable-cu/`, live.mjs written, not run): the arm's DISABLE_TELEMETRY/DO_NOT_TRACK
  turn off the flag that creates the computer-use server, and the prompt gate regex misses a placeholder. The owner approved the
  harness pressing the app card for allowlisted apps (LAWS, 2026-10-17). Item CU1.
- HID idle (overnight): engine clicks left it untouched in 10 of 10, and keys can reset it. Navigation by key can still stop.

- Fable, categorical flag rule (A/B traces): any repeated notice naming `disableDiffing` pushed Haiku into disableDiffing reads plus
  sleeps; the ribbon fold fired only on Word/Excel and hid where they act, and the hint repeated on Excel results. Built as FL1.
- Fable, cross-window drag and Excel tabs: XD1's design (toWindowId, three paths, per-window guards, a 4-variant probe). In 10/10
  runs a tab click right after a rename dragged the clicked tab to the end, which refutes the stale-mouseDown theory. Built as XL1.

**Queued, not started:** none. Items live in `~/Projects/sleight-wt/ledger/queue/tt/`. Run `ls ledger/claims` before reusing an ID.

**Owner items.** Decide on publishing once claude-cu and the browser race have run. The turbo live check before the tag. Leftover
windows from today's testing were cleared (Mail and Terminal quit on the owner's OK); the Microsoft Error Reporting window is theirs
to read or dismiss.

**Gotchas from 2026-10-17.** Never send Apple events to Office from this session (Excel had no Automation grant and a macOS prompt
appeared). Quit fixture apps with NSRunningApplication and answer their own Don't Save sheet or dialog by System Events. An
AX-opened menu loop releases with one Escape posted to the pid. Finder fixture windows left open held Finder at ~99% CPU for
hours, so close them after Finder passes. A leftover Calculator blocks Calculator fixture setup.

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
