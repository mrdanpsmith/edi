#!/usr/bin/env bash
#
# Installs Linux desktop integration for the Edi executable so the taskbar
# and dock show the Edi icon instead of a generic gear. On Wayland the icon
# comes from a .desktop entry, not the window icon, so without this the app
# shows a generic marker even though the window icon is set.
#
# Also registers Edi for .md and Mermaid (.mmd, .mermaid) files: it installs
# the text/x-mermaid MIME type (packaging/edi-mime.xml), which the system
# database lacks, and the desktop entry advertises text/markdown,
# text/x-markdown and text/x-mermaid (via the template), which makes the app
# appear in the "Open With" menu. Pass --set-default to additionally make Edi
# the system default handler for those types.
#
# Usage:  ./scripts/install-desktop.sh [--set-default] [path/to/edi]
#         (path defaults to ./dist-app/edi/edi; a bundle directory means the
#         edi executable inside it)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/dist-app/edi/edi"
SET_DEFAULT=0
for arg in "$@"; do
  case "$arg" in
    --set-default) SET_DEFAULT=1 ;;
    *) BIN="$arg" ;;
  esac
done
[ -d "$BIN" ] && BIN="$BIN/edi"
if [ ! -f "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "error: executable not found: $BIN" >&2
  echo "usage: $0 [--set-default] [path/to/edi]" >&2
  exit 1
fi
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
ICON_DIR="$APP_DIR/icons/hicolor/512x512/apps"
APPS_DIR="$APP_DIR/applications"
MIME_DIR="$APP_DIR/mime"
mkdir -p "$ICON_DIR" "$APPS_DIR" "$MIME_DIR/packages"

install -m 0644 "$ROOT/scripts/assets/app-icon.png" "$ICON_DIR/edi.png"
sed "s|@EDI_BINARY@|$BIN|" "$ROOT/scripts/assets/edi.desktop" > "$APPS_DIR/edi.desktop"
chmod 0644 "$APPS_DIR/edi.desktop"
install -m 0644 "$ROOT/packaging/edi-mime.xml" "$MIME_DIR/packages/edi.xml"

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database "$MIME_DIR" >/dev/null 2>&1 || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$APP_DIR/icons/hicolor" >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

if [ "$SET_DEFAULT" = 1 ]; then
  if ! command -v xdg-mime >/dev/null 2>&1; then
    echo "error: xdg-mime not found; cannot set default MIME handler" >&2
    exit 1
  fi
  for mime in text/markdown text/x-markdown text/x-mermaid; do
    xdg-mime default edi.desktop "$mime"
  done
fi

echo "Installed Edi desktop integration:"
echo "  Icon:    $ICON_DIR/edi.png"
echo "  Desktop: $APPS_DIR/edi.desktop (Exec=$BIN %U)"
echo "  MIME:    $MIME_DIR/packages/edi.xml (text/x-mermaid: *.mmd, *.mermaid)"
echo "  Handles: text/markdown;text/x-markdown;text/x-mermaid"
if [ "$SET_DEFAULT" = 1 ]; then
  echo "  Default: Edi is now the default handler for Markdown and Mermaid files"
else
  echo "  Default: pass --set-default to make Edi the default Markdown and Mermaid handler"
fi
echo "Log out and back in (or restart Files/the dock) if the app or gear icon is stale."
