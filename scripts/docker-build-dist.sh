#!/usr/bin/env bash
# Builds the frontend (dist/) inside a Docker container with the pinned Node
# toolchain, so it does not depend on the Node version installed on the host.
#
# Usage:  ./scripts/docker-build-dist.sh
# Output: ./dist/ (relative asset paths, loaded via file:// by the Qt shell)

set -euo pipefail

cd "$(dirname "$0")/.."

docker build --target frontend -t edi-frontend .
mkdir -p dist
docker run --rm -v "$PWD/dist:/out" edi-frontend
echo "dist/ built:"
ls -1 dist
