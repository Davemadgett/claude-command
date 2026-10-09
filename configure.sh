#!/bin/bash
# Render config.json from a template, so one template serves every machine.
#
#   ./configure.sh <template.json>
#
# config.json is gitignored on purpose: it holds paths on this disk and the
# owner's name. Keep the real one in a template somewhere private and render it
# here. Three placeholders are filled in:
#
#   {{HOME}}       this user's home directory
#   {{CLIO_ROOT}}  what `paths.py --print clio` prints (cloud mounts get renamed;
#   {{PA_ROOT}}    what `paths.py --print pa` prints    resolve them, never type them)
#
# The last two are only looked up if the template uses them, and the resolver
# path can be overridden with CC_PATHS_PY. A placeholder that cannot be filled
# is an error, not an empty string — a config with a blank root looks fine and
# silently finds nothing.
set -euo pipefail
cd "$(dirname "$0")"

TEMPLATE="${1:-}"
[ -n "$TEMPLATE" ] && [ -f "$TEMPLATE" ] || { echo "usage: ./configure.sh <template.json>" >&2; exit 2; }
PATHS_PY="${CC_PATHS_PY:-$HOME/code/clio-assistant/paths.py}"

resolve() {
  [ -f "$PATHS_PY" ] || { echo "configure: template needs $1 but $PATHS_PY is missing" >&2; exit 1; }
  local v
  v="$(python3 "$PATHS_PY" --print "$1")" || { echo "configure: paths.py could not resolve '$1'" >&2; exit 1; }
  [ -n "$v" ] && [ -d "$v" ] || { echo "configure: '$1' resolved to '$v', which is not a directory" >&2; exit 1; }
  printf '%s' "$v"
}

CLIO_ROOT=""; PA_ROOT=""
grep -q '{{CLIO_ROOT}}' "$TEMPLATE" && CLIO_ROOT="$(resolve clio)"
grep -q '{{PA_ROOT}}'   "$TEMPLATE" && PA_ROOT="$(resolve pa)"

HOME_DIR="$HOME" CLIO_ROOT="$CLIO_ROOT" PA_ROOT="$PA_ROOT" node -e '
  const fs = require("fs");
  let t = fs.readFileSync(process.argv[1], "utf8");
  t = t.split("{{HOME}}").join(process.env.HOME_DIR)
       .split("{{CLIO_ROOT}}").join(process.env.CLIO_ROOT)
       .split("{{PA_ROOT}}").join(process.env.PA_ROOT);
  const left = t.match(/{{[A-Z_]+}}/g);
  if (left) { console.error("configure: unknown placeholder(s): " + [...new Set(left)].join(" ")); process.exit(1); }
  JSON.parse(t);
  fs.writeFileSync("config.json", t);
' "$TEMPLATE"

echo "Wrote config.json from $TEMPLATE"
