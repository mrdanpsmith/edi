"""`scripts/version.sh` writes the version files and owns the bump commit."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "version.sh"
VERSION_FILES = ["backend/__init__.py", "package-lock.json", "package.json"]


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def _run(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(repo / "scripts" / "version.sh"), *args],
        cwd=repo,
        capture_output=True,
        text=True,
    )


def _version(repo: Path) -> str:
    return json.loads((repo / "package.json").read_text(encoding="utf-8"))["version"]


def _next_patch(version: str) -> str:
    major, minor, patch = (int(part) for part in version.split("."))
    return f"{major}.{minor}.{patch + 1}"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    path = tmp_path / "repo"
    (path / "scripts").mkdir(parents=True)
    (path / "backend").mkdir()
    shutil.copy2(SCRIPT, path / "scripts" / "version.sh")
    shutil.copy2(ROOT / "package.json", path / "package.json")
    shutil.copy2(ROOT / "package-lock.json", path / "package-lock.json")
    shutil.copy2(ROOT / "backend" / "__init__.py", path / "backend" / "__init__.py")
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "user.name", "Test")
    _git(path, "add", ".")
    _git(path, "commit", "-q", "-m", "initial")
    return path


def test_bump_stages_and_commits_the_version_files(repo: Path):
    old = _version(repo)
    new = _next_patch(old)

    result = _run(repo, "bump", "patch")

    assert result.returncode == 0, result.stderr
    assert _version(repo) == new
    assert _git(repo, "log", "-1", "--pretty=%s") == (
        f"Bump version to {new} [skip changelog]"
    )
    committed = sorted(_git(repo, "show", "--pretty=format:", "--name-only", "HEAD").split())
    assert committed == VERSION_FILES
    assert _git(repo, "status", "--porcelain") == ""
    assert "Committed: Bump version" in result.stdout


def test_no_commit_leaves_the_bump_uncommitted_and_prints_the_commands(repo: Path):
    old = _version(repo)
    new = _next_patch(old)
    head = _git(repo, "rev-parse", "HEAD")

    result = _run(repo, "bump", "patch", "--no-commit")

    assert result.returncode == 0, result.stderr
    assert _git(repo, "rev-parse", "HEAD") == head
    assert _version(repo) == new
    changed = sorted(
        line.split(maxsplit=1)[1]
        for line in _git(repo, "status", "--porcelain").splitlines()
    )
    assert changed == VERSION_FILES
    assert "Skipped commit (--no-commit)." in result.stdout
    assert (
        f'git commit -m "Bump version to {new} [skip changelog]"' in result.stdout
    )


def test_refuses_to_bump_before_changing_files_outside_a_git_work_tree(tmp_path: Path):
    path = tmp_path / "not-a-repo"
    (path / "scripts").mkdir(parents=True)
    (path / "backend").mkdir()
    shutil.copy2(SCRIPT, path / "scripts" / "version.sh")
    shutil.copy2(ROOT / "package.json", path / "package.json")
    shutil.copy2(ROOT / "package-lock.json", path / "package-lock.json")
    shutil.copy2(ROOT / "backend" / "__init__.py", path / "backend" / "__init__.py")
    old = _version(path)

    result = _run(path, "bump", "patch")

    assert result.returncode != 0
    assert "not inside a git work tree" in result.stderr
    assert _version(path) == old
