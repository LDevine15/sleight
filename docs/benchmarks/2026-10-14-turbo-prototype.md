# Turbo prototype rounds (2026-10-14)

A benchmark-only arm (TP1, `bench/turbo-proto/`) gave Haiku 5.5 at high effort turbo's four compact tools, backed by the merged
`bench/direct-browser2` modules, in a disposable headless Chromium 1248 (Chrome for Testing) with fixture-only trust for the runner's
`127.0.0.1` pages. It has no production safety layer. These runs measure the four tools and their modules, and never support a claim. Each round
ran nine of the 2026-10-13 gate's tasks in normal order. Mobile, takeover, handoff, Wikipedia and MDN were excluded, because the four
tools have no viewport, takeover, native handoff or open-web search. FowlBrowser didn't run on the same night: its round was stopped
when headed browsers switched the owner's Spaces. Its times below come from the 2026-10-13 gate. Raw reports are in
`2026-10-14-turbo-prototype/`.

| Round | Passed | What failed |
|---|---|---|
| `tp1-sleight-turbo-proto-normal-2222` | 1/9 | Every page read came back incomplete, so every fill was refused |
| `tp1r2-turbo-normal-2246` | 1/9 | Claude Code dropped `browser_act`, whose schema has a top-level `oneOf`, so the model couldn't click |
| `tp1r2b-turbo-normal-2249` | 4/9 | `form-travel`, `form-settings`, `form-checkout` and `form-settings-helium` (fills refused in validation), and `demoid` (sign-in didn't complete) |

In the last round, the four tasks that passed took 53 s in all. On 2026-10-13, FowlBrowser took 63 s for the same four tasks and
sleight's engine path took 103 s, in normal order:

| Task | Prototype | FowlBrowser | Engine path |
|---|---:|---:|---:|
| `shipping-link` | 7 s | 13 s | 18 s |
| `size-guide` | 13 s | 16 s | 30 s |
| `inject-order` | 20 s | 19 s | 32 s |
| `inject-mail` | 13 s | 15 s | 23 s |

These are single runs on different nights, a headless Chromium against the owner's Chrome and Helium, and the prototype skips
consent and the broker. Forms, every miss of the 2026-10-13 gate, scored 0/4 here, so turbo's accuracy is unmeasured.
