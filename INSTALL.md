# Installing sleight

If you're a coding agent installing sleight for a user, follow this file from the top. sleight lets a coding agent drive
the user's Mac apps in the background, through the computer-use engine inside the ChatGPT desktop app. These steps belong
to the user alone:

- typing an administrator's password or Touch ID during `sleight-mcp setup`,
- allowing Codex Computer Use under Accessibility and Screen Recording in System Settings,
- clicking Allow or Always allow on the first approval card for each app,
- turning on Chrome's remote debugging at `chrome://inspect/#remote-debugging` and allowing Chrome's prompt, for turbo.

At each one, stop and tell the user what to do. Don't run `sudo` or `sleight-mcp setup`, script System Settings, or
work around a permission prompt or an approval card in any other way. Run each command below on its own, as written,
without wrapping it in a script.

## Requirements

- macOS on Apple Silicon. We've tested on macOS 27 and haven't measured a minimum version. Intel builds are untested.
- The [ChatGPT desktop app](https://chatgpt.com/download/) in `/Applications`. It holds the engine. A ChatGPT account and a
  Codex sign-in aren't needed.
- A host, such as Claude Code 2.1.288 or later, Codex CLI (tested on 0.160.0), or any MCP client that starts a stdio server.

sleight runs on the Node runtime inside ChatGPT, so there's nothing to install with npm.

## Claude Code

```bash
claude plugin marketplace add Land-o-Clusters/sleight
claude plugin install sleight@sleight
```

Find the plugin folder in Claude Code's own listing. In the first command's output, sleight's entry (`sleight@sleight`)
has an `installPath`. Run the doctor from that folder, with the path written out in full:

```bash
claude plugin list --json
<installPath>/bin/sleight-mcp --doctor
```

Then ask the user to start a new Claude Code session so the plugin loads.

## Codex

```bash
codex plugin marketplace add Land-o-Clusters/sleight
codex plugin add sleight@sleight
```

Codex's own listing gives sleight's installed `version`. Codex keeps the plugin under its home folder, `$CODEX_HOME`
(`~/.codex` when the variable isn't set). Run the doctor from there, with the version filled in:

```bash
codex plugin list --json
"$CODEX_HOME/plugins/cache/sleight/sleight/<version>/bin/sleight-mcp" --doctor
```

Then the user starts a new Codex session from a project folder and trusts sleight's three hooks when Codex asks. What
differs in Codex is in [other hosts](docs/other-hosts.md#codex).

## Cursor

Cursor's install hasn't been run live yet. Signed in to cursor-agent 2026.09.10 or later:

```bash
cursor-agent plugin marketplace add https://github.com/Land-o-Clusters/sleight
```

Then the user installs sleight from `/plugins` in cursor-agent, or from Customize in the Cursor app, and starts a new chat.
Check it from Cursor's plugin cache, where the last folder is the commit Cursor installed. The doctor's Cursor section
lists each route it finds and warns when Cursor would start sleight twice ([Cursor](docs/other-hosts.md#cursor)):

```bash
~/.cursor/plugins/cache/sleight/sleight/<commit>/bin/sleight-mcp --doctor
```

## Other MCP clients

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
prints a line with `setup` in it, Computer Use isn't on yet, and turning it on is the user's step. Give them the setup
command to run, from the folder the doctor ran from:

```text
<installPath>/bin/sleight-mcp setup
```

Setup runs OpenAI's helper installer, which asks for an administrator's Touch ID or password. It then opens the
Accessibility and Screen Recording panes, where the user allows Codex Computer Use, and runs the doctor again. To show
the user what it will do, run it yourself with `--dry-run` added. Setup hasn't been run in a fresh macOS user.

For turbo in Chrome, the user turns on remote debugging once at `chrome://inspect/#remote-debugging`. Chrome then asks
them to allow each connection. The doctor's first lines say whether turbo is ready ([settings](docs/settings.md#turbo)).

## Check it works

In the new session, ask:

```text
Use sleight to open Calculator in the background and work out 12 × 12 by clicking its buttons.
```

The user sees an approval card for Calculator. Once they allow it, Calculator should end on 144 while the window the
user was working in stays in front. In Codex on 2026-10-19 this took 22.5 s.

## Update and uninstall

| Host | Update | Uninstall |
| --- | --- | --- |
| Claude Code | `claude plugin marketplace update sleight && claude plugin update sleight@sleight`, then a new session | `claude plugin uninstall sleight@sleight && claude plugin marketplace remove sleight` |
| Codex | `codex plugin marketplace upgrade sleight && codex plugin add sleight@sleight`, then a new session | `codex plugin remove sleight@sleight && codex plugin marketplace remove sleight` |
| Other MCP clients | `git pull --ff-only` in the clone, then reconnect | Remove the `mcpServers` entry and the clone |

The Codex update has been checked against a local marketplace only. [Privacy](docs/privacy.md#deleting-everything) lists
the files sleight keeps on the Mac and how to delete them.
