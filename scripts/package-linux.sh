#!/usr/bin/env bash
#
# Wraps an existing Edi onefile binary into standard Linux packages:
#   .deb (Debian/Ubuntu), .rpm (Fedora/RHEL/openSUSE),
#   .tar.gz (portable archive), .AppImage (self-contained desktop app).
#
# The binary is never rebuilt here — only wrapped — so the packages inherit
# the glibc 2.35 build from Dockerfile.pyzip (see scripts/build-pyzip.sh).
#
# Usage: ./scripts/package-linux.sh [path/to/edi] [version]
#
#   path    the onefile executable to wrap      (default: ./dist-app/edi)
#   version x.y.z used in names and metadata    (default: scripts/version.sh current)
#
# Output (into ./dist-app):
#   edi_<ver>_amd64.deb
#   edi-<ver>-1.x86_64.rpm
#   edi-<ver>-linux-x86_64.tar.gz
#   Edi-<ver>-x86_64.AppImage
#
# Requires: dpkg-deb, rpmbuild (apt-get install rpm), tar, curl, a venv
# python with PySide6 for icon scaling, and network for the appimagetool
# download. dpkg-deb output is forced to xz so old apt versions can read it.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BIN="${1:-$ROOT/dist-app/edi}"
if [ ! -x "$BIN" ]; then
  echo "error: executable not found: $BIN" >&2
  echo "usage: $0 [path/to/edi] [version]" >&2
  exit 1
fi
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

if [ $# -ge 2 ]; then
  VER="$2"
else
  VER="$(./scripts/version.sh current)"
fi
if [[ ! "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: invalid version '$VER' (expected x.y.z)" >&2
  exit 1
fi

DEB_ARCH="amd64"
RPM_ARCH="x86_64"

# Runtime libraries the onefile bundle does not include but QtWebEngine needs.
# Debian package names (checked against Ubuntu 22.04, the build target).
DEB_DEPENDS=(
  libnss3 libnspr4
  libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxtst6 libxkbfile1
  libxcb-cursor0 libxcb-xkb1 libxcb-icccm4 libxcb-shape0 libxcb-keysyms1
  libxcb-xinerama0 libxcb-render-util0
  libxkbcommon0 libxkbcommon-x11-0
  libgbm1 libegl1 libgl1 libgl1-mesa-dri
  libasound2 libpulse0 libpcsclite1
  libdbus-1-3 libfontconfig1 libglib2.0-0
  libkrb5-3 libgssapi-krb5-2
  libwayland-cursor0 libwayland-egl1 libwayland-server0
  fonts-dejavu-core
)
# Same libraries under their RPM package names (Fedora/RHEL).
RPM_REQUIRES=(
  nss nspr
  libXcomposite libXdamage libXrandr libXfixes libXtst libxkbfile
  libxcb-cursor libxcb-xkb libxcb-icccm libxcb-shape libxcb-keysyms
  libxcb-xinerama libxcb-render-util
  libxkbcommon libxkbcommon-x11
  libgbm mesa-libEGL mesa-libGL mesa-dri-drivers
  alsa-lib pulseaudio-libs pcsc-lite-libs
  dbus-libs fontconfig glib2
  krb5-libs
  wayland
  dejavu-fonts-common dejavu-sans-fonts
)

# Join a bash array into a comma/newline-separated string.
join_comma() {
  local IFS=','
  echo "${*}"
}
join_space() {
  local IFS=' '
  echo "${*}"
}

STAGE="$ROOT/build/package"
OUT="$ROOT/dist-app"
rm -rf "$STAGE"
mkdir -p "$STAGE"

print_step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

# --- 1. Common install tree (usr/) used by the .deb and .rpm ---------------
print_step "Assembling install tree"
TREE="$STAGE/tree"
mkdir -p "$TREE/usr/bin" \
  "$TREE/usr/share/applications" \
  "$TREE/usr/share/doc/edi"
install -m 0755 "$BIN" "$TREE/usr/bin/edi"
install -m 0644 "$ROOT/packaging/edi.desktop" "$TREE/usr/share/applications/edi.desktop"

# hicolor icon set scaled from the 1024x1024 source with PySide6 (headless).
SCALE_PY="$STAGE/scale_icons.py"
cat > "$SCALE_PY" <<'PYEOF'
import os
import sys
from PySide6.QtGui import QImage

src, outroot = sys.argv[1], sys.argv[2]
img = QImage(src)
if img.isNull():
    sys.exit("error: could not read icon: %s" % src)
for size in (16, 32, 48, 64, 128, 256, 512):
    d = os.path.join(outroot, f"{size}x{size}", "apps")
    os.makedirs(d, exist_ok=True)
    if not img.scaled(size, size).save(os.path.join(d, "edi.png")):
        sys.exit("error: could not write icon size %s" % size)
print("wrote 7 hicolor sizes")
PYEOF
if [ -x "$ROOT/.venv/bin/python" ]; then
  PY="$ROOT/.venv/bin/python"
else
  PY="python3"
fi
"$PY" "$SCALE_PY" "$ROOT/scripts/assets/app-icon.png" "$TREE/usr/share/icons/hicolor"

install -m 0644 "$ROOT/LICENSE" "$TREE/usr/share/doc/edi/copyright"
install -m 0644 "$ROOT/README.md" "$TREE/usr/share/doc/edi/README.md"

# --- 2. .deb -----------------------------------------------------------------
print_step "Building .deb (xz compression)"
DEB_DIR="$STAGE/deb"
cp -a "$TREE" "$DEB_DIR"
mkdir -p "$DEB_DIR/DEBIAN"
sed -e "s|@VERSION@|$VER|" \
  -e "s|@DEPENDS@|$(join_comma "${DEB_DEPENDS[@]}")|" \
  "$ROOT/packaging/control.in" > "$DEB_DIR/DEBIAN/control"
DEB_NAME="edi_${VER}_${DEB_ARCH}.deb"
dpkg-deb --build --root-owner-group -Zxz "$DEB_DIR" "$OUT/$DEB_NAME"
dpkg-deb --info "$OUT/$DEB_NAME" > /dev/null

# --- 3. .rpm -----------------------------------------------------------------
print_step "Building .rpm"
if ! command -v rpmbuild >/dev/null 2>&1; then
  echo "error: rpmbuild not found; install with: apt-get install -y rpm" >&2
  exit 1
fi
RPM_DIR="$STAGE/rpm"
mkdir -p "$RPM_DIR/"{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
cp -a "$TREE/usr" "$RPM_DIR/SOURCES/usr"
sed -e "s|@VERSION@|$VER|" \
  -e "s|@REQUIRES@|$(join_space "${RPM_REQUIRES[@]}")|" \
  "$ROOT/packaging/edi.spec.in" > "$RPM_DIR/SPECS/edi.spec"
rpmbuild -bb \
  --define "_topdir $RPM_DIR" \
  --define "_sourcedir $RPM_DIR/SOURCES" \
  --define "_dbpath $RPM_DIR/rpmdb" \
  "$RPM_DIR/SPECS/edi.spec"
RPM_FILE=$(find "$RPM_DIR/RPMS" -name "*.rpm" | head -1)
RPM_NAME="edi-${VER}-1.${RPM_ARCH}.rpm"
install -m 0644 "$RPM_FILE" "$OUT/$RPM_NAME"

# --- 4. .tar.gz ---------------------------------------------------------------
print_step "Building portable .tar.gz"
TAR_DIR="$STAGE/tgz/edi-${VER}-linux-${RPM_ARCH}"
mkdir -p "$TAR_DIR"
install -m 0755 "$BIN" "$TAR_DIR/edi"
install -m 0644 "$ROOT/scripts/assets/edi.desktop" "$TAR_DIR/edi.desktop"
install -m 0644 "$TREE/usr/share/icons/hicolor/512x512/apps/edi.png" "$TAR_DIR/edi.png"
install -m 0755 "$ROOT/scripts/assets/install-tarball.sh" "$TAR_DIR/install.sh"
cat > "$TAR_DIR/README.txt" <<EOF
Edi $VER (portable)

  ./edi            run the editor (no installation required)
  ./install.sh     install the binary + desktop integration for this user

The .deb/.rpm/.AppImage artifacts are the recommended install paths; this
archive is a plain-file fallback that needs no package manager.
EOF
tar -C "$STAGE/tgz" -czf "$OUT/edi-${VER}-linux-${RPM_ARCH}.tar.gz" "edi-${VER}-linux-${RPM_ARCH}"

# --- 5. .AppImage ---------------------------------------------------------------
print_step "Building .AppImage"
APPDIR="$STAGE/AppDir"
mkdir -p "$APPDIR/usr/bin"
install -m 0755 "$BIN" "$APPDIR/usr/bin/edi"
install -m 0644 "$ROOT/packaging/edi.desktop" "$APPDIR/edi.desktop"
install -m 0644 "$TREE/usr/share/icons/hicolor/512x512/apps/edi.png" "$APPDIR/edi.png"
install -m 0755 "$ROOT/packaging/AppDir/AppRun" "$APPDIR/AppRun"

TOOL="$STAGE/appimagetool"
if [ ! -x "$TOOL" ]; then
  curl -fsSL -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage" \
    || curl -fsSL -o "$TOOL" \
      "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$TOOL"
fi
(
  cd "$STAGE"
  APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$RPM_ARCH" VERSION="$VER" "$TOOL" "$APPDIR"
) >/dev/null
APPIMAGE_FILE=$(find "$STAGE" -maxdepth 1 -name "*.AppImage" | head -1)
if [ -z "$APPIMAGE_FILE" ]; then
  echo "error: appimagetool produced no AppImage" >&2
  exit 1
fi
install -m 0755 "$APPIMAGE_FILE" "$OUT/Edi-${VER}-${RPM_ARCH}.AppImage"

# --- Done ------------------------------------------------------------------------
printf '\nPackaged Edi %s:\n' "$VER"
ls -lh "$OUT/edi_${VER}_${DEB_ARCH}.deb" \
  "$OUT/$RPM_NAME" \
  "$OUT/edi-${VER}-linux-${RPM_ARCH}.tar.gz" \
  "$OUT/Edi-${VER}-${RPM_ARCH}.AppImage"
