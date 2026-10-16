# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-16 04:15 UTC)

OWNER ASLEEP since 2026-10-16T04:21:57Z (/goodnight). Night Shift on.

**Gate on `adc5fbc9` (04:01 to 04:32 UTC) failed on time** (docs/benchmarks/2026-10-16-gate.md, second section): turbo median
607 s (p90 634) against FowlBrowser's 685 s (p90 706), 89%. Errors, focus and ToolSearch targets are met, and both arms score 26/26
or 25/26. The extra time against the A/B is model turns on forms. 193 of 254 empty `find` reads used `a|b` alternation, which the
literal match never met. `arch/find-alt` `0d1bcfa0` fixes that and the hidden-radio click (focused and 8 real-page files pass).
Puddle was told FAIL, so there's no Opus W2. **Find A/B (05:25 to 05:43):** find-alt median 572 s against 622 s over 3 rounds
(faster in 2 of 3, empty finds 29 of 68 down to 9 of 83, docs/benchmarks/2026-10-16-turbo-ab.md). Next, after a full check it merges into
v3-gate for a new gate. `arch/gate-next` `66ada2bd` is v3-gate plus find-alt plus world-login (focused tests pass). Its full
check runs in the next window. **Sleight native arm, first try (05:43):** it stopped after 3 tasks. Calculator was still open from the
owner's claude-cu test (sleight-arch quit it normally), and the TextEdit fixture couldn't quit TextEdit: it restored "Untitled 9" and
"Untitled 10" from the owner's iCloud TextEdit folder, plus a window without a name (likely the iCloud Open panel). TextEdit is still
running with them, untouched (owner's leftovers to decide). The world fixture's TextEdit launch lacks the
`-ApplePersistenceIgnoreState YES -NSShowAppCentricOpenPanelInsteadOfUntitledFile NO -NSDocumentSaveNewDocumentsToCloud NO`
arguments other bench launchers pass (fix before the 9 TextEdit tasks run). Next window (about 06:40, cap 60):
`ledger/claims/GATE2/window-native-check.sh`, with the 18 non-TextEdit sleight tasks, then the full check of gate-next. The about-05:30 window runs `ledger/claims/GATE2/window-ab-then-native.sh`. It first runs a
turbo A/B of v3-gate against find-alt over 3 rounds (prefix `abf`), then the sleight native arm. One release touch ends it (cap 75 min, granted).

**W4 (06:41 to 06:43 UTC, loaded: a Puddle suite ran until 06:43:26).** The sleight native arm passed calculator-click (7.5 s) and calculator-menu (10.3 s), then failed
chess-drag (73.2 s) and stopped on "Owned Chess fixture window cleanup unconfirmed" (AX read -25205 AXTitle). Chess isn't running
now. The full check of `arch/gate-next` passed its tests (6873, 0 fail, 399 skipped) and mod tests (49/49). It failed
`claude plugin validate` because `~/.local/bin/claude` had disappeared, so `claude` resolved to Homebrew's 2.1.231. sleight-arch
restored the symlink to `~/.local/share/claude/versions/2.1.289`, and validation then passed. `~/.local/bin` changed at 03:33 UTC,
during the owner's interactive claude-cu sessions, which showed "Auto-update failed". The arm's own CLI ran its auto-updater with the
owner's HOME (the benchmark sets `DISABLE_AUTOUPDATER=1`, the owner's terminal didn't), which most likely removed the symlink.
`install.cjs` only copies the binary inside the package. Owner commands for arm CLIs need `DISABLE_AUTOUPDATER=1`. **v3-gate is now `66ada2bd`** (find-alt plus
world-login, fast-forwarded and pushed). Asked Puddle for a gate window (5 rounds on `66ada2bd`) and a window for the sleight arm's
other 15 tasks (without chess-drag and the 9 TextEdit tasks).

**Rest of the night (owner asleep until about 12:00 UTC, all approved).**
1. Superseded (gate failed): W2 would have opened at about 05:30 for Opus (5 rounds, `MODEL=opus ledger/claims/GATE2/gate5.sh 5`). A full check of
   `arch/world-login` merged into v3-gate follows in the same window, which a second touch releases. If it fails: study the slow runs, fix, A/B, and retry.
2. The native first pass, one arm per Puddle window: `ledger/claims/CS3/native-arm.sh ARM [tasks to resume]`, in the order sleight,
   codex, lcu, cua, peekaboo. It runs from `~/Projects/sleight-wt/world-login`, logs to `ledger/claims/CS3/runs/`, stops by 12:00 UTC,
   and skips claude-cu (owner-present only).
3. Review the EPV3-2 agent's report (`arch/epv3-2`, `ledger/claims/EPV3-2/REPORT.md`) when the agent finishes.
4. `arch/v8-int` `59345e0b` (V8 and V8R on v3-gate, 8,640 KB) needs a full check before it merges.
5. Rewrite and push this banner after every result (owner: trust disk over compaction).

loc-arch is paused (video held). The owner may stop its monitors.

**Gate rounds 1 to 5, 01:28 to 02:00 UTC** ([docs/benchmarks/2026-10-16-gate.md](../benchmarks/2026-10-16-gate.md), v3-gate
`ad602918`, product code as of `a544e303`, Haiku 5.5 high, owner's login, `--world`, Puddle held). Turbo median 603 s (p90 646 s),
197 calls, 4 errors. FowlBrowser median 677 s (p90 711 s), 292 calls, 8 errors. Turbo took 89% of FowlBrowser's time; the 575 s
target (85%) isn't met (rounds of 573 s and 580 s came close). Both 26/26 under the owner's scoring in every round, 0 focus events
(observer coverage full after the stale-pid fix), 0 ToolSearch. FowlBrowser paid $268 unpriced in 8 of 10 form-checkout runs.

**Turbo A/B, 02:28 to 02:58 UTC** ([docs/benchmarks/2026-10-16-turbo-ab.md](../benchmarks/2026-10-16-turbo-ab.md)): the
candidate `arch/gate-cand` beat v3-gate in all 5 interleaved rounds, median 542 s against 581 s (7%), 0 errors in 130 runs against
3 to 5 per round. Its full check passed (exit 0 with 0 of 6862 tests failing and 397 real-page tests skipped, mod 49/49), and 19
real-page files pass with `SLEIGHT_LIVE_DOM_TEST=1`. **v3-gate is now `adc5fbc9`** (fast-forwarded to the candidate, pushed). It
holds `SLEIGHT_CONFIRM_PAYMENTS=never` and the forgive and form fixes. Against FowlBrowser's 677 s, 542 s would be 80%, which
is a projection only.

**Next.** Gate rounds (5) with both arms on v3-gate `adc5fbc9` when Puddle sends "HOLD live" (promised for about 04:00 UTC,
`gate5.sh 5`, defaults), then the Opus head-to-head (`MODEL=opus gate5.sh`).

**Native claim suite (owner agreed 2026-10-16 03:20 UTC).** Benches don't wait for Electron. First a pass of one run per arm per task
(162 runs, `ledger/claims/CS3/plan-runs1.json`) to find where sleight loses, then the five-run claim. `arch/world-login` at
`816c42dd` runs the native world suite on the owner's login, one isolated config per arm (focused tests pass). It merges into
v3-gate after tonight's gate rounds, with a full check. The owner logged in all five native arm configs, and
`node bench/world/login-readiness.mjs` reads them all as logged in. The claude-cu native root is installed (2.1.289), with onboarding,
folder trust and `/mcp` computer-use enabled in `claude-cu/work`. Its app approvals last one session, with no "always allow" in the
CLI, so its runs need the owner present. Whether the bench's strict empty MCP config hides its built-in `computer-use` server is
unchecked. The owner is away 2026-10-16 until about 12:00 UTC and approved the first pass overnight without claude-cu (135 runs, 5 arms), one arm per Puddle gap, after the gate and Opus rounds. Stop by 12:00 UTC. Puddle's windows (agreed 03:50 UTC) open at about 04:00 for the gate and about 05:30 for Opus if the gate passes. After that each window holds one arm and is followed by about 45 min of Puddle's lanes. Arm order: sleight, Codex, LCU, Cua, Peekaboo. Resume an interrupted arm with `--tasks`. EPV3-1's consent run is still owed: its
cards open from the "sleight" menu bar item, not a popup.

**Electron.** Agent `epv3-2` builds EPV3-2 on `arch/epv3-2` (`2bbdf404` is v3-gate plus EPV3-1, with the v3-context conflict resolved
by sleight-arch). Step 0 ports EPV3-1's electron-context test fake to AD1's seal evidence (43 of 50 failed on the merged base).

**Video.** No work until the claim suite with native apps backs "fastest on macOS" (owner). LoC's draft paint round is parked unsent
on LoC trunk `d8c3ef73` (`artifacts/ARCH-IMAGEGEN-R18/`). The storyboard is `340ba5e2`.

Goal (owner): the published head-to-head showing sleight is the fastest computer use plugin for Mac, then 1.3.0, the claim post and
the video. ROADMAP.md is the plan. Read it whole.

**Earlier: gate round 3, 2026-10-15 21:19 UTC** ([docs/benchmarks/2026-10-15-gate.md](../benchmarks/2026-10-15-gate.md),
v3-gate `cddc7895`, Haiku 5.5 high, owner's login, `--world`). Turbo 26/26 under the owner's scoring (form-checkout asks before an
unpriced payment, LAWS; the runner shows 24/26), 590 s, 197 calls, 2 errors. FowlBrowser 26/26 (paid $268 unpriced twice), 750 s,
276 calls, 7 errors. Both 0 focus events and 0 ToolSearch. A claim needs the median of at least 5 rounds on the release build.
Earlier that day, the 18:26 UTC round had turbo at 14/26 checked with 31 errors (arm limits), and the 20:07 UTC round at 855 s (slow
forms). Each round takes about 8 minutes. The gate script is `~/Projects/sleight-wt/ledger/claims/GATE2/gate.sh`: four passes that
alternate the arm order per browser order, and an EXIT trap that touches `/tmp/sleight-bench-done`.

**In flight at the flush.**
- Q1 is integrated on `arch/q1-int` at `0022e9c2` (`~/Projects/sleight-wt/q1-int`, from pane/auto-mode): all 17 error-message
  fixes, Q1-12 reworked on live engine evidence (1-based line, 0-based column), 584/584 focused tests (`ledger/claims/Q1/INTEGRATION.md`).
  It adds about 150 characters per error across 22 fixture errors. Q1-17's notice now says what ran (`c0aa885c`: a syntax
  error did not run, a runtime error may have run up to it). Merges after the 1.3.0 tag.
- No gate round or benchmark is running. HOLD was released at 02:00:30 UTC.

Branches (all on `private`, pushed):
- `pane/auto-mode` at the commit holding this banner (RC1 to RC1R3). `~/Projects/sleight` is fast-forwarded to it. 0 open PRs.
- `v3-gate` at `adc5fbc9` (`~/Projects/sleight-wt/v3-int`) is the release build. It is turbo v3 plus the bench funding, arm fixes,
  closed-root controls, form speed and option pickers (records in `ledger/claims/GATE2/`), all of AD1 merged as `9585d253`
  (`GATE2/gate-ad1-merge.md`), and the read-redaction fix. Full check on `9585d253` (2026-10-16 01:10 UTC) passed 6414 of 6809 with
  395 skipped (the real-page files skip without `SLEIGHT_LIVE_DOM_TEST=1`). A six-task smoke round there took 191 s against 216 s in
  round 3, and click latency is +4 ms. In that smoke round the focus column read "unqualified" because the host window observer
  logged `window:false`. Check that focus is measured again before the gate rounds.
- `arch/epv3-1` at `f9e1e919` (Electron step 1: the per-app debugger consent card and app-document identity, inert until EPV3-7,
  `ledger/claims/EPV3-1/REPORT.md`). It needs an owner-operated consent run (command in the report). It merges after the tag.
- After the gate (owner): `codex/v8` `813bca75`, then V8R (queued).

Next for the gate, in order:
1. Done 2026-10-16 (5 rounds, above). For the candidate's A/B and any later gate rounds (the owner OK'd running them whenever,
   2026-10-15 21:30 UTC), before each: ask
   Puddle's architect for HOLD (`ListAgents`, `SendMessage` to "puddle arch"), wait for "HOLD live", delete
   `/tmp/sleight-bench-done`, check the Mac has been idle a few minutes (`ioreg -c IOHIDSystem | awk '/HIDIdleTime/'`), run both
   preflights with `--world`, then `~/Projects/sleight-wt/ledger/claims/GATE2/gate5.sh [rounds]`. Report the median per arm.
2. Done: `SLEIGHT_CONFIRM_PAYMENTS=never` is in v3-gate `adc5fbc9`.
3. One Opus head-to-head, then merge v3-gate into pane/auto-mode, V8 and V8R, the release pass, RP1's CHANGELOG/README, the tag.
4. Done: EPV3-1's Swift payment sheet accepts exactly once and cancel, like the JS side (`f9e1e919`).

Bench setup facts (2026-10-15): the bench arms log in per config dir. `sleight-turbo` and `fowlbrowser` arm configs are logged in
(Max). Without `--world`, the FowlBrowser arm uses `~/Library/Caches/sleight-bench/fowl-claude-config`, which is NOT logged in, so
gate rounds use `--world` (both arms on the pinned Claude Code 2.1.289). FowlBrowser's extension is loaded unpacked from
`~/Library/Application Support/FowlBrowser/extension` in Chrome's "sleight benchmark" profile and in Helium (sockets in
`~/.fowlbrowser/`). macOS denies reading Chrome's Local State from this session; `ledger/claims/CS2/plans.json` named the profile
folder `Profile 7`, but `open --args --profile-directory="Profile 7"` opened the owner's normal profile, so that mapping is unreliable.

Haiku 5.5 latency (2026-10-15, turbo arm, 138 gaps): median 2.0 s between tool calls, p90 3.5 s, max 4.4 s. Thinking took a median 0.35 s.

After 1.3.0 (ROADMAP section 2) come Electron on v3 (EPV3-1 to EPV3-8, plan `ledger/electron-v3-plan.md` reviewed MERGE), the claim
suite, Q1-7 to Q1-17 reviews, IN1 to IN4 on sleight-arch's calls.

How work runs: agents (Sonnet high) build and review, and sleight-arch integrates and runs one full check per merge. Every
real-page test needs `SLEIGHT_LIVE_DOM_TEST=1` or it skips silently. Agents never `pkill -f`. Competitor code is never adapted
(LAWS). No Codex lane is running. The real-page runner (`node scripts/live-dom-runner.mjs`, pid 39609) is still up from 2026-10-14.

Owner items: OpenUsage.app may relock the "Claude Code-credentials" keychain item on a token refresh (owner keeps it, 2026-10-14).
A lane worktree from 2026-10-13 sits inside the main checkout at `private/codex/fm1`. Remove it with `git worktree remove` once
FM1's evidence is no longer needed. About 20 temporary browser profiles named `sleight-bench-v3-*` remain in the temp dir, left by bench runs.

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

**Benchmark.** Claude arms run on the owner's Anthropic account login, Haiku 5.5 at high (LAWS, 2026-10-15). `bench/fowl/rounds.sh`
runs every Claude arm on the login since `83fbf6b4`. Browser Use needs an API key and runs only in its own round. `--surfaces browser,computer` runs the real suite with the extension browser API. Chains of
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
