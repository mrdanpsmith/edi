"""Main window: native Qt shell hosting the frontend in a webview."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QFile, QPoint, QSettings, QUrl, Qt
from PySide6.QtGui import QAction, QDesktopServices, QIcon, QPixmap
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

RECENT_LIMIT = 8

_QWEBCHANNEL_JS = Path(__file__).resolve().parent / "qwebchannel.js"


def _is_main_index_file(local: str) -> bool:
    """True if ``local`` is the app's index.html, separator-agnostic.

    QUrl.toLocalFile() keeps forward slashes on every platform (Qt never
    converts them), while ``DIST_DIR / "index.html"`` uses the native
    separator. On Windows the two would never string-match, so the initial
    load would be rejected and the webview would stay blank; normalize both.
    """
    return (
        local.replace("\\", "/") == str(DIST_DIR / "index.html").replace("\\", "/")
    )


def _app_url(is_selftest: bool = False) -> QUrl:
    """URL for the frontend index file, optionally tagged for selftest mode.

    ``?selftest=1`` makes the frontend boot the Welcome document into a tab so
    the packaged-build smoke probe (``.ProseMirror`` + ``.mermaid``) still has a
    rendered editor to test, instead of the home screen shown on normal launch.
    """
    url = QUrl.fromLocalFile(str(DIST_DIR / "index.html"))
    if is_selftest:
        url.setQuery("selftest=1")
    return url


class _AppPage(QWebEnginePage):
    """Webview page that never lets the main frame leave the app.

    Link clicks are intercepted in the frontend (they open in the system
    browser or an Edi tab), but this is a backstop so no middle-click,
    keyboard, or JS-initiated navigation can replace the editor UI.
    """

    def acceptNavigationRequest(self, url: QUrl, _navigation_type, is_main_frame: bool) -> bool:
        if is_main_frame:
            return _is_main_index_file(url.toLocalFile())
        return True


def _child_env() -> dict[str, str]:
    """Environment for spawned children, minus the PyInstaller bundle path.

    The onefile bootloader exports ``LD_LIBRARY_PATH`` pointing at the
    extraction dir full of Ubuntu 22.04 libraries. A browser child inherits it
    and loads those older libs instead of the host's system ones, breaking
    e.g. Waterfox with ``Couldn't load XPCOM``. Strip it so children behave
    like a plain terminal launch.
    """
    return {
        key: value
        for key, value in os.environ.items()
        if key not in ("LD_LIBRARY_PATH", "LD_PRELOAD")
    }


def _xdg_open(url: str) -> bool:
    """Spawn the system ``xdg-open`` handler for ``url``; True if it started.

    ``QDesktopServices.openUrl`` cannot be given a custom environment, and the
    PyInstaller onefile bootloader exports ``LD_LIBRARY_PATH`` pointing at the
    bundled Ubuntu 22.04 libraries — a browser spawned with that inherited
    path breaks (e.g. Waterfox's "Couldn't load XPCOM"). ``xdg-open`` is the
    same handler QDesktopServices uses on Linux, but it can be run with a
    sanitized environment. stdio is discarded so a failing handler cannot
    flood Edi's console.
    """
    try:
        subprocess.Popen(
            ["xdg-open", url],
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return False
    return True


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


def load_about_logo(max_size: int = 180) -> QPixmap | None:
    """Return the app icon scaled to fit ``max_size``, or ``None``.

    The about dialog reuses the window/taskbar artwork so Edi has a single
    icon; the dedicated ``assets/edi-logo.png`` was removed.
    """
    icon_path = _find_icon()
    if icon_path is None:
        return None
    pixmap = QPixmap(str(icon_path))
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


class _AboutDialog(QDialog):
    """Frameless About dialog: logo, title, version, description.

    Frameless so the window-manager titlebar (with its minimize/maximize/close
    buttons) can never clip the title text; drag the dialog body to move it,
    Ok or Escape to close it.
    """

    def __init__(self, parent=None) -> None:
        super().__init__(parent, Qt.WindowType.Dialog | Qt.WindowType.FramelessWindowHint)
        self.setWindowTitle("About Edi")
        self.setWindowModality(Qt.WindowModality.WindowModal)
        self._drag_offset: QPoint | None = None

        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 24, 28, 16)
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
        buttons.accepted.connect(self.accept)
        layout.addWidget(buttons, alignment=Qt.AlignmentFlag.AlignCenter)

        self.setMinimumWidth(360)
        self.adjustSize()

    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_offset = (
                event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            )
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._drag_offset is not None and event.buttons() & Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        self._drag_offset = None
        super().mouseReleaseEvent(event)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Edi")
        self.setMinimumSize(800, 560)
        icon = load_app_icon()
        if icon is not None:
            self.setWindowIcon(icon)
        self._dirty = False
        self._allow_close = False
        self._revert_action = None
        self._formatting_action = None
        self._insert_actions = None

        self._bridge = Bridge(self)
        self._web = QWebEngineView()
        self._web.setPage(_AppPage(self._web))
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

        self._web.load(_app_url(is_selftest=os.environ.get("EDI_SELFTEST") == "1"))

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

        self._edit_menu = menubar.addMenu("&Edit")
        edit_menu = self._edit_menu
        for label, command in (
            ("&Undo\tCtrl+Z", "undo"),
            ("&Redo\tCtrl+Shift+Z", "redo"),
        ):
            action = QAction(label, self)
            action.triggered.connect(lambda _checked=False, cmd=command: self._menu_command(cmd))
            edit_menu.addAction(action)

        edit_menu.addSeparator()

        for label, command in (
            ("Cu&t\tCtrl+X", "cut"),
            ("&Copy\tCtrl+C", "copy"),
            ("&Paste\tCtrl+V", "paste"),
        ):
            action = QAction(label, self)
            action.triggered.connect(lambda _checked=False, cmd=command: self._menu_command(cmd))
            edit_menu.addAction(action)

        edit_menu.addSeparator()

        select_all_action = QAction("Select &All\tCtrl+A", self)
        select_all_action.triggered.connect(lambda _checked=False: self._menu_command("selectAll"))
        edit_menu.addAction(select_all_action)

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
        self._insert_actions = (import_action, text_action, image_action)

        self._view_menu = menubar.addMenu("&View")
        view_menu = self._view_menu
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
        dialog = _AboutDialog(self)
        dialog.open()

    def _menu_command(self, command: str) -> None:
        self._web.page().runJavaScript(f"window.ediMenuCommand({json.dumps(command)})")

    def open_external_url(self, url: str) -> None:
        """Open ``url`` in the system default application (usually a browser).

        ``xdg-open`` is used instead of ``QDesktopServices.openUrl`` so the
        handler runs with a sanitized environment (see ``_xdg_open``), falling
        back to the desktop service if the helper is unavailable.
        """
        if not _xdg_open(url):
            QDesktopServices.openUrl(QUrl(url))

    def update_menu_state(
        self,
        can_revert: bool,
        formatting_visible: bool,
    ) -> None:
        if self._revert_action is not None:
            self._revert_action.setEnabled(can_revert)
        if self._formatting_action is not None:
            self._formatting_action.setChecked(formatting_visible)
        if self._insert_actions is not None:
            for action in self._insert_actions:
                action.setEnabled(True)

    def set_dirty(self, dirty: bool) -> None:
        self._dirty = dirty

    def is_dirty(self) -> bool:
        return self._dirty

    def set_title(self, title: str) -> None:
        self.setWindowTitle(title or "Edi")

    def recent_files(self) -> list[str]:
        """Most-recently-opened documents, most recent first (capped).

        Stored in QSettings under ``recentFiles``; ``QSettings()`` uses the
        org="Edi" / app="Edi" names set in ``backend.main`` (Linux:
        ``~/.config/Edi/Edi.conf``).

        QSettings' native format stores a one-element QStringList as a bare
        scalar, so a fresh process reads it back as a str rather than a list;
        treat that as a single-entry list (empty strings are just ignored).
        """
        value = QSettings().value("recentFiles", [])
        if isinstance(value, str):
            return [value] if value else []
        return list(value) if isinstance(value, list) else []

    def add_recent_file(self, path: str) -> None:
        """Record ``path`` as the most recent document, deduped and capped."""
        current = self.recent_files()
        if path in current:
            current.remove(path)
        current.insert(0, path)
        QSettings().setValue("recentFiles", current[:RECENT_LIMIT])

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

    def alert(self, message: str) -> None:
        """Show a non-blocking centered message box with a single OK button.

        Unlike :meth:`confirm`, this is informational: there is no Yes/No
        decision, so the dialog has exactly one button ("OK").
        """
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("Edi")
        box.setText(message)
        box.addButton(QMessageBox.StandardButton.Ok)
        box.setWindowModality(Qt.WindowModality.WindowModal)
        box.adjustSize()
        frame = box.frameGeometry()
        frame.moveCenter(self.frameGeometry().center())
        box.move(frame.topLeft())
        box.finished.connect(lambda _result: box.deleteLater())
        box.open()

    def _run_dialog(self, dialog: QFileDialog, callback=None, multiple: bool = False) -> None:
        """Open a file dialog non-blocking and report the chosen path(s).

        ``callback(path: str | None)`` runs on accept (selected file) or cancel
        (``None``). With ``multiple=True`` the callback receives the full list
        of selected files (``[]`` on cancel). Non-blocking (``open()``) so the
        event loop keeps pumping.
        """
        dialog.setWindowModality(Qt.WindowModality.WindowModal)

        def done(result) -> None:
            selected = dialog.selectedFiles()
            if multiple:
                value = selected if result else []
            else:
                value = selected[0] if result and selected else None
            dialog.deleteLater()
            if callback is not None:
                callback(value)

        dialog.finished.connect(done)
        dialog.open()

    def pick_open_path(self, callback=None) -> None:
        dialog = QFileDialog(self, "Open documents")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptOpen)
        dialog.setFileMode(QFileDialog.FileMode.ExistingFiles)
        dialog.setNameFilter("Markdown documents (*.md *.markdown *.txt *.mermaid);;All files (*)")
        self._run_dialog(dialog, callback, multiple=True)

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
