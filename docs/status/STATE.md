# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-19 17:58 UTC, flushed before the owner's clear)

Goal (owner, 2026-10-19): push 1.3.1 public today when every check is done (flag A/Bs and AS-3 included, the release push is
approved), then validate and release 1.4.0 the same day under the LAWS release-validation rule (reuse 1.3.1's runs as the A
side). The ledger (`~/Projects/sleight-wt/ledger/LEDGER.md`) records every result and ruling in time order. Builds, fix rounds
and integrations go to Sol codex lanes (Claude used 10% of the owner's week in 2-3 h). Sonnet-high reviews and Fable studies
stay on Claude.

**1.3.0, released 2026-10-19.** Tag `v1.3.0` on `ca2188b4`, public `main` and the private repo, GitHub release from the CHANGELOG.
Public CI runs on Node 24 (the Node ChatGPT bundles). The private repo's org ruleset 22105960 refuses workflow edits; the owner
okayed one toggle (disable, push, re-enable, verified active). Release line `pane/auto-mode` c4625506 (private, local, main
checkout). The owner's installed copy is 1.3.0 (`claude plugin update`, reads from the main checkout). Claim: native "fastest" 8 of
9 (251.2 s against 453.9 s), app 3 of 3, Chrome turbo "fastest" 10 of 13 on the release build (258.9 s against 447.8 s), Safari and
Firefox "fastest" 11 of 12 (592.1 s, 557.1 s), sleight inside Codex (luna) ahead of Codex on 9 and 8 of 12, release pass 13 of 13
on Haiku and on Opus. Helium on the release build (2026-10-19, rel130 r1-r5, owner's go): "fastest" on 10 of 13, 264.1 s
against FowlBrowser's 343.6 s, every pair within 20% at 5 runs (README updated, hub not regenerated yet). Known 1.3.0 problems found
since: the startup cache (HS1) and the promo-code Apply stop (PG2), both in known-problems.

**1.3.1, `claude/p131-integration` 60fe1319 (pushed private; full check 9075 tests, 0 fail).** Everything for 1.3.1 is merged
and reviewed: PG2, PG3, compat check and workflow, CF2, CF3, FS split (FS2 Firefox keyboard new-tab route on by default, FS1
description text behind `SLEIGHT_FS=1` after the native A/B lost passes), NT1, DR1 with review fixes, SW1b, TU1, HS1, the live
harnesses G1 (ghost hand H5/H6/H8), G2 (AS-3), G3 (flag A/Bs), G4 (Electron). Live results today: PG3/PG2 stopped before the
unpriced payment 4 of 4; SW1 demoid 2 of 3 before SW1b; compat engine tier PASS, live tier failed on check bugs (CF3 fixed them,
rerun owed). The native FS A/B summed medians of 371.5 s off and 364.3 s on. Runbook: ledger/p130/live-runbook-1019.md.
Still to run, in order: the flag A/Bs (running now), the film T1 take and the compat live rerun. After them come the AS-3 A/B (`bench/fowl/as3-ab.command`,
~1 h 25 min, bar 2.5 s per task), Electron qualification (G4 runner; the owner delegated all its cards on benchmark VS Code
copies), ghost hand H5/H6/H8, SW1b and DR1 rechecks (textedit-window-drag, demoid) and Codex turbo (cxt1, perhaps with one
hook-trust prompt for the owner). Flags that measure faster become defaults, then the version bump, Chrome release pass with the TU1 census,
CHANGELOG date, public push with the history rewrite (prepared and dry-run: ledger/p131/rewrite-REPORT.md, rewrite-identity.sh,
push-rewritten.sh; also rewrite OLD_EMAIL=x for two commits; ruleset toggled around the pushes), tag, GitHub release, update
the owner's installed copy.

**1.4.0, `claude/p140` e58329e1 (pushed private).** Merged: 1.3.1 60fe1319, analytics, Cursor, AM1 and AM1E, CR1+CR3, CR2,
CC1-CC3 (list helper), CC4/CC5 (X5), CC6, CC7+LB4+LB6 (tabc), CC8 (drag labels by AXValue, LAWS), LB1-LB3 (X6 turbo), LB5 (X8
select_window suffix), LB8 (X7 census), X3 analytics validation, X4 held-out fixtures, README and hub H1-H6 plus H3 Pages, and
the CHANGELOG 1.4.0 section. Every branch had a Sonnet-high review; reviews found and fixed a payment-gate bypass on resend
(X5), a drag pass-through hole (DR1), approvals widened for every world pass (X4) and more. Sol lane X11b trimmed the window-selection notice so the lean prompt
ratio is 0.70992 (limit 0.71), with 702 focused tests passing. LB7 (`claude/p140-lb7` 12ca040a) passed its fifth review (MERGE-OK) but reuses ~0% of reads on this Mac (it
stays off while another engine client runs), so sleight-arch did NOT merge it: no measured win. 1.4.0 validation (ROADMAP):
full check, release pass, B rounds against 1.3.1's runs, both sides on the new CC held-out tasks and demoid, analytics (X3),
Pages (`gh api` enable from main /docs after the public push), H7 taste pass (fresh Sonnet read, then the owner). Owner steps,
none blocking the push: one-time logins for the agent-install test (`node bench/agent-install.mjs --setup` prints them), the
Cursor sign-in for its first install (Cursor is listed only after it passes).

**Running across the clear (Terminal windows and nohup lanes keep running).**
- `race-1017/block-flags.command` (pid 89050): the flag A/Bs on race-131 at 60fe1319 (started 17:34:53Z, 5 rounds, ~1 h 35 min,
  logs `race-1017/flags.log`, manifest `flags-manifest.tsv`, score with `node bench/flag-ab.mjs score` from p131-int). It pauses on
  a STOP with `race-1017/flags-pause`.
- `race-1017/cap-t1b.command` (pid 99021): waits for block-flags' "done", then the film T1 take via the runner in
  `~/Projects/sleight-wt/p131-t1` (c30fcf5d), log `~/Movies/sleight-film/t1-take.log`. Send loc arch the folder, take length and
  frame-delta numbers after.
- Worktrees: race-131 at 60fe1319 (the A/B build), race-fx at 1f6efff2 (1.3.0), p131-int, p140, p140-* and p131-* branch worktrees.

**Launch film.** T0b recorded and approved by loc arch (sRGB tagging and name scrubbing added). T1 runner built (plain "Thursday"
front window, Chess 1157x900, payment-free Tidewell checkout); three attempts stopped in setup (Chess open, Chess width, Safari
marker), all fixed. T2 race take (sleight turbo vs FowlBrowser, one task) not built yet. loc arch renders only while
`race-1017/CLEAR` exists and holds `/tmp/sleight-hold` per segment: ask loc arch before removing a hold.

**Opt-in flags still opt-in (A/B running 2026-10-19):** `SLEIGHT_FS=1` (FS1 only), `SLEIGHT_OPEN_SHOT=1`, `SLEIGHT_SKILL=screenshot` (SK1 ran excel-edit 50-53 s in 3/3 on the pre-FL1
build; recheck), `SLEIGHT_COMPACT_TOOLBARS=1` (made word-edit ~40% slower; FL1 now leaves Word and Excel unfolded),
`SLEIGHT_COMPACT_CONFIRMATIONS=1` (wording approved by the owner).

**Gotchas from 2026-10-17.** Never send Apple events to Office from this session (Excel had no Automation grant and a macOS prompt
appeared). Quit fixture apps with NSRunningApplication and answer their own Don't Save sheet or dialog by System Events. An
AX-opened menu loop releases with one Escape posted to the pid. Finder fixture windows left open held Finder at ~99% CPU for
hours, so close them after Finder passes. A leftover Calculator blocks Calculator fixture setup.

**Machine notes from 2026-10-16.** Office was cleared by hand three times: arms leave Word or Excel behind dialogs (Find and Replace)
and a force-quit leaves a "Recovered" fixture. Before an Office window, check that Word and Excel aren't running, and close any
`Report-*` or `Inventory-*` recovered document with Word scripting (`close ... saving no`), never AX presses. Puddle gives 10-minute
gaps between windows and wants 15 minutes' notice before a long one. Its spin guard renices spinning waiters (nice 20).

How work runs. Sol codex lanes build, Sonnet-high agents review, and sleight-arch integrates and runs one full check per merge (`npm run check`,
with `PATH="$HOME/.local/bin:$PATH"` so `claude plugin validate` uses 2.1.289). Every real-page test needs `SLEIGHT_LIVE_DOM_TEST=1`.
Benchmark windows come from Puddle's architect. Ask with a length and a cap, start on "HOLD live", and release with one fresh
touch of `/tmp/sleight-bench-done`. The scripts in `ledger/claims/GATE2/` (gate5.sh with `REPO`, `SPECS`, `PREFIX` and `MODEL`) do the touch.

This session works in `.claude/worktrees/boot-sleight-arch-*`, because a hook refuses edits in the main checkout: commit there,
`git push private HEAD:pane/auto-mode`, then `git -C ~/Projects/sleight merge --ff-only <branch>`. A release also pushes
`HEAD:refs/heads/main` and the tag to `origin` with `SLEIGHT_RELEASE_PUSH=1` (owner's call), then `gh release create` from the
CHANGELOG section. Public CI is Linux, without `npm install`, on Claude Code 2.1.288. Released so far: `v1.2.0` to `v1.2.5`
(2026-10-11) and `v1.3.0` (2026-10-19, public `main` `ca2188b4`). The owner's install is 1.3.0. Public `origin/pane/auto-mode`
stays at `332e3ca`. A workflow edit needs the org ruleset off for the private push (owner's call each time).

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
