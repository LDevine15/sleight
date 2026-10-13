# Direct-browser package plan

BP2-11 offline draft, 2026-10-13. The owner dispatched BP2 work. BP2-10 is merged. This base has
world/protected-value and lifecycle modules but lacks the broker, IPC, authority, setup and compact
surface assembly. Joining those modules belongs to BP2-9/BP2-12. This document describes the future broker package.

The plugin contains its reviewed broker and fixed helpers. It uses one explicitly selected browser
application, process incarnation and user-data-root. It does not install an extension, register a native
messaging host or create a launch-at-login service. It never edits a daily profile, Chrome's
checkbox, sign-ins, permissions or owner settings. Existing engine control remains the fallback.
An optional separate automation profile follows an explicit user choice, explains separate sign-ins
and uses owned child cleanup. Declined authority cannot select this fallback as a bypass.

## Decisions and release gates

The owner settled both choices in LEDGER.md's BROWSER DECISIONS on 2026-10-13. Retain the approved
connection when no Claude session is open, until explicit Disconnect, browser exit or OS logout.
Show connected-idle status. Ending the last session releases its tabs, references and authority;
it does not disconnect the browser or carry those session grants into the next session. A lost
connection requires deliberate new browser consent. There is no automatic idle reconnect.

Include sleight-owned local UI with the plugin, outside the page, authenticated to the session and
exact operation. The package metadata specifies `sleight-local-ui` and requires outside-page,
session and operation binding declarations. Payment/data-destination checks remain required.
The joined host must prove those declarations, its indicators and its native authentication.

Node has no portable getpeereid provider. The host must qualify peer credentials, private socket and
directory ownership, stale-lock handling and singleton races. JSON uid/approved flags cannot do it.
Default packaging remains unqualified until the joined authority/adapter/host has passed review.
Distributing dependency binaries or code requires the existing owner redistribution decision and notices.

## Inventory before bundling

| Component | Current evidence | Required packaging action |
| --- | --- | --- |
| Original sleight prototypes | Repository MIT LICENSE | Pin exact selected commits and include LICENSE |
| Node runtime | Existing host runtime used by unit tests | Choose and qualify supported runtime policy, without an installer here |
| BP2 broker/IPC | codex/bp2-2 and its review fix, not on this base | Join the reviewed fix, protocol 1, authenticated host peer provider |
| Scoped Playwright adapter | BP2-2 design contract | Record exact dependency/version/license and vendor NOTICE before bundling |
| Native confirmation/status host | Owner approved sleight local UI included in the plugin | Pin host version/authentication and qualify it independently |
| Browser | User-selected external application | Qualify Chrome 144+ and Helium separately, never bundle owner data |

The source-map pins remain design evidence. FowlBrowser MIT and Playwright/CDM Apache-2.0 are
adaptation candidates, not dependencies silently copied by this draft. Chromium source supplied
behavior evidence only. This draft uses original sleight code and behavior notes.

## Version and update contract

Record exact bundle commit, fixed-helper commit and IPC protocol in the frontend/broker handshake.
Concurrent frontend versions cannot mix helper/receipt shapes within one broker generation.
Mismatch returns VERSION_MISMATCH without dispatch, reconnect or migration. Older frontends stay
on their accepted broker or use existing engine control only through its usual authorization.

An update drains prepared work, fences new requests and parks unknown dispatched effects before
replacing its owned broker. Retain exact ownership journals and explicit cleanup uncertainty.
Restart loses Chrome's accepted socket, invalidates refs/leases and presents deliberate new consent.
Never retry unknown actions. Browser restart, changed process incarnation and setting-off also
invalidate connection acceptance. The package updater preserves the browser toggle and user tabs.

Start with BP2-2's existing 128-client, 32-pending-per-client and 4 MiB frame limits. Measure queue
fairness and resources before changing them. Teardown/revoke has priority, but a client timeout
cannot release an unknown in-flight mutation. Startup keeps one authenticated singleton per selected
OS-user/browser-root. A stale singleton requires exact owned cleanup, not removal by guessed PID.

perf.mjs checks plan and handshake metadata only. Its ready result means the declared fields are
present for review. releaseAuthorized is always false. It supplies no IPC authentication or grants.
