#!/bin/sh
# FowlBrowser's own round runner (github.com/argofowl/FowlBrowser, pinned below) with one added surface, sleight
# (bench/fowl/sleight-surface.patch). Runs on the owner's API key with no CLAUDE* variables from the host session.
# Usage: bench/fowl/rounds.sh --surface sleight|fowlbrowser|fowl+sleight|browser-use [rounds.mjs options]
set -eu
PIN=8b68924
DIR="$HOME/Library/Caches/sleight-bench/fowlbrowser"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
for a in "$@"; do
  [ "$a" != --plan ] || exec node "$REPO/bench/fowl/accounting.mjs" "$@"
done
MODEL=opus; SURFACE=""; TASKS=""; OUT=""; ONLY=""; GUI=""; REMOTE=""; prev=""; for a in "$@"; do
  [ "$prev" = --model ] && MODEL="$a"
  [ "$prev" = --surface ] && SURFACE="$a"
  [ "$prev" = --tasks ] && TASKS="$a"
  [ "$prev" = --out ] && OUT="$a"
  [ "$prev" = --only ] && ONLY="$a"
  [ "$prev" = --remote ] && REMOTE="$a"
  [ "$a" = --gui ] && GUI=1
  prev="$a"
done
MODEL=$(node "$REPO/bench/fowl/accounting.mjs" --model-id "$MODEL")
node "$REPO/bench/fowl/preflight.mjs" "$@"
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
SPEND="$HOME/Library/Logs/sleight/bench-api-spend.json"
# Task overrides determine whether any arm needs the API key. Computer use always uses its login.
SURFACES="$(node "$REPO/bench/fowl/preflight.mjs" --funding-surfaces "$@")"
if [ -z "$SURFACES" ] || [ "$SURFACES" = claude-cu ]; then
  AUTH=account; KEY=""
elif echo "$SURFACES" | grep -qx browser-use; then
  AUTH=api
  KEY="$(node --input-type=module -e "import { pathToFileURL } from 'node:url'; const { readKey } = await import(pathToFileURL(process.argv[1]).href); const k = readKey(); if (!k) process.exit(1); process.stdout.write(k);" "$REPO/bench/api-auth.mjs")"
elif echo "$MODEL" | grep -q opus; then
  AUTH=account; KEY=""
else
  AUTH=api; KEY="$(cat "$HOME/.config/sleight-bench/anthropic-api-key")"
fi
[ "$AUTH" = account ] || [ -n "$OUT" ] || { echo "rounds.sh: API rounds require --out so token spend can be recorded" >&2; exit 1; }
[ "$AUTH" = account ] || node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=new Date().toISOString().slice(0,7);process.exit((j.unpriced||j.month===m&&j.usd>=190)?1:0)' "$SPEND" || { echo "rounds.sh: API spend is at or over 190 USD, or a round's token cost needs reconciliation" >&2; exit 1; }
mkdir /tmp/sleight-live.lock || { echo "rounds.sh: the live lock is held" >&2; exit 1; }
trap 'rmdir /tmp/sleight-live.lock' EXIT; trap 'exit 130' INT TERM HUP
trap 'rmdir /tmp/sleight-live.lock; [ "$AUTH" = api ] && [ -n "$OUT" ] && [ -d "$OUT" ] && node "$REPO/bench/fowl/add-spend.mjs" "$OUT" "$SPEND"' EXIT
env -i HOME="$HOME" USER="$USER" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
  CLAUDE_CONFIG_DIR="$HOME/Library/Caches/sleight-bench/fowl-claude-config" \
  SLEIGHT_REPO="$REPO" SLEIGHT_TRACE="${SLEIGHT_TRACE:-}" SLEIGHT_PROMPT="${SLEIGHT_PROMPT:-}" SLEIGHT_ENGINE_DOCS="${SLEIGHT_ENGINE_DOCS:-}" ${KEY:+ANTHROPIC_API_KEY="$KEY"} \
  node tools/rounds.mjs --effort medium "$@" --model "$MODEL"
