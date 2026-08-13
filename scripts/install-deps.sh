#!/usr/bin/env bash
#
# Installs everything needed to build Edi from source on a fresh system.
# Supports Ubuntu/Debian based distributions (the platform Tauri is built against).
#
# Usage: ./scripts/install-deps.sh
#
set -euo pipefail

print_step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

# --- Rust toolchain -------------------------------------------------------
if command -v cargo >/dev/null 2>&1; then
  print_step "Rust toolchain already installed ($(cargo --version | awk '{print $2}'))"
else
  print_step "Installing Rust via rustup (non-interactive)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  print_step "Rust installed: $(cargo --version)"
fi

# --- System packages ------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  print_step "Installing system build dependencies via apt"
  sudo apt-get update
  sudo apt-get install -y \
    build-essential \
    curl \
    file \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libsoup-3.0-dev \
    libwebkit2gtk-4.1-dev \
    pkg-config \
    xvfb
else
  print_step "Skipping apt install: apt-get not found"
  print_step "Ensure your distribution provides: webkit2gtk-4.1, gtk3, libsoup-3.0, librsvg2"
fi

# --- Node dependencies ------------------------------------------------------
print_step "Installing npm dependencies"
npm install

print_step "All dependencies installed."
printf '\nNext steps:\n'
printf '  npm run tauri dev     run Edi in development\n'
printf '  npm run tauri build   produce a release bundle\n'
printf '  npm run check         run typecheck, lint, and tests\n'
