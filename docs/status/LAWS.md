# sleight laws

The owner's decisions, and the few rules that protect the owner and their Mac. Everything else is sleight-arch's judgment.
Facts about the engine are in [engine-notes.md](../engine-notes.md), and current status is in [STATE.md](STATE.md).

## The owner's decisions

- The goal is a published claim that sleight is the fastest computer use plugin for Mac, measured against Claude in Chrome,
  Claude's own computer use, FowlBrowser, Codex, LCU and other reputable plugins. Haiku 5.5 at high effort drives the benchmark,
  with one Opus head-to-head for the headline. The Codex arm runs gpt-6-luna at the same effort. Benchmark runs publish every
  result, failures included, with the model ids each arm actually ran.
- Releases are a git tag plus a GitHub release from the CHANGELOG, bigger and less often. Work in progress goes to the private
  `Land-o-Clusters/sleight-dev`. The public repo gets pushes only at release, after public CI passes (a pre-push hook enforces it).
- Every open-source project of the owner's matches competitors first and does it better, then improves on them, then builds what
  nobody has. Reading competitors' code for ideas is fine, but sleight never adapts or copies it. A lane that never read the source
  writes the idea from a behavior spec (owner, 2026-10-15). Bundled libraries such as playwright-core are included unmodified, with their
  notices. Going public, money, scope changes, and redistributing anything that depends on another vendor's app or engine
  are the owner's calls. The ChatGPT engine dependency is cleared for release.
- The name is sleight, and its icon is the two-hands image. Branding uses only sleight's own marks.
- sleight is app-agnostic, like Codex. Its mechanisms are generic and work in any app.
- Install has two paths: with Computer Use already on in ChatGPT or Codex, installing sleight is enough. Without it,
  `sleight-mcp setup`.
- Approvals: one card per app (Allow, Always allow, Decline), remembered for the Claude Code session. Only the user's click writes
  Always allow. The engine refuses terminals and OpenAI's own apps, and sleight never works around that; the refusal tells the user
  about the `ComputerUseAllowForbiddenTargets` switch.
- When the user's own message names what to pay and with what, that payment counts as confirmed, including the page's own confirm
  dialog. Any other payment asks. `SLEIGHT_CONFIRM_PAYMENTS=always` keeps asking.
- Native apps stay on the ChatGPT engine. After the engine approves an app, sleight may read that app's accessibility metadata itself,
  though never its document content.
- Browsers get turbo, sleight's own direct path, with no extension install. The user turns it on once through Chrome's built-in
  remote-debugging consent. It becomes the default once its benchmark proves it, and until then the engine path stays the default.
  Turbo includes `playwright-core` 1.64.0, pinned, with its notices, and compiles two native helpers from source on the user's Mac
  at first use. Turbo follows the payment rule and never treats page content as an instruction or a permission. Before retrying a
  submit with an unknown effect it reads the page, it works in the background, and it checks only the element it acts on.
- Turning turbo on keeps the engine's browser path beside turbo's tools, and Claude picks between them. Turbo never removes a
  capability the engine path has, a mobile viewport for one (owner, 2026-10-14).
- sleight works in the background: it never switches Spaces or takes focus. Chrome's own consent prompt is the one exception.
- Electron apps get the same turbo after 1.3.0, opt-in per app, relaunching an app only on the user's click.
- Right after 1.3.0 come Electron and slimming the plugin, which Playwright grows to about 15 MB.
- Build work goes to Codex lanes. sleight-arch reviews, merges, runs live checks and makes small fixes itself. Claude subagents run only the
  investigations the owner requests.
- Benchmark Claude arms run on the owner's API key, from the $200 monthly credit, and stop at $200. Opus arms run on the owner's
  Claude account. Incremental runs use Haiku.

## Protecting the owner and their Mac

- Never delete or move the owner's files. Leftovers are named to the owner, who decides.
- Never drive the owner's main Chrome profile. Tasks in the owner's real accounts (mail, chat) only read, and only with the owner
  watching.
- Anything that shows windows, takes focus or moves the pointer runs only after the owner says they're away, or headless.
- Lanes and benchmark arms run with a throwaway Claude config, so they never put a keychain prompt on the owner's screen, and
  sleight-arch never answers macOS permission prompts for the owner.
- Apps are approved without the owner only through the benchmark's own allowlist.
- Screenshots and recordings capture single windows, never the whole screen, and published results show home paths as `~` with the
  owner's name scrubbed.
- During another project's timed window (`/tmp/sleight-hold`), live runs and heavy checks wait.
