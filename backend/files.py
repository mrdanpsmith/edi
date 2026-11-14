"""File IO helpers, mirroring the previous Tauri backend commands."""

from __future__ import annotations

import codecs
import os
import tempfile
from pathlib import Path

SUPPORTED_EXTENSIONS = ("md", "markdown", "txt", "mermaid", "mmd")


def is_supported_extension(path: str) -> bool:
    return Path(path).suffix.lstrip(".").lower() in SUPPORTED_EXTENSIONS


def resolve_typed_path(text: str, base_dir: str | None) -> str:
    """Turn a path the user typed into an absolute, normalised path.

    Surrounding whitespace and one pair of matching quotes are dropped, so a
    path pasted from a terminal works. ``~`` and ``$VARS`` are expanded. A
    relative path is resolved against ``base_dir`` (the active document's
    folder), or the home directory when there is none. Returns ``""`` for
    blank input. Nothing is checked on disk; see :func:`check_typed_open_path`.
    """
    value = text.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1].strip()
    if not value:
        return ""
    value = os.path.expanduser(os.path.expandvars(value))
    if not os.path.isabs(value):
        value = os.path.join(base_dir or os.path.expanduser("~"), value)
    return os.path.normpath(value)


def check_typed_open_path(path: str) -> str | None:
    """Why ``path`` cannot be opened as a document, or ``None`` if it can."""
    if not path:
        return "Enter a file path."
    if not os.path.exists(path):
        return f"No such file:\n{path}"
    if not os.path.isfile(path):
        return f"Not a file:\n{path}"
    if not is_supported_extension(path):
        return "Unsupported file type (expected one of {}):\n{}".format(
            ", ".join(f".{ext}" for ext in SUPPORTED_EXTENSIONS), path
        )
    return None


def check_rename_target(old_path: str, new_path: str) -> str | None:
    """Why the document at ``old_path`` cannot be renamed or moved to
    ``new_path``, or ``None`` if it can.

    The same refusals :func:`rename_text_file` makes, asked before the prompt
    closes so a typo is corrected there: a folder that does not exist is not
    created, a file already at the destination is not replaced, and the
    document's own path is not a move (a change of case only is).
    """
    if not new_path:
        return "Enter a new name or a path."
    old = Path(old_path)
    new = Path(new_path)
    if os.path.realpath(old) == os.path.realpath(new):
        return "That is the document's current name."
    folder = new.parent
    if not folder.exists():
        return f"No such folder:\n{folder}"
    if not folder.is_dir():
        return f"Not a folder:\n{folder}"
    if (new.exists() or new.is_symlink()) and not _is_case_only_rename(old, new):
        return f"A file already exists there:\n{new_path}"
    return None


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
    # `utf-8-sig` drops a byte-order mark, which would otherwise be read as a
    # `﻿` at the start of the first line (and stop a `# Title` there being a
    # heading). The page always gets `\n` line endings; `write_text_file` puts
    # the file's own back.
    return target.read_text(encoding="utf-8-sig")


def read_any_text_file(path: str) -> str:
    """Read any text file, regardless of extension (used for inserts)."""
    target = Path(path)
    if not target.is_file():
        raise FileNotFoundError(f"Not a file: {path}")
    return target.read_text(encoding="utf-8-sig")


def _file_format(path: Path) -> tuple[str | None, bool]:
    """How an existing file is written: its line ending and whether it has a BOM.

    The line ending is the file's first one, as ``open(newline=…)`` takes it;
    ``None`` (the platform's own) for a file that does not exist or has no line
    break yet, which is what a new file has always been written with.
    """
    try:
        with open(path, "rb") as handle:
            head = handle.read(65536)
    except OSError:
        return None, False
    bom = head.startswith(codecs.BOM_UTF8)
    first = head.find(b"\n")
    if first < 0:
        return None, bom
    return ("\r\n" if head[first - 1 : first] == b"\r" else "\n"), bom


#: Folders that removable drives and network shares are mounted under. A path
#: below one whose mount point is gone is on a drive that isn't connected, and
#: making that folder would put an ordinary folder on the main disk where the
#: drive belongs.
_MOUNT_PARENTS = ("/Volumes", "/media", "/run/media", "/mnt")


def missing_volume(path: str) -> str | None:
    """The mount point ``path`` is on when that mount point is gone, else ``None``.

    macOS ``/Volumes/<name>``, Linux ``/media/<user>/<name>``,
    ``/run/media/<user>/<name>`` and ``/mnt/<name>``, and a Windows drive root."""
    drive, _rest = os.path.splitdrive(path)
    if drive and not os.path.exists(drive + os.sep):
        return drive + os.sep
    parts = Path(path).parts
    for parent in _MOUNT_PARENTS:
        prefix = Path(parent).parts
        if tuple(parts[: len(prefix)]) != prefix:
            continue
        # `/media` and `/run/media` hold a folder per user, then the volume.
        depth = len(prefix) + (2 if parent in ("/media", "/run/media") else 1)
        if len(parts) <= depth:
            return None
        mount = Path(*parts[:depth])
        if not mount.exists():
            return str(mount)
    return None


def missing_folders(path: str) -> list[str]:
    """The folders that would have to be made, outermost first, to put a file at
    ``path``: everything below the nearest folder that still exists."""
    missing: list[str] = []
    folder = Path(path).parent
    while not folder.exists() and folder != folder.parent:
        missing.append(str(folder))
        folder = folder.parent
    return list(reversed(missing))


class FolderMissing(FileNotFoundError):
    """A write into a folder that no longer exists, which the user has not
    agreed to make again. ``folders`` are those it would take, outermost first."""

    def __init__(self, path: str) -> None:
        self.folders = missing_folders(path)
        listed = "\n".join(f"  {folder}" for folder in self.folders)
        super().__init__(
            f"The folder “{os.path.dirname(path)}” no longer exists.\n\nSaving there would create:\n{listed}"
        )


class DriveNotConnected(FileNotFoundError):
    """A write to a drive that isn't connected (``missing_volume``)."""

    def __init__(self, volume: str) -> None:
        self.volume = volume
        super().__init__(f"The drive {volume} isn't connected")


def check_folder(path: str, make_folders: bool = False) -> None:
    """Make sure a file can be written at ``path``: its folder is there, or is
    made when ``make_folders`` says the user agreed to it. Never on a drive that
    isn't connected (``DriveNotConnected``); otherwise ``FolderMissing``."""
    folder = Path(path).parent
    if folder.is_dir():
        return
    volume = missing_volume(path)
    if volume is not None:
        raise DriveNotConnected(volume)
    if not make_folders:
        raise FolderMissing(path)
    folder.mkdir(parents=True)


def write_text_file(path: str, content: str, *, like: str | None = None, make_folders: bool = False) -> None:
    """Write ``content`` so the file on disk is always the old or the new text.

    The text goes to a temporary file beside the target, is flushed to disk and
    then renamed over it, so a crash or a full disk mid-save never leaves a
    truncated document. A symlinked target is written through to the file it
    points at, and an existing file keeps its permissions.

    It also keeps its *format*: the line endings and byte-order mark of the file
    being replaced (or of ``like``, the file a rename moves), so saving a CRLF
    file on macOS, or an LF one on Windows, does not rewrite every line.

    A folder that is gone is made again only with ``make_folders``, and never
    on a drive that isn't connected (``check_folder``): a document whose folder
    was deleted, or whose drive was unplugged, is not silently written into a
    new tree of folders on the main disk.
    """
    target = Path(os.path.realpath(path))
    check_folder(str(target), make_folders)
    try:
        mode = target.stat().st_mode & 0o7777
    except FileNotFoundError:
        mode = None
    newline, bom = _file_format(Path(os.path.realpath(like)) if like else target)
    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig" if bom else "utf-8", newline=newline) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(tmp_name, mode)
        else:
            # mkstemp creates 0600; give a new file the usual umask-derived mode.
            umask = os.umask(0)
            os.umask(umask)
            os.chmod(tmp_name, 0o666 & ~umask)
        os.replace(tmp_name, target)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def _is_case_only_rename(old: Path, new: Path) -> bool:
    """The same folder, a name differing only in case, naming this very file."""
    if old.parent != new.parent or old.name == new.name or old.name.casefold() != new.name.casefold():
        return False
    try:
        return os.path.samefile(old, new)
    except OSError:
        return False


def rename_text_file(old_path: str, new_path: str, content: str) -> None:
    """Write ``content`` to ``new_path`` and delete ``old_path`` — or neither.

    The document is written under its new name *before* the old file is removed,
    so no failure part-way through can lose it: if the removal fails, the new
    copy is removed again and the original is left exactly as it was. A rename
    that cannot do both leaves the document where it was rather than in two
    places or in none.

    An existing destination is refused rather than overwritten — a different
    document is not something the user asked to lose — and so is a "rename" onto
    the same file (a symlink to it, or a path spelled differently). The new path
    may be in another folder (a move), but that folder must already exist.
    """
    old = Path(old_path)
    new = Path(new_path)
    if not old.is_file():
        raise FileNotFoundError(f"Not a file: {old_path}")
    if os.path.realpath(old) == os.path.realpath(new):
        raise ValueError("The document already has that name")
    if _is_case_only_rename(old, new):
        # `Foo.md` → `foo.md` on a case-insensitive filesystem (macOS, Windows):
        # the "new" name already exists because it *is* this file, so it is
        # written in place and then renamed, which only changes the spelling.
        write_text_file(old_path, content)
        os.replace(old, new)
        return
    if new.exists() or new.is_symlink():
        raise FileExistsError(f"A file already exists: {new_path}")
    # A move goes into a folder that is there; it does not create one (a typo
    # in the folder would otherwise become a new tree of folders).
    if not new.parent.is_dir():
        raise FileNotFoundError(f"No such folder: {new.parent}")
    write_text_file(new_path, content, like=old_path)
    try:
        old.unlink()
    except OSError:
        # Roll the new copy back so the old name stays the only one holding the
        # document; the original is untouched (it was never opened for writing).
        new.unlink(missing_ok=True)
        raise
