#!/bin/sh
set -eu
exec node "$(dirname "$0")/../../native-setup.mjs" cua --version 0.34.0 "$@"
