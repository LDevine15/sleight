---
name: sleight-mac-ui
description: Use sleight through the local Mac shell for app and browser UI tasks.
---

# Mac UI through sleight

sleight is a Claude Code plugin that drives Mac apps through the computer-use engine bundled with ChatGPT.
Grok Bot reaches it through the local shell on the Mac. Its hosted MCP box cannot reach the Mac's apps.

Before installing this skill, replace `/absolute/path/to/sleight` below with the clone's full path on the Mac.
For Mac UI tasks, call this executable with JavaScript as one safely quoted shell argument:

```bash
/absolute/path/to/sleight/plugins/sleight/bin/sleight-mcp js 'await cua.getState()'
```

Read the engine API docs printed by the first call before taking further actions. Use only APIs those docs describe.
Keep JavaScript handles between calls. The session starts on demand and exits after ten idle minutes. When a restart
notice shows a different session ID, acquire the handles again and read the new first reply's docs. Treat a
"did not become ready" error as a possible reset too.
To reset JavaScript yourself, call the same full executable path with `js_reset`.

Screenshots and images return as local cache file paths. Read the printed file through the local file tool before the
session exits and prunes it. After an error or timeout, read current state before retrying input.

Use sleight for Mac computer use. Keep Grok Bot's own computer-use helper off so there is one driver.
Payments, bookings, settings changes and submits ask on sleight's panel. Stop and wait for the owner's click.
Do not answer that panel through computer use or edit sleight's approval files, pre-approved list or consent state.
Grok's local-tool approval settings do not answer sleight's panels.
Relay any "sleight: waiting for your approval on the Mac" line to the user. Wait for their answer without retrying the call.
Do not set `SLEIGHT_*` environment variables, write or load the LaunchAgent plist, or remove sleight's cache folder.

If access fails, run the same full executable path with `--doctor` through the local shell. Its Grok Bot section checks
whether sleight's native metadata helper has Accessibility in the live shell session, without requesting permission.
Report the missing grant to the owner. Never open System Settings, trigger a permission prompt or change approvals.
