# sleight state

What is true now. One banner, replaced in place as work happens. Always-true rules live in
[LAWS.md](LAWS.md). Cap 32 KB.

## Banner (2026-10-14 03:50 UTC, after the reboot)

Goal (owner): a published head-to-head showing sleight is the fastest computer use plugin for Mac, then release 1.3.0, the claim
post and the video (ROADMAP 0b). LAWS was cut to 4.7 KB on 2026-10-14 (owner's decisions plus Mac protections). Engine facts are in
docs/engine-notes.md, and process is sleight-arch's judgment (memory `slim-laws`).
Pushed: `pane/auto-mode` at the commit holding this banner (private sleight-dev), with P1S, GR1, LD1 and LD1R cherry-picked
on top of `501aa82b`. Full check 4661 pass, 0 fail, 45 skipped, mod 33/33. `~/Projects/sleight` is fast-forwarded to it. There are 0 open PRs, and public CI is green on 1.2.5.

Turbo (sleight's direct browser path, opt-in through Chrome's remote-debugging consent) is the path to the gate.
- Merged into the plugin, inactive until wired: the P1 chain with the broker and the closed host interface (`9a98f6d0`),
  BP2-P1B (helpers compile on the user's Mac at first use, `7c3b3d77`), and BP2-P1S, the four-rule host contract with staged file
  transfer (`a3c09ef5`, `a2dc2f71`). All `bench/direct-browser2` prototype modules are merged.
- GR1 is merged (`f509fb10`): `SLEIGHT_GUARD=first-off` skips the guard's first-action read. Its A/B is live work for an away
  window.
- Owner decisions on 2026-10-14 (all in LAWS): `playwright-core` 1.64.0 bundled and pinned; helpers compiled on first use;
  background only (the gate fails on any Space switch); and four safety rules (payments, page content never authorizes, no blind
  resend of a submit, background). Fills check the target element alone. There are no per-field tokens and no per-site prompts.
  Turbo becomes the default once its benchmark proves it.
- In flight (headless `codex exec` lanes keep running through the clear and report only through
  `~/Projects/sleight-wt/ledger/claims/`; logs in `/private/tmp/claude-501/lanes/`):
  - BP2-P2 (codex-hdlck) and BP2-P3 (codex-hdlcl) restarted on P1S at 03:44 UTC, rebasing `codex/bp2-p2` (`e8c380df`) and
    `codex/bp2-p3` (`e9b193f4`) onto `pane/auto-mode`. P2 supplies the target check, submit and payment classification, fresh-read
    evidence and the file provider, and must make the demo forms fill and submit. P3 wires turbo into the plugin and advertises
    every tool schema without a top-level oneOf (Claude Code drops such tools).
  - LD1 and LD1R are merged (`d999b498`, `5a1b54e5`). The real-page runner serves lanes from `~/Projects/sleight`
    (`node scripts/live-dom-runner.mjs`, started 03:49 UTC, log `/private/tmp/claude-501/lanes/live-dom-runner.log`, queue
    `~/Projects/sleight-wt/ledger/live-dom/`). Qualified on `tests/fill-form.test.mjs`: 18/18, no skips, group collected,
    worktree removed. P2 and P3 were told how to use it in their ARCH-NOTE.md files.
  - SR1, the read after an action, decided 2026-10-14 from both reports (`ledger/sr1-opus-report.md`, `ledger/sr1-astra-report.md`).
    Both found the 262 s against 110 s gap was all browser-path calls. Of 915 mid-call native reads (about 430 s, 16% of native
    tool time), 80 follow a sheet or panel opener and 673 sit between two clicks. Opus's design A goes first (bind numbers to the
    call's first read, no reads between clicks, about 280 to 300 s), once its no-model probe passes: `node bench/engine-time.mjs
    bind` (Calculator, 10 trials an arm, owner away). It needs bind 10/10 at 391 with the control showing the renumber. Then
    `SLEIGHT_GUARD=bind`. Design B (quiet edit shortcuts and field clicks) is lane SR1B (codex-hdlcm, `SLEIGHT_GUARD=quiet-edits`).
    Astra's readiness predicate is Opus's design C and comes after A. Skipping the wait after real openers stays rejected
    (Codex got 15 of 49 such calls wrong).
- Done, to apply: RP1 (`ledger/claims/RP1/`: CHANGELOG-1.3.0.md, README-diff.md, release-checklist.md) for the release. CS1
  (`ledger/claims/CS1/REPORT.md`) found only the Codex native arm ready for the claim suite, out of 18. Its table gives each
  other arm's install command, and claude-cu needs the owner's login.
- The prototype arm (TP1, `codex/tp1r2` at `0eaa14bf`, never merged) stopped after its last round. The rounds are in
  docs/benchmarks/2026-10-14-turbo-prototype.md: 4/9, with 53 s on four non-form tasks against FowlBrowser's 63 s and the engine
  path's 103 s, and forms 0/4 on validation bugs, which are now in P2's brief.
- AM1, the speed map, is parked until after 1.3.0 (owner).

Next steps, in order:
1. Review and merge P2 and P3 as they finish, then SR1B after P3 (it touches relay.mjs).
2. Once P2 is merged, run the four form tasks headless (TP-style, about $0.20) for an early read on forms.
3. P3 wires turbo into the plugin. Then live qualification in the owner's Chrome "sleight benchmark" profile and Helium. The owner
   clicks Allow on Chrome's prompt once per launch. The gate counts Space switches and focus changes.
4. The turbo gate round (Haiku 5.5, both arms, both orders), only while the owner is away or headless. Then one Opus head-to-head on
   the owner's account.
5. Install the claim-suite arms per CS1 and run the suite with the W8 runner.
6. Apply RP1's CHANGELOG and README proposals, and release 1.3.0 on the owner's call.
After 1.3.0 come Electron (EP-1 to EP-7), slimming the plugin, AM1, and the SR1 and GR1 results.

Owner items: OpenUsage.app relocked the "Claude Code-credentials" keychain item to its own binary today (17:05 local). Every new
Claude Code session then prompts for the keychain password. The owner was given the one-line fix
(`security set-generic-password-partition-list -S "apple-tool:,apple:,teamid:Q6L2SF6YDW" -s "Claude Code-credentials" -a
owner`) and the option to quit OpenUsage. Vibe Island's Claude Code hooks were removed from `~/.claude/settings.json` on the
owner's order (backup `settings.json.before-vibe-island-removal-20261014`), and its bridge renamed `.disabled-20261014`. An old
Chrome for Testing (build 1234, started 15:46 local, not this session's) was left running. API spend for October is $157.17 of $200.

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
