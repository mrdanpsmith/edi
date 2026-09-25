#!/usr/bin/env bash
#
# Builds the Windows Edi onefile (dist-app/Edi-<ver>-win64.exe) WITHOUT a
# Windows host: a real Windows Python 3.12 + PyInstaller run under WineHQ-staging
# (Dockerfile.wine). PyInstaller cannot cross-compile; Wine provides the Windows
# runtime that makes edi.spec take its win32 branch (VSVersionInfo, .ico,
# WebEngine companion DLLs, console Selftest twin) on Linux.
#
# It replaces the former hosted-SaaS Windows runner job as the release's
# Windows producer. Validation is STRUCTURAL, not a render: like that runner
# (Server SKU, no dcomp.dll/bthprops.cpl — its frozen smoke was
# SELFTEST_SKIPPED_ENVIRONMENTAL), Wine cannot host QtWebEngine. We prove the
# onefile self-extracts, the PE bundle's DLLs resolve, and Python boots to the
# SELFTEST_BOOTING heartbeat via the console twin. A full page render only
# happens on a real Windows desktop (scripts/build-windows.ps1).
#
# Two modes:
#   * Container (default, local iteration): `docker build` + `docker run`
#     against edi-wine-builder:jammy with the checkout mounted at /builds/edi
#     as the current uid. The image bakes /opt/wheels (win_amd64 wheels) and
#     the Windows Python installer; the wine PREFIX is created at runtime under
#     build/wine-prefix and reused across runs (pin-stamped).
#   * Direct (CI): when `wine`, /opt/wheels and the python installer are already
#     present (i.e. running inside the baked edi-wine-builder image), the
#     docker step is skipped and the steps run against $PWD. The docker
#     executor runs as root, and wine refuses to run as root, so in that case
#     the steps re-exec themselves as an unprivileged `ediwin` user after
#     chowning just build/ + dist-app/.
#
# Prereqs (either mode): dist/index.html + scripts/assets/app-icon.ico must
# exist — `npm run build` and `node scripts/generate-icon.mjs` (in CI they come
# from the `frontend` job). Version defaults to backend/__init__.py.
#
# Usage:  ./scripts/build-windows-wine.sh [VERSION]
# Output: ./dist-app/Edi-<VERSION>-win64.exe   (smoke-classified before success)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${EDI_WINE_IMAGE:-edi-wine-builder:jammy}"

print_step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

# --- Inputs + version --------------------------------------------------------
if [ ! -f dist/index.html ]; then
  echo "error: dist/index.html missing — run 'npm ci && npm run build' first (CI: the frontend job artifact)" >&2
  exit 1
fi
if [ ! -f scripts/assets/app-icon.ico ]; then
  echo "error: scripts/assets/app-icon.ico missing — run 'node scripts/generate-icon.mjs' first (CI: the frontend job artifact)" >&2
  exit 1
fi

VERSION="${1:-$(sed -n 's/^__version__ = "\(.*\)"/\1/p' backend/__init__.py)}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: invalid version '$VERSION' (expected x.y.z)" >&2
  exit 1
fi

# --- Direct mode detection ---------------------------------------------------
# Running inside the baked wine toolchain (CI edi-wine-builder image) skips
# Docker entirely; a plain host has neither wine nor /opt/wheels, so it uses
# the container path.
DIRECT=0
if command -v wine >/dev/null 2>&1 && [ -d /opt/wheels ] && ls /opt/py/python-*-amd64.exe >/dev/null 2>&1 \
    && [ -f /opt/vc/vc_redist.x64.exe ]; then
  DIRECT=1
fi

REQ_HASH="$(md5sum "$ROOT/requirements-win.txt" | cut -d' ' -f1)"

if [ "$DIRECT" = 1 ]; then
  if [ "$(id -u)" -eq 0 ] && [ -t 0 ]; then
    # CI runs as root inside the baked image; STEPS re-execs as `ediwin`
    # (wine refuses root). Only an INTERACTIVE root run is rejected here so the
    # user fixes it themselves instead of the wine aborts wall of text — a
    # non-interactive root (CI) proceeds and drops down below.
    echo "error: wine refuses to run as root — run this script as a normal user" >&2
    exit 1
  fi
else
  if ! command -v docker >/dev/null 2>&1; then
    echo "error: docker is required for the container mode (local iteration)" >&2
    exit 1
  fi
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    print_step "Building $IMAGE from Dockerfile.wine (large first time)"
    docker build --build-arg REQ_HASH="$REQ_HASH" -f Dockerfile.wine -t "$IMAGE" "$ROOT"
  fi
  # Stale-image guard (same pattern as simulate-ci-test.sh): a image built
  # before a wheel/installer was baked fails later with a cryptic error, so
  # probe the baked contents and rebuild on demand — the Docker cache makes it
  # a no-op unless Dockerfile.wine or requirements-win.txt (via REQ_HASH)
  # actually changed.
  if ! docker run --rm "$IMAGE" bash -euc '
        [ -d /opt/wheels ] && ls /opt/wheels/*.whl >/dev/null 2>&1 \
            && [ -f /opt/py/python-*-amd64.exe ] \
            && [ -f /opt/vc/vc_redist.x64.exe ] \
            && command -v wine >/dev/null 2>&1 \
            && command -v xvfb-run >/dev/null 2>&1 \
            && find /opt/wine-* -iname "icuuc.dll" | head -n1 | grep -q .'; then
    print_step "Stale $IMAGE (missing a baked tool); rebuilding from Dockerfile.wine"
    docker build --build-arg REQ_HASH="$REQ_HASH" -f Dockerfile.wine -t "$IMAGE" "$ROOT"
  fi
fi

# --- The build, as run inside the wine toolchain ----------------------------
# Container mode: STEPS runs with B=/builds/edi (the mounted checkout).
# Direct mode: STEPS runs with B=$PWD (the checkout, as $EDD_BUILD_ROOT) and
# drops to the `ediwin` user if we started as root.
STEPS=$(cat <<'EDI_STEPS'
set -euo pipefail
trap 'wineserver -k >/dev/null 2>&1 || true' EXIT

B="${EDI_BUILD_ROOT:-/builds/edi}"
VERSION="${EDI_VERSION:?EDI_VERSION not set}"
cd "$B"

PREFIX="$B/build/wine-prefix"
WINEHOME="$B/build/wine-home"
STAMP="$PREFIX/.edi-stamp"
WINEPY="$PREFIX/drive_c/Python312/python.exe"
PY_INSTALLER="$(ls /opt/py/python-*-amd64.exe 2>/dev/null | head -n1 || true)"
VC_REDIST="$(ls /opt/vc/vc_redist.x64.exe 2>/dev/null | head -n1 || true)"

export WINEPREFIX="$PREFIX"
export HOME="$WINEHOME"
export WINEDEBUG=-all
export WINEDLLOVERRIDES='mscoree,mshtml='

if [ -z "$PY_INSTALLER" ] || [ -z "$VC_REDIST" ] || [ ! -d /opt/wheels ] || ! command -v wine >/dev/null 2>&1; then
  echo "error: wine toolchain missing — build/run via Dockerfile.wine (bakes wine, /opt/wheels, /opt/py)" >&2
  exit 1
fi
[ -f "$B/requirements-win.txt" ] || { echo "error: requirements-win.txt missing" >&2; exit 1; }

# Wine refuses to run as root (CI container jobs do), so re-exec the
# whole script as an unprivileged user after making the dirs we write (build/,
# dist-app/) available to it. EDI_DROPPED prevents a loop.
if [ "$(id -u)" -eq 0 ] && [ "${EDI_DROPPED:-0}" != 1 ]; then
  echo "[wine] running as root; dropping to unprivileged 'ediwin' (wine refuses root)"
  getent passwd ediwin >/dev/null 2>&1 || useradd -m -s /bin/bash ediwin
  mkdir -p "$B/build" "$B/dist-app" "$B/build/ediwin-home"
  chown -R ediwin:ediwin "$B/build" "$B/dist-app"
  runuser -u ediwin -- env \
    HOME="$B/build/ediwin-home" \
    EDI_BUILD_ROOT="$B" EDI_VERSION="$VERSION" EDI_DROPPED=1 \
    bash -euc "$STEPS"
  rc=$?
  # Root can read ediwin-owned files, so artifact upload (runner-as-root) is fine.
  exit $rc
fi

stamp_value() {
  printf '%s\n%s\n%s\n%s\n' \
    "$(wine --version 2>/dev/null | tr -d '\r')" \
    "$(md5sum "$B/requirements-win.txt" | cut -d' ' -f1)" \
    "$(basename "$PY_INSTALLER")" \
    "$(basename "$VC_REDIST")"
}

# --- 1. Wine prefix, pin-stamped (wine + python installer + wheel pins) ------
# Kept under build/ so the checkout stays clean and a rerun in the same
# checkout reuses the installed runtime (~2 min instead of ~20 on a tag).
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$(stamp_value)" ]; then
  echo "[wine] initializing fresh prefix (stamp missing or outdated)"
  rm -rf "$PREFIX" "$WINEHOME"
  mkdir -p "$PREFIX" "$WINEHOME"
  # The Python installer is a GUI bootstrapper: without an X display it is
  # killed immediately (wine reports 128+SIGINT), so wineboot and the install
  # run under xvfb-run. pip/pyinstaller are console apps and stay headless.
  xvfb-run -a timeout 300 wineboot -u
  # VC++ 2015-2022 redistributable: makes msvcp140.dll etc. land in the
  # prefix's System32. Without it `import PySide6.QtCore` fails under wine, the
  # PyInstaller Qt hooks come back empty, and the bundle ships NO platform
  # plugins (Qt then dies with "no Qt platform plugin could be initialized").
  # The bootstrapper is also GUI — xvfb. Exit codes vary (0 / 3010 reboot /
  # 1638 already installed), so verify by the DLL actually landing instead.
  xvfb-run -a timeout 600 wine "$VC_REDIST" /install /quiet /norestart >/dev/null 2>&1 || true
  if [ ! -f "$PREFIX/drive_c/windows/system32/msvcp140.dll" ]; then
    echo "error: VC++ redistributable did not install (msvcp140.dll missing from prefix System32)" >&2
    exit 1
  fi
  echo "[wine] installing Windows Python ($(basename "$PY_INSTALLER"))"
  xvfb-run -a timeout 600 wine "$PY_INSTALLER" /quiet InstallAllUsers=0 PrependPath=0 Shortcuts=0 \
      Include_test=0 Include_launcher=0 Include_doc=0 Include_tcltk=0 Include_pip=1 \
      TargetDir='C:\\Python312'
  echo "[wine] pip install (offline wheels from /opt/wheels)"
  timeout 900 wine "$WINEPY" -m pip install --no-index --find-links /opt/wheels -r "$B/requirements-win.txt"
  # Qt6Core.dll hard-imports icuuc.dll (Windows' system ICU; present in every
  # real System32 >= 1703, but Wine only bundles it as of v11.5). Wine's own
  # copy sits in the container's winelib dir — copy it next to Qt6Core.dll so
  # (a) PyInstaller's Qt metadata probe (`import PySide6.QtCore`) succeeds and
  # the plugins get collected, and (b) the analysis resolves it from an app
  # path, so it lands IN the bundle — the exe then runs even on Server/no-ICU
  # Windows. icu.dll is the 1903+ combined lib; icuuc/icuin the 1703+ pair.
  WINE_ICU_DIR="$(dirname "$(find /opt/wine-* -iname 'icuuc.dll' | head -n1)" 2>/dev/null || true)"
  PYSIDE_DIR="$PREFIX/drive_c/Python312/Lib/site-packages/PySide6"
  ICU_SET=""
  mkdir -p "$PYSIDE_DIR"
  for dll in icu.dll icuuc.dll icuin.dll; do
    if [ -f "$WINE_ICU_DIR/$dll" ]; then
      cp -f "$WINE_ICU_DIR/$dll" "$PYSIDE_DIR/"
      ICU_SET="$ICU_SET $dll"
    fi
  done
  if [ -z "$ICU_SET" ]; then
    echo "error: wine bundles no ICU (need winehq-staging, i.e. the >= 11.5 devline); the Qt hooks would emit a pluginless bundle" >&2
    exit 1
  fi
  echo "[wine] bundled wine ICU into PySide6 dir:${ICU_SET}"
  stamp_value > "$STAMP"
else
  echo "[wine] reusing prefix $PREFIX (stamp OK)"
fi

# --- 2. Host capability probe (mirrors build-windows.ps1) -------------------
# If Wine cannot even import QtWebEngineCore, no bundle could ever render here:
# an environment limitation (like the Server-SKU runners), so skip the frozen
# smoke and report the structural outcome only.
echo "[wine] host capability probe (QtWebEngineCore import)"
PROBE_LOG="$B/build/probe-wine.out"
PROBE_OK=0
if timeout 240 wine "$WINEPY" -c "from PySide6.QtWebEngineCore import QWebEngineSettings; print('WEBENGINE_HOST_OK')" > "$PROBE_LOG" 2>&1 \
   && grep -q WEBENGINE_HOST_OK "$PROBE_LOG"; then
  PROBE_OK=1
  echo "[wine] probe OK: this Wine can import QtWebEngineCore"
else
  echo "[wine] probe FAILED: Wine cannot import QtWebEngineCore (environmental — same class as the Server-SKU runners)"
  sed 's/^/  probe: /' "$PROBE_LOG" || true
fi

# --- 3. PyInstaller onefile (edi.spec win32 branch under wine) --------------
echo "[wine] PyInstaller onefile"
PYINSTALLER_ZLIB_COMPRESSION_LEVEL=1 timeout 1800 wine "$WINEPY" -m PyInstaller \
    --clean --distpath dist-app --workpath build/win edi.spec
[ -f dist-app/Edi.exe ] || { echo "error: dist-app/Edi.exe not produced" >&2; exit 1; }
[ -f dist-app/Edi-selftest.exe ] || { echo "error: dist-app/Edi-selftest.exe not produced" >&2; exit 1; }

# --- 4a. Bundle-content structural check -------------------------------------
# The bundle listing is the load-bearing regression gate: a pluginless bundle
# (the pre-ICU-wrap defect) dies here even though the probe above may pass.
# CArchiveReader is pure stdlib + PyInstaller, so it runs on the .exe file
# itself — no wine render needed.
echo "[wine] verifying bundle contents (Qt plugins + ICU in the CArchive)"
cat > "$B/build/list_archive.py" <<'PYEOF'
import sys
from PyInstaller.archive.readers import CArchiveReader

c = CArchiveReader(sys.argv[1])
names = {n.lower().replace('\\', '/') for n in c.toc}
need = [
    'pyside6/plugins/platforms/qwindows.dll',
    'pyside6/plugins/platforms/qoffscreen.dll',
    'pyside6/plugins/imageformats/qjpeg.dll',
    'pyside6/icuuc.dll',
    'pyside6/icuin.dll',
]
missing = [w for w in need if w not in names]
if missing:
    print('BUNDLE_MISSING total=%d missing=%r' % (len(names), missing))
    sys.exit(1)
print('BUNDLE_OK total=%d (platform plugins, imageformats, ICU all present)' % len(names))
PYEOF
timeout 300 wine "$WINEPY" "Z:$B/build/list_archive.py" "Z:$B/dist-app/Edi.exe" \
  > "$B/build/archive-wine.out" 2>&1
if grep -q 'BUNDLE_OK' "$B/build/archive-wine.out"; then
  echo "[wine] bundle structural check OK"
  ARCHIVE_OK=1
else
  echo "error: bundle is missing Qt plugins / ICU (Qt hooks did not collect them):" >&2
  cat "$B/build/archive-wine.out" 2>/dev/null || true
  exit 1
fi

# --- 4b. Frozen smoke via the console twin (STRUCTURAL under Wine) -----------
# Wine can boot the onefile (extraction + Python + Qt init) but QtWebEngine's
# Chromium cannot render under Wine (proven: FATAL in WSALookupServiceBegin /
# hwnd_util during WebEngine init, after which wine pops an invisible winedbg
# dialog and the process would otherwise hang to the budget). So the frozen
# smoke is bounded and stops early on those crash markers; a Chromium-init
# crash is classified SELFTEST_SKIPPED_ENVIRONMENTAL (4a already proved the
# bundle), while extraction/DLL-load failures are hard faults.
if [ "$PROBE_OK" = 1 ] && [ "$ARCHIVE_OK" = 1 ]; then
  echo "[wine] smoke test (console twin, offscreen)"
  SMOKE_FILE="$B/build/selftest-wine.txt"
  SMOKE_OUT_Z="Z:${SMOKE_FILE}"
  BUDGET_MIN="${EDI_SMOKE_BUDGET_MIN:-20}"
  [[ "$BUDGET_MIN" =~ ^[0-9]+$ ]] || BUDGET_MIN=20
  VERDICT=""
  SMOKE_LOG="$B/build/selftest-boot-wine.out"
  SMOKE_RC=0

  rm -f "$SMOKE_FILE" "$SMOKE_LOG"
  setsid env \
    EDI_SELFTEST=1 \
    EDI_SELFTEST_OUT="$SMOKE_OUT_Z" \
    QT_QPA_PLATFORM=offscreen \
    QTWEBENGINE_DISABLE_SANDBOX=1 \
    QTWEBENGINE_CHROMIUM_FLAGS='--disable-dev-shm-usage --disable-gpu' \
    timeout 1800 xvfb-run -a wine "$B/dist-app/Edi-selftest.exe" \
    > "$SMOKE_LOG" 2>&1 &
  SMOKE_PID=$!
  SMOKE_DEADLINE=$(( $(date +%s) + BUDGET_MIN * 60 ))
  while kill -0 "$SMOKE_PID" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$SMOKE_DEADLINE" ]; then break; fi
    if [ -f "$SMOKE_FILE" ]; then
      VERDICT="$(tr -d '\r\n' < "$SMOKE_FILE")"
      [ -n "$VERDICT" ] && [ "$VERDICT" != SELFTEST_BOOTING ] && break
    fi
    if grep -Eiq 'WSALookupServiceBegin|hwnd_util\.cc|Unhandled exception|starting debugger|0x80000003' "$SMOKE_LOG" 2>/dev/null; then
      break
    fi
    sleep 3
  done
  if kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill -- -"$SMOKE_PID" 2>/dev/null || kill "$SMOKE_PID" 2>/dev/null || true
    sleep 2
    kill -9 -- -"$SMOKE_PID" 2>/dev/null || true
  fi
  wait "$SMOKE_PID" 2>/dev/null || SMOKE_RC=$?
  if [ -z "$VERDICT" ] && [ -f "$SMOKE_FILE" ]; then
    VERDICT="$(tr -d '\r\n' < "$SMOKE_FILE")"
  fi

  if [ -n "$VERDICT" ]; then
    case "$VERDICT" in
      'SELFTEST {'*)
        case "$VERDICT" in
          *'"editor"'* | *'"icon"'*)
            echo "[wine] FULL PASS: console twin rendered and reported probes"
            ;;
          *)
            echo "error: selftest JSON missing probes: $VERDICT" >&2
            exit 1
            ;;
        esac
        ;;
      SELFTEST_TIMEOUT*)
        echo "warn: SELFTEST_TIMEOUT — wine booted the app but QtWebEngine never rendered; structural pass only" >&2
        ;;
      SELFTEST_BOOTING)
        echo "warn: exited at SELFTEST_BOOTING (Python booted, renderer init never completed under Wine); structural pass only" >&2
        ;;
      *)
        echo "error: unexpected selftest state: '$VERDICT'" >&2
        exit 1
        ;;
    esac
  else
    echo "--- bootloader log ---"
    cat "$SMOKE_LOG" 2>/dev/null || true
    if grep -Eiq 'Error extracting|Failed to extract|DLL load failed|ImportError|No module named' "$SMOKE_LOG"; then
      echo "error: frozen smoke shows a packaging/DLL defect (see bootloader log above)" >&2
      exit 1
    elif grep -Eiq 'WSALookupServiceBegin|hwnd_util\.cc|Unhandled exception|starting debugger|0x80000003' "$SMOKE_LOG"; then
      echo "warn: Wine cannot render QtWebEngine (proven environmental Chromium-init crash); structural validation passed -> SELFTEST_SKIPPED_ENVIRONMENTAL" >&2
    else
      echo "error: smoke produced no verdict and no identifying log markers" >&2
      exit 1
    fi
  fi
else
  echo "warn: probe/bundle gate not passed, so the frozen smoke was SKIPPED (environmental — wine cannot render WebEngine)" >&2
fi

# --- 5. Versioned artifact ---------------------------------------------------
echo "[wine] wrapping artifacts"
rm -f dist-app/Edi-selftest.exe
mv dist-app/Edi.exe "dist-app/Edi-$VERSION-win64.exe"
echo "[wine] DONE: dist-app/Edi-$VERSION-win64.exe"

# --- 6. NSIS installer (native makensis, baked into the image) ---------------
# edi.nsi is platform-neutral (relative dist-app\ paths, /DVERSION /DSETUPEXE
# defines), so the Linux NSIS compiles byte-identically to a desktop Windows
# build — no Wine needed for this step. Output: dist-app/Edi-<v>-win64-setup.exe
echo "[wine] NSIS installer"
if command -v makensis >/dev/null 2>&1; then
  # edi.nsi resolves relative File/OutFile paths against the SCRIPT's dir, so
  # every define is passed ABSOLUTE ($B/dist-app/...); OUTEXE overrides the
  # default relative OutFile. Linux makensis uses -D defines, not /D.
  makensis -V2 \
    "-DVERSION=$VERSION" \
    "-DSETUPEXE=$B/dist-app/Edi-$VERSION-win64.exe" \
    "-DICO=$B/scripts/assets/app-icon.ico" \
    "-DOUTEXE=$B/dist-app/Edi-$VERSION-win64-setup.exe" \
    packaging/edi.nsi
  [ -f "dist-app/Edi-$VERSION-win64-setup.exe" ] || { echo "error: installer not produced" >&2; exit 1; }
  echo "[wine] DONE: dist-app/Edi-$VERSION-win64-setup.exe"
else
  echo "error: makensis not found in the image (run 'apt-get install nsis')" >&2
  exit 1
fi
EDI_STEPS
)
# The STEPS body references $STEPS to re-exec itself under `ediwin` (wine
# refuses root, and CI runs as root), so it must reach the subprocess.
export STEPS

# --- Invocation ---------------------------------------------------------------
if [ "$DIRECT" = 1 ]; then
  print_step "Running Wine build directly in the baked toolchain (wine + /opt/wheels present)"
  EDI_BUILD_ROOT="$ROOT" EDI_VERSION="$VERSION" bash -euc "$STEPS"
else
  print_step "Running Wine build in $IMAGE (checkout mounted at /builds/edi)"
  docker run --rm \
    -v "$ROOT:/builds/edi:rw" \
    -w /builds/edi \
    -u "$(id -u):$(id -g)" \
    -e "EDI_VERSION=$VERSION" \
    "$IMAGE" bash -euc "$STEPS"
fi

print_step "Done: dist-app/Edi-$VERSION-win64.exe"