# sleight roadmap

Everything we intend, in order. Always-true decisions are in [LAWS.md](LAWS.md), current state in [STATE.md](STATE.md), and the
history of every finished item in git and the CHANGELOG. Rewritten 2026-10-15 from an item-by-item audit of the old roadmap
against git, the ledger and the code. Any owner correction about the plan is written here the same turn.

## Goal

The world's fastest computer use plugin for Mac, proven by a published head-to-head (LAWS), and the most thorough one in measured
facts (owner, 2026-10-15). Every claim is a measurement. Work goes to the biggest measured lever first: `bench/fowl/anatomy.mjs` splits
each round into start, model and tool time, result characters and turns. Haiku 5.5 runs every incremental change, because it shows
how forgiving an interface is, and Opus runs once at the end of a batch.

## 1. Release 1.3.0 (waits only on turbo v3)

Everything except turbo is release-ready and merged (owner, 2026-10-14). That covers public CI and the benchmark preflights, plus
the release-pass and claim-suite runners. The release notes (RL1) wait on `codex/rl1`.

1. Finish turbo v3 on `private/v3-gate`. V10R4, CR6, CR7 and AT1 are merged there. AD1 reached its finish line on 2026-10-15:
   every branch is merged in `arch/ad1-int` (the figure-only payment rule the owner chose, 50/98 honest checkouts allowed), and it
   merges into `v3-gate` as `arch/gate-ad1`.
2. One full check on `v3-gate`, then gate rounds with the owner away or headless. On 2026-10-16, over 5 rounds, turbo's median was
   603 s and 4 errors against FowlBrowser's 677 s and 8, which is 89% of FowlBrowser's time, short of the 85% target
   (docs/benchmarks/2026-10-16-gate.md). Their interface misses and form time sinks are fixed in v3-gate `adc5fbc9`, which was faster than the
   old build in all 5 rounds of a turbo A/B (542 s against 581 s, 0 errors, docs/benchmarks/2026-10-16-turbo-ab.md). Next is 5 gate
   rounds with both arms on it.
   The original gate runs Haiku 5.5 on both arms in both orders. It runs Haiku 5.5 on both arms in both
   orders, through V9's arm. The targets are 26/26 tasks, at most 85% of FowlBrowser's 677 s (575 s), at most 9 errors (soft failures included), 0
   ToolSearch calls, 0 focus events.
3. One Opus head-to-head on the owner's account.
   `SLEIGHT_CONFIRM_PAYMENTS=never`, the user's opt-out of the purchase confirmation (owner, 2026-10-15, in LAWS), is built in v3-gate.
4. Merge `v3-gate` into `pane/auto-mode`, then V8 and V8R (the v1/v2 removal and slimming, 15.4 MB to 8.2 MB), then the release
   pass, RP1's CHANGELOG and README changes, and the 1.3.0 tag on the owner's call.
5. Then the claim post (owner publishes) and the launch video (`docs/design/video-storyboard.md`). The art-direction architect the
   owner boots directs the art (owner, 2026-10-16). sleight-arch supplies single-window captures of the trick (in an away window),
   the race from a published run, and the playbill numbers. Puddle's records don't show the Puddle launch film the storyboard's first
   line names, so the art architect should check that line.

Before the gate, the owner reloads FowlBrowser's extension in Helium and runs the sleight-arm login. Chrome's Allow and
`ledger/claim-suite-owner-checklist.md` are the owner's too.

## 2. After 1.3.0, in the owner's order

Post-release work builds on branches now and merges after the tag (owner, 2026-10-14).

1. Electron on turbo v3: EPV3-1 to EPV3-8 (`ledger/electron-v3-plan.md`), carrying over EP-2's cleanup and EP-6's build
   qualification. EPV3-1 is building on `arch/epv3-1` since 2026-10-15, and the rest follow in the plan's order.
2. The full claim suite comes before the parity battery (owner, 2026-10-15). It runs every arm on the same tasks (Claude in Chrome, Claude's own computer use on the newest Claude Desktop,
   FowlBrowser, Codex, LCU, Cua, Peekaboo), median and p90 over at least 5 runs, published with failures. Runs use the owner's
   Anthropic account login, not API credits (owner, 2026-10-15).
3. The Q1 error-message fixes. Q1-1 to Q1-6 are reviewed, and Q1-7 to Q1-17 are in review since 2026-10-15.
4. Speed. The measured gap to FowlBrowser on Haiku 5.5 is mostly time before the first action (67%) and result size (3x larger),
   with code streaming 26% (`ledger/opus-less-code-report.md`), so those come first. Turbo's five tools already cut code per action
   for the browser. IN1 to IN4 proceed on sleight-arch's calls (owner, 2026-10-15): IN1 narrowed to default browser snapshots,
   IN3's design reviewed by sleight-arch, and IN2 and IN4 measured headless or in an away window.
   The skill (94 lines, up from 86 in 1.2.0) gets pruned with an A/B after the tag, not before the gate (owner, 2026-10-15).
5. The parity battery runs about 25 popular apps side by side with Codex. The harness is built, and 3 of 34 runs are done.
6. The AM1 speed map of app classes, parked until after 1.3.0. Its VS Code and Word fixtures still fail setup.
7. Smaller queued work: NP-8 (native-path follow-up), FM3 (forms), TB2, CH1 (Chess save), AS-3 to AS-9, AM1FR.

## 3. Live checks still owed

Unit-tested fixes that no live run has confirmed yet, or that failed their last live run. Each is listed in `docs/known-problems.md`.

- Full Screen and Split View handling. Detection is merged, and the Split View pass is open.
- The simulator's first tap (the 2026-10-11 sitting's simulator-form failed, later in fixture setup).
- iPhone Mirroring scroll-to-swipe and settle wait.
- `typeText` after select-all, and the TextEdit save lock (cause unknown).
- `menu_bar` (the sitting's result file and commit disagree) and stale-number (failed).
- The Target and Best Buy shop tasks (failed in the sitting).
- Mail, Mimestream and the chat tasks, with the owner watching (LAWS).
- Desktop sessions staying busy after `/sleight stop` (mod fix, unit-tested only).
- `sleight-mcp setup` in a fresh macOS user, and native Codex taking part in the lease broker.
- Recording a task from the user's demonstration.

## 4. Parked or shelved by the owner

Windows (plan in `docs/design/windows.md`), the Anthropic directory listing, scoped approvals (`docs/design/scoped-approvals.md`)
and the stable-controls mode (LAWS).

## 5. Waiting on the owner

- AS-8 and AS-9: owner qualification and diagnostic runs.
