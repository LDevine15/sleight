# Direct-browser production promotion plan

BP2-12, codex-hdlba, 2026-10-14. Documentation only. Audited base:
`da2604bcd8e62ba46640a492b199a9f710f09cc3` on `private/pane/auto-mode`.
No prototype is promoted by this plan. The engine remains the default. direct browser control
is an opt-in turbo. Source and failed attempts are indexed in [evidence-index.md](evidence-index.md).

Final validation base is `c86c1730910d96525baa6f853e3c0470f781047c`, after the architect's
baseline prose correction, BP2-1R4 and BP2-5T merges. BP2-1R4's joint snapshot provider now
refuses missing or incoherent host evidence. BP2-8R3 is DONE and awaiting peer review/merge.
The matrix records the initial audit below. Its remaining activation conditions still apply.

## Decisions and unknowns first

The owner accepted design v2. These choices are settled: no extension install. a user-selected
browser/root and Chrome consent. one broker per OS user retaining its approved connection
until Disconnect, browser exit or logout. visible connected-idle status. plugin-contained
sleight-owned local UI outside the page, authenticated to the session and exact operation.
The hookup animation is asynchronous. Native apps and Safari retain the engine.
Do not reopen these choices or treat Chrome connection approval as site/action permission.

Activation still requires these concrete owner/architect actions, each recorded separately:

- Architect dispatch of production wiring after this plan's independent review and merge,
  BP2-1R4 MERGED and BP2-8R3 MERGED. A parked/refused dependency is a stop, not permission
  to transplant an earlier branch. BP2-4R4 and BP2-11R are already merged at the audited base.
- Owner approval of the exact runtime/dependency distribution inventory if new binaries or
  vendor-dependent code must be bundled. Choose the supported Node runtime policy, native
  UI/peer provider, signing/update package and installation footprint from a concrete bank.
  The chosen architecture is settled. its code and redistribution receipts are absent.
- Owner-started disposable compatibility/model gates, followed by a separately scoped
  owner-present normal-use task. No scored round, login, real profile access or production
  reproduction is authorized by BP2-12.
- Owner acceptance of the measured supported-browser/version and popup-semantic subset,
  and release after public CI. A fastest claim also needs the LAWS competitor suite
  and final Opus comparison, not a Fowl-only transport probe.

Unknown: authentic user-intent/confirmation ingestion. OS peer credentials and singleton races.
joined helper/adapter coverage. branded Chrome/Helium consent/indicators/setting-off.
profile-to-instance resolution. human takeover signals. popup focus/Space behavior. default
context downloads. protected proof through all serialization paths. full policy latency.
independent 1/4/13 clients. model adoption and exact cleanup. None is inferred from unit green.

## Acceptance and unknown matrix

“Offline” means source/tests with injected trusted callbacks. The integration must supply those
callbacks faithfully outside model-controlled code. Historical MERGED markers on earlier fixes
are superseded by the latest review chain. Do not activate an old authority or popup contract.

| Boundary | Offline bank at this base | Required acceptance proof | Status |
| --- | --- | --- | --- |
| Final authority | BP2-1/R policy and navigation contract. R2/R3 findings retained | BP2-1R4 coherent final identity/time/authority/quarantine snapshot, no callback after fence | Blocking dependency |
| Broker/IPC | BP2-2R queues, framing, dedupe, scoped adapter | Real OS peer identity, private socket ownership, singleton/version races, broker fence at actual input | Unqualified host join |
| Trusted UI | BP2-3R escaped setup, operation-bound UI contract, indicator state | Native UI authentication, exact session/operation response, forged/stale reply refusal, user-only permanent grant | Unqualified host join |
| Reads/refs | BP2-4R4 delivery-aware scoped hybrid reads and semantic refs | Bounded ARIA acquisition, document/frame mapping, recycled rows, complete sensing/omission truth | Joined/live unknown |
| Worlds/protection | BP2-5R fixed MAIN getters, closed-root refs and private proof | Hostile getter timeout/loss, cross-frame attribution, no secrets in model/log/error/delta output | Joined/live unknown |
| Input/waits | BP2-6R3 repeated semantic/authority fence and pre-armed effect proof | Adapter actionability, dialog/event semantics, unknown effect, no dispatch after revocation | Joined/live unknown |
| Forms/files | BP2-7R2 coordinator and host-bound file capability | Form classes listed below, fresh dependencies, exact transmission authority and retained upload cleanup | Joined/live unknown |
| Popups/downloads | Latest BP2-8R3 still in build at snapshot. prior R2 parked | Ordered registration release, child ownership, security/opener behavior and default-context download policy | Blocking dependency |
| Four tools | BP2-9R2 schemas, output budgets, recovery and restricted fallback | Each tool uses the joined broker/semantic adapters. partial receipts agree across routes | Join/model unknown |
| Lifecycle | BP2-10R turn hook, takeover controls, handoff, exact cleanup journal | Authentic takeover, logout/crash/restart, cleanup loss, same operation no replay | Joined/live unknown |
| Package/fairness | BP2-11R metadata refuses sparse dependency inventory | Exact distribution inventory and independent complete 1/4/13 matrix with resource/cleanup evidence | Unqualified |

Form classes are ordinary, custom getter/closed shadow, protected, readonly/date,
and dependent/multi-select/file. Keep their fixture coverage separate from the unchanged benchmark task IDs.
Native checkbox/radio, normalized number/range, native select, virtual combobox and draggable
priority lists are included in their applicable cells. Do not remove any inherited task/check.

## Production file plan

The destinations below are proposals. A wiring dispatch must assign exact files and test ownership.
Production files must not import bench modules or include fixture bypasses. The dependency set
is transitive: review all retained BP-8 tools/errors imports before moving the v2 surface.

| Inspected bench source anchor | Proposed plugin boundary | Join obligations |
| --- | --- | --- |
| `contract.mjs:91`, `policy.mjs:10`, `discovery.mjs:30` | lib/direct-browser/{authority,policy,discovery}.mjs | Use R4, canonical selected root and trusted coherent final snapshot. exact transaction/data/destination checks |
| `broker.mjs:30`, `ipc.mjs:78` | lib/direct-browser/{broker,ipc}.mjs and fixed broker entry | One selected-browser socket, host-derived UID/incarnations, protocol 1, 128 clients/32 pending/4 MiB frames. fail without peer provider |
| `scoped-adapter.mjs:9` | lib/direct-browser/scoped-adapter.mjs | Keep helpers fixed and bind target/frame leases during scoped adapter startup. no generic root connectOverCDP |
| `ui-contract.mjs:79`, `setup-ui.mjs:23`, `indicator.mjs:4` | lib/direct-browser/{consent-ui,setup-ui,indicator}.mjs and fixed native host | Authenticate UI/peer locally. escaped observations never instructions. Pause/Disconnect always reachable |
| `reads.mjs:102`, `refs.mjs:8`, `deltas.mjs:2` | lib/direct-browser/{reads,refs,deltas}.mjs | Frame/OOPIF lifecycle, ARIA provider, delivered acknowledgment, coverage. 12,000-byte envelope/64,000 explicit ceiling |
| `worlds.mjs:27`, `closed-roots.mjs:6`, `protected-proof.mjs:18` | lib/direct-browser/{worlds,closed-roots,protected-proof}.mjs | Fixed isolated inspectors, typed MAIN getters only when necessary. private operation-bound equality proof |
| `input.mjs:67`, `effects.mjs:48`, `waits.mjs:2` | lib/direct-browser/{input,effects,waits}.mjs | Qualified visibility/stability/hit-target strategy, fresh node semantics, one deadline, pre-armed events |
| `forms.mjs:129`, `files.mjs:44` | lib/direct-browser/{forms,files}.mjs | Per-field broker fence/receipts, no implicit submit, canonical approved file and destination, retained cleanup capabilities |
| BP2-8R3 popups.mjs/attachment.mjs/downloads.mjs, absent on base | lib/direct-browser/{popups,attachment,downloads}.mjs | Use only reviewed merged source. bounded parent/child hooks, causal receipts, no root autoattach or profile-wide download override |
| `surface.mjs:94`, `errors.mjs:11` plus BP-8 tools.mjs/errors.mjs imports | lib/direct-browser/{surface,schemas,errors}.mjs | Coherent four-verb route, complete relevant recovery read, redaction before size budget, exact suffix counts |
| `lifecycle.mjs:29`, `takeover.mjs:4`, `handoff.mjs:9` | lib/direct-browser/{lifecycle,takeover,handoff}.mjs | Exact ownership journal, session grants end separately from idle connection |
| `perf.mjs:8`, `perf.mjs:45` | Retain bench accounting. package manifest consumed by fixed loader | Metadata always releaseAuthorized:false / qualified:false. never a runtime authorization source |

New native host source, peer provider and exact helper/runtime inventory need a separately assigned
code bank. The setup-ui callback contract still needs a real authenticated UI host. Exclude fixture
`authorize: () => true`, `dispatchFence: () => true` and createFixtureSlice entries from production.
The small scoped adapter is deliberately incomplete. qualify its closed command/parameter set
against the exact Playwright dependency instead of expanding raw CDP to make initialization pass.
Every input strategy must fence at the actual transport entry after its last asynchronous preparation.

Proposed launch/relay integration points: launch.mjs owns validated route configuration and starts
only the fixed reviewed broker client. relay.mjs advertises the four verbs only for a trusted opted-in
route. Session end revokes authority and releases exact owned targets without disconnecting the
idle broker. Existing native guard/approval and engine/browser behavior retain their tests.
Skill/tool text is a separate measured change: prompt-budget tests/hash and affected model tasks
are mandatory. Do not blend direct tools with a conflicting unrestricted browser-JS interface.

## Defaults, authority and fallback

Default route is engine. Turbo is a trusted user choice, never a model argument or project file.
Default direct capabilities exclude raw CDP, arbitrary evaluate, cookies/history, permission mutation,
browser-close on an attached instance and model-selected filesystem paths. User daily profiles are
never restarted, copied or edited. Unsupported state returns promptly. pending consent never stores
an action to execute later. Browser toggle survives Disconnect. Chrome Allow is always the user's.

Follow this order: consent direct path. existing engine extension path. optional separate owned pipe
profile with explicit choice and separate sign-ins. sleight-owned extension only after a new owner
scope decision proves a need. Safety refusal never routes to a weaker transport. Decline, pending
approval, stale identity, disconnect, partial work and unknown dispatch retain their stop.
An unavailable capability may use a separately approved engine adapter only before input, with proved
none effect and zero completed steps. That adapter still checks its own policy and target identity.
Native/Safari handoff is explicit and keeps engine refusals. Unknown Pay/upload is never retried.

Exact payment terms include item, amount, payee, plan and payment method. The user's own message
can confirm that transaction and its same-transaction dialog. Page/model content cannot. Changed
terms need new confirmation. SLEIGHT_CONFIRM_PAYMENTS=always retains action-time confirmation.
Login/upload/permission exceptions retain exact approved scope. Other consequential actions keep
v1 policy. password-change completion and safety/paywall barriers require human handoff.
Entering data may transmit immediately: approve exact data/destination before the first field,
paste, query navigation or file upload. Session grants are memory-only. once semantics and user-only
Always allow persist. A decline retires matching positive authority without caching a denial.

## Gate protocol and evidence receipts

This is a protocol for a future owner-started sitting. It executes nothing. The architect records
exact package commit, helper hashes, model/settings, route, policy, host/runtime/browser versions,
task/check hashes, order, process incarnation and cleanup ownership before the first run.

1. Bank/review: require latest prerequisite MERGED receipts and independent review of the assembled
   bank. Run offline adversarial negatives and the full check bare, exit 0. lint all new prose.
   Verify plugin code is app-agnostic, injected helper names are local, fakes reject unsupported
   methods and Linux optional/native cases skip by name. Validate immutable upstream notices.
2. Disposable compatibility: qualify branded Chrome 144+ and Helium independently, with policy on.
   Before live work honor hold, owner-away and owned live lock. Visible repository-local harness
   owns launch, control channel, targets, profile, server, events and verified cleanup. Consent experiments omit debugging
   flags. The user answers the browser prompt. Test Cancel/close,
   setting-off, Pause/Disconnect, idle/zero sessions, browser/broker restart, logout and update races.
3. Join/adversarial: authentic forged/expired/stale grants. navigation destinations and secret URL
   queries. stale instance/session/turn/target/frame/document/ref. two-session isolation.
   protected errors/getters/options/AX/DOM/deltas. hostile MAIN/closed roots. late proof/timeouts.
   scoped attachment loss. popup POST/referrer/opener/sandbox/named-window/COOP/OAuth semantics.
   default downloads, Save handoff, takeover, native approval and exact ownership cleanup.
   Missing semantic proof returns unverifiable/unknown or a concrete handoff, never success.
4. Model-free fairness: order-balance 1/4/13 independent OS clients, at least 20 samples per declared
   cell, policy enabled, mixed small/dense/3,000-item reads/actions/forms/popup churn, large payloads,
   cancelled queues and slow/hung pages. Record human consent, cold attach, policy/adapter setup,
   warm complete calls separately. queue tails, CPU, RSS, sensing/delivery coverage and unrelated
   effects. Publish every failure and incomplete cell, raw samples/N, nearest-rank p50/p90.
5. Model adoption: use explicit claude-haiku-5-5 at high effort and a pinned Claude version in both task orders,
   same prompts/task IDs/checks and budget, comparing Fowl and turbo. Require 26/26 across the two
   13-task orders for each arm and every one of the five form classes. No reduced threshold of 24/26,
   reclassified miss, weakened check or dropped order can satisfy promotion. Class-specific fixture
   proof accompanies the unchanged scored suite. it cannot replace a failed suite task.
   Preserve all failed rounds. Record offered tools/actual choices, setup/recovery calls, errors,
   wall time, turns, model time/per turn, input/output/cache tokens, thinking, final answer and priced
   token cost. Distinguish ToolSearch and browser calls. don't add overlapping API durations.
6. Native regression: separate authorized fixture suite with baseline engine approval/refusal,
   foreground/Space/pointer checks, cross-app handoff and no forbidden effects. Browser success
   cannot qualify native behavior. Exact target/process/profile/lock cleanup is independently proved.
7. Normal use: separate owner-present dispatch with the owner's installed package updated and exact
   gitCommitSha verified. Observe real consent/status/takeover and a concrete ordinary browser task.
   No real payment/submission or owner account access is implied by the fixture sitting.
8. Completion/release: architect accepts compatibility, adoption, native and normal-use receipts.
   public CI passes on the intended release. owner/architect release permissions and distribution
   inventory are satisfied. Architect owns merge/tag/GitHub release and release-copy updates.

A pass whose setup, cleanup, forbidden-effect or process independence evidence is missing is held,
even with correct answers. Pass percentiles accompany total time including failures. Unknown
metrics are null. Small CDP latency, an eligible metadata cell or a passing fixture cannot authorize
activation, establish adoption or support a fastest claim.

## Release and rollback checklist

Before activation pin the distributed module/helper/runtime set, protocol and supported products.
retain full dependency licenses/NOTICE/modification statements. inspect the complete installed
package and stale-version behavior. provide truthful status/help and a user-visible off control.
Refuse mismatched versions and define exact broker update/drain behavior. Do not silently migrate grants.

Rollback is a trusted control transition: fence new work first, cancel prepared queues, retain
unknown dispatched effects and exact ownership journal, invalidate refs/leases and revoke session
grants. There is no replay and no automatic compensating form/payment action. Surface the completed
prefix, possibly dispatched slot and truly untouched suffix. Recovery requires a new authorized,
complete relevant read. it never turns the original unknown receipt into permission to resend.

Turning turbo off returns future tasks to the engine only through its ordinary approvals. A normal
Pause can retain the approved socket with visible connected-idle/paused status. A withdrawn or broken
package must visibly Disconnect its exact owned socket before its status host exits. a failed
cleanup leaves an explicit retained journal/status and operator handoff. Never leave an approved
broker hidden, close unrelated/user/kept tabs, change the Chrome toggle or kill shared services.
An update that replaces the broker loses the accepted connection and requires deliberate new consent.
Do not claim close until exact owned absence is independently verified. Keep locks on uncertainty.

Release copy must name distinct receipts: source evidence. disposable browser proof. real-product
qualification. model adoption. owner-present reproduction. merge. tag/publication. This plan supplies
only source evidence. Proposed release lines live in the claim report until the architect has proof.

## Handoff and proposed wiring items

Proposals BP2-P1 (host/authenticated broker), BP2-P2 (joined semantic adapter), BP2-P3 (opt-in frontend
and lifecycle) are in ledger/queue/next/. They remain proposals, all after BP2-1R4 and BP2-8R3 MERGED,
this plan MERGED and a scoped production dispatch. P3 also waits for P1/P2 MERGED.
They assign independent file ownership and offline tests. Their author cannot review their own branch.
Live compatibility/model/normal-use gates remain the architect's separate work.

Give the next owner: exact accepted branch/commit/reviews, latest dependency MERGED receipts,
open matrix cells, transitive file/license map, retained failed attempts, chosen native host/runtime,
protocol/helper package pins and a prepared gate manifest. The owner starts a concrete authorized
sitting only after this bank is reviewable. nothing in BP2-12 runs one or promotes a prototype.
