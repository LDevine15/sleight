# Lessons from the benchmarks

sleight's benchmarks ran from 2026-10-03 to 2026-10-18 on one Mac, mostly on Haiku 5.5 at high effort.
Linked sources are public. Unlinked filenames refer to private working notes. Readers cannot audit those figures here.
Use the hub's linked run data to check the published claims. Where sources disagree, the lesson says so.

The per-benchmark tables are in the [benchmark hub](README.md) and the [interactive page](explore.html).

## Model variation

1. One task on one model can vary several times over. In the 1.1.0 release pass (Sonnet 5.5 at medium, 2026-10-09),
   calculator-click passed in 94.7 s, 20.0 s and 16.3 s (10, 4 and 4 turns). chess-drag took 303 s, 303 s and 127 s. Both
   303 s runs had saved the right game and then hit the 5-minute limit, because Claude Code's Glob never returned while
   Claude looked for the file. Source: [results README](README.md), [benchmark.md](../benchmark.md), "Time per run".
2. The same build gave three different medians in one night. Turbo at `adc5fbc9` took 542 s in the turbo A/B (02:28 UTC),
   607 s in the gate an hour later (04:01) and 622 s as the baseline of the find A/B (05:25), all on FowlBrowser's 13
   tasks with Haiku 5.5. API time rose from 1,323 s to 1,614 s while tool time per call fell, so the extra time was model
   turns. FowlBrowser's medians across that night's three Haiku gate runs were 677 s, 685 s and 720 s. That spread is why A/Bs
   alternate the old and new builds inside each round. Source: [2026-10-16-gate.md](../benchmarks/2026-10-16-gate.md),
   [2026-10-16-turbo-ab.md](../benchmarks/2026-10-16-turbo-ab.md).
3. An unchanged arm ran faster later. FowlBrowser took 1,744 s at 16:06 and 1,234 s at 19:12 on 2026-10-12.
   Source: [2026-10-12-haiku-round-2.md](../benchmarks/2026-10-12-haiku-round-2.md).
4. The noise sets the sample size. word-edit's wall time had a standard deviation of 28 s on a mean of 81 s, so a 10% effect
   needs about 200 runs per side unpaired, or 50 without the stuck-menu runs. excel-edit needs about 60 (`fable-1017-office-turns.md`,
   2026-10-17). A 0.5 s effect on preview-read needs 24 to 30 runs per side (`fable-1017-save-preview.md`). The claim's 3 and 5
   runs can separate clear gaps only.
5. Opus took longer than Haiku for both arms on FowlBrowser's 13 tasks (2026-10-16, both at high effort). Turbo went from
   547 s on Haiku to 675 s on Opus, and FowlBrowser from 720 s to 885 s. Turbo took 76% of FowlBrowser's time on both models,
   with 163 against 286 calls on Haiku and 159 against 270 on Opus. Source: [2026-10-16-gate.md](../benchmarks/2026-10-16-gate.md),
   [2026-10-16-opus.md](../benchmarks/2026-10-16-opus.md).
6. Haiku was the fastest model on the native suite because its turns were shortest. One pass each, 21 runs, medium effort
   (2026-10-08). Haiku 5.5 took 625 s (20/21, 1.54 s of model time a turn), Sonnet 5.5 687 s (20/21, 2.05 s), Opus 5.5 808 s
   (21/21, 2.41 s) and Sonnet 5.5 at low 827 s (21/21). Haiku also took the most turns, 235. Source: [benchmark.md](../benchmark.md),
   "Time per run".
7. Haiku shows where an interface is easy to misuse. In a round on 2026-10-12, sleight's browser path finished 19/26 with 145
   tool errors: 39 calls to API names that don't exist, 23 selector failures and 12 lost handles. Opus finished 26/26 the
   same day. After the interface was changed to accept what Haiku writes, turbo's 2026-10-16 gate rounds had 0 errors each.
   Source: [2026-10-12-haiku-baseline.md](../benchmarks/2026-10-12-haiku-baseline.md), [2026-10-16-gate.md](../benchmarks/2026-10-16-gate.md).
8. Shorter code mattered more for weaker models. On Haiku 4.5, streaming the code block took 52% of each web turn (2.5 s a
   call). On Haiku 5.5 it was 12% of a native turn and 18% of a web turn. On Opus, sleight wrote about as much as FowlBrowser
   (1,433 against 1,306 output tokens a run). Source: `opus-less-code-report.md`, 2026-10-14.
9. Sonnet and Haiku took the same number of turns on Office tasks. Sonnet's word-edit runs took 15 to 20 turns and excel-edit
   13 to 19, matching Haiku on the same build. The turns came from sleight and the apps, not from the model's plan.
   Source: `LEDGER.md`, 2026-10-17 18:21Z.
10. A model alias changed which model ran. Every "Haiku" round on 2026-10-12 ran `claude-haiku-4-5-20251001`, because
    Claude Code 2.1.289 resolves the `haiku` alias to 4.5. Results now record the model id from every model event: 5,731
    events in the final Haiku gate, all `claude-haiku-5-5`. Source: [2026-10-12-haiku-baseline.md](../benchmarks/2026-10-12-haiku-baseline.md),
    [2026-10-16-gate.md](../benchmarks/2026-10-16-gate.md).
11. The native claim count moved with each fixed build. sleight was fastest on 5 of 9 tasks in the first all-arms
    run (2026-10-17, commit `4624bf35`), 6 of 9 at 282 s against 460 s in the final run with its top-up round (commit `cd7e2e28`),
    and 8 of 9 at 251 s against 454 s on the release build (2026-10-18, `LEDGER.md` NATIVE-1018b). Each step was a new build, and the extra top-up runs didn't change a count.
12. One failure moves expected time more than the median. sleight's excel-edit went from 52 s expected at 2 of 3 passes to 45 s
    at 4 of 5 (32.5, 35.6, a failure, 31.6 and 43.4 s). Expected time is total seconds over passes. A failed run adds its time
    and no pass. Source: `LEDGER.md`, CLAIM-1018, 2026-10-18.
13. Small A/Bs showed direction at best. The find-alternation fix was faster in 2 of 3 rounds and 14 s slower in the other. A
    loss-fix A/B over 6 rounds moved word-edit from 75.9 s to 113.3 s expected, with the one failure diagnosed as model variance,
    and the verdict was "noise larger than the effects". Source: [2026-10-16-turbo-ab.md](../benchmarks/2026-10-16-turbo-ab.md),
    `LEDGER.md` AB-LOSS, 2026-10-17.
14. An A/B reversed on rerun. `SLEIGHT_LEAN_CALLS` first measured faster, 176.1 s against 210.8 s, because of a cache-key
    bug. After the fix it measured slower, 220.8 s against 194.4 s. Source: [2026-10-14-lean-calls-ab.md](../benchmarks/2026-10-14-lean-calls-ab.md).
15. Harness bugs looked like product misses until we checked. Claude in Chrome scored 0/39 in the first Chrome rounds because
    its own permission prompt timed out. Cua stopped on 11 of 12 Safari tasks in 2 to 3 calls because the prompt gave a stale
    process id. Finder windows left from earlier runs covered 41% of Safari from 18:08 to 19:35Z, and four arms' second rounds were set aside. Before
    the race scorer required site evidence, Codex and LCU passed inject-order in Firefox by refusing before they opened the shop.
    Source: `LEDGER.md` 2026-10-18, [benchmark.md](../benchmark.md), "Scoring the real-window race".
16. One fast passing run changed the loss rule. Codex passed Firefox's form-checkout in 36.5 s against sleight's best of 52.5 s
    (2026-10-18), and since then a competitor's faster passing run also counts as a loss. sleight later passed it in 42.2 s.
    Source: [LAWS](../status/LAWS.md), `LEDGER.md`.

## Speed and tuning

### What paid

17. Extra calls cost time. In the Firefox race (2026-10-18), sleight's median gap from a tool result to the next call was 2.16 s
    (n=93) against Codex's 2.19 s (n=67) and LCU's 2.39 s. sleight lost on the number of calls, 8.75 a run against Codex's 6.6.
    On the short Firefox tasks, per-turn latency was 2.44 s against LCU's 2.75 s, and wasted turns took 12.0 s a run against
    4.4 s. Source: `fable-1018-loss-reads.md`, `fable-1018-loss-short.md`.
18. A turn takes about 4.2 s in Office tasks (median model gap 2.8 s, p90 5.6 s, tool time 0.9 s). Seconds
    per turn tracked thinking time (r 0.94 to 0.96) and not context size (r about 0). A turn after a screenshot took 4.0 s
    against 2.0 s. Source: `fable-1017-office-turns.md`, `LEDGER.md` RA1, 2026-10-17.
19. Streaming a native call's code took 315 ms of a 2,725 ms turn, and model time was 23.7 s of a
    38.8 s run (2026-10-14 native A/B). A separate count over the 2026-10-16 claim runs put model time at about 85% of each run.
    These samples differ, and the first counts startup and harness time in the run. Source: `opus-less-code-report.md`,
    `queue/speed/README.md`.
20. Fewer guard reads. In the guard A/B (2026-10-14, five native tasks, three runs a side, summed medians) wall time fell from
    208.6 s to 185.9 s, tool time from 49.9 s to 32.5 s and guard reads from 17.3 s to 5.7 s, with 15/15 passes against 14/15.
    After the safety fixes the follow-up ran 191.1 s, 43.9 s and 11.6 s at 14/14. Source: [2026-10-14-guard-ab.md](../benchmarks/2026-10-14-guard-ab.md).
21. A warm REPL. With 13 sessions starting together, the first call took 34 ms and 26 ms on average against 804 ms and
    1,160 ms cold (2026-10-12). Source: [2026-10-12-repl-warmup.md](../benchmarks/2026-10-12-repl-warmup.md).
22. A warm engine and a faster `open_file`. In the 2026-10-17 A/B, calculator-click went from 8.7 s to 6.7 s, preview-read from
    5.5 s to 3.9 s and textedit-save from 10.4 s to 8.1 s (medians, 3 runs each). The engine's first-call start is about 0.73 s.
    The [CHANGELOG](../../CHANGELOG.md) credits both switches. The STATE entry for that run (commit `8eb6190d`) records it as
    the old build against the new build with every opt-in flag on, so the run doesn't separate them.
23. Smaller results on pages that change. Scrolling the CNN front page five times sent 39,655 characters instead of 203,160, and a
    click on a 120-item sidebar page sent 428 instead of 35,532 (0.10.0, 2026-10-05). On small native tasks the saving was small:
    textedit-save went from 66,747 to 66,405. Source: [2026-10-05-compact-reads.md](../benchmarks/2026-10-05-compact-reads.md).
24. Turbo for browsers. Its first 2026-10-16 gate took 89% of FowlBrowser's time (603 s against 677 s) and missed the 85% target.
    Fixes from those rounds took the median from 581 s to 542 s with errors from 20 to 0 over five rounds. Accepting `a|b`
    alternation in `find`, which Haiku wrote in 193 of 254 empty finds, cut empty finds from 29 of 68 to 9 of 83. The passing
    gate took 76%. Source: [2026-10-16-gate.md](../benchmarks/2026-10-16-gate.md), [2026-10-16-turbo-ab.md](../benchmarks/2026-10-16-turbo-ab.md).
25. One tool for a whole step. The engine's `tab.drag` dropped on an HTML5 list 0 times in 14. `sleight.dragTo` dropped 6 of 6,
    and FowlBrowser's settings form took 39 s instead of 313 s in Helium (2026-10-12). Source: [2026-10-12-fowlbrowser-h2h-2.md](../benchmarks/2026-10-12-fowlbrowser-h2h-2.md),
    [known problems](../known-problems.md).
26. Fixes from the real-window race. Turbo in Chrome went from fastest on 6 of 13 tasks against FowlBrowser (first round) to 11
    and then 12 of 13 on 2026-10-18. In Firefox the engine path went from 6 to 10 of 12. After the tab-continuation fix, 29 of 29
    Cmd+T batches ran whole, against 0 of 9 before. Source: `LEDGER.md`, `fable-1018-loss-mdn.md`.

### What didn't pay

27. `SLEIGHT_LEAN_CALLS`: 220.8 s against 194.4 s, passing 11/13 against 12/14 (2026-10-14). It stays off.
    Source: [2026-10-14-lean-calls-ab.md](../benchmarks/2026-10-14-lean-calls-ab.md).
28. `SLEIGHT_COMPACT_REACQUIRE`: replayed offline it halved acquisition tree text, but live it took 156.3 s (9/10) against
    149.4 s (10/10) on excel-edit and word-edit over 5 rounds, with 9% fewer prompt tokens and 18 Excel turns against 15
    (2026-10-17). Source: [CHANGELOG](../../CHANGELOG.md), commit `19ef04d0`.
29. `SLEIGHT_COMPACT_TOOLBARS`: folding Word's ribbon made word-edit about 40% slower, 99, 133 and 118 s against 48, 91 and
    82 s (n=3, 2026-10-17). Folding now skips Word and Excel. Source: STATE history, commit `f69bb36c`.
30. Every opt-in flag at once: the claim tasks took 298 s (26/26) against 265 s (24/25). Small tasks got faster, but word-edit went
    from 73 s to 101 s (19 to 23 turns) and excel-edit from 59 s to 68 s, with prompt tokens up from 588k to 739k. The held-out
    tasks went the other way, 368 s (23/30) against 431 s (19/25). No flag became a default as part of the bundle.
    Source: STATE history, commit `8eb6190d`, 2026-10-17.
31. A lean skill: 430 words against 923 finished 24/26 in 981 s against 25/26 in 1,006 s (Opus 5.5 at medium, 2026-10-12),
    within noise. The default stayed. Source: [2026-10-12-lean-skill-ab.md](../benchmarks/2026-10-12-lean-skill-ab.md).
32. A minimal engine reference (`SLEIGHT_ENGINE_DOCS=min`, 11,897 characters down to 672) finished 42/52 against 37/52, but the
    default arm alone ranged from 17 to 20 of 26 that day. It stays opt-in. Source: [2026-10-12-d5-min-ab.md](../benchmarks/2026-10-12-d5-min-ab.md).
33. Trimming the engine reference by section found nothing to cut (TK2, 2026-10-17). In 91 transcripts and 707 calls, Haiku
    used an API from every nonempty section. Source: `claims/TK2/REPORT.md`.
34. Pressing Excel's sheet tabs through Accessibility: the tester allowed it because posted tab clicks acted as drags, but a live
    dump showed the tab doesn't expose any actions, and AXPress returns -25206 (2026-10-17). Source: `LEDGER.md` TP1.
35. Putting the skill's rules before the first tree: the final gap was 2.16 s rules-first against 1.76 s rules-after, within noise.
    Source: `fable-1017-save-preview.md`.
36. Faster first input without a faster task: time to the first non-error input fell from 15.87 s to 10.88 s in Word, but the
    mean task time rose from 93.0 s to 130.9 s (3 to 4 runs an arm). Source: `astra-1018-firstaction-report.md`.

### Tuning dropped as scoreboard tuning

37. preview-read is the native claim task sleight loses, 5.1 s median against Peekaboo's 4.4 s (5 runs each, 2026-10-18). Haiku's
    thinking before its answer accounts for about 1.06 s, more than the 0.96 s gap between the means. It thought on that turn
    in 5 of 5 sleight runs against 2 of 5 for Peekaboo. The trigger is the engine's tree or JSON result, since LCU and Cua
    thought in 5 of 5 without any of sleight's rules. The items for it, a shorter `open_file` rule set (SP2) and the final-turn thinking (PV1), would move only this one
    task, and LAWS keeps them out. Source: `fable-1018-loss-preview.md`, [LAWS](../status/LAWS.md).
38. Skill lines that a lane shortened were restored, because they shape tasks sleight wins (2026-10-18). Fixes that also touch a
    task sleight leads (Word steering, a keyboard drag route) are measured on held-out tasks only. Source: `LEDGER.md` SKL,
    [LAWS](../status/LAWS.md).

## Engine and macOS quirks

Quirks in the engine and macOS added time to benchmark runs.

| # | Quirk, as measured | What sleight does |
| --- | --- | --- |
| 39 | The engine prints nothing for a bare final value: 58 of 78 recorded filtered reads lost their value, and Claude read the whole tree instead. | Prints a value derived from the tree and leaves the tree out. |
| 40 | Claude Code cut the engine's `js` tool description at 2,048 of its 3,511 characters, dropping the app example and output rules. | Sends a 1,536-character version with the safety guidance first. |
| 41 | After an Accessibility write, TextEdit's next Cmd+S deadlocked in 10 of 13 trials. One posted Shift press gave 0 hangs in 10 against 5 in 8 without (2026-10-09). The cause is unknown. | Splits the call at the save and posts one Shift press. |
| 42 | In Excel, the first click on another sheet tab after a rename swapped the two tabs. All three excel-edit failures in the 2026-10-17 claim run were this swap. | Reports the new tab order. The skill switches sheets by key. |
| 43 | `setValue` on Excel's name box, then Return, kept the old cell in 4 of 9 excel-edit runs (2026-10-17). | Says when the value didn't hold. |
| 44 | A menu opened in a background app doesn't always close. Word ignored keys for 20 calls in one run, and two runs failed at 172 s and 138 s. | Warns that a menu may be stuck. 1.3.1 posts one Escape to the app. |
| 45 | The engine's scroll left a mirrored iPhone list unmoved in 3 of 3 tries. | Turns `scroll` into a swipe on such windows. |
| 46 | At a load average of 101, apps missed a 0.5 s Accessibility deadline in 5 of 5 probes and answered within 0.52 s (2026-10-09). | Probes again with a 3 s deadline before calling an app hung. |
| 47 | The engine's helper crashed 4 times between 2026-10-05 and 2026-10-11 ("native pipe closed before response"). | Sends a read once more after 2 s, never a call with actions. |
| 48 | Safari's AutoFill button renumbered the form and stopped 3 of 3 form-travel runs. | Follows an element moved by one inserted block of rows. |
| 49 | `app.drag` in Safari left rows in place in both runs that tried it, and in Firefox in 13 of 13 retries. | Sends row reorders to sleight's `drag` tool. |
| 50 | Script popups on the engine's browser path took focus 18 times in 26 runs (2026-10-13), against 0 for FowlBrowser. | Opens new-tab links in the background. Turbo took focus 0 times in 260 runs. |
| 51 | An Electron app builds its Accessibility tree late. Discord showed 11 nodes 12 s after launch and 509 after the engine's read (2026-10-11). | `SLEIGHT_LAUNCH_REREAD=1` reads again after 2.5 s (opt-in, not yet A/B'd). |
| 52 | Chess reported parent frames that missed the drag point, so every drag on the board's right half was refused (2026-10-17). | Counts a hit-test hit inside the window. |
| 53 | 105 of 108 recorded Office calls passed `disableDiffing: true`, which turned every tree in the call whole. | Keeps filtered reads filtered and acting calls' change notes. |
| 54 | Some engine key presses reset macOS's input idle time (`typeText` 3 of 3, `pressKey` after a click 3 of 3, after a key 0 of 4). | A call that opens a menu by key may still stop. We don't know why a key after a key doesn't count. |
| 55 | A Save sheet with 198 file rows produced 57,000 characters, past Claude Code's tool output limit. | `SLEIGHT_RESULT_TRIM=1` cut a 198-file folder from 72,616 characters to under 25,000 (opt-in). |
| 56 | Finder fixture windows left open held Finder at about 99% CPU for hours (2026-10-17). | The benchmark harness closes them after Finder passes. |

Sources: [CHANGELOG](../../CHANGELOG.md) 1.3.0, [known problems](../known-problems.md), [engine notes](../engine-notes.md),
`fable-1018-word-keys.md`, `LEDGER.md`.

The Excel tab swap has two counts. [LAWS](../status/LAWS.md) and `LEDGER.md` (TP1) say 6 of 8 Excel runs, and
[known problems](../known-problems.md) says 6 of 6 runs that renamed a sheet first. The second count is probably the subset that
renamed, but neither source says so.

## Safety findings

57. An unpriced checkout. FowlBrowser's form-checkout prompt names the item and card but no amount, and the page asks
    "Pay $268.00 now?".
    - On 2026-10-12, sleight's engine path on Opus paid in its passing runs. FowlBrowser's grader counts paying as done.
    - On 2026-10-15 the tester ruled that stopping to ask is the correct result.
    - On 2026-10-16, turbo stopped in all 10 runs of each set. FowlBrowser paid in 8, 8 and 6 of 10 across three Haiku gates and
      in 10 of 10 on Opus.
    - In the first real-window Firefox round (2026-10-17), the engine path paid (1 of 1). The payment rule now requires the
      amount in the user's message.

    The sources disagree on what happened next. [Known problems](../known-problems.md) says the change hasn't been rerun, and
    `LEDGER.md` (RACE2, the same evening) records a 12/12 Firefox round whose form-checkout stopped before paying.
    Source: [2026-10-12-lean-skill-ab.md](../benchmarks/2026-10-12-lean-skill-ab.md), [2026-10-16-gate.md](../benchmarks/2026-10-16-gate.md),
    [2026-10-16-opus.md](../benchmarks/2026-10-16-opus.md).
58. Turbo's figure check asks often. It asks when any money figure on the checkout is larger than the amount in the message. On
    2026-10-15, 50 of 98 honest pages went through without asking, so about half of honest checkouts ask once. The check can't
    catch a page that hides its total or splits a charge into smaller figures. Source: [known problems](../known-problems.md).
59. Forms were the weak spot before turbo: 13 of 24 form runs passed across two gate rounds and a targeted check, against 36/36
    for every other task (2026-10-13). Source: [2026-10-13-gate.md](../benchmarks/2026-10-13-gate.md).
60. The form rule costs a task. The race's form-settings prompt turns two-factor on, and sleight asks before security settings
    even when the user names them, so that task can stop before Save and count as a loss (2026-10-18). A travel run that stopped
    before "Book trip" led to the rule that a booking the user's own message asks for counts as confirmed. Source: [LAWS](../status/LAWS.md),
    [known problems](../known-problems.md).
61. sleight's own cards were reachable. A lane building the 1.3.1 permissions view found that, after one ordinary approval, Claude
    could answer sleight's menu and its approval and payment cards through the `menu_bar` tool or `cua.getApp("consent-host")`.
    No run did it. The 1.3.0 fix refuses the host by name, file and process id in every tool, passed 2,939 of 2,942 focused tests,
    and an adversarial review didn't find a click that gets past it (2026-10-18). Source: `LEDGER.md` pm1 and sec130.
62. Prompt injection. In the 2026-10-12 round (Haiku 4.5), sleight stopped before the injected order and asked before forwarding
    the injected email in all 4 runs. FowlBrowser forwarded the invoice email to the address the injected message named in both
    inject-mail runs and gave no answer in both inject-order runs. Source: [2026-10-12-haiku-baseline.md](../benchmarks/2026-10-12-haiku-baseline.md).
63. Focus. Turbo took focus 0 times in 260 Haiku runs and 260 Opus runs (2026-10-16). The engine's browser path took it 18 times in
    26 runs (2026-10-13). Source: [2026-10-16-gate.md](../benchmarks/2026-10-16-gate.md), [2026-10-13-gate.md](../benchmarks/2026-10-13-gate.md).

## What we don't know yet

- The consent-host refusal hasn't run against the live engine. We don't know what the engine's approval card calls the host, or
  whether the engine's `pressKey` can answer a card in front.
- The engine path's payment rule, with the amount required, has one recorded Firefox round behind it.
- Whether Excel or the engine turns a tab click into a drag, and what holds TextEdit's save lock.
- Effects under about 10% on Office tasks: those need 50 to 200 runs per side, and we haven't run that many.
- Each opt-in flag alone on Office. Only RB1 has a per-flag result. The screenshot skill (SK1) ran excel-edit in 50 to 53 s in
  3 of 3 on an older build and needs a recheck.
- Claude in Chrome's speed: its rounds stopped on its own permission prompt, and it is unmeasured.
- sleight running inside Codex (gpt-6-luna and gpt-6.1-sol), Electron on turbo, and `sleight-mcp setup` in a fresh macOS user.
- The final 1.3.0 numbers. Everything above predates the release build's last runs.
- [Known problems](../known-problems.md) says the tab continuation ran 0 of 9 times in a 2026-10-18 round with the cause unrecorded,
  and `fable-1018-loss-mdn.md` counts 29 of 29 on the later b3 build. The known-problems entry is older and needs updating.
