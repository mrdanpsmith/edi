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
print_step "Verifying binary via the offscreen smoke test"
QT_QPA_PLATFORM=offscreen \
QTWEBENGINE_DISABLE_SANDBOX=1 \
QTWEBENGINE_CHROMIUM_FLAGS="--disable-dev-shm-usage --disable-gpu" \
EDI_SELFTEST=1 \
timeout 60 "$ROOT/dist-app/edi"

print_step "Done: ./dist-app/edi"
