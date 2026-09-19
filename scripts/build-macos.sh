#!/usr/bin/env bash
#
# Builds the macOS Edi app (Edi.app) + a drag-to-Applications .dmg on a Mac.
#
# PyInstaller cannot cross-compile, so this must run on macOS. GitLab's hosted
# macOS runners are Premium/Ultimate-only (beta), so there is NO macOS CI job —
# run this on a Mac when cutting a release and attach the .dmg to the release
# manually if you want a published artifact.
#
#   ./scripts/build-macos.sh [x.y.z]      # version from scripts/version.sh by default
#
# Output: dist-app/Edi-<ver>-macos-arm64.dmg
#
# Apple Silicon (arm64) only. The app is ad-hoc code-signed (arm64 will not
# launch unsigned) but NOT notarized (no Apple Developer account in CI), so
# Gatekeeper warns on first open on another Mac — right-click > Open, or
# `xattr -dr com.apple.quarantine Edi.app`. Developer-ID signing + notarization
# are a deliberate out-of-scope follow-up (needs account credentials).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(./scripts/version.sh current)}"
VERSION="${VERSION#v}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: invalid version '$VERSION' (expected x.y.z)" >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: macOS binaries must be built on macOS (PyInstaller cannot cross-compile)" >&2
  exit 1
fi

print_step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_AUTO_UPDATE

# --- Toolchain: brew-install what the pins need ------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node --version | sed -E 's/^v([0-9]+).*/\1/')" -lt 20 ]; then
  echo "Installing node@22 via Homebrew..."
  brew install node@22
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi
if ! command -v python3 >/dev/null 2>&1 || \
   ! python3 -c 'import sys; exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  echo "Installing python@3.12 via Homebrew..."
  brew install python@3.12
  export PATH="/opt/homebrew/opt/python@3.12/bin:$PATH"
fi

print_step "Building Edi $VERSION for macOS (arm64)"

# --- Frontend ----------------------------------------------------------------
npm ci --no-audit --no-fund
npm run build

# --- Python venv --------------------------------------------------------------
python3 -m venv .venv-macos
PY_VENV="$ROOT/.venv-macos/bin/python"
"$PY_VENV" -m pip install --upgrade pip
"$PY_VENV" -m pip install "PySide6==6.11.1" "pyinstaller==6.22.0" "defusedxml"

# --- Icons (ico + icns from the 1024 master, pure Node) ---------------------
node scripts/generate-icon.mjs

# --- PyInstaller .app ---------------------------------------------------------
rm -rf dist-app
PYINSTALLER_ZLIB_COMPRESSION_LEVEL=1 "$PY_VENV" -m PyInstaller --clean \
  --distpath dist-app \
  --workpath build \
  edi.spec

APP="$ROOT/dist-app/Edi.app"
if [ ! -d "$APP" ]; then
  echo "error: $APP was not produced" >&2
  exit 1
fi

# --- Ad-hoc code-sign (arm64 will not launch unsigned) -------------------------
print_step "Ad-hoc code-signing Edi.app"
codesign --force --deep -s - "$APP"
codesign --verify --deep --strict "$APP"

# --- Offscreen smoke test ------------------------------------------------------
# Headless QtWebEngine (same flags CI uses for the Linux binary; a window does
# briefly appear on a real desktop and exits via os._exit). macOS GUI bundles
# keep usable stdout when launched from a shell, so the SELFTEST line + exit
# code are the gate. The onefile self-extracts to $TMPDIR, so point it at a
# disk-backed dir under build/.
print_step "Verifying Edi.app via the offscreen smoke test"
mkdir -p "$ROOT/build/smoke-tmp-macos"
TMPDIR="$ROOT/build/smoke-tmp-macos" \
QT_QPA_PLATFORM=offscreen \
QTWEBENGINE_DISABLE_SANDBOX=1 \
QTWEBENGINE_CHROMIUM_FLAGS="--disable-dev-shm-usage --disable-gpu" \
EDI_SELFTEST=1 \
timeout 120 "$APP/Contents/MacOS/Edi"

# --- Drag-to-Applications .dmg ---------------------------------------------------
print_step "Creating the .dmg"
DMG_STAGE="$ROOT/dist-app/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
DMG="$ROOT/dist-app/Edi-$VERSION-macos-arm64.dmg"
hdiutil create -volname "Edi $VERSION" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG"
rm -rf "$DMG_STAGE"
print_step "Done: $DMG"