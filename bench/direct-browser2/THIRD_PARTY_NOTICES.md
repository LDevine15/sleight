# Browser prototype references

The BP2-1 files are original code. They adapt discovery and validation ideas from these pinned sources.
The code was written for this prototype. Upstream source and license text stayed in their source trees.

- Chrome DevTools MCP, Copyright 2025 Google LLC, Apache-2.0. Source revision
  `e52c6b59b476c5e04d8dd9fd4bd017ba3b3d65df`, `src/BrowserManager.ts` (SHA-256
  `ed6f02fa6355fca0786ab37055ffc7f244e0654e9fc0102011d390edd3f2d35c`). Packed version 1.10.1,
  `build/src/BrowserManager.js:292-317,346-365` (SHA-256
  `e8ad9ae18a6836a0e56771afbf453b4b0db9fccca04300a9fa222`). Discovery uses an explicit selected root,
  strict full port/path parsing and independent process/connection evidence. The prototype never launches or closes a browser.
  [Source and license](https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/e52c6b59b476c5e04d8dd9fd4bd017ba3b3d65df).
- FowlBrowser, MIT, revision `8b689249ba4e33d2626487aad930605c62e2c6a7`, `host/host.mjs`
  (SHA-256 `286e776a93f0f1a16cf84a3c53673c514ef01feb03ce650f89ff9ab38f28128b`). Bounded closed
  requests and incarnation checks informed this contract. No extension registration, app-name matching,
  process command, allowlist or policy denylist was copied.
  [Source and license](https://github.com/argofowl/FowlBrowser/tree/8b689249ba4e33d2626487aad930605c62e2c6a7).

Future copied code must keep the upstream license and copyright. Keep any required NOTICE too, and document changes.
Production still requires trusted UI integration. Each supported browser needs its own qualification.
