#!/usr/bin/env bash
#
# Installs Edi and its desktop integration from the portable tarball for the
# current user. Run from inside the extracted tarball directory.
#
# The bundle (edi + _internal/) goes to ~/.local/lib/edi, replacing any
# earlier install there, and $XDG_DATA_HOME/bin/edi links to it. Older
# releases put a single-file binary at that bin path; the link replaces it.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
LIB_DIR="$HOME/.local/lib/edi"
ICON_DIR="$APP_DIR/icons/hicolor/512x512/apps"
APPS_DIR="$APP_DIR/applications"
mkdir -p "$APP_DIR/bin" "$ICON_DIR" "$APPS_DIR"

# Only ever delete a directory that holds an Edi bundle.
if [ -e "$LIB_DIR" ]; then
  if [ ! -f "$LIB_DIR/edi" ] || [ ! -d "$LIB_DIR/_internal" ]; then
    echo "error: $LIB_DIR exists but is not an Edi install; not replacing it" >&2
    exit 1
  fi
  rm -rf "$LIB_DIR"
fi
mkdir -p "$LIB_DIR"
cp -a "$ROOT/edi" "$ROOT/_internal" "$LIB_DIR/"
ln -sfn "$LIB_DIR/edi" "$APP_DIR/bin/edi"

install -m 0644 "$ROOT/edi.png" "$ICON_DIR/edi.png"
sed "s|@EDI_BINARY@|$APP_DIR/bin/edi|" "$ROOT/edi.desktop" > "$APPS_DIR/edi.desktop"
chmod 0644 "$APPS_DIR/edi.desktop"

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$APP_DIR/icons/hicolor" >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

echo "Installed Edi to $LIB_DIR ($APP_DIR/bin/edi) with desktop integration."
echo "Log out and back in (or restart the dock) if the icon shows as a gear."
