# Third-party notices

## Playwright core 1.64.0

Copyright (c) Microsoft Corporation. Licensed under Apache License 2.0.

The complete package is retained unchanged at `vendor/playwright-core/` from the owner's
accepted 1.64.0 FowlBrowser cache distribution. It contains 115 files (13,655,528 bytes).
`lib/direct-browser/inspectors/playwright-files.json` records the SHA-256 of every file.
The manifest SHA-256 is `1aa229ee7e6943ee675f5ff74f0982573073ed04f426ee444a9f702566b97ed7`.
`lib/coreBundle.js` has SHA-256 `2325ca4c1c83070e89dc49fb82525508f0a68e0cf12e2a624277968da216b7e0`.

The package's full [LICENSE](vendor/playwright-core/LICENSE) and [NOTICE](vendor/playwright-core/NOTICE)
are retained. Its upstream NOTICE states:

> Playwright
> Copyright (c) Microsoft Corporation
>
> This software contains code derived from the Puppeteer project (https://github.com/puppeteer/puppeteer),
> available under the Apache 2.0 license (https://github.com/puppeteer/puppeteer/blob/master/LICENSE).

There are no modifications to this distribution. The original sleight loader in
`lib/direct-browser/worlds.mjs` verifies its inventory and loads it only for a trusted turbo caller.
This source bank has no browser connection, launch hook or runtime activation.

## Original semantic modules

The original sleight ref, world, closed-root and protected-proof modules are selected from the
reviewed BP2-4R4 and BP2-5R source banks. Their comments retain design references to
FowlBrowser 8b689249ba4e33d2626487aad930605c62e2c6a7 (MIT) and
Playwright e8149b8257d32dcf8f72573ecc43e72439da7080 (Apache-2.0).
These modules contain independently authored sleight code. No FowlBrowser or monorepo
Playwright source is copied into these modules. Their production changes join the ref
identity and closed-root namespace, invalidate in-flight observations on world loss,
and add inventory verification. The 1.64.0 package pin is separate from the source-study revision.

The reads, input, effects and waits modules retain the reviewed BP2-4R4 and BP2-6R3
sources. The attachment, popup and download modules retain the merged BP2-8R3/T
ownership bank. Their production changes bind leased reads and typed input to the
host, preserve delivered refs, and limit uncertain-submit recovery to a fresh read.
The new form and user-file providers are original sleight code. They call the
unchanged pinned Playwright module through the host's closed node interface.
No additional dependency or native binary is distributed by this semantic join.

The v3 `lib/direct-browser/snapshot.mjs` is independently authored sleight code.
Its compact snapshot and closed-root discovery design was informed by FowlBrowser
8b689249ba4e33d2626487aad930605c62e2c6a7 (MIT). It uses the unchanged bundled
Playwright API and carries the design credit in its source header.
