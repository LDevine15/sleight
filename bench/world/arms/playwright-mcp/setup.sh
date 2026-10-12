#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/../install.mjs" playwright-mcp @playwright/mcp@0.0.83 @anthropic-ai/claude-code@2.1.289 "$@"
