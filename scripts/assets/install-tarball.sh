#!/usr/bin/env bash
#
# Installs the Edi binary and desktop integration from the portable tarball
# into the current user's ~/.local/share (respecting XDG_DATA_HOME). Run from
# inside the extracted tarball directory.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
ICON_DIR="$APP_DIR/icons/hicolor/512x512/apps"
APPS_DIR="$APP_DIR/applications"
mkdir -p "$APP_DIR/bin" "$ICON_DIR" "$APPS_DIR"

install -m 0755 "$ROOT/edi" "$APP_DIR/bin/edi"
install -m 0644 "$ROOT/edi.png" "$ICON_DIR/edi.png"
sed "s|@EDI_BINARY@|$APP_DIR/bin/edi|" "$ROOT/edi.desktop" > "$APPS_DIR/edi.desktop"
chmod 0644 "$APPS_DIR/edi.desktop"

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$APP_DIR/icons/hicolor" >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

echo "Installed Edi to $APP_DIR/bin/edi with desktop integration."
echo "Log out and back in (or restart the dock) if the icon shows as a gear."
