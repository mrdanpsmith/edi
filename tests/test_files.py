"""Tests for file IO helpers."""

from __future__ import annotations

from pathlib import Path

from backend.files import (
    is_supported_extension,
    read_any_text_file,
    read_text_file,
    rename_text_file,
)

import pytest


def test_read_any_text_file_reads_unknown_extensions(tmp_path):
    path = tmp_path / "notes.log"
    path.write_text("hello", encoding="utf-8")
    assert read_any_text_file(str(path)) == "hello"


def test_read_any_text_file_reads_supported_extensions(tmp_path):
    path = tmp_path / "notes.md"
    path.write_text("# Hi", encoding="utf-8")
    assert read_any_text_file(str(path)) == "# Hi"


def test_read_any_text_file_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        read_any_text_file(str(tmp_path / "nope.md"))


def test_read_text_file_rejects_unknown_extensions(tmp_path):
    path = tmp_path / "notes.log"
    path.write_text("hello", encoding="utf-8")
    with pytest.raises(ValueError, match="Unsupported file extension"):
        read_text_file(str(path))


def test_is_supported_extension():
    assert is_supported_extension("a.md") is True
    assert is_supported_extension("a.txt") is True
    assert is_supported_extension("a.log") is False


def test_rename_text_file_moves_the_content_and_deletes_the_old_file(tmp_path):
    old = tmp_path / "notes.md"
    old.write_text("stale on disk", encoding="utf-8")
    new = tmp_path / "ideas.md"

    rename_text_file(str(old), str(new), "# Edited")

    assert not old.exists()
    assert new.read_text(encoding="utf-8") == "# Edited"


def test_rename_text_file_refuses_an_existing_destination(tmp_path):
    old = tmp_path / "notes.md"
    old.write_text("mine", encoding="utf-8")
    taken = tmp_path / "ideas.md"
    taken.write_text("someone else's", encoding="utf-8")

    with pytest.raises(FileExistsError):
        rename_text_file(str(old), str(taken), "# Edited")

    # Neither document moved: the other one is not ours to overwrite, and the
    # rename did not half-happen either.
    assert old.read_text(encoding="utf-8") == "mine"
    assert taken.read_text(encoding="utf-8") == "someone else's"


def test_rename_text_file_refuses_the_same_file(tmp_path):
    old = tmp_path / "notes.md"
    old.write_text("mine", encoding="utf-8")

    with pytest.raises(ValueError, match="already has that name"):
        rename_text_file(str(old), str(old), "# Edited")

    # A path that reaches the same file by another spelling is the same name.
    with pytest.raises(ValueError, match="already has that name"):
        rename_text_file(str(old), str(tmp_path / "." / "notes.md"), "# Edited")

    assert old.read_text(encoding="utf-8") == "mine"


def test_rename_text_file_refuses_a_missing_source(tmp_path):
    with pytest.raises(FileNotFoundError):
        rename_text_file(str(tmp_path / "gone.md"), str(tmp_path / "ideas.md"), "x")
    assert not (tmp_path / "ideas.md").exists()


def test_rename_text_file_leaves_nothing_behind_when_the_delete_fails(tmp_path, monkeypatch):
    """A rename that cannot do both leaves the document where it was.

    The content is written under the new name first, so the delete is the only
    step that can fail — and when it does, the new copy goes back with it.
    """
    old = tmp_path / "notes.md"
    old.write_text("mine", encoding="utf-8")
    new = tmp_path / "ideas.md"

    real_unlink = Path.unlink

    def refuse_the_old_one(self, *args, **kwargs):
        if self == old:
            raise OSError("permission denied")
        return real_unlink(self, *args, **kwargs)

    monkeypatch.setattr("pathlib.Path.unlink", refuse_the_old_one)

    with pytest.raises(OSError, match="permission denied"):
        rename_text_file(str(old), str(new), "# Edited")

    assert not new.exists()
    assert old.read_text(encoding="utf-8") == "mine"


def test_rename_text_file_writes_a_destination_in_another_directory(tmp_path):
    """The new name is the only thing that changes; the folder is the caller's."""
    old = tmp_path / "notes.md"
    old.write_text("mine", encoding="utf-8")
    target = tmp_path / "archive"
    new = target / "notes.md"

    rename_text_file(str(old), str(new), "kept")

    assert new.read_text(encoding="utf-8") == "kept"
    assert not old.exists()
