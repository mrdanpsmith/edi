"""File IO helpers, mirroring the previous Tauri backend commands."""

from __future__ import annotations

import os
from pathlib import Path

SUPPORTED_EXTENSIONS = ("md", "markdown", "txt", "mermaid")


def is_supported_extension(path: str) -> bool:
    return Path(path).suffix.lstrip(".").lower() in SUPPORTED_EXTENSIONS


def read_text_file(path: str) -> str:
    target = Path(path)
    if not target.is_file():
        raise FileNotFoundError(f"Not a file: {path}")
    if not is_supported_extension(path):
        raise ValueError(
            "Unsupported file extension (expected one of {}): {}".format(
                ", ".join(SUPPORTED_EXTENSIONS), path
            )
        )
    return target.read_text(encoding="utf-8")


def read_any_text_file(path: str) -> str:
    """Read any text file, regardless of extension (used for inserts)."""
    target = Path(path)
    if not target.is_file():
        raise FileNotFoundError(f"Not a file: {path}")
    return target.read_text(encoding="utf-8")


def write_text_file(path: str, content: str) -> None:
    target = Path(path)
    if target.parent and str(target.parent) != ".":
        target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def rename_text_file(old_path: str, new_path: str, content: str) -> None:
    """Write ``content`` to ``new_path`` and delete ``old_path`` — or neither.

    The document is written under its new name *before* the old file is removed,
    so no failure part-way through can lose it: if the removal fails, the new
    copy is removed again and the original is left exactly as it was. A rename
    that cannot do both leaves the document where it was rather than in two
    places or in none.

    An existing destination is refused rather than overwritten — a different
    document is not something the user asked to lose — and so is a "rename" onto
    the same file (a symlink to it, or a path spelled differently).
    """
    old = Path(old_path)
    new = Path(new_path)
    if not old.is_file():
        raise FileNotFoundError(f"Not a file: {old_path}")
    if os.path.realpath(old) == os.path.realpath(new):
        raise ValueError("The document already has that name")
    if new.exists() or new.is_symlink():
        raise FileExistsError(f"A file already exists: {new_path}")
    write_text_file(new_path, content)
    try:
        old.unlink()
    except OSError:
        # Roll the new copy back so the old name stays the only one holding the
        # document; the original is untouched (it was never opened for writing).
        new.unlink(missing_ok=True)
        raise
