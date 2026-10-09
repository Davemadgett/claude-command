#!/bin/bash
# Bring this machine's copy current: pull, install, build, relaunch.
#
#   ./update.sh                      pull + rebuild; relaunch the app if it was running
#   ./update.sh --no-relaunch        pull + rebuild only (a relaunch ends every live session)
#   CC_TEMPLATE=<file> ./update.sh   also re-render config.json from that template
#
# Run it on every machine after a push. node_modules never travels between
# machines — the native modules (node-pty, better-sqlite3) are built for this
# Node, on this machine, by npm install.
set -euo pipefail
cd "$(dirname "$0")"

RELAUNCH=1
[ "${1:-}" = "--no-relaunch" ] && RELAUNCH=0

echo "Pulling…"
git pull --ff-only

echo "Installing…"
npm install --silent --no-audit --no-fund
npm --prefix web install --silent --no-audit --no-fund

if [ -n "${CC_TEMPLATE:-}" ]; then
  ./configure.sh "$CC_TEMPLATE"
fi

echo "Building UI…"
npm --prefix web run build >/dev/null

APP_NAME="$(node -e 'let c={};try{c=JSON.parse(require("fs").readFileSync("config.json","utf8"))}catch{};process.stdout.write(c.appName||"Claude Command")')"
EXEC_NAME="$(printf '%s' "$APP_NAME" | tr -d ' ')"
PORT="${PORT:-$(node -e 'let c={};try{c=JSON.parse(require("fs").readFileSync("config.json","utf8"))}catch{};process.stdout.write(String(c.port||4317))')}"

BUNDLE_ID="$(node -e 'let c={};try{c=JSON.parse(require("fs").readFileSync("config.json","utf8"))}catch{};process.stdout.write(c.bundleId||"com.example.claudecommand")')"
LAUNCHD_LABEL="$BUNDLE_ID.server"

# Two ways the server may be running. Under launchd (a LaunchAgent labelled
# <bundleId>.server, the always-on install: the app then attaches to it and
# never spawns its own), restart that job. Otherwise the app owns the server,
# and the only way to load new server code is to relaunch the app.
if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
  if command -v swiftc >/dev/null 2>&1; then ./app/build.sh; fi
  if [ "$RELAUNCH" = 1 ]; then
    echo "Restarting $LAUNCHD_LABEL (live sessions end; each is resumable from its card)…"
    launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
  else
    echo "Server under launchd is still the OLD code; restart it with: launchctl kickstart -k gui/$(id -u)/$LAUNCHD_LABEL"
  fi
elif command -v swiftc >/dev/null 2>&1; then
  WAS_RUNNING=0
  pgrep -x "$EXEC_NAME" >/dev/null 2>&1 && WAS_RUNNING=1
  ./app/build.sh
  if [ "$RELAUNCH" = 1 ]; then
    if [ "$WAS_RUNNING" = 1 ]; then
      echo "Relaunching $APP_NAME (live sessions end; each is resumable from its card)…"
      osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
      for _ in $(seq 1 20); do pgrep -x "$EXEC_NAME" >/dev/null || break; sleep 0.5; done
      for p in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$p" 2>/dev/null || true; done
    fi
    open "/Applications/$APP_NAME.app"
  elif [ "$WAS_RUNNING" = 1 ]; then
    echo "App is still running the OLD server; relaunch it when you reach a stopping point."
  fi
else
  echo "No swiftc here — browser mode. Restart ./start.sh to load the new server."
fi

for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && { echo "Up: http://127.0.0.1:$PORT  ($(git log -1 --format='%h %s'))"; exit 0; }
  sleep 0.5
done
echo "Updated to $(git log -1 --format='%h') but nothing is answering on :$PORT yet." >&2
exit 1
