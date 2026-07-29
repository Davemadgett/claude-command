#!/bin/bash
# Run the board in your browser. This is the path that needs nothing but Node —
# no Xcode, no build tools, no signing. ./app/build.sh is the optional step that
# wraps the same thing in a real Mac app.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4317}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "This needs $1. $2" >&2
    exit 1
  }
}

need node "Install Node 20 or newer from https://nodejs.org and run this again."

# A major version behind and better-sqlite3's prebuilt binary won't load, which
# surfaces as an unreadable NODE_MODULE_VERSION error rather than "upgrade node".
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $(node -v) is too old — this needs 20 or newer." >&2
  exit 1
fi

if [ ! -d node_modules ] || [ ! -d web/node_modules ]; then
  echo "Installing dependencies (first run only)…"
  npm install --silent
  npm --prefix web install --silent
fi

if [ ! -d web/dist ] || [ -n "$(find web/src -newer web/dist -type f 2>/dev/null | head -1)" ]; then
  echo "Building the UI…"
  npm --prefix web run build >/dev/null
fi

# The calendar panel needs a small Swift helper, and Swift is the one dependency
# not everyone has. Build it if we can, and carry on quietly if we can't — every
# other part of the board works without it.
if [ ! -x bin/calendar-dump ] && command -v swiftc >/dev/null 2>&1; then
  echo "Building the calendar helper…"
  mkdir -p bin
  swiftc -O -target arm64-apple-macos12 -framework EventKit -framework Foundation \
    -o bin/calendar-dump app/CalendarDump.swift 2>/dev/null || true
fi

if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Already running on port $PORT."
else
  PORT="$PORT" node server/index.js &
  sleep 1.5
fi

echo
echo "  Board:  http://127.0.0.1:$PORT"
echo "  Stop:   Ctrl-C"
echo

open "http://127.0.0.1:$PORT" 2>/dev/null || true
wait
