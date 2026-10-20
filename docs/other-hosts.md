# Other MCP hosts

sleight is a Claude Code plugin first. It also installs as a Codex plugin and a Cursor plugin, and its
MCP server works with generic stdio clients. [INSTALL.md](../INSTALL.md) has the install steps for each, and they all need
the same Mac and ChatGPT app setup.

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

The first time, Codex asks you to review sleight's three hooks. Trust them. At the end of a turn,
interrupted or not, the Stop and Interrupt hooks call sleight's `turn_ended` tool, which should release the apps sleight
used. The prompt hook is turbo's (below).
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

Codex doesn't get the pane, the status line or the `/sleight` command. Turbo works in Codex 0.160.0 and
later: sleight's prompt hook ties each turbo turn to your message, and the Stop and Interrupt hooks end
it. It hasn't run in a live session yet. Trust all three hooks when Codex asks. Until you do, turbo's tools report that turbo is unavailable
and the model uses the engine path. [How the binding works](design/other-hosts.md#turbo-in-codex).
Codex gives a plugin's server only a short list
of environment variables, and sleight's plugin adds every documented `SLEIGHT_*` [setting](settings.md)
to it except the benchmark ones. Export a setting in the shell that starts Codex and sleight sees it.

Live checks so far on 2026-10-19 used Codex 0.160.0 and gpt-6.1-sol with the owner at the Mac.
Calculator worked out 12 × 12 = 144 in 22.5 s, and a new plain TextEdit document took 44.4 s, including the
approval. In both, the first `getApp` failed and the model retried. We think Codex's sandbox state
sends each call to an engine kernel of its own. sleight now sets up again whenever that state changes,
which unit tests cover but no live run has checked yet.

## Cursor

The repo is also a Cursor plugin marketplace ([install](../INSTALL.md#cursor)). Nobody has run this install yet. It needs
the 1.4.0 release on the public repo.

If sleight is installed in Claude Code, Cursor may run it already. Cursor 3.25.6 loads Claude Code's
plugins while "Include Third-Party Plugins, Skills, and Other Configs" is on in its settings, which is
the default. On our Mac, Cursor's logs show sleight's server connected in 10 sessions from 2026-10-08
to 2026-10-14. cursor-agent's plugin loader keeps one plugin per marketplace and name, so installing
sleight from the marketplace above replaces that copy in cursor-agent. We haven't checked the Cursor app's own
loader. `sleight-mcp --doctor` has a Cursor section that lists each route it
finds, and gives the command when there's none.

Cursor's model calls sleight's tools through Cursor's own MCP tool, as server `plugin-sleight-computer`,
tool `js`. The plugin's skill is the same file Claude Code and Codex read, and as in Claude Code only
the skill's slash command loads it in full. The relay adds it to the engine's first documentation
reply. Approvals use Cursor's form prompts and name Cursor. Cursor's hooks run shell commands and can't
call an MCP tool. The relay ends a used turn after 30 idle seconds and on disconnect. Cursor doesn't
get the pane, the status line, `/sleight` or turbo.

## Grok CLI

Grok CLI is supported in 1.4.0 through the [direct MCP entry](../INSTALL.md#grok-cli). Grok 1.0.13's headless
`mcp doctor computer` completed the handshake and listed 10 tools. It identified itself as
`grok-shell-computer`, version `1.0.13`. The direct entry's handshake sent `grok-shell-sleight` at that same version.
Both listed 10 tools. The dropdown and approval panel call it Grok.
No model session, image delivery or app task has been checked.

Grok can import sleight from Claude Code's `known_marketplaces.json` checkout. On the study Mac that copy was
1.3.1, while Claude Code used its 1.3.0 cache. The doctor's Grok section reports that mismatch and the
`[compat.claude]` import switch, on by default. Marketplace add and plugin install with `--trust` succeeded
in a throwaway home, but inspect still selected the imported copy. Keep one server and check `grok inspect --json`
for its target. No warning about sleight's mod-only `hooks.json` appeared. Those hooks have not run in Grok.

The injected guidance names `computer__js` for the import, or `sleight__js` for the direct entry, through Grok's
`use_tool`. Results stay within 20,000 serialized bytes, including images and metadata. Trees shrink first.
An output that still cannot fit returns a delivery error; execution may have completed, so read current state before retrying.
The first documentation reply's size is unit-tested, with the full confirmation policy. A model session has not checked spilling.

Grok's form answers grant Allow for this server session. Even an Always answer cannot write a pre-approval.
Only the user's click on Always allow in sleight's own panel writes one. Set `SLEIGHT_APPROVAL_PROMPT=dialog`
if you want that panel. Turbo stays off in Grok for 1.4.0: its command hooks cannot bind each MCP call to a trusted
user turn. Browser and Electron work use the engine path. Used turns end after 30 idle seconds or on disconnect.

## Grok Bot

Grok Bot uses its local shell daemon to call sleight on your Mac. Its custom STDIO MCP servers run in Grok's hosted
box, which has neither your Mac's apps nor ChatGPT's engine. Use the shell route below instead of adding a box server.

With ChatGPT and Computer Use set up, call the clone's executable by its full path:

```bash
/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp js 'await cua.getState()'
```

When no session is listening, `js` starts a detached session in its own process group. It keeps one relay behind
`~/Library/Caches/sleight/shell/session.sock` (0600 in a 0700 folder). Connections require the same uid. The session
needs Apple's clang from Xcode Command Line Tools to build its peer-check helper. sleight doesn't install a login job.
The session and relay use a fixed environment and the shell cache as their working directory. Caller guard settings,
Node options and flow-rule paths are not inherited.
Any process running as your macOS user can drive this session. A bot with shell access can also edit
`preapproved.json` directly. The socket's permissions do not isolate it from those processes.
The socket path must fit in 103 UTF-8 bytes, so a long home path can prevent startup.
After ten idle minutes it collects the engine, removes its socket and prunes its images. A call in progress does
not count as idle. The next call starts a session again. Every call prints the session ID on stdout before its result. A changed ID means JavaScript handles
and session approvals have reset. Read the engine docs in its first reply before continuing.

Startup waits at most 90 seconds. Each relay call keeps its five-minute timeout, and the shell waits at most 310 seconds
for the reply. Together these limits stay below the bot's reported 13-minute foreground limit. A timed-out call may
have acted. The session refuses further calls until the engine replies or exits. If it has not returned after another 30 seconds,
the session begins shutdown. Shutdown gives the relay ten seconds after EOF, then sends SIGTERM to its process group and
SIGKILL five seconds later if needed. It waits for that group to exit before releasing session ownership.
Reply writes have a ten-second deadline so a caller that stops reading cannot hold a peer slot.
Read current state before retrying input.
sleight never replays a dispatched call during startup recovery.
Images and screenshots become 0600 files in private `images-*` folders under that shell cache. Read the printed path
through the bot's local file tool before the session exits or fifty newer images replace it. Startup also prunes image folders left by a crashed session.

Give the bot [the Grok Bot skill](grokbot-skill.md), replacing its executable placeholder with your clone's full path.
Set this one-line profile pointer, replacing the skill path with its installed location:

```text
For Mac UI tasks, read /absolute/path/to/sleight/docs/grokbot-skill.md and use its sleight shell instructions.
```

### Optional owner LaunchAgent step

If you want to start the session through launchd, preview the plist and command:

```bash
/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp session --install-agent
```

This only prints the plist and `launchctl bootstrap` command. Save the plist and run the command yourself if you choose
this route. sleight never writes or loads it. The session still exits after ten idle minutes. The agent runs once at load and does not restart failed sessions. To keep a session in a terminal instead, run `sleight-mcp session` and stop it with Ctrl-C.
Permissions under launchd may differ from the bot's shell. Doctor checks the live session's native helper.

The commands `open_file`, `select_window` and `drag` each accept one JSON argument with the same fields as their MCP tool.
Run the command with `--help` to read its description and argument schema before using it:

```bash
/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp select_window --help
/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp select_window '{"app":"TextEdit","title":"Untitled"}'
```

`sleight-mcp --doctor` has a separate Grok Bot section. It reads the app bundle version, the computer-use gate,
local daemon PID state and local tool permission setting, then prints `route: shell (sleight-mcp js)` even when a
session isn't running. Missing or unreadable state
shows as unknown. A running PID does not prove the daemon's identity or health. Doctor doesn't read daemon credentials or browser storage.
It asks the live shell session to run sleight's native JXA helper and check `AXIsProcessTrusted`, without a prompt
or app interaction. Without a live session the result is unknown. If denied, tell the owner that the session's
responsible app needs Accessibility. Do not change permissions. The engine's own grants belong to its helper and do
not prove that sleight's metadata helper has access.

Grok Bot's own computer use is a second driver when it is on. Its helper and sleight do not share an input lease,
so both could act on the same app. Grok's `always` local tool permission does not answer sleight's approval panel.
The shell route has no trusted user-turn binding, so every payment, booking, settings change and submit asks on
sleight's panel, including actions you requested. Turbo stays off because the route cannot bind a user turn.
App Allow lasts for that session without adding an entry to the pre-approved list. Existing user pre-approvals apply
only to plain engine app-access cards whose quoted app name matches their app metadata. Local tools, including
`drag` and `open_file`, ask on the panel for each action. Their approvals are never remembered on this route.

Grok Bot has no Mac-side MCP client placement, so there is no HTTP bridge route. Offline tests cover the shell transport
and its guards. One live read passed (2026-10-20). Image delivery hasn't been checked live. Grok Bot support is a preview:
approvals wait in the menu bar glove ([known problems](known-problems.md#hosts-and-platform)).

Screenshots and app text sent through any Grok route go to Grok's hosted model. Grok Bot sends them through its gateway.
See [privacy](privacy.md#what-leaves-the-mac).

## Generic clients

[INSTALL.md](../INSTALL.md#other-mcp-clients) has the clone and the `mcpServers` entry. The launcher runs on the Node
bundled with ChatGPT, without npm install. To use [Cursor](https://cursor.com/docs/context/mcp) without the plugin, put
that entry in `~/.cursor/mcp.json`. Keep one route: with the plugin installed too, Cursor starts two sleight servers.

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
