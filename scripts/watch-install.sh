#!/bin/sh
# Schedules scripts/watch.sh with launchd, weekly (Mondays at 9:00) or daily (9:00).
#   scripts/watch-install.sh                  install or update the weekly job
#   scripts/watch-install.sh --daily          run it daily
#   scripts/watch-install.sh --daily --live   also run the live checks after an engine update, once the
#                                             Mac has been idle 5 minutes (they open Calculator, and Safari
#                                             when this job has Accessibility)
#   scripts/watch-install.sh --remove         remove it
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.landoclusters.sleight-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

WHEN='<key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer>'
SAID="on Mondays at 9:00"
ENV=''
for arg in "$@"; do
  case "$arg" in
    --remove)
      launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
      rm -f "$PLIST"
      echo "removed $LABEL"
      exit 0 ;;
    --daily)
      WHEN='<key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer>'
      SAID="daily at 9:00" ;;
    --live)
      ENV='<key>EnvironmentVariables</key><dict><key>SLEIGHT_COMPAT_LIVE</key><string>1</string></dict>'
      SAID="$SAID, live checks on" ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/sleight"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$ROOT/scripts/watch.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict>$WHEN</dict>
  $ENV
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/sleight/watch.stderr.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL: runs $ROOT/scripts/watch.sh $SAID"
