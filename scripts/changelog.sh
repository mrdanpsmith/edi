#!/usr/bin/env bash
#
# The commit list for the release notes, one line per commit
# (`- <short-sha> <subject>`) over the given revision range.
#
# Mark a commit as not-for-users by putting `[skip changelog]` (or
# `[no changelog]`, case-insensitive) anywhere in its message — for chores,
# refactors, CI-only changes and the like. Such commits are omitted from the
# release notes but still appear in `git log`.
#
# Usage:
#   ./scripts/changelog.sh v0.9.0..v0.10.0
#   ./scripts/changelog.sh v0.10.0            # everything reachable from the tag
#
set -euo pipefail

range="${1:?usage: changelog.sh <rev-range>}"

entries="$(git log --pretty=format:'- %h %s' \
  --extended-regexp --invert-grep --regexp-ignore-case \
  --grep='\[(skip|no) changelog\]' "$range")"

if [[ -z "$entries" ]]; then
  printf -- '- Internal changes only.\n'
else
  printf '%s\n' "$entries"
fi
