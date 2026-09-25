#!/usr/bin/env bash
#
# Local simulation of the GitHub Actions CI `test` job (the quality gate).
#
# CI runs that job in the pre-built `edi-builder:jammy` image: Ubuntu 22.04,
# Python 3.10 (the `f"...{...\\n...}"` f-string restriction and other syntax
# gates that a host 3.14 venv miss), a baked venv at /opt/edi/venv (PySide6,
# pytest, pytest-qt, pytest-cov), Node 22, and NO GNOME session / gsettings /
# dconf (tests must not depend on them). Replicating it locally means a green
# run here is green in CI, without spending CI minutes.
#
# The image is built from Dockerfile.ci once (then reused from the Docker cache);
# the checkout is mounted read-write at /builds/edi and the same env vars and
# commands as the real job run inside it. Written artifacts (node_modules/,
# dist/, coverage/, .npm/, build/) all land on gitignored paths, so the checkout
# stays clean.
#
# Usage: ./scripts/simulate-ci-test.sh [--pytest-only] [--rebuild-image]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${EDI_BUILDER_IMAGE:-edi-builder:jammy}"
PYTEST_ONLY=0
REBUILD=0

for arg in "$@"; do
  case "$arg" in
    --pytest-only) PYTEST_ONLY=1 ;;
    --rebuild-image) REBUILD=1 ;;
    -h|--help)
      echo "usage: $0 [--pytest-only] [--rebuild-image]"
      echo "  --pytest-only     backend only (3.10 source check + pytest), no npm steps"
      echo "  --rebuild-image   rebuild $IMAGE from Dockerfile.ci even if present"
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

print_step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required to simulate the CI runner" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1 || [[ "$REBUILD" == 1 ]]; then
  print_step "Building $IMAGE from Dockerfile.ci (one-time; subsequent runs reuse it)"
  docker build -f Dockerfile.ci -t "$IMAGE" "$ROOT"
fi

# A stale local image (built before a tool was baked into /opt/edi/venv) fails
# mid-run with a cryptic "No such file or directory"; the Docker cache makes
# this a no-op whenever Dockerfile.ci is current.
TOOLS='python pytest'
[[ "$PYTEST_ONLY" == 1 ]] || TOOLS="$TOOLS bandit pip-audit"
check_bake_tools() {
  docker run --rm "$IMAGE" bash -euc "
    missing=0
    for t in $TOOLS; do
      PATH=/opt/edi/venv/bin:\$PATH command -v \"\$t\" >/dev/null 2>&1 || { echo \"baked tool missing from $IMAGE: \$t\" >&2; missing=1; }
    done
    exit \$missing
  "
}
if ! check_bake_tools; then
  print_step "Stale $IMAGE (missing a baked tool); rebuilding from Dockerfile.ci"
  docker build -f Dockerfile.ci -t "$IMAGE" "$ROOT"
  check_bake_tools
fi

# The exact `test` job steps (.github/workflows/ci.yml), minus the `.venv`
# symlink: the
# host checkout already has a real .venv, and /opt/edi/venv/bin/pytest is the
# same interpreter the job would resolve through the link.
if [[ "$PYTEST_ONLY" == 1 ]]; then
  STEPS='
set -euo pipefail
echo "[sim] python 3.10 source check"
/opt/edi/venv/bin/python -m compileall -q backend tests scripts run_edi.py
echo "[sim] pytest tests/ (backend only)"
/opt/edi/venv/bin/pytest tests/
echo "[sim] SIMULATED PYTEST PASSED"'
else
  STEPS='
set -euo pipefail
echo "[sim] python 3.10 source check"
/opt/edi/venv/bin/python -m compileall -q backend tests scripts run_edi.py
echo "[sim] npm ci"
npm ci --no-audit --no-fund
echo "[sim] npm run lint"
npm run lint
echo "[sim] npm run typecheck"
npm run typecheck
echo "[sim] npm run dupcheck"
npm run dupcheck
echo "[sim] npm run coverage"
npm run coverage
echo "[sim] npm run build"
npm run build
echo "[sim] bandit (backend security, all findings)"
/opt/edi/venv/bin/bandit -c pyproject.toml -r backend scripts/color-scheme-probe.py scripts/dark-mode-forensics.py run_edi.py -q
echo "[sim] pytest tests/"
/opt/edi/venv/bin/pytest tests/
echo "[sim] npm audit (network)"
npm run audit
echo "[sim] pip-audit -r requirements.txt (network)"
/opt/edi/venv/bin/pip-audit -r requirements.txt
echo "[sim] SIMULATED TEST JOB PASSED"'
fi

# The `test` job steps run in a fresh CI container (/root config). Mirror that
# by giving Qt/QSettings a throwaway config dir inside the (gitignored) build/
# tree instead of the checkout, which HOME=/builds/edi would otherwise fill.
CONFIG_DIR="$ROOT/build/ci-config"
rm -rf "$CONFIG_DIR"
mkdir -p "$CONFIG_DIR"

print_step "Running CI \`test\` job simulation in $IMAGE (Python 3.10, headless, no gsettings)"
docker run --rm \
  -v "$ROOT:/builds/edi" \
  -w /builds/edi \
  -u "$(id -u):$(id -g)" \
  -e "HOME=/builds/edi" \
  -e "XDG_CACHE_HOME=/builds/edi/build/ci-cache" \
  -e "XDG_CONFIG_HOME=/builds/edi/build/ci-config" \
  -e "NPM_CONFIG_CACHE=/builds/edi/.npm" \
  -e "QT_QPA_PLATFORM=offscreen" \
  -e "QTWEBENGINE_DISABLE_SANDBOX=1" \
  -e "QTWEBENGINE_CHROMIUM_FLAGS=--disable-dev-shm-usage --disable-gpu" \
  -e "PYTHONUNBUFFERED=1" \
  "$IMAGE" bash -euc "$STEPS"