#!/usr/bin/env bash
#
# Installs Linux desktop integration for the Edi executable so the taskbar
# and dock show the Edi icon instead of a generic gear. On Wayland the icon
# comes from a .desktop entry, not the window icon, so without this the app
# shows a generic marker even though the window icon is set.
#
# Usage:  ./scripts/install-desktop.sh [path/to/edi]
#         (defaults to ./dist-app/edi)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:-$ROOT/dist-app/edi}"
if [ ! -x "$BIN" ]; then
  echo "error: executable not found: $BIN" >&2
  echo "usage: $0 [path/to/edi]" >&2
  exit 1
fi
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
ICON_DIR="$APP_DIR/icons/hicolor/512x512/apps"
APPS_DIR="$APP_DIR/applications"
mkdir -p "$ICON_DIR" "$APPS_DIR"

install -m 0644 "$ROOT/scripts/assets/app-icon.png" "$ICON_DIR/edi.png"
sed "s|@EDI_BINARY@|$BIN|" "$ROOT/scripts/assets/edi.desktop" > "$APPS_DIR/edi.desktop"
chmod 0644 "$APPS_DIR/edi.desktop"

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$APP_DIR/icons/hicolor" >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

echo "Installed Edi desktop integration:"
echo "  Icon:    $ICON_DIR/edi.png"
echo "  Desktop: $APPS_DIR/edi.desktop (Exec=$BIN)"
echo "Log out and back in (or restart the dock) if the gear icon persists."
