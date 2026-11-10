"""Tests for per-document version history (`backend/history.py`)."""

from __future__ import annotations

import os
import threading

import pytest
from dulwich.objects import Blob, Commit, Tree
from dulwich.repo import Repo

from backend import history


@pytest.fixture
def store(tmp_path, monkeypatch):
    root = tmp_path / "store"
    monkeypatch.setenv(history.ROOT_ENV, str(root))
    return root


@pytest.fixture
def docs(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    return folder


def _stored(doc, version_id: str) -> tuple[list[bytes], bytes]:
    """A version as git holds it: its tree's entry names, and the document's bytes."""
    with Repo(str(history.repo_dir(str(doc)))) as repo:
        commit = repo[version_id.encode()]
        assert isinstance(commit, Commit)
        tree = repo[commit.tree]
        assert isinstance(tree, Tree)
        blob = repo[next(iter(tree.items())).sha]
        assert isinstance(blob, Blob)
        return [entry.path for entry in tree.items()], blob.data


def _save(path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))
    history.record(str(path))


def test_a_save_records_a_version_in_an_ordinary_git_repository(store, docs):
    doc = docs / "notes.md"
    _save(doc, "# One\n")
    _save(doc, "# Two\n")

    versions = history.list_versions(str(doc))
    assert [v["message"] for v in versions] == ["Saved", "Saved"]
    assert history.read_version(str(doc), versions[0]["id"]) == "# Two\n"
    assert history.read_version(str(doc), versions[1]["id"]) == "# One\n"
    # Nothing is written beside the document.
    assert sorted(p.name for p in docs.iterdir()) == ["notes.md"]
    # It is a real git repository, its tree holding the document by name.
    assert _stored(doc, versions[0]["id"]) == ([b"notes.md"], b"# Two\n")
    assert (history.repo_dir(str(doc)) / history.PATH_FILE).read_text() == os.path.realpath(doc)


def test_an_unchanged_save_records_nothing(store, docs):
    doc = docs / "notes.md"
    _save(doc, "same\n")
    _save(doc, "same\n")
    assert len(history.list_versions(str(doc))) == 1


def test_a_document_without_history_has_no_versions(store, docs):
    doc = docs / "new.md"
    doc.write_text("x", encoding="utf-8")
    assert history.list_versions(str(doc)) == []


def test_versions_keep_the_files_bytes_and_read_back_as_the_page_reads(store, docs):
    doc = docs / "windows.md"
    doc.write_bytes(b"\xef\xbb\xbfline one\r\nline two\r\n")
    history.record(str(doc))
    (version,) = history.list_versions(str(doc))
    assert _stored(doc, version["id"])[1] == b"\xef\xbb\xbfline one\r\nline two\r\n"
    assert history.read_version(str(doc), version["id"]) == "line one\nline two\n"


def test_read_version_refuses_what_is_not_a_version(store, docs):
    doc = docs / "notes.md"
    _save(doc, "x\n")
    with pytest.raises(ValueError):
        history.read_version(str(doc), "../../etc/passwd")
    with pytest.raises(FileNotFoundError):
        history.read_version(str(doc), "0" * 40)
    with pytest.raises(FileNotFoundError):
        history.read_version(str(docs / "other.md"), "0" * 40)


def test_move_carries_the_history_to_the_new_name(store, docs):
    old = docs / "notes.md"
    _save(old, "first\n")
    new = docs / "ideas.md"
    old.rename(new)
    history.move(str(old), str(new))

    versions = history.list_versions(str(new))
    assert [v["message"] for v in versions] == ["Saved"]  # same bytes: no new commit
    assert not history.repo_dir(str(old)).exists()
    assert (history.repo_dir(str(new)) / history.PATH_FILE).read_text() == os.path.realpath(new)


def test_move_records_the_renamed_documents_new_text(store, docs):
    old = docs / "notes.md"
    _save(old, "first\n")
    new = docs / "ideas.md"
    old.rename(new)
    new.write_text("edited while renaming\n", encoding="utf-8")
    history.move(str(old), str(new))
    versions = history.list_versions(str(new))
    assert versions[0]["message"] == "Renamed from notes.md"
    assert history.read_version(str(new), versions[0]["id"]) == "edited while renaming\n"


def test_move_keeps_a_stale_history_at_the_new_name_rather_than_deleting_it(store, docs):
    stale = docs / "ideas.md"
    _save(stale, "an older ideas.md\n")
    stale.unlink()
    old = docs / "notes.md"
    _save(old, "notes\n")
    old.rename(stale)
    history.move(str(old), str(stale))

    assert history.read_version(str(stale), history.list_versions(str(stale))[0]["id"]) == "notes\n"
    assert len(list(store.iterdir())) == 2


def test_a_document_renamed_outside_edi_finds_its_history_again(store, docs):
    old = docs / "notes.md"
    _save(old, "one\n")
    _save(old, "two\n")
    moved = docs / "elsewhere.md"
    old.rename(moved)

    assert len(history.list_versions(str(moved))) == 2
    assert (history.repo_dir(str(moved)) / history.PATH_FILE).read_text() == os.path.realpath(moved)
    assert not history.repo_dir(str(old)).exists()


def test_no_history_is_adopted_from_a_document_that_still_exists(store, docs):
    original = docs / "notes.md"
    _save(original, "shared text\n")
    copy = docs / "copy.md"
    copy.write_bytes(original.read_bytes())
    assert history.list_versions(str(copy)) == []
    assert len(history.list_versions(str(original))) == 1


def test_no_history_is_adopted_when_two_lost_documents_match(store, docs):
    for name in ("a.md", "b.md"):
        _save(docs / name, "the same text\n")
        (docs / name).unlink()
    found = docs / "found.md"
    found.write_text("the same text\n", encoding="utf-8")
    assert history.list_versions(str(found)) == []


def test_concurrent_saves_each_land_once(store, docs):
    doc = docs / "busy.md"
    texts = [f"version {i}\n" for i in range(8)]
    doc.write_text(texts[0], encoding="utf-8")

    def save(text: str) -> None:
        # Replaced whole, as `files.write_text_file` does: a reader never sees
        # a half-written file.
        staged = docs / f".{abs(hash(text))}.tmp"
        staged.write_text(text, encoding="utf-8")
        os.replace(staged, doc)
        history.record(str(doc))

    threads = [threading.Thread(target=save, args=(text,)) for text in texts]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    versions = history.list_versions(str(doc))
    assert 1 <= len(versions) <= len(texts)
    # The chain is intact: every version reads back as one of the texts saved.
    assert {history.read_version(str(doc), v["id"]) for v in versions} <= set(texts)


def test_a_failure_to_record_is_logged_not_raised(store, docs, caplog):
    history.record(str(docs / "missing.md"))
    assert "Could not record a version" in caplog.text
    history.move(str(docs / "missing.md"), str(docs / "gone.md"))
    assert "Could not record a version" in caplog.text
