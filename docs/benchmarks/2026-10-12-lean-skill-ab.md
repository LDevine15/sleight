# Lean skill A/B on FowlBrowser's tasks (2026-10-12)

`SLEIGHT_PROMPT=lean` swaps sleight's skill (923 words) for the lean one (430 words). Both ran FowlBrowser's 13 tasks in
both browser orders on `ec59d81`, interleaved (lean normal, default normal, lean swapped, default swapped), Opus 5.5 at
medium on the owner's account, from 15:54 to 16:02 EDT with the owner using the Mac.

| Skill | Done right | Time, 26 runs | Cost | Calls | Turns |
| --- | --- | --- | --- | --- | --- |
| lean | 24/26 | 981 s | $8.92 | 206 | 232 |
| default | 25/26 | 1,006 s | $8.72 | 221 | 247 |

Lean and default are within run-to-run noise on time and cost, and lean lost one more task. The default skill stays. Every miss
was `form-checkout`:
- Lean, Helium: the agent reported another session's submission id and said it wasn't sure it was its own.
- Lean and default, Chrome: the page's total still read $268.00 after the promo applied, and the agent declined the
  payment confirm because of it. Chrome then stopped answering (`Emulation.setFocusEmulationEnabled` timed out on every
  later call). In the passing runs the agent saw the same $268.00 and paid.

Raw reports, home paths shown as `~`, are in [2026-10-12-lean-skill-ab/](2026-10-12-lean-skill-ab/), one file per skill and
order. Turns come from `bench/fowl/anatomy.mjs`.
