# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-14 00:00 UTC)

Goal (owner, 2026-10-12): a published head-to-head that shows sleight is the fastest computer use plugin for Mac, then release
1.3.0, the claim post and the video (ROADMAP 0b, docs/design/video-storyboard.md). Read ROADMAP 0b and LAWS first.
Pushed: `pane/auto-mode` at the commit holding this banner (private); full check 3964 pass, 0 fail, 39 skipped, mod 33/33.
`~/Projects/sleight` is fast-forwarded to it, there are 0 open PRs, and public CI is green on 1.2.5.

The turn of 2026-10-13: two Haiku 5.5 gate rounds on the engine's browser path put sleight at 23/26 and 21/26 against
FowlBrowser's 26/26 at about twice its time. Every miss was a form (form runs 17/40, non-form 36/36,
`docs/benchmarks/2026-10-13-gate.md`), and every form failure traced to the engine's browser path. The owner then decided
(LAWS) that sleight gets a direct browser path as an opt-in turbo through Chrome's built-in remote debugging consent. The engine
path remains the zero-setup default. Design v2 (`~/Projects/sleight-wt/ledger/browser-path-design-v2.md`) and the native-app
design (`native-path-design.md`) are approved. The Electron design (`electron-path-design.md`) waits on four owner decisions.
Engine-browser fixes (AS-3, AS-4, FM2, FM3, QT1) are parked: their checks are in the gate doc.

Merged on 2026-10-13, all peer-reviewed by Codex lanes: AS-1R and AS-2R, FS2R, W8R2, FM1, TB1, M3R, T2R7, W3R5, R1, W4R6, AS-5,
Q1, RS5-1R, RS6-1R, and the turbo and native prototypes under `bench/` (not wired into the plugin yet): BP2-1, BP2-2, BP2-3,
BP2-5, BP2-6R3, BP2-7, BP2-9, BP2-10, NP-1, NP-2, NP-4R, NP-6R, NP-7. After the clear: AM1R (`bench/app-speed-map.mjs`, which times app reads without a model.
Every app it names is on the LAWS allowlist, and account apps need `--owner-present`).

Real-page tests: FowlBrowser's playwright-core 1.64 needs Chromium build 1248, which wasn't installed, so `SLEIGHT_LIVE_DOM_TEST=1`
runs skipped or failed to launch before 2026-10-14 ("the installed playwright-core Chromium build is unavailable"). Installed on
the owner's OK (2026-10-14). With it, 3419 of 3420 tests pass under the flag and 1 skips. Read the TAP skip reasons at every merge.

Past the cap (owner, 2026-10-13 23:45 UTC): BP2-1R2 and BP2-4R3 were parked and block BP2-12. In BP2-1R2 the navigation fix holds, but the last gate
misses an identity recheck after the final clock callback. In BP2-4R3 the cursor fix holds, but autofill tokens match case-sensitively. The
owner allowed one more round each, BP2-1R3 and BP2-4R4, and pre-approved one round after that (BP2-1R4, BP2-4R5). After that they park.

Lanes (headless `codex exec`, gpt-6.1-sol high; memory `headless-codex-lanes`; logs and prompts in `/private/tmp/claude-501/lanes/`;
report only through `~/Projects/sleight-wt/ledger/claims/`): codex-hdlav (BP2-1R3) and codex-hdlaw (BP2-4R4) started 23:55 UTC;
codex-hdlas reviews NP-5R, codex-hdlat reviews NP-3R2 and BP2-8R2. BP2-11R's claim was overwritten in a collision by codex-hdlar
(OWNER-CORRECTION.md); its owner codex-hdlap exited with uncommitted work in `~/Projects/sleight-wt/bp2-11r`, and codex-hdlax
took it over at 00:00 UTC. Waiting in `queue/next/`: BP2-12 (wires turbo into the plugin), NP-8, EP-1 to EP-7, the Q1, IN, AA1 and RS proposals.
B1 and Q2-1 are plugin changes held until after the 1.3.0 freeze.

Merging a prototype item: squash `private/codex/<id>`, run `SLEIGHT_LIVE_DOM_TEST=1 node --test` on its test files (real-page
tests are sleight-arch's), then the bare `npm run check`, push, and `touch claims/<ID>/MERGED`. Keep about 12 lanes at most:
16 at once drove the load to 130 on 2026-10-13 (pause a lane's process group with SIGSTOP in an emergency).

Next steps, in order:
1. Merge reviewed BP2 and NP items as they pass, with BP2-1R3 and BP2-4R4 before BP2-12. Reassign BP2-11R.
2. BP2-12 wires turbo into the plugin, opt-in. Then live qualification in the owner's Chrome "sleight benchmark" profile and Helium:
   the owner turned remote debugging on in both (2026-10-13) and clicks Allow on Chrome's prompt once per browser launch.
3. AM1's live speed map in an away window.
4. The turbo gate round (Haiku 5.5, both arms, both orders), then one Opus head-to-head on the owner's account.
5. The claim suite with the W8 runner. The Claude in Chrome arm is signed in (Max plan, 2026-10-13); Cua and Peekaboo need the
   owner's permission clicks on first run.
6. Release 1.3.0 on the owner's call once all of it is done (CHANGELOG draft in `ledger/claims/R2R/`), then the claim post
   and the video.

Waiting on the owner: the four Electron decisions; the Cua and Peekaboo clicks; an away window for steps 3 and 4; two iCloud
TextEdit leftovers ("Delivery Note.txt", "Untitled 6.txt", 2026-10-12) and an unused keychain entry `Claude Code-credentials-…`
from a mistyped arm path, both theirs to delete. API spend for October: $156.76 of $200.

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
