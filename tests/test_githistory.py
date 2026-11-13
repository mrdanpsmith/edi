"""Tests for a document's git history (`backend/githistory.py`) and how Version
History lists it beside Edi's own versions (`history.list_combined`)."""

from __future__ import annotations

import pytest
from dulwich import porcelain
from dulwich.repo import Repo

from backend import githistory, history

AUTHOR = b"Ada Lovelace <ada@example.com>"


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    root = tmp_path / "store"
    monkeypatch.setenv(history.ROOT_ENV, str(root))
    githistory.clear_cache()
    yield root
    githistory.clear_cache()


@pytest.fixture
def clock(monkeypatch):
    """Edi's snapshots take the time from here, so they can fall between commits."""
    now = {"t": 1_000}
    monkeypatch.setattr(history.time, "time", lambda: now["t"])
    return now


@pytest.fixture
def repo(tmp_path):
    work = tmp_path / "project"
    work.mkdir()
    Repo.init(str(work)).close()
    return work


def _commit(work, relative: str, text: str, message: str, when: int) -> str:
    target = work / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode("utf-8"))
    porcelain.add(str(work), [str(target)])
    commit_id = porcelain.commit(
        str(work),
        message=message.encode(),
        author=AUTHOR,
        committer=AUTHOR,
        author_timestamp=when,
        commit_timestamp=when,
        author_timezone=0,
        commit_timezone=0,
    )
    return commit_id.decode("ascii")


def _snapshot(clock, doc, text: str, when: int, message: str = "Saved") -> None:
    clock["t"] = when
    doc.write_bytes(text.encode("utf-8"))
    history.record(str(doc), message)


# ── reading the repository ───────────────────────────────────────────────


def test_a_tracked_document_lists_the_commits_that_changed_it(repo):
    first = _commit(repo, "docs/notes.md", "one\n", "Add notes", 100)
    _commit(repo, "other.txt", "x\n", "Unrelated", 200)
    second = _commit(repo, "docs/notes.md", "two\n", "Edit notes\n\nThe body.", 300)

    found = githistory.history(str(repo / "docs" / "notes.md"))
    assert found is not None and found.complete
    assert [(v.id, v.message, v.author) for v in found.versions] == [
        (second, "Edit notes", "Ada Lovelace"),
        (first, "Add notes", "Ada Lovelace"),
    ]
    assert githistory.read(str(repo / "docs" / "notes.md"), first) == b"one\n"


def test_no_git_history_for_untracked_documents_or_files_outside_a_repository(repo, tmp_path):
    _commit(repo, "tracked.md", "t\n", "Add", 100)
    (repo / "untracked.md").write_text("u\n", encoding="utf-8")
    loose = tmp_path / "loose.md"
    loose.write_text("l\n", encoding="utf-8")
    assert githistory.history(str(repo / "untracked.md")) is None
    assert githistory.history(str(loose)) is None


def test_no_git_history_for_a_repository_without_commits_or_an_lfs_file(repo):
    (repo / "notes.md").write_text("n\n", encoding="utf-8")
    porcelain.add(str(repo), [str(repo / "notes.md")])
    assert githistory.history(str(repo / "notes.md")) is None  # staged, never committed

    _commit(repo, "big.md", "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n", "LFS", 100)
    assert githistory.history(str(repo / "big.md")) is None


def test_the_walk_stops_at_its_limit_and_says_so(repo, monkeypatch):
    for n in range(5):
        _commit(repo, "notes.md", f"v{n}\n", f"Commit {n}", 100 + n)
    monkeypatch.setattr(githistory, "LIMIT", 2)
    found = githistory.history(str(repo / "notes.md"))
    assert found is not None
    assert [v.message for v in found.versions] == ["Commit 4", "Commit 3"]
    assert found.complete is False


def test_a_new_commit_is_seen_though_the_walk_is_cached(repo):
    _commit(repo, "notes.md", "one\n", "First", 100)
    assert len(githistory.history(str(repo / "notes.md")).versions) == 1
    _commit(repo, "notes.md", "two\n", "Second", 200)
    assert [v.message for v in githistory.history(str(repo / "notes.md")).versions] == ["Second", "First"]


def test_reading_a_commit_that_does_not_hold_the_document_fails(repo):
    other = _commit(repo, "other.md", "o\n", "Other", 100)
    _commit(repo, "notes.md", "n\n", "Notes", 200)
    with pytest.raises(FileNotFoundError):
        githistory.read(str(repo / "notes.md"), other)
    with pytest.raises(ValueError):
        githistory.read(str(repo / "notes.md"), "HEAD")


# ── one timeline ──────────────────────────────────────────────────────────


def _shape(listing: dict) -> list[tuple[str, str, str]]:
    return [(v["source"], v["message"], v.get("section", "")) for v in listing["versions"]]


def test_a_document_moved_into_a_repository_keeps_its_history_from_before_git(repo, clock):
    """The case that shaped the rule: a document with Edi history, moved into a
    repository and committed. Its snapshots from before the commit exist only in
    Edi, so they stay in view."""
    doc = repo / "notes.md"
    _snapshot(clock, doc, "draft\n", 100, "Opened in Edi")
    _snapshot(clock, doc, "better\n", 150)
    _commit(repo, "notes.md", "better\n", "Add notes", 200)
    _snapshot(clock, doc, "after\n", 300)

    listing = history.list_combined(str(doc))
    assert _shape(listing) == [
        ("edi", "Saved", "uncommitted"),
        ("git", "Add notes", ""),
        # "better" at 150 is the commit itself, so it is folded into it.
        ("edi", "Opened in Edi", "beforeGit"),
    ]
    assert listing["git"] == {"complete": True, "walked": 1}
    commit = listing["versions"][1]
    assert commit["author"] == "Ada Lovelace" and commit["short"] == commit["id"][:7]
    assert history.read_from(str(doc), commit["id"], "git") == "better\n"


def test_snapshots_between_commits_are_grouped_under_the_commit_they_follow(repo, clock):
    doc = repo / "notes.md"
    first = _commit(repo, "notes.md", "one\n", "First", 100)
    _snapshot(clock, doc, "one\n", 110, "Opened in Edi")  # the commit itself
    _snapshot(clock, doc, "one and a bit\n", 150)
    _snapshot(clock, doc, "one and more\n", 160, "Changed outside Edi")
    _commit(repo, "notes.md", "two\n", "Second", 200)

    listing = history.list_combined(str(doc))
    assert _shape(listing) == [
        ("git", "Second", ""),
        ("edi", "Changed outside Edi", "between"),
        ("edi", "Saved", "between"),
        ("git", "First", ""),
    ]
    assert {v.get("group") for v in listing["versions"] if v["source"] == "edi"} == {first}


def test_line_endings_alone_do_not_keep_a_snapshot_apart_from_its_commit(repo, clock):
    doc = repo / "notes.md"
    _commit(repo, "notes.md", "one\ntwo\n", "Add", 100)
    clock["t"] = 150
    doc.write_bytes(b"one\r\ntwo\r\n")
    history.record(str(doc), "Opened in Edi")
    assert _shape(history.list_combined(str(doc))) == [("git", "Add", "")]


def test_without_git_or_outside_a_repository_the_list_is_edis_alone(repo, clock, tmp_path):
    doc = repo / "notes.md"
    _commit(repo, "notes.md", "one\n", "Add", 100)
    _snapshot(clock, doc, "two\n", 150)
    assert history.list_combined(str(doc), use_git=False) == {
        "versions": [{**history.list_versions(str(doc))[0], "source": "edi"}],
        "git": None,
    }

    loose = tmp_path / "loose.md"
    _snapshot(clock, loose, "l\n", 200)
    listing = history.list_combined(str(loose))
    assert listing["git"] is None
    assert _shape(listing) == [("edi", "Saved", "")]


def test_snapshots_older_than_an_unfinished_walk_are_not_called_before_git(repo, clock, monkeypatch):
    doc = repo / "notes.md"
    _commit(repo, "notes.md", "one\n", "First", 100)
    _snapshot(clock, doc, "one-ish\n", 150)
    _commit(repo, "notes.md", "two\n", "Second", 200)
    monkeypatch.setattr(githistory, "LIMIT", 1)
    listing = history.list_combined(str(doc))
    assert _shape(listing) == [("git", "Second", ""), ("edi", "Saved", "between")]
    assert listing["versions"][1]["group"] == ""
    assert listing["git"]["complete"] is False
