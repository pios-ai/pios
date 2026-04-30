#!/bin/bash
# Patch Electron.app Info.plist so macOS Dock shows "Pi" instead of "Electron" in dev mode
set -e
PLIST="$(dirname "$0")/../node_modules/electron/dist/Electron.app/Contents/Info.plist"
if [ ! -f "$PLIST" ]; then
  echo "[patch-electron-name] Info.plist not found, skipping"
  exit 0
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleName Pi" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Pi" "$PLIST"
echo "[patch-electron-name] Dock name patched to 'Pi'"

# Copy custom icon if available
ICON_SRC="$(dirname "$0")/../build/icon.icns"
ICON_DST="$(dirname "$0")/../node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$ICON_DST"
  echo "[patch-electron-name] Custom icon applied"
fi
