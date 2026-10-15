# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-15 03:05 UTC)

Goal (owner): the published head-to-head showing sleight is the fastest computer use plugin for Mac, then 1.3.0, the claim post and
the video. 1.3.0 waits only on turbo v3's gate (owner, 2026-10-14. Reaffirmed 2026-10-14 23:20 UTC). ROADMAP.md was rewritten from an
item-by-item audit on 2026-10-15 and is the plan. Read it whole.

Branches (all on `private`):
- `pane/auto-mode` at the commit holding this banner (parent `ab1faa44`). `~/Projects/sleight` is fast-forwarded to it. Release prep
  is merged there: CI1, OL1, OL1R, CS3+CS3R+CS3R2, RP2+RP2R+RP2R2 (full check 5691 pass, 0 fail, 49 mod). 0 open PRs. Public CI green
  on 1.2.5.
- `v3-gate` at `1ee4cd57` (worktree `~/Projects/sleight-wt/v3-int`): every turbo v3 piece that passed review. V1R2, V2R, V4R, V5R2, V6R2, V3R,
  V7 to V7R5, V9R, V10 to V10R4, CR1 to CR7 (clean-room, audited CLEAN), AT1 (behavior atlas), plus sleight-arch's bench worker and two
  merge-seam fixes. Full check 6214 pass, 0 fail, 49 mod. Real-page tests that survive V8: 505/507 at `bba01ea5`. The 2 failures were the
  v2 demo test (hangs. V8R removes it) and a missing export, fixed in `1ee4cd57` (`turbo-v3-arm.real` and `turbo-v3-bench-worker.real`
  pass 2/2 there).
- Merge after reviews, before the release pass (rare-case polish, not gate-blocking): `codex/cr8` `f9237223` (reviewed PASS),
  `codex/cr9` `b612a753` (review: one designMode nit. CR10 then found the real browser contradicts it, STALE, nothing to do).
- Into 1.3.0: `codex/rc1r` `57079737` (on `codex/rc1` `65246f3a`): sleight reconnects after a ChatGPT engine update without a
  restart. The Claude review passed it (2026-10-15) with M1 (an app approved by name is asked again after a restore by bundle ID),
  M2 (the reconnect skips turn_ended) and lows L1, L2, L4. A Claude agent fixes them as RC1R2 in `~/Projects/sleight-wt/rc1r2`
  (`arch/rc1r2`). RC1R and RC1R2 merge together.
- Merge right after the gate (owner): `codex/v8` `813bca75` (v1/v2 removal, 15.4 to 8.2 MB, reviewed twice), then V8R (queued:
  restore canonical() tests, remove `tests/turbo-popup-demo.real.test.mjs` and other v2-only bench files).
- AD1, the adversarial page bank (about 330 real-page attack tests in `tests/adversarial/`), is rebased onto v3-gate (`codex/ad1`
  `5eb3b92c`, local). Rerun headless on v3-gate 2026-10-15: 53 failures (endpoint 8, keyboard 6, page-instructions 3, page-natives 10,
  payment-decoys 12, submit-retry 1, timing-and-covering 13), matching `ledger/claims/AD1/REPORT.md`.
- `arch/ad1-fixes` (`~/Projects/sleight-wt/adfix`, pushed): the bank plus sleight-arch's fix 1 at `2ff1f086`. A page session's
  Fetch never sees a popup's first request, so one browser-level `Fetch.enable` per connection, matching only the debug port, now
  fails it (probe: 6 of 6 popup vectors blocked, 0 hits on the port). The endpoint file passes 136/136, and the filter, port and
  popup tests pass 107/107. The form POST case was a test bug.
- Five Sonnet-high Claude agents fix the rest, each in `~/Projects/sleight-wt/adfix-<kb|pop|pay|swap|hyg>` on `arch/ad1-<same>`,
  focused tests only: kb (keypress focus redirect, v3-context), pop (foreground tabs from timers and spoofed targets, cancelled links,
  clean-room page.mjs), pay (decoy terms and button-type payment controls), swap (click-time swaps, forwarded activation, covers;
  clean-room), hyg (page text outside the untrusted label, label-forwarded file chooser). Clean-room briefs forbid competitor code.

Next, to reach the gate:
1. Review and merge the five AD1 fix branches into `arch/ad1-fixes` (Sonnet-high review for each, plus the bank rerun), then CR8
   (`f9237223`, reviewed PASS) and CR9 (`b612a753`), then rerun the whole bank and one full check, and merge into v3-gate.
2. Merge RC1R with RC1R2 after RC1R2's review.
3. Smoke run, headless, no owner needed: from `~/Projects/sleight-wt/v3-int`, `bench/fowl/rounds.sh --surface sleight-turbo --model
   haiku --tasks tools/agents/codex-h2h.json --only form-travel,demoid` (preflight passed 2026-10-15. A few cents). The gate tasks are
   `codex-h2h.json`'s local fixtures, not FowlBrowser's public-site `tasks.json`.
4. Then ask the owner once for the away window: the gate round (Haiku 5.5, both arms, both orders. FowlBrowser's arm drives Helium,
   so it shows windows). FowlBrowser's extension is installed in Helium (0.1.0, pinned 8b68924, Developer mode on, 2026-10-15).
5. One Opus head-to-head, then merge v3-gate into pane/auto-mode, V8 and V8R, the release pass, RP1's CHANGELOG/README, the tag.

After 1.3.0 (ROADMAP section 2) come Electron on v3 (EPV3-1 to EPV3-8, plan `ledger/electron-v3-plan.md` reviewed MERGE. EPV3-1 never
started because V10R4's dead lane held `v3-join`, now free), the claim suite, Q1-7 to Q1-17 reviews, IN1 to IN4 on sleight-arch's calls.

How work runs now: lanes run focused tests only (LEDGER NOTICE 3), sleight-arch runs one full check per merge and builds directly
when faster (LAWS), Claude reviewers (Sonnet high) review every safety, release and clean-room item, and lane reviews add real-page
repros. Competitor code is never adapted (LAWS): CR items get a similarity audit, and lanes that read FowlBrowser can't review them.

The real-page runner (`node scripts/live-dom-runner.mjs`, pid 39609) has run from `~/Projects/sleight` since 2026-10-14 20:40
UTC. No Codex lane is running. Claude agents end at a clear, and their worktrees and pushed branches remain.

The owner's steps at the Mac are Chrome's Allow during the gate, the sleight-arm login if the preflight says it lapsed
(`CLAUDE_CONFIG_DIR=~/Library/Caches/sleight-bench/sleight-arm/claude ~/.local/bin/claude auth login`), and
`ledger/claim-suite-owner-checklist.md`. API spend for October: $159.96 of $200. This session's own sleight MCP couldn't reach the
engine helper after the 2026-10-14 engine update (26.1007.71326). `.dev/tools/probe.mjs`-style fresh clients through the relay with
`preapproved` and `grantAudit` passed in work (RC1 fixes the cause).

Owner items: OpenUsage.app may relock the "Claude Code-credentials" keychain item on a token refresh (owner keeps it, 2026-10-14).
A lane worktree from 2026-10-13 sits inside the main checkout at `private/codex/fm1` (registered with git). Remove it with
`git worktree remove` once FM1's evidence is no longer needed.

Released 2026-10-11, each with a GitHub release and green CI: `v1.2.0` through `v1.2.5` (`b2eb9d8`,
public `main`). The owner's install is 1.2.5. `pane/auto-mode` (private) is at the commit holding this
banner, and `~/Projects/sleight` is fast-forwarded to it.

This session works in `.claude/worktrees/boot-sleight-arch-*`, because a hook refuses edits in the main
checkout: fast-forward the worktree branch to `pane/auto-mode`, commit there, `git push private
HEAD:pane/auto-mode`, then `git -C ~/Projects/sleight merge --ff-only <branch>`. A release also pushes
`HEAD:refs/heads/main` and the tag to `origin` with `SLEIGHT_RELEASE_PUSH=1` (owner's release call),
then `gh release create` from the CHANGELOG section. Public CI is Linux, without `npm install`, on
Claude Code 2.1.288: check new tests for macOS binaries, `/private/tmp` and dev-dependency imports first.

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

**Waiting on the owner.** The 20 extension ids can run now with `--surfaces browser,computer --extension-sites-allowed`
(127.0.0.1 is allowed since 2026-10-13). For the full battery
they seed 5 self-messages (Slack, Discord, WhatsApp, Messages, Mail) and 5 app items (Music, Maps,
Photos, Spotify, Zoom) and name local Notes, Reminders and Calendar containers. Leftovers for them:
guest carts with test items in Safari on Target and Best Buy, one benchmark Helium tab on 127.0.0.1.
Optional: `sleight-mcp setup` in a fresh macOS user (README says it's untested there).

**Where work goes.** Work in progress is private between releases (LAWS): `remote.pushDefault
private` sends pushes to `Land-o-Clusters/sleight-dev`, and a pre-push hook refuses the public repo
without `SLEIGHT_RELEASE_PUSH=1`. Public `origin/pane/auto-mode` stays at `332e3ca`.

**Benchmark.** Claude arms run on the owner's API key, Haiku 5.5 at high, capped at $200 a month
(LAWS). `--surfaces browser,computer` runs the real suite with the extension browser API. Chains of
live runs live in `.dev/passes/`. Compare A/Bs with `node .dev/tools/ab-compare.mjs <log>.log`.

Branches and worktrees: `pane/auto-mode` in `~/Projects/sleight` is the working branch.
`~/Projects/sleight-wt/` contains only owned-abort. `perf/screenshot-scale` (`1aa574b`) is parked.

## Machine state outside the repo

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
- `~/Library/Application Support/sleight/preapproved.json` lists Calculator (owner, 2026-10-04) and
  Helium (`net.imput.helium` and `Helium`, all `high`). Helium was added on the owner's order on
  2026-10-05, and the owner kept it with no end date on 2026-10-08. The list before it is
  `.dev/tools/preapproved.before-helium.json`.
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
