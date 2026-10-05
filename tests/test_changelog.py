"""The release-notes generator and its `[skip changelog]` marker."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "changelog.sh"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


def _commit(repo: Path, name: str, message: str) -> None:
    (repo / name).write_text(name)
    _git(repo, "add", name)
    _git(repo, "commit", "-q", "-m", message)


def _changelog(repo: Path, rev_range: str) -> str:
    return subprocess.run(
        [str(SCRIPT), rev_range], cwd=repo, check=True, capture_output=True, text=True
    ).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    path = tmp_path / "repo"
    path.mkdir()
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "user.name", "Test")
    return path


def test_omits_marked_commits_and_keeps_the_rest(repo: Path):
    _commit(repo, "a", "feat: add a thing")
    _commit(repo, "b", "chore: bump versions [skip changelog]")
    _commit(repo, "c", "fix: the bug")

    out = _changelog(repo, "HEAD~2..HEAD")

    assert "fix: the bug" in out
    assert "chore: bump versions" not in out


def test_marker_is_case_insensitive_and_accepts_no_changelog(repo: Path):
    _commit(repo, "a", "chore: internal [NO CHANGELOG]")
    _commit(repo, "b", "chore: other [no changelog]")

    assert "Internal changes only." in _changelog(repo, "HEAD")


def test_a_range_with_only_marked_commits_falls_back(repo: Path):
    _commit(repo, "a", "feat: visible")
    _commit(repo, "b", "ci: tweak workflow [skip changelog]")

    assert _changelog(repo, "HEAD~1..HEAD").strip() == "- Internal changes only."
