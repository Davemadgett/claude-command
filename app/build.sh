#!/bin/bash
# Build the Mac app into /Applications.
#
# What it is called, and its bundle identifier, come from config.json — so a
# fork gets its own app rather than overwriting somebody else's, and the name in
# the Dock matches the name in the window.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DEST="${DEST:-/Applications}"

# The only step in the whole project that needs Xcode. Say so plainly, and point
# at the path that doesn't — the app is a nicer wrapper, not the product.
if ! command -v swiftc >/dev/null 2>&1; then
  cat >&2 <<'MSG'
Building the Mac app needs Swift, which comes with the Xcode command line tools:

    xcode-select --install

You don't need it to use this. ./start.sh runs the same board in your browser.
MSG
  exit 1
fi

# node is already a dependency, so use it rather than adding jq.
read_config() {
  node -e "
    const fs = require('fs');
    let c = {};
    try { c = JSON.parse(fs.readFileSync('$REPO/config.json', 'utf8')); } catch {}
    process.stdout.write(String(c['$1'] ?? '$2'));
  "
}

APP_NAME="$(read_config appName 'Claude Command')"
BUNDLE_ID="$(read_config bundleId 'com.example.claudecommand')"
PORT="${PORT:-$(read_config port 4317)}"

# The executable inside the bundle cannot have spaces in a way that survives
# every launcher, so strip them: "Claude Command" -> "ClaudeCommand".
EXEC_NAME="$(printf '%s' "$APP_NAME" | tr -d ' ')"
APP="$DEST/$APP_NAME.app"

echo "Building UI…"
npm --prefix "$REPO/web" run build >/dev/null

# The generated icon is committed, so a missing Pillow is not a build failure —
# only a reason to keep the icon that is already there.
if [ ! -f "$HERE/AppIcon.icns" ] || python3 -c "import PIL" 2>/dev/null; then
  echo "Generating icon…"
  python3 "$HERE/make_icon.py" >/dev/null || echo "  (icon generation failed; using the committed one)"
fi

echo "Compiling…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -target arm64-apple-macos12 \
  -framework Cocoa -framework WebKit \
  -o "$APP/Contents/MacOS/$EXEC_NAME" \
  "$HERE/SessionBoard.swift"

echo "Building calendar helper…"
mkdir -p "$REPO/bin"
swiftc -O -target arm64-apple-macos12 \
  -framework EventKit -framework Foundation \
  -o "$REPO/bin/calendar-dump" \
  "$HERE/CalendarDump.swift"

cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${EXEC_NAME}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSCalendarsUsageDescription</key><string>${APP_NAME} reads your calendars so deadlines show up alongside your work.</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>${APP_NAME} reads your calendars so deadlines show up alongside your work.</string>
  <key>SBRepoPath</key><string>$REPO</string>
  <key>SBPort</key><string>$PORT</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSExceptionDomains</key>
    <dict>
      <key>127.0.0.1</key>
      <dict>
        <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
      </dict>
      <key>localhost</key>
      <dict>
        <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
      </dict>
    </dict>
  </dict>
</dict>
</plist>
PLIST

# Ad-hoc signature: without it macOS treats each rebuild as a different app and
# re-prompts for permissions.
codesign --force --deep --sign - "$APP" 2>/dev/null || true
touch "$APP"

echo "Built $APP"
