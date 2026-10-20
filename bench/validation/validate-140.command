#!/bin/zsh
# Start directly from sleight-arch's shell in an agreed away window.
# --plan is the default and performs no writes, waiting, app inspection or launches.
set -eu
ROOT=${0:A:h:h:h}
exec node "$ROOT/bench/validation/validation-140.mjs" "$@"
