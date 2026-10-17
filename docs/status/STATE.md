# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-17 12:50 UTC)

Goal (owner): release 1.3.0, then the native claim and the video, then maintenance and benchmarking (owner, 2026-10-16: "I don't
want to work on sleight forever"). ROADMAP.md is the plan. Read it whole, especially 1b. The owner is back and wants normal answers.

**Merged since the boot** (last full check 6,452 tests, 0 fail, exit 0, pushed as `97fd52ab`):
- IT1: after an editable-field click, typing or paste on that handle in the same call waits until 250 ms since the click. Default
  on. It needs a live word-edit check.
- RF1: const-warning strip, enabled-element preference among duplicate labels, API names after a missing method. Default on.
- SK1 (`SLEIGHT_SKILL=screenshot`) and RB1 (`SLEIGHT_COMPACT_TOOLBARS=1`), opt-in until the word-edit/excel-edit A/B.
- CP1 with CP1R (`SLEIGHT_COMPACT_CONFIRMATIONS=1`, policy 5,946 to about 4,000 chars), opt-in until the owner reads the wording
  in `plugins/sleight/lib/compact-confirmations.mjs` (side-by-side table in `ledger/claims/CP1R/REPORT.md`).
- CU1 with CU1R and `eb8bde6e`: the claude-cu arm keeps its computer-use server under telemetry opt-out and answers the session card
  only when each app and grant the card lists is on the task's fixture allowlist. Two Sonnet-high reviews; the second found the hook denied
  every real `request_access` (the schema's required `reason`) and the block record kept the account banner, both fixed. Needs its
  live check.

**Running.** DG1R (Codex lane, log `ledger/lane-runs/dg1r.log`): review fixes to `codex/dg1` (drag by element number or text
selection). Its element scan stopped at depth 12 or 300 elements, so deep web text would refuse, and titles with commas could match
another element. DG1 merges after it. No live run is going: the next ones wait for the owner to say they're away and a Puddle window.
sleight's 11:53 rerun (on `2c687b2a`'s code, flags off) finished 12:12:54Z, 26 of 27 passed, scored to
`~/Projects/sleight-wt/sitting-1017/claim-score-final.txt`, and Puddle's window w-flagab-1017 was released at 12:13:06Z.
Its harness bugs: run.mjs crashed in the unlock because something else removed `/tmp/sleight-live.lock` mid-run (fixed in
`250708da`, which reports it and exits 1; the culprit is unknown), and claim.sh logged `$(date)`'s status as the arm's exit
(fixed in place in `sitting-1017/claim.sh`).

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

**Build.** `pane/auto-mode` is at the newest commit on `private` (the flush). Since `ef833641` these were merged, each reviewed by a
Sonnet-high agent with findings fixed test-first; the last full check was 6,290 tests, exit 0:
- Chess drag fix `1933db78`; the swap-note sort guard `5a6ba6c0`; PR1/PR1R (engine docs held back from open_file until Claude's
  first js result); TC1/TC1R (cross-app stop wording, select_window, menu Cancel, acquisition reads bound to their handle);
  RW1/RW1R/SW1/SW1R (save confirmation after an ID click, sibling-swap note); WM1/WM1R (stuck-menu and misplaced-typing warnings);
  JD1 (the engine's js description cut under Claude Code's 2,048 limit, 3,511 to 1,536 chars).
- Opt-in flags awaiting an A/B before they become defaults: `SLEIGHT_WARM_ENGINE=1`, `SLEIGHT_OPEN_FAST=1` (PW1/PW1R) and
  `SLEIGHT_OPEN_SHOT=1` (SH1, a screenshot with open_file's first read). Suggested A/B: `OLD=<head> NEW=<head>
  NEW_ENV="SLEIGHT_WARM_ENGINE=1 SLEIGHT_OPEN_FAST=1 SLEIGHT_OPEN_SHOT=1" TASKS=preview-read,calculator-click,textedit-save,word-edit
  ROUNDS=3 bench/ab-sleight.sh`.
- Bench: FC1/FC1R (two-window cleanup, live 3/3), FC2/FC2R (cleanup discards only the run's own fixture), the real-window browser
  gate (BR1, BR1F, BR1G Chrome and Helium; BR2A, BR2B, BR2C Firefox; BR2S, BR2SR Safari through the owner's "sleight benchmark"
  profile). None of the gate has run live. Firefox's dry run plans 12 tasks. Safari refuses on any window without profile
  evidence, and a fresh Safari likely opens a default-profile window first, so expect a refusal and run the read-only probe
  (`bench/fowl/safari-ax-probe.sh`) on a Safari with no owner windows.

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

**Queued items** in `~/Projects/sleight-wt/ledger/queue/tt/` (none claimed): CU1, SK1, IT1, RB1, RF1, DG1, CP1 (CP1 needs an owner
look at the compact policy wording). Lane launch: `nohup codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -c
sandbox_workspace_write.network_access=true -C ~/Projects/sleight-wt --skip-git-repo-check --add-dir ~/Projects/sleight --add-dir
~/Library/Caches --add-dir /private/tmp --add-dir /tmp - < ledger/lane-runs/prompt-<id>.md`, the prompt made from
`lane-runs/prompt-tc1.md` by replacing TC1 and tc1 (it lets focused tests run at nice 20 during a live lock). Item IDs collide
with old claims often: check `ls ledger/claims` first.

**Next.** Read the rerun score. Then, in Puddle windows: the flag A/B; CU1 built and its live check; the Excel and Word input
probe; the real-window browser race (Chrome, Helium, Firefox; Safari after its probe), about 2 hours. Then the release pass, the
turbo live check with the owner (about 10 min), and the tag. Video only after the claim is complete (owner).

**Owner items.** Decide on publishing once claude-cu and the browser race have run. Look at CP1's compact policy wording when it
exists. The turbo live check before the tag. Done today: the login for the world benchmark's sleight arm, the Safari "sleight benchmark" profile,
approval of the claude-cu card answerer for allowlisted apps.

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
