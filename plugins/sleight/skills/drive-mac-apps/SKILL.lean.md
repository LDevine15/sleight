# sleight

Prefer CLI/API. Follow engine docs. Await actions.

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
Use documented methods, leave tabs in the background, stop if the user declines browser approval.

- Select text in `js`, then `drag`: `app`, `windowId`, `from`, `to` from the latest screenshot of that window,
  inside content. Lost text: press Cmd+Z in that window and read.
- Try `Help:`, `Secondary Actions:`, right-click or keys before `hover` (`app`, `at`).
  Tell the user first that it moves their pointer and brings the app forward for about two seconds.
- `notifications`, `menu_bar`: user approval once per session.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`, and never decide for
  the user. `SLEIGHT_APPROVAL_SCOPE=document`: call `document_scope` after acquiring, and ask when it
  stops a call. A flow rule that stops a transfer: tell the user which, and after a `flow_exception`
  yes, retry the identical call once.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder.
