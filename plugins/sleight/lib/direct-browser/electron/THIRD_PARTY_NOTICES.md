# Electron broker and launcher sources

The broker, launcher and fake-child tests are independently authored. This item uses independently written source throughout.

The transport uses the public Chromium NUL-delimited JSON protocol on inherited descriptors 3 and 4. The research in
`ledger/electron-path-design.md` identified Playwright 1.64.0's Apache-2.0 transport and connection modules as future reuse candidates.
The broker and launcher do not import or redistribute Playwright. Its Electron launcher adds inspector and TCP flags, so it is excluded.

The recipe registry is empty. The measured research builds have no complete filesystem-isolation audit. A trusted host must
review a build's isolation recipe before adding it, supply debugger approval, and use the app's own Quit only on the user's click.

The host supplies `ElectronBroker` with launch, ownership and authority callbacks. `launch.py` supplies the pipe and owned-child
primitive for that host. The host must supply app authority before these modules can operate. They moved here from bench/direct-electron in EPV3-7.

## EPV3-2 additions

`D/electron-connection.mjs` hands the already vendored, pinned Playwright 1.64.0 (`plugins/sleight/vendor/playwright-core`, loaded only
through `D/worlds.mjs` with its hash-checked manifest) a transport object for `chromium.connectOverCDP`. Playwright's source stays in the vendor directory and is not copied here, and its Apache-2.0 LICENSE, NOTICE and ThirdPartyNotices stay where they are. The channel,
journal, host and Python adapter are independently written with Node and Python standard libraries only. The adapter reads process
birth times through the operating system's libproc (macOS) or /proc (Linux) and has no other dependency.
