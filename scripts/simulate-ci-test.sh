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
# The builder image is x86-64 only (x64 Node tarball; PySide6's arm64 Linux
# wheels need glibc 2.39, newer than jammy's 2.35). Pin the platform so an
# Apple Silicon host builds and runs it under emulation instead of failing to
# pip-install PySide6 for arm64.
PLATFORM=(--platform linux/amd64)
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

# What the image is built from. A new pin in a requirements file (a runtime
# dependency such as dulwich) leaves every baked *tool* in place, so the check
# below cannot see it: the run then fails much later with an unresolved import.
# The image is labelled with a hash of its inputs instead, and rebuilt when
# they change.
INPUTS_HASH="$(cat Dockerfile.ci requirements*.txt | shasum -a 256 | cut -d' ' -f1)"
build_image() {
  docker build "${PLATFORM[@]}" -f Dockerfile.ci -t "$IMAGE" \
    --label "edi.inputs=$INPUTS_HASH" "$ROOT"
}

if ! docker image inspect "$IMAGE" >/dev/null 2>&1 || [[ "$REBUILD" == 1 ]]; then
  print_step "Building $IMAGE from Dockerfile.ci (one-time; subsequent runs reuse it)"
  build_image
elif [[ "$(docker image inspect -f '{{ index .Config.Labels "edi.inputs" }}' "$IMAGE" 2>/dev/null)" != "$INPUTS_HASH" ]]; then
  print_step "Dockerfile.ci or a requirements file changed since $IMAGE was built; rebuilding"
  build_image
fi

# A stale local image (built before a tool was baked into /opt/edi/venv) fails
# mid-run with a cryptic "No such file or directory"; the Docker cache makes
# this a no-op whenever Dockerfile.ci is current.
TOOLS='python pytest'
[[ "$PYTEST_ONLY" == 1 ]] || TOOLS="$TOOLS bandit pip-audit pyright"
check_bake_tools() {
  docker run --rm --init "${PLATFORM[@]}" "$IMAGE" bash -euc "
    missing=0
    for t in $TOOLS; do
      PATH=/opt/edi/venv/bin:\$PATH command -v \"\$t\" >/dev/null 2>&1 || { echo \"baked tool missing from $IMAGE: \$t\" >&2; missing=1; }
    done
    if [[ $PYTEST_ONLY != 1 ]] && ! compgen -G '/opt/ms-playwright/chromium_headless_shell-*' >/dev/null; then
      echo \"baked Chromium missing from $IMAGE: /opt/ms-playwright\" >&2; missing=1
    fi
    exit \$missing
  "
}
if ! check_bake_tools; then
  print_step "Stale $IMAGE (missing a baked tool); rebuilding from Dockerfile.ci"
  build_image
  check_bake_tools
fi

# The exact `test` job steps (.github/workflows/ci.yml), minus the `.venv`
# symlink. The job links `.venv` to /opt/edi/venv in a fresh checkout; here the
# checkout is the host's, whose `.venv` is a real directory — the host's own
# venv. `ln -sfn` cannot replace a directory (it puts a link *inside* it), so
# the old copy of that step silently left pyright, which finds packages
# through `pyrightconfig.json`'s `.venv`, checking against the *host's* venv:
# a dependency the image has but the host venv lacks (dulwich, once) failed as
# an unresolved import. Every tool is therefore called from /opt/edi/venv by
# path, and pyright is pointed at it with `--venvpath`, which overrides the
# config's `venvPath` and keeps its `venv` name. Nothing in the checkout's
# `.venv` is touched.
PYRIGHT='mkdir -p /tmp/edi-pyright && ln -sfn /opt/edi/venv /tmp/edi-pyright/.venv && /opt/edi/venv/bin/pyright --venvpath /tmp/edi-pyright'
if [[ "$PYTEST_ONLY" == 1 ]]; then
  STEPS='
set -euo pipefail
echo "[sim] python 3.10 source check"
/opt/edi/venv/bin/python -m compileall -q backend tests scripts run_edi.py
echo "[sim] version and dependency-pin check"
./scripts/version.sh check
echo "[sim] python type check (pyright)"
'"$PYRIGHT"'
echo "[sim] pytest tests/ (backend only)"
/opt/edi/venv/bin/pytest tests/
echo "[sim] SIMULATED PYTEST PASSED"'
else
  STEPS='
set -euo pipefail
echo "[sim] python 3.10 source check"
/opt/edi/venv/bin/python -m compileall -q backend tests scripts run_edi.py
echo "[sim] version and dependency-pin check"
./scripts/version.sh check
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
echo "[sim] npm run test:browser (baked headless Chromium)"
npm run test:browser
echo "[sim] npm run build:test (app bundle + window-test harness)"
npm run build:test
echo "[sim] python type check (pyright)"
'"$PYRIGHT"'
echo "[sim] bandit (backend security, all findings)"
/opt/edi/venv/bin/bandit -c pyproject.toml -r backend scripts/color-scheme-probe.py scripts/dark-mode-forensics.py run_edi.py -q
echo "[sim] pytest tests/"
/opt/edi/venv/bin/pytest tests/
echo "[sim] npm audit (network)"
npm run audit
echo "[sim] pip-audit -r requirements.txt (network)"
/opt/edi/venv/bin/pip-audit --cache-dir /builds/edi/build/ci-cache -r requirements.txt
echo "[sim] SIMULATED TEST JOB PASSED"'
fi

# The `test` job steps run in a fresh CI container (/root config). Mirror that
# by giving Qt/QSettings a throwaway config dir inside the (gitignored) build/
# tree instead of the checkout, which HOME=/builds/edi would otherwise fill.
CONFIG_DIR="$ROOT/build/ci-config"
CACHE_DIR="$ROOT/build/ci-cache"
rm -rf "$CONFIG_DIR" "$CACHE_DIR"
mkdir -p "$CONFIG_DIR" "$CACHE_DIR"

print_step "Running CI \`test\` job simulation in $IMAGE (Python 3.10, headless, no gsettings)"

# Stopping the run must stop the container. Without this, Ctrl+C during a
# `git push` cancelled the push but left the simulation running: `docker run`
# proxies the signal to the container's PID 1, which was `bash`, and PID 1
# ignores SIGINT/SIGTERM that it has no handler for, so the container ran on
# and the CLI kept waiting for it. Two fixes, each enough on its own path:
# - `--init` makes PID 1 a tiny init that forwards signals, and
#   TINI_KILL_PROCESS_GROUP sends them to the whole tree (npm, pytest, …);
# - `docker run` runs in the background, so this script's own trap fires at
#   once on Ctrl+C, a closed terminal or git stopping the hook, and removes
#   the named container whatever state the CLI is in.
CONTAINER="edi-ci-sim-$$"
DOCKER_PID=""
stop_container() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
on_signal() {
  trap - INT TERM HUP
  echo >&2
  echo "simulate-ci-test: interrupted — stopping container $CONTAINER" >&2
  stop_container
  [[ -n "$DOCKER_PID" ]] && kill "$DOCKER_PID" 2>/dev/null || true
  exit "$1"
}
trap stop_container EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

docker run --rm --init --name "$CONTAINER" "${PLATFORM[@]}" \
  -e "TINI_KILL_PROCESS_GROUP=1" \
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
  "$IMAGE" bash -euc "$STEPS" </dev/null &
DOCKER_PID=$!
# `wait` returns as soon as a trapped signal arrives (the trap then runs), and
# otherwise with the container's exit status, which `set -e` passes on.
wait "$DOCKER_PID"