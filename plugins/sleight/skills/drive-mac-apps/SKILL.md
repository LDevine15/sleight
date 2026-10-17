---
name: drive-mac-apps
disable-model-invocation: true
description: Use when a task needs a web page or native macOS app operated through its UI (clicking, typing, dragging, reading what is on screen) and no CLI, API or dedicated tool covers it. sleight drives the app in the background through the computer-use engine bundled with the ChatGPT desktop app, without moving the user's pointer.
---

# Driving Mac apps with sleight

`mcp__plugin_sleight_computer__js` runs persistent JavaScript with `cua`. `js_reset` restarts it.
Follow engine docs and app instructions. Prefer a CLI, API or dedicated tool when one covers
the task.
Top-level `await`, no `return`. Write text with `nodeRepl.write(...)`.

Never create or edit `~/Library/Application Support/sleight/preapproved.json`; only the user writes
it. If an app isn't approved, ask the user, or stop when a headless run refuses it.

## Calls

- When the task specifies an app, start with `let app = await cua.getApp("<name or bundle ID>")`.
  Use `cua.getState()` only to find an app you can't name. Batch known actions. Re-acquire in a call
  switching apps. Keep the handle and `await` every action.
- After renumbering, prefer stable IDs or labels to element numbers:
  `await app.click({ id: "<ID from the tree>" }); await app.click({ label: "<label>" })`.
- End on the action. Its result already includes changed lines. Don't read just to confirm them.
  For missing information, use `await app.getAXState()`.
- If acquisition returns an empty tree, or a result says the user changed the app or a header
  changed, read again before retrying.
- Among windows, call `select_window` with the app and exact `url` or `title`, then acquire
  alone and check its Window line.
- Multiply tap coordinates by the screenshot multiplier.

## Text, menus and files

- `await app.paste("text")` avoids autocorrect and capitalization. Replace documents with select-all
  and paste in one call.
- Use a menu item's shortcut if it has one. Otherwise open the menu and pick the item by label in one
  call: `await app.click({ label: "<menu>" }); await app.click({ label: "<item>" })`.
  `menu_bar` is only for status icons.
- Acquire a document that's already open. Don't reopen it.
- Open a file with `open_file`, not the app's Open panel, which can bring the app to the front.
- Transfer numbers as digits.
- Move files with Copy, then the menu's Move item (Cut is often disabled for files), not a drag.
- In a Save panel, send Go to Folder, the folder, Return, the name and the final Return in one call,
  such as `await app.pressKey("super+shift+g"); await app.typeText("<folder>"); await app.pressKey("Return"); await app.setValue({ id: "saveAsNameTextField" }, "<name>"); await app.pressKey("Return")`.
  A full path in the name field becomes a name with slashes. The result's title and URL confirm the
  save.
- If scrolling fails, use search or keyboard navigation.

## When to stop

- A sign-in, update, permission or first-run screen: stop and tell the user. Don't answer it.
- An approval the user declined, a lease another session holds (the refusal names it and the seconds
  left), or a refused settings window: stop and tell the user. Don't retry around it.
- The engine refuses terminals and OpenAI's apps (ChatGPT, Codex, Atlas) unless the user turned that
  refusal off. When it refuses, pass on what the result says and stop. Never run that command yourself.

With a connected ChatGPT extension, web pages use the tab handle, never `getApp`.
The engine masks protected field reads as `<redacted>`. This does not mean input was replaced. Use validation or submission results. Never try to unmask it.
Submit in that call only when the user asked for that submit and the engine's confirmation policy
doesn't require confirming it. Otherwise stop before the final click.

## Browsers

Several Chromium browsers report as Chrome: pick `metadata.extensionInstanceId` from
`await cua.listBrowsers()`. `cua.getBrowser({ extensionInstanceId })` runs in a call of its own.
Open pages with `cua.createBrowserTab(browser.browserId, url)`.
Tab input's first argument is an element index or `null`.
Fill every field you already see in one call.
Fill without submitting: `nodeRepl.write(await sleight.fillForm(tab, [{label:"Name",value:"Ada"}]))` takes each field by label or locator (an index needs a stable ID in the tree).
List rows: `nodeRepl.write(await sleight.pickFromList(tab, list, "Portland"))`.
Read once at the end.
Use locators when validation or autocomplete can add or move fields, indices on static forms.
Use only documented methods, leave tabs in the background, and stop if the user declines a browser approval.
`nodeRepl.write(await sleight.dragTo(tab, from, to))`: selectors, locators or page coordinates, reads back indices. `nodeRepl.write(await sleight.reorder(tab,list,order))`: row names, verified.
Downloads: `locator.downloadMedia({})`, never `tab.click` (stalls later downloads).
Click a button that may open a page dialog (pay, delete, leave) with
`tab.click(index)`, not a locator, then answer it: `(await tab.getJsDialog()).accept()` or `.dismiss()`.

## sleight's other tools

- `app.drag` moves things that follow the pointer at once. Moving selected text needs the button
  held first: select it in `js`, then call `drag` with `app`, `windowId`, and `from` and `to` from the
  latest screenshot of that window, both inside its visible content. If it reports lost text, press
  Cmd+Z in that window and read it.
- Engine events don't trigger hover. Use `Help:` fields, `Secondary Actions:`, a right-click
  or a key first. Only then `hover` with `app` and `at`, after telling the user it moves their pointer
  and brings the app forward for about two seconds.
- `notifications` lists banners on screen and presses their buttons. Banners leave in seconds, so act
  at once. `menu_bar` reaches status icons. The user approves each once per session.
- Copy and Cut use the real clipboard unless `SLEIGHT_CLIPBOARD=preserve` (then one clipboard shortcut
  per call). Never clear or replace the user's clipboard to get around a refusal.
- `SLEIGHT_CHANGE_REVIEW=1`: acquire before editing, save before `review_changes`, and never decide for
  the user. `SLEIGHT_APPROVAL_SCOPE=document`: call `document_scope` after acquiring, and ask when it
  stops a call. A flow rule that stops a transfer: tell the user which, and after a `flow_exception`
  yes, retry the identical call once.

If `js` fails to start, ask the user to run `bin/sleight-mcp --doctor` from the plugin folder.
