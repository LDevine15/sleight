# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-13 02:25 UTC, boot after the clear)

Goal (owner, 2026-10-12): a published head-to-head that shows sleight is the fastest computer use plugin for Mac (LAWS, ROADMAP 0b).
The finish line is locked in ROADMAP 0b (owner, 2026-10-12 20:00 EDT), four steps ending in release 1.3.0 and the video. Read it first.
Claude quota is short (owner, 2026-10-13): finish the rows and the release, nothing else. Build work stays in lanes.
Pushed: `pane/auto-mode` at the commit holding this banner (private); last full check 2817 pass, 1 skipped, mod 33/33, exit 0.
`~/Projects/sleight` is fast-forwarded to it, and there are 0 open PRs. Public CI is green on 1.2.5.

At boot all seven finished lane items (M1, M2, T2R6, W2R3, W3R4, W4R5, W6) failed Sonnet-high review. Their fixes are five
ledger items, the whole finish line now. Grok has T2R7 and W3R5. Codex has M3 (M1 plus M2 in one patch), W4R6 (the owner's one
extra round past the cap) and W7 (W2R3, W6 and W4R5's runner part in one branch). Then the gate round on Haiku 5.5.
API spend for October is $151.00 of $200, in `~/Library/Logs/sleight/bench-api-spend.json`. Opus rounds don't count.

Measured 2026-10-12 (all in `docs/benchmarks/2026-10-12-*`):
- Every FowlBrowser-runner "Haiku" round ran Haiku 4.5 (the `haiku` alias in Claude Code 2.1.289 resolves to
  `claude-haiku-4-5-20251001`), both arms. The docs say so. M1 makes the gate run 5.5. The Opus rounds ran `claude-opus-5-5`.
- Opus, 15:23 EDT: sleight 26/26, 893 s, $8.39. FowlBrowser 26/26, 805 s, $5.55.
- Haiku 4.5, 16:06 EDT: FowlBrowser 22/26 with 22 tool errors, sleight 19/26 with 145.
- Haiku 4.5, 19:12 EDT at `2ad83d1a` (`haiku-round-2.md`): sleight 21/26, 2,607 s, $3.73, 107 errors, 2 resets. FowlBrowser 24/26,
  1,234 s, $2.08, 8 errors. The anatomy's unexplained time is the model writing (D7: 565 s against 119 s): next sprint's lever.
- REPL warm-up (S1R): an empty first call with 13 sessions at once went from 0.8 to 1.2 s to about 30 ms.
- D5 `min` docs: within noise, opt-in. First-call queueing: a tab open is 0.9 s alone, 3.2 s mean with 13 sessions.

Merged and pushed 2026-10-12 after Sonnet-high reviews: D2, D5R, A9R3, A3R5, A10R, F4R3, E1, H1R, H11, H14, A6R4, S1R, S1R3, S2R2,
H6R2, H4R2, T1R3, T2R4, H2R4, H8R4, T4R4, H5R4, H15R2 (sleight-arch moved one regex into the injected function), H16, H17, N1R2, D6
(sleight-arch guarded one assignment and named four functions in its notice), K12, W1R4, W3R3, W4R2, W5R3, A7R's live fix. Parked:
A5/A2R, P1, T3, D4, H12. Stale: H9, H10, H13, T5, H4.

In flight at the clear (`~/Projects/sleight-wt/ledger/LEDGER.md`, claims marked SEEN2 when sent to review):
- H3R3 merged at the flush. T2R5 failed review and found that the merged `sleight.pickFromList` calls `tab.scroll`, which the
  engine's Tab lacks, so it throws on a real tab, and its search gives up before rows past about index 360: T2R6, first after M1/M2.
- W4R4 failed review on three audit gaps: W4R5 in the ledger. D7 is a finished report only (`codex/d7`).
- Lanes building: M1 (Haiku 5.5 ids and token-based cost in `rounds.sh`), M2 (bound the FowlBrowser runner's inventory awaits: the
  19:25 hang), W2R3 (rebase W2R2 onto W4R2's world design), W3R4 (Browser Use temp-profile leak, `uv` test skip for CI).
- Unclaimed: W6 (Claude's own computer use through an interactive harness).
- Background work at the clear: the ledger monitor loop stopped and wasn't relaunched. Restart it at boot (memory `lane-ledger`).
  The REA study of the engine's native helper finished after the flush: notes in `~/Projects/sleight-wt/ledger/rea-helper-study.md`
  (settle floor about 100 ms after the last AX notification, 5 s cap, per-app FIFO, ranked speed ideas for next sprint).

Next steps: review and merge M1, M2 and T2R6. Then run the gate round with Haiku 5.5, both arms (`/tmp/fb-rounds`, the
`hk2.sh` pattern: `rounds.sh --model haiku` maps to 5.5 after M1). Then the Opus head-to-head. Then W2R3, W3R4, W6 and the claim
run. The owner owes two things. First, the login for the Claude in Chrome arm, after sleight-arch reinstalls that arm (its pinned claude is the
stub): `env CLAUDE_CONFIG_DIR=~/.config/sleight-bench/world/arms/claude-in-chrome/claude-config <pinned claude> auth login`. Second, the
Cua and Peekaboo permission clicks once W2R3 is merged.
Helium was relaunched with FowlBrowser's extension at 19:12 EDT (owner's OK). The Chrome profile "sleight benchmark" holds Claude in
Chrome, device id in `~/.config/sleight-bench/world/claude-in-chrome-device`.

Lane ledger (`~/Projects/sleight-wt/ledger/LEDGER.md`): the source of open items. Its FINISH LINE header lists what is left.

A7R's save split, live (21:15 UTC): 0/3 saved at first, because `settle-text-write.js` called `isNil()` on a CGEvent (a CF
pointer in JXA). Fixed, then 3/3 saved, save 2.1 s, the read after it under 65 ms (`bench/save-split-probe.mjs`). No background jobs of sleight-arch's are running. The lanes run on their own.

Hand-off tasks (`bench/fowl/handoff.sh`), published in `docs/benchmarks/2026-10-12-handoff.md`: at 18:57 UTC sleight 3/3
(203 s, $2.39), FowlBrowser + sleight 3/3 (143 s, $1.57), FowlBrowser 0/3. At 18:37 the sleight arms missed the invoice on
the engine's download prompt, which the hook accepts since `faeea9d`. sleight's arms may use `open_file` since `e815a8e`.

The engine updated to 26.1007.30912 on 2026-10-12 (the 09:00 watch). Its API docs didn't change (empty diff).

Waiting on the owner:
- Bench leftovers in their iCloud TextEdit folder, "Delivery Note.txt" (65 bytes) and "Untitled 6.txt" (empty), from
  2026-10-12 13:44 to 13:45 EDT. Theirs to trash.
- The video waits until the claim work is done (owner, 2026-10-12).

FowlBrowser on this Mac is a pinned clone at `~/Library/Caches/sleight-bench/fowlbrowser` (`8b68924`, our patch applied by
`rounds.sh`), installed with `--lite` and no Claude config changes. Its extension is loaded unpacked in Chrome (Developer mode on) and in
Helium by a launch flag that lasts until Helium restarts (relaunch: `open -g -a Helium --args --load-extension="$HOME/Library/Application Support/FowlBrowser/extension"`).

**Next steps:**
1. Keep the ledger moving: review and merge each done item, fix items for failed reviews.
2. Haiku A/Bs: D5 `min`, then batch H once merged.
3. Clean-room reads (LAWS): the FowlBrowser study is in batch H (H5 is new); a Sonnet subagent is reading Claude in Chrome, the
   Codex extension and the engine's browser code. REA (owner's pick) waits on the owner's install.
4. Once every open item is merged, one Opus head-to-head, published. Video and release follow on the owner's call.

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
