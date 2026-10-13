# Compact browser surface prototype

Use `browser_open`, `browser_read`, `browser_act` and `browser_fill` for the direct browser route. Native engine JavaScript remains a separate native capability. This prototype has no installed transport, engine integration or JavaScript fallback. BP-12 owns production integration.

Open takes a selected browser handle and an HTTP or HTTPS URL. Read takes a session tab and an optional observed scope ref. Act takes one operation or at most 16 observed steps. Click, key, select, scroll, drag, hover and wait use current refs. Dialog actions require an observed dialog handle and their policy check. Fill takes at most 50 ordered fields and never submits. Values keep their types: text, boolean, number, string array, calendar date or approved file handles.

Proof is automatic. A protected write with proof is complete. Omission of its value is not a reason to refill. An unknown or unverifiable effect stops a batch. Results retain its proven prefix and untouched suffix. Read the expected state before deciding whether an explicit retry is appropriate. Errors specify one recovery action, using an available read or a trusted user control. They never invent a selector.

Each operation requires injected trusted authorization and synchronous redaction callbacks. The future adapter receives only `send`, `on`, `off` and `sessionId` on the CDP session. It owns target, origin, lease and document checks, current refs, actionability, semantic proof, one bounded deadline and cancellation. A model boolean cannot grant permission. The facade is an offline contract, not those implemented browser guards.

The default delivery budget is 12,000 UTF-8 bytes for the entire envelope. Read can request 1,024 to 64,000 bytes. Oversized proof observations become explicit omitted coverage. Receipts and recovery survive. Acquisition and proof still run. Intent is validated without truncation or coercion. Advanced tab, capture and download descriptors are discoverable through an injected catalog, outside routine context. Their code and routing are later adapters' work.

Connection states distinguish setting off, approval pending, declined, stale instance and disconnected. Recovery requires trusted user setup or reconnection. A safety refusal does not select another transport or actuator.

`measure-shapes.mjs` reports whole calls, responses, schema amortization, an extra recovery read and illustrative final narration. It identifies its Unicode word and punctuation tokenizer as a lexical proxy. Characters divided by four are a separate proxy. Neither is a model tokenizer, billed output or thinking count. Model token targets and future adoption remain unmeasured.

Failure fixtures are synthetic regressions for saved failure classes described in ledger/astra-report.md:113-149, study-fowl-tool-shapes.md:119-175 and the BP-8 brief. They are not verbatim model transcripts or a replay score. These modules and tests were written from the design contract. Live form correctness, model adoption and speed require owner-started qualification after the dependent adapters are merged.
