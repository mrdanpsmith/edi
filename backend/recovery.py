"""Putting deleted documents back from their version history.

Shared by Settings › Manage Version History… and File › Open Recent › Manage
Recent Documents…: both offer Recover… for documents that are no longer on
disk, and both ask the same questions when the way back is not clear. The
store's side is ``history.recover``; see ``docs/history.md``.

Every prompt is opened with ``open()``, never ``exec()``, like the rest of the
shell's dialogs: the event loop keeps pumping, which keeps the webview alive and
lets the tests drive each prompt.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFileDialog, QMessageBox, QWidget

from . import history
from .files import missing_folders, missing_volume


def _tilde(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home) :] if path == home or path.startswith(home + os.sep) else path


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


class Recovery:
    """One Recover…: the documents go back a group at a time, then ``done``.

    Documents whose folder is there go straight back. The others are grouped
    by what stands in their way — one missing folder, one disconnected drive,
    or each blocked path on its own — and each group gets one prompt.

    ``done(recovered, problems)`` gets ``(old path, new path)`` for every
    document written back, and a line for each one that could not be.
    """

    def __init__(
        self,
        parent: QWidget,
        statuses: dict[str, str],
        done: Callable[[list[tuple[str, str]], list[str]], None],
    ) -> None:
        self._parent = parent
        self._statuses = statuses
        self._done = done
        self._queue: list[tuple[str, list[str]]] = []
        self._recovered: list[tuple[str, str]] = []
        self._problems: list[str] = []

    def start(self, paths: list[str]) -> None:
        groups: dict[str, list[str]] = {}
        for path in sorted(paths):
            status = self._statuses[path]
            if status == "noDrive":
                key = f"noDrive\0{missing_volume(path)}"
            elif status == "blocked":
                key = f"blocked\0{path}"
            else:
                key = f"{status}\0{os.path.dirname(path)}"
            groups.setdefault(key, []).append(path)
        self._queue = [(key.split("\0", 1)[0], members) for key, members in groups.items()]
        self._next_group()

    def _write(self, path: str, destination: str, make_folders: bool = False) -> None:
        try:
            history.recover(path, destination, make_folders=make_folders)
        except Exception as exc:  # noqa: BLE001 — reported with the others, at the end
            self._problems.append(f"{os.path.basename(path)}: {exc}")
        else:
            self._recovered.append((path, destination))

    def _next_group(self) -> None:
        if not self._queue:
            self._done(self._recovered, self._problems)
            return
        status, paths = self._queue.pop(0)
        if status == "missing":
            for path in paths:
                self._write(path, path)
            self._next_group()
            return
        names = ", ".join(f"“{os.path.basename(path)}”" for path in paths)
        box = QMessageBox(self._parent)
        box.setIcon(QMessageBox.Icon.Question)
        box.setWindowTitle("Recover")
        recreate = None
        if status == "folderMissing":
            folders = missing_folders(paths[0])
            box.setText(f"The folder “{_tilde(os.path.dirname(paths[0]))}” no longer exists.")
            box.setInformativeText(
                f"Recreate it to put {names} back where {'it was' if len(paths) == 1 else 'they were'}? "
                "Edi will create:\n" + "\n".join(f"  {_tilde(folder)}" for folder in folders)
            )
            recreate = box.addButton("Recreate Folder", QMessageBox.ButtonRole.AcceptRole)
        elif status == "noDrive":
            volume = missing_volume(paths[0]) or ""
            box.setText(f"{names} {'was' if len(paths) == 1 else 'were'} on a drive that isn't connected: {volume}")
            box.setInformativeText(
                "Connect the drive and choose Recover again to put "
                f"{'it' if len(paths) == 1 else 'them'} back there, or recover to another folder now."
            )
        else:
            box.setText(f"Something that isn't {names} is now at “{_tilde(paths[0])}”.")
            box.setInformativeText("Edi will not replace it. Recover to another folder instead?")
        elsewhere = box.addButton("Choose Another Folder…", QMessageBox.ButtonRole.ActionRole)
        skip = box.addButton("Skip", QMessageBox.ButtonRole.RejectRole)
        box.setDefaultButton(recreate or elsewhere)
        box.setEscapeButton(skip)

        def answered(button) -> None:
            if recreate is not None and button is recreate:
                for path in paths:
                    self._write(path, path, make_folders=True)
                self._next_group()
            elif button is elsewhere:
                self._choose_folder(paths)
            else:
                self._next_group()

        box.buttonClicked.connect(answered)
        box.setWindowModality(Qt.WindowModality.WindowModal)
        box.finished.connect(lambda _result: box.deleteLater())
        box.open()

    def _choose_folder(self, paths: list[str]) -> None:
        """Recover ``paths`` into a folder the user picks, under their own names."""
        start = Path(paths[0]).parent
        while not start.is_dir() and start != start.parent:
            start = start.parent
        if missing_volume(paths[0]) is not None:
            start = Path.home()
        dialog = QFileDialog(self._parent, "Recover to Folder", str(start))
        dialog.setFileMode(QFileDialog.FileMode.Directory)
        dialog.setOption(QFileDialog.Option.ShowDirsOnly, True)
        dialog.setWindowModality(Qt.WindowModality.WindowModal)

        def done(result) -> None:
            chosen = dialog.selectedFiles() if result else []
            dialog.deleteLater()
            if chosen:
                for path in paths:
                    self._write(path, os.path.join(chosen[0], os.path.basename(path)))
            self._next_group()

        dialog.finished.connect(done)
        dialog.open()


def report_problems(parent: QWidget, problems: list[str]) -> None:
    """Say which documents could not be recovered, if any."""
    if not problems:
        return
    box = QMessageBox(parent)
    box.setIcon(QMessageBox.Icon.Warning)
    box.setWindowTitle("Recover")
    box.setText(f"{_plural(len(problems), 'document')} could not be recovered.")
    box.setInformativeText("\n".join(problems))
    box.addButton(QMessageBox.StandardButton.Ok)
    box.setWindowModality(Qt.WindowModality.WindowModal)
    box.finished.connect(lambda _result: box.deleteLater())
    box.open()
