# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-19 05:00 UTC)

**Since the clear (05:00Z).** Release line `pane/auto-mode` dbc7925d. Pay-gate merged, with a checkout-link fix 8c6b08ca after
the live rounds (full check 8318 tests 0 fail). On engine 26.1013.40934 (b10, Haiku), sleight's Safari total is 567.1 s expected total,
fastest on 10 of 12, and Firefox 555.5 s, 10 of 12, every run passing. The competitor numbers it beats are from 26.1007.71326.
Owner decisions (LAWS, ROADMAP): engine updates no longer force reruns, since every result records its engine version, and
a compatibility check after every update comes in 1.3.1 (4f). Also, 4b runs the luna pair for 1.3.0 and the Sol pair for 1.3.1.
The tag path is now the Safari r2 rerun (running), block b12 (codex-sleight luna Safari and Firefox x3, `race-1017/block-b12.command`,
started by `swap-b12.sh` once r2 ends), top-ups to 5 for pairs within 20%, EV1 (engine versions on results, `claude/ev1`,
building), release pass, hub and README, then the owner's go. 1.3.1 `claude/p131-integration` f858cf8b (codex-turbo, FU1, gate
fix) needs its full check, and 4f builds on `claude/p131-compat`. 1.4.0 `claude/p140` a96092aa holds analytics, Cursor and AM1
(focused tests pass, full check owed, AM1 live rerun owed after its FOCUS_CHANGED stop). Items below marked as in flight at the
clear are superseded by this paragraph.

**Release line** `pane/auto-mode` = main checkout. It holds the race fixes ft1, fs1 and md1, plus sec130, es1, ff1, rg1r2, fl3,
form-2fa, the Safari harness fixes, mdn-note, OH1, the FM3 port (engine Chromium tab path only), list-pick, the native
sleight-in-Codex claim arms with the Calculator reader fix, the benchmark hub, and the Codex plugin with the dropdown's host line
(`claude/codex-plugin` c8ac627b, merged at the clear; one live Codex rerun with the owner is still owed, as cxp1-REPORT.md describes). The flush full check, with the Codex plugin merged, ran 8279 tests
with no failures, and lint is clean. LAWS gained the Codex auto-approval rule.

**In flight at the clear** (Opus agents in the old session, which may stop at the clear: check each branch first):
- `claude/pay-gate` d39236bb: the engine-path payment gate with sleight's card. Both security review rounds are done (38/38,
  1441 focused and 2528 adversarial headless tests pass). It is NOT merged: the merge conflicts with the Codex plugin in
  launch.mjs and relay.mjs. Resolve that first next session, keeping both sides, then run the full check. Live checks are still
  owed: one Sol and one Haiku Firefox form-checkout and a Safari confirm sheet.
- `claude/codex-turbo` (no pushed commit yet): turbo inside Codex for 1.3.1, in the worktree `~/Projects/sleight-wt/codex-turbo`.
  The report goes to ledger/p130/cxt1-REPORT.md. If nothing was pushed, restart it from the ROADMAP 4e brief.
- `codex/fu1` 50438a18: the Sol lane is DONE (claims/FU1). It needs a Sonnet-high review, then a merge into `claude/p131-integration`.

**1.3.1 branch** `claude/p131-integration` 199bf5c7 holds every 1.3.1 branch: pm1, so1 with SF1R, OH2, EL4, and AS-3's
`browser_open` behind `SLEIGHT_BROWSER_CORE=1`. Its full check hasn't run. Still to come: FU1 and codex-turbo. AS-9's runner is
`claude/as9` fc9ce104 (ledger/p130/as9-PLAN.md). It needs an away window with every other engine client closed (11 were running at
02:25Z), so it's the owner's to schedule. AS-8 and TB2 are closed (owner).

**Owner checks done on 2026-10-19.** The owner ran the Codex plugin interactively in `~/.codex-sleight-check`. Calculator gave
144 and TextEdit typed its line. The approval appeared as Codex's own prompt offering one time or always, and the owner chose
always, which put TextEdit in preapproved.json. com.apple.Terminal joined the same list through always-allow while sleight-arch
read the Terminal window.

**Engine changed mid-race.** ChatGPT went from 26.1007.71326 to 26.1013.40934 on 2026-10-18 at 21:47Z. An action now takes about
1.0-1.1 s, against about 0.6 s before, and the latency A/B saw the same on the old and new builds. The engine arms' results
(codex, lcu, sleight, codex-sleight) must be rerun on the new engine, while cua's and Peekaboo's results stand. The new engine
leaves an unproven AXDialog window in driven apps, which the harness and the Calculator reader now skip.

**Next steps:**
1. Done 03:00Z: pay-gate merged (7a129a4a).
2. Done 03:05Z: 1.3.1 integration 4abeff67 pushed with FU1 and codex-turbo.
3. Final runs on the new engine, in an away window, through one queue-runner Terminal window rather than one window per job
   (the owner flagged the pile-up):
   - Safari and Firefox x3 for sleight, codex and lcu;
   - codex-sleight and codex-sleight-sol x3 against codex and a new codex-sol baseline (ROADMAP 4b);
   - the native claim rerun, including the Codex arms;
   - top-ups to 5 where an arm is within 20%;
   - live checks for pay-gate (one Sol and one Haiku Firefox form-checkout, plus a Safari confirm sheet), Codex turbo, and the AS-3 A/B.
4. Regenerate the hub (`node bench/results-hub.mjs`), merge `claude/insights-readme` b92792ff, fill its README `TODO(final)`
   markers through the humanizer, run the release pass, and tag (owner's call).

**Running across the clear:** the race watchdog (`race-1017/watchdog.sh`, pid 63290, nohup), harmless while idle. Nothing else
runs, since the Codex lanes have exited and the live lock and `/tmp/sleight-hold` are both clear.

**Where the claim stands (Haiku 5.5 high, real windows).** Native 9 tasks "fastest", 8 of 9, 251 s against claude-cu's 454 s (lost
preview-read to Peekaboo). App tasks 3 of 3. Chrome and Helium turbo 12 of 13 each. Firefox 10 of 12 (older build). Safari is complete (3 rounds an arm, all reruns done 23:35Z): sleight fastest on 9 of 12
by expected time, total 670.1 s, the only arm that passed all 12 tasks. Codex leads form-travel and mdn, and Peekaboo leads
wikipedia (17.6 against 18.0). By the owner's loss rule (a faster passing run also counts), lcu's one 42.3 s form-checkout pass
makes that task a loss too. form-settings is now sleight's (167.0 against cua's 206.3), though the two-factor switch can make it
ask (LAWS). Fixes for form-travel, mdn and form-checkout are on ft1, fs1 and md1. Close pairs for top-ups: form-travel, wikipedia
and mdn against Codex and Peekaboo, form-settings against cua.

**Running now.**
- The race is idle since Safari finished at 23:35Z. Neither the live lock nor `/tmp/sleight-hold` exists.
- `nohup` watchdog `race-1017/watchdog.sh` (pid 63290, log `watchdog.log`): ALERT and exit if the live lock is held with no round
  for 3 min, a round runs over 40 min, or Safari stays up with no round. Read it first after the clear.

**Order from here.**
1. Safari is scored (`node bench/fowl/race-score.mjs ~/Projects/sleight-wt/race-1017/safari-*-r[0-9]*`).
2. Done 23:5xZ (0917b8e9).
3. Live checks the merges need first: sec130's engine card text for the consent host and a press_key probe against a frontmost
   consent-host card, and ft1's Page Down in Safari's and Firefox's long lists.
4. sleight's Safari x3 and Firefox x3 on the new build, rescore, then one top-up round to 5 for pairs still within 20%.
5. sleight-in-Codex smoke and rounds; Claude in Chrome rounds (Allow watcher) and reconnect GitHub; native claim rerun on the final
   build, then the release pass (including MB1 live with turbo connected) and the 1.3.0 tag (owner's call).
6. 1.3.1: merge the post-1.3.0 branches in the order above, then validation in an away window with the owner, covering Electron qualification
   (one Always allow click; watch the first relaunch of the real VS Code), ghost hand capture test (decides capture `visible`) and
   cost pass, WK4 and DC1 live, AM1 fixtures, the flag A/Bs (GA1T2, TS3, FA1, WB1/WB2, SO1), then the 1.3.1 tag.
7. Launch video (art greenlit, loc arch directs). Film captures after the 1.3.0 pass with the lid open, owner typing live in the
   trick. cap1's recorder runs from a Terminal.app .command (Terminal already holds Screen Recording); send loc arch a 5 s test
   stream and sync.json first, then the final numbers and the playbill CSV.

**Owner items.** The 1.3.0 tag and publishing. GitHub Integration on claude.ai reconnect after the Claude in Chrome rounds
(passkey if asked). The capture sitting (lid open, live typing). Electron qualification's one Always allow click.

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
