#!/usr/bin/env bash
# Edi installer / updater for macOS.
#
#   curl -fsSL https://github.com/mrdanpsmith/edi/releases/latest/download/install.sh | bash
#   EDI_VERSION=0.17.0 bash install.sh      # pin a version
#
# Downloads the arm64 app with curl (which does not add the quarantine flag
# browsers add), verifies its SHA-256 and code signature, then replaces the
# installed app in /Applications or ~/Applications. One undoable step per run:
# the old app is put back if the copy fails. Making Edi the default Markdown
# editor is asked about, never assumed (EDI_SET_DEFAULT=1/0 answers for a
# non-interactive run).
set -euo pipefail

REPO="mrdanpsmith/edi"
APP_NAME="Edi"
BUNDLE_ID="com.mrdanpsmith.edi"
MARKDOWN_UTI="net.daringfireball.markdown"
PLAIN_TEXT_UTI="public.plain-text"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

# --- Launch Services -------------------------------------------------------
# osascript's JavaScript bridge reaches the same API Finder uses, without
# needing duti or a compiler. A literal "-" means "no handler", so an empty
# answer is distinguishable from a query that failed.
handler_for() {
  osascript -l JavaScript - "$1" 2>/dev/null <<'JXA' || true
ObjC.import("CoreServices");
function run(argv) {
  var handler = $.LSCopyDefaultRoleHandlerForContentType($(argv[0]), $.kLSRolesAll);
  return handler ? ObjC.unwrap(ObjC.castRefToObject(handler)) : "-";
}
JXA
}

set_handler_for() {
  local uti="$1" bundle="$2"
  osascript -l JavaScript - "$uti" "$bundle" >/dev/null 2>&1 <<'JXA' || true
ObjC.import("CoreServices");
function run(argv) {
  return $.LSSetDefaultRoleHandlerForContentType($(argv[0]), $.kLSRolesAll, $(argv[1]));
}
JXA
  [[ "$(handler_for "$uti")" == "$bundle" ]]
}

# Ask on the terminal, not stdin: with `curl ... | bash` stdin is the script.
ask_default_app() {
  local reply=""
  if ! { printf 'Make %s the default app for Markdown files? [y/N] ' "$APP_NAME" >/dev/tty; } 2>/dev/null; then
    return 1
  fi
  if ! IFS= read -r reply < /dev/tty 2>/dev/null; then
    reply=""
  fi
  [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}

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

# --- default Markdown app --------------------------------------------------
# Registering the bundle imports Edi's Markdown type, and on a Mac where
# nothing else owns it that can make Edi the handler. Which editor opens a
# file is the user's choice, so ask before changing it -- and when the answer
# is no (or there is no terminal to ask), put back whatever was the handler
# before Edi arrived. With no Markdown handler at all, .md files fall back to
# the plain-text handler (TextEdit on a stock Mac), which is what they opened
# with before. This is read before the swap so the reading is pre-Edi.
PREVIOUS_HANDLER="$(handler_for "$MARKDOWN_UTI")"
RESTORE_HANDLER="$PREVIOUS_HANDLER"
if [[ "$RESTORE_HANDLER" == "-" ]]; then
  RESTORE_HANDLER="$(handler_for "$PLAIN_TEXT_UTI")"
  [[ "$RESTORE_HANDLER" == "-" ]] && RESTORE_HANDLER=""
fi

WANT_DEFAULT=0
if [[ "$PREVIOUS_HANDLER" == "$BUNDLE_ID" ]]; then
  WANT_DEFAULT=1
else
  case "${EDI_SET_DEFAULT:-}" in
    1|yes|true) WANT_DEFAULT=1 ;;
    0|no|false) WANT_DEFAULT=0 ;;
    "")
      if ask_default_app; then
        WANT_DEFAULT=1
      fi
      ;;
    *) die "invalid EDI_SET_DEFAULT '${EDI_SET_DEFAULT}' (use 1 or 0)" ;;
  esac
fi

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

if [[ "$WANT_DEFAULT" == "1" ]]; then
  if set_handler_for "$MARKDOWN_UTI" "$BUNDLE_ID"; then
    log "${APP_NAME} is the default app for Markdown files"
  else
    log "warning: could not set ${APP_NAME} as the default Markdown app"
  fi
elif [[ -n "$RESTORE_HANDLER" && "$RESTORE_HANDLER" != "$BUNDLE_ID" ]]; then
  if set_handler_for "$MARKDOWN_UTI" "$RESTORE_HANDLER"; then
    log "Markdown files keep opening with ${RESTORE_HANDLER}"
  else
    log "warning: could not restore the previous Markdown handler (${RESTORE_HANDLER})"
  fi
elif [[ -z "$PREVIOUS_HANDLER" ]]; then
  log "warning: could not determine the previous Markdown handler"
fi

log "Installed ${APP_NAME} ${VERSION} to ${DEST}"
