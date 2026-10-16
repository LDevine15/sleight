# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-16 14:40 UTC, 8 of the sleight arm's tasks pass, second retry requested)

Goal (owner): release 1.3.0, then the native claim and the video, then maintenance and benchmarking as competitors improve (owner,
2026-10-16: "I don't want to work on sleight forever"). ROADMAP.md is the plan. Read it whole.

**Where it stands.** `pane/auto-mode` (private) is the release line, with the full check passing at every merge today.
- Gate passed 2026-10-16 07:38 to 08:08 UTC on v3-gate `66ada2bd`: turbo median 547 s (p90 590) and 0 errors in all 5 rounds,
  against FowlBrowser's 720 s (p90 868), 76%. The Opus head-to-head gave 675 s against 885 s, 76%
  (docs/benchmarks/2026-10-16-gate.md and -opus.md).
- Merged into `pane/auto-mode` today: the release build (v3-gate plus V8 and V8R, plugin 8,640 KB), the 1.3.0 release notes (owner
  approved), turbo on by default (owner's call, `turbo-setup.mjs`, `sleight-mcp turbo on|off|status`, a doctor section, a write
  guard for wrapped shell spellings, and a package walk that ignores `.in_use` and `.claude-plugin/types`), the release pass on the
  owner's login, and native fixture fixes. The last full check passed at `a65350ba`. The flush commit adds one more fixture fix.

**Release path, in order.**
1. Live turbo qualification with the owner present (about 10 min). `turbo.json` exists (0600, Helium, written 12:49 UTC; Chrome's
   executable here is mode 775 and refused), and the doctor reads turbo on with remote debugging on. The owner turns on remote debugging
   in Helium (`chrome://inspect/#remote-debugging`, unverified in Helium) and clicks its consent prompt on the first browser task.
   Then `sleight-mcp turbo off` must still be off in a new session. Never the owner's main Chrome profile.
2. The release pass (`bench/release-pass.mjs`, on the login), with its native, gate, Opus and claim stages. It needs Puddle windows and the owner away.
3. The 1.3.0 tag on the owner's call, then the public push (`SLEIGHT_RELEASE_PUSH=1`) and `gh release create`.

**Native claim pass (owner approved running it with the owner away).** Plan: `ledger/claims/CS3/plan-runs1.json` (162 rows, 6 arms).
Run one arm per Puddle window: `ledger/claims/CS3/native-arm.sh ARM "$(cat ledger/claims/CS3/tasks-no-chess.txt)"` with
`NATIVE_REPO=$HOME/Projects/sleight`. It logs to `ledger/claims/CS3/runs/` and touches `/tmp/sleight-bench-done` on exit. Order:
sleight, codex, lcu, cua, peekaboo. claude-cu runs only with the owner present (per-session app approval).
- Before cua: start its driver with `/usr/bin/open -n -g --env CUA_DRIVER_RS_TELEMETRY_ENABLED=0 --env CUA_TELEMETRY_ENABLED=0 --env
  CUA_DRIVER_RS_UPDATE_CHECK=false --env DO_NOT_TRACK=1 "$HOME/Library/Caches/sleight-bench/mcp-cua-arm/CuaDriver.app" --args serve
  --socket "$HOME/Library/Caches/sleight-bench/mcp-cua-arm/driver.sock"`, and check that the socket exists.
- Peekaboo's grants belong to Terminal.app, so launch its arm from a Terminal window (`osascript -e 'tell application "Terminal"
  to do script "…"'`, owner away only).
- Results so far, sleight arm (retry at 14:25 UTC): calculator-click, calculator-menu, textedit-save, textedit-edit, textedit-drag,
  preview-pdf, finder-files and textedit-calculator pass. word-edit did its task, but cleanup stopped on Word's "All done" alert,
  which vanished while the dialog scan read it (-25202 on AXChildren). `7d2e5c06` skips such a dialog, and a -25202 stop at close now
  reports its step. Before that, textedit-drag failed at 14:17 UTC on a real sleight bug: JXA's `Ref('CGPoint')` reads back as the
  number 0, so `drag` never matched a window by frame (broken since `0afa13f6` on 2026-10-12, a day after the last pass).
  `287c8679` reads geometry through a byte buffer, with a real-osascript test. Its cleanup then stopped the pass because TextEdit's
  Close stayed disabled after activation, though the app quit cleanly with the file unchanged. chess-drag is parked: the dialog scan's inspection of an untitled Chess window exceeds its bound
  (docs/known-problems.md).
- Puddle holds each arm's window and stops the chain after it. sleight-arch runs the arm command itself on "HOLD live" and asks "puddle arch" for the next window.
  sleight's windows have priority today (owner, 2026-10-16).

**After the tag (built, merge after 1.3.0).**
- `arch/epv3-2` `2817c762`: EPV3-2, the Electron app pipe outside turn workers (inert; 93 focused tests; host acceptance owed,
  `ledger/claims/EPV3-2/REPORT.md`). EPV3-3 is next in `ledger/electron-v3-plan.md`.
- `arch/epv3-1` `f9e1e919`: EPV3-1, merged into epv3-2's base. Its consent run is owed with the owner (the cards open from the
  "sleight" menu bar item: `cd ~/Projects/sleight-wt/epv3-1 && node bench/electron-consent-run.mjs --receipt
  ~/Projects/sleight-wt/ledger/claims/EPV3-1/consent-receipt.json`).
- `arch/q1-int` `c0aa885c`: the Q1 error-message fixes.
- IN1 to IN4 (native speed) wait for the native pass to show where sleight loses.

**Video.** No work until the native claim backs "fastest on macOS" (owner). The storyboard is `docs/design/video-storyboard.md`
(`340ba5e2`). LoC's draft paint round is parked unsent on LoC trunk `d8c3ef73` (`artifacts/ARCH-IMAGEGEN-R18/`). Message "loc arch"
when the claim is measured.

**Owner items.** Turbo live qualification, the claude-cu runs and EPV3-1's consent run (all owner-present), the 1.3.0 tag.

**Running now.** Nothing. The second retry of the sleight arm waits for Puddle's next window (requested 14:40 UTC, owner away).

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
