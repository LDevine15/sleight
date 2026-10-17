# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-17 22:31 UTC)

Goal (owner): release 1.3.0, then the native claim and the video. The owner is "focused on winning everything we can" (2026-10-17):
no claim shortcuts, but every measured fix lands before the claim. Puddle is shut down, and sleight has the Mac. The owner is away
from the PC but home and reachable by phone (since 21:46Z), so live runs are allowed.

**Tonight's state (details and numbers in `~/Projects/sleight-wt/ledger/LEDGER.md`, sections ASTRA-1017 and AB-LOSS).**
- All three Astra lanes finished (native 21:38Z, office ~22:00Z, browser ~22:05Z). Reports `ledger/astra-1017-<name>-report.md`, items
  AN1 to AN7, AO1 to AO5, AB1 to AB5. No product code from them.
- Merged and pushed (`3ff925db`, full check 6583 pass, prose lint clean): the five reviewed loss-fix branches, AN1 (switch tabs by
  key, not click), AN4 (open_file adds a screenshot when the tree has no document text), AN6 (bench timing parts add up), AO1 (one
  paste for a known block of cells), AO5 (cleanup confirms exits independently), AB4 (one coordinate frame note), AN2 (results that
  name supported alternatives and what ran), MS1 (stuck menu-bar note escalates), AB2 (one call's repeated reads compacted). Each had a
  Sonnet-high review and fixes.
- In review: AB1 (continue across a tab the call opened, after its safety review) and AB3 (fresh numbers after an invalid-ID stop).
- First A/B (old 369bc9a2, new c34549ff, 6 rounds): no clear win. Expected s: excel 57.1 to 44.7, save 10.6 to 9.8, preview 4.4 to
  4.9, word 75.9 to 113.3 (one model-variance failure, passing mean 78.9).
- Running now, A/B 2 (`sitting-1017c/ab2.sh`, old 369bc9a2, new 3ff925db, 6 tasks, 5 rounds, started 22:30Z).
- Late-alert probe (AN3, light Return check): first live run unusable (Finder baseline, Excel alert never triggered, TextEdit open
  panel), so it went back to its lane. The light check stays off.
- The owner made the Safari profile named "sleight benchmark" on 2026-10-16.

**Native claim: the scorer says "fastest"** (`~/Projects/sleight-wt/sitting-1017c/claim-score-final.{txt,json}`). sleight's final
claim run (bb6f99f6, 2026-10-17 19:07-19:32Z, results copied into the main checkout's `bench/results`) passed 44 of 45, and the one
failure is the Excel tab swap. After the one top-up round (claude-cu finder-move, Peekaboo preview-read), every pair within 20% has 5
runs. sleight is fastest on 6 of 9, with a total of 282 s against claude-cu's 460 s. It loses textedit-save (LCU 11 against 14, medians
10.5 against 10.4), preview-read (Peekaboo 4.4 against 4.6 median) and excel-edit (claude-cu 54 against 74). LAWS ties the
headline's wording to the browser race, which isn't done.

**Browser race (real windows), started.** Harness `bench/fowl/rounds.sh --world --real-browser <chrome|helium|firefox|safari>
--surface <arm> --model haiku --effort high`; arms sleight-turbo (Chrome, Helium), sleight (Safari, Firefox: engine path, now with
`SLEIGHT_TURBO=0`), lcu, cua, peekaboo (from Terminal.app), codex. Firefox, sleight: round 1 5/12 (harness bugs), round 2 12/12
(`/tmp/fb-rounds/real-f6f636c8-b44e-407e-a37e-d55e1fbfa2c5-sleight`, form-checkout stopped before paying). LCU, Cua and Codex rounds are
harness failures, being triaged. Safari, Chrome and Helium haven't run. The owner made Safari's "sleight benchmark" profile on 2026-10-16 (owner, 2026-10-17). macOS denies this session's shell reading Chrome's and
Firefox's data folders (EPERM, App Data protection), so Chrome-family rounds and the Claude in Chrome dry run must run from
Terminal.app (`open -a Terminal x.command`, output to a file). Firefox now launches through LaunchServices (`open -n -a`); a direct
spawn showed "Profile Missing".

**Real-window FowlBrowser gate (owner's request), arms built.** Smoke on 2026-10-17: FowlBrowser ok on the Chrome profile copy and on
Helium; turbo ok on Helium; turbo on Chrome refused (the 775 check above); Claude in Chrome connects (device 44826f70 in the copy) but
timed out waiting on prompts (see agent-ad5cfb3df41d7b6dc). The wikipedia and mdn graders now fail memory answers.

**Pushed today after the claim build** (`pane/auto-mode` on `private` at 369bc9a2, fast-forwarded into the main checkout):
- The payment rule needs the amount (owner, LAWS): the engine path paid $268 on an unpriced test checkout in Firefox round 1.
- LW1 first commit d734b73b (dialog-close lease continuation). It didn't trigger live in two word-edit runs. Follow-ups f3c15d05 and
  fd834163 (safety-review fixes, refusal traces) are on worktree-agent-ac2392d909bf6200b, unmerged: merge after a re-review, then A/B
  word-edit. Its build agent warned that the staleness bound may block the Word Replace All flow it targets.
- TP1 (AX press) dropped. Excel's sheet tabs don't list any AX actions (AXPress -25206), and setting AXSelected, AXSelectedChildren or
  AXFocused switches nothing. Branch worktree-agent-a65d1243221b4ee23 holds it, unmerged and abandoned. The owner's LAWS exception stays.
- Real-window harness fixes and arms (399a17aa, 4b91dc50, 0f8cd212, 86f119cf, a1344e8b) and drag allowed in away gate rounds (owner).

**Owner today:** quitting their Chrome and Helium was allowed for tonight's race only. Both are closed now, reopen them yourself, and
tabs restore. The owner overrode their own rule so sleight-arch could grant Claude in Chrome site access in the benchmark profile;
nothing was granted, since it turned out not to be needed. The owner declined moving the real pointer for Excel tab clicks.

**Opt-in flags still opt-in:** `SLEIGHT_OPEN_SHOT=1`, `SLEIGHT_SKILL=screenshot` (SK1 ran excel-edit 50-53 s in 3/3 on the pre-FL1
build; recheck), `SLEIGHT_COMPACT_TOOLBARS=1` (made word-edit ~40% slower; FL1 now leaves Word and Excel unfolded),
`SLEIGHT_COMPACT_CONFIRMATIONS=1` (wording approved by the owner).

**Owner items.** Decide on publishing once the browser race has run. The turbo live check before the tag. The Microsoft Error
Reporting window from an earlier Office crash is theirs to read or dismiss.

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
