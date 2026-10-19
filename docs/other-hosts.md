# Other MCP hosts

sleight is a Claude Code plugin first. It also installs as a Codex plugin, and its MCP server works
with Cursor and generic stdio clients. Each needs the same [Mac and ChatGPT app setup](../README.md#install).

## Codex

The repo is also a Codex marketplace. Install sleight with:

```bash
codex plugin marketplace add Land-o-Clusters/sleight
```

```bash
codex plugin add sleight@sleight
```

Then start a new Codex session. The first time, Codex asks you to review sleight's two hooks. Trust
them. At the end of a turn, interrupted or not, they call sleight's `turn_ended` tool. That releases
the apps sleight used. Codex skips untrusted hooks, and then sleight ends a used turn after 30
idle seconds.

To set up Computer Use on a Mac that doesn't have it yet, run setup from the installed copy:
`~/.codex/plugins/cache/sleight/sleight/<version>/bin/sleight-mcp setup`. Its `--doctor` reports
whether sleight is installed and enabled in Codex, and whether Codex's own Computer Use is on beside it.

To update, run `codex plugin marketplace upgrade sleight && codex plugin add sleight@sleight` and
start a new session.

Codex runs the same server, skill and tools as Claude Code. Its tool names match Claude Code's
(`mcp__plugin_sleight_computer__js` and the rest), and the skill text is identical on both hosts.
Codex lists the skill as `sleight:drive-mac-apps`.

Approvals follow the same rules as in Claude Code. Each app gets one card with Allow, Always allow
and Decline, and Allow lasts for the session. Only your own pick writes Always allow. Codex
0.160.0 tells MCP servers it can show forms, and sleight sends each card to Codex as a form instead
of opening its own panel. We haven't yet seen a card in an interactive Codex session. A headless
`codex exec` run can't answer forms, and it refuses any app you haven't pre-approved.

When Codex's own Computer Use plugin is on too, the model sees two computer-use surfaces. sleight's
skill listing tells it to use sleight's tools. To start a session without Codex's plugin:

```bash
codex -c 'plugins."computer-use@openai-bundled".enabled=false'
```

To keep it off, turn it off in Codex's plugin settings. sleight never changes Codex's config itself.
Leave `unified-computer-use` on, since Codex's Browser plugin runs on it too.

Codex doesn't get the pane, the status line, the `/sleight` command or turbo. Turbo ties each turn to
your own message through the Claude Code mod, which Codex doesn't run. The Codex plugin sets
`SLEIGHT_TURBO=0`, and browsers use the engine path. Codex gives a plugin's server only a short list
of environment variables, and sleight's plugin adds the documented `SLEIGHT_*` [settings](settings.md)
to it. Export a setting in the shell that starts Codex and sleight sees it.

## Cursor and generic clients

Clone the repo and use its launcher. It runs on the Node bundled with ChatGPT, without npm install.

```bash
git clone https://github.com/Land-o-Clusters/sleight.git ~/sleight
~/sleight/plugins/sleight/bin/sleight-mcp --doctor
```

For [Cursor](https://cursor.com/help/customization/mcp), put this in `~/.cursor/mcp.json`. The same
`mcpServers` entry works in a generic client that accepts this JSON format. Replace the command with
your clone's absolute path. JSON doesn't expand `~` or `${CLAUDE_PLUGIN_ROOT}`.

```json
{
  "mcpServers": {
    "sleight": {
      "command": "/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp"
    }
  }
}
```

After reconnecting the client, ask it to use sleight's `js` tool.

These clients don't get the Claude Code pane, status line, `/sleight stop`, registered skill
command or turbo. The relay still adds the bundled
skill's guidance to the first engine documentation reply. Without that file, the engine's API docs
and tools still work. Approvals use the client's form prompts when supported, otherwise sleight's
own macOS panel. That panel names Claude under Claude Code and uses generic wording in other hosts.
Without a turn hook, the relay ends a used turn after 30 idle seconds and on disconnect. Close the
server connection to stop the session.

Update the clone with `git pull --ff-only` and reconnect. See [settings](settings.md) for approval
overrides and [the design note](design/other-hosts.md) for protocol checks and host-testing limits.
