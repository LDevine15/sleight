#!/bin/sh
# Read-only probe for sleight-arch: pass the existing Safari PID. Never launches Safari.
# Run only with no owner windows. Prints roles/attribute names; values are redacted
# unless they are the exact benchmark profile match. Never prints page/tab content.
set -eu
[ "$#" -eq 1 ] || { echo 'usage: safari-ax-probe.sh SAFARI_PID' >&2; exit 64; }
case "$1" in ''|*[!0-9]*) exit 64 ;; esac
ROOT=$(cd "$(dirname "$0")" && pwd)
TEMP=$(mktemp -d /private/tmp/sleight-safari-probe-XXXXXX)
trap 'rm -rf "$TEMP"' EXIT
/usr/bin/xcrun swiftc -module-cache-path "$TEMP/module-cache" "$ROOT/safari-helper.swift" -o "$TEMP/probe"
"$TEMP/probe" --probe "$1"
