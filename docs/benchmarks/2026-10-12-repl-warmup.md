# REPL warm-up before the first call (2026-10-12)

S1 starts the engine's REPL and sleight's setup as the session opens, before Claude's first call. It doesn't read an app, take the
input lease or show anything. `bench/fowl/coldstart-probe.mjs --empty-only --concurrency 13 --trials 13 --prepare-ms 2500` started 13
sleight sessions together, waited 2.5 s (a stand-in for Claude's first model turn) and timed an empty first call. No model ran. Two
passes each, alternating, at 18:45 EDT, at `c2c2891` with lanes running checks.

| Warm-up | Pass | First call, mean | Median | Slowest |
| --- | --- | --- | --- | --- |
| off (`SLEIGHT_WARM_REPL=0`) | 1 | 804 ms | 953 ms | 1,024 ms |
| on | 1 | 34 ms | 12 ms | 166 ms |
| off | 2 | 1,160 ms | 1,314 ms | 1,476 ms |
| on | 2 | 26 ms | 19 ms | 101 ms |

With 13 sessions starting together, the warm-up moves 0.8 to 1.2 s off the first call into time Claude spends thinking anyway.
Connect time (175 to 845 ms) is unchanged. A session whose first call comes sooner than the warm-up finishes waits only for the rest
of it. The warm-up is on by default.
