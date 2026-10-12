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
# Opus runs on the owner's Claude account (owner, 2026-10-12: parity with FowlBrowser's published runs without
# spending the API credit). Other models run on the API key, whose monthly credit stops at $200 (LAWS): refuse a round
# from $190, and add each round's cost to the ledger.
MODEL=opus; prev=""; for a in "$@"; do [ "$prev" = --model ] && MODEL="$a"; prev="$a"; done
SPEND="$HOME/Library/Logs/sleight/bench-api-spend.json"
case "$MODEL" in
  *opus*) AUTH=account; KEY="" ;;
  *) AUTH=api; KEY="$(cat "$HOME/.config/sleight-bench/anthropic-api-key")" ;;
esac
[ "$AUTH" = account ] || node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=new Date().toISOString().slice(0,7);process.exit(j.month===m&&j.usd>=190?1:0)' "$SPEND" || { echo "rounds.sh: this month's API spend is at or over $190" >&2; exit 1; }
mkdir /tmp/sleight-live.lock || { echo "rounds.sh: the live lock is held" >&2; exit 1; }
trap 'rmdir /tmp/sleight-live.lock' EXIT; trap 'exit 130' INT TERM HUP
OUT=""; prev=""; for a in "$@"; do [ "$prev" = --out ] && OUT="$a"; prev="$a"; done
trap 'rmdir /tmp/sleight-live.lock; [ "$AUTH" = api ] && [ -n "$OUT" ] && [ -f "$OUT/report.md" ] && node "$REPO/bench/fowl/add-spend.mjs" "$OUT/report.md" "$SPEND"' EXIT
env -i HOME="$HOME" USER="$USER" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
  SLEIGHT_REPO="$REPO" SLEIGHT_TRACE="${SLEIGHT_TRACE:-}" SLEIGHT_PROMPT="${SLEIGHT_PROMPT:-}" ${KEY:+ANTHROPIC_API_KEY="$KEY"} \
  node tools/rounds.mjs --model opus --effort medium "$@"
