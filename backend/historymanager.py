"""File › Manage Version History…: every document Edi keeps a history for, and
what to do with each one — recover a deleted document, or delete histories.

This is the shell's own dialog, never the page's, for the reason the old Clear
Version History dialog was: listing every stored path, deleting histories and
writing recovered files are out of reach of anything running in the page. The
store's side is ``backend/history.py``; see ``docs/history.md``.

Every prompt is opened with ``open()``, never ``exec()``, like the rest of the
shell's dialogs: the event loop keeps pumping, which keeps the webview alive and
lets the tests drive each prompt.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QDialog,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from . import history

STATUS_LABELS = {
    "exists": "On disk",
    "missing": "Missing",
    "folderMissing": "Folder missing",
    "noDrive": "Drive not connected",
    "blocked": "Something else there",
}

#: The filter's choices: its label, and which statuses it shows.
FILTERS = (
    ("All documents", None),
    ("Missing from disk", {"missing", "folderMissing", "noDrive", "blocked"}),
    ("On disk", {"exists"}),
)

#: The most of a version the preview shows.
PREVIEW_BYTES = 200_000

_PATH_ROLE = Qt.ItemDataRole.UserRole


def _tilde(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home) :] if path == home or path.startswith(home + os.sep) else path


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


class HistoryManager(QDialog):
    """The documents with history, a preview of the selected one's newest
    version, and the two things to do with a selection: Recover… and Delete
    History….

    ``open_files`` opens recovered documents in the page (and grants them, as the
    OS opening a document does); ``flash`` says something in the status bar;
    ``watched`` names the documents open in Edi now.
    """

    def __init__(
        self,
        parent: QWidget | None,
        *,
        open_files: Callable[[list[str]], None],
        flash: Callable[[str], None],
        watched: Callable[[], list[str]],
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("Manage Version History")
        self.setWindowModality(Qt.WindowModality.WindowModal)
        self.resize(860, 520)
        self._open_files = open_files
        self._flash = flash
        self._watched = watched
        self._documents: dict[str, dict] = {}
        # A recovery in progress: groups still to ask about, and how it went.
        self._queue: list[tuple[str, list[str]]] = []
        self._recovered: list[str] = []
        self._problems: list[str] = []

        layout = QVBoxLayout(self)

        top = QHBoxLayout()
        top.addWidget(QLabel("Show:"))
        self.filter = QComboBox()
        for label, _statuses in FILTERS:
            self.filter.addItem(label)
        self.filter.currentIndexChanged.connect(lambda _index: self._fill())
        top.addWidget(self.filter)
        top.addStretch(1)
        self.count = QLabel()
        top.addWidget(self.count)
        layout.addLayout(top)

        self.tree = QTreeWidget()
        self.tree.setColumnCount(5)
        self.tree.setHeaderLabels(["Document", "Folder", "Status", "Versions", "Last version"])
        self.tree.setRootIsDecorated(False)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.setSortingEnabled(True)
        self.tree.header().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.tree.itemSelectionChanged.connect(self._selection_changed)

        self.preview = QPlainTextEdit()
        self.preview.setReadOnly(True)
        self.preview.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont))
        self.preview.setPlaceholderText("Select a document to see its newest version.")

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self.tree)
        splitter.addWidget(self.preview)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        layout.addWidget(splitter, 1)

        hint = QLabel(
            "Moved or renamed a folder outside Edi? Its documents show here as missing. "
            "Open them where they are now instead: their history follows them."
        )
        hint.setWordWrap(True)
        layout.addWidget(hint)

        buttons = QHBoxLayout()
        self.delete_button = QPushButton("Delete History…")
        self.delete_button.clicked.connect(self._confirm_delete)
        buttons.addWidget(self.delete_button)
        buttons.addStretch(1)
        self.recover_button = QPushButton("Recover…")
        self.recover_button.clicked.connect(self._start_recovery)
        buttons.addWidget(self.recover_button)
        self.close_button = QPushButton("Close")
        self.close_button.clicked.connect(self.close)
        self.close_button.setDefault(True)
        buttons.addWidget(self.close_button)
        layout.addLayout(buttons)

        self.refresh()

    # ── the list ────────────────────────────────────────────────────────────

    def refresh(self) -> None:
        """Read the store again and show it under the current filter."""
        self._documents = {doc["path"]: doc for doc in history.stored_documents() if doc["path"]}
        self._fill()

    def _fill(self) -> None:
        statuses = FILTERS[self.filter.currentIndex()][1]
        # Quiet while the rows are replaced: clearing a selection of documents
        # the store no longer has would report it, and the selection is read
        # once, below, when the list is whole again.
        self.tree.blockSignals(True)
        self.tree.setSortingEnabled(False)
        self.tree.clear()
        shown = 0
        for path, doc in self._documents.items():
            if statuses is not None and doc["status"] not in statuses:
                continue
            status: str = doc["status"]
            columns: list[str] = [
                os.path.basename(path),
                _tilde(os.path.dirname(path)),
                STATUS_LABELS.get(status) or status,
                str(doc["versions"]),
                time.strftime("%Y-%m-%d %H:%M", time.localtime(doc["time"])) if doc["time"] else "",
            ]
            item = QTreeWidgetItem(columns)
            item.setData(0, _PATH_ROLE, path)
            item.setToolTip(1, path)
            item.setTextAlignment(3, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.tree.addTopLevelItem(item)
            shown += 1
        self.tree.setSortingEnabled(True)
        self.tree.sortByColumn(4, Qt.SortOrder.DescendingOrder)
        self.tree.blockSignals(False)
        total = len(self._documents)
        self.count.setText(
            "No document has any version history yet."
            if total == 0
            else f"{shown} of {_plural(total, 'document')}"
        )
        self._selection_changed()

    def selected_paths(self) -> list[str]:
        return [item.data(0, _PATH_ROLE) for item in self.tree.selectedItems()]

    def select(self, paths: list[str]) -> None:
        """Select exactly these documents (as a click would)."""
        wanted = set(paths)
        self.tree.clearSelection()
        for index in range(self.tree.topLevelItemCount()):
            item = self.tree.topLevelItem(index)
            if item is not None and item.data(0, _PATH_ROLE) in wanted:
                item.setSelected(True)

    def _selection_changed(self) -> None:
        paths = self.selected_paths()
        self.delete_button.setEnabled(bool(paths))
        # Only a document no longer on disk can be recovered: one that is there
        # is opened, and its versions restored, in Version History.
        self.recover_button.setEnabled(
            bool(paths) and all(self._documents[path]["status"] != "exists" for path in paths)
        )
        if len(paths) != 1:
            self.preview.setPlainText("" if not paths else f"{_plural(len(paths), 'document')} selected.")
            return
        data = history.latest_bytes(paths[0])
        if data is None:
            self.preview.setPlainText("")
            return
        text = data[:PREVIEW_BYTES].decode("utf-8-sig", "replace").replace("\r\n", "\n")
        if len(data) > PREVIEW_BYTES:
            text += "\n…"
        self.preview.setPlainText(text)

    # ── deleting ────────────────────────────────────────────────────────────

    def _confirm_delete(self) -> None:
        paths = self.selected_paths()
        if not paths:
            return
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("Delete History")
        box.setText(f"Delete the version history of {_plural(len(paths), 'document')}?")
        box.setInformativeText(
            "The documents themselves are not touched. One open in Edi keeps its file as it "
            "is now as the first version of a new history. This cannot be undone."
        )
        delete = box.addButton("Delete History", QMessageBox.ButtonRole.DestructiveRole)
        cancel = box.addButton(QMessageBox.StandardButton.Cancel)
        box.setDefaultButton(cancel)

        def answered(button) -> None:
            if button is delete:
                removed = history.remove_histories(paths, keep=self._watched())
                self._flash(f"Deleted the history of {_plural(removed, 'document')}")
                self.refresh()

        box.buttonClicked.connect(answered)
        box.setWindowModality(Qt.WindowModality.WindowModal)
        box.finished.connect(lambda _result: box.deleteLater())
        box.open()

    # ── recovering ──────────────────────────────────────────────────────────

    def _start_recovery(self) -> None:
        """Recover the selected documents, a group at a time.

        Documents whose folder is there go straight back. The others are grouped
        by what stands in their way — one missing folder, one disconnected
        drive, or each blocked path on its own — and each group gets one prompt.
        """
        paths = [path for path in self.selected_paths() if self._documents[path]["status"] != "exists"]
        groups: dict[str, list[str]] = {}
        for path in sorted(paths):
            status = self._documents[path]["status"]
            if status == "noDrive":
                key = f"noDrive\0{history.missing_volume(path)}"
            elif status == "blocked":
                key = f"blocked\0{path}"
            else:
                key = f"{status}\0{os.path.dirname(path)}"
            groups.setdefault(key, []).append(path)
        self._queue = [(key.split("\0", 1)[0], members) for key, members in groups.items()]
        self._recovered = []
        self._problems = []
        self._next_group()

    def _write(self, path: str, destination: str, make_folders: bool = False) -> None:
        try:
            history.recover(path, destination, make_folders=make_folders)
        except Exception as exc:  # noqa: BLE001 — reported with the others, at the end
            self._problems.append(f"{os.path.basename(path)}: {exc}")
        else:
            self._recovered.append(destination)

    def _next_group(self) -> None:
        if not self._queue:
            self._finish_recovery()
            return
        status, paths = self._queue.pop(0)
        if status == "missing":
            for path in paths:
                self._write(path, path)
            self._next_group()
            return
        names = ", ".join(f"“{os.path.basename(path)}”" for path in paths)
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Question)
        box.setWindowTitle("Recover")
        recreate = None
        if status == "folderMissing":
            folders = history.missing_folders(paths[0])
            box.setText(f"The folder “{_tilde(os.path.dirname(paths[0]))}” no longer exists.")
            box.setInformativeText(
                f"Recreate it to put {names} back where {'it was' if len(paths) == 1 else 'they were'}? "
                "Edi will create:\n" + "\n".join(f"  {_tilde(folder)}" for folder in folders)
            )
            recreate = box.addButton("Recreate Folder", QMessageBox.ButtonRole.AcceptRole)
        elif status == "noDrive":
            volume = history.missing_volume(paths[0]) or ""
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
        if history.missing_volume(paths[0]) is not None:
            start = Path.home()
        dialog = QFileDialog(self, "Recover to Folder", str(start))
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

    def _finish_recovery(self) -> None:
        recovered = self._recovered
        if recovered:
            self._open_files(recovered)
            self._flash(f"Recovered {_plural(len(recovered), 'document')}")
        self.refresh()
        if self._problems:
            box = QMessageBox(self)
            box.setIcon(QMessageBox.Icon.Warning)
            box.setWindowTitle("Recover")
            box.setText(f"{_plural(len(self._problems), 'document')} could not be recovered.")
            box.setInformativeText("\n".join(self._problems))
            box.addButton(QMessageBox.StandardButton.Ok)
            box.setWindowModality(Qt.WindowModality.WindowModal)
            box.finished.connect(lambda _result: box.deleteLater())
            box.open()
