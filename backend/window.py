"""Main window: native Qt shell hosting the frontend in a webview."""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QFile, QUrl, Qt
from PySide6.QtGui import QIcon
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineScript, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QFileDialog, QMainWindow, QMessageBox

from .bridge import Bridge

DIST_DIR = Path(__file__).resolve().parent.parent / "dist"

CONFIRM_QUIT_MESSAGE = "Unsaved changes will be lost. Quit anyway?"

_QWEBCHANNEL_JS = Path(__file__).resolve().parent / "qwebchannel.js"


def _find_icon() -> Path | None:
    """Locate the app icon (source tree, packaged, or container layout)."""
    meipass = getattr(sys, "_MEIPASS", None)
    candidates = [
        Path(meipass) / "assets" / "app-icon.png" if meipass else None,
        Path(__file__).resolve().parent.parent / "scripts" / "assets" / "app-icon.png",
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    return None


def load_app_icon() -> QIcon | None:
    """Return the Edi icon, or ``None`` if it is not bundled."""
    icon_path = _find_icon()
    if icon_path is None:
        return None
    icon = QIcon(str(icon_path))
    return icon if not icon.isNull() else None


def _load_qwebchannel_js() -> str:
    """Source of ``QWebChannel`` for the page.

    PySide6 6.11 no longer bundles the ``:/qtwebchannel/qwebchannel.js`` Qt
    resource, so prefer the vendored copy shipped with this app and fall back
    to the resource on older PySide6 versions that still provide it.
    """
    if _QWEBCHANNEL_JS.exists():
        return _QWEBCHANNEL_JS.read_text(encoding="utf-8")
    qwebchannel_js = QFile(":/qtwebchannel/qwebchannel.js")
    if qwebchannel_js.open(QFile.OpenModeFlag.ReadOnly):
        return str(qwebchannel_js.readAll(), "utf-8")
    raise FileNotFoundError("qwebchannel.js not found (vendored copy or Qt resource)")


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Edi")
        icon = load_app_icon()
        if icon is not None:
            self.setWindowIcon(icon)
        self._dirty = False
        self._allow_close = False

        self._bridge = Bridge(self)
        self._web = QWebEngineView()
        self._web.setPage(QWebEnginePage(self._web))
        self._setup_web()
        self.setCentralWidget(self._web)

    def _setup_web(self) -> None:
        settings = self._web.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        settings.setAttribute(
            QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True
        )

        channel = QWebChannel(self._web)
        channel.registerObject("bridge", self._bridge)
        self._web.page().setWebChannel(channel)

        script = QWebEngineScript()
        script.setName("qwebchannel")
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        script.setSourceCode(_load_qwebchannel_js())
        self._web.page().scripts().insert(script)

        self._web.load(QUrl.fromLocalFile(str(DIST_DIR / "index.html")))

    def set_dirty(self, dirty: bool) -> None:
        self._dirty = dirty

    def is_dirty(self) -> bool:
        return self._dirty

    def confirm(self, message: str, callback=None) -> None:
        """Show a non-blocking centered Yes/No dialog.

        ``callback(accepted: bool)`` runs when the user answers. Non-blocking
        (``open()`` instead of ``exec()``) so the Qt event loop keeps pumping,
        which both lets tests drive the dialog and keeps the webview alive.
        """
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("Edi")
        box.setText(message)
        yes = box.addButton(QMessageBox.StandardButton.Yes)
        box.addButton(QMessageBox.StandardButton.No)
        box.setDefaultButton(QMessageBox.StandardButton.No)
        box.setWindowModality(Qt.WindowModality.WindowModal)
        # Center on the window frame explicitly: some desktop environments do
        # not center parented dialogs, and the previous stack's dialog could
        # end up off-screen.
        box.adjustSize()
        frame = box.frameGeometry()
        frame.moveCenter(self.frameGeometry().center())
        box.move(frame.topLeft())

        def done(_result) -> None:
            box.deleteLater()
            if callback is not None:
                callback(box.clickedButton() == yes)

        box.finished.connect(done)
        box.open()

    def _run_dialog(self, dialog: QFileDialog, callback=None) -> None:
        """Open a file dialog non-blocking and report the chosen path.

        ``callback(path: str | None)`` runs on accept (selected file) or cancel
        (``None``). Non-blocking (``open()``) so the event loop keeps pumping.
        """
        dialog.setWindowModality(Qt.WindowModality.WindowModal)

        def done(result) -> None:
            selected = dialog.selectedFiles()
            value = selected[0] if result and selected else None
            dialog.deleteLater()
            if callback is not None:
                callback(value)

        dialog.finished.connect(done)
        dialog.open()

    def pick_open_path(self, callback=None) -> None:
        dialog = QFileDialog(self, "Open document")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptOpen)
        dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
        dialog.setNameFilter("Markdown documents (*.md *.markdown *.txt *.mermaid);;All files (*)")
        self._run_dialog(dialog, callback)

    def pick_save_path(self, default_name, callback=None) -> None:
        dialog = QFileDialog(self, "Save document")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptSave)
        dialog.setNameFilter("Markdown documents (*.md *.markdown *.txt *.mermaid);;All files (*)")
        dialog.selectFile(f"{default_name}.md")
        self._run_dialog(dialog, callback)

    def pick_export_path(self, default_name, callback=None) -> None:
        dialog = QFileDialog(self, "Export HTML")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptSave)
        dialog.setNameFilter("HTML documents (*.html *.htm);;All files (*)")
        dialog.selectFile(f"{default_name}.html")
        self._run_dialog(dialog, callback)

    def closeEvent(self, event) -> None:
        if self._dirty and not self._allow_close:
            event.ignore()
            self.confirm(CONFIRM_QUIT_MESSAGE, callback=self._confirm_quit)
            return
        self._allow_close = True
        event.accept()

    def _confirm_quit(self, accepted: bool) -> None:
        if accepted:
            self._allow_close = True
            self.close()

    def showEvent(self, event) -> None:
        super().showEvent(event)
        self._allow_close = False
