#!/usr/bin/env bash
#
# Bumps the Edi version everywhere it is tracked.
#
# Usage: ./scripts/version.sh <command> [args]
#
# Commands:
#   current            Print the current version (e.g. 0.1.0)
#   set <x.y.z>        Set the version in package.json, package-lock.json,
#                      and backend/__init__.py
#   bump <part>        Bump the patch, minor, or major part of the version
#   check              Verify all declarations agree on a valid version
#   tag                Create an annotated git tag v<current-version>
#
# Examples:
#   ./scripts/version.sh current
#   ./scripts/version.sh bump patch
#   ./scripts/version.sh set 1.2.0
#   ./scripts/version.sh check
#   ./scripts/version.sh tag
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'EOF'
Usage: ./scripts/version.sh <command> [args]

Commands:
  current            Print the current version (e.g. 0.1.0)
  set <x.y.z>        Set the version in package.json, package-lock.json,
                     and backend/__init__.py
  bump <part>        Bump the patch, minor, or major part of the version
  check              Verify all declarations agree on a valid version
  tag                Create an annotated git tag v<current-version>

Examples:
  ./scripts/version.sh current
  ./scripts/version.sh bump patch
  ./scripts/version.sh set 1.2.0
  ./scripts/version.sh check
  ./scripts/version.sh tag
EOF
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required (project requirement is Node 20+)" >&2
  exit 1
fi

VERSION_FILES="package.json package-lock.json backend/__init__.py"

get_version() {
  node -p "require('./package.json').version"
}

valid_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

apply_version() {
  local version="$1"
  sed -i -E 's/^__version__ = ".*"/__version__ = "'"$version"'"/' backend/__init__.py
}

print_next_steps() {
  local version="$1"
  printf '\nNext steps:\n'
  printf '  git add %s\n' "$VERSION_FILES"
  printf '  git commit -m "Bump version to %s"\n' "$version"
  printf '  ./scripts/version.sh tag\n'
  printf '  git push\n'
  printf '  git push origin v%s\n' "$version"
  printf '\nPushing the v%s tag triggers the GitHub Actions release job.\n' "$version"
}

cmd_current() {
  echo "$(get_version)"
}

cmd_set() {
  local version="$1"
  if ! valid_semver "$version"; then
    echo "error: invalid version '$version' (expected x.y.z)" >&2
    exit 1
  fi
  local old
  old="$(get_version)"
  if [ "$old" = "$version" ]; then
    echo "error: version unchanged ($version); pick a different version" >&2
    exit 1
  fi
  npm version "$version" --no-git-tag-version >/dev/null
  apply_version "$version"
  echo "Bumped $old -> $version"
  print_next_steps "$version"
}

cmd_bump() {
  local part="$1"
  case "$part" in
    patch | minor | major) ;;
    *) echo "error: invalid part '$part' (expected patch, minor, or major)" >&2; exit 1 ;;
  esac
  local old new
  old="$(get_version)"
  npm version "$part" --no-git-tag-version >/dev/null
  new="$(get_version)"
  apply_version "$new"
  echo "Bumped $old -> $new"
  print_next_steps "$new"
}

cmd_check() {
  local pkg lock init bad=0
  pkg="$(get_version)"
  lock="$(node -p "require('./package-lock.json').version")"
  init="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' backend/__init__.py)"
  for v in "$pkg" "$lock" "$init"; do
    if ! valid_semver "$v"; then
      echo "error: invalid version '$v'" >&2
      bad=1
    fi
  done
  [ "$bad" -eq 0 ] || return 1
  if [ "$pkg" != "$lock" ] || [ "$pkg" != "$init" ]; then
    echo "error: version mismatch:" >&2
    echo "  package.json:        $pkg" >&2
    echo "  package-lock.json:   $lock" >&2
    echo "  backend/__init__.py: $init" >&2
    return 1
  fi
  echo "OK: version $pkg agrees across $VERSION_FILES"
}

cmd_tag() {
  if ! cmd_check >/dev/null; then
    echo "error: refusing to tag while version declarations are inconsistent" >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "error: refusing to tag with uncommitted changes" >&2
    echo "  commit (or stash) your work first, then run ./scripts/version.sh tag" >&2
    exit 1
  fi
  local version
  version="$(get_version)"
  if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    echo "error: tag v$version already exists" >&2
    exit 1
  fi
  git tag -a "v$version" -m "Edi v$version"
  echo "Created annotated tag v$version (push it to trigger the release job)"
}

if [ $# -eq 0 ]; then
  usage
fi

cmd="$1"
shift

case "$cmd" in
  current) cmd_current ;;
  set) cmd_set "${1:-}" ;;
  bump) cmd_bump "${1:-}" ;;
  check) cmd_check ;;
  tag) cmd_tag ;;
  -h | --help) usage ;;
  *) echo "error: unknown command '$cmd'" >&2; usage ;;
esac
