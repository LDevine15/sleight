# Engine notes

Facts about the ChatGPT computer-use engine that sleight's code relies on, each learned the hard way. They change only when the
engine does, so recheck them after an engine update.

- The engine diffs UI state against the latest read of an app, whoever made it. The pane snapshots only between turns, and the next
  prompt asks Claude for a full read.
- Real pointer activity in an app counts as a person taking over.
- One engine helper serves every Codex and sleight session on the Mac. Restarting ChatGPT ends every Codex thread, so it's never a
  test step.
- Finishing an app's File > Open panel can bring the app to the front (TextEdit, 3 of about 21 runs). `open_file` uses `open -g`.
- macOS picks a drag's drop target from what's on screen at the drop point, so a background drag can't drop into a covered window.
- A read right after input waits for the UI to settle, and only after that wait does the next key go to a sheet the action opened.
  (SR1 is investigating cheaper ways to get the same guarantee.)
- The engine refuses a key press made only of modifiers (`-10005`). sleight posts a bare modifier through its own helper.
- Page `evaluate` runs in a read-only scope. It lacks event constructors and `fetch`, and assigning a global throws.
- `tab.drag(from, to)` makes 8 equal pressed moves, and a drop needs two of them inside the target, so `sleight.dragTo` aims inside
  the target's near edge.
- After `tab.click` on a download link, the tab's later downloads stall. Downloads use `locator.downloadMedia({})` or a
  `waitForEvent("download")` registered before the click.
- The Codex browser extension keeps one lifecycle queue per session.
- `Tab.ax` is unsupported for extension, iab, cdp and mcpapps browsers. Locator timeouts and `waitForURL` cap at 3 s and
  `pressSequentially` at 5 s.
- The engine doesn't remember a session's approvals, so the relay does. It honors ChatGPT's own Always allow list.
- The engine rejects `getApp({ windowId })`, so routines acquire by bundle ID and confirm the window's exact title.
- The engine takes only element numbers or points, so actions by sleight ID or label need a fresh read to find the current number.
- The engine's warm write takes about 72 ms (AA1). Reads and settle waits, not writes, are most of sleight's tool time.
