#!/bin/bash
# Install (or remove) the background updater on this machine.
#
#   ./app/install-updater.sh            install: runs at login and every hour
#   ./app/install-updater.sh --remove
#
# The updater is a LaunchAgent labelled <bundleId>.updater that runs
# `update.sh --if-behind --when-idle`: nothing happens unless the remote has new
# commits; then the code is pulled, dependencies and the app bundle rebuilt, and
# the server restarted only if no session is live. Otherwise the new version
# simply takes effect the next time the app or the launchd server starts.
# Log: ~/Library/Logs/<appName>-updater.log
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "$REPO"

read_config() {
  node -e "
    const fs = require('fs');
    let c = {};
    try { c = JSON.parse(fs.readFileSync('$REPO/config.json', 'utf8')); } catch {}
    process.stdout.write(String(c['$1'] ?? '$2'));
  "
}
BUNDLE_ID="$(read_config bundleId 'com.example.claudecommand')"
APP_NAME="$(read_config appName 'Claude Command')"
LABEL="$BUNDLE_ID.updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/$(printf '%s' "$APP_NAME" | tr -d ' ')-updater.log"
NODE_DIR="$(dirname "$(command -v node)")"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/update.sh</string>
    <string>--if-behind</string>
    <string>--when-idle</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL — checks $(git remote get-url origin) at login and hourly; log: $LOG"
