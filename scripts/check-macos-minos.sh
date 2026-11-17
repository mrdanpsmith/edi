#!/usr/bin/env bash
#
# Fails when any Mach-O binary in a macOS .app needs a newer macOS than the
# bundle's Info.plist declares (LSMinimumSystemVersion).
#
#   ./scripts/check-macos-minos.sh dist-app/Edi.app
#
# The declared minimum is what macOS checks before launching the app; each
# binary's own minimum (its LC_BUILD_VERSION `minos`) is what it actually needs.
# A binary built for a newer macOS than declared is an app that opens on an
# older Mac and then fails. The usual cause is a library compiled for the macOS
# it was built on, such as a Homebrew Python on the build machine, so this is
# run on every build (`build-macos.sh`) instead of trusted.
set -euo pipefail

APP="${1:?usage: $0 path/to/App.app}"
INFO="$APP/Contents/Info.plist"
DECLARED="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$INFO")"

# `x.y[.z]` as one comparable number.
version_key() {
  local IFS=.
  # shellcheck disable=SC2206
  local parts=($1)
  echo $(( ${parts[0]:-0} * 10000 + ${parts[1]:-0} * 100 + ${parts[2]:-0} ))
}

declared_key="$(version_key "$DECLARED")"
too_new=""
checked=0
while IFS= read -r -d '' file; do
  # Not every executable-bit file is Mach-O (scripts, data); vtool refuses those.
  minos="$(vtool -show-build "$file" 2>/dev/null | awk '$1 == "minos" { print $2 }' | sort -V | tail -1)"
  [ -n "$minos" ] || continue
  checked=$((checked + 1))
  if [ "$(version_key "$minos")" -gt "$declared_key" ]; then
    too_new+="  needs macOS $minos: ${file#"$APP"/}"$'\n'
  fi
done < <(find "$APP" -type f \( -name '*.dylib' -o -name '*.so' -o -perm -u+x \) -print0)

if [ "$checked" -eq 0 ]; then
  echo "error: no Mach-O binaries found in $APP" >&2
  exit 1
fi
if [ -n "$too_new" ]; then
  echo "error: $APP declares macOS $DECLARED (LSMinimumSystemVersion) but contains binaries that need newer:" >&2
  printf '%s' "$too_new" | sort -V >&2
  echo "       Build with a Python made for older macOS (actions/setup-python, or the python.org installer)," >&2
  echo "       not one compiled for this machine (Homebrew), or raise LSMinimumSystemVersion in edi.spec." >&2
  exit 1
fi
echo "ok: $checked binaries, none needs newer than macOS $DECLARED"
