# Browser host interface

BP2-P1S uses protocol 1 and authority contract 3. P2 and P3 join this private
host to the opt-in turbo path. The engine path stays the default. The model
receives four browser verbs and redacted observations. The host keeps the root
connection, native controls, file authority and resource journals private.

## Safety and target checks

Payments use authenticated user intent. A user message naming the item and
payment method allows that payment and its own page confirmation dialog.
Changed terms need confirmation. Other payments ask once through sleight's
native consent UI. `SLEIGHT_CONFIRM_PAYMENTS=always` requires confirmation even
when the user requested the payment. Dismissing a dialog does not require payment
confirmation. Page observations cannot create permission or instructions.

The host presents browser connection and payment controls. It has no site
prompt, persistent site allowlist or per-field transmission tokens. Ordinary
form fields and navigation do not require additional permission. Redaction and
injection handling still apply to every observation.

`createAuthority` requires trusted current, classify, authenticate and snapshot
providers. Before typing or clicking, `checkTarget(operation)` supplies plain
synchronous data with present, visible, enabled and same all true. Missing
checks refuse input. The semantic adapter checks that the current element is
the one the model saw, after asynchronous preparation and before physical input.
An incomplete read elsewhere on the page does not block a checked target.
Each field gets its own target check. The host repeats document, frame, lease,
turn, session and browser identity checks at the transport boundary.

Trusted classification sets `submit:true` for a submit and consequence payment
for a payment. An uncertain submit retains an unknown receipt and blocks a
new submit on that document until a successful fresh read. A failed read or
one from another frame cannot clear it. Dispatch sequence numbers bind read
freshness to the latest uncertain submit, even when results arrive late. Reads
use their first physical command and submits their last, excluding late cleanup
as evidence of a newer capture.
Uncertainty follows the browser incarnation, target, frame, document and origin
across turn, session, lease and broker changes. Recovery preserves that order;
older receipts without order require a new read. Command authority still checks
the full current scope. A read does not prove the earlier submit succeeded.
Ordinary clicks and links can continue after unknown effects.
The broker caches receipts by request id and never automatically resends input.

Turbo requires background targets. `Page.bringToFront` and
`Target.activateTarget` are outside the closed command set. P2 creates tabs and
popups in the background and qualifies that behavior against the selected
browser. Disconnect fences new commands synchronously.

## Requests and receipts

P3 sends exactly `{id, operation, args}`. `validateHostRequest` accepts
browser_open, browser_read, browser_act and browser_fill. Each uses its existing
closed argument schema. IDs have 1 to 128 letters, digits, _ characters or
hyphens. The timeout is 1 to 30,000 ms. Tabs, refs, dialogs and files use opaque
handles. File handles do not contain paths.

A form fill is one ordered operation. The trusted resolver maps each physical
command to its field and closed arguments. The transport shares one request
deadline and revocation generation across the fields. It does not issue field
permission tokens. A second field can proceed after the first physical send
settles, without separate effect proof. A final form readback can verify the
whole operation.

Optional orderedOperations metadata bounds field order and receipt accounting.
Optional preparationOperations metadata lists reads, scrolls and object/world
preparation. Both contain closed semantic operations, with unique IDs.
`context.session.completeStep(index, effect)` records a verified field prefix
when the adapter has that evidence. `completePreparation(id, effect)` records
preparation separately. These calls record progress.
An unfinished submit needs a fresh read before another submit.

Receipts keep completed, unknownStep and untouched separate. A timeout during
field two of three can report `{completed:1, unknownStep:1, untouched:1}`.
The adapter cannot enlarge a verified prefix. Per-result and error observations
pass through the synchronous redactor before storage or delivery. Protected
values, equality checks and digests remain inside the host. Lease loss or session end
prevents late publication.

## Scoped transport

The leased view binds target, cdpSessionId, frame, origin, document and epoch.
Persistent resources also bind browserIncarnation, brokerEpoch, clientSession
and turn. Trusted node and context providers return that current identity.
Foreign nodes, contexts, handles and retired documents refuse.

The adapter allows shallow DOM reads, bounded accessibility reads, fixed helper
calls and typed input. It excludes raw evaluate, arbitrary functions, custom
selectors, MAIN writes and root CDP access. Wheel input accepts only finite
coordinates and deltas bounded to 100,000. The branded broker transport repeats
its coherent scope/time fence immediately before each physical send.

P2 prepares `Page.createIsolatedWorld` on the leased frame with worldName
sleight-state and universal access false. `installFixed(name, context)` admits
only registered source with its exact hash. The Playwright module hash is
`852e40f938e72e6129b6c9a8bde3f4cc6cfe5cecb5ac734b6b06c8ad1fde42bf`.
It is the only source larger than 65,536 bytes admitted by the adapter.

`createPlaywright({constructor})` uses fixed Chromium constructor options in
that isolated world. `callPlaywright({instance,node,method,args})` permits
checkElementStates, elementState, expectHitTarget, ariaSnapshot, fill,
selectOptions and check with their closed argument shapes. Node and instance
must share the owned world. P2 interprets the returned strategy and readback;
a CDP response alone is not action proof.

`answerDialog({dialogId,operation,accept,promptText?})` binds a private dialog
record to trusted semantic metadata and the current operation. Payment dialogs
use the same payment intent rule. The record retires before dispatch, so an
uncertain answer cannot be replayed. Raw dialog events never grant permission.

## User-named files and staged transfer

The trusted file provider checks the user's own message for the exact paths and
the task's named file input. It supplies `createFileAuthority`'s approve callback;
page content and model arguments cannot issue file handles. `issue(paths,binding)`
checks 1 to 16 canonical ordinary files with no symlinks, at most 64 MiB each.
It retains descriptor identity, timestamps, size and a private content hash.

Binding contains browserIncarnation, brokerEpoch, clientSession, turn,
leaseGeneration, target, frame, document, origin, operation and ref.
`stage(token,binding)` reads and privately retains the exact approved bytes.
The opaque stage expires within 30 seconds and permits one transfer. Changing
original paths, exposed buffers or staging paths cannot change those bytes.
Cleanup before transfer prevents transfer. A copied stage cannot authorize it.

`setFilePayloads({backendNodeId,operation,executionContextId},stage)` resolves
the file input identified by the task in the owned isolated world, repeats the binding and target
checks and enters the branded terminal fence. A fixed actuator builds Files
from the retained bytes through DataTransfer, then dispatches input and change.
The browser retains a copy of the bytes before local cleanup. A disabled or non-file input,
or multiple files on a single-file input, refuses transfer.

The receipt is `{transfer:{effect,count},cleanup:{stage,object}}`. Effect
transferred confirms byte transfer, not form submission. Uncertain replies
report unknown and cannot replay the stage. `stage.cleanup()` separately
reports retained ownership. Failed remote-object release retains the exact
object ID for cleanup. P2 keeps its file journal until cleanup is proven.
The existing setFiles path entry still accepts only a branded exact file
capability. Raw `DOM.setFileInputFiles` remains refused.

## Persistent ownership, activation and cleanup

One `createTransportOwner` belongs to each approved browser connection.
`owner.run(lease,brokerContext,dispatch)` gives trusted semantic code a scoped
view. `owner.reader(lease,name,factory)` retains P2's reader and delivered
baseline across requests on that lease. Abort and document loss retire it.
Views and objects cannot cross client, turn or document ownership.

Late acquisitions retain their source connection, route and lease. A separate
cleanup route can only release those exact objects. Failed or pending releases
remain owned. Pending cleanup never launches another physical release.
`revokeSession` fences synchronously. cleanupSession, cleanup and close return
retained resource receipts. Browser socket closure is the broker's own receipt.

The installed loader verifies the accepted package inventory and source hashes.
Native helpers compile from source on the user's Mac at first use. Opt-in and
resume decisions come from the private authenticated native UI, bound to the
session, nonce and broker epoch. Copied JSON, expired decisions and changed
packages cannot enable turbo. The approved browser connection remains visible
as connected-idle when no Claude session is open, until Disconnect, browser
exit or logout.

`host.endSession()` fences before returning a cleanup promise. It revokes the
session authority, retires readers and disconnects the exact client. Unproved
cleanup retains an exact receipt and may be retried explicitly. An empty object
list does not prove tabs, files or downloads closed. Native UI/peer identity,
background behavior, form strategies and cleanup still need sleight-arch's live
qualification.
