#!/bin/sh
# Runs the Claude CLI with a throwaway config folder. Checks don't need a login, and the user's own config makes the CLI read
# its credentials from the macOS keychain, which prompts once per process when several checks run at once.
dir=$(mktemp -d "${TMPDIR:-/tmp}/sleight-claude-config.XXXXXX") || exit 1
trap 'rm -rf "$dir"' EXIT INT TERM
CLAUDE_CONFIG_DIR="$dir" claude "$@"
