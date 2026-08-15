#!/usr/bin/env bash
#
# Builds a portable single-file Edi executable (a PyInstaller onefile
# self-extracting zip) inside an Ubuntu 22.04 container so it links against
# glibc 2.35 and runs on older desktop Linux machines.
#
# The frontend (dist/) is also built in a pinned-Node Docker stage, so the
# host Node version does not matter.
#
# Usage:  ./scripts/build-pyzip.sh
# Output: ./dist-app/edi   (smoke-tested before reporting success)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

print_step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is required to build the portable pyzip" >&2
  exit 1
fi

# --- 1. Build the onefile pyzip on glibc 2.35 -----------------------------
print_step "Building frontend + onefile executable in Docker (Ubuntu 22.04)"
docker build -f "$ROOT/Dockerfile.pyzip" -t edi-pyzip:jammy "$ROOT"

print_step "Copying binary out of the build container"
mkdir -p "$ROOT/dist-app"
docker run --rm -v "$ROOT/dist-app:/out" edi-pyzip:jammy

# --- 2. Smoke-test the binary (no display needed) --------------------------
# Headless QtWebEngine runs need software rendering and no /dev/shm: the GPU
# process otherwise tries to init GL with the 22.04-bundled Mesa against the
# host's newer stack and crashes (SIGTRAP, "failed to bind extensions").
#
# The onefile self-extraction unpacks ~450 MB to $TMPDIR, so point it at a
# disk-backed directory: /tmp is often a small tmpfs, and a full write makes
# the bootloader fail with "Failed to extract ...: decompression resulted in
# return code -1" (Z_ERRNO from fwrite). build/ lives on the host's disk.
SMOKE_TMP="$ROOT/build/smoke-tmp"
rm -rf "$SMOKE_TMP"
mkdir -p "$SMOKE_TMP"

cleanup_smoke_tmp() {
  # The selftest exits via os._exit (skipping Qt teardown), so QtWebEngine
  # subprocesses can outlive the parent for a moment. If one re-launches the
  # onefile binary without PyInstaller's env markers while we are deleting the
  # extraction dir, its bootloader fails with "Could not create temporary
  # directory!". Wait for all instances to exit before removing the dir.
  for _ in $(seq 1 8); do
    pgrep -f "dist-app/edi" >/dev/null 2>&1 || break
    sleep 0.5
  done
  rm -rf "$SMOKE_TMP"
}
trap cleanup_smoke_tmp EXIT

print_step "Verifying binary via the offscreen smoke test"
TMPDIR="$SMOKE_TMP" \
QT_QPA_PLATFORM=offscreen \
QTWEBENGINE_DISABLE_SANDBOX=1 \
QTWEBENGINE_CHROMIUM_FLAGS="--disable-dev-shm-usage --disable-gpu" \
EDI_SELFTEST=1 \
timeout 60 "$ROOT/dist-app/edi"

print_step "Done: ./dist-app/edi"
