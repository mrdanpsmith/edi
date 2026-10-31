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


def _commit_something(repo: Path, name: str = "later.txt") -> str:
    (repo / name).write_text("later\n")
    _git(repo, "add", name)
    _git(repo, "commit", "-q", "-m", f"add {name}")
    return _git(repo, "rev-parse", "HEAD")


def _tagged(repo: Path) -> str:
    return _git(repo, "rev-parse", f"v{_version(repo)}^{{commit}}")


@pytest.fixture
def remote(repo: Path, tmp_path: Path) -> Path:
    path = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", str(path))
    _git(repo, "remote", "add", "origin", str(path))
    return path


def test_tag_refuses_an_existing_tag_and_points_at_move(repo: Path):
    assert _run(repo, "tag").returncode == 0
    first = _tagged(repo)
    _commit_something(repo)

    result = _run(repo, "tag")

    assert result.returncode != 0
    assert "already exists" in result.stderr
    assert "--move" in result.stderr
    assert _tagged(repo) == first


def test_tag_move_moves_a_tag_no_remote_has(repo: Path, remote: Path):
    assert _run(repo, "tag").returncode == 0
    head = _commit_something(repo)

    result = _run(repo, "tag", "--move")

    assert result.returncode == 0, result.stderr
    assert _tagged(repo) == head
    assert _git(repo, "cat-file", "-t", f"v{_version(repo)}") == "tag", "still annotated"
    assert "Moved annotated tag" in result.stdout


def test_tag_move_refuses_a_pushed_tag(repo: Path, remote: Path):
    assert _run(repo, "tag").returncode == 0
    _git(repo, "push", "-q", "origin", f"v{_version(repo)}")
    first = _tagged(repo)
    _commit_something(repo)

    result = _run(repo, "tag", "--move")

    assert result.returncode != 0
    assert "already been pushed to 'origin'" in result.stderr
    assert _tagged(repo) == first


def test_tag_move_refuses_when_a_remote_cannot_be_asked(repo: Path, tmp_path: Path):
    _git(repo, "remote", "add", "origin", str(tmp_path / "missing.git"))
    assert _run(repo, "tag").returncode == 0
    first = _tagged(repo)
    _commit_something(repo)

    result = _run(repo, "tag", "--move")

    assert result.returncode != 0
    assert "could not ask remote 'origin'" in result.stderr
    assert _tagged(repo) == first


def test_tag_move_at_head_is_a_no_op(repo: Path, remote: Path):
    assert _run(repo, "tag").returncode == 0

    result = _run(repo, "tag", "--move")

    assert result.returncode == 0, result.stderr
    assert "nothing to move" in result.stdout


def test_move_is_only_valid_with_tag(repo: Path):
    result = _run(repo, "bump", "patch", "--move")

    assert result.returncode != 0
    assert "--move is only valid with tag" in result.stderr
    assert _git(repo, "log", "-1", "--pretty=%s") == "initial"


def test_check_accepts_python_pins_in_the_requirements_files(repo: Path):
    pin = "PySide6==" + "6.11.1"
    (repo / "requirements-build.txt").write_text(pin + "\n")

    result = _run(repo, "check")

    assert result.returncode == 0, result.stderr
    assert "pins live only in requirements*.txt" in result.stdout


def test_check_rejects_a_python_pin_in_a_build_script(repo: Path):
    pin = "PySide6==" + "6.11.1"
    (repo / "Dockerfile").write_text(f"RUN pip install {pin}\n")

    result = _run(repo, "check")

    assert result.returncode != 0
    assert "PySide6/PyInstaller pins must live only in requirements*.txt" in result.stderr
    assert "Dockerfile" in result.stderr
