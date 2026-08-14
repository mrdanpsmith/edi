"""Tests for file IO helpers."""

from __future__ import annotations

from backend.files import is_supported_extension, read_any_text_file, read_text_file

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
