# Apps the engine refuses

The engine's helper refuses terminals (Terminal, iTerm2) and OpenAI's own apps
(ChatGPT, Codex, Atlas, with their beta builds) before any approval prompt. The
refusal is OpenAI's code and is never modified, patched or wrapped.

The refusal text is `Computer Use is not allowed to use the app '…' for safety
reasons.` (engine 26.930.31730). The relay adds a note to such results naming the
setting that lifts the refusal, `ComputerUseAllowForbiddenTargets`, and tells
Claude to pass it on and stop. Only the user runs it, and sleight never sets it.

With the setting on, these apps go through the engine like any other app. The
approval card is the same one (Always allow, Allow, Decline), with one added line:
the app could be dangerous, because a terminal runs commands and another AI app
has approval buttons Claude could press (owner, 2026-10-11). Actions in their
settings windows are refused by window title (the words Settings and Preferences
in several languages, and Terminal's pane names), so Claude can't change their
approval or safety settings. The check runs in cooperative code and is not a
security boundary.

Until 2026-10-11 sleight also had `blocked_app`, its own Accessibility driver for
these apps when the setting is off. The owner removed it, because the setting
gives Claude the full engine path and every real Codex window tripped the driver's
settings scan.
