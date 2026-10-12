#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/../install.mjs" chrome-devtools-mcp chrome-devtools-mcp@1.10.1 @anthropic-ai/claude-code@2.1.289 "$@"
