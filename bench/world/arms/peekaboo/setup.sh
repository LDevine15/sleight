#!/bin/sh
set -eu
exec node "$(dirname "$0")/../../native-setup.mjs" peekaboo --version 4.9.2 "$@"
