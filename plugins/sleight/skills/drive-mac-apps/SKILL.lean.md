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

Web pages use the tab handle, never `getApp`.
`js`: script body with top-level `await`, no `return`. The last expression is the result.
Tab input takes an element index or `null`.
Use only documented methods, leave tabs in the
background, and stop if the user declines a browser approval.

- For text, select in `js`, then `drag`: `app`, `windowId`, `from`, `to` from its latest screenshot,
  inside content. Lost text: press Cmd+Z there, then read.
- Try `Help:`, `Secondary Actions:`, right-click or keys before `hover` (`app`, `at`). Tell the user
  it moves their pointer and brings the app forward for about two seconds.
- `notifications` and `menu_bar`. The user approves each once per session.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`, and never decide for
  the user. `SLEIGHT_APPROVAL_SCOPE=document`: call `document_scope` after acquiring, and ask when it
  stops a call. A flow rule that stops a transfer: tell the user which, and after a `flow_exception`
  yes, retry the identical call once.

If `js` won't start, ask the user: `bin/sleight-mcp --doctor` from plugin folder.
