# sleight laws

What is true always. A line changes only when we learn we were wrong. Measurements and current status
belong in [STATE.md](STATE.md).

## Owner decisions

- The owner pushes changes to `.github/workflows/` and any `*.yml`. The org ruleset
  `no-workflow-edits-without-disabling-this-ruleset` blocks everyone else. sleight-arch toggles it
  only when the owner asks in chat, for that one push, and turns it back on in the same command
  (owner, 2026-10-10). If Claude Code's safety classifier blocks that, the owner runs it.
- Going public, money, scope changes, and redistributing or bundling anything that depends on another
  vendor's app or engine are the owner's call.
- sleight is public (owner, 2026-10-03), and promoting it is cleared: the owner checked the licensing
  of depending on the ChatGPT app's engine (2026-10-05). LCU gets a link and credit in the README, no heads-up, and
  the desktop app's declined prompts aren't reported to Anthropic.
- The owner cleared reading other vendors' installed code to learn their design (2026-10-12). That covers Claude in Chrome, Claude Code's own
  computer use (added 2026-10-13), the Codex browser extension and the ChatGPT engine, by hand or with REA. Only notes on behavior and design come back, never their
  code. MIT projects like FowlBrowser may be copied with credit. Apache-2.0 projects may be copied too (owner, 2026-10-13): the
  copied file keeps its copyright header and says we changed it, and `THIRD-PARTY-NOTICES` holds their license and NOTICE text.
- The project's name is sleight, and its icon is the two-hands image from ChatGPT (2026-10-03).
- sleight launched at 0.x (owner, 2026-10-03) and reached 1.0.0 on 2026-10-09, after it survived
  two ChatGPT engine updates, someone else installed it from the marketplace, the desktop pane's
  picture was verified, and the benchmark compared it with LCU and Codex. The owner approved 1.0 on
  the condition that its head-to-head and release pass ran with them away, with no new failure that's
  sleight's fault.
- The owner's rule for every open-source project of theirs, sleight included (2026-10-03), in order:
  do what competitors do, but better. Improve on them where they haven't. Then build what nobody has.
- sleight benchmarks against Claude in Chrome, Claude's own computer use and other reputable computer-use plugins, toward a
  public claim to be the fastest computer use plugin in the world (owner, 2026-10-12). This supersedes the 2026-10-04 rule that
  ruled out benchmarking Claude's own computer use.
  The claim is "the fastest computer use plugin for Mac". Every Claude-drivable arm runs Haiku 5.5 high on the full suite and
  one Opus pass for the headline. The owner approved installing the open-source competitors, Claude in Chrome, Claude's computer
  use and hosted agents behind API keys as benchmark arms, never in the owner's own Claude Code config (all 2026-10-12).
- A release means a git tag plus a GitHub release with notes from the changelog (owner, 2026-10-04).
- Haiku 5.5 at high effort is the default driver for the benchmark and the docs (owner, 2026-10-10,
  once runs moved to the API key). It supersedes Sonnet 5.5 at medium (owner, 2026-10-08, after the
  four-model comparison in `docs/benchmark.md`). Passes before 2026-10-10 ran on Sonnet.
- The benchmark's Codex arm runs gpt-6-luna at the same effort as the Claude arm's Haiku 5.5, medium or
  high, so both arms use a model of the same class (owner, 2026-10-11). Earlier passes ran gpt-6.1-sol.
- Codex lanes run on gpt-6.1-sol (owner, 2026-10-04), except deep performance tuning in the code, which
  may run on gpt-6-astra (owner, 2026-10-07).
- Shopping scenarios run two ways (owner, 2026-10-10): a local shop page that copies a retailer's
  flow for the head-to-head, and real retailer sites as one-run smoke tasks that stop before
  checkout, decline non-essential cookies and stop at any CAPTCHA. CPU comparisons publish two arm
  setups: clean arms without the owner's user plugins, and the owner's normal setup. iPhone
  Mirroring runs only with the owner at the Mac, since it needs their sign-in and focus.
- The benchmark grows toward the apps people use (owner, 2026-10-09): varied web pages (sheets,
  docs, dense, interactive, collapsible), Microsoft Office (Word, Excel, PowerPoint), and mail
  apps, where tasks only navigate and never send. Mimestream runs on the owner's own Gmail and only
  opens and reads, and its published results don't include any mail content (owner, 2026-10-09).
  Tasks in the owner's real accounts (Mail, Mimestream, Slack, Discord, WhatsApp) run only with the
  owner at the Mac and watching (`--owner-present`), never while they're away (owner, 2026-10-11).
- Speed comes before the guard's read between actions in a batch (owner, 2026-10-09): keys,
  typing, paste and coordinate actions after the first action in a call skip it by default, as in
  Codex. The first action and numbered actions keep their check, and `SLEIGHT_GUARD=careful` keeps
  every read. In the default mode on a loaded Mac, the first action may use Claude's full read from the call
  just before when that read took over 2 s and is less than 10 s old. A first action that sends keys,
  text or coordinates may use that read whenever it is less than 10 s old, loaded or not (owner,
  2026-10-10, for about 0.35 s a run). A window switch between calls isn't caught before that action. Return after
  `setValue({ id })` skips the read too (owner, 2026-10-10, 1.85 s a save). Actions by ID or label keep
  their read: the engine takes only element numbers or points, so sleight finds the current number in a
  fresh read. The owner also chose to skip those reads, on sleight-arch's wrong claim that the engine
  resolves IDs itself. Those reads are unchanged. The bar is Codex's speed and footprint under any load.
- sleight is app-agnostic, like Codex (owner, 2026-10-11): what users run (the skill, the relay, the
  guard and the tools) adds generic mechanisms that help in any app, never rules or code paths for
  one app. App knowledge belongs to the engine or to the model. A workaround for one app
  needs the owner's OK and says so. Benchmark tasks name apps, but their checks are generic: they judge
  the answer and the app's state, with no per-app harness.
- sleight gets its own direct browser path for Chromium browsers, and the ChatGPT engine keeps everything outside the browser
  (owner, 2026-10-13, after the engine's browser path left sleight's form runs at 17 of 40 against FowlBrowser's 26 of 26 per
  round). It is designed from a teardown of FowlBrowser and the other browser tools, keeping what works, improving the rest and
  adding what none of them have, never a copy. MIT and Apache-2.0 code may be adapted with credit and notices.
- Browser use is sleight's strongest suit, measured against Codex, and sleight releases with the
  numbers that show it (owner, 2026-10-11, after a Codex-derived browser extension for Claude was teased).
- Install has two paths (owner, 2026-10-11): with Computer Use already on in ChatGPT or Codex,
  installing sleight is enough; without it, `sleight-mcp setup` with no ChatGPT sign-in. Errors about a
  missing engine point at setup.
- Owner-away live runs happen in one sitting, asked for only once every open lane is merged, never in
  partial windows: each sitting means pausing the owner's other projects (owner, 2026-10-11).
- Build work goes to Codex, Grok and GLM lanes, not Claude subagents, which the owner saves for
  other work (owner, 2026-10-11). sleight-arch reviews, merges and runs the live checks.
- Codex time goes to known problems and enhancements, not benchmark runs (owner, 2026-10-04).
  SUPERSEDED (2026-10-09): "one benchmark pass per merge that changes default behavior". The owner
  now wants several fixes and features batched into each release, with one full pass per release. In
  development only the affected tasks run.
- The benchmark's Claude arms run on the owner's Anthropic API key, paid from the $200 monthly API
  credit of their Max plan, which has no other use (owner, 2026-10-10). Spend it freely. A pass
  stops at $200 of spend in a month, because anything past the credit is billed to the owner's card.
  Opus arms run on the owner's Claude account instead (`claude -p` signed in, no API key), and Haiku and Sonnet
  arms stay on the API key (owner, 2026-10-12). The FowlBrowser head-to-head keeps Opus without spending the credit.
  Claude's own computer use needs a Pro or Max login. Its arm runs Haiku 5.5 high on the owner's login like any other model, and
  its runs never count toward the API credit (owner, 2026-10-13).
- Incremental benchmark runs use Haiku on the API key, within the $200 stop (owner, 2026-10-12 evening, because Opus rounds were
  eating the owner's quota). Measure with the model-free tools first (char audit, probes, anatomy of saved rounds). Opus runs
  once, at the end of a batch of fixes, as the head-to-head against FowlBrowser.
- Routines and replay acquire an app by bundle ID and then confirm the window's exact title (and
  URL when present) from the read, because this engine rejects `getApp({ windowId })`. The owner
  followed sleight-arch's recommendation to keep it (2026-10-10).
- Bigger releases, less often (owner, 2026-10-10), so competitors have less to copy or benchmark
  against between releases. Work in progress goes to the private `Land-o-Clusters/sleight-dev`
  (`remote.pushDefault private`), and the public repo gets pushes only at release (owner, 2026-10-10).
  A pre-push hook in the shared `.git/hooks` refuses a push to the public repo unless
  `SLEIGHT_RELEASE_PUSH=1` is set, because a branch tracking `origin` still pushed there.

## Approvals and safety

- A payment the user's own message asked for, naming what to pay and with what, counts as confirmed by
  default, including the page's own "pay now?" dialog for it (owner, 2026-10-12, for parity with
  FowlBrowser). sleight changes the engine's written rule to say so. Any other payment still needs the
  user's confirmation, page content never counts as permission, and `SLEIGHT_CONFIRM_PAYMENTS=always`
  keeps the engine's rule as written.
- An accepted app approval lasts for one Claude Code session, kept in the relay's memory. The relay never
  sends `persist: "always"` and never remembers a decline. `SLEIGHT_APPROVAL_SCOPE=once` turns it off.
  The prompt also offers "Always allow", which adds that app to the user's pre-approved list with the
  date (owner, 2026-10-10). Only the user's own click writes it, never Claude. Terminals and OpenAI's
  apps get the same card as any app, Always allow included, with one line saying the app could be
  dangerous (owner, 2026-10-11, as in Codex: the choice is always the user's, in one click).
- Apps get approved without a person at the moment of use only two ways: the benchmark's allowlist
  (Calculator, TextEdit, Chess, and Simulator or DeviceHub since 2026-10-07, by name or bundle ID) in benchmark runs,
  plus Safari, Preview, Finder and Helium for the real-use tasks (owner, 2026-10-08), Preview also for the hand-off tasks (owner, 2026-10-12) and Word,
  Excel, PowerPoint, Mail and Mimestream for them too (owner, 2026-10-09), VS Code (also by its app name, Code), Cursor, Firefox,
  Slack, Discord and WhatsApp for them too (owner, 2026-10-10, chat apps open and read only), Notes, Reminders, Calendar,
  Messages, Pages, Numbers, Keynote, Music, Maps, Photos, Arc, Chrome, Notion, Spotify and Zoom for the parity
  battery (owner, 2026-10-11, fixtures only, read only in the owner's accounts), ZCode for the battery's
  flows in its sleight-scrap project only, owner away allowed, never the agent seats (owner, 2026-10-11), iPhone Mirroring
  only in real-suite runs started with `--owner-present` (owner, 2026-10-11), and the repo's own
  hang fixture (`org.sleight.reliability-fixture`, owner, 2026-10-08) in its probe and in the native probes of ledger items
  AS-7 and AA1, for that probe session only and never "always" (owner, 2026-10-13), browser-extension access to
  the benchmark's own local pages on `127.0.0.1` (owner, 2026-10-10), and a list the user writes in
  a file outside any project, read by sleight in every session, headless or not (owner, 2026-10-04).
  No project or plugin can add to either. Claude edits the user's list only on the owner's explicit
  order in chat, names the change and its end date in STATE, and keeps the earlier list (owner,
  2026-10-05). When a safety check blocks an action, the owner does it or it doesn't happen.
- The engine refuses terminals and OpenAI's own apps (ChatGPT, Codex, Atlas). sleight never modifies or
  wraps OpenAI's helper to change that, and never sets `ComputerUseAllowForbiddenTargets`, the user's
  switch that lifts the refusal (owner, 2026-10-05). A refusal tells the user that switch exists.
  sleight has no other path to these apps: the owner removed `blocked_app` on 2026-10-11, replacing
  the 2026-10-04 scope call. With the switch on, their settings windows are refused.
- sleight's `menu_bar`, `notifications` and `drag` tools act outside the engine, through macOS
  Accessibility and posted mouse events (owner's scope calls, 2026-10-03 and 2026-10-04). Each app's icon needs the user's approval, as do notifications,
  with the same session memory as engine approvals. Every action on an app waits for that approval.
- sleight's mod may approve, in Claude Code's `tool.check`, only its own pane snapshot (the exact code
  it built) and `turn_ended`, matched by `next.origin.plugin === 'sleight'`, which the host sets. It
  never approves a call Claude made (owner, 2026-10-08).
- sleight's branding uses only its own marks, never another company's logo or mascot.
- sleight never tells Claude to bring an app to the front. When only activation would help, the
  message hands that choice to the user, since it takes their focus.

## The engine

- The engine diffs UI state against the latest read of an app, whoever made it. So the pane snapshots
  only between turns, and the next prompt tells Claude to do a full read.
- The engine refuses terminal apps. Real pointer activity in an app counts as a person taking over.
- The engine's helper serves every Codex and sleight session on the Mac, and Codex runs inside the
  ChatGPT app. Restarting ChatGPT ends every Codex thread, so it's the owner's call, never a test step.
- Finishing an app's File > Open panel can bring the app to the front (TextEdit, 3 of about 21 runs,
  2026-10-10). sleight opens files with `open -g` (`open_file`), which left the front app alone.
- macOS picks a drag's drop target from what's on screen at the drop point. A drag posted to an app in
  the background never drops into a window another app covers there.
- An engine read right after input waits for the UI to settle, and that wait is also what lets the
  next key reach a panel or sheet the previous action opened. A guard that skips reads keeps them
  after clicks, shortcuts, Return, Escape, Tab and Space.
- The engine refuses a key press made only of modifiers (`pressKey("shift")` returns
  `-10005 keyPressIncludedNoNonModifierKeys`). A settle that needs a bare modifier is posted by sleight's
  own helper, never sent through the engine.
- The engine's page `evaluate` (and a locator's) runs in a read-only scope: no event constructors, no `fetch`, read-only
  element wrappers, and assigning a global throws. Changes to a page go through the tab's actions and locators.
- The engine's `tab.drag(from, to)` presses at `from`, makes 8 equal pressed moves and releases at `to`. A page sees an HTML5
  `dragover`, which a drop needs, only when two moves in a row are inside the target, so a drop point near the target's center
  never drops. `sleight.dragTo` aims inside the target's near edge.
- After `tab.click` on a download link, the engine doesn't show a download prompt, and that tab's later downloads stall. Downloads go
  through `locator.downloadMedia({})`, or `waitForEvent("download")` registered before the click.
- The Codex browser extension keeps one lifecycle queue per session, not one across sessions (read from the installed extension,
  2026-10-13). Sessions that start together wait instead on the engine's browser discovery, which probes every backend socket on
  each selection, and on a one-time first session command. Neither needs our own extension to avoid.
- The engine marks `Tab.ax` unsupported by default for extension, iab, cdp and mcpapps browsers, so hints never name `tab.ax`. Locator
  action timeouts, `waitForLoadState`, locator `waitFor` and `waitForURL` are capped at 3 s and `pressSequentially` at 5 s. Only
  `waitForTimeout` is uncapped. Locators have no `scrollIntoViewIfNeeded`, and `el.scrollIntoView` inside `evaluate` is allowed.
  `tabs.content` is off for local browsers (read from the engine's `api.json` and `browser-service.mjs`, 2026-10-12).
- The engine doesn't remember a session's approvals. In Codex the host does, so here the relay does. It
  does honor the "Always allow" list ChatGPT keeps (`ComputerUseAppApprovals.json`), with no prompt to
  sleight. That file is the user's ChatGPT setting: sleight reads it at most, and the owner decides any change.

## Method

- Run every check bare, capture its exit code, commit only on 0. Commit with the pathspec on the commit.
- Live behavior is proven by a live run, judged from the relay trace and the transcript, not the screen.
- Benchmark results are published in full: every run, failures included, with the raw results file
  in `docs/benchmarks/` and the caveats stated (owner, 2026-10-03). We never pick runs after seeing
  them: every full pass is published, intermediate and noisy ones too.
- A pass measures sleight only while a regular desktop shows the benchmark apps' Space and the screen
  is clear of system dialogs. Any other pass is published with that caveat.
- The owner's installed sleight is a copy keyed by version, refreshed only by `claude plugin update`.
  Before asking the owner to check anything in a session, update it and confirm its `gitCommitSha`.
- A lane finishes an item with a bare `npm run check` at exit 0, not only the test files it touched: two branches that
  passed their own files broke 7 tests elsewhere (2026-10-12).
- A shell script a live run is executing is never edited in place: `sh` reads it as it goes.
- A benchmark round records the model id each arm actually ran, checked in its events, because Claude Code aliases resolve per version (the
  `haiku` alias in 2.1.289 ran Haiku 4.5 all day on 2026-10-12). Rounds pass explicit model ids.
- Tests of page helpers use fakes that throw on any method the engine lacks, and helpers that `relay.mjs` injects as source keep every
  name they use inside the injected function (module scope is lost). A page helper also gets a real-page test with Playwright where
  available. Unit tests with invented engine methods passed three helpers that failed on the real page (2026-10-12).
- A lane item that fails a third review is parked, not sent round again (owner, 2026-10-12).
- Every lane branch (Codex, Grok or GLM) gets a code review by a Sonnet subagent at high effort before
  sleight-arch merges it, and a finding goes back as a fix item rather than being merged around
  (owner, 2026-10-12). Exploration and docs subagents run Sonnet at medium effort. When Claude quota is
  short, another Codex lane reviews instead, never the branch's own author, by the ledger's review rules (owner, 2026-10-13).
- The guard follows a stale element number to a new one only when the line Claude saw was unique in
  that tree, is on exactly one element now, isn't a bare role, and the call has one literal number.
  A number the code computed from its own read in the call is checked against that read.
- Codex agents build on `codex/*` branches in their own worktrees and never push to `main`. sleight-arch
  reviews each branch (design note, safety paths, evidence for personal data), squash-merges it onto
  `main` so scrubbed history stays off it, and releases. Conflicts in the relay's core go back to
  the branch's author to rebase. Hand merges there broke the relay twice.
- A Codex report is a claim until sleight-arch reproduces it under normal use: the owner at the Mac,
  other apps open. Results measured while the owner was away say so.
- Other projects on this Mac run timed tests in announced windows. Their architects message this
  session. No app driving during a window, ask before any run that adds load, and say in the results
  when a run overlapped another project's load.
- During another project's window sleight-arch keeps `/tmp/sleight-hold`. Every brief stops live
  probes while it exists, and `npm run check` waits on it. Compile-heavy checks skewed Puddle's timed
  pairs on 2026-10-10 until the check itself waited.
- Live checks that drive apps hold `/tmp/sleight-live.lock`, taken with `mkdir`, released on exit. A
  command that can't take it stops there (`mkdir … || exit 1`), so nothing after it runs.
  A process removes the lock only if it created it in that run. On 2026-10-10 another process
  removed a held lock, and two live runs overlapped. A lock left by an exited script is released by sleight-arch
  after checking what that script left open.
- The benchmark changes an app's settings only for one launch, with launch arguments, never with
  `defaults write`. It never deletes or moves the owner's files: leftovers in the owner's folders are
  named to the owner, who decides (two iCloud TextEdit leftovers went to the Trash on the owner's OK,
  2026-10-10).
- A run that can take the owner's pointer or keyboard happens only while the owner is away from the
  Mac (owner, 2026-10-09). Chess drags and the simulator can, and so can any foreground fallback.
- A benchmark run quits every app it launched, so no keyboard event tap is still installed after it. When the owner
  reports a dead keyboard or pointer, stop every live run first, then look (2026-10-09).
- Claude arms run without tools that reach outside the app or search files (Bash, Write, Edit, Glob,
  Grep, Read, Skill, Monitor, Agent, the web tools). A hand-off arm wrote its "TextEdit" file through Monitor's shell
  on 2026-10-12, and its grader passed it. The user's own plugins and settings load in a run, and each of
  these has once changed or stalled a run (Glob never returned, 2026-10-09).
- Benchmark cleanup closes only windows it holds a reference to, never one found by title. It leaves any
  other window open and names it to the owner.
- A skill or prompt change that alters what Claude does is released only after the affected tasks ran with
  it: a hint that read well (press a 3D piece at its head) cost Chess runs (2026-10-09).
- Any Claude process the benchmark or a probe starts begins from an environment without the host
  session's `CLAUDE*` variables. Inherited, they made every arm look like the desktop app's own
  Claude Code, and billing refused the arms (2026-10-11).
- Benchmark arms run from folders outside any git repo. Claude Code loads CLAUDE.md from parent
  folders and keys project memory by the git root, so a folder inside this repo leaks both.
- A release goes out only once public CI passes on it. CI runs on Linux without `npm install`, on the
  oldest supported Claude Code: a test that needs macOS binaries or `/private/tmp` skips by name
  elsewhere, and one that needs a dev dependency skips when it isn't installed.
- The marketplace installs from the default branch, so `main` is what new users get. Keep it releasable:
  a default that fails the benchmark goes back to opt-in at once.
- Window titles can include the owner's name (Chess games do). Scrub evidence and screenshots of them.
- Recordings and screenshots capture individual windows (`screencapture -l`), never the whole screen
  or a display region: messages, notifications and other apps on it are private. Open and Save panels
  show the home folder, so their frames are left out.
- The plugin folder contains only code the plugin runs. Research prototypes go in `bench/`.
- Published results and logs show home paths as `~`. Check raw logs for personal data before publishing.
- A guard that runs inside the engine's JavaScript can't be a security boundary, because Claude writes
  that code. Features built on one say so plainly; only the user decides approvals, keeps and undos.
- A speed claim gives turns, model time and model time per turn with the total. The model API's
  latency changes from pass to pass, so total time alone can show a change that isn't sleight's.
- Every release rereads README.md whole and fixes any number, version or behavior that's no longer
  true (owner, 2026-10-09). A claim tied to a release or a pass names it.
- Docs pass `npm run lint:prose` with zero flags. Limitations go in `docs/known-problems.md` when we find
  them.
