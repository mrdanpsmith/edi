#!/usr/bin/env bash
#
# Builds a portable Edi AppImage inside an Ubuntu 22.04 container (glibc 2.35).
# Building on newer distros bundles libraries that require a newer glibc and
# the resulting AppImage will not run on older systems.
#
# Prerequisites: Docker with network access.
# Output: src-tauri/target/release/bundle/appimage/Edi_<version>_amd64.AppImage
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="edi-appimage:jammy"
OUT_DIR="${ROOT}/src-tauri/target/release/bundle/appimage"

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is not available" >&2
  exit 1
fi

echo "==> Building build image ($IMAGE)"
docker build -t "$IMAGE" -f "$ROOT/Dockerfile.appimage" "$ROOT"

echo "==> Building AppImage inside $IMAGE"
mkdir -p "$OUT_DIR" "$ROOT/.cache/cargo" "$ROOT/.cache/npm"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/app/.cache/home \
  -e CARGO_HOME=/app/.cache/cargo \
  -e npm_config_cache=/app/.cache/npm \
  -v "$ROOT:/app" \
  "$IMAGE" \
  bash -c 'cd /app && npm ci --no-audit --no-fund && npm run tauri build -- --bundles appimage'

echo "==> Done"
ls -lh "${OUT_DIR}"/*.AppImage
