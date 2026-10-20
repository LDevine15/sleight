# Installing sleight

Coding agents: [read Agent notes first](#agent-notes).

## Installing it yourself

Install the ChatGPT app first, then use the section for your coding agent. Run the doctor, run setup if it asks,
allow the macOS permissions, and start a new agent session. If Computer Use is already on in ChatGPT or Codex, skip setup.
`installPath` means the installed sleight plugin folder, reported by your host's plugin listing.
`setup` runs OpenAI's helper installer and opens Accessibility and Screen Recording for your approval.

The [install validation limits](README.md#install-validation) apply here. Setup asks for an administrator's password or
Touch ID, and Chrome's browser connection needs its debugging switch and your consent, so you need to be at the Mac.

sleight is MIT-licensed and uses your coding agent's account or API access. It doesn't need a ChatGPT account or separate
Codex sign-in. We haven't measured typical tokens or money per task, or a complete install's disk and background CPU cost.
The ChatGPT app must be installed, and we haven't established that sleight works while the app's UI is quit.

## Agent notes

If you're installing for someone else, follow the host's commands below and stop for these user steps:

- typing an administrator's password or Touch ID during `sleight-mcp setup`,
- allowing Codex Computer Use under Accessibility and Screen Recording in System Settings,
- clicking Allow or Always allow on the first approval card for each app,
- turning on Chrome's remote debugging at `chrome://inspect/#remote-debugging` and allowing Chrome's prompt, for turbo.

At each step, tell the user what to do and wait. Don't run `sudo` or `sleight-mcp setup`, and don't script System Settings
or work around a prompt or approval card. Run each command below on its own. You may inspect setup with `--dry-run`.

## Requirements

- macOS on Apple Silicon. We've tested on macOS 27 and haven't measured a minimum version. Intel builds are untested.
- The [ChatGPT desktop app](https://chatgpt.com/download/) in `/Applications`. It holds the engine.
- A host, such as Claude Code 2.1.288 or later, Codex CLI (tested on 0.160.0), or any MCP client that starts a stdio server.

sleight runs on the Node runtime inside ChatGPT, so there's nothing to install with npm.

## Claude Code

```bash
claude --version
claude plugin marketplace add Land-o-Clusters/sleight
claude plugin install sleight@sleight
```

The version must be 2.1.288 or later. Print the installed plugin listing:

```bash
claude plugin list --json
```

Copy `installPath` from the `sleight@sleight` entry. Replace `<installPath>` below with that entire path; keep the quotes:

```bash
"<installPath>/bin/sleight-mcp" --doctor
```

Start a new Claude Code session so the plugin loads.

## Codex

```bash
codex plugin marketplace add Land-o-Clusters/sleight
codex plugin add sleight@sleight
```

Codex's own listing gives sleight's installed `version`. Codex keeps the plugin under its home folder, `$CODEX_HOME`
(`~/.codex` when the variable isn't set). Run the doctor from there, with the version filled in:

```bash
codex plugin list --json
"${CODEX_HOME:-$HOME/.codex}/plugins/cache/sleight/sleight/<version>/bin/sleight-mcp" --doctor
```

Start a new Codex session from a project folder and trust sleight's three hooks when Codex asks. What
differs in Codex is in [other hosts](docs/other-hosts.md#codex).

## Cursor

Cursor is not listed as a supported host in the README until its first live install passes. This route is
unverified. It needs a signed-in cursor-agent 2026.09.10 or later:

```bash
cursor-agent plugin marketplace add https://github.com/Land-o-Clusters/sleight
```

Install sleight from `/plugins` in cursor-agent, or from Customize in the Cursor app, and start a new chat.
Check it from Cursor's plugin cache, where the last folder is the commit Cursor installed. The doctor's Cursor section
lists each route it finds and warns when Cursor would start sleight twice ([Cursor](docs/other-hosts.md#cursor)):

```bash
~/.cursor/plugins/cache/sleight/sleight/<commit>/bin/sleight-mcp --doctor
```

## Grok CLI

Grok CLI is supported in 1.4.0 through a stdio MCP entry. After cloning sleight as below, run:

```bash
grok mcp add sleight -- /absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp
grok mcp doctor sleight
```

Keep one route. Grok may already import sleight from Claude Code's marketplace checkout, which can differ from
Claude Code's cached version. `sleight-mcp --doctor` lists these copies. In a throwaway Grok 1.0.13 home,
marketplace add and `plugin install sleight --trust` succeeded, but `grok inspect --json` still selected the Claude
import. Check its `mcpServers` target before relying on the marketplace install.

Turbo is off in Grok for 1.4.0 because its calls have no trusted binding to the user's message. Use the engine path.
See [Grok CLI](docs/other-hosts.md#grok-cli) for approval and result limits.

## Grok Bot

Clone sleight as below and set up ChatGPT's Computer Use on the Mac where Grok Bot's local daemon runs. Start one
session there with the clone's absolute path:

```bash
/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp session
```

The session needs Apple's clang from Xcode Command Line Tools. Leave it running, then paste the
[Grok Bot instructions](docs/other-hosts.md#grok-bot), with that same full path, into your bot. The bot calls
`sleight-mcp js '<code>'` through its local shell. Its hosted STDIO MCP box cannot drive your Mac.

Turn Grok Bot's own computer-use helper off. sleight shows its own approval panels, turbo stays off, and payments,
bookings and submits ask each time. The session collects its engine after ten idle minutes or when stopped with
Ctrl-C or SIGTERM. This route has offline tests. A live Grok Bot session has not been checked.

## Other MCP clients

Install the ChatGPT desktop app in `/Applications` first. The launcher uses its Node runtime. Then clone sleight:

```bash
git clone https://github.com/Land-o-Clusters/sleight.git ~/sleight
~/sleight/plugins/sleight/bin/sleight-mcp --doctor
```

Add this server to the client's config, with the clone's absolute path (JSON doesn't expand `~`):

```json
{
  "mcpServers": {
    "sleight": {
      "command": "/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp"
    }
  }
}
```

## Computer Use

The doctor exits 0 and prints `live read ok (helper inventory)` when the engine works. If it prints `MISSING` lines or
prints a line with `setup` in it, Computer Use isn't on yet. Give the user this setup command to run from the same plugin folder:

```text
"<installPath>/bin/sleight-mcp" setup
```

Setup runs OpenAI's helper installer, which asks for an administrator's Touch ID or password. It then opens the
Accessibility and Screen Recording panes, where the user allows Codex Computer Use, and runs the doctor again. To preview
what it will do, add `--dry-run`. See the [install validation limits](README.md#install-validation).

For turbo in Chrome, the user turns on remote debugging once at `chrome://inspect/#remote-debugging`. Chrome then asks
them to allow each connection. The doctor's first lines say whether turbo is ready ([settings](docs/settings.md#turbo)).

## Check it works

In the new session, ask:

```text
Use sleight to open Calculator in the background and work out 12 times 12 by clicking its buttons.
```

The user sees an approval card for Calculator. Once they allow it, Calculator should end on 144 while the window the
user was working in stays in front. In Codex on 2026-10-19 this took 22.5 s.

## Update and uninstall

| Host | Update | Uninstall |
| --- | --- | --- |
| Claude Code | `claude plugin marketplace update sleight && claude plugin update sleight@sleight`, then a new session | `claude plugin uninstall sleight@sleight && claude plugin marketplace remove sleight` |
| Codex | `codex plugin marketplace upgrade sleight && codex plugin add sleight@sleight`, then a new session | `codex plugin remove sleight@sleight && codex plugin marketplace remove sleight` |
| Other MCP clients | `git pull --ff-only` in the clone, then reconnect | Remove the `mcpServers` entry and the clone |

We've checked the Codex update against a local marketplace only. [Privacy](docs/privacy.md#deleting-everything) lists
the files sleight keeps on the Mac and how to delete them.
