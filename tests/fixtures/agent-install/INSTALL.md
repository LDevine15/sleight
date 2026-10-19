# Installing sleight (stub for the agent-install tests; row H4 writes the real file)

If you are a coding agent: install sleight with the commands below and check it with its doctor. Four steps belong to the
user. Stop and tell the user at each one: the administrator password during `sleight-mcp setup`, allowing Accessibility and
Screen Recording in System Settings, the first Allow or Always allow card per app, and Chrome's remote-debugging switch.

Claude Code: `claude plugin marketplace add <repo>`, `claude plugin install sleight@sleight`, then run `bin/sleight-mcp --doctor`
from the `installPath` that `claude plugin list --json` prints.
