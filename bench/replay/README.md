# Recorded tool replay

Replay sends recorded MCP requests to a worktree's sleight server, in tool-use emission order. It does not start a model. Each iteration creates the benchmark fixture again and starts fresh servers. Elapsed tool time still varies with the engine, browser and host load.

Preview a check without starting fixtures, servers or a live lock:

```sh
node bench/replay/run.mjs --check MC1 --plan
```

Live commands require the owner to be away. They acquire `/tmp/sleight-live.lock` and stop during `/tmp/sleight-hold`. The permission observer stops replay if a macOS permission prompt appears. They never answer those prompts. A hold or permission-prompt abort can leave the owned benchmark browser open and the lock held. Further app actions stop, including browser cleanup, so the qualification owner must resolve the retained browser and lock after inspecting the evidence. Example for the live qualification owner:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/replay/run.mjs --check MC1 --owner-away --repeat 5 --env SLEIGHT_MC1=1 --compare SLEIGHT_MC1=0
```

`--env` and `--compare` take comma-separated boolean switches from this list: `SLEIGHT_DP1`, `SLEIGHT_DP2`, `SLEIGHT_DP7`, `SLEIGHT_CK2`, `SLEIGHT_CK3`, `SLEIGHT_MC1` and `SLEIGHT_LB12`. Other names are refused, including switches for leases, window selection and stuck-menu recovery. Both servers and the turbo worker enforce that list. The settings run A, B, A, B, with N iterations of each. Using `--env` alone runs one setting N times.

For a capability without a switch, use two distinct worktree roots. Set `MS1_OLD_WORKTREE` and `MS1_NEW_WORKTREE` to prepared baseline and candidate paths, then preview the comparison:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/replay/run.mjs --check MS1 --old-worktree "$MS1_OLD_WORKTREE" --new-worktree "$MS1_NEW_WORKTREE" --plan
```

Both builds must include the original SR2 launcher injection (`bfe6cf44`), which supplies an empty approval store and suppresses the headless payment card. A launcher without those parameters is refused before startup. Both need their dependencies installed. The replay driver stays in the harness checkout; the selected worktree supplies the native launcher, turbo server and turbo worker. The harness supplies the same fixture lifecycle for both builds. Each iteration starts and collects its own servers before the next build starts.

Worktree mode alternates A (old) and B (new) against the same loaded recording. Its plan and results identify each build's canonical path, commit, tracked dirty state and tracked diff hash. These are checked again before each iteration. Untracked dependencies are outside that identity check. `--env` applies equally to both builds. Combining worktree mode with the switch-based `--compare` is refused. MS1 requires worktree mode. A future live command for the qualification owner is:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node bench/replay/run.mjs --check MS1 --old-worktree "$MS1_OLD_WORKTREE" --new-worktree "$MS1_NEW_WORKTREE" --owner-away --repeat 5
```

Inputs can be a race task folder containing `run.json` and `events.jsonl`, or a native results file:

```sh
node bench/replay/run.mjs ~/Projects/sleight-wt/race-1017/safari-sleight-b10-r3/form-checkout --plan
node bench/replay/run.mjs RESULTS.json --task textedit-window-drag --arm sleight --run 1 --evidence RETAINED_TASK_FOLDER --plan
```

Native `bench/run.mjs` runs save transcripts through `bench/driver.mjs` as `$TMPDIR/sleight-real-evidence/<stamp>/<arm>-<task>-<run>/transcript.jsonl`. Results rows usually do not contain that path. The loader derives it from the results stamp. `--evidence` names a retained copy if the original has been swept. Multiple matching rows require `--arm` and `--run`.

## Fixture and approval boundaries

Browser replay reuses `startGateSites`, `realBrowserPlan`, `launchRealBrowser`, `resetRealBrowser`, `checkBrowserOwner` and the browser's own `stop`. It uses a fresh benchmark profile and the original task definition from `run.json`. The pinned FowlBrowser fixture cache must already exist. The cache must be installed beforehand. Replay does not copy credentials or rewrite approval lists. It does not prepare other arms.

Native replay reuses `getTasks`, `genericTask` and `executeRealTask`, including its fixture setup, check, cleanup and permission observer. Supported native fixtures are the TextEdit save, edit, drag, two-window, replace and insert-line tasks. The recording must identify exactly one benchmark fixture directory and nonce. File names and contents use that nonce. The directory moves. Random calculator operands, external documents and real accounts need a saved fixture manifest and are refused.

The engine server uses the ordinary sleight launcher with an empty in-memory approval store. User preapproval files are neither read nor written. App and origin approvals come from the existing `answerElicitation` policies, `bench/approve.mjs` or the race's `origin-hook.mjs`, within the benchmark allowlist. Window selection and turbo's engine-browser restriction use the benchmark's existing guards. Only session or once answers are returned. Replay supplies no payment confirmation, consent-card answer or remembered approval. A gated result diverges immediately. The headless engine companion does not open a payment card.

The turbo arm uses the benchmark's v3 server and privately binds the original task message. Turbo follows the product's task-message payment rule. A user message with the payment, amount and payment method is confirmation, so a local form-checkout replay can complete its purchase click without a new card. Payment guards remain active for requests that lack that confirmation. Both servers and the worker receive the replay switches. A validated benchmark data envelope forwards the requested boolean feature switches to the worker beside its existing LB12 setting. This does not enable installed turbo or read its opt-in file.

If server collection, fixture cleanup or permission observation leaves ownership uncertain, replay keeps the lock and artifacts. It writes the reason into the result. The harness owns and collects the processes it launches.

## Mapping and divergence

- Native element numbers match a unique role, label and ancestor path in the recorded and current trees. A named control can also match by a globally unique role and label. Values are excluded from identity matching but retained in result comparison. Compact diffs update existing numbers. New numbers remain uncertain until a full recorded tree establishes their path. A second Save in a diff cannot inherit the first Save's path. Literal numeric element arguments, including both drag endpoints, go through a JavaScript parser and mapper. Unsupported methods with numeric or computed arguments refuse before input. Typed text, timing options and key sequences keep their values.
- Coordinates require matching native selection receipts from the immediately preceding call. A receipt needs the app's bundle ID, window title and `identity.windowNumber`. Its `frame` contains finite `x`, `y`, `width` and `height` values in points. Origin and size must each differ by at most 2 pt. Cross-window input needs both frames in that observation. The request uses the same app bundle ID and explicit window IDs. Missing, ambiguous or expired frame evidence stops before input. Mapping reads expire frame evidence too. JavaScript handle coordinates and nested coordinate requests lack that proof and refuse.
- Existing native selection receipts omit frames. Such recordings, including the retained DP7 coordinate calls, stop before coordinate input. Screenshot dimensions cannot establish a window's origin or its point dimensions. Plans retain explicit frame receipts in `windowFrames`. Missing bounds remain unknown.
- Turbo ref maps are scoped to recorded tab handles. Snapshot and diff state is separate for each page, so overlapping `e5` refs cannot share mappings. Missing tab mappings or snapshots stop input. Removals and refreshes affect only the target tab.
- Tab handles match one header on each side with the same URL and title. Native window numbers map from matching `select_window` receipts, by app and title. `windowId` and `toWindowId` use those receipts too. Unknown IDs are refused.
- The fixture directory and gate marker have explicit substitutions, including the encoded marker URL. Other window titles must match exactly. A missing element mapping triggers one read on the already acquired app handle, or `browser_read` on the mapped turbo tab, before input. A second ambiguity stops. Replay never resends an action after partial or uncertain input.
- Result comparison normalizes mapped handles, element numbering, runtime process IDs and line endings. Text, values, errors and structured results otherwise compare exactly. Images must match byte for byte. Changed images stop for visual interpretation. Replay also diverges when failure becomes success, since the recorded recovery step is no longer justified. The improved call's output and timing are retained.

Replay serializes requests even if the original host overlapped them. It cannot reproduce concurrency, model reasoning, changed wording, unrecorded intermediate UI states or a model's response to a different result. A new tool description or screenshot can stop replay earlier than the mechanism being checked. A recording that guessed an unseen ref has no identity to map and can stop even against its own recorded responses.

## Evidence and checks

Pass a new directory to `--out`. Otherwise replay creates a private temporary output folder. Each iteration writes `trace.jsonl` with MCP traffic, approvals, mapping reads, recorded and submitted arguments, results and per-call milliseconds. The launcher also writes its ordinary `trace-<pid>.jsonl`. Turbo writes `turbo-metrics.jsonl`. `result.json`, the campaign's `plan.json` and `summary.json` retain failures as well as passes.

Per-call medians include the reached prefixes, with sample counts. Total tool-time medians include complete passing replays only. Mapping-read milliseconds are reported separately. Setup, server startup, cleanup and model time do not enter tool time. Missing or divergent runs never appear as a faster total.

`checks/` pins recorded runs and assertions for DP1, DP2, DP7, CK2, CK3, MC1, MS1 and LB1. Run each with `--check ID`. The default sets its switch to 1 when the code has one. A check whose target was not reached is `inconclusive`. DP7 also requires the world fixture's saved-file check to pass. The selected MS1 recording contains the two-language array, whereas rel131-r1 used click and key recovery. LB1 times the viewport-only restore with `observe:none`, which excludes a full snapshot's cost. Any failed, skipped or inconclusive check exits nonzero. The campaign summary cannot report a pass when a check is incomplete.

DP2 checks Accessibility delivery under 1500 ms and the DPc phase events under `SLEIGHT_TRACE`. The launcher writes `direction: "drag-phase"`, with `msg.phase` equal to `ax-move`, `raise`, `settle` or `posted-press`. `msg.edge` is `start` or `end`. `msg.monoMs` is monotonic milliseconds, and `msg.helperPid` identifies the helper. The helper's stderr prefix is `sleight-drag-phase `, which the launcher converts to those JSON trace entries. No document content belongs in a phase event.

For each selected drag call, phase pairs must nest correctly, use one helper and have nondecreasing monotonic times. Exactly one complete AX move must finish before any raise. An Accessibility result must have no posted press. Nested settle events during the AX write are allowed. A build without phase events reports `skip` and specifies the missing events. Partial, malformed, mixed-helper or reversed evidence fails. The `SLEIGHT_DP2=0` baseline keeps its old raise/settle-first behavior and can fail the candidate's path, timing or ordering predicates. Its calls and timings remain in the evidence.

Offline unit coverage:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/bench-replay.test.mjs
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/bench-replay-safety.test.mjs
```
