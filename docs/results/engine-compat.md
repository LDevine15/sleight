# Engine compatibility

Each row is one compatibility check of sleight against a ChatGPT release, newest first, with its UTC date. "Static" rows come
from `bench/compat-static.mjs`, which reads a release's engine files without running them. "Mac" rows come from
`bench/compat.mjs` on the development Mac: the engine checks run the installed engine with no app, and the live checks
drive Calculator and a local page in Safari through sleight. Rows marked "watch task" predate the suite: `scripts/watch.sh`
ran the doctor, an API docs diff and the calculator-click benchmark task. [engine-notes.md](../engine-notes.md) describes
the checks, and this page is rebuilt with `node bench/compat.mjs --publish`.

| Checked (UTC) | ChatGPT | Engine | Where | Result | Live | Warnings and failures |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-19 05:42 | 26.1013.40934 | 26.1013.1001501 | Static | pass |  | js-description: the engine's js description changed, so sleight sends it whole instead of its shorter version (tool-description.mjs ENGINE_JS_HASH) |
| 2026-10-14 13:00 |  | 26.1007.71326 | Mac (watch task) | pass |  |  |
| 2026-10-12 13:00 |  | 26.1007.30912 | Mac (watch task) | pass |  |  |
| 2026-10-10 08:19 |  | 26.1007.21159 | Mac (watch task) | pass |  |  |
