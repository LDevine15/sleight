#!/bin/zsh
# Logs the frontmost app, window id and title, twice a second, until killed.
# Tracked copy of .dev/passes/front-watch.sh with window identity added. Query only.
prev=""
while true; do
  f=$(osascript -l JavaScript -e 'ObjC.import("AppKit"); const app = $.NSWorkspace.sharedWorkspace.frontmostApplication; const name = ObjC.unwrap(app.localizedName) || ""; const pid = Number(app.processIdentifier); const info = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID); let id = "-", title = ""; if (info) { const count = Number(info.count); for (let i = 0; i < count; i++) { const w = info.objectAtIndex(i); const owner = Number(ObjC.unwrap(w.objectForKey("kCGWindowOwnerPID"))); const layer = Number(ObjC.unwrap(w.objectForKey("kCGWindowLayer"))); if (owner !== pid || layer !== 0) continue; id = String(Number(ObjC.unwrap(w.objectForKey("kCGWindowNumber")))); title = ObjC.unwrap(w.objectForKey("kCGWindowName")) || ""; break; } } name + "\t" + id + "\t" + title;' 2>/dev/null)
  [ "$f" != "$prev" ] && echo "$(date -u +%H:%M:%S.%3N 2>/dev/null || date -u +%H:%M:%S) $f" && prev=$f
  sleep 0.5
done
