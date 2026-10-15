# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-15 00:33 UTC)

Goal (owner): a published head-to-head showing sleight is the fastest computer use plugin for Mac, then 1.3.0, the claim post and
the video. Owner (2026-10-14 evening): everything besides turbo gets release-ready now, so 1.3.0 waits only on turbo v3 (reaffirmed 23:20 UTC, over releasing 1.3.0 without it); lanes stay
busy, and post-release work builds on branches and merges after the tag.
Pushed: `pane/auto-mode` at the commit holding this banner. `~/Projects/sleight` is fast-forwarded to it. There are 0 open PRs, and
public CI is green on 1.2.5. The engine updated to 26.1007.71326 (the watch's baseline follows it), and `--doctor` passes with a live read.

Running (headless, nohup): 12 `codex exec` lanes (launcher `~/Projects/sleight-wt/ledger/start-lane.sh <lane> "<START WITH line>"`,
template `ledger/lane-prompt-codex.md`, prompts and logs in `ledger/lane-runs/`) and the real-page runner (`node
scripts/live-dom-runner.mjs` from `~/Projects/sleight`, pid 39609, log `ledger/lane-runs-runner.log`). Two NOTICEs top LEDGER.md: the
resolved blockers (group 49357, the 300 s compile deadline) and V10 claimable. Restart the runner after merging any runner or
owned-group fix (a runner keeps the code it started with). A lane worktree from 2026-10-13 sits inside the main checkout at
`private/codex/fm1` (registered with git, untracked there). Remove it with `git worktree remove` once FM1's evidence is no longer needed.

Turbo v3 (owner's direction, ROADMAP; design `ledger/opus-turbo-v3-design.md`): our own action layer on the bundled Playwright, 5
always-loaded tools, effects as observations, whole-form fill, background popups that keep their opener, the four rules as one module,
and V8 removing 7,638 library lines, 7,217 test lines, bench/direct-browser2 and 6.8 MB of playwright-core. Lanes and branches
(`private/codex/<id lowercase>`), each item reviewed by another lane as `claims/V-<ID>`: V1, V2, V4, V5, V6 DONE; V4R and V2R DONE and
reviewed; V5R2, V6R2 DONE with reviews running. V3 is in progress. V1R2 hit the stale 120 s compile deadline. sleight-arch cleared it for the next free lane. V10's brief said "after V7" while V7 waits on V10, so
no lane claimed it; sleight-arch dropped the "after" and started lane `codex-v3-v10` (23:10 UTC), which then finishes V7 on top. V9
(bench arm) waits for V7. V8 (removal, `codex/v8` 813bca75) is DONE and passed a Claude review: package 15.4 to 8.2 MB, turbo module
11,029 to 4,710 lines, tests 63,582 to 48,848 lines, 1155 pass. It merges right after the gate (owner), with V8R (restore canonical()
coverage, settle five unreachable modules). Speed-up (owner, 23:25 UTC, because the load holds up their other projects). Lanes run focused tests only (LEDGER NOTICE 3, lane
template step 6). sleight-arch runs one full check per merge. Sonnet-high Claude reviewers take the critical reviews.
`private/v3-integration` (worktree `~/Projects/sleight-wt/v3-int`) holds v1r2, v2r, v4r, v5r2 and v6r2, 1177/1177
direct-browser tests, plus `9721c126` crediting page.mjs's popup code as adapted from FowlBrowser with the MIT text (a Claude audit of
all 51 v3 sources found only that file and snapshot.mjs). Reviews by 23:40 UTC: V1R2, V2R, V4R, V5R2 pass. The FIX items
each have a lane. V10R (in the trust join, Enter or Space could reach a payment button through unverified focus, reload after a payment,
reusable upload offers, a dialog grant that never expires) is on `codex-v3-v10r`. V3R (snapshot password leak, stalled continuation,
stale refs, MIT notice) and V9R (census soft failures) are claimed. V7 is on `codex-v3-v7b`, which wires V10's join into the
installed worker. The load average fell from about 49 to 2.7 within the hour after the switch. V3R passed its re-review and is merged (integration `5dd1eccc`, 1210/1210). V10R's re-review found an iframe focus redirect and a dialog expiry
shorter than a model turn, queued as V10R2 on lane `codex-v3-v10r2`. A lane review of V10R reproduced two HIGH bypasses on real pages (a page redefines
the activeElement or form getter in the main world, and a neutral control sends Enter or a click to a card form): queued as
V10R3 after V10R2, reading authority only from the utility world or CDP. V7 (installed worker, `codex/v7b` 5212de62): a lane
review found Pause/Disconnect expire at 30 s while the refresh is 60 s (V7R, claimed). The Claude review found cleanup that
never releases Chrome's connection after UI or parent loss, a stale upload receipt, an eager first-prompt connect, and browser_open
reaching the DevTools endpoint: V7R2 after V7R. sleight-arch's call: one session keeps its connection between turns and releases it
when the session ends. CS3R2 merged at `566f4d4e` (5691 pass, 0 fail, 49 mod). Before it, offline handoff tests
could quit TextEdit or Preview through real osascript. V9R
passed its re-review. Owner (01:30 UTC): no competitor code in sleight, so LAWS and ROADMAP now say ideas only, written
clean-room. `private/cr1-base` (`a9212d4d`) strips the two FowlBrowser-adapted pieces (page.mjs popupHook and backgroundClick,
snapshot.mjs closedRoots) to stubs, and lane `codex-cr1` rewrites them from the behavior spec in queue/CR1.md without access to
FowlBrowser or the old versions. CR1 is DONE (29/29 real-page). A similarity audit found four constants that came through sleight-arch's spec, so CR2 re-derives
them from HTML and WAI-ARIA on lane `codex-cr2` (base `private/cr2-base`). CR3 follows CR2. It uses the background click for
everything except same-context links and own-activation controls, because the source-text guess missed external scripts. It also
reads each frame in one CDP pass, measured before and after, and carries CR1's review fixes (same-context links became new tabs, closed-root probe budget,
weak fixtures). CR2 is DONE: its re-audit leaves one role-order leftover that sleight-arch sorts at CR3's merge, and it measured the
modifier window (max 6.2 ms over 20 clicks, so 100 ms, down from 1000). CR3 is on lane `codex-cr3`. Trust join: V10R3 moved
authority reads to the utility world. A Claude review then found DOM clobbering (`<img name="activeElement">`). V10R4 fixes it on
`codex-v3-v10r4`, and V10R3 doesn't merge alone. V7R3 passed startup failures and reconnect; V7R4 (Fetch pattern false positives, popup and worker auto-attach) is on
`codex-v3-v7r4`. CR3's review found Cmd-click on submit controls submits into a new tab; sleight-arch measured it 12/12 on
Chromium 1248, and only multi-select options and links also change with Cmd, so CR4 (lane `codex-cr4`) keeps submits in place and
masks by event, and CR5 (queued after CR4) replaces the role list with that measured rule. `private/v3-gate` (sleight-arch, worktree
`~/Projects/sleight-wt/v3-int`) merges every turbo tip (v7r3, v10r3, v9r, cr3) with two seam fixes; its full check passed 6115, 0 fail,
49 mod at `6235142f`. V7R4, V10R4, CR4 and CR5 merge into it as they pass, then V8. Next: CR1, V7, V9R and V10R merge into
v3-integration as they pass, then one full check, then the gate round. Then V9's arm runs the
gate tasks against the targets (26/26, at most 85% of FowlBrowser's 677 s, at most 9 errors, 0 ToolSearch, 0 focus events), then V8 merges.
- v1 stays on pane/auto-mode as fallback and test source, including TG1R2 (with turbo on, the engine's browser path stays
  beside it, owner, LAWS). TF3, TF5, TF6 sit on branches as reference for V5. Measured on v1 in the headless arm:
  non-form tasks 4/5, forms 3/4, form-travel 242 s in 99 calls.
- Turbo-only rounds after TG1R need FowlBrowser's extension socket. Measure from a worktree with `bench/fowl/sleight-surface.patch` and
  `bench/turbo/setup.mjs` from `c0caa5c9` (memory `lessons-2026-10-14-day`). Never kill a running round (unpriced spend marker).

Release readiness: done apart from turbo. CI1, OL1, OL1R merged earlier. CS3 with CS3R and RP2 with RP2R and RP2R2 passed Claude
and sleight-arch reviews and merged at `739a0f87`; the full check there passed 5690, 0 fail, 59 skip, 49 mod, in 41 s. RL1 release
notes are DONE and reviewed on `codex/rl1` (apply at release). The owner chose to drop the codex-cu and devtools bridge arms and say
so in the published coverage. Post-release on branches, merge after the tag: EP-2, EP-6, EP-6R, Q1-1 to Q1-6 reviewed or DONE,
Q1-7 to Q1-17 finishing. EP-4 and EP-5 wait for v3's design to settle.

Owner steps at the Mac: reload FowlBrowser's extension in Helium (Helium isn't on the benchmark allowlist, so sleight-arch can't).
Run the sleight-arm login (`CLAUDE_CONFIG_DIR=~/Library/Caches/sleight-bench/sleight-arm/claude ~/.local/bin/claude auth login`).
Click turbo's opt-in and Chrome's Allow (only a person grants debugger control). Work through `ledger/claim-suite-owner-checklist.md`. This session's own
sleight MCP couldn't start the engine helper after the morning's engine update (fresh clients work). API spend for October: $159.96 of $200.

Next steps, in order:
1. Review P2; merge P2, P3 and P4 together once P4 passes. Merge SR1A, SR1CPR2 and OG1 as they pass.
2. Run the four form tasks headless (TP-style, about $0.20) for an early read on forms.
3. Live qualification in the owner's Chrome "sleight benchmark" profile and Helium. The owner
   clicks Allow on Chrome's prompt once per launch. The gate counts Space switches and focus changes.
4. The turbo gate round (Haiku 5.5, both arms, both orders), only while the owner is away or headless. Then one Opus head-to-head on
   the owner's account.
5. Install the claim-suite arms per CS1 and run the suite with the W8 runner.
6. Apply RP1's CHANGELOG and README proposals, and release 1.3.0 on the owner's call.
After 1.3.0 come Electron (EP-1 to EP-7), slimming the plugin, AM1, and the SR1 and GR1 results.

Owner items: OpenUsage.app relocked the "Claude Code-credentials" keychain item to its own cdhash again at 05:01 UTC; the owner
reset the partition list on 2026-10-14 and keeps OpenUsage (it may relock again on a token refresh). CodexBar was moved to the Trash
and removed from login items on the owner's order (2026-10-14).

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
