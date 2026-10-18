# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-18 20:25 UTC, after the clear)

Goal (owner): release 1.3.0, then the claim post and the video. The claim has four categories (owner, 2026-10-18). Turbo runs in real
Chrome and Helium windows and the engine path races in Firefox and Safari, beside the native app claim and the Electron app tasks. Ledger:
`~/Projects/sleight-wt/ledger/LEDGER.md` (every result, item and decision of 2026-10-18 is in the sections from APP-CLAIM on).

**Release line.** This worktree's branch is at `05e67bec` and pushed to `private` `pane/auto-mode`, with the main checkout fast-forwarded.
The full check last passed on 9463c0c4 (8073 tests). Commits since then change only bench/fowl (cover record, Safari per-task
PID), tests and docs. They passed 249 focused tests, and the full check waits until the timed rounds stop. Race worktree
`~/Projects/sleight-wt/race-fx` moves to 05e67bec between rounds. Only the untracked `.playwright-mcp/`, `.vale/` and `node_modules`
are outside git. No open PRs. Every lane branch of 2026-10-18 is merged.

**Where the claim stands (all Haiku 5.5 high, real windows):**
- Native 9 tasks: "fastest", 8 of 9, 251 s against claude-cu's 454 s on 995b4855 (lost preview-read 5.1 against Peekaboo's 4.4; its
  study says the gap is model thinking every engine-tree arm shares). The build has changed since, so sleight's native arm reruns on
  the final build before publishing.
- App tasks (VS Code, Slack, Spotify): fastest on 3 of 3 (`~/Projects/sleight-wt/app-claim/app-score-1018.txt`).
- Chrome turbo (b5, 0f706f6d): fastest on 12 of 13 against FowlBrowser, 39/39 passes, 247.6 against 441.8 s. Helium turbo (b5,
  46ac78bf): 12 of 13, 241.8 against 363.3 s. Close pairs need 5-round top-ups. Claude in Chrome has no result (see owner items).
- Firefox (sleight b3 on 326dde47, competitors 3 rounds): fastest on 10 of 12. Lost mdn (Codex 16.0 against 19.7) and
  form-settings-helium, which only Cua passes. Fixes since (CT result trimming, EN lines, FM7, DRG drags) are unmeasured: sleight's
  Firefox rounds rerun on the current build.
- Safari: r1 for all four Terminal arms is set aside (`race-1017/failed-safari-pid-*`). Since the per-task relaunch, each prompt named
  the first Safari's PID, and cua stopped on 11 of 12 tasks because that PID had no windows. 05e67bec replans each task. In
  that r1, sleight and lcu both failed form-settings and form-settings-helium at the list's drag reorder. The Fable study found the
  race's own Terminal window over Safari's list, and the engine's background drags miss in a covered window (known-problems,
  Benchmark environment). AXRaise can't lift a background app's window over another app's (1/1). Since fea700fa every task's row
  records the windows over the browser at its start (`cover`, report column "covered by"). Rounds don't raise or move windows.
  Every task from 18:08Z to 19:35Z had two Finder run-folder windows over 41% of Safari. The owner said they weren't theirs, and
  sleight-arch closed them by their AX close buttons at 19:35Z. The cover matters only for the two drag tasks. So each r2 of the
  four Terminal arms is scored without form-settings and form-settings-helium (10 rows, `filtered.json` in the folder, originals in
  `race-1017/failed-safari-finder`), and those two tasks rerun uncovered into `safari-<arm>-r2f`. Codex r1 (19:35Z) was the first
  uncovered round: 7 of 12, cover "none". The owner added two 2560x1440 displays at about 20:05Z. From 64396fa5 (race-fx after
  codex r3) each task first moves the round's own browser window to the least-covered spot on any display (TextEdit probe: 53%
  covered to none), and the finished race `.command` Terminal windows close at that switch.

**Running across a clear:**
- Terminal.app job `race-1017/race-safari-term.command` (log `race-safari-term.log`) runs Safari r3 for sleight, lcu, cua and
  peekaboo. When it logs `done`, a waiter in sleight-arch's shell opens `race-safari-r1.command`. It reruns the four r1 rounds
  (log `race-safari-r1a.log`), then the r2f drag-task reruns, and writes `done` to `race-safari-r1.log` only at the end. After a clear, if that log doesn't exist once the term log says `done`, open it by hand.
- Safari's Codex x3 (`race-safari-codex.log`) runs from sleight-arch's shell and has not started a round yet, so it runs on the fix.
- Queued from sleight-arch's shell: sleight's Firefox b6 x3 (`race-firefox-b6.log`, after the safari-term, safari-codex and safari-r1
  logs say `done`), then the sleight-in-Codex smoke in Firefox (both arms, wikipedia and form-checkout, `smoke-codex-sleight.sh`,
  log `race-smoke-codex-sleight.log`). Its dry run passed, and `~/.codex-bench-sleight` was set up 17:53Z. A clear kills these
  shell jobs: rerun the same commands (in `race-1017`, see each log's name).
- `nohup` watchdog `race-1017/watchdog.sh` (pid 584, log `watchdog.log`): exits with an ALERT line if the live lock is held with no round
  for 3 min, a round runs over 40 min, or Safari stays up with no round for 3 min. Nobody is woken after the clear, so read its log first.
- `touch ~/Projects/sleight-wt/race-1017/pause` pauses every race script between rounds (tested 19:51Z: no round started in 90 s).

**Order from here:**
1. Safari r2 and r3 are running, with Codex x3 and the r1 reruns queued. Score Safari when they finish.
2. sleight's Firefox rerun on the current build (queued).
3. sleight inside Codex (arms `codex-sleight` gpt-6-luna, `codex-sleight-sol` gpt-6.1-sol): live smoke in Firefox (queued), then
   3 rounds each in Firefox and Safari. Codex in Chrome/Helium is blocked (item SF1).
4. Claude in Chrome: first live smoke of the Allow watcher (bench/fowl/chrome-allow.*) from Terminal, then 3 Chrome rounds; then
   reconnect GitHub (owner item).
5. Top-ups to 5 rounds for every pair within 20% (Firefox about 16, Chrome and Helium a few, Safari once scored).
6. sleight's native claim arm on the final build, then the release pass and the 1.3.0 tag (owner's call).

**Owner items:**
- MB1 (ledger): turbo's menu bar item says "sleight disconnected" whenever a session's turbo worker runs. Proposed: show it only
  while connected, paused or cleanup-required. Built after the race.
- GitHub Integration on claude.ai was disconnected 14:1xZ for the Claude in Chrome rounds; sleight-arch reconnects it afterwards at
  claude.ai/customize/connectors/yours/id/integration-github (owner does a passkey if asked).
- Changed with the owner's OK for Claude in Chrome: its panel mode in the benchmark profile is "Skip all approvals", and claude.ai's
  Claude in Chrome site default is "Allow all sites" (also covers the desktop app's built-in browser). Neither reached the per-action
  prompt. The watcher clicks it.
- FM6 (ledger): a drag-endpoint fix needs sleight to read page text values (AXValue), which LAWS excludes. Owner decides.
- The Codex arm in Chrome and Helium is blocked (SF1). Chrome's profile copy needs Terminal, the approvals file needs sleight-arch's shell.
- The 1.3.0 tag and publishing.

**Opt-in flags still opt-in:** `SLEIGHT_OPEN_SHOT=1`, `SLEIGHT_SKILL=screenshot` (SK1 ran excel-edit 50-53 s in 3/3 on the pre-FL1
build; recheck), `SLEIGHT_COMPACT_TOOLBARS=1` (made word-edit ~40% slower; FL1 now leaves Word and Excel unfolded),
`SLEIGHT_COMPACT_CONFIRMATIONS=1` (wording approved by the owner).

**Older owner items.** One "Always allow" click on the VS Code debugger card at the Electron turbo qualification (1.3.1). The engine's Always-allow list has listed only Word and Codex since 2026-10-11 (below). The
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
