# Turbo v3 distribution inventory

Turbo uses the running Node runtime, built-in modules and the pinned Playwright core 1.64.0 runtime under vendor/playwright-core.
The exact vendor file hashes live in inspectors/playwright-files.json. LICENSE, NOTICE and ThirdPartyNotices.txt remain intact.
The loader verifies every retained file and refuses extra, missing, changed or linked files.

The plugin distributes native/peer-host.c and native/consent-host.swift as source. The process observer still supplies the selected
browser's PID, start time and executable evidence. The consent host supplies authenticated payment and connection controls.
Both compile locally at first use with Apple's command-line tools. No signed or notarized native binary is distributed.

host.mjs publishes both helpers only after compilation and hash verification, under a private per-user cache.
Its exclusive build.lock refuses concurrent publication. Source and executable identity are rechecked before each launch.
Only a locally issued receipt object can start a helper. Missing tools or failed compilation leave the engine route available.

installed-config.mjs accepts only the operator's fixed configuration. The source receipt inventories the entire plugin, including
launcher, relay, hooks, helpers and vendor bytes. A package change needs fresh operator acceptance.

worker.mjs uses inherited fork IPC instead of the retired socket broker and peer-client protocol.
V3 retains the native process observer, UI channel, user-file authority and selected browser connection.
Engine apps and browser tools remain available beside turbo. No app, profile or browser is opened during package verification.

Live qualification covers the v3 page, snapshot, action, form, rule, context and worker tests through the host runner.
Offline tests and compiler success do not prove live behavior, foreground preservation or task performance.
