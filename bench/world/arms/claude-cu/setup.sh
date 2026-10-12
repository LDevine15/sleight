#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/../install.mjs" claude-cu unsupported @anthropic-ai/claude-code@2.1.289 "$@"
