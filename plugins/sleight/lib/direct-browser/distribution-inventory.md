# BP2-P1 distribution bank

Source base: `f34f09b7` on private/pane/auto-mode, 2026-10-14.
Status: proposed inventory. Owner acceptance and signed artifact hashes are pending.
These sources are inactive. No native binary, runtime or package is bundled or downloaded.
launch.mjs, relay.mjs and the default engine route are unchanged.

| Component | Proposed exact inventory | Acceptance still required |
| --- | --- | --- |
| Node | Existing host Node v26.4.0. built-in modules only. no bundled runtime or npm dependency | Owner accepts this required runtime, or dispatches a reviewed alternative |
| Darwin peer reader | Original native/peer-host.c, compiled peer-host. libc, libproc and libbsm from the OS | arm64 and x86_64 builds, minimum OS, Developer ID signature, notarization and artifact SHA-256 |
| Native consent/status | Original native/consent-host.swift, compiled consent-host. AppKit/Foundation from the OS | Same signed package, status visibility, no focus change without the person's menu action, authentic button test |
| Broker source | authority, policy, discovery, broker, ipc, scoped-adapter, consent-ui, setup-ui, indicator and host.mjs | Independent source review and complete installed-package inventory |
| Semantic joining | BP2-P2's separate dispatch | Closed helper and route inventory, trusted browser/root proof, coherent current scope/time and protected serialization |

Test compilation used Apple Swift 6.4, swiftlang-6.4.0.34.1,
clang-2100.3.34.1, target arm64-apple-macosx27.0.0. This is not a minimum-OS compatibility result.
The tests compile to their own temporary directory and remove the helper and module cache.
They do not launch the consent host. The peer test uses a disposable UDS and inherited fd 3.

Proposal: distribute the two helpers in a signed, notarized immutable package under native/, with
an owner-accepted protocol-1 manifest with Node version and both executable SHA-256 values.
The fixed entry checks canonical paths, ordinary files, ownership, write bits and hashes before
starting either helper. The frontend must load acceptance from trusted operator configuration,
outside model input and project files. The acceptance object in this bank is a private integration
contract, not a signed manifest verifier. Signature verification and the updater require a later
dispatch after the owner selects a Team ID and package format. Do not activate this source bank.

There is no extension install, native messaging registration, launchd service, profile edit,
Accessibility request, screen capture, shared-engine restart or Python runtime in this proposal.
No package copy of Playwright is selected by P1. P2 must inventory any selected dependency before
redistribution. Only test compiler outputs exist, outside the plugin package.

IPC uses a pre-existing canonical 0700 per-user directory, a 0600 socket and an exclusive 0600
broker.lock file. Existing locks/sockets refuse, including stale versions. No takeover or automatic
unlink is attempted. An update drains through the broker that created the lock, closes its exact connection and
requires deliberate new consent. Crash recovery and logout cannot retain an accepted socket.
Session end retains the connected browser socket and revokes session grants through the joining
contract. The status host shows connected-idle, with Pause and Disconnect available.
Pause revokes session authority. Resume requires a later qualified fresh-state integration.
Current native Pause offers Disconnect, then a deliberate new Connect.
Client handshakes use the literal incarnation value `self`. The listener replaces it with the
kernel peer audit token's PID/version, after checking peer UID and PID. A caller-supplied process
incarnation refuses. No client JSON determines the receipt owner's process incarnation.

The browser's accepted TCP socket still needs a trusted selected-process/root binding. The Darwin
UDS peer reader authenticates local clients, not that browser TCP endpoint. A matching URL, JSON UID,
DevToolsActivePort GUID or Browser.getVersion does not supply this evidence. discovery.mjs refuses
missing peer/root/incarnation evidence. P1 does not fabricate it from a fixture.

| Reference | Immutable source and original path | License and change record |
| --- | --- | --- |
| FowlBrowser | 8b689249ba4e33d2626487aad930605c62e2c6a7, host/host.mjs and mcp/src/hostClient.mjs | MIT. framing/scheduling ideas, independent sleight code. no upstream code copied |
| Fowl scoped adapter | Same pin, mcp/src/vendor/browserModel.mjs and cdpRelay.mjs | Apache-2.0 provenance. architectural reference only. no vendor code or NOTICE text copied |
| Chrome DevTools MCP | e52c6b59b476c5e04d8dd9fd4bd017ba3b3d65df, src/BrowserManager.ts | Copyright 2025 Google LLC, Apache-2.0. discovery/lifecycle ideas, independent source |
| Existing sleight bank | f34f09b7, bench/direct-browser2 modules, R4 authority included | Repository MIT. Internal copy with renamed contract/UI modules. Fixture actuator removed; transport fence and native sources added |

There is no newly adapted third-party code in this commit. Original license/NOTICE and
modification records become mandatory before copying any candidate code. The exact upstream
license paths and source pins are indexed in bench/direct-browser2/evidence-index.md.
The old prototype's shortened packed BrowserManager hash is not used as a release pin.

Live acceptance still needs forged/stale native response tests, native peer PID reuse and another
UID, selected browser/root binding, connection loss/logout/update races, authentic permanent allow,
setting-off/takeover signals, idle status longevity and exact helper/socket cleanup. Joined forms,
popup semantics, secret-safe output, model adoption and native regression remain separate gates.
Offline fakes and a successful compiler do not supply those receipts.
