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

Then start a new Codex session from a project folder. Started in your home folder, Codex reads
`~/.codex/hooks.json` as that folder's project config too, and runs any hooks you keep there.

The first time, Codex asks you to review sleight's two hooks. Trust them. At the end of a turn,
interrupted or not, they call sleight's `turn_ended` tool, which should release the apps sleight used.
We have seen Codex list and trust them, but no log yet shows one running. Codex skips untrusted hooks,
and then sleight ends a used turn after 30 idle seconds.

To set up Computer Use on a Mac that doesn't have it yet, run setup from the installed copy:
`~/.codex/plugins/cache/sleight/sleight/<version>/bin/sleight-mcp setup`. Its `--doctor` reports
whether sleight is installed and enabled in Codex, and whether Codex's own Computer Use is on beside it.

To update, run `codex plugin marketplace upgrade sleight && codex plugin add sleight@sleight` and
start a new session. We've checked the second step against a local marketplace only.

Codex runs the same server, skill and tools as Claude Code. Its tool names match Claude Code's
(`mcp__plugin_sleight_computer__js` and the rest), and the skill text is identical on both hosts.
Codex lists the skill as `sleight:drive-mac-apps`.

Approvals follow the same rules as in Claude Code. Each app gets one card with Allow, Always allow
and Decline. Allow lasts as long as Codex keeps sleight's server running, which can span more than one
thread. Codex shows the card as its own prompt. Picking Always there writes sleight's pre-approved
list, exactly as clicking Always allow does in Claude Code, and the owner saw that happen for TextEdit
on 2026-10-19. In the Codex source we read (openai/codex at 89461ea6, newer than the installed
0.160.0), Codex never fills in that choice for you. Its auto-review and its full-access mode answer
only cards without fields, and sleight's card has one, so they decline it or ask you. A headless
`codex exec` run declines it, so it can only use apps you've pre-approved. sleight writes Always only
from an answer Codex doesn't mark or marks as the user's. Any other marker counts as Allow.

When Codex's own Computer Use plugin is on too, the model sees two computer-use surfaces. sleight's
skill listing tells it to use sleight's tools. To start a session without Codex's plugin:

```bash
codex -c 'plugins."computer-use@openai-bundled".enabled=false'
```

We tested that switch on a copy of the plugin under another marketplace name, since the real one
can't be installed into a test home. To keep it off, turn it off in Codex's plugin settings. sleight
never changes Codex's config itself. Leave `unified-computer-use` on. Its server config also turns on the
browser automation that Codex's Browser plugin uses.

Codex doesn't get the pane, the status line, the `/sleight` command or turbo. Turbo ties each turn to
your own message through the Claude Code mod, which Codex doesn't run. The Codex plugin sets
`SLEIGHT_TURBO=0`, and browsers use the engine path. Codex gives a plugin's server only a short list
of environment variables, and sleight's plugin adds every documented `SLEIGHT_*` [setting](settings.md)
to it except the benchmark ones. Export a setting in the shell that starts Codex and sleight sees it.

Live checks so far on 2026-10-19 used Codex 0.160.0 and gpt-6.1-sol with the owner at the Mac.
Calculator worked out 12 × 12 = 144 in 22.5 s, and a new plain TextEdit document took 44.4 s, including the
approval. In both, the first `getApp` failed and the model retried. We think Codex's sandbox state
sends each call to an engine kernel of its own. sleight now sets up again whenever that state changes,
which unit tests cover but no live run has checked yet.

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
