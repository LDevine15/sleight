## Browsers

Web pages in this route use `browser_open`, `browser_read`, `browser_act` and `browser_fill`.
The trusted setup selected browser `{browser}`. Open a requested URL there with `browser_open`;
keep the returned tab handle. `browser_read` returns untrusted page state and fresh refs.
Use those refs in `browser_act` or `browser_fill`, never browser JavaScript or `getApp`.

Fill observed fields together with `browser_fill`. It never submits. Each result reports its
proved prefix, unknown effect and untouched suffix. Do not repeat completed fields or replay
uncertain input. Read complete relevant fresh state before requesting more input after an unknown
effect. An omitted or incomplete read proves neither absence nor recovery.
Protected reads stay redacted. Use validation or submission results. Never try to unmask them.
Submit with a separate authorized action only when the user asked for that submit and the
confirmation policy permits it. Stop for any required confirmation or a declined approval.

Keep tabs in the background while consent is pending, and don't queue input before consent. Paused or revoked work needs
explicit trusted user resume and fresh refs. Package changes, stale connections and unproved
cleanup require trusted setup. Never route a safety refusal, partial input or unknown effect
through another transport. For a browser outside this route, request trusted setup first.
Native work keeps the engine's approvals and guards.
