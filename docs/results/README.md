# Benchmark results

Every benchmark sleight has published, one page per family. Each page opens with its method: models, effort, runs per arm, scoring and loss rules, arm versions, and what was left out and why. The tables and the data file follow. `bench/results-hub.mjs` computes every number from the raw results with the same scorers the claims use, and failures are published with the passes.

[explore.html](explore.html) has the same data with sorting, filters and a chart per task. GitHub shows only its source, so open it from a checkout or from a host that serves this folder.

| Family | What it measures | Where it stands | Data |
| --- | --- | --- | --- |
| [Native claim](native-claim.md) | The 9 native Mac app tasks, sleight against LCU, Codex, Cua, Peekaboo and Claude's own computer use. | "fastest", sleight's total expected time 251.2 s over 9 tasks (197 runs, 2026-10-17 to 2026-10-18) | [json](data/native-claim.json) |
| [App claim](app-claim.md) | VS Code, Slack and Spotify tasks with the same arms. | "fastest", sleight's total expected time 56.8 s over 3 tasks (60 runs, 2026-10-18, 02:39 to 03:16 UTC) | [json](data/app-claim.json) |
| [Browser turbo against FowlBrowser](browser-turbo.md) | Turbo in Chrome and Helium, in the gate rounds and the real-window race. | Chrome lowest expected time on 10 of 13, total 258.9 s against FowlBrowser's 447.8 s (`sleight-turbo-rel130`). Helium lowest expected time on 11 of 13, total 241.8 s against FowlBrowser's 338.3 s (`sleight-turbo-b5`). 14 gate studies | [json](data/browser-turbo.json) |
| [Safari and Firefox race](browser-race.md) | sleight's engine path in Safari and Firefox against Codex, LCU, Cua and Peekaboo. | Safari "fastest" (`sleight-b10`, 2026-10-18). Firefox "fastest" (`sleight-b10`, 2026-10-18) | [json](data/browser-race.json) |
| [A/B tests and tuning experiments](ab-tests.md) | sleight against sleight, for skill, wording, tool and turbo changes. | 13 studies with run data, 94 write-ups in all | [json](data/ab-tests.json) |
| [Release passes](release-passes.md) | The per-release regression passes and the first native head-to-heads. | 7 release passes (2026-10-05 to 2026-10-09), 115 results files in all | [json](data/release-passes.json) |

[Insights](insights.md) (being written) covers what the runs taught us about run-to-run variation, Haiku against Opus, which tuning paid off, and engine quirks.

## Terms

- Expected time is the mean seconds per attempt divided by the pass rate, the time to a correct result if failed attempts are retried.
- An arm is one agent setup: sleight, a competitor plugin, or a sleight variant in an A/B.
- A round runs every task once per arm. A claim or race task gets 3 runs per arm, or 5 where sleight and another arm are within 20%.
- The full rules are in [LAWS](../status/LAWS.md), and the tasks and harnesses in [benchmark.md](../benchmark.md).

## Rebuild

```sh
node bench/results-hub.mjs                # collect from the raw folders this Mac has, then render
node bench/results-hub.mjs --render-only  # render from docs/results/data only
node bench/results-hub.mjs --check        # exit 1 if a page or data file would change
```

The raw claim and race folders live outside the repo, in `~/Projects/sleight-wt/app-claim` and `~/Projects/sleight-wt/race-1017`. On a Mac without them, the generator keeps the data files already here. `--wt <dir>` points it at another copy.
