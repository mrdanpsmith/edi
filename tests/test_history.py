"""Tests for per-document version history (`backend/history.py`)."""

from __future__ import annotations

import os
import threading

import pytest
from dulwich.objects import Blob, Commit, Tree
from dulwich.repo import Repo

from backend import history
from backend.files import missing_folders, missing_volume


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


def test_clear_keeps_the_document_as_it_is_now_as_the_first_version(store, docs):
    doc = docs / "notes.md"
    _save(doc, "one\n")
    _save(doc, "two\n")
    history.clear(str(doc))
    versions = history.list_versions(str(doc))
    assert [v["message"] for v in versions] == ["History cleared"]
    assert history.read_version(str(doc), versions[0]["id"]) == "two\n"


def test_clear_of_a_deleted_document_leaves_nothing(store, docs):
    doc = docs / "notes.md"
    _save(doc, "one\n")
    doc.unlink()
    history.clear(str(doc))
    assert history.stored_documents() == []


def test_stored_documents_say_where_each_stands_newest_first(store, docs, monkeypatch):
    now = {"t": 100}
    monkeypatch.setattr(history.time, "time", lambda: now["t"])
    kept = docs / "kept.md"
    gone = docs / "gone.md"
    _save(kept, "kept\n")
    now["t"] = 200
    _save(gone, "gone\n")
    _save(gone, "gone again\n")
    gone.unlink()
    assert [(d["path"], d["exists"], d["status"], d["versions"], d["time"]) for d in history.stored_documents()] == [
        (os.path.realpath(gone), False, "missing", 2, 200),
        (os.path.realpath(kept), True, "exists", 1, 100),
    ]


def test_removing_histories_keeps_a_fresh_start_only_for_open_documents(store, docs):
    open_doc = docs / "open.md"
    closed_doc = docs / "closed.md"
    other = docs / "other.md"
    _save(open_doc, "one\n")
    _save(open_doc, "two\n")
    _save(closed_doc, "x\n")
    _save(other, "y\n")

    assert history.remove_histories([str(open_doc), str(closed_doc)], keep=[str(open_doc)]) == 2
    assert [v["message"] for v in history.list_versions(str(open_doc))] == ["History cleared"]
    assert sorted(d["path"] for d in history.stored_documents()) == sorted(
        [os.path.realpath(open_doc), os.path.realpath(other)]
    )
    assert closed_doc.exists()  # the document itself is never touched


# ── recovering a deleted document ─────────────────────────────────────────


def test_location_status_names_what_stands_in_the_way(docs, tmp_path):
    there = docs / "there.md"
    there.write_text("x", encoding="utf-8")
    (docs / "folder.md").mkdir()
    (docs / "plain-file").write_text("x", encoding="utf-8")
    assert history.location_status(str(there)) == "exists"
    assert history.location_status(str(docs / "gone.md")) == "missing"
    assert history.location_status(str(docs / "a" / "b" / "gone.md")) == "folderMissing"
    assert history.location_status(str(docs / "folder.md")) == "blocked"
    assert history.location_status(str(docs / "plain-file" / "gone.md")) == "blocked"
    assert missing_folders(str(docs / "a" / "b" / "gone.md")) == [str(docs / "a"), str(docs / "a" / "b")]


def test_a_path_on_a_drive_that_is_not_connected_is_never_recreated(monkeypatch):
    # The drives are "unplugged": their mount points don't exist. The store is
    # stubbed, since nothing can be recorded on a drive that isn't there.
    monkeypatch.setattr(history.Path, "exists", lambda self: str(self) not in ("/Volumes/USB", "/media/ada/USB"))
    monkeypatch.setattr(history, "latest_bytes", lambda _path: b"notes\n")
    assert missing_volume("/Volumes/USB/notes/a.md") == "/Volumes/USB"
    assert missing_volume("/media/ada/USB/a.md") == "/media/ada/USB"
    assert missing_volume("/Users/ada/notes/a.md") is None
    assert history.location_status("/Volumes/USB/notes/a.md") == "noDrive"
    with pytest.raises(FileNotFoundError, match="isn't connected"):
        history.recover("/Volumes/USB/notes/a.md", "/Volumes/USB/notes/a.md", make_folders=True)


def test_recover_writes_the_newest_version_back_byte_for_byte(store, docs):
    doc = docs / "notes.md"
    doc.write_bytes(b"\xef\xbb\xbfone\r\n")
    history.record(str(doc))
    doc.write_bytes(b"\xef\xbb\xbftwo\r\n")
    history.record(str(doc))
    doc.unlink()

    history.recover(str(doc), str(doc))
    assert doc.read_bytes() == b"\xef\xbb\xbftwo\r\n"
    # Back where it was, so nothing new is recorded and the history is whole.
    assert len(history.list_versions(str(doc))) == 2
    assert [p.name for p in docs.iterdir()] == ["notes.md"]  # no temporary file left


def test_recover_makes_missing_folders_only_when_asked(store, docs):
    doc = docs / "2025" / "q4" / "plan.md"
    doc.parent.mkdir(parents=True)
    _save(doc, "plan\n")
    doc.unlink()
    doc.parent.rmdir()
    doc.parent.parent.rmdir()

    with pytest.raises(FileNotFoundError, match="no longer exists"):
        history.recover(str(doc), str(doc))
    assert not (docs / "2025").exists()
    history.recover(str(doc), str(doc), make_folders=True)
    assert doc.read_text(encoding="utf-8") == "plan\n"


def test_recover_never_replaces_anything(store, docs):
    doc = docs / "notes.md"
    _save(doc, "mine\n")
    doc.write_text("someone else's\n", encoding="utf-8")
    with pytest.raises(FileExistsError):
        history.recover(str(doc), str(doc))
    assert doc.read_text(encoding="utf-8") == "someone else's\n"


def test_recover_elsewhere_takes_the_history_along(store, docs, tmp_path):
    doc = docs / "notes.md"
    _save(doc, "one\n")
    _save(doc, "two\n")
    doc.unlink()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    target = elsewhere / "notes.md"

    history.recover(str(doc), str(target))
    assert target.read_text(encoding="utf-8") == "two\n"
    assert [v["message"] for v in history.list_versions(str(target))] == ["Saved", "Saved"]
    assert [d["path"] for d in history.stored_documents()] == [os.path.realpath(target)]


def test_nothing_outside_the_store_is_ever_removed(store, docs):
    with pytest.raises(ValueError):
        history._remove(docs)
    assert docs.is_dir()


def test_a_failure_to_record_is_logged_not_raised(store, docs, caplog):
    history.record(str(docs / "missing.md"))
    assert "Could not record a version" in caplog.text
    history.move(str(docs / "missing.md"), str(docs / "gone.md"))
    assert "Could not record a version" in caplog.text
