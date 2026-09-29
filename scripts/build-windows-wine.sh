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
            && command -v makensis >/dev/null 2>&1 \
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

# --- One clock for the whole run ---------------------------------------------
# Every stage below announces when it STARTS and how far into the run it is.
# That is not decoration: wineboot and the VC++ redistributable were the only
# stages that produced no output at all, and they are also the two a slow run
# wedges in, so a 20-minute job was indistinguishable from a hung one and its
# time could not be attributed to anything. $SECONDS is a bash builtin and
# STEPS always runs under bash.
RUN_T0=$SECONDS
elapsed() { printf '+%dm%02ds' "$(( (SECONDS - RUN_T0) / 60 ))" "$(( (SECONDS - RUN_T0) % 60 ))"; }
stage() { printf '[wine] %s %s\n' "$(elapsed)" "$*"; }

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

# A GUI bootstrapper on a 2-vCPU shared runner is a different animal from one
# on a big box; without this line a slow run cannot be told from a slow runner.
stage "runner: $(nproc) cpu, $(awk '/MemTotal:/ { printf "%.1f GiB", $2 / 1048576 }' /proc/meminfo), prefix $([ -d "$PREFIX" ] && echo present || echo absent)"

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

# "Reuse" means the stamp AND the three files every later stage assumes. The
# stamp alone stopped being enough once CI began restoring this prefix from a
# cache: a partial restore can leave .edi-stamp with none of the payload it
# describes, and that surfaces much later as an inscrutable error inside
# PyInstaller. Anything short of all four is a cold prefix, not a failure.
PREFIX_SENTINELS="drive_c/windows/system32/msvcp140.dll
drive_c/Python312/python.exe
drive_c/Python312/Lib/site-packages/PySide6/QtWebEngineCore.pyd"

prefix_reusable() {
  [ -f "$STAMP" ] || return 1
  [ "$(cat "$STAMP" 2>/dev/null || true)" = "$(stamp_value)" ] || return 1
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -e "$PREFIX/$f" ] || { echo "  prefix: stamp matches but $f is missing (corrupt restore?)" >&2; return 1; }
  done <<< "$PREFIX_SENTINELS"
  return 0
}

# --- 1. Wine prefix, pin-stamped (wine + python installer + wheel pins) ------
# Kept under build/ so the checkout stays clean and a rerun in the same
# checkout reuses the installed runtime (~2 min instead of ~20 on a tag).

# A GUI bootstrapper under a synthetic display is the one genuinely flaky step
# in here: wine's own allocator has been observed aborting mid-install
# ("free(): corrupted unsorted chunks"), which wedges the installer until the
# budget reaps it — and because `timeout` used to wrap the *wine* process
# rather than the xvfb-run group, the kill left xvfb-run reaping a dead
# display, so the only thing the log ever showed was the display dying
# ("X connection to :99 broken") and a bare 124 with no stage named. `timeout`
# now wraps the whole group (so the exit code belongs to the step and
# xvfb-run tears its own display down), and a stage that still fails is retried
# once from a clean wineserver. On a healthy run every command is invoked
# exactly as before and returns 0, so this is a no-op on the happy path.
gui() {
  local budget=$1 rc=0 attempt
  shift
  for attempt in 1 2; do
    if timeout "$budget" xvfb-run -a "$@"; then
      return 0
    else
      rc=$?
    fi
    wineserver -k >/dev/null 2>&1 || true
    if [ "$attempt" -eq 1 ]; then
      echo "[wine] '$1' exited $rc — killing wineserver and retrying once" >&2
      sleep 5
    fi
  done
  return "$rc"
}

if ! prefix_reusable; then
  stage "cold prefix: building the Wine runtime from scratch (stamp missing, outdated, or incomplete)"
  rm -rf "$PREFIX" "$WINEHOME"
  mkdir -p "$PREFIX" "$WINEHOME"
  # The Python installer is a GUI bootstrapper: without an X display it is
  # killed immediately (wine reports 128+SIGINT), so wineboot and the install
  # run under xvfb-run. pip/pyinstaller are console apps and stay headless.
  stage "wineboot -u (budget 300s)"
  gui 300 wineboot -u
  # VC++ 2015-2022 redistributable: makes msvcp140.dll etc. land in the
  # prefix's System32. Without it `import PySide6.QtCore` fails under wine, the
  # PyInstaller Qt hooks come back empty, and the bundle ships NO platform
  # plugins (Qt then dies with "no Qt platform plugin could be initialized").
  # The bootstrapper is also GUI — xvfb. Exit codes vary (0 / 3010 reboot /
  # 1638 already installed), so verify by the DLL actually landing instead;
  # which is also why this one is not retried (every retry burns its whole
  # budget on a "already installed" exit code).
  # Its exit code is not the test (0 / 3010 / 1638 all occur), so the DLL is.
  # But the stage is not silent either: this was the one step that could spend
  # its whole 600s budget with nothing in the log, which is exactly where a slow
  # run's minutes went unaccounted for. Capture it, and surface it only if the
  # DLL check is what actually failed.
  stage "VC++ 2015-2022 redistributable (budget 600s)"
  REDIST_LOG="$B/build/redist-wine.out"
  REDIST_RC=0
  timeout 600 xvfb-run -a wine "$VC_REDIST" /install /quiet /norestart > "$REDIST_LOG" 2>&1 || REDIST_RC=$?
  if [ ! -f "$PREFIX/drive_c/windows/system32/msvcp140.dll" ]; then
    echo "error: VC++ redistributable did not install (msvcp140.dll missing from prefix System32, exit $REDIST_RC)" >&2
    sed 's/^/  redist: /' "$REDIST_LOG" 2>/dev/null || true
    exit 1
  fi
  stage "VC++ redistributable ok (exit $REDIST_RC, msvcp140.dll present)"
  stage "installing Windows Python $(basename "$PY_INSTALLER") (budget 600s, retried once)"
  gui 600 wine "$PY_INSTALLER" /quiet InstallAllUsers=0 PrependPath=0 Shortcuts=0 \
      Include_test=0 Include_launcher=0 Include_doc=0 Include_tcltk=0 Include_pip=1 \
      TargetDir='C:\\Python312'
  stage "pip install (offline wheels from /opt/wheels, budget 900s)"
  timeout 900 wine "$WINEPY" -m pip install --no-index --find-links /opt/wheels -r "$B/requirements-win.txt"
  # Qt6Core.dll hard-imports icuuc.dll (Windows' system ICU; present in every
  # real System32 >= 1703, but Wine only bundles it as of v11.5). Wine's own
  # copy sits in the container's winelib dir — copy it next to Qt6Core.dll so
  # (a) PyInstaller's Qt metadata probe (`import PySide6.QtCore`) succeeds and
  # the plugins get collected, and (b) the analysis resolves it from an app
  # path, so it lands IN the bundle — the exe then runs even on Server/no-ICU
  # Windows. icu.dll is the 1903+ combined lib; icuuc/icuin the 1703+ pair.
  stage "staging wine's ICU next to Qt6Core.dll (so the PyInstaller Qt hooks can collect plugins)"
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
  stage "reusing prefix $PREFIX (stamp + sentinels OK: wineboot, redist, Python, pip and ICU staging all skipped)"
fi

# --- 2. Host capability probe (mirrors build-windows.ps1) -------------------
# If Wine cannot even import QtWebEngineCore, no bundle could ever render here:
# an environment limitation (like the Server-SKU runners), so skip the frozen
# smoke and report the structural outcome only.
stage "host capability probe: can this Wine import QtWebEngineCore? (budget 240s)"
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
# PyInstaller sends its progress to stdout, and under Wine the expensive part
# of that run is a filesystem walk of the whole PySide6 tree (PySide6 +
# Essentials + Addons + shiboken6, ~1.5 GB / tens of thousands of files) via
# Wine's NT path layer on the Z: drive. That walk is silent, so when it wedges
# the log just stops mid-hook and a timeout reports a bare 124 with no way to
# tell "slow" from "dead". Hence the tee: it names the exact hook it died in,
# and the wchan/STAT snapshot distinguishes a thread blocked in the kernel
# (disk thrash) from one spinning on CPU (a Wine deadlock) — the two causes
# that look identical from the outside and need opposite fixes.
stage "PyInstaller onefile (budget 1800s)"
PYINSTALLER_LOG="$B/build/pyinstaller-wine.out"
if ! PYINSTALLER_ZLIB_COMPRESSION_LEVEL=1 timeout 1800 wine "$WINEPY" -m PyInstaller \
        --clean --distpath dist-app --workpath build/win edi.spec 2>&1 | tee "$PYINSTALLER_LOG"; then
  echo "error: PyInstaller did not complete — last 30 lines it produced:" >&2
  tail -n 30 "$PYINSTALLER_LOG" | sed 's/^/  pyinstaller: /' >&2 || true
  echo "  processes at the moment of the timeout (STAT S = blocked, R = spinning):" >&2
  ps -eo pid,etimes,stat,wchan:24,comm 2>/dev/null | grep -Ei 'PID|wineserver|wine|python' | sed 's/^/  ps: /' >&2 || true
  exit 1
fi
[ -f dist-app/Edi.exe ] || { echo "error: dist-app/Edi.exe not produced" >&2; exit 1; }
[ -f dist-app/Edi-selftest.exe ] || { echo "error: dist-app/Edi-selftest.exe not produced" >&2; exit 1; }

# --- 4a. Bundle-content structural check -------------------------------------
# The bundle listing is the load-bearing regression gate: a pluginless bundle
# (the pre-ICU-wrap defect) dies here even though the probe above may pass.
# CArchiveReader is pure stdlib + PyInstaller, so it runs on the .exe file
# itself — no wine render needed.
stage "verifying bundle contents (Qt plugins + ICU in the CArchive, budget 300s)"
# The check itself lives in scripts/check_bundle_contents.py, shared verbatim
# with the native build-windows job: it is the gate that still proves the
# bundle when the frozen smoke is skipped as environmental, so two copies of
# the required-entry list would be two chances to let the pluginless-bundle
# defect through. CArchiveReader is pure stdlib + PyInstaller, so it reads the
# .exe under Wine exactly as it does on real Windows.
timeout 300 wine "$WINEPY" "Z:$B/scripts/check_bundle_contents.py" "Z:$B/dist-app/Edi.exe" \
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
  stage "frozen smoke (console twin, offscreen)"
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
stage "wrapping artifacts"
rm -f dist-app/Edi-selftest.exe
mv dist-app/Edi.exe "dist-app/Edi-$VERSION-win64.exe"
printf '[wine] DONE (%s): dist-app/Edi-%s-win64.exe\n' "$(elapsed)" "$VERSION"

# --- 6. NSIS installer (native makensis, baked into the image) ---------------
# edi.nsi is platform-neutral (relative dist-app\ paths, /DVERSION /DSETUPEXE
# defines), so the Linux NSIS compiles byte-identically to a desktop Windows
# build — no Wine needed for this step. Output: dist-app/Edi-<v>-win64-setup.exe
stage "NSIS installer (native makensis, no wine)"
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
  printf '[wine] DONE (%s): dist-app/Edi-%s-win64-setup.exe\n' "$(elapsed)" "$VERSION"
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