# Turbo v3 interface

The installed worker uses Node's inherited fork IPC. A private bootstrap binds each turn's user message separately from tool JSON.
Only branded bridges and frontends enter the launcher and relay. Opt-in and package acceptance remain operator-owned.
Typed v3 unavailability returns to the engine route, without constructing a legacy browser host.

tools.mjs defines browser_open, browser_read, browser_act, browser_fill and browser_tabs.
Their schemas and dispatcher live in tools.mjs. Results are bounded plain text.
The engine serves browser and native tools beside turbo.

page.mjs owns session tabs and the per-tab queue. snapshot.mjs owns delivered refs and reads.
act.mjs and fill.mjs act through Playwright. rules.mjs and v3-context.mjs check the trusted turn, target and payment terms.
Only the user's message or confirmation in the native UI can authorize a payment. Page content supplies no permission.
Unconfirmed submits require a fresh delivered read before retry. Read state never proves the submit succeeded.

The worker connects through the owned-target CDP filter and the selected connection's process evidence.
No browser command brings a page forward. Turn end fences input before asynchronous cleanup.
Unproved cleanup retains resources and prevents another turn from reusing them.

worlds.mjs verifies the exact vendored Playwright runtime inventory before loading it.
host.mjs builds the process observer and consent UI from accepted source into a private cache.
installed-config.mjs and session-host.mjs verify the complete installed plugin, including these sources and the vendor copy.
Shared file, download, handoff, takeover, indicator and closed-root modules retain their existing contracts.

## V3 snapshot ref ownership

The snapshot module assigns public eN refs per document generation. Public refs
never repeat across navigation, even when Playwright restarts its own counter.
The worker calls `acknowledgeSnapshot(page, number)` only after the exact
returned text reaches the client.
Snapshots install `page.getByRef` for the V4/V5 action path. It resolves ordinary refs with `snapshotRefBinding(page, ref)`, which
returns the locator for the underlying Playwright aria-ref. It refuses stale
refs and refs from an undelivered snapshot with a browser_read hint. Closed
sN refs continue through `closedRefBinding`. A raw aria-ref selector bypasses
this generation check and is only for tests of the Playwright read itself.
