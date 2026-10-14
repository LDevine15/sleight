# Lean calls A/B, 2026-10-14

`SLEIGHT_LEAN_CALLS=1` (LC1) gives native action results as the window header plus what changed, and tells Claude to end a call
on the action instead of a full read. Two A/Bs against the default on five native tasks, 3 rounds alternating, Claude Haiku 5.5
at high effort on the owner's API key, owner away. Scripts: `.dev/passes/ab-lean-1014.sh` and `ab-lean2-1014.sh`.

| Run | Commit | Default wall s | Lean wall s | Default tool s | Lean tool s | Passed, default / lean |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| First | `4bc32f92` | 210.8 | 176.1 | 47.0 | 32.9 | 14/14, 13/14 |
| Rerun after the cache fix (LC1R) | `bd1f0b53` | 194.4 | 220.8 | 39.8 | 47.9 | 12/14, 11/13 |

Wall and tool times are summed medians over the five tasks. The first run's lean arm may have reused a cached default tool
description (LC1R fixed the cache key), so the rerun is the one that counts. chess-drag drives the swing, at 103.1 s against
130.0 s in the rerun. Without it the arms took 91.3 s and 90.8 s. Lean calls stay off: no measured win. Both runs together cost $0.63.
chess-drag also passed only 2 of 6 in the rerun, all failures "game was not saved", which CH1 is investigating.
