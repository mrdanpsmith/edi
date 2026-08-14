"""Main window: native Qt shell hosting the frontend in a webview."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PySide6.QtCore import QFile, QUrl, Qt
from PySide6.QtGui import QAction, QIcon, QPixmap
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineScript, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QLabel,
    QMainWindow,
    QMessageBox,
    QVBoxLayout,
)

from . import __version__
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


def _find_logo() -> Path | None:
    """Locate the about-dialog logo (source tree or packaged)."""
    meipass = getattr(sys, "_MEIPASS", None)
    candidates = [
        Path(meipass) / "assets" / "edi-logo.png" if meipass else None,
        Path(__file__).resolve().parent.parent / "assets" / "edi-logo.png",
        Path(meipass) / "assets" / "app-icon.png" if meipass else None,
        Path(__file__).resolve().parent.parent / "scripts" / "assets" / "app-icon.png",
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    return None


def load_about_logo(max_size: int = 180) -> QPixmap | None:
    """Return the about-dialog logo scaled to fit ``max_size``, or ``None``.

    Falls back to the app icon so the dialog still shows a graphic even if the
    dedicated logo is missing (e.g. an older packaged build).
    """
    logo_path = _find_logo()
    if logo_path is None:
        return None
    pixmap = QPixmap(str(logo_path))
    if pixmap.isNull():
        return None
    return pixmap.scaled(
        max_size,
        max_size,
        Qt.AspectRatioMode.KeepAspectRatio,
        Qt.TransformationMode.SmoothTransformation,
    )


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
        self._revert_action = None
        self._preview_action = None
        self._formatting_action = None

        self._bridge = Bridge(self)
        self._web = QWebEngineView()
        self._web.setPage(QWebEnginePage(self._web))
        self._setup_web()
        self.setCentralWidget(self._web)
        self._build_menus()

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

    def _build_menus(self) -> None:
        menubar = self.menuBar()

        # Keep Python references: PySide6 hands ownership of addMenu() results
        # to Python, and dropping them garbage-collects the C++ menus.
        self._file_menu = menubar.addMenu("&File")
        file_menu = self._file_menu
        for label, command in (
            ("&New\tCtrl+N", "new"),
            ("&Open…\tCtrl+O", "open"),
            ("&Save\tCtrl+S", "save"),
            ("Save &As…\tCtrl+Shift+S", "saveAs"),
        ):
            action = QAction(label, self)
            action.triggered.connect(lambda _checked=False, cmd=command: self._menu_command(cmd))
            file_menu.addAction(action)

        self._revert_action = QAction("&Revert", self)
        self._revert_action.setEnabled(False)
        self._revert_action.triggered.connect(
            lambda _checked=False: self._menu_command("revert")
        )
        file_menu.addAction(self._revert_action)

        file_menu.addSeparator()

        export_action = QAction("&Export HTML…\tCtrl+Shift+E", self)
        export_action.triggered.connect(lambda _checked=False: self._menu_command("export"))
        file_menu.addAction(export_action)

        file_menu.addSeparator()

        quit_action = QAction("&Quit\tCtrl+Q", self)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        self._insert_menu = menubar.addMenu("&Insert")
        insert_menu = self._insert_menu
        import_action = QAction("&Spreadsheet…", self)
        import_action.triggered.connect(
            lambda _checked=False: self._menu_command("importTable")
        )
        insert_menu.addAction(import_action)
        text_action = QAction("&Text File…", self)
        text_action.triggered.connect(
            lambda _checked=False: self._menu_command("importText")
        )
        insert_menu.addAction(text_action)
        image_action = QAction("&Image…", self)
        image_action.triggered.connect(
            lambda _checked=False: self._menu_command("insertImage")
        )
        insert_menu.addAction(image_action)

        self._view_menu = menubar.addMenu("&View")
        view_menu = self._view_menu
        self._preview_action = QAction("&Preview\tCtrl+Shift+P", self)
        self._preview_action.setCheckable(True)
        self._preview_action.setChecked(True)
        self._preview_action.triggered.connect(
            lambda _checked=False: self._menu_command("togglePreview")
        )
        view_menu.addAction(self._preview_action)

        self._formatting_action = QAction("&Formatting Toolbar", self)
        self._formatting_action.setCheckable(True)
        self._formatting_action.setChecked(True)
        self._formatting_action.triggered.connect(
            lambda _checked=False: self._menu_command("toggleFormatting")
        )
        view_menu.addAction(self._formatting_action)

        self._help_menu = menubar.addMenu("&Help")
        help_menu = self._help_menu
        about_action = QAction("&About Edi…", self)
        about_action.triggered.connect(lambda _checked=False: self._show_about())
        help_menu.addAction(about_action)

    def _show_about(self) -> None:
        """Open the non-blocking About dialog: logo, version, description."""
        dialog = QDialog(self)
        dialog.setWindowTitle("About Edi")
        dialog.setWindowModality(Qt.WindowModality.WindowModal)

        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(28, 20, 28, 16)
        layout.setSpacing(6)

        pixmap = load_about_logo()
        if pixmap is not None:
            logo = QLabel()
            logo.setPixmap(pixmap)
            logo.setAlignment(Qt.AlignmentFlag.AlignCenter)
            layout.addWidget(logo)

        title = QLabel("Edi")
        title_font = title.font()
        title_font.setPointSize(18)
        title_font.setBold(True)
        title.setFont(title_font)
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(title)

        version = QLabel(f"Version {__version__}")
        version.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(version)

        description = QLabel(
            "A fast markdown editor with live preview, Mermaid diagrams, "
            "spreadsheet tables, executable code blocks, and more."
        )
        description.setWordWrap(True)
        description.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(description)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok)
        buttons.accepted.connect(dialog.accept)
        layout.addWidget(buttons, alignment=Qt.AlignmentFlag.AlignCenter)

        dialog.open()

    def _menu_command(self, command: str) -> None:
        self._web.page().runJavaScript(f"window.ediMenuCommand({json.dumps(command)})")

    def update_menu_state(self, can_revert: bool, preview_visible: bool, formatting_visible: bool) -> None:
        if self._revert_action is not None:
            self._revert_action.setEnabled(can_revert)
        if self._preview_action is not None:
            self._preview_action.setChecked(preview_visible)
        if self._formatting_action is not None:
            self._formatting_action.setChecked(formatting_visible)

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

    def pick_import_path(self, callback=None) -> None:
        dialog = QFileDialog(self, "Import spreadsheet")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptOpen)
        dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
        dialog.setNameFilter(
            "Spreadsheets (*.csv *.tsv *.ods *.xlsx *.xlsm);;"
            "CSV / TSV (*.csv *.tsv *.txt);;"
            "ODS (*.ods);;"
            "Excel (*.xlsx *.xlsm);;"
            "All files (*)"
        )
        self._run_dialog(dialog, callback)

    def pick_text_import_path(self, callback=None) -> None:
        dialog = QFileDialog(self, "Insert text file")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptOpen)
        dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
        dialog.setNameFilter(
            "Markdown / text files (*.md *.markdown *.txt *.mermaid *.log);;"
            "All files (*)"
        )
        self._run_dialog(dialog, callback)

    def pick_image_import_path(self, callback=None) -> None:
        dialog = QFileDialog(self, "Insert image")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptOpen)
        dialog.setFileMode(QFileDialog.FileMode.ExistingFile)
        dialog.setNameFilter(
            "Images (*.png *.jpg *.jpeg *.gif *.svg *.webp *.bmp);;"
            "All files (*)"
        )
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
