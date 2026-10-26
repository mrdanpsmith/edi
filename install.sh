#!/usr/bin/env bash
# Edi installer / updater for macOS.
#
#   curl -fsSL https://github.com/mrdanpsmith/edi/releases/latest/download/install.sh | bash
#   EDI_VERSION=0.17.0 bash install.sh      # pin a version
#
# Downloads the arm64 app with curl (which does not add the quarantine flag
# browsers add), verifies its SHA-256 and code signature, then replaces the
# installed app in /Applications or ~/Applications. One undoable step per run:
# the old app is put back if the copy fails.
set -euo pipefail

REPO="mrdanpsmith/edi"
APP_NAME="Edi"
BUNDLE_ID="com.mrdanpsmith.edi"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only"
[[ "$(uname -m)" == "arm64" ]] || die "Edi is built for Apple Silicon (arm64) only"

# --- resolve version -------------------------------------------------------
VERSION="${EDI_VERSION:-}"
VERSION="${VERSION#v}"
if [[ -z "$VERSION" ]]; then
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")" \
    || die "could not determine latest version (set EDI_VERSION=x.y.z to pin one)"
  VERSION="$(printf '%s' "$RELEASE_JSON" \
    | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p')"
  [[ -n "$VERSION" ]] || die "could not determine latest version (set EDI_VERSION=x.y.z to pin one)"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid version '$VERSION'"
ASSET="${APP_NAME}-${VERSION}-arm64.zip"
BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"

# --- install location ------------------------------------------------------
# Replace the copy already installed, wherever it is, so a user who installed
# into ~/Applications does not end up with a second Edi in /Applications.
if [[ -d "/Applications/${APP_NAME}.app" ]]; then
  DEST_DIR="/Applications"
elif [[ -d "${HOME}/Applications/${APP_NAME}.app" ]]; then
  DEST_DIR="${HOME}/Applications"
elif [[ -w /Applications ]]; then
  DEST_DIR="/Applications"
else
  DEST_DIR="${HOME}/Applications"
  mkdir -p "$DEST_DIR"
fi
DEST="${DEST_DIR}/${APP_NAME}.app"

INSTALLED="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$DEST/Contents/Info.plist" 2>/dev/null || true)"
if [[ "$INSTALLED" == "$VERSION" && -z "${EDI_FORCE:-}" ]]; then
  log "${APP_NAME} ${VERSION} already installed at ${DEST} (set EDI_FORCE=1 to reinstall)"
  exit 0
fi

# --- download + verify -----------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "Downloading ${APP_NAME} ${VERSION}"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$ASSET" "$BASE_URL/$ASSET"
curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$ASSET.sha256" "$BASE_URL/$ASSET.sha256"

EXPECTED="$(awk 'NF {print $1; exit}' "$TMP/$ASSET.sha256")"
ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
[[ -n "$EXPECTED" && "$EXPECTED" == "$ACTUAL" ]] \
  || die "checksum mismatch (expected ${EXPECTED:-none}, got $ACTUAL)"

# --- unpack + validate -----------------------------------------------------
ditto -x -k "$TMP/$ASSET" "$TMP/unpacked"
NEW_APP="$TMP/unpacked/${APP_NAME}.app"
[[ -d "$NEW_APP" ]] || die "archive does not contain ${APP_NAME}.app"

GOT_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$NEW_APP/Contents/Info.plist")"
[[ "$GOT_ID" == "$BUNDLE_ID" ]] || die "unexpected bundle id: $GOT_ID"
codesign --verify --deep --strict "$NEW_APP" || die "code signature invalid"

# --- quit running instance -------------------------------------------------
if pgrep -xq "$APP_NAME"; then
  log "Quitting running ${APP_NAME}"
  osascript -e "tell application id \"${BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    pgrep -xq "$APP_NAME" || break
    sleep 0.5
  done
  pgrep -xq "$APP_NAME" && die "${APP_NAME} is still running; quit it and re-run"
fi

# --- swap in new version (with rollback) -----------------------------------
BACKUP=""
if [[ -d "$DEST" ]]; then
  BACKUP="$TMP/${APP_NAME}.app.previous"
  mv "$DEST" "$BACKUP"
fi
if ! ditto "$NEW_APP" "$DEST"; then
  rm -rf "$DEST"
  if [[ -n "$BACKUP" ]]; then
    mv "$BACKUP" "$DEST"
  fi
  die "install failed; previous version restored"
fi

# --- post-install ----------------------------------------------------------
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
fi

log "Installed ${APP_NAME} ${VERSION} to ${DEST}"
