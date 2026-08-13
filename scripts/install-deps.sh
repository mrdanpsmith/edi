#!/usr/bin/env bash
#
# Installs everything needed to build and run Edi from source.
# Requires: Python 3.10+ with venv support, and Node.js 20+ (for the frontend
# toolchain). On Debian/Ubuntu:  sudo apt install python3-venv python3-pip nodejs
#
# Usage: ./scripts/install-deps.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

print_step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

# --- Python virtualenv -------------------------------------------------------
if ! python3 -c 'import venv' >/dev/null 2>&1; then
  echo "error: python3-venv is required (Ubuntu/Debian: sudo apt install python3-venv)" >&2
  exit 1
fi

print_step "Setting up Python virtualenv (.venv)"
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# --- Frontend dependencies ----------------------------------------------------
print_step "Installing npm dependencies"
npm install

print_step "Generating app icon"
node scripts/generate-icon.mjs

print_step "All dependencies installed."
printf '\nNext steps:\n'
printf '  npm run build         build the frontend into dist/\n'
printf '  .venv/bin/python run_edi.py    run Edi from source\n'
printf '  npm run check         run typecheck, lint, and frontend tests\n'
printf '  .venv/bin/pytest tests/        run backend tests\n'
printf '  ./scripts/build-pyzip.sh       build the portable single-file binary\n'
