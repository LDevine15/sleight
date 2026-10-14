# Direct-browser evidence index

BP2-12 audit, 2026-10-14. Frozen code base `da2604bcd8e62ba46640a492b199a9f710f09cc3`.
No new adaptation, browser/model experiment, production adoption or release is claimed.
Evidence below was read as source/report data. Historical author and peer receipts are in
`~/Projects/sleight-wt/ledger/claims/`. they are outside the product package.

Final validation used base `c86c1730910d96525baa6f853e3c0470f781047c`. By then BP2-1R4 and
BP2-5T had MERGED receipts. BP2-1R4's peer review covered
`0aba9f324c3c99455e9a80027940c054c97a2b32`. It recorded 141 contract passes and 22
regressions red on its base. The code requires a private synchronous joint scope/time snapshot
and refuses without a provider.
BP2-8R3 was DONE awaiting peer review/merge. These updates clear no live qualification cell.
The historical audit table below preserves what was available when the evidence was read.

## Immutable evidence and provenance

| Source | Exact revision / path | Meaning and limit |
| --- | --- | --- |
| v2 design | codex/astra-browser-design2 at bfdb427d6d89c4df5963b1b2656524bdb8b05339. bench/browser-design2/DESIGN.md, SOURCE-MAP.json, VALIDATION.md | Normative v2 sections 3/7/8 and carry-forward. old pending owner choices are settled by later ledger rulings |
| Consent raw records | Same commit, bench/browser-design2/evidence/consent-1791926350105.jsonl, summary.json, summary-first-matrix.json | CfT 151 consent and tiny transport only. 21 accepted, one cancel, 1,440 replies, exact disposable cleanup reported |
| Consent earlier failures | Same commit, all consent-*.jsonl, recovery.jsonl, measured-run.sh.txt, VALIDATION.md | Early ignored synthetic clicks, stale endpoint and protocol failures retained. measured launcher lacked the live lock. later launcher repaired but not remeasured |
| Chromium behavior/protocol | Same commit, SOURCE-MAP.json, evidence/chromium-155-pin.json and protocol-selected.json | Source behavior. protocol snapshot fetched from master, hash-bound at retrieval but not immutable upstream release. revalidate qualified product protocol |
| Helium bundle | Same commit, evidence/helium-bundle.json, helium-resources.json | Bundle 0.19.2.1 / Chromium 155.0.8059.39 strings/resources only. running consent/indicator/off/latency remains unqualified |
| v1 design | ledger/browser-path-design.md. supportingReports SHA-256 2f0517d04777a5fb37b0e5b7b7c101206bc88b1e04e3bcb755fa367e46aebf9f in v2 source map | Extension-independent semantics/safety retained. extension install/host transport superseded |
| Browser lab | codex/astra-browser-lab at dbcd70cd70752544aa14aaa6aeabd1af6dc7d3a9. bench/browser-lab/. ledger/browser-lab-report.md | Model-free read/input/world/popup/calibration. every prior failure and unmeasured cell remains in results/report |
| Gate failures | docs/benchmarks/2026-10-13-gate.md and adjacent 2026-10-13-gate/ raw reports at audited base | Existing engine path and model evidence, not direct-path qualification |

The final CfT experiment had fixed order and uncontrolled load. Its UDS clients ran in the same
process. Its 1/4/13 transport samples were not independent Claude clients, policy, adapter startup,
forms or resource measurements. Connect time includes an artificial 1.2 s prompt-read wait.
human response time was not measured. The absent visible automation strip remains unexplained.
The combined 360/360 popup-hook fixture report does not prove transient headful focus/Space behavior.
Read-marker presence never proves universal semantic coverage. A custom getter may execute page code.

## Failed gate denominator and accounting

The first gate used pane/auto-mode 35ecd7fd, explicit claude-haiku-5-5 high, both orders:
engine sleight 23/26 versus Fowl 26/26. wall 1,206 versus 677 s. browser calls 291 versus 277.
errors 39 versus 9. The 24/26 gate missed by one. Its three misses were travel (normal),
settings (two-factor) and checkout (swap). This plan's future parity gate is 26/26, not 24/26.

The second gate at b15048d9 returned 21/26 versus 26/26. 1,517 versus 711 s. 332 versus 256
browser calls. 51 versus 9 errors. Forms accounted for the five misses. Across the five saved form checks,
17/40 passed (travel 6/10, settings 9/20, checkout 2/10). non-form tasks passed 36/36 in both
full gates. QT1, FM1, AS-3-off, AS-3-on and FM3 failed/partial rounds remain evidence too.
AS-3-on's missing swap order and tool non-adoption cannot become a passing sample.

The lab's raw paired Fowl duration is 712.026 s for the second gate while published text says
711 s (first raw is 677.050 s versus 677). Preserve the discrepancy. Total Fowl tool calls
include 35/36 ToolSearch calls while published columns count browser calls. API duration counters
overlap tool accounting. do not add them into wall time. Published Claude cost figures are not a
fresh price proof. the new gate prices usage from the declared model's token table and marks unknown
models unpriced. Every failed attempt, timeout, over-budget run and cleanup failure stays included.

## Module chain at the audited base

Claims and review markers are snapshots, not permanent qualification. Source below is present in
bench/direct-browser2 unless noted. Later corrective branches supersede earlier MERGED/FIX records.
Recheck branch SHA and MERGED receipts before any wiring. The bench bank is not installed product code.

| Item chain | Latest corrective source branch / commit | Read audit and remaining boundary |
| --- | --- | --- |
| BP2-1, 1R, 1R2, 1R3, 1R4 | 1R3 fef91aff42af96fbb070061e5f66a419f081386b failed. 1R4 in flight | contract/policy/discovery. decline retirement, final scope/time, late independent proof and navigation transmission. R4 MERGED mandatory |
| BP2-2, 2R | codex/bp2-2r 9dcd0d68225d35695dbf2b033bcc9875b030543c, MERGED | broker/ipc/scoped-adapter. queue/fence identity and redaction. real peers and Playwright join absent |
| BP2-3, 3R | codex/bp2-3r 271227752130ca3ddaeca2e1dcf2672044a6bd67, MERGED | setup-ui/ui-contract/indicator. no native UI code or branded indicator qualification |
| BP2-4 through 4R4 | codex/bp2-4r4 56a015b7ed5983e4c86cb5cbb6f1c8c2d8c68f7d, MERGED | reads/refs/deltas. inherited incomplete/failed sensing, delivery baseline, budgets, case-insensitive autofill protection fixed in chain. no real policy/host join |
| BP2-5, 5R | codex/bp2-5r 559b03e3ad4b3833eeef997df4cfb8d25316dbbb, MERGED | worlds/closed-roots/protected-proof. isolated/MAIN/read redaction/private proof. full hostile-page serialization join unqualified |
| BP2-5T | codex/bp2-5t 926d33849c0219c8e24210853dddc7112b026333, peer MERGE but no MERGED at snapshot | forms deadline stability. source branch not assumed present. reconcile this parallel file touch during join |
| BP2-6 through 6R3 | codex/bp2-6r3 fa4c92fbd1d46c8c59c64b5a8cc12f58a480c8b4, MERGED | input/waits/effects. semantic identity after preparation and adapter race fences. actual adapter contract required |
| BP2-7, 7R, 7R2 | codex/bp2-7r2 796107284bab12d0b2490662a94d252564942741, MERGED | forms/files. protected transport-vs-proof and upload cleanup holds, per-field fences. fake adapters are not an end-to-end qualified form path |
| BP2-8, 8R, 8R2, 8R3 | 8R2 c2cb892a failed and parked. 8R3 in flight | popups/attachment/downloads absent at base. both pending-registration clear-order findings must pass and merge |
| BP2-9, 9R, 9R2 | codex/bp2-9r2 05258d163d29526ded9d139ec0e25104d534a6e1, MERGED | surface/errors/adoption. incomplete-state recovery stopped, proof/prefix retained under budgets. imports BP-8 tools/errors transitively |
| BP2-10, 10R | codex/bp2-10r a5d6db4da99d1bcd4c4c856c80c512d022f40362, MERGED | lifecycle/takeover/handoff. final authorization, concurrent connection, exact ownership. real takeover/crash/native approval unknown |
| BP2-11, 11R | codex/bp2-11r 41e391f7f00c0a1911f3068407ad93b8d8aa7c66, MERGED | perf/package-plan/qualification. sparse inventory refused. ready/eligible metadata always lacks release authority |

Every original report and REVIEW.md is retained. Retain the authority final
clock/current callback failures, world/proof tests, omitted-output/coverage recovery failures,
form dispatch/cleanup races, popup registration ownership races or sparse dependency repro.
Source callbacks attest semantics only when a real trusted code supplies them.

BP2-7's five classes: ordinary. custom getter/closed shadow. protected. readonly/date.
dependent/multi-select/file. Unit fake green does not establish all five through the assembled broker.
The mandatory pre-entry data/destination/payment fences are an additional acceptance requirement,
even where a fixture can be filled faster without them.

## Selective source and license inventory

The following are design references/candidates, not automatically distributed dependencies. Prototype
headers describe original codes with behavior/architecture credit. No new adaptation
is made here. Copying in a future wiring item requires exact path/pin, retained copyright and
license text, NOTICE when applicable, modification statement and a full transitive inventory.
Do not bundle closed engine/extension/Claude code or competitor marks.

| Project and immutable pin | Original paths / proposed retained use | License and modification record required before shipment |
| --- | --- | --- |
| FowlBrowser 8b689249ba4e33d2626487aad930605c62e2c6a7 | host/host.mjs. mcp/src/{hostClient,browsers,cdp}.mjs | MIT copyright/LICENSE if copied. broker scheduling/framing/lifecycle ideas independently rewritten for consent, session authority and scoped targets |
| Same Fowl pin | mcp/src/{snapshots,closedShadow,tools,popups,browserData,takeover,turns}.mjs. mcp/bin/turn-ended.mjs | MIT. record only selected adapted portions, delivery-aware refs/redaction/partial receipts, early owned-child policy and stricter takeover/cleanup |
| Same Fowl pin, Playwright-derived vendor | mcp/src/vendor/browserModel.mjs, mcp/src/vendor/cdpRelay.mjs, vendor/LICENSE, vendor/NOTICE | Apache-2.0, preserve Microsoft headers and Fowl modification credit/NOTICE, record virtual-target/broker-socket changes. current scoped-adapter is a new smaller code |
| Playwright e8149b8257d32dcf8f72573ecc43e72439da7080 | packages/injected/src/{ariaSnapshot,ariaSnapshotDistiller,domUtils}.ts. packages/isomorphic/ariaSnapshotRenderer.ts. packages/playwright-core/src/tools/backend/{snapshot,form,tab,utils}.ts | Apache-2.0, exact source/NOTICE. scoped actionability/ARIA only, no global target/foreground/raw-evaluate API |
| Installed PW package evidence | npm playwright-core 1.64.0 lib/coreBundle.js. SHA-256 2325ca4c1c83070e89dc49fb82525508f0a68e0cf12e2a624277968da216b7e0 | Apache-2.0. not silently interchangeable with monorepo pin or MCP wrapper's 1.64.0-alpha-1790635538000. chosen distributed runtime remains unknown |
| Chrome DevTools MCP e52c6b59b476c5e04d8dd9fd4bd017ba3b3d65df | src/BrowserManager.ts, TextSnapshot.ts, formatters/SnapshotFormatter.ts, utils/WaitForHelper.ts, tools/input.ts | Apache-2.0. Google copyright, license/NOTICE if present. strict full-integer root/endpoint selection, no automatic launch/reconnect or source defaults copied |
| Packed CDM 1.10.1 | build/src/BrowserManager.js. SHA-256 e8ad9ae18a6836a0e56771afbf453b4b9ea1d384b4b0db9fccca04300a9fa222 | Package/source provenance differs. preserve version/hash and revalidate before any adaptation |
| Chromium CfT source 782af9cb30a53f54487e5d2e44738645a8ec457c | chrome/browser/devtools/{remote_debugging_server,devtools_connection_dialog,chrome_devtools_manager_delegate}.cc. content/browser/devtools/devtools_http_handler.cc. prefs/UI/resources indexed by v2 SOURCE-MAP | BSD-3-Clause, behavior source only. not copied or redistributed by prototypes |
| Chromium 155 source 3ff7ac5a9224be9156d7f8703a06e22890aafd34 | Same consent/server paths, resource/inspect UI and source pins in v2 SOURCE-MAP | BSD-3-Clause, source only. does not qualify running Helium/Chrome |
| Browser Use 0.13.11 | browser_use/dom/serializer/{serializer,paint_order}.py. dom/views.py, study-browser-use.md cache/source record | MIT optional research candidate only. no Python runtime or code adopted. acquire immutable release/artifact hash before copying |
| Optional Fowl cursor, same Fowl pin | mcp/src/cursor/{overlay.js,index.mjs} | MIT plus retained Cua attribution from Fowl THIRD_PARTY_NOTICES. decorative async cursor only if separately selected. not an input/runtime dependency |

V2 SOURCE-MAP.json records exact per-file hashes. The BP2-1 THIRD_PARTY_NOTICES packed
BrowserManager hash is shortened/malformed compared with the 64-hex source-map value above.
reconcile it in the future distribution inventory instead of treating that text as a verified pin.
This prose-only consolidation records the source license obligations. Source-map copyright ownership,
upstream LICENSE and NOTICE must be inspected at the exact pin if code is selected for copying.
The repo MIT license does not replace third-party Apache notices. No extension/native-host installer,
registration manifest, store key/update or owner's profile is part of the runtime plan.

## Measurement and acceptance separation

Existing author full-check receipts often report sandbox AppKit/process/uv/fake-PTY failures then
an unchanged scoped host retry. Those results are branch-specific, not BP2-12's current check.
Opt-in real-page files skip without the declared live flag. missing live execution stays unknown.
All new measurement records need raw failures, exact config/counts/N, nearest-rank p50/p90,
separate startup/consent/warm clocks, coverage, unrelated effects and exact owned cleanup.
Same-process IDs, fake auth flags and tiny command timings cannot qualify a package or speed claim.

The companion promotion plan maps every stage through independent review, authenticated host join,
per-browser disposable proof, model adoption, native regression, owner-present normal use and
public CI/release. An offline bank being DONE or MERGED supplies none of those later receipts.
