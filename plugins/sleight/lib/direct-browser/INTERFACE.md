# Closed browser host interface

Source contract: BP2-P1I2, protocol 1, authority contract 2. These are private host
interfaces for P2 and P3. They are inactive until the installed loader, semantic
adapter and live gates qualify. No model endpoint exposes the scoped view, root
connection, user controls, file authority or resource owner.

Every acting or reading command uses the current broker operation's branded
terminal transport. Its coherent scope/time snapshot is the final authority
check before the physical send. A once grant is consumed for the exact logical
operation, whose capability is retained across physical commands with a complete
fence at each entry. Failed commands require fresh effect proof before recovery.

The leased view has target, cdpSessionId, frame, origin, document and epoch.
Persistent owners and file transfers also require browserIncarnation,
brokerEpoch, clientSession and turn. Node and context binding providers return
current identity data for that entire lease, never a boolean permission flag.
P2 supplies those trusted metadata providers and the classified operation to the
existing branded authority. Missing or ambiguous evidence refuses.

## 1. Typed Playwright instance

Prepare `view.send('Page.createIsolatedWorld', {frameId, worldName:'sleight-state'})`.
Only the leased frame is accepted. Universal access is false. Install the
registered injected module with `view.installFixed(name, executionContextId)`.
Its SHA-256 must be
`852e40f938e72e6129b6c9a8bde3f4cc6cfe5cecb5ac734b6b06c8ad1fde42bf`.
This is the only exception to the 65,536-byte source ceiling.

`view.createPlaywright({constructor:objectId})` returns `{objectId}` for a typed
instance of that constructor in the same owned isolated world. Constructor
options are fixed: JavaScript, Chromium backend, two stable animation frames,
data-testid, an empty custom-engine list and disabled testing mode. MAIN is refused.

Resolve a leased backend node into that same world with
`view.send('DOM.resolveNode', {backendNodeId, executionContextId})`. Then call
`view.callPlaywright({instance:objectId, node:objectId, method, args})`.

| Method | Exact args | Meaning |
| --- | --- | --- |
| checkElementStates | states: unique nonempty array of visible, hidden, enabled, disabled, editable, checked, unchecked or stable | Playwright actionability checks; success returns null |
| elementState | state: one state above, except stable | Playwright state inspection |
| expectHitTarget | x and y: finite numbers from 0 to 100,000 | Playwright obstruction check for the resolved node |
| ariaSnapshot | depth: integer from 1 to 10 | ARIA snapshot in ai mode; 262,144-byte response ceiling |
| fill | value: string, at most 65,536 UTF-8 bytes | Playwright fill preparation or native control fill; honor its returned strategy |
| selectOptions | options: 1 to 100 records with only value, label and index | Native select strategy; value/label strings at most 4,096 bytes, index from 0 to 100,000 |
| check | checked: boolean | Checked-state inspection; P2 uses fenced pointer input to change state and then checks again |

No selector source, custom engine, force option, arbitrary function, remote
argument or constructor option is accepted. Instance and node objects must share
the same leased isolated world. Each reply repeats node/context/lease validation.
Unknown methods or extra keys refuse with SCOPED_COMMAND_DENIED. Foreign or
retired handles refuse with OBJECT_LOST or WORLD_LOST. Context/document loss or
abort prevents publication. CDP exceptions and fill strategy results are private
semantic evidence, not verified action receipts.

## 2. File input actuator

`createFileAuthority({approve, now, ttlMs})` ports the reviewed BP2-7 capability.
The trusted approve provider obtains exact user file intent outside model/page
input. `issue(paths, binding)` validates canonical ordinary files and parents,
rejects symlinks, reads bytes through a no-follow descriptor and binds size,
inode, timestamps and hash. Files are at most 64 MiB; lists contain 1 to 16 unique
paths. Approval repeats file checks. Opaque tokens expire within 30 seconds and
are consumed once, including on failure. Stage retains the reviewed byte-backed
private staging interface and explicit cleanup.

Binding contains exactly browserIncarnation, brokerEpoch, clientSession, turn,
leaseGeneration, target, frame, document, origin, operation and ref.
The view's trusted fileBinding provider resolves that complete current binding
from the backend node. Its identity must match the leased view.

`view.setFiles({backendNodeId, operation}, capability)` consumes only a branded
file authority token. It sends DOM.setFileInputFiles with the checked canonical
paths through the current operation's terminal fence. Model paths are never an
argument to this entry. The resolver must classify upload intent and bind the
same file list and destination before transmission. P2 retains staging until
its qualified file strategy proves byte transfer and cleanup.

Unknown keys, incomplete identity, changed files, foreign nodes, stale tokens or
different operation/destination refuse before dispatch. Direct send/input of
DOM.setFileInputFiles stays refused. The local trusted-process boundary does not
claim protection against unrelated same-user software rewriting paths during a
browser's delayed read. Use the byte-backed stage for that strategy.

## 3. JavaScript dialog actuator

Page.javascriptDialogOpening creates a private monotonic dialog-N record on the
leased target; closing, navigation, detach and document loss retire it. A
foreign frame or origin is refused. P2 observes the event and maps its dialog
handle to this private record. The trusted dialogBinding provider receives
the private id and lease and returns the complete lease plus dialogId,
operation, accept and optional promptText for the exact authorized operation.

`view.answerDialog({dialogId, operation, accept, promptText?})` sends the closed
Page.handleJavaScriptDialog actuator. accept is boolean. promptText is accepted
only for an accepted prompt and is at most 65,536 bytes. The complete decision
must match current trusted metadata; the terminal authority independently checks
the user's exact action/payment authority. The record is retired before send,
so an uncertain answer cannot be replayed. Missing dialog/decision, changed
choice/text/operation or a foreign lease gives DIALOG_AUTHORITY_REQUIRED.
Direct send and generic input of the dialog command remain refused.

Raw events do not establish a user decision. When CDP lacks a frame identifier,
the trusted semantic provider must prove the leased frame and operation;
ambiguous subframe dialogs must refuse. Branded-browser qualification still
needs this evidence, including same-origin subframes and beforeunload behavior.

## 4. Wheel input

`view.input('Input.dispatchMouseEvent', {type:'mouseWheel', x, y, deltaX, deltaY})`
accepts only those fields. Points are finite and nonnegative; deltas are finite
and bounded to 100,000 in magnitude. Deltas are exclusive to wheel events.
Wheel events exclude button, buttons and clickCount. The authority's closed scroll
intent has exactly deltaX and deltaY. The whole wheel is one logical operation
and one physical send. Extra fields, nonfinite data or lost authority refuse.

## 5. Persistent transport and late cleanup

Create one `createTransportOwner({session, checkLease, helpers, nodeBinding,
contextBinding, fileAuthority, fileBinding, dialogBinding})` per accepted browser
connection. Keep it for the connection's lifetime. P2 dispatch calls
`owner.run(lease, brokerContext, view => semanticDispatch(view))`. The callback
is trusted semantic code, never a permission predicate or model function.
brokerContext contains clientSession, turn, browserIncarnation, brokerEpoch,
operation, signal and the broker's branded session transport.

`owner.reader(lease, name, factory)` inside run retains the same P2 reader and
its baseline across requests for that complete lease. Factories return an
object with dispose. Views, worlds, remote objects and readers never cross
client/turn/document ownership. Concurrent replacement of an active lease
transport refuses with TRANSPORT_BUSY. Inactive sends refuse. Lifecycle loss
disposes readers, and abort prevents late publication. A changed identity needs
new preparation. The owner has a 128-lease ceiling.

Acquired remote objects are privately recorded with their exact source
connection, CDP route and lease. Late acquisition after loss or cancellation
uses a separate cleanup-only Runtime.releaseObject route. It cannot read or
act, choose an unknown object, target a new socket or grant action authority.
Failed/pending releases retain ownership. Explicit cleanup retries only those
records. Pending release never starts another physical release.

`revokeSession(id)` retires session readers and fences future runs synchronously.
`cleanupSession(id)`, `cleanup()` and `close()` return `{closed, cleanup}` with
retained target/frame/document/resource receipts. close fences first and also
retains every in-flight acquisition until its late object is collected. Exact
socket closure remains the broker's separate cleanup responsibility.

## 6. Closed client requests and receipts

P3's client sends exactly `{id, operation, args}`. id matches
`[A-Za-z0-9_-]{1,128}`. operation is browser_open, browser_read, browser_act or
browser_fill. `validateHostRequest(frame)` returns that same immutable frame or
throws INVALID_ARGUMENT. Supply it as the broker's validateRequest provider.

| Operation | Closed args |
| --- | --- |
| browser_open | browser: b handle, url: http(s) URL without credentials, timeout_ms? |
| browser_read | tab: t handle, scope: r handle?, max_bytes: 1,024 to 64,000?, timeout_ms? |
| browser_act | tab, one op or steps: 1 to 16 closed actions, timeout_ms? |
| browser_fill | tab, fields: 1 to 50 unique {ref:r handle, value}, timeout_ms? |

Handles start with their prefix plus 1 to 63 letters, numbers, _ characters or
hyphens. timeout_ms is an integer from 1 to 30,000. Actions are click/hover(ref),
key(ref,key), select(ref,value), scroll(ref,dx?/dy?), drag(ref,to), wait(ref,state)
or dialog(dialog:d handle,action:accept/dismiss,value?). At least one scroll
delta is required. Each action may include expect:{ref,state}; states are
visible, hidden, enabled, disabled or changed, with changed excluded for wait.
Values are bounded text, boolean, finite number, unique string array, a valid
{date:YYYY-MM-DD}, or {files:[f handles]}. File handles are never filesystem paths.
All unlisted keys and non-data/accessor inputs refuse.

The broker preserves completed, results, observation, effect, untouched and an
opened t tab handle. Per-result observations pass the redactor too. Its existing
bounded receipt cache and unknown-effect quarantine remain active. P3 must not
equate a completed prefix with an unattempted or unknown suffix.

## 7. Opt-in, package state, connection state and resume

`createPackageInventory({root, receipt})` is selected by the fixed loader from
trusted accepted configuration outside model/project input. The receipt contains
accepted:true, protocol:1, the exact Node version, helperMode:source and a full
list of {path,bytes,sha256}. Paths are normalized package-relative files. The
inventory includes the original native helper sources, host source and accepted
Playwright file inventory. The verifier checks the complete directory, canonical
root identity, ownership/write bits, symlinks, extra/missing files and every hash
synchronously. User acceptance comes from trusted configuration, and the separate
source-helper loader owns first-use compilation and its cache.

`createSessionHost` exposes verifyOptIn, packageCurrent, status and verifyResume
to P3. The concrete `createBrokerSessionHost({broker, identity, authority,
transportOwner, ui, packageInventory, redact})` attaches the authenticated broker
identity and supplies its real state, branded revocation and resource receipts.
The lower-level factory accepts private providers for separate IPC clients;
those providers must preserve this same host contract.

The trusted loader calls requestOptIn or requestResume. Only a branded private
native UI channel can return enable/resume decisions. They bind the exact session,
request nonce and broker epoch; each opaque proof can be verified once and only
for its own kind. A forged JSON object, decline, expiry, package change or epoch
change cannot enable or resume. status returns the broker's connection state;
connected-idle is the native status presentation when clients is zero. Status
changes never create resume authority. The native helper adds deliberate review
controls, without launching a browser, activating an app or answering a prompt.

## 8. Observation redaction

The session host runs its synchronous redact hook on top-level, per-result and
error observations before delivery. Input/output must be immutable JSON data;
an asynchronous or throwing redactor refuses delivery. The broker also redacts
before storing/providing receipts. Protected comparison, equality capabilities,
values, lengths and digests stay inside P2. No redactor is an approval or proof
provider. Session end or package change during a pending request prevents its
observation from reaching the model.

## 9. Synchronous session end and cleanup receipts

`host.endSession()` fences new requests and enters revocation before returning a
promise. The concrete broker join cancels the branded authority's session
capabilities, retires the persistent owner and disconnects that exact client.
The connected-idle browser connection remains owned and visible. Cleanup returns
`{revoked:boolean, cleanup:[exact resource receipts]}`. Revocation must return
true synchronously: false, throws or promises never become revoked:true.

Resource uncertainty remains in receipts. Thrown, malformed or timed-out cleanup
returns a retained CLEANUP_UNPROVED receipt. Repeated calls may explicitly retry
retained cleanup. Concurrent callers share the same pending collection. In-flight
remote acquisition and unclosed broker connections remain retained. P2 must add
its exact tab/file/download journals at its semantic lifecycle join; an empty
remote-object list is not proof those other resources closed.

No root CDP, connectOverCDP, raw evaluate, model callback or callback allow flag
is added. Authentic installed UI/peer identity, branded-browser world/frame
behavior, protected form classes, focus, cleanup and model gates remain live
qualification work for sleight-arch.
