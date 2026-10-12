#!/bin/sh
# Three hand-off tasks (browser step, then a Mac app), on FowlBrowser alone, sleight alone, and both
# servers together. Output: /tmp/fb-rounds/handoff-<stamp>-<arm>/. Do not run while sleight-arch is
# on a live round: this drives Chrome, Helium, Preview and TextEdit.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
exec node "$DIR/handoff-runner.mjs"
