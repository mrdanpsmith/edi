"""File IO helpers, mirroring the previous Tauri backend commands."""

from __future__ import annotations

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
