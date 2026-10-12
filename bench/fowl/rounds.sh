#!/bin/sh
# FowlBrowser's own round runner (github.com/argofowl/FowlBrowser, pinned below) with one added surface, sleight
# (bench/fowl/sleight-surface.patch). Runs on the owner's API key with no CLAUDE* variables from the host session.
# Usage: bench/fowl/rounds.sh --surface sleight|fowlbrowser|fowl+sleight [rounds.mjs options]
set -eu
PIN=8b68924
DIR="$HOME/Library/Caches/sleight-bench/fowlbrowser"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
[ -d "$DIR/.git" ] || git clone -q https://github.com/argofowl/FowlBrowser "$DIR"
cd "$DIR"
# The clone is this benchmark's own cache: when its tracked files differ from the current patch (an older
# patch, or nothing applied), put them back to the pin and apply the patch.
if ! git diff | cmp -s - "$REPO/bench/fowl/sleight-surface.patch"; then
  git checkout -q -- . && git checkout -q "$PIN" && git apply "$REPO/bench/fowl/sleight-surface.patch"
fi
[ "$(git rev-parse --short HEAD)" = "$PIN" ] || { echo "rounds.sh: $DIR is not at $PIN" >&2; exit 1; }
mkdir /tmp/sleight-live.lock || { echo "rounds.sh: the live lock is held" >&2; exit 1; }
trap 'rmdir /tmp/sleight-live.lock' EXIT; trap 'exit 130' INT TERM HUP
env -i HOME="$HOME" USER="$USER" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
  SLEIGHT_REPO="$REPO" SLEIGHT_TRACE="${SLEIGHT_TRACE:-}" SLEIGHT_PROMPT="${SLEIGHT_PROMPT:-}" ANTHROPIC_API_KEY="$(cat "$HOME/.config/sleight-bench/anthropic-api-key")" \
  node tools/rounds.mjs --model opus --effort medium "$@"
