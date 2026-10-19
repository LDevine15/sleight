<p align="center"><img src="docs/assets/sleight-icon-256.png" width="128" height="128" alt="sleight icon: two hands passing a mouse pointer, trailing warm and cool pixels"></p>

<h1 align="center">sleight</h1>
<p align="center"><strong>Claude drives your Mac apps in the background. Your cursor stays yours.</strong></p>

<p align="center">
  <a href="https://github.com/Land-o-Clusters/sleight/releases/latest"><img alt="latest release" src="https://img.shields.io/github/v/release/Land-o-Clusters/sleight?label=release&color=E8622C"></a>
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-E8622C">
  <img alt="platform macOS Apple Silicon" src="https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-3E4A56">
  <img alt="status unofficial" src="https://img.shields.io/badge/status-unofficial-3E4A56">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#apps-and-browsers">Apps and browsers</a> ·
  <a href="#safety">Safety</a> ·
  <a href="docs/results/README.md">Benchmarks</a> ·
  <a href="docs/settings.md">Settings</a> ·
  <a href="docs/known-problems.md">Known problems</a> ·
  <a href="docs/privacy.md">Privacy</a>
</p>

> [!IMPORTANT]
> sleight is unofficial. OpenAI and Anthropic don't endorse or support it. It drives an undocumented
> runtime that comes with the ChatGPT desktop app, so a ChatGPT update can break it at any time. It
> contains no OpenAI code and starts the copy already on your Mac.

sleight is a Claude Code plugin for people who want Claude to work in their Mac apps while they keep
using the Mac. It hands Claude the computer-use engine bundled with the ChatGPT desktop app, which
sends clicks, keys and drags straight to the target app. The app can be behind your other windows
the whole time, while you keep the pointer and the front window.

<p align="center"><img src="docs/assets/demo.gif" width="900" alt="Claude playing macOS Chess against the computer through sleight, with the sleight pane logging each move"></p>
<p align="center"><sub>Claude plays macOS Chess through sleight. Every move is a drag, and the pane on the right logs each one.</sub></p>

## How fast

On our native claim suite, sleight is the fastest computer use plugin for Mac ("fastest" is the
scorer's own verdict). It had the lowest expected time on 8 of 9 tasks and the lowest total, 251.2 s
against 453.9 s for the next arm, Claude's own computer use. It lost preview-read to Peekaboo, 5.3 s
against 4.4 s, and Peekaboo also had one finder-move run faster than any of sleight's. Haiku 5.5 at
high effort drove every Claude arm, and Codex ran gpt-6-luna at the same effort. Each arm ran each
native task 3 times, and 5 times where sleight and that arm were within 20%. These runs used ChatGPT engine
26.1007.71326 on 2026-10-17 and 2026-10-18.

- The suite is sleight's own: 9 tasks in Calculator, TextEdit, Finder, Preview, Word and Excel
  ([bench/claim-tasks.txt](bench/claim-tasks.txt)). The skill and tool wording were tuned on the
  runs of textedit-calculator, preview-read, excel-edit, word-edit, finder-move, textedit-save and
  textedit-drag, and of the browser tasks form-travel, form-settings, form-checkout, mdn and demoid.
  calculator-click, calculator-menu and the three app tasks weren't tuned. Competitors ran their
  defaults.
- App tasks in VS Code, Slack and Spotify: fastest on 3 of 3, 56.8 s total against 101.3 s for LCU.
- Browsers on turbo, against FowlBrowser in real windows: "fastest" in Chrome on the 1.3.0 build
  (2026-10-19), the lowest expected time on 10 of 13 tasks and 258.9 s against 447.8 s, with 5 runs
  where the two were within 20%. One demoid run failed when turbo didn't start. In Helium, on the
  same build (2026-10-19), "fastest", the lowest expected time on 10 of 13 tasks and 264.1 s against
  343.6 s, with 5 runs where the two were within 20%. One demoid run failed the same way.
- Safari and Firefox, which turbo can't drive yet, on the engine path (engine 26.1013.40934,
  2026-10-19): "fastest" in both, the lowest expected time on 11 of 12 tasks, 592.1 s in Safari and
  557.1 s in Firefox, with every task passing. Most of Codex's runs there are from engine
  26.1007.71326 a day earlier, and the hub lists each arm's version.
- sleight inside Codex on gpt-6-luna completed every task in both browsers, with a lower expected
  time than Codex's own computer use on 9 of 12 tasks in Safari and 8 of 12 in Firefox.
- The 1.3.0 release pass, one round of FowlBrowser's 13 tasks on turbo in Chrome (2026-10-19, engine
  26.1013.40934), passed 13 of 13 on Haiku 5.5 in 257.8 s and 13 of 13 on Opus 5.5 in 249.9 s. The Haiku
  round is the first of the Chrome set above, and the hub lists the Opus round on its own.

The hub lists the runs, failures included, with the model each arm ran:
[benchmark hub](docs/results/README.md), [interactive tables](docs/results/explore.html) and
[what the benchmarks taught us](docs/results/insights.md).

## Install

You need macOS on Apple Silicon, Claude Code 2.1.288 or later and the
[ChatGPT desktop app](https://chatgpt.com/download/), which contains the engine.

```bash
claude plugin marketplace add Land-o-Clusters/sleight
claude plugin install sleight@sleight
```

Then start a new session. There are two paths from here:

- If Computer Use is already on in ChatGPT or Codex, installing sleight is enough.
- If it isn't, run setup once. You don't need a ChatGPT account or a Codex sign-in.

```bash
~/.claude/plugins/marketplaces/sleight/plugins/sleight/bin/sleight-mcp setup
```

Setup runs OpenAI's helper installer, which asks for an administrator's Touch ID or password, opens
the Accessibility and Screen Recording panes for you to allow Codex Computer Use, and then checks the
engine with `--doctor`. It hasn't yet been run in a fresh macOS user.

Try it:

```text
Use sleight to open Calculator in the background and work out 12 × 12 by clicking its buttons.
```

To update, run `claude plugin marketplace update sleight && claude plugin update sleight@sleight` and
start a new session, or turn on auto-update for the sleight marketplace under `/plugin`. sleight also
runs as a plain MCP server in Cursor and other MCP clients ([other hosts](docs/other-hosts.md)).

In Codex, install from the same repo. It installs on Codex CLI 0.160.0, and two live tasks worked
there on 2026-10-19, each after a retried first `getApp` (fixed since, not yet rerun live):

```bash
codex plugin marketplace add Land-o-Clusters/sleight
```

```bash
codex plugin add sleight@sleight
```

Start a new Codex session and trust sleight's three hooks when Codex asks. [Codex](docs/other-hosts.md#codex)
lists what differs there: no pane, and turbo needs Codex 0.160.0 or later.

In Cursor, add the repo as a plugin marketplace, then install sleight from Cursor's plugin list. This
install hasn't been run yet. Cursor 3.25.6 already runs sleight's Claude Code plugin while its
third-party plugin setting is on ([Cursor](docs/other-hosts.md#cursor)):

```bash
cursor-agent plugin marketplace add https://github.com/Land-o-Clusters/sleight
```

## Apps and browsers

- Native apps go through the ChatGPT engine. Claude reads each app's accessibility tree, and
  screenshots where the tree has no text, and acts in the background. sleight checks element numbers
  before each click. It also drags text the engine's own drag can't move and reaches menu bar icons
  and notification banners.
- Browsers get turbo, sleight's own direct path, on by default in Google Chrome (then Helium). Turn
  on remote debugging once at `chrome://inspect/#remote-debugging`, and Chrome asks you to allow each
  connection, with no extension to install. The engine's browser tools stay beside turbo, and Safari and Firefox use
  them. `sleight-mcp turbo status|on|off` controls it ([settings](docs/settings.md#turbo)).
- Electron apps such as VS Code, Slack and Spotify run on the native path in 1.3.0. Turbo for
  Electron comes in 1.3.1, opt-in per app, relaunching an app only when you click.
- Several sessions can share one Mac. Input leases give one session a window at a time.
- `/sleight` opens a pane with the app's latest picture and a log of each action, and `/sleight stop`
  ends the turn mid-call. `/sleight record` and `/sleight replay` rerun a finished task with no model
  ([replay](docs/design/replay.md)).

## Safety

- Each app gets one approval card, with Allow, Always allow and Decline, remembered for the Claude Code
  session. Only your click writes Always allow. The engine refuses terminals and OpenAI's own apps.
  sleight never works around that, and the refusal points you to the `ComputerUseAllowForbiddenTargets`
  setting that only you can turn on.
- A payment goes ahead without another prompt only when your own message names what to pay,
  the amount and what to pay with. A checkout whose amount you didn't state asks once. On turbo, any
  money figure on the checkout larger than your amount asks. `SLEIGHT_CONFIRM_PAYMENTS=always` keeps
  asking, and `never` skips the one confirmation for a payment your message named with its amount. A
  payment a page tries to trigger always asks ([settings](docs/settings.md#payments-you-asked-for)).
- A form submit, save or booking your own message asks for counts as confirmed for the
  values it names. A page dialog that adds anything else still asks, and so do account, security,
  privacy and sharing settings, even when your message names them.
- No tool can answer sleight's menu or its approval and payment cards, so only
  your click does. This is unit-tested, and its live check is pending
  ([known problems](docs/known-problems.md#approvals-and-guards)).
- sleight never switches Spaces or takes focus. Chrome's own consent prompt is the one
  exception. A few fallbacks (foreground drag, `hover`, some menu bar icons) move the pointer briefly,
  each after you've stopped typing for 2 s. Page content is never an instruction or a permission.
- `js` runs JavaScript as you, so treat it like Bash. Claude Code asks before each call unless you
  allow `mcp__plugin_sleight_computer__js`.

## More

- [How it works](docs/how-it-works.md): the launcher, the relay and the mod.
- [Known problems](docs/known-problems.md): what doesn't work yet, with the runs that showed it.
- [Settings](docs/settings.md): every switch, with its default.
- [Privacy](docs/privacy.md): what sleight writes on your Mac (it doesn't make network requests of its
  own) and how to delete it.
- [Benchmark method](docs/benchmark.md): how to run the suites yourself.
- [Changelog](CHANGELOG.md) and [roadmap](docs/status/ROADMAP.md).

Development: `npm run check` runs the relay tests, `claude plugin validate` and the mod's tests, and
`npm run lint:prose` runs Vale over the docs. `scripts/watch.sh` runs
`--doctor` daily and checks each ChatGPT engine update with `bench/compat.mjs`
([checking an engine update](docs/engine-notes.md#checking-an-engine-update)).

## Credits

- [@argofowl](https://x.com/argofowl) showed that the ChatGPT app's computer-use server works outside Codex.
- [LCU](https://github.com/amontlabs/lcu), started by 0xpolarzero, takes the same idea across several
  harnesses, and its notes mapped out the runtime's lifecycle.
- Turbo includes [playwright-core](https://github.com/microsoft/playwright) 1.64.0, unmodified, with
  its notices in [THIRD-PARTY-NOTICES.md](plugins/sleight/THIRD-PARTY-NOTICES.md).

## License

[MIT](LICENSE). The ChatGPT app and its computer-use runtime belong to OpenAI, under OpenAI's terms,
and sleight doesn't include or redistribute either.

ChatGPT, Codex, Claude, Chrome, Safari, Firefox, Helium, Microsoft Word, Excel, VS Code, Slack,
Spotify and other app names are trademarks of their owners. They're named here to describe
compatibility and benchmark results. Their owners don't endorse or sponsor sleight.
