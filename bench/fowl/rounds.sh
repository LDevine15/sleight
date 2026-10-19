#!/bin/sh
# FowlBrowser's own round runner (github.com/argofowl/FowlBrowser, pinned below) with one added surface, sleight
# (bench/fowl/sleight-surface.patch). Claude arms run on the owner's account login with no CLAUDE* variables from the host session.
# Real gate: --real-browser chrome|helium|firefox|safari --surface sleight-turbo|sleight|lcu|cua|peekaboo|codex|codex-sol|codex-sleight|codex-sleight-sol|fowlbrowser|claude-in-chrome
#   [--real-profile fresh|benchmark] [--dry-run]. benchmark (Chrome only) copies the "sleight benchmark" profile per round.
#   codex-sleight / codex-sleight-sol run sleight itself inside Codex (gpt-6-luna / gpt-6.1-sol, effort high) from ~/.codex-bench-sleight
#   (login copied from ~/.codex-bench by the round's arm prep or `node bench/codex-sleight.mjs setup`): turbo in Chrome and Helium,
#   the engine path in Firefox and Safari. A proxy (bench/codex-sleight-proxy.mjs) answers sleight's approval forms from the race's
#   allowlist, so the engine's Always allow list and sleight's preapproved.json are not touched.
#   Peekaboo's grants are on Terminal.app, so its rounds run from a Terminal window (`open -a Terminal x.command`); the gate
#   refuses otherwise. A Codex round sets the engine's Always allow list to the round's apps and restores it; a Cua round
#   starts Cua's daemon when it isn't running and stops it afterwards (bench/fowl/real-gate.mjs, arm-prep.json).
# Usage: bench/fowl/rounds.sh --surface sleight|fowlbrowser|fowl+sleight|browser-use [rounds.mjs options]
set -eu
PIN=8b68924
DIR="$HOME/Library/Caches/sleight-bench/fowlbrowser"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
for a in "$@"; do
  [ "$a" != --plan ] || exec node "$REPO/bench/fowl/accounting.mjs" "$@"
done
REAL=""; DRY=""
MODEL=opus; SURFACE=""; TASKS=""; OUT=""; ONLY=""; GUI=""; REMOTE=""; prev=""; for a in "$@"; do
  [ "$prev" = --real-browser ] && REAL="$a"
  [ "$a" = --dry-run ] && DRY=1
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
[ -z "$REAL" ] || [ -z "$DRY" ] || exec node "$REPO/bench/fowl/real-gate.mjs" "$@"
[ -n "$REAL" ] || node "$REPO/bench/fowl/preflight.mjs" "$@"
[ -d "$DIR/.git" ] || git clone -q https://github.com/argofowl/FowlBrowser "$DIR"
cd "$DIR"
# The clone is this benchmark's own cache: when its tracked files differ from the current patch (an older
# patch, or nothing applied), put them back to the pin and apply the patch.
if ! git diff | cmp -s - "$REPO/bench/fowl/sleight-surface.patch"; then
  git checkout -q -- . && git checkout -q "$PIN" && git apply "$REPO/bench/fowl/sleight-surface.patch"
fi
[ "$(git rev-parse --short HEAD)" = "$PIN" ] || { echo "rounds.sh: $DIR is not at $PIN" >&2; exit 1; }
if [ -n "$REAL" ]; then
  exec env -i HOME="$HOME" USER="$USER" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
    SLEIGHT_REPO="$REPO" ${SLEIGHT_TRACE:+SLEIGHT_TRACE="$SLEIGHT_TRACE"} ${SLEIGHT_TS3:+SLEIGHT_TS3="$SLEIGHT_TS3"} ${SLEIGHT_FS:+SLEIGHT_FS="$SLEIGHT_FS"} node tools/rounds.mjs "$@" --model "$MODEL"
fi
# Every Claude arm runs on the owner's account login, never the API credit (owner, 2026-10-15, LAWS). Browser Use
# needs an API key by design, so it runs only in a round of its own (computer use keeps its login beside it), and the
# spend ledger still refuses it from $190.
SPEND="$HOME/Library/Logs/sleight/bench-api-spend.json"
# Task overrides determine which arms run. Computer use always uses its login.
SURFACES="$(node "$REPO/bench/fowl/preflight.mjs" --funding-surfaces "$@")"
# roundAuth refuses Browser Use beside any Claude arm other than computer use, and answers api only for Browser Use.
AUTH=$(node "$REPO/bench/fowl/accounting.mjs" --auth-mode "$MODEL" "$SURFACES") || exit 1
if [ "$AUTH" = account ]; then
  KEY=""
else
  KEY="$(node --input-type=module -e "import { pathToFileURL } from 'node:url'; const { readKey } = await import(pathToFileURL(process.argv[1]).href); const k = readKey(); if (!k) process.exit(1); process.stdout.write(k);" "$REPO/bench/api-auth.mjs")"
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
