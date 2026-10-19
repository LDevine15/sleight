# Engine notes

Facts about the ChatGPT computer-use engine that sleight's code relies on, each learned the hard way. They change only when the
engine does, so recheck them after an engine update.

- The engine diffs UI state against the latest read of an app, whoever made it. The pane snapshots only between turns, and the next
  prompt asks Claude for a full read.
- Real pointer activity in an app counts as a person taking over.
- One engine helper serves every Codex and sleight session on the Mac. Restarting ChatGPT ends every Codex thread, so it's never a
  test step.
- Finishing an app's File > Open panel can bring the app to the front (TextEdit, 3 of about 21 runs). `open_file` uses `open -g`.
- macOS picks a drag's drop target from what's on screen at the drop point, so a background drag can't drop into a covered window.
- A read right after input waits for the UI to settle, and only after that wait does the next key go to a sheet the action opened.
  (SR1 is investigating cheaper ways to get the same guarantee.)
- The engine refuses a key press made only of modifiers (`-10005`). sleight posts a bare modifier through its own helper.
- Page `evaluate` runs in a read-only scope. It lacks event constructors and `fetch`, and assigning a global throws.
- `tab.drag(from, to)` makes 8 equal pressed moves, and a drop needs two of them inside the target, so `sleight.dragTo` aims inside
  the target's near edge.
- After `tab.click` on a download link, the tab's later downloads stall. Downloads use `locator.downloadMedia({})` or a
  `waitForEvent("download")` registered before the click.
- The Codex browser extension keeps one lifecycle queue per session.
- `Tab.ax` is unsupported for extension, iab, cdp and mcpapps browsers. Locator timeouts and `waitForURL` cap at 3 s and
  `pressSequentially` at 5 s.
- The engine doesn't remember a session's approvals, so the relay does. It honors ChatGPT's own Always allow list.
- The engine rejects `getApp({ windowId })`, so routines acquire by bundle ID and confirm the window's exact title.
- The engine takes only element numbers or points, so actions by sleight ID or label need a fresh read to find the current number.
- The engine's warm write takes about 72 ms (AA1). Reads and settle waits, not writes, are most of sleight's tool time.

## Checking an engine update

ChatGPT updates several times a week, so benchmarks rerun periodically, and each published result states the engine
version it ran on. What runs after every update is a compatibility check in two halves. Each writes the UTC date and the
ChatGPT and engine versions to [the compatibility record](results/engine-compat.md).

- `bench/compat-static.mjs --feed` reads ChatGPT's update feed and, when the version changes, downloads the release,
  checks its Sparkle signature against the key the app pins, and unpacks it without running anything. It then checks
  the engine files sleight depends on against `bench/compat/contract.mjs`. That covers the API declarations, the `js`
  and `turn_ended` arguments in `node_repl` and the methods the engine's JavaScript defines. It also covers the bundle
  layout `sleight-mcp setup` uses and whether sleight's js description and policy rewrites still match. It runs on Linux,
  hourly, in `.github/workflows/engine-compat.yml` or a systemd timer (`scripts/ci-box/`). Its output mentions only
  sleight's check items. `--keep-docs` keeps the engine's docs and their diff in the state folder, for a private machine.
  `--app /Applications/ChatGPT.app` checks an installed app the same way.
- `bench/compat.mjs` runs the installed engine on this Mac: the doctor, the raw engine's tool list, docs and a REPL
  probe of method types and result shapes (never values), sleight's launcher, and a diff of the docs against the last
  version that passed (`~/Library/Logs/sleight/engine-raw-<version>.diff`). It doesn't open an app and takes about 20 s.
  With `--owner-away` it adds the live checks, about 2 minutes: 17 × 23 in Calculator by clicks with a screenshot, and
  one engine-path read of a page served on 127.0.0.1 in a Safari window the benchmark's fixture helper creates. They
  wait out `/tmp/sleight-hold`, take `/tmp/sleight-live.lock` without waiting, use only an app they launched, and
  approve only Calculator and Safari from the benchmark allowlist.
- `scripts/watch.sh`, the launchd job, runs the doctor daily and `bench/compat.mjs` when the engine version changes.
  Installed with `scripts/watch-install.sh --daily --live` it also runs the live checks once the Mac has been idle for
  5 minutes, retrying daily while they're pending. A launchd job has no Accessibility grant. Its Safari check skips,
  and `npm run compat -- --owner-away` from a terminal covers it.
- `node bench/compat.mjs --publish --static-log <results.jsonl>` merges the Mac log and the static results into the
  record.

The live checks haven't run yet (2026-10-19). The first static run, on ChatGPT 26.1013.40934 (engine 26.1013.1001501),
found that sleight's shorter js description no longer applies: the engine added one browser bullet on 2026-10-16.
