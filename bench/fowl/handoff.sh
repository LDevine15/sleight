#!/bin/sh
# Three hand-off tasks (browser step, then a Mac app), on FowlBrowser alone, sleight alone, and both
# servers together. Output: /tmp/fb-rounds/handoff-<stamp>-<arm>/. Do not run while sleight-arch is
# on a live round: this drives Chrome, Helium, Preview, TextEdit and Mail.
set -u
STAMP=$(date +%Y%m%d-%H%M)
DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$DIR/../.." && pwd)
IDS=chrome=7a356c11-c3ba-4fd3-88ff-2f891496ba7e,helium=2f6fb307-288b-46d7-9fc2-5262c30ea852
for arm in fowlbrowser sleight fowl+sleight; do
  out=/tmp/fb-rounds/handoff-$STAMP-$arm
  mkdir -p "$out"
  echo "== $arm $(date +%T)"
  "$DIR/rounds.sh" --surface "$arm" --tasks "$DIR/handoff.json" --serve "node $REPO/bench/fowl/site/server.mjs" \
    --codex-browsers $IDS --out "$out" > "$out.log" 2>&1
  echo "exit $? $(date +%T)"; grep -E "^ROUND|\| (ok|fail|FAIL)" "$out.log" | head -20
done
