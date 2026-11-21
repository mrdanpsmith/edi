"""File › Open Recent › Manage Recent Documents…: every document the recent
list remembers, how it ranks, and the means to open, recover, remove or clear
them.

The shell's own dialog, like Manage Version History: the page can add a granted
path to the list and read the shown list back, but listing or wiping the whole
history is out of its reach. The store is ``backend/recents.py``; see
``docs/preferences.md``. Recover… is the version-history recovery
(``backend/recovery.py``), for documents that were deleted.

Prompts are opened with ``open()``, never ``exec()``, as everywhere in the
shell: the event loop keeps pumping, which keeps the webview alive and lets the
tests drive them.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable

from PySide6.QtCore import QModelIndex, QPersistentModelIndex, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPalette
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QPushButton,
    QStyle,
    QStyleOptionViewItem,
    QTreeWidget,
    QVBoxLayout,
    QWidget,
)

from . import history, recents
from .historymanager import STATUS_LABELS as LOCATION_LABELS
from .historymanager import _DIM_ROLE, _SORT_ROLE, _Delegate, _dot, _dot_icon, _Item, _when
from .recents import Recents
from .recovery import Recovery, _plural, _tilde, report_problems

STATUS_LABELS = {
    "shown": "On the list",
    "tracked": "Not on the list",
    **{status: label for status, label in LOCATION_LABELS.items() if status != "exists"},
}

#: Said after a missing document's status when there is nothing to recover it from.
NO_COPY = "no saved copy"

_PATH_ROLE = Qt.ItemDataRole.UserRole
#: A row's score as a share of the best one's, 0 to 1, for the rank bar.
_SHARE_ROLE = Qt.ItemDataRole.UserRole + 10

_RANK_COLUMN = 1


class _RankDelegate(_Delegate):
    """The history manager's roomy rows, and the rank column drawn as a bar."""

    def paint(self, painter: QPainter, option: QStyleOptionViewItem, index: QModelIndex | QPersistentModelIndex) -> None:
        if index.column() != _RANK_COLUMN:
            super().paint(painter, option, index)
            return
        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        widget = opt.widget
        style = widget.style() if widget else QApplication.style()
        style.drawControl(QStyle.ControlElement.CE_ItemViewItem, opt, painter, widget)
        share = float(index.data(_SHARE_ROLE) or 0.0)
        rect = QRectF(opt.rect).adjusted(6, 0, -6, 0)
        height = 6.0
        track = QRectF(rect.left(), rect.center().y() - height / 2, rect.width(), height)
        selected = bool(opt.state & QStyle.StateFlag.State_Selected)
        role = QPalette.ColorRole.HighlightedText if selected else QPalette.ColorRole.Highlight
        fill = QColor(opt.palette.color(role))
        faint = QColor(fill)
        faint.setAlphaF(0.18)
        painter.save()
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(faint)
        painter.drawRoundedRect(track, height / 2, height / 2)
        if share > 0:
            # At least a dot's width, so a faded document still shows a mark.
            bar = QRectF(track.left(), track.top(), max(track.width() * share, height), height)
            painter.setBrush(fill)
            painter.drawRoundedRect(bar, height / 2, height / 2)
        painter.restore()


class RecentsManager(QDialog):
    """The remembered documents with Open, Recover…, Remove and Clear All….

    ``open_files`` opens documents in the page; ``changed`` is called after the
    history changes, so the page redraws its launcher; ``flash`` says something
    in the status bar; ``store`` is for tests.
    """

    def __init__(
        self,
        parent: QWidget | None,
        *,
        open_files: Callable[[list[str]], None],
        changed: Callable[[], None],
        flash: Callable[[str], None] = lambda _message: None,
        store: Recents | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("Manage Recent Documents")
        self.setWindowModality(Qt.WindowModality.WindowModal)
        self.resize(760, 460)
        self._open_files = open_files
        self._changed = changed
        self._flash = flash
        self._store = store if store is not None else Recents()
        self._documents: dict[str, dict] = {}
        # A recovery in progress, kept alive while its prompts are up.
        self._recovery: Recovery | None = None

        layout = QVBoxLayout(self)
        intro = QLabel(
            f"Ranked by how often and how lately each was opened: an open counts half as much "
            f"after {recents.HALF_LIFE_DAYS:g} days. File › Open Recent and New Tab show the top "
            f"{recents.SHOWN}, always including the {recents.ALWAYS_SHOWN} opened last. "
            "A missing file is left off until it is back, or recovered from its version history."
        )
        intro.setWordWrap(True)
        layout.addWidget(intro)

        self.tree = QTreeWidget()
        self.tree.setRootIsDecorated(False)
        self.tree.setColumnCount(4)
        self.tree.setHeaderLabels(["Document", "Rank", "Opens", "Last opened"])
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.setTextElideMode(Qt.TextElideMode.ElideMiddle)
        self.tree.setSortingEnabled(True)
        self.tree.sortByColumn(_RANK_COLUMN, Qt.SortOrder.DescendingOrder)
        header = self.tree.header()
        header.setStretchLastSection(False)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(_RANK_COLUMN, QHeaderView.ResizeMode.Fixed)
        header.resizeSection(_RANK_COLUMN, 140)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.tree.setItemDelegate(_RankDelegate(self.tree))
        self.tree.itemSelectionChanged.connect(self._selection_changed)
        self.tree.itemDoubleClicked.connect(lambda _item, _column: self._open_selected())
        # Filled: on the list. Hollow grey: remembered, ranked below it. Not on
        # disk: the dots Manage Version History uses for the same statuses.
        self._dots = {"shown": _dot("exists"), "tracked": _dot_icon("#8a8f98", False)}
        self._dots.update({status: _dot(status) for status in LOCATION_LABELS if status != "exists"})
        layout.addWidget(self.tree, 1)

        self.count = QLabel()
        layout.addWidget(self.count)

        buttons = QHBoxLayout()
        self.remove_button = QPushButton("Remove")
        self.remove_button.clicked.connect(self._remove_selected)
        buttons.addWidget(self.remove_button)
        self.clear_button = QPushButton("Clear All…")
        self.clear_button.clicked.connect(lambda: confirm_clear(self, self._store, self._after_clear))
        buttons.addWidget(self.clear_button)
        buttons.addStretch(1)
        self.recover_button = QPushButton("Recover…")
        self.recover_button.clicked.connect(self._start_recovery)
        buttons.addWidget(self.recover_button)
        self.open_button = QPushButton("Open")
        self.open_button.clicked.connect(self._open_selected)
        buttons.addWidget(self.open_button)
        self.close_button = QPushButton("Close")
        self.close_button.clicked.connect(self.close)
        self.close_button.setDefault(True)
        buttons.addWidget(self.close_button)
        layout.addLayout(buttons)

        self.refresh()

    # ── the list ────────────────────────────────────────────────────────────

    def refresh(self) -> None:
        """Read the history again and show it in the current sort order."""
        docs = self._store.history()
        for doc in docs:
            if doc["exists"]:
                doc["status"] = "shown" if doc["shown"] else "tracked"
                doc["recoverable"] = False
            else:
                doc["status"] = history.location_status(doc["path"])
                doc["recoverable"] = history.has_history(doc["path"])
        self._documents = {doc["path"]: doc for doc in docs}
        best = max((doc["score"] for doc in docs), default=0.0)
        now = time.time()
        # Quiet while the rows are replaced; the selection is read once, below.
        self.tree.blockSignals(True)
        sorting = self.tree.isSortingEnabled()
        self.tree.setSortingEnabled(False)
        self.tree.clear()
        for doc in docs:
            self.tree.addTopLevelItem(self._item(doc, best, now))
        self.tree.setSortingEnabled(sorting)
        self.tree.blockSignals(False)
        shown = sum(1 for doc in docs if doc["shown"])
        missing = sum(1 for doc in docs if not doc["exists"])
        self.count.setText(
            "No recent documents."
            if not docs
            else f"{_plural(len(docs), 'document')} remembered, {shown} on the list"
            + (f", {missing} missing" if missing else "")
        )
        self.clear_button.setEnabled(bool(docs))
        self._selection_changed()

    def _label(self, doc: dict) -> str:
        label = STATUS_LABELS[doc["status"]]
        return label if doc["exists"] or doc["recoverable"] else f"{label}, {NO_COPY}"

    def _item(self, doc: dict, best: float, now: float) -> _Item:
        path = doc["path"]
        name = os.path.basename(path) or path
        item = _Item([name, "", str(doc["opens"]), _when(doc["lastOpened"], now)])
        item.setData(0, _PATH_ROLE, path)
        folder = _tilde(os.path.dirname(path))
        # Not on disk: the status said on the row, so a missing document with
        # nothing to recover it from is told apart without a hover.
        item.setData(0, _DIM_ROLE, folder if doc["exists"] else f"{self._label(doc)} · {folder}")
        item.setIcon(0, self._dots[doc["status"]])
        item.setToolTip(0, f"{path}\n{self._label(doc)}")
        item.setData(_RANK_COLUMN, _SHARE_ROLE, doc["score"] / best if best > 0 else 0.0)
        item.setToolTip(_RANK_COLUMN, f"Score {doc['score']:.2f} (an open today counts 1)")
        item.setTextAlignment(2, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        item.setToolTip(3, time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(doc["lastOpened"])))
        # What each column sorts by; a name sorts by its path after it, so two
        # notes.md stay in folder order.
        item.setData(0, _SORT_ROLE, (name.casefold(), path))
        item.setData(_RANK_COLUMN, _SORT_ROLE, doc["score"])
        item.setData(2, _SORT_ROLE, doc["opens"])
        item.setData(3, _SORT_ROLE, doc["lastOpened"])
        return item

    def rows(self) -> list[tuple[str, str]]:
        """Every row as (path, status label), top to bottom as shown."""
        rows = []
        for index in range(self.tree.topLevelItemCount()):
            item = self.tree.topLevelItem(index)
            if item is not None:
                path = item.data(0, _PATH_ROLE)
                rows.append((path, self._label(self._documents[path])))
        return rows

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
        docs = [self._documents[path] for path in self.selected_paths()]
        self.remove_button.setEnabled(bool(docs))
        self.open_button.setEnabled(bool(docs) and all(doc["exists"] for doc in docs))
        self.recover_button.setEnabled(bool(docs) and all(doc["recoverable"] for doc in docs))

    # ── actions ─────────────────────────────────────────────────────────────

    def _remove_selected(self) -> None:
        paths = self.selected_paths()
        if not paths:
            return
        for path in paths:
            self._store.forget(path)
        self.refresh()
        self._changed()

    def _open_selected(self) -> None:
        paths = [path for path in self.selected_paths() if self._documents[path]["exists"]]
        if paths:
            self._open_files(paths)
            self.close()

    def _after_clear(self) -> None:
        self.refresh()
        self._changed()

    def _start_recovery(self) -> None:
        paths = [path for path in self.selected_paths() if self._documents[path]["recoverable"]]
        if not paths:
            return
        statuses = {path: self._documents[path]["status"] for path in paths}
        self._recovery = Recovery(self, statuses, self._finish_recovery)
        self._recovery.start(paths)

    def _finish_recovery(self, recovered: list[tuple[str, str]], problems: list[str]) -> None:
        self._recovery = None
        for old, new in recovered:
            # Put back somewhere else: the rank goes with it, as with a rename.
            self._store.move(old, new)
        if recovered:
            self._open_files([new for _old, new in recovered])
            self._flash(f"Recovered {_plural(len(recovered), 'document')}")
            self._changed()
        self.refresh()
        report_problems(self, problems)


def confirm_clear(parent: QWidget, store: Recents, done: Callable[[], None]) -> QMessageBox:
    """Ask before forgetting every recent document, then clear and call ``done``.

    Shared by the dialog's Clear All… and File › Open Recent › Clear Recent
    Documents…: the ranking is weeks of opens, which a stray click should not
    lose.
    """
    box = QMessageBox(parent)
    box.setIcon(QMessageBox.Icon.Warning)
    box.setWindowTitle("Clear Recent Documents")
    box.setText("Forget every recent document?")
    box.setInformativeText(
        "Open Recent and New Tab start empty, and documents rank from their next open. "
        "The documents themselves are not touched."
    )
    clear = box.addButton("Clear", QMessageBox.ButtonRole.DestructiveRole)
    cancel = box.addButton(QMessageBox.StandardButton.Cancel)
    box.setDefaultButton(cancel)

    def answered(button) -> None:
        if button is clear:
            store.clear()
            done()

    box.buttonClicked.connect(answered)
    box.setWindowModality(Qt.WindowModality.WindowModal)
    box.finished.connect(lambda _result: box.deleteLater())
    box.open()
    return box
