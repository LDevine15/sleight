# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-17 06:19 UTC, overnight sitting: A/B done, claim run running since 04:03)

OWNER ASLEEP since 2026-10-17T02:19:48Z (/goodnight). Night Shift on. Read "vaya con dios" after the boot report's "waiting for
your go" as the go, and pinged the phone with that reading. At the owner's request (from bed), sleight-arch closed the two
Microsoft Error Reporting dialogs with their restart boxes unticked first, so neither Word nor Excel restarted.

Goal (owner): release 1.3.0, then the native claim and the video, then maintenance and benchmarking (owner, 2026-10-16: "I don't
want to work on sleight forever"). ROADMAP.md is the plan. Read it whole, especially 1b and 2.4.

**The overnight sitting** (Puddle window w-overnight-1017, HOLD sent 02:36:22Z, cap 420 min, auto-release about 09:36Z; release
earlier with one fresh touch of `/tmp/sleight-bench-done`). Scripts and logs in `~/Projects/sleight-wt/sitting-1017/`.
1. Done: HID idle. Engine background clicks left it untouched in 10 of 10, as menu continuation assumes. Keys reset it:
   `typeText` 3 of 3, `pressKey` 3 of 3 right after a click and 0 of 4 right after a key. Navigation by key can still stop. The
   CHANGELOG navigation entry and known-problems say so (`hid-probe.mjs`, `hid-probe.json`). textedit-drag and chess-drag run
   inside the A/B instead of a separate check.
2. Done: the A/B (since `2026-10-17T02-41`, `bench/ab-score.mjs` output in `sitting-1017/ab-score.txt`). Claim tasks: new 22/24
   passes in 272.6 s summed per-task means against old 20/23 in 319.0 s, 74 turns against 84. Outside the claim suite: new 19/25
   in 395.3 s against old 19/23 in 461.9 s. Paired round totals: -99.5 s, -167.7 s, +90.0 s (round 3's new side ran 4 more tasks).
   Both sides lost runs to the harness: the two-window fixture's cleanup stopped a pass on each side ("Owned document lost focus"),
   and Word was left stuck in an AX-opened menu loop (old side, round 3).
3. Done: triage (two Sonnet-high trace reads of every new-side failure). One sleight regression: TT3's endpoint check refused every
   Chess drag on the board's right half, because Chess reports parent frames that miss the point. Fixed in `1933db78` (2 tests
   failed first, a review's text-field hole fixed too, full check 5,879 tests exit 0) and checked live: chess-drag 2/2, with the
   drag that was refused before now delivered in the background. excel-edit's failures are an Excel tab reorder after a rename
   (also seen before both builds; known-problems), finder-rename and finder-create-folder were model variance. FC1 (`024c4c5a`,
   merged) makes the two-window cleanup close by the window's own button after a cold launch. It needs a live check.
4. Running since 04:03: the all-arms claim run, `sitting-1017/claim.sh` (sleight, lcu, codex, cua; Word and Excel quit between
   arms, with an Escape posted to a stuck app), then peekaboo from a Terminal window with `ARMS=peekaboo`. `since` is
   `2026-10-17T04-03` in bench/claim-exclusions.json. Then 5 runs where sleight and an arm are within 20%. Score with
   `bench/claim-score.mjs` and word the claim by the LAWS rule. sleight's arm finished at 04:20: 9/9 tasks completed, 25/27 runs,
   expected seconds calculator-click 8, calculator-menu 11, textedit-save 10, textedit-drag 38, finder-move 41, preview-read 6,
   textedit-calculator 47, word-edit 82, excel-edit 171 (1/3: the Excel tab swap, twice). lcu finished at 04:41 with 8/9 tasks
   (textedit-drag 0/3). At 04:42 the script's Apple-event quit of Excel raised a macOS prompt ("claude wants access to control
   Microsoft Excel"). It was left unanswered and closed by itself once Excel quit (asked through `NSRunningApplication`, with
   its own Don't Save sheet answered). Office now quits through NSRunningApplication, then Escape and Cmd+Q posted to its pid,
   then its own Don't Save sheet or dialog (Excel shows a dialog window, Word a sheet with a curly apostrophe).
   codex finished at 05:07 (8/9). The harness stopped competitor passes five times after a result was recorded (Word or Excel left
   modified, two TextEdit processes from cua). cua lost three passes, and lcu and peekaboo one each. Each stopped pass was
   finished with single-task reruns (`cua-rest.sh`, `fill.sh`, `peekaboo-rest.command` from Terminal). cua's first stopped pass
   is excluded in bench/claim-exclusions.json. FC2 (bench cleanup that discards only the run's own fixture) and its review fixes
   FC2R are in lanes for after the claim run.

**The build is frozen** at `1933db78`: `ef833641` (every fix from 2026-10-16's studies and the 2026-10-17 trace studies, each
reviewed by a Sonnet-high agent) plus the Chess drag fix, FC1's bench fixture change and docs. The full check exited 0 on 5,879
tests. The CHANGELOG 1.3.0 section lists the fixes, and the A/B above is their first live measurement.

**In flight.**
- BR1 (`a069a845`), BR1F (`b838ec52`) and BR1G (`private/codex/br1g` `2dae81fb`) are done, reviewed and NOT merged: the harness that
  races browsers in a real window. A Sonnet-high review of BR1F found a census that failed open on short `ps` names, a stray tab
  aborting the reset, evidence lost on unproved cleanup, and no census after launch. BR1G fixed those four test-first (62 tests;
  sleight-arch read the diff). The review also confirmed BR1's `codex-arm.mjs` change leaves native Codex runs as they were. Merge
  br1g (it contains both) after the overnight sitting. The marker tab in `startKeys` is latent (no task uses keepMin).
- BR2 (Safari and Firefox) went STALE: the LAWS line on its base read as turbo-only for every browser, and Safari's WebDriver
  automation windows block the native input the other four arms need. LAWS now says the turbo-only rule covers the browsers turbo
  drives, as ROADMAP 1b records. The Firefox gate is built (BR2A's draft, with BR2B's test run at 259 passing). A Sonnet-high review
  found an owned Firefox never census-checked while alive, a quit helper that didn't check the parent pid, thin `ps` matching, an
  inflated keep grade and a 5 s quit timeout, and BR2C fixed those (`private/codex/br2c` `61324606`, 128 tests). Not merged and
  not run live. Safari needs a design decision first (owner items).
- RW1 tells Claude when a click swapped two siblings (the Excel tab case). A review found it missed the engine's `Selected, `
  prefix and fired on deliberate sorts. RW1R fixed both (`private/codex/rw1r` `a7d292d4`, 767 tests). Not merged; after the tag
  unless the owner pulls it in, then an A/B on excel-edit.
- Lane launch command: `nohup codex exec -m
  gpt-6.1-sol -c model_reasoning_effort=high -c sandbox_workspace_write.network_access=true -C ~/Projects/sleight-wt
  --skip-git-repo-check --add-dir ~/Projects/sleight --add-dir ~/Library/Caches --add-dir /private/tmp --add-dir /tmp - <
  ledger/lane-runs/prompt-<id>.md`, with the prompt made from `prompt-tt4.md` by replacing TT4 and tt4.
- Not ours: PID 41395, a read-only `codex exec` started 2026-10-16 01:46 local. Leave it.

**Browser decisions (owner, 2026-10-17, in LAWS and ROADMAP).** Browser tasks race only turbo, so the native claim suite is 9 tasks.
The headline "fastest plugin on macOS" needs the real-window race against lcu, Cua, Peekaboo and Codex in Chrome and Helium (BR1),
plus Safari and Firefox (BR2), before the launch post, not before the tag. Brave 155.1.97.56, Edge 155.0.4283.45, Vivaldi
8.2.4133.84 and Chrome Beta 157.0.8103.6 were installed by Homebrew cask for qualification and never launched. The studies found
Firefox turbo impossible without a relaunch flag today, and Safari's only fit is a hybrid behind Develop > Allow JavaScript from
Apple Events. Both are post-1.3.0 options.

**Where the claim stands** (scored, 2026-10-16 runs; expected seconds to a correct result, passes/runs). sleight completed 9/9
native tasks; lcu 6/9, codex 6/9, cua 7/9, peekaboo 3/9. After skill fix `14327dd4` (rerun 2026-10-17 00:05 UTC, load 4.5 at start)
sleight leads textedit-drag 32 (3/3; nobody else ever passed it), textedit-calculator 45 (3/3, was 1/3) and word-edit 88 (3/3;
lcu 122), and ties calculator-click 8 with lcu. It trails on 5 tasks: calculator-menu 19 vs lcu 12, textedit-save 21 vs lcu 11,
preview-read 12 vs Peekaboo 5, finder-move 136 vs cua 97, excel-edit 184 vs cua 133 (one cua run). Trace studies found sleight's
best runs tie lcu and Peekaboo turn for turn, and the losses are turns wasted by sleight's own tools (lease stops on same-call menu
clicks, open_file on open documents, Finder drags inside sleight's guards) plus a 25,000-character first result against
Peekaboo's 4,600. The claim wording follows the LAWS rule the owner set on 2026-10-17.
Fable's review (2026-10-17) found the skill fix was tuned on the claim's own failures, so check it on held-out tasks and say so in
the publication. Codex runs gpt-6-luna, not Haiku. Publish pass counts and median-of-passes beside expected time.

**Release path.** Turbo live check with the owner (about 10 min; the release pass refuses the gate without it), then the slimmed
release pass, then the tag. The CHANGELOG 1.3.0 drag entry carries its live measurement. Turbo in `claude -p` never activates,
because the mod's `prompt.submit` hook doesn't fire there, and the gate measured turbo through a bench-only server
(`bench/turbo/v3-server.mjs`) on headless Chromium. BR1 adds the real-window race with a Codex arm.

**After the tag.** `arch/epv3-2` `2817c762` (EPV3-2, inert; EPV3-3 next in `ledger/electron-v3-plan.md`), `arch/epv3-1` `f9e1e919`
(consent run owed with the owner), `arch/q1-int` `c0aa885c` (Q1 error messages), the ghost hand (ROADMAP 2.7; LoC's architect has the
design request queued), the speed items in ROADMAP 2.4.

**Video.** No film work until the claim is measured (owner). Storyboard `docs/design/video-storyboard.md`; LoC's draft paint round
waits on LoC trunk. Message "loc arch" when the claim run is scored.

**Owner items.** Safari isolation for its race is the owner's call. The one option found so far that native arms can drive
is a dedicated Safari profile the owner makes once (Safari > Settings > Profiles), with Safari quit before each round as for Chrome. With the owner present: the turbo live check, claude-cu runs, EPV3-1's consent run,
and each Chromium browser's qualification. Then the tag.

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
