"""Repo paths named in the agent docs must exist.

``AGENTS.md`` is the entry point every coding agent reads, and the topic
documents under ``docs/`` are what it follows next. A stale path there sends a
reader to a file that is not in the tree, so this test treats every backticked
repo path in those files as a link that has to resolve.

Only paths whose first segment exists at the repository root are considered, so
relative names (``node/``), generated output (``dist/``), absolute paths, URLs
and placeholders (``Edi-<ver>``) are left alone.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DOCS = [ROOT / "AGENTS.md", *sorted((ROOT / "docs").glob("*.md"))]
BACKTICK = re.compile(r"`([^`\n]+)`")
NON_SOURCE = {
    "artifacts",
    "build",
    "coverage",
    "coverage-py",
    "dist",
    "dist-app",
    "lost+found",
    "node_modules",
    "__pycache__",
    ".git",
    ".npm",
    ".pytest_cache",
    ".qttest",
    ".venv",
    ".venv-macos",
    ".venv-win",
}
PLACEHOLDER_CHARS = set("*<>$")


def repo_paths(text: str) -> set[str]:
    """The backticked tokens that look like paths into this repository."""
    paths: set[str] = set()
    for match in BACKTICK.finditer(text):
        token = match.group(1).strip()
        if " " in token:
            # A command such as ``scripts/simulate-ci-test.sh --pytest-only``;
            # keep its leading path and drop the arguments.
            token = token.split()[0]
        token = token.split("::", 1)[0].rstrip("/")
        if "/" not in token or not token:
            continue
        if token.startswith(("/", "~", "http:", "https:", "file:")):
            continue
        if any(char in token for char in PLACEHOLDER_CHARS) or "..." in token:
            continue
        first = token.split("/", 1)[0]
        if first in NON_SOURCE or not (ROOT / first).exists():
            continue
        paths.add(token)
    return paths


@pytest.mark.parametrize("doc", DOCS, ids=lambda path: str(path.relative_to(ROOT)))
def test_backticked_repo_paths_exist(doc: Path) -> None:
    missing = sorted(
        path for path in repo_paths(doc.read_text(encoding="utf-8"))
        if not (ROOT / path).exists()
    )

    assert not missing, f"{doc.relative_to(ROOT)} references missing paths: {missing}"
