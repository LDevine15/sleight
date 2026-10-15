#!/bin/sh
# FowlBrowser's own round runner (github.com/argofowl/FowlBrowser, pinned below) with one added surface, sleight
# (bench/fowl/sleight-surface.patch). Claude arms run on the owner's account login with no CLAUDE* variables from the host session.
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
# Every Claude arm runs on the owner's account login, never the API credit (owner, 2026-10-15, LAWS). Browser Use
# needs an API key by design, so it runs only in a round of its own (computer use keeps its login beside it), and the
# spend ledger still refuses it from $190.
SPEND="$HOME/Library/Logs/sleight/bench-api-spend.json"
# Task overrides determine which arms run. Computer use always uses its login.
SURFACES="$(node "$REPO/bench/fowl/preflight.mjs" --funding-surfaces "$@")"
if echo "$SURFACES" | grep -qx browser-use; then
  if echo "$SURFACES" | grep -vx -e browser-use -e claude-cu | grep -q .; then
    echo "rounds.sh: Claude arms run on the owner's login; run browser-use, which needs the API key, in a round of its own" >&2; exit 1
  fi
  AUTH=api
  KEY="$(node --input-type=module -e "import { pathToFileURL } from 'node:url'; const { readKey } = await import(pathToFileURL(process.argv[1]).href); const k = readKey(); if (!k) process.exit(1); process.stdout.write(k);" "$REPO/bench/api-auth.mjs")"
else
  AUTH=account; KEY=""
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
