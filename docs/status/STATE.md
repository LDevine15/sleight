# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-18 02:21 UTC)

Goal (owner): release 1.3.0, then the claim post and the video. The owner is away from the PC, reachable by phone, and OK'd live
runs tonight. Ledger: `~/Projects/sleight-wt/ledger/LEDGER.md` (sections CLAIM-1018, EPV3, APP-CLAIM).

**Native claim on the release build: "fastest" (scorer wording), sleight fastest on 8 of 9, 251 s total against claude-cu's 454 s.**
Build 995b4855 (Electron, MV2, FL2), sleight rerun 03:17-03:38Z with top-ups to 5 on preview-read, word-edit and excel-edit, against
the competitors' claim files. Lost preview-read (5.1 against Peekaboo's 4.4). Score: `~/Projects/sleight-wt/app-claim/native-score-1018b.txt`.
The earlier claim build `9c836f22` scored 230 s, 8 of 9.

**Owner decisions 2026-10-18 (in LAWS):** F3 decided: 1.3.0's app tasks run on the native path, and Electron turbo comes in 1.3.1 with
the relaunch flow. The claim's app tasks are VS Code (vscode-edit, temporary profile), Slack (slack-post: one fixed message in
#new-channel of the owner's throwaway workspace) and Spotify (spotify-play: search "Bohemian Rhapsody" by Queen, play, pause), all six
arms, 3 runs each with top-ups. Cursor is out of the claim.

**Release line.** This worktree's branch is pushed to `private` `pane/auto-mode` and the main checkout fast-forwarded. It holds epv3-int
merged onto the claim line, with MV2 (Excel moved-tab check sees every Window block), FL2 (virtual clock in guard-light-return) and the
Electron tests' trackTemp fix. Full check green (7739 tests, 7381 pass, 0 fail, 2026-10-18 02:1xZ).

**App tasks (3 of 3, scorer wording "fastest").** Build 995b4855, 02:39-03:20Z, all six arms. Expected s: vscode-edit sleight 17,
LCU 32, Codex 42, Cua 45 (Peekaboo and claude-cu never pass). slack-post sleight 13.5 (5/5), LCU 14.2 (5/5), claude-cu 16 (5/5), Cua 26,
Peekaboo 47, Codex 65. spotify-play sleight 27, Codex 41, LCU 55, Cua 112. Totals sleight 57, LCU 101, Codex 147, Cua 183. Score in
`~/Projects/sleight-wt/app-claim/app-score-1018.txt`, failure causes in the ledger (APP-CLAIM). Open owner question: whether "fastest"
counts the app tasks with the 9 native ones (sleight wins 11 of 12 either way).

**Browser race.** In Firefox, LCU r1 and Codex r1 are done and Cua r1 started 03:41Z. `touch ~/Projects/sleight-wt/race-1017/pause`
holds the rounds between arms, and removing it resumes them.

Order from here:
1. The Firefox race: competitor rounds (cua r1 overlapped a full check at load 5, so rerun it if it scores within 20% of sleight), then
   sleight's Firefox rounds from a race worktree at the release build, then the plan's later steps.
2. The Codex lease-broker live check.
3. The release pass for 1.3.0.

**Opt-in flags still opt-in:** `SLEIGHT_OPEN_SHOT=1`, `SLEIGHT_SKILL=screenshot` (SK1 ran excel-edit 50-53 s in 3/3 on the pre-FL1
build; recheck), `SLEIGHT_COMPACT_TOOLBARS=1` (made word-edit ~40% slower; FL1 now leaves Word and Excel unfolded),
`SLEIGHT_COMPACT_CONFIRMATIONS=1` (wording approved by the owner).

**Owner items.** The F3 Electron decision (banner). One "Always allow" click on the VS Code debugger card at the live qualification.
Publishing, once the browser race has run. The engine's Always-allow list has listed only Word and Codex since 2026-10-11 (below). The
Microsoft Error Reporting window from an earlier Office crash is theirs to read or dismiss.

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
  It has listed only Word and Codex since 2026-10-11. The owner's 6 apps are in
  `ComputerUseAppApprovals.before-2026-10-11T14-19-10-653Z.json`, and the owner will restore it later (owner, 2026-10-17).
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
