#!/usr/bin/env bash
#
# Point git at the versioned `.githooks/` directory so a fresh clone gets the
# same hooks (git hooks in `.git/hooks` are not shared). `install-deps.sh`
# runs this automatically; run it by hand on an existing checkout.
#
# Usage: ./scripts/install-hooks.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A source tarball has no git metadata; installing hooks there would only fail.
if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git checkout — skipping git hook install"
  exit 0
fi

git -C "$ROOT" config --local core.hooksPath "$ROOT/.githooks"

printf 'Installed git hooks from %s/.githooks\n' "$ROOT"
printf '  pre-push: full CI simulation (skip with `git push --no-verify` or SKIP_CI_SIM=1)\n'
