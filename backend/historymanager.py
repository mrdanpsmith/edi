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
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

from PySide6.QtCore import QModelIndex, QPersistentModelIndex, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QFontDatabase, QFontMetrics, QIcon, QPainter, QPalette, QPen, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
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
    QStyle,
    QStyledItemDelegate,
    QStyleOptionViewItem,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from . import history
from .files import missing_folders, missing_volume

STATUS_LABELS = {
    "exists": "On disk",
    "missing": "Missing",
    "folderMissing": "Folder missing",
    "noDrive": "Drive not connected",
    "blocked": "Something else there",
}

_NOT_ON_DISK = {"missing", "folderMissing", "noDrive", "blocked"}

#: The filter's choices: its label, and which documents it shows, given a
#: document and whether it is in a temporary folder.
FILTERS: tuple[tuple[str, Callable[[dict, bool], bool]], ...] = (
    ("All documents", lambda _doc, _temp: True),
    ("Missing from disk", lambda doc, _temp: doc["status"] in _NOT_ON_DISK),
    ("On disk", lambda doc, _temp: doc["status"] == "exists"),
    ("Temporary files", lambda _doc, temp: temp),
)

#: The one row every document in a temporary folder is grouped under.
TEMPORARY_LABEL = "Temporary files"

#: The most of a version the preview shows.
PREVIEW_BYTES = 200_000

#: A document row's path; folder rows have none.
_PATH_ROLE = Qt.ItemDataRole.UserRole
#: A document row's status key (``exists``, ``missing``…).
_STATUS_ROLE = Qt.ItemDataRole.UserRole + 1
#: What a column sorts by, which is not always what it shows.
_SORT_ROLE = Qt.ItemDataRole.UserRole + 2
#: Text drawn dimmed after a row's own, in the first column: a folder's parent,
#: or a temporary document's folder.
_DIM_ROLE = Qt.ItemDataRole.UserRole + 3

#: Extra height per row, over the style's own, so the list is not packed tight.
_ROW_PADDING = 6

#: Statuses that belong to the folder rather than the document: every document
#: in it shares them, so the folder row says so once.
_FOLDER_STATUSES = ("folderMissing", "noDrive")

#: The dot beside a document: its colour, and whether it is filled.
_DOTS = {
    "exists": ("#8a8f98", True),
    "missing": ("#d08700", False),
    "folderMissing": ("#d08700", False),
    "noDrive": ("#d08700", False),
    "blocked": ("#d0453a", True),
}


class _Item(QTreeWidgetItem):
    """A row that sorts by ``_SORT_ROLE``: names without case, times as numbers."""

    def __lt__(self, other: QTreeWidgetItem) -> bool:
        column = self.treeWidget().sortColumn() if self.treeWidget() else 0
        return self.data(column, _SORT_ROLE) < other.data(column, _SORT_ROLE)


def _dot(status: str) -> QIcon:
    color, filled = _DOTS.get(status, ("#8a8f98", True))
    size = 16
    pixmap = QPixmap(size * 2, size * 2)
    pixmap.setDevicePixelRatio(2)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setPen(QPen(QColor(color), 1.5))
    painter.setBrush(QColor(color) if filled else Qt.BrushStyle.NoBrush)
    painter.drawEllipse(QRectF(4.5, 4.5, 7, 7))
    painter.end()
    return QIcon(pixmap)


class _Delegate(QStyledItemDelegate):
    """Roomier rows, and a row's ``_DIM_ROLE`` text drawn after its own in the
    placeholder colour, elided in the middle to whatever room is left."""

    def sizeHint(self, option: QStyleOptionViewItem, index: QModelIndex | QPersistentModelIndex) -> QSize:
        size = super().sizeHint(option, index)
        return QSize(size.width(), size.height() + _ROW_PADDING)

    def paint(self, painter: QPainter, option: QStyleOptionViewItem, index: QModelIndex | QPersistentModelIndex) -> None:
        dim = index.data(_DIM_ROLE)
        if not dim:
            super().paint(painter, option, index)
            return
        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        widget = opt.widget
        style = widget.style() if widget else QApplication.style()
        # The room for text, measured while the row still has its text; then
        # the row is drawn without it (background, selection, icon) and both
        # parts of the text are drawn here.
        rect = style.subElementRect(QStyle.SubElement.SE_ItemViewItemText, opt, widget).adjusted(2, 0, -2, 0)
        text = opt.text
        opt.text = ""
        style.drawControl(QStyle.ControlElement.CE_ItemViewItem, opt, painter, widget)

        selected = bool(opt.state & QStyle.StateFlag.State_Selected)
        palette = opt.palette
        main = palette.color(QPalette.ColorRole.HighlightedText if selected else QPalette.ColorRole.Text)
        if selected:
            faint = QColor(main)
            faint.setAlphaF(0.7)
        else:
            faint = palette.color(QPalette.ColorRole.PlaceholderText)
        metrics = QFontMetrics(opt.font)
        name = metrics.elidedText(text, Qt.TextElideMode.ElideMiddle, rect.width())
        painter.save()
        painter.setFont(opt.font)
        painter.setPen(main)
        flags = Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter
        painter.drawText(rect, flags, name)
        rest = rect.adjusted(metrics.horizontalAdvance(name + "   "), 0, 0, 0)
        if rest.width() > metrics.horizontalAdvance("……"):
            painter.setPen(faint)
            painter.drawText(rest, flags, metrics.elidedText(dim, Qt.TextElideMode.ElideMiddle, rest.width()))
        painter.restore()


def _temp_roots() -> tuple[str, ...]:
    """Where the system keeps temporary files, as the store spells paths."""
    roots = {os.path.realpath(tempfile.gettempdir())}
    if os.name != "nt":
        roots |= {"/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"}
    return tuple(sorted(roots))


def _temp_root(path: str, roots: tuple[str, ...]) -> str | None:
    """The temporary root ``path`` is below, if any (the deepest one)."""
    found = [root for root in roots if path.startswith(root.rstrip(os.sep) + os.sep)]
    return max(found, key=len) if found else None


def _when(stamp: float, now: float | None = None) -> str:
    """A version's time the short way: today's and yesterday's by the clock,
    this year's by the day, older ones by the date."""
    moment = time.localtime(stamp)
    today = time.localtime(now if now is not None else time.time())
    yesterday = time.localtime((now if now is not None else time.time()) - 86_400)
    day = moment[:3]
    if day == today[:3]:
        return time.strftime("Today %H:%M", moment)
    if day == yesterday[:3]:
        return time.strftime("Yesterday %H:%M", moment)
    if moment.tm_year == today.tm_year:
        return f"{time.strftime('%b', moment)} {moment.tm_mday}"
    return time.strftime("%Y-%m-%d", moment)


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
        # Most of the window it belongs to, not a fixed size: a long store
        # needs the rows, and the preview the width.
        width, height = 860, 520
        if parent is not None:
            width = max(width, int(parent.width() * 0.8))
            height = max(height, int(parent.height() * 0.8))
        self.resize(width, height)
        self._temp_roots = _temp_roots()
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

        # Documents grouped under their folder: the folder is said once, not on
        # every row, and a missing folder or drive is said on the folder.
        self.tree = QTreeWidget()
        self.tree.setColumnCount(2)
        self.tree.setHeaderLabels(["Document", "History"])
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.setTextElideMode(Qt.TextElideMode.ElideMiddle)
        self.tree.setSortingEnabled(True)
        header = self.tree.header()
        header.setStretchLastSection(False)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.tree.setItemDelegate(_Delegate(self.tree))
        self.tree.itemSelectionChanged.connect(self._selection_changed)
        self._folder_icon = self.style().standardIcon(QStyle.StandardPixmap.SP_DirIcon)
        self._dots = {status: _dot(status) for status in _DOTS}

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
        shows = FILTERS[self.filter.currentIndex()][1]
        # Quiet while the rows are replaced: clearing a selection of documents
        # the store no longer has would report it, and the selection is read
        # once, below, when the list is whole again.
        self.tree.blockSignals(True)
        self.tree.setSortingEnabled(False)
        self.tree.clear()
        shown = 0
        now = time.time()
        folders: dict[str, list[str]] = {}
        temporary: list[str] = []
        for path, doc in self._documents.items():
            temp = _temp_root(path, self._temp_roots) is not None
            if not shows(doc, temp):
                continue
            if temp:
                temporary.append(path)
            else:
                folders.setdefault(os.path.dirname(path), []).append(path)
        for folder, paths in folders.items():
            # The folder's own name first, its parent dimmed after it.
            name = os.path.basename(folder) or folder
            parent = self._group_item(name, paths)
            parent.setData(0, _DIM_ROLE, _tilde(os.path.dirname(folder)) if os.path.basename(folder) else "")
            parent.setToolTip(0, folder)
            parent.setIcon(0, self._folder_icon)
            shared = {self._documents[path]["status"] for path in paths}
            if len(shared) == 1 and (status := shared.pop()) in _FOLDER_STATUSES:
                parent.setText(1, STATUS_LABELS[status])
            for path in paths:
                parent.addChild(self._document_item(path, self._documents[path], now))
            shown += len(paths)
            self.tree.addTopLevelItem(parent)
            parent.setExpanded(True)
        if temporary:
            # Scratch files from other tools: one row, folded away unless asked
            # for, so they do not bury the documents that matter.
            parent = self._group_item(TEMPORARY_LABEL, temporary)
            parent.setToolTip(0, "Documents in the system's temporary folders")
            parent.setIcon(0, self._folder_icon)
            parent.setText(1, _plural(len(temporary), "document"))
            for path in temporary:
                item = self._document_item(path, self._documents[path], now)
                root = _temp_root(path, self._temp_roots) or ""
                item.setData(0, _DIM_ROLE, os.path.dirname(path)[len(root) :].lstrip(os.sep))
                parent.addChild(item)
            shown += len(temporary)
            self.tree.addTopLevelItem(parent)
            parent.setExpanded(not folders)
        self.tree.setSortingEnabled(True)
        self.tree.sortByColumn(1, Qt.SortOrder.DescendingOrder)
        self.tree.blockSignals(False)
        total = len(self._documents)
        self.count.setText(
            "No document has any version history yet."
            if total == 0
            else f"{shown} of {_plural(total, 'document')}"
        )
        self._selection_changed()

    def _group_item(self, label: str, paths: list[str]) -> QTreeWidgetItem:
        item = _Item([label, ""])
        item.setData(0, _SORT_ROLE, label.casefold())
        item.setData(1, _SORT_ROLE, max(self._documents[path]["time"] or 0 for path in paths))
        return item

    def _document_item(self, path: str, doc: dict, now: float) -> QTreeWidgetItem:
        status: str = doc["status"]
        when = _when(doc["time"], now) if doc["time"] else ""
        item = _Item([os.path.basename(path), " · ".join(filter(None, [_plural(doc["versions"], "version"), when]))])
        if doc["time"]:
            item.setToolTip(1, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(doc["time"])))
        item.setIcon(0, self._dots.get(status) or self._dots["exists"])
        item.setToolTip(0, f"{path}\n{STATUS_LABELS.get(status) or status}")
        item.setData(0, _PATH_ROLE, path)
        item.setData(0, _STATUS_ROLE, status)
        item.setData(0, _SORT_ROLE, os.path.basename(path).casefold())
        item.setData(1, _SORT_ROLE, doc["time"] or 0)
        return item

    def _document_items(self):
        for index in range(self.tree.topLevelItemCount()):
            folder = self.tree.topLevelItem(index)
            if folder is None:
                continue
            for child in range(folder.childCount()):
                yield folder.child(child)

    def selected_paths(self) -> list[str]:
        """The selected documents; a selected folder stands for all of its own."""
        paths: dict[str, None] = {}
        for item in self.tree.selectedItems():
            members = [item] if item.parent() else [item.child(i) for i in range(item.childCount())]
            for member in members:
                paths[member.data(0, _PATH_ROLE)] = None
        return list(paths)

    def select(self, paths: list[str]) -> None:
        """Select exactly these documents (as a click would)."""
        wanted = set(paths)
        self.tree.clearSelection()
        for item in self._document_items():
            if item.data(0, _PATH_ROLE) in wanted:
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
                key = f"noDrive\0{missing_volume(path)}"
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
