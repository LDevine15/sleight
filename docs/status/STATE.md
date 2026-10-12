# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-12 20:00 UTC)

Goal (owner, 2026-10-12, ROADMAP 0b): beat FowlBrowser in the browser on its own 13 tasks (tasks, time and cost),
then a release and a launch video showing it. Not there yet. Pushed: `pane/auto-mode` at `faeea9d` (private), full
check 2169 pass, 1 skipped, mod 33/33, exit 0 (at `c0ccc4b`). The main checkout is fast-forwarded to it.

Head-to-heads today (FowlBrowser's runner, Opus 5.5 medium, both browser orders, `/tmp/fb-rounds/h2h-*`):
- 10:25: sleight 23/26, 2,109 s, $13.33, against 26/26, 972 s, $7.98. Published in `docs/benchmarks/2026-10-12-fowlbrowser-h2h.md`.
- 13:09: 22/26, 1,258 s, $10.64 against 26/26, 884 s. 13:22: 25/26, 1,101 s, $9.13 against 26/26, 943 s, $7.11. 14:27:
  22/26, 1,414 s, $9.07 against 26/26, 967 s, $7.19. Not yet published.
- 14:49 sleight-only round with A1 (`/tmp/fb-rounds/r6-sleight-a1/report.md`, one browser order): 13/13, 814 s, $5.98.
  FowlBrowser's half of a round is about 470 s and $3.55. 313 s and $2.01 of ours is form-settings in Helium, where about
  280 s went on the HTML5 priority list. Cause, from `bench/fowl/drag-probe.mjs`: the engine's `tab.drag` moves in 8
  equal steps, and Chrome fires `dragover` only when two consecutive moves are inside one element, so a drag aimed at the
  target's center never drops (0/14). Aimed 3 px inside the target's near edge it drops 6/6 (Helium and Chrome). Lane
  item A9 builds `sleight.dragTo` on that.
- The gap is calls and cost: engine docs are 81% of what results send Claude (571,870 of 705,611 characters over 13 runs).

Found 2026-10-12: the engine's `evaluate` is a read-only scope (`browser-service.mjs:8585-8640`: no `Event`,
`DragEvent` or `DataTransfer`, read-only element wrappers, global assignment throws). So A8's in-page drag events (STALE),
A4's network watch (STALE) and the confirm pre-accept probe (`window.confirm = ...`) can't work through it.

Lane ledger (`~/Projects/sleight-wt/ledger/LEDGER.md`, prompt `lane-prompt-F.md`): reviews today (Sonnet high) merged F6R3
and F5R2. A2, A3 and A7 failed review and went back as A2R, A3R and A7R. F5R3 (receipts) is new. A6 also takes F6R3's leftovers
(a small tree cut to 0 rows under the limit, the first Wikipedia result still 55,450 characters). In progress: A6, A9, F5R3. Open:
A2R, A3R, A5, A7R, A10, F4, F7R2, F12. F3 parked. A lane item is done only after a bare `npm run check` at exit 0.

Hand-off tasks (`bench/fowl/handoff.sh`), published in `docs/benchmarks/2026-10-12-handoff.md`: at 18:57 UTC sleight 3/3
(203 s, $2.39), FowlBrowser + sleight 3/3 (143 s, $1.57), FowlBrowser 0/3. At 18:37 the sleight arms missed the invoice on
the engine's download prompt, which the hook accepts since `faeea9d`. sleight's arms may use `open_file` since `e815a8e`.

API spend this month: $119.92 of $200 (ledger `~/Library/Logs/sleight/bench-api-spend.json`). Opus rounds don't count.

The engine updated to 26.1007.30912 on 2026-10-12 (the 09:00 watch). Its API docs didn't change (empty diff).

Waiting on the owner:
- Bench leftovers in their iCloud TextEdit folder, "Delivery Note.txt" (65 bytes) and "Untitled 6.txt" (empty), from
  2026-10-12 13:44 to 13:45 EDT. Theirs to trash.
- The video (draft 1 at `~/Desktop/sleight-launch/sleight-launch-draft1.mp4`, source `media/launch/`): the owner asked
  for it to show sleight beating FowlBrowser. sleight-arch proposed leading with the hand-off tasks plus browser parity. No answer yet.
- Preview auto-approval in the hand-off hook (LAWS approves Preview for real-use tasks). No answer yet.

FowlBrowser on this Mac is a pinned clone at `~/Library/Caches/sleight-bench/fowlbrowser` (`8b68924`, our patch applied by
`rounds.sh`), installed with `--lite` and no Claude config changes. Its extension is loaded unpacked in Chrome (Developer mode on) and in
Helium by a launch flag that lasts until Helium restarts (relaunch: `open -g -a Helium --args --load-extension="$HOME/Library/Application Support/FowlBrowser/extension"`).

**Next steps:**
1. Review A9 once its branch is pushed and run it live on the settings form (`bench/fowl/rounds.sh --only form-settings-helium`).
2. The invoice's `downloadMedia` hang is the engine's: after `tab.click` on a download link, that tab's downloads stall
   (`bench/fowl/download-probe.mjs`, known-problems). A3R adds the hint, A10 the skill sentence.
3. Review lane branches as they are pushed (A2R first), merge, then a full head-to-head (both arms, Opus on the account). Publish
   every round next to the 10:25 one.
4. Video and release once a head-to-head is a win, or on the owner's call.

Released 2026-10-11, each with a GitHub release and green CI: `v1.2.0` through `v1.2.5` (`b2eb9d8`,
public `main`). The owner's install is 1.2.5. `pane/auto-mode` (private) is at the commit holding this
banner, and `~/Projects/sleight` is fast-forwarded to it.

This session works in `.claude/worktrees/boot-sleight-arch-*`, because a hook refuses edits in the main
checkout: fast-forward the worktree branch to `pane/auto-mode`, commit there, `git push private
HEAD:pane/auto-mode`, then `git -C ~/Projects/sleight merge --ff-only <branch>`. A release also pushes
`HEAD:refs/heads/main` and the tag to `origin` with `SLEIGHT_RELEASE_PUSH=1` (owner's release call),
then `gh release create` from the CHANGELOG section. Public CI is Linux, without `npm install`, on
Claude Code 2.1.288: check new tests for macOS binaries, `/private/tmp` and dev-dependency imports first.

**Measured 2026-10-11, owner away** (docs/benchmark.md, raw in `docs/benchmarks/2026-10-11-*`), against
gpt-6.1-sol: clean-arms head-to-head 9/9 each, sleight 22.0 s and 7.11 turns a run against Codex 44.6 s
and 8.67, 4.68 against 4.84 CPU s. Normal setup 9/9 each, 27.1 s against 36.2 s, 5.94 against 4.30 CPU
s. Browser head-to-head (12 tasks, Safari and Helium) 24/24 each, 28.5 s against 41.8 s, faster on 11
of 12. API spend for October: $7.84 of $200.

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
- The watch's baseline (`~/Library/Logs/sleight/watch-engine-version`) is 26.1007.30912 (2026-10-12).
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
