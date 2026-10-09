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

if command -v swiftc >/dev/null 2>&1; then
  WAS_RUNNING=0
  pgrep -x "$EXEC_NAME" >/dev/null 2>&1 && WAS_RUNNING=1
  ./app/build.sh
  if [ "$RELAUNCH" = 1 ]; then
    if [ "$WAS_RUNNING" = 1 ]; then
      echo "Relaunching $APP_NAME (live sessions end; each is resumable from its card)…"
      osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
      for _ in $(seq 1 20); do pgrep -x "$EXEC_NAME" >/dev/null || break; sleep 0.5; done
      pkill -f "node server/index.js" >/dev/null 2>&1 || true
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
