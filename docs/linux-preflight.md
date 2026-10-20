# Linux preflight

Run the Linux test suite on the final integrated commit before any public push. A macOS
focused test pass does not satisfy this release requirement. Record the commit, command,
test counts and exit code with the release evidence. A failing preflight stops the push.

From the worktree, with Docker running and network access for the Node image and npm:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node scripts/linux-preflight.mjs
```

The script runs Node 24 in Docker, installs dependencies with `npm ci --ignore-scripts`,
then runs `npm test`. Both npm commands use argument vectors, without a shell. It returns
the install or test exit code and returns nonzero if Docker cannot start or gets interrupted.
It creates a fresh Claude config inside the container and removes it when the checks end.

An anonymous volume at `/w/node_modules` keeps the Linux install separate from the host's
dependencies, including a lane's symlink to another worktree. Docker removes the volume
with the container. The source worktree is mounted at `/w` and may receive test artifacts.
A6's release preflight should invoke `node scripts/linux-preflight.mjs` and require exit 0.
Use `--worktree PATH` to check another worktree explicitly.

The underlying test command, for a worktree with Linux dependencies already installed, is:

```sh
docker run --rm -v <wt>:/w -w /w node:24 npm test
```

Replace `<wt>` with an absolute worktree path and quote the volume argument if it contains
spaces. A fresh checkout needs `npm ci --ignore-scripts` in Linux first. The reusable script
handles that prerequisite and Claude config isolation on each run. Prefer it when the host
uses a dependency symlink.

`tests/test-path-portability.test.mjs` scans all files under `tests/`, including nested
fixtures and comments, for hardcoded `/private/tmp` and `"/Users/"` paths. It has no file
exemptions. Use `os.tmpdir()` and a unique temporary directory for real filesystem work.
Tests of macOS path validation or privacy scrubbing may construct synthetic macOS paths
from components. Keep those strings separate from real allocation roots.

The path guard and command construction tests run offline. They do not prove that the
Linux suite passes. The actual Docker run remains required before public push.
