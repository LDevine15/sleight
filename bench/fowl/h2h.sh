#!/bin/sh
# FowlBrowser's 13 head-to-head tasks, both arms, both browser orders, interleaved so drift hits both arms alike.
# Output: /tmp/fb-rounds/h2h-<stamp>-<arm>-<order>/ (report.md, per-agent transcripts).
set -u
STAMP=$(date +%Y%m%d-%H%M)
DIR=$(cd "$(dirname "$0")" && pwd)
IDS=chrome=7a356c11-c3ba-4fd3-88ff-2f891496ba7e,helium=2f6fb307-288b-46d7-9fc2-5262c30ea852
for order in normal swap; do
  for arm in fowlbrowser sleight; do
    out=/tmp/fb-rounds/h2h-$STAMP-$arm-$order
    swap=; [ $order = swap ] && swap=--swap
    echo "== $arm $order $(date +%T)"
    "$DIR/rounds.sh" --surface $arm --tasks tools/agents/codex-h2h.json --serve "node test/demo/server.mjs --all" \
      --codex-browsers $IDS --out "$out" $swap > "$out.log" 2>&1
    echo "exit $? $(date +%T)"; grep -E "^ROUND|\| (ok|fail|FAIL)" "$out.log" | head -20
  done
done
