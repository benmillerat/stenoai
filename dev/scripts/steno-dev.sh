#!/bin/bash
# Fork-only helper: run this checkout as "Steno Dev" on a Mac that has the
# official Steno app installed. It reuses that app's bundled backend, so no
# Python/PyInstaller build is needed. Works because this branch changes no
# backend code. Notes are shared with the installed app, so never run both.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND="/Applications/Steno.app/Contents/Resources/stenoai"

[ -x "$BACKEND/stenoai" ] || { echo "Install the official Steno app into /Applications first."; exit 1; }
command -v npm >/dev/null || { echo "Install Node.js (npm) first."; exit 1; }
if pgrep -f "/Applications/Steno.app/Contents/MacOS/Steno" >/dev/null; then
  echo "Quit the official Steno app first (Cmd+Q): both use the same notes folder."; exit 1
fi

installed="$(defaults read /Applications/Steno.app/Contents/Info CFBundleShortVersionString 2>/dev/null || echo unknown)"
ours="$(node -p "require('$ROOT/app/package.json').version")"
[ "$installed" = "$ours" ] || echo "Warning: installed Steno is $installed, this checkout is $ours. Sync the fork with upstream if something breaks."

mkdir -p "$ROOT/dist"
ln -sfn "$BACKEND" "$ROOT/dist/stenoai"

cd "$ROOT/app"
[ -d node_modules ] || npm ci
[ -d node_modules/electron/dist ] || ELECTRON_SKIP_BINARY_DOWNLOAD= node node_modules/electron/install.js
exec npm start
