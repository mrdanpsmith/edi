"""Tests for file IO helpers."""

from __future__ import annotations

import os
from pathlib import Path

from backend.files import (
    check_rename_target,
    check_typed_open_path,
    is_supported_extension,
    read_any_text_file,
    read_text_file,
    rename_text_file,
    resolve_typed_path,
    write_text_file,
)

import pytest


def test_resolve_typed_path_keeps_absolute_paths(tmp_path):
    assert resolve_typed_path(f"  {tmp_path}/a/../b.md  ", None) == str(tmp_path / "b.md")


def test_resolve_typed_path_strips_one_pair_of_quotes(tmp_path):
    assert resolve_typed_path(f'"{tmp_path}/my notes.md"', None) == str(tmp_path / "my notes.md")
    assert resolve_typed_path(f"'{tmp_path}/a.md'", None) == str(tmp_path / "a.md")


def test_resolve_typed_path_expands_home_and_variables(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("EDI_NOTES", "notes")
    assert resolve_typed_path("~/a.md", None) == str(tmp_path / "a.md")
    assert resolve_typed_path("$HOME/$EDI_NOTES/a.md", None) == str(tmp_path / "notes" / "a.md")


def test_resolve_typed_path_relative_to_base_or_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert resolve_typed_path("../x.md", str(tmp_path / "docs")) == str(tmp_path / "x.md")
    assert resolve_typed_path("x.md", None) == str(tmp_path / "home" / "x.md")


def test_resolve_typed_path_blank_is_empty():
    assert resolve_typed_path("   ", "/tmp") == ""
    assert resolve_typed_path('""', "/tmp") == ""


def test_check_typed_open_path(tmp_path):
    doc = tmp_path / "a.md"
    doc.write_text("x", encoding="utf-8")
    other = tmp_path / "a.py"
    other.write_text("x", encoding="utf-8")
    assert check_typed_open_path(str(doc)) is None
    assert check_typed_open_path("") == "Enter a file path."
    assert "No such file" in (check_typed_open_path(str(tmp_path / "nope.md")) or "")
    assert "Not a file" in (check_typed_open_path(str(tmp_path)) or "")
    assert "Unsupported file type" in (check_typed_open_path(str(other)) or "")


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


def test_write_text_file_keeps_the_old_text_when_the_write_fails(tmp_path, monkeypatch):
    path = tmp_path / "notes.md"
    path.write_text("saved before", encoding="utf-8")

    def full_disk(*args, **kwargs):
        raise OSError("No space left on device")

    monkeypatch.setattr("os.fsync", full_disk)
    with pytest.raises(OSError, match="No space left"):
        write_text_file(str(path), "# Half written")

    assert path.read_text(encoding="utf-8") == "saved before"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["notes.md"]


def test_write_text_file_keeps_permissions_and_writes_through_symlinks(tmp_path):
    real = tmp_path / "real.md"
    real.write_text("old", encoding="utf-8")
    real.chmod(0o640)
    link = tmp_path / "link.md"
    link.symlink_to(real)

    write_text_file(str(link), "new")

    assert link.is_symlink()
    assert real.read_text(encoding="utf-8") == "new"
    assert real.stat().st_mode & 0o777 == 0o640


def test_a_saved_file_keeps_its_line_endings_and_bom(tmp_path):
    crlf = tmp_path / "windows.md"
    crlf.write_bytes(b"\xef\xbb\xbf# Title\r\nline\r\n")
    # The page sees clean text: no BOM, `\n` endings.
    assert read_text_file(str(crlf)) == "# Title\nline\n"

    write_text_file(str(crlf), "# Title\nedited\n")
    assert crlf.read_bytes() == b"\xef\xbb\xbf# Title\r\nedited\r\n"

    lf = tmp_path / "unix.md"
    lf.write_bytes(b"a\nb\n")
    write_text_file(str(lf), "a\nc\n")
    assert lf.read_bytes() == b"a\nc\n"


def test_a_renamed_file_keeps_the_format_of_the_file_it_was(tmp_path):
    old = tmp_path / "notes.md"
    old.write_bytes(b"a\r\nb\r\n")
    new = tmp_path / "ideas.md"
    rename_text_file(str(old), str(new), "a\nb\nc\n")
    assert new.read_bytes() == b"a\r\nb\r\nc\r\n"


def test_write_text_file_creates_missing_folders(tmp_path):
    path = tmp_path / "a" / "b" / "notes.md"
    write_text_file(str(path), "hi")
    assert path.read_text(encoding="utf-8") == "hi"


def test_rename_text_file_moves_the_content_and_deletes_the_old_file(tmp_path):
    old = tmp_path / "notes.md"
    old.write_text("stale on disk", encoding="utf-8")
    new = tmp_path / "ideas.md"

    rename_text_file(str(old), str(new), "# Edited")

    assert not old.exists()
    assert new.read_text(encoding="utf-8") == "# Edited"


def test_rename_text_file_changes_only_the_case_of_a_name(tmp_path):
    # On a case-insensitive filesystem the new name already "exists" as the
    # document itself; on a case-sensitive one it is an ordinary rename.
    old = tmp_path / "Notes.md"
    old.write_text("stale", encoding="utf-8")
    rename_text_file(str(old), str(tmp_path / "notes.md"), "# Edited")
    assert sorted(os.listdir(tmp_path)) == ["notes.md"]
    assert (tmp_path / "notes.md").read_text(encoding="utf-8") == "# Edited"


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


def test_rename_text_file_moves_into_another_directory(tmp_path):
    old = tmp_path / "notes.md"
    old.write_text("mine", encoding="utf-8")
    target = tmp_path / "archive"
    target.mkdir()
    new = target / "notes.md"

    rename_text_file(str(old), str(new), "kept")

    assert new.read_text(encoding="utf-8") == "kept"
    assert not old.exists()


def test_rename_text_file_does_not_create_a_missing_directory(tmp_path):
    old = tmp_path / "notes.md"
    old.write_text("mine", encoding="utf-8")
    new = tmp_path / "archive" / "notes.md"

    with pytest.raises(FileNotFoundError, match="No such folder"):
        rename_text_file(str(old), str(new), "kept")

    assert old.read_text(encoding="utf-8") == "mine"
    assert not (tmp_path / "archive").exists()


def test_check_rename_target(tmp_path):
    old = tmp_path / "notes.md"
    old.write_text("mine", encoding="utf-8")
    (tmp_path / "taken.md").write_text("theirs", encoding="utf-8")
    (tmp_path / "archive").mkdir()
    (tmp_path / "plain").write_text("not a folder", encoding="utf-8")

    assert check_rename_target(str(old), str(tmp_path / "ideas.md")) is None
    assert check_rename_target(str(old), str(tmp_path / "archive" / "notes.md")) is None
    assert "Enter" in check_rename_target(str(old), "")
    assert "current name" in check_rename_target(str(old), str(old))
    assert "current name" in check_rename_target(str(old), str(tmp_path / "." / "notes.md"))
    assert "already exists" in check_rename_target(str(old), str(tmp_path / "taken.md"))
    assert "No such folder" in check_rename_target(str(old), str(tmp_path / "missing" / "notes.md"))
    assert "Not a folder" in check_rename_target(str(old), str(tmp_path / "plain" / "notes.md"))
