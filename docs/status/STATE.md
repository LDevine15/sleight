# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-17 16:55 UTC, flushed before the owner's clear)

Goal (owner): release 1.3.0, then the native claim and the video. No shortcuts on the claim (owner, 2026-10-17): every fix the
live runs surface lands before sleight's final claim run, then the tag (ROADMAP 1b). The owner shut Puddle down at ~14:37Z and gave
sleight the Mac (Puddle's leftover hold-setter, pid 92090, was stopped and noted in its window log). Build work today ran as Claude
subagents, Opus high for builds and Sonnet high for reviews (owner, 2026-10-17). Nothing is running at the clear: no lanes,
agents, monitors or live runs.

**Pushed:** `pane/auto-mode` on `private` is this branch's newest commit (see `git log -1`). Full check before the flush:
see the commit message. Everything below is in it.

**Merged today** (each with Sonnet-high review rounds): WD1 (window-drag grader), DG1+DG1R (drag by element number or text
selection; replays of selection or line-end drags need `--allow-positions`), IT2+IT2R (before typing after a field click, read the
engine's focused-element line; a different focused element stops with a setValue hint), FL1+FL1R (repeated notices don't mention an API,
folds only where the document exposes text; screenshot hint once per window), HY1B-HY1E (pass hygiene, which closes only windows that
appeared in apps the pass touched and quits what it launched, never answering a prompt; snapshots only between tasks, temp sweep, 7-day
screenshot retention), XD1+XD1R (`drag` with `toWindowId`: AX two-area move that confirms B before cutting A and rolls B back,
then posted drag, then foreground), XL1B+XL1R (a note when a click moves the clicked sibling), the menu-continuation splitter half
of LA1 (`20155db3`), and OPEN_FAST on by default (=0 for A/B baselines). WARM_ENGINE stays opt-in: as a default it timed out
tests/lease-launcher.test.mjs's stop-then-lazy-start test (20 s), possibly a real hang after `/sleight stop`, so find why first. LA1's in-call lease adoption failed two
safety reviews (it could type into a window it didn't verify) and was dropped; branches `arch/la1`, `arch/la1r` stay on `private`
for reference only.

**claude-cu arm works** (first full claim pass 15:51-16:21Z, 9/9). Its harness fixes, in order: tool search left on and the task
sent 2.5 s after the computer-use connect line; a virtual terminal (`bench/world/arms/claude-cu/terminal.mjs`); card matching
whitespace-insensitive; Down and Enter in one write (Claude Code resets the select to Deny on re-render); the hook's real tool
names; a false dialog stop on Claude's own prose fixed; the PreToolUse hook records the request_access reason and apps
(`access-<session>.json`) so an unboxed reason line is admitted only when it matches and the card's apps must be the requested
ones; textedit-calculator grants the clipboard, Finder tasks grant fileAccess. The claude-cu arm hides other apps while it works
(Claude Code's default). The owner OK'd quitting a Continuity Camera onboarding overlay (`ContinuityCaptureOnboardingUI`) that sat
over Calculator.

**Claim score** (`node bench/claim-score.mjs --results ~/Projects/sleight/bench/results`, saved in
`~/Projects/sleight-wt/sitting-1017c/claim-score-cu.txt`, exclusions committed with reasons). Expected s (passes/runs):
sleight on the 11:53 build is fastest on 5 of 9: calculator-click 10, calculator-menu 12, textedit-drag 67 (claude-cu 71),
finder-move 31 (claude-cu 39), word-edit 85 (claude-cu 102). It loses textedit-save 14 (lcu 11), preview-read 7 (Peekaboo 4),
textedit-calculator 40 (lcu 33) and excel-edit 110 (claude-cu 54). Lowest total: sleight 376 against claude-cu 476; every other arm
fails a task. Claude CU per task: 15, 30, 104, 71 (2/3), 39, 16, 45, 102, 54. The 5/9 is thin, and the final run's result sets the wording.

**Next, in order (all live work needs the owner away):**
1. sleight's final claim run on this build, 9 tasks with 5 runs where any arm is within 20%. After it come the competitor top-ups to 5 runs
   (lcu on calculator-click, textedit-save, preview-read and textedit-calculator, and Codex on excel-edit). Run with `claim.sh`'s pattern
   (`~/Projects/sleight-wt/sitting-1017c/claim-cu.sh` is the copy with the exit-code fix, with repo set to the main checkout).
2. The Excel probe (`CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/xl1-probe.mjs --live --owner-away`): its
   16:27Z run stopped on "Foreign or ambiguous app window"; `b1c4292b` adds a window diagnostic and path-tolerant cleanup, not yet
   run. Its result picks how to prevent the tab swap (arm D, an AX press, is the likely categorical fix). Excel is the biggest gap.
3. The cross-window drag probe (`node bench/xd1-probe.mjs /private/tmp/<results>.json`): its 16:48Z V1 trial moved nothing and its
   cleanup went unconfirmed; results in `/private/tmp/sleight-xd1-results-1017.json`, fixtures kept in
   `/private/tmp/sleight-xd1-probe-2C5gFp`. The stale live lock it kept was removed at 16:52:16Z (no process held it).
4. On finder-move, Fable found sleight thinks 2.3-4.1K tokens per run against claude-cu's 0.4K. A/B the lean skill, 5 runs.
5. The real-window browser race (Chrome, Helium, Firefox, Safari; about 2 h, harness never run live), the release pass, the
   owner's turbo check, the tag.

**Fable studies today** (reports in this session's transcript): categorical flag rule (built as FL1); cross-window drag and Excel
tabs (built as XD1, XL1; in 10/10 runs a tab click right after a rename dragged the clicked tab to the end, refuting the stale
mouseDown theory); why claude-cu beat sleight (tool time equal; sleight loses on model thinking in finder-move, on lease and
menu stops in textedit-calculator, and on the Excel tab swap).

**Opt-in flags still opt-in:** `SLEIGHT_WARM_ENGINE=1`, `SLEIGHT_OPEN_SHOT=1`, `SLEIGHT_SKILL=screenshot` (SK1 ran excel-edit 50-53 s in 3/3 on the pre-FL1
build; recheck), `SLEIGHT_COMPACT_TOOLBARS=1` (made word-edit ~40% slower; FL1 now leaves Word and Excel unfolded),
`SLEIGHT_COMPACT_CONFIRMATIONS=1` (wording approved by the owner).

**Owner items.** Decide on publishing once the browser race has run. The turbo live check before the tag. The Microsoft Error
Reporting window from an earlier Office crash is theirs to read or dismiss.

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
