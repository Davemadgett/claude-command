#!/bin/bash
# Build the UI if needed, then serve the board on a single port and open it.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4317}"

if [ ! -d web/dist ] || [ -n "$(find web/src -newer web/dist -type f 2>/dev/null | head -1)" ]; then
  echo "Building UI…"
  npm --prefix web run build >/dev/null
fi

if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Already running on port $PORT."
else
  PORT="$PORT" node server/index.js &
  sleep 1.5
fi

open "http://127.0.0.1:$PORT"
wait
