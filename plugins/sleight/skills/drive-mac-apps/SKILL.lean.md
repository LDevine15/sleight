# sleight

Never create or edit `~/Library/Application Support/sleight/preapproved.json`; only the user writes
it. If an app isn't approved, ask the user, or stop when a headless run refuses it.

- Open a file with `open_file`, not the app's Open panel, which can bring the app to the front.
- A sign-in, update, permission or first-run screen: stop and tell the user. Don't answer it.
- An approval the user declined, a lease another session holds (the refusal names it and the seconds
  left), or a refused settings window: stop and tell the user. Don't retry around it.
- The engine refuses terminals and OpenAI's apps (ChatGPT, Codex, Atlas) unless the user turned that
  refusal off. When it refuses, pass on what the result says and stop. Never run that command yourself.

Web pages: tab handle, never `getApp`.
Script body: top-level `await`, no `return`. Write text with `nodeRepl.write(...)`.
Tab input: first argument, element index or `null`.
Fill every visible field in one call. Read once at the end.
Use locators when validation/autocomplete moves fields, indices on static forms.
Submit in that call only when the user asked and the engine's confirmation policy doesn't require confirming it. Otherwise stop before the final click.
Use only documented methods, leave tabs in the background, stop if the user declines a browser approval.

Selected text: select in `js`, then `drag` (`app`, `windowId`, `from`, `to`) in its content, from
the latest screenshot of that window. Lost text: press Cmd+Z in that window.
Before `hover`, try `Help:`, `Secondary Actions:`, right-click or keys, then tell the user first that it moves their pointer
and brings the app forward for about two seconds.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`, and never decide for
  the user. `SLEIGHT_APPROVAL_SCOPE=document`: call `document_scope` after acquiring, and ask when it
  stops a call. A flow rule that stops a transfer: tell the user which, and after a `flow_exception`
  yes, retry the identical call once.

Startup failure: ask the user to run `bin/sleight-mcp --doctor` from the plugin folder.
