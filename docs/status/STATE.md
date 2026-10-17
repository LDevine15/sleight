# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-17 00:40 UTC, flushed before the owner's clear: heads-down on fixes, then one A/B, the claim run and the tag)

Goal (owner): release 1.3.0, then the native claim and the video, then maintenance and benchmarking (owner, 2026-10-16: "I don't
want to work on sleight forever"). ROADMAP.md is the plan. Read it whole, especially 1b and 2.4.

**Plan now (owner, 2026-10-17, ROADMAP 1b).** Go heads-down: build every token, turn and reliability fix found on 2026-10-16, merge
and freeze the harness, then (1) one combined A/B, today's sleight vs all-fixes sleight on the claim tasks plus held-out native
tasks (about 1 hour, owner away), (2) the all-arms claim run in one window (sleight, lcu, codex, cua, peekaboo; 5 runs wherever
any arm fails; about 4 hours, owner away; peekaboo needs a Terminal launch), (3) claude-cu and the turbo live check with the owner
present (about 55 min), (4) the slimmed release pass (browser gate plus Opus on the release commit, about 1 hour), (5) the tag on
the owner's call. Score only with `node bench/claim-score.mjs --results ~/Projects/sleight/bench/results` (exclusions with reasons in
`bench/claim-exclusions.json`; add a rule there, never filter by hand). Claim rules are in LAWS.

**Build lanes in flight.** They run as headless `codex exec` (gpt-6.1-sol high) under launchd, so the clear doesn't stop them.
Briefs are in `~/Projects/sleight-wt/ledger/queue/tt/` and `queue/speed/`, with the prompt `queue/tt/lane-prompt-tt.md`. Logs go to `ledger/lane-runs/`.
- TT2, pid 58221: the relay. open_file returns the window, a top-level `return` works, and the file's mtime confirms a save.
- TT3, pid 58228: drag. Non-text drags hit-test their endpoints, and a timeout points to Copy and Paste.
- TT4, pid 58235: compact reads. No full tree after a filtered return.
- TS13, pid 67634: skill and result text. No confirming read after an action, and getApp on an app the task names.
  Each reports in `ledger/claims/<ID>/` (DONE, BLOCKED or STALE, plus REPORT.md). Review each branch, run one full check per
  merge, push, fast-forward.
- Next in line (same files as a running lane): TK1 compact first acquisition after TT4, TK2 engine docs once and shorter after
  TT2, TK3 skill placement after TS13 (it blocked on the skill lock, correctly). Relaunch with the same prompt template (claim
  folders TK3 hold a BLOCKED from the lock clash: remove BLOCKED and OWNER before relaunching it).
- TT1N (the input lease accepting a menu its own call opened) is sleight-arch's own design job: the guard sees only title, app and
  URL, with no window number or in-call focus history (`claims/TT1N/REPORT.md`, branch `codex/tt1n` `b440ac07` holds 10 tests,
  2 red by design). The fix needs sleight's native window identity between the two actions. The lease protects the owner.
- Not ours: PID 41395, a read-only `codex exec` started 2026-10-16 01:46 local. Leave it.
- This session's lane watcher stops at the clear. Next session: check `ls ledger/claims/{TT2,TT3,TT4,TS13}`.

**Where the claim stands** (scored, 2026-10-16 runs; expected seconds to a correct result, passes/runs). sleight completed 9/9
native tasks; lcu 6/9, codex 6/9, cua 7/9, peekaboo 3/9. After skill fix `14327dd4` (rerun 2026-10-17 00:05 UTC, load 4.5 at start)
sleight leads textedit-drag 32 (3/3; nobody else ever passed it), textedit-calculator 45 (3/3, was 1/3) and word-edit 88 (3/3;
lcu 122), and ties calculator-click 8 with lcu. It trails on 5 tasks: calculator-menu 19 vs lcu 12, textedit-save 21 vs lcu 11,
preview-read 12 vs Peekaboo 5, finder-move 136 vs cua 97, excel-edit 184 vs cua 133 (one cua run). Trace studies found sleight's
best runs tie lcu and Peekaboo turn for turn, and the losses are turns wasted by sleight's own tools (lease stops on same-call menu
clicks, open_file on open documents, Finder drags inside sleight's guards) plus a 25,000-character first result against
Peekaboo's 4,600. Recommended wording to the owner: "completed every task" rather than "fastest", until the claim run.
Fable's review (2026-10-17) found the skill fix was tuned on the claim's own failures, so check it on held-out tasks and say so in
the publication. Codex runs gpt-6-luna, not Haiku. Publish pass counts and median-of-passes beside expected time.

**Release path.** Turbo live check with the owner (about 10 min; the release pass refuses the gate without it), then the slimmed
release pass, then the tag. The CHANGELOG 1.3.0 drag entry carries its live measurement. Turbo in `claude -p` never activates,
because the mod's `prompt.submit` hook doesn't fire there, and the gate measured turbo through a bench-only server
(`bench/turbo/v3-server.mjs`). The browser comparison stays in the gate's harness with a Codex arm to add (owner, 2026-10-16).

**After the tag.** `arch/epv3-2` `2817c762` (EPV3-2, inert; EPV3-3 next in `ledger/electron-v3-plan.md`), `arch/epv3-1` `f9e1e919`
(consent run owed with the owner), `arch/q1-int` `c0aa885c` (Q1 error messages), the ghost hand (ROADMAP 2.7; LoC's architect has the
design request queued), the speed items in ROADMAP 2.4.

**Video.** No film work until the claim is measured (owner). Storyboard `docs/design/video-storyboard.md`; LoC's draft paint round
waits on LoC trunk. Message "loc arch" when the claim run is scored.

**Owner items.** Turbo live check, claude-cu runs and EPV3-1's consent run (owner present), the claim wording, the tag.

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
