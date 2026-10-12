# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-12 00:45 UTC)

**The owner's Mac is still under load** (owner, 2026-10-12 00:00 UTC; load average 14 to 21): no live
runs and no full `npm run check` until they say it's free. Everything since 1.2.5 passed only the test
files it touched, plus `lint:prose`. The first full check and one live pass over all of it are owed.

Codex's "-1005" timeouts were the engine's: `-10005 timeoutReached` on 2 of 2 `getApp` calls on
OpenUsage (menu-bar-only), after the engine service segfaulted (4 crashes since 2026-10-05). The relay
now resends a read that met a crash and routes a menu-bar-only timeout to `menu_bar` (`ff41cd0`).
`remove-blocked-app` is cherry-picked (`8ff3317`). known-problems is 190 lines, down from 1,151.

Lane ledger at `~/Projects/sleight-wt/ledger` (LEDGER.md, claims by `mkdir`, reports in
`claims/<ID>/REPORT.md`, and a `MERGED` file for each item sleight-arch merged). Merged after review, unit-tested
only: every item except K10 (20 merged, K4, K5, K6 and K9 through their review-fix items K4R, K5R,
K6R and K9R). Each REPORT.md says what it changed and what its live check is. K4R runs only under
`SLEIGHT_LAUNCH_REREAD=1`, and K7's row trim only under `SLEIGHT_RESULT_TRIM=1`. The drag changes
(K5R, K6R) rely on JXA bridging that unit tests mock, so a live drag run gates any release. K10 needs
a Swift build on a free Mac.

The engine plugin is now 26.1007.30912 (folder dated 2026-10-11 12:45); the watch's baseline is still
26.1007.21159, so the 9:00 watch diffs it. Live lock and hold are free. No background job of this
session runs.

Released 2026-10-11, each with a GitHub release and green CI: `v1.2.0` through `v1.2.5` (`b2eb9d8`,
public `main`). The owner's install is 1.2.5. `pane/auto-mode` (private) is at the commit holding this
banner, and `~/Projects/sleight` is fast-forwarded to it.

This session works in `.claude/worktrees/boot-sleight-arch-*`, because a hook refuses edits in the main
checkout: fast-forward the worktree branch to `pane/auto-mode`, commit there, `git push private
HEAD:pane/auto-mode`, then `git -C ~/Projects/sleight merge --ff-only <branch>`. A release also pushes
`HEAD:refs/heads/main` and the tag to `origin` with `SLEIGHT_RELEASE_PUSH=1` (owner's release call),
then `gh release create` from the CHANGELOG section. Public CI is Linux, without `npm install`, on
Claude Code 2.1.288: check new tests for macOS binaries, `/private/tmp` and dev-dependency imports first.

**In flight.**
- `remove-blocked-app` (`e536f38`) is cherry-picked onto `pane/auto-mode` (2026-10-12) and supersedes
  `e640e28`. Its full check and live check are owed with the rest.
- Lane owned-abort (Codex, `~/Projects/sleight-wt/owned-abort`, branch `codex/owned-abort` at
  `245a186`): uncommitted `bench/preapproved-process.mjs` and `tests/preapproved-process-abort.test.mjs`,
  recording an EPERM while cancelling instead of throwing from the abort listener. No report yet.
- Merged 2026-10-11 to 2026-10-12 after review, none run live: broken-harnesses (Chess pid, save-lock
  URL match, select-all fixture timeout, stale-number reads the display fresh), harness-hygiene
  (simctl 405, harness signals exit after cleanup, Chess leftovers named), shop-match (brand and
  option tokens), front-restore (Codex, `c576f59`: default on, `SLEIGHT_FRONT_RESTORE=0`, only clicks
  cancel it). Front-restore changes what every user runs: live check before any release. `signin`
  browser kind (`8b47a54`). The ZCode battery flows (`98d2113`) run with `--suite battery --tasks
  zcode-send,zcode-rename,zcode-pin,zcode-sidebar`. sleight-arch adds `~/sleight-scrap` as a ZCode
  project through sleight before their first pass (owner, 2026-10-11).
- The benchmark's Codex arm defaults to gpt-6-luna at Claude's effort (owner, 2026-10-11, LAWS). The
  published head-to-heads ran gpt-6.1-sol and get rerun on luna.
- Launch post draft: `~/Desktop/sleight-launch/thread-next.md`, with [PENDING] lines for the luna
  rerun, the approval change and the release pass.
- ROADMAP 3.0 (owner, 2026-10-11): ZCode nudges by puddle arch felt slow. 5 calls and 30 to 45 s a
  nudge, about 7 s of it sleight's calls; the rest is model time, plus 7.9 to 8.1 s calls in a 700-element
  tree. Targets: fewer turns and faster reads of large Electron trees.

**Measured 2026-10-11, owner away** (docs/benchmark.md, raw in `docs/benchmarks/2026-10-11-*`), against
gpt-6.1-sol: clean-arms head-to-head 9/9 each, sleight 22.0 s and 7.11 turns a run against Codex 44.6 s
and 8.67, 4.68 against 4.84 CPU s. Normal setup 9/9 each, 27.1 s against 36.2 s, 5.94 against 4.30 CPU
s. Browser head-to-head (12 tasks, Safari and Helium) 24/24 each, 28.5 s against 41.8 s, faster on 11
of 12. API spend for October: $7.84 of $200.

**Next steps:**
1. When the owner says the Mac is free: cherry-pick `remove-blocked-app`, run the full check, push.
2. One away sitting, asked for once: the luna head-to-heads (clean and normal, then the 12 browser
   tasks), the lean-prompt A/B (`SLEIGHT_PROMPT=lean`, calculator-click, textedit-edit and
   textedit-save, 6 runs a task per arm), front-restore's live check, the ZCode flows on both arms,
   the merged harnesses (Chess, save-lock, select-all, stale-number, simulator-form, shop smoke),
   `signin` and the 40 native browser ids, and the no-seed battery. Merged lanes battery-cleanup,
   battery-host-2, browser-tasks(-2) and web-cleanup have no full live pass yet.
3. Fill the launch draft's [PENDING] lines from those results, then the release gate (ROADMAP 5b).

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

**Waiting on the owner.** Allow `127.0.0.1` in the Codex extension's site settings in Helium and
Chrome (their OK; sleight-arch couldn't: the engine's read of Helium timed out twice), then the 20
extension ids run with `--surfaces browser,computer --extension-sites-allowed`. For the full battery
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

- Daily launchd job `com.landoclusters.sleight-watch` (9:00, `scripts/watch.sh`), daily since
  2026-10-10 on the owner's OK because a competitor hinted at an engine change; weekly with
  `npm run watch:install`. It saves the engine's API docs, without sleight's skill since 2026-10-10
  (`~/Library/Logs/sleight/engine-api-26.1007.21159.md` is the latest), and diffs them on an engine
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
- The watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1007.21159 (2026-10-10).
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
