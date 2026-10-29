#!/usr/bin/env bash
#
# Builds the macOS Edi app (Edi.app) + a drag-to-Applications .dmg on a Mac.
#
# PyInstaller cannot cross-compile, so this must run on macOS. CI (GitHub
# Actions, `build-macos` job in .github/workflows/release.yml) runs it natively on
# an arm64 `macos-15` runner for v* tags; this script is also the local path —
# run it on a Mac when cutting a release without CI.
#
# It does NOT build the frontend or the icons: the `frontend` job builds both
# once and uploads them as the `edi-web` artifact, which this job (and the
# Linux/Windows jobs) consume. So it needs no Node, and it ASSERTS its
# preconditions rather than falling back to building them — see the check
# below. Locally, produce the inputs once with:
#   npm ci && npm run build && node scripts/generate-icon.mjs
#
#   ./scripts/build-macos.sh [x.y.z]      # version from scripts/version.sh by default
#
# Output: dist-app/Edi-<ver>-macos-arm64.dmg
#         dist-app/Edi-<ver>-arm64.zip + .sha256 (the curl installer's payload)
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
# Node is deliberately NOT provisioned here: the frontend and the icon
# variants are built once in the frontend job and consumed, so nothing in this
# script runs npm. Only the Python venv below needs a toolchain check.
if ! command -v python3 >/dev/null 2>&1 || \
   ! python3 -c 'import sys; exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  echo "Installing python@3.12 via Homebrew..."
  brew install python@3.12
  export PATH="/opt/homebrew/opt/python@3.12/bin:$PATH"
fi

print_step "Building Edi $VERSION for macOS (arm64)"

# --- Frontend + icons: consumed, never built here ---------------------------
# The frontend is built ONCE, in the `frontend` job (release.yml), which also
# generates the .ico/.icns variants and uploads dist/ + the icons as `edi-web`.
# Every platform build consumes that one artifact. This script does not build
# the frontend and does not generate icons: regenerating here meant the .app
# shipped a second, separately built dist/ that the `test` job never ran
# against, and nothing enforced the two were the same (AGENTS.md used to
# assert they were "byte-identical" while also saying macOS rebuilt it).
#
# So this is an assert, not a fallback. A missing artifact is a hard failure
# with the one command that fixes it, exactly as build-windows.ps1 does for its
# own two preconditions -- because a script that quietly regenerates what it
# was supposed to consume turns a broken artifact download into a green build
# of something else, which is the failure mode worth refusing to have.
print_step "Checking prebuilt frontend + icons"
MISSING=""
[ -f "$ROOT/dist/index.html" ] || MISSING="$MISSING dist/index.html"
[ -f "$ROOT/scripts/assets/app-icon.ico" ] || MISSING="$MISSING scripts/assets/app-icon.ico"
[ -f "$ROOT/scripts/assets/app-icon.icns" ] || MISSING="$MISSING scripts/assets/app-icon.icns"
if [ -n "$MISSING" ]; then
  echo "error: prebuilt frontend/icons missing:$MISSING" >&2
  echo "hint: in CI these come from the 'edi-web' artifact that the frontend job" >&2
  echo "      uploads; check that job succeeded and that this job downloads it." >&2
  echo "      locally, produce them once with:" >&2
  echo "        npm ci && npm run build && node scripts/generate-icon.mjs" >&2
  exit 1
fi
echo "using the prebuilt dist/ + generated icons"

# --- Python venv --------------------------------------------------------------
python3 -m venv .venv-macos
PY_VENV="$ROOT/.venv-macos/bin/python"
"$PY_VENV" -m pip install --upgrade pip
"$PY_VENV" -m pip install -r requirements-build.txt

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

# --- File association is part of the bundle ------------------------------------
# edi.spec puts these in Info.plist; fail the build here rather than shipping an
# app Finder will never offer for a .md file. Check the actual handler entries
# (not just the imported UTI, which would still mention the identifier even if
# CFBundleDocumentTypes had been dropped).
print_step "Checking the Markdown document type"
INFO="$APP/Contents/Info.plist"
plutil -lint "$INFO"
MARKDOWN_TYPE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDocumentTypes:0:LSItemContentTypes:0' "$INFO" 2>/dev/null || true)"
PLAIN_TYPE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDocumentTypes:1:LSItemContentTypes:0' "$INFO" 2>/dev/null || true)"
MARKDOWN_UTI="$(/usr/libexec/PlistBuddy -c 'Print :UTImportedTypeDeclarations:0:UTTypeIdentifier' "$INFO" 2>/dev/null || true)"
if [[ "$MARKDOWN_TYPE" != "net.daringfireball.markdown" || \
      "$PLAIN_TYPE" != "public.plain-text" || \
      "$MARKDOWN_UTI" != "net.daringfireball.markdown" ]]; then
  echo "error: Info.plist is missing its document types (edi.spec was not applied?)" >&2
  echo "       CFBundleDocumentTypes: Markdown='$MARKDOWN_TYPE' plain-text='$PLAIN_TYPE'" >&2
  echo "       UTImportedTypeDeclarations: Markdown='$MARKDOWN_UTI'" >&2
  exit 1
fi

# --- Offscreen smoke test ------------------------------------------------------
# Headless QtWebEngine (same flags CI uses for the Linux binary; the app exits
# via os._exit). Read the verdict
# from EDI_SELFTEST_OUT, not stdout: a windowed .app launched by the runner can
# produce no captured stdout at all, while the app has still exited with a
# verdict. The log keeps the bootloader/Chromium diagnostics and is printed on
# failure.
#
# The smoke test runs a throwaway copy, never the bundle that ships: with the
# sandbox disabled QtWebEngine creates an empty
# QtWebEngineCore.framework/Versions/Resources inside the bundle, which breaks
# the `codesign --verify --deep --strict` that install.sh runs.
print_step "Verifying Edi.app via the offscreen smoke test"
SMOKE_DIR="$ROOT/build/smoke-tmp-macos"
SMOKE_LOG="$SMOKE_DIR/selftest.log"
SMOKE_OUT="$SMOKE_DIR/selftest.json"
rm -rf "$SMOKE_DIR"
mkdir -p "$SMOKE_DIR"
ditto "$APP" "$SMOKE_DIR/Edi.app"
# GNU coreutils `timeout` is not on stock macOS, so bound the app ourselves:
# run in the background, poll up to 120s, then kill. The app os._exits after
# writing SELFTEST; its exit code and the verdict file are the gate.
TMPDIR="$SMOKE_DIR" \
QT_QPA_PLATFORM=offscreen \
QTWEBENGINE_DISABLE_SANDBOX=1 \
QTWEBENGINE_CHROMIUM_FLAGS="--disable-dev-shm-usage --disable-gpu" \
EDI_SELFTEST=1 \
EDI_SELFTEST_OUT="$SMOKE_OUT" \
"$SMOKE_DIR/Edi.app/Contents/MacOS/Edi" >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
DEADLINE=$(( $(date +%s) + 120 ))
while kill -0 "$SMOKE_PID" 2>/dev/null && [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 1
done
SMOKE_TIMED_OUT=0
if kill -0 "$SMOKE_PID" 2>/dev/null; then
  SMOKE_TIMED_OUT=1
  kill "$SMOKE_PID" 2>/dev/null || true
fi
# A nonzero `wait` must not trip `set -e`: printing the diagnostics below is
# the point of running the smoke test in the job log.
SMOKE_STATUS=0
wait "$SMOKE_PID" 2>/dev/null || SMOKE_STATUS=$?
if [ -s "$SMOKE_LOG" ]; then
  echo "--- app output ---"
  cat "$SMOKE_LOG"
fi
VERDICT=""
if [ -s "$SMOKE_OUT" ]; then
  VERDICT="$(cat "$SMOKE_OUT")"
  echo "--- selftest verdict ---"
  echo "$VERDICT"
fi
if [ "$SMOKE_TIMED_OUT" -eq 1 ]; then
  echo "error: selftest timed out after 120s" >&2
  exit 124
fi
if [ "$SMOKE_STATUS" -ne 0 ]; then
  echo "error: selftest failed (exit $SMOKE_STATUS)" >&2
  exit "$SMOKE_STATUS"
fi
if [[ "$VERDICT" != SELFTEST\ * ]]; then
  echo "error: selftest produced no verdict (got '${VERDICT:-nothing}')" >&2
  exit 1
fi

# The bundle being packaged must still pass the check install.sh makes.
codesign --verify --deep --strict "$APP"

# --- Drag-to-Applications .dmg ---------------------------------------------------
print_step "Creating the .dmg"
DMG_STAGE="$ROOT/dist-app/dmg"
mkdir -p "$DMG_STAGE"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
DMG="$ROOT/dist-app/Edi-$VERSION-macos-arm64.dmg"
hdiutil create -volname "Edi $VERSION" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG"
rm -rf "$DMG_STAGE"

# --- Curl-installer archive + checksum ------------------------------------------
# `ditto` rather than `zip -r`: it keeps symlinks, permissions and extended
# attributes inside the bundle, and the code signature with them. The install
# script downloads this zip and its .sha256 sidecar from the release.
print_step "Creating the curl-install archive"
ZIP_NAME="Edi-$VERSION-arm64.zip"
ZIP="$ROOT/dist-app/$ZIP_NAME"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
(
  cd "$ROOT/dist-app"
  shasum -a 256 "$ZIP_NAME" > "$ZIP_NAME.sha256"
)
print_step "Done: $DMG"
print_step "Done: $ZIP (+ .sha256)"
