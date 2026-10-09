"""Main window: native Qt shell hosting the frontend in a webview."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QFile, QPoint, QSettings, QUrl, Qt
from PySide6.QtGui import QAction, QActionGroup, QDesktopServices, QIcon, QKeySequence, QPixmap
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
from .preferences import Preferences

DIST_DIR = Path(__file__).resolve().parent.parent / "dist"

CONFIRM_QUIT_MESSAGE = "Unsaved changes will be lost. Quit anyway?"

RECENT_LIMIT = 8

# Mirrors ``ZOOM_LEVELS`` in ``src/zoom.ts``; used to build the View > Zoom
# submenu. The frontend is the source of truth for clamping, this is only the
# menu's list of rungs.
ZOOM_LEVELS = (0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3)

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


def _recent_label(path: str) -> str:
    """Menu text for a recent document: its file name, qualified by its folder."""
    name = os.path.basename(path) or path
    parent = os.path.dirname(path)
    if not parent:
        return name
    return f"{name} — {parent}"


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


class _AppWebView(QWebEngineView):
    """Webview with no default right-click context menu.

    QWebEngineView's default ``contextMenuEvent`` raises Chromium's
    Cut/Copy/Paste menu; swallowing the event leaves right-clicks inert so the
    app can later provide its own menu if it wants one.
    """

    def contextMenuEvent(self, event) -> None:
        event.accept()


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
    opener = shutil.which("xdg-open")
    if opener is None:
        return False
    # xdg-open receives a single argv element, no shell; the OS registered
    # handler is exactly what QDesktopServices would use.
    try:
        subprocess.Popen(  # nosec B603
            [opener, url],
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
    def __init__(self, pending_files: list[str] | None = None) -> None:
        super().__init__()
        self.setWindowTitle("Edi")
        self.setMinimumSize(800, 560)
        icon = load_app_icon()
        if icon is not None:
            self.setWindowIcon(icon)
        self._dirty = False
        self._allow_close = False
        self._revert_action = None
        self._copy_path_action = None
        self._rename_action = None
        self._toolbar_action = None
        self._hover_band_action = None
        self._insert_actions = None
        self._zoom_in_action = None
        self._zoom_out_action = None
        self._zoom_actions: dict[float, QAction] = {}

        self._preferences = Preferences()
        self._bridge = Bridge(self, pending_files)
        self._web = _AppWebView()
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

        # The preferences, injected before the app's own bundle runs — see
        # `backend/preferences.py` for why they cannot simply be read over the
        # bridge at boot. Same injection point as `qwebchannel.js` and, like it,
        # a static string: which is why `set_preference` rewrites this script's
        # source on every write, so that a document created later in the run
        # replays the current answers instead of the ones this window booted with.
        self._preferences_script = QWebEngineScript()
        self._preferences_script.setName("edi-preferences")
        self._preferences_script.setInjectionPoint(
            QWebEngineScript.InjectionPoint.DocumentCreation
        )
        self._preferences_script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        self._preferences_script.setSourceCode(self._preferences_source())
        self._web.page().scripts().insert(self._preferences_script)

        self._web.load(_app_url(is_selftest=os.environ.get("EDI_SELFTEST") == "1"))

    def _preferences_source(self) -> str:
        """The page's one line of preferences, as JavaScript.

        Assigned to a single global rather than passed to a function: the reader
        in ``src/preferences.ts`` runs at module load, during the bundle's own
        execution, and there is no earlier point at which the bridge exists to
        call. ``json.dumps`` of the coerced dict is safe to inline — every value
        is a float or a bool, and the keys are the store's own names.
        """
        return "window.ediPreferences = %s;" % json.dumps(self._preferences.all())

    def preferences(self) -> dict:
        """Every persisted preference, defaults filled in."""
        return self._preferences.all()

    def set_preference(self, name: str, value) -> None:
        """Persist one preference and keep the injected copy in step."""
        if self._preferences.set(name, value):
            self._preferences_script.setSourceCode(self._preferences_source())

    def _menubar_action(self, label: str, command: str, *, shell_owns_key: bool) -> QAction:
        """Build a menubar item, and decide explicitly who owns its key.

        **The ``\t`` in a label is not a shortcut, and this file used to believe it
        was.** A ``\t`` in a ``QAction`` label gives the action no ``QShortcut`` at
        all in PySide6 — verified by reading ``action.shortcut()`` back, which is
        empty for every action built the old way, while the zoom actions a few lines
        below, which call ``setShortcut()``, do have one. So ``Ctrl+C`` and ``Ctrl+A``
        were *labels*: the keys reached the webview, where there was no DOM selection
        to copy, and nothing happened at all. The menu item worked and the keyboard
        did not, which is the whole of the symptom.

        So the shortcut is now set explicitly, and only where the **shell** should
        own the key (``shell_owns_key=True``, which binds the sequence the label
        declared). The document commands pass ``shell_owns_key=False`` and have the
        ``\t`` stripped instead: the page implements them, and it implements them
        better, because it is the only thing that knows about a CodeMirror buffer's
        own selection or a spreadsheet grid's. A window-level shortcut would shadow
        the page's handling of precisely the case the shortcut exists for.

        Stripping rather than honouring is the point. A menu item advertising a
        shortcut that does not work is the bug, and it is a worse bug than a menu
        item with no hint on it.
        """
        text, _, declared = label.partition("\t")
        action = QAction(text, self)
        if shell_owns_key:
            if not declared:
                raise ValueError(f"{label!r} claims a key but declares no sequence")
            action.setShortcut(QKeySequence(declared))
        action.setShortcutContext(Qt.WindowShortcut)
        action.triggered.connect(lambda _checked=False, cmd=command: self._menu_command(cmd))
        return action

    def _build_menus(self) -> None:
        menubar = self.menuBar()

        # Keep Python references: PySide6 hands ownership of addMenu() results
        # to Python, and dropping them garbage-collects the C++ menus.
        self._file_menu = menubar.addMenu("&File")
        file_menu = self._file_menu
        for label, command in (
            ("&New\tCtrl+N", "new"),
            ("&Open…\tCtrl+O", "open"),
        ):
            file_menu.addAction(self._menubar_action(label, command, shell_owns_key=True))

        # The recent list lives in QSettings and can change between launches, so
        # the submenu is repopulated every time it is opened rather than once
        # here. `self._recent_menu` is kept for the same ownership reason as the
        # other menus above.
        self._recent_menu = file_menu.addMenu("Open &Recent")
        self._recent_menu.aboutToShow.connect(self._refresh_recent_menu)

        for label, command in (
            ("&Save\tCtrl+S", "save"),
            ("Save &As…\tCtrl+Shift+S", "saveAs"),
        ):
            file_menu.addAction(self._menubar_action(label, command, shell_owns_key=True))

        # No shortcut: F2 is the spreadsheet cell editor's key to edit in place,
        # and a menubar shortcut wins over the page, so one would cost that.
        self._rename_action = QAction("Re&name…", self)
        self._rename_action.setEnabled(False)
        self._rename_action.triggered.connect(
            lambda _checked=False: self._menu_command("rename")
        )
        file_menu.addAction(self._rename_action)

        self._revert_action = QAction("&Revert", self)
        self._revert_action.setEnabled(False)
        self._revert_action.triggered.connect(
            lambda _checked=False: self._menu_command("revert")
        )
        file_menu.addAction(self._revert_action)

        # Enabled by the frontend only while the document in view has a path.
        # `setShortcut` rather than a `\t` in the label, for the reason
        # `_menubar_action` documents — and the label carries no shortcut because Qt
        # renders a real one in the menu item itself, so a `\t` would show it twice.
        self._copy_path_action = QAction("Copy File &Path", self)
        self._copy_path_action.setShortcut(QKeySequence("Ctrl+Alt+Shift+C"))
        self._copy_path_action.setEnabled(False)
        self._copy_path_action.triggered.connect(
            lambda _checked=False: self._menu_command("copyFilePath")
        )
        file_menu.addAction(self._copy_path_action)

        file_menu.addSeparator()

        # No shortcut: Ctrl+Shift+E is the page's block-source toggle
        # (`Mod-Shift-e` in `src/editor.ts`), and a menubar shortcut wins over
        # the page — see the Rename action above. This label used to claim it,
        # which is why block source mode had no working keyboard entry.
        export_action = QAction("&Export HTML…", self)
        export_action.triggered.connect(lambda _checked=False: self._menu_command("export"))
        file_menu.addAction(export_action)

        file_menu.addSeparator()

        quit_action = QAction("&Quit", self)
        quit_action.setShortcut(QKeySequence("Ctrl+Q"))
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        self._edit_menu = menubar.addMenu("&Edit")
        edit_menu = self._edit_menu
        for label, command in (
            ("&Undo\tCtrl+Z", "undo"),
            ("&Redo\tCtrl+Shift+Z", "redo"),
        ):
            edit_menu.addAction(self._menubar_action(label, command, shell_owns_key=False))

        edit_menu.addSeparator()

        for label, command in (
            ("Cu&t\tCtrl+X", "cut"),
            ("&Copy\tCtrl+C", "copy"),
            ("Copy as &Markdown\tCtrl+Shift+C", "copyAsMarkdown"),
            ("&Paste\tCtrl+V", "paste"),
            ("Paste as &Markdown\tCtrl+Shift+V", "pasteAsMarkdown"),
        ):
            edit_menu.addAction(self._menubar_action(label, command, shell_owns_key=False))

        edit_menu.addSeparator()

        select_all_action = QAction("Select &All", self)
        select_all_action.triggered.connect(lambda _checked=False: self._menu_command("selectAll"))
        edit_menu.addAction(select_all_action)

        edit_menu.addSeparator()

        encrypt_block_action = QAction("&Encrypt Block…", self)
        encrypt_block_action.triggered.connect(lambda _checked=False: self._menu_command("encryptBlock"))
        edit_menu.addAction(encrypt_block_action)

        edit_menu.addSeparator()

        for label, command in (
            ("&Find…\tCtrl+F", "find"),
            ("&Replace…\tCtrl+H", "replace"),
        ):
            edit_menu.addAction(self._menubar_action(label, command, shell_owns_key=False))

        self._insert_menu = menubar.addMenu("&Insert")
        insert_menu = self._insert_menu
        table_action = QAction("&Table…", self)
        table_action.triggered.connect(
            lambda _checked=False: self._menu_command("insertTableDefault")
        )
        insert_menu.addAction(table_action)
        kanban_action = QAction("&Kanban Board…", self)
        kanban_action.triggered.connect(
            lambda _checked=False: self._menu_command("insertKanban")
        )
        insert_menu.addAction(kanban_action)
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
        self._insert_actions = (table_action, kanban_action, import_action, text_action, image_action)

        self._view_menu = menubar.addMenu("&View")
        view_menu = self._view_menu
        self._toolbar_action = QAction("&Toolbar", self)
        self._toolbar_action.setCheckable(True)
        self._toolbar_action.setChecked(True)
        self._toolbar_action.triggered.connect(
            lambda _checked=False: self._menu_command("toggleToolbar")
        )
        view_menu.addAction(self._toolbar_action)

        # The hover band — the faint band behind the block under the pointer, the
        # page's answer to "which block would Alt+click alter?". Same shape as the
        # Toolbar item above, and for the same reason: the page owns the persisted
        # value, so this action is a blind toggle that never reads its own check
        # state, and the checkmark arrives in the next `setMenuState`. The
        # provisional `setChecked(True)` is a boot-time guess only — the option is
        # on unless the reader has turned it off, and the real answer comes from
        # storage in the page, which is why the bridge's default here is `True`
        # rather than `bool(None) == False`.
        self._hover_band_action = QAction("&Hover Band", self)
        self._hover_band_action.setCheckable(True)
        self._hover_band_action.setChecked(True)
        self._hover_band_action.triggered.connect(
            lambda _checked=False: self._menu_command("toggleHoverBand")
        )
        view_menu.addAction(self._hover_band_action)

        view_menu.addSeparator()

        # Zoom shortcuts are registered as *real* QAction shortcuts, unlike the
        # rest of the menus whose `\t...` text is only a label and whose keys the
        # frontend handles. A real shortcut is consumed by Qt before the webview
        # sees it, which is what stops Chromium's whole-page zoom from scaling
        # the tab bar and toolbar along with the document.
        self._zoom_in_action = QAction("Zoom &In", self)
        self._zoom_in_action.setShortcuts(
            [QKeySequence(QKeySequence.StandardKey.ZoomIn), QKeySequence("Ctrl+=")]
        )
        self._zoom_in_action.triggered.connect(
            lambda _checked=False: self._menu_command("zoomIn")
        )
        view_menu.addAction(self._zoom_in_action)

        self._zoom_out_action = QAction("Zoom &Out", self)
        self._zoom_out_action.setShortcut(QKeySequence(QKeySequence.StandardKey.ZoomOut))
        self._zoom_out_action.triggered.connect(
            lambda _checked=False: self._menu_command("zoomOut")
        )
        view_menu.addAction(self._zoom_out_action)

        reset_zoom_action = QAction("&Reset Zoom", self)
        reset_zoom_action.setShortcut(QKeySequence("Ctrl+0"))
        reset_zoom_action.triggered.connect(
            lambda _checked=False: self._menu_command("zoomReset")
        )
        view_menu.addAction(reset_zoom_action)

        view_menu.addSeparator()

        zoom_menu = view_menu.addMenu("&Zoom")
        zoom_group = QActionGroup(self)
        zoom_group.setExclusive(True)
        for level in ZOOM_LEVELS:
            level_action = QAction(f"{round(level * 100)}%", self)
            level_action.setCheckable(True)
            level_action.triggered.connect(
                lambda _checked=False, value=level: self._menu_command("zoomTo", str(value))
            )
            zoom_group.addAction(level_action)
            zoom_menu.addAction(level_action)
            self._zoom_actions[level] = level_action

        self._help_menu = menubar.addMenu("&Help")
        help_menu = self._help_menu
        guide_action = QAction("&Edi Guide…", self)
        guide_action.triggered.connect(
            lambda _checked=False: self._menu_command("helpGuide")
        )
        help_menu.addAction(guide_action)
        reference_action = QAction("&Formula Reference…", self)
        reference_action.triggered.connect(
            lambda _checked=False: self._menu_command("formulaReference")
        )
        help_menu.addAction(reference_action)
        help_menu.addSeparator()
        about_action = QAction("&About Edi…", self)
        about_action.triggered.connect(lambda _checked=False: self._show_about())
        help_menu.addAction(about_action)

    def _show_about(self) -> None:
        """Open the non-blocking About dialog: logo, version, description."""
        dialog = _AboutDialog(self)
        dialog.open()

    def _menu_command(self, command: str, argument: str = "") -> None:
        """Run a menu command in the page, with an optional string argument."""
        self._web.page().runJavaScript(
            f"window.ediMenuCommand({json.dumps(command)}, {json.dumps(argument)})"
        )

    def _refresh_recent_menu(self) -> None:
        """Rebuild File > Open Recent from the stored recent documents.

        Each entry is labelled with its file name plus the containing folder, so
        two documents called ``notes.md`` stay distinguishable; the full path is
        the action's tooltip.
        """
        self._recent_menu.clear()
        paths = self.recent_files()
        if not paths:
            empty = self._recent_menu.addAction("No recent documents")
            empty.setEnabled(False)
            return
        for path in paths:
            action = self._recent_menu.addAction(_recent_label(path))
            action.setToolTip(path)
            action.triggered.connect(
                lambda _checked=False, target=path: self._menu_command(
                    "openRecent", target
                )
            )

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
        can_copy_path: bool,
        toolbar_visible: bool,
        can_rename: bool = False,
        hover_band: bool = True,
        zoom_factor: float = 1.0,
        can_zoom_in: bool = True,
        can_zoom_out: bool = True,
    ) -> None:
        if self._revert_action is not None:
            self._revert_action.setEnabled(can_revert)
        if self._copy_path_action is not None:
            self._copy_path_action.setEnabled(can_copy_path)
        if self._rename_action is not None:
            self._rename_action.setEnabled(can_rename)
        if self._toolbar_action is not None:
            self._toolbar_action.setChecked(toolbar_visible)
        if self._hover_band_action is not None:
            self._hover_band_action.setChecked(hover_band)
        if self._insert_actions is not None:
            for action in self._insert_actions:
                action.setEnabled(True)
        if self._zoom_in_action is not None:
            self._zoom_in_action.setEnabled(can_zoom_in)
        if self._zoom_out_action is not None:
            self._zoom_out_action.setEnabled(can_zoom_out)
        if self._zoom_actions:
            nearest = min(self._zoom_actions, key=lambda level: abs(level - zoom_factor))
            self._zoom_actions[nearest].setChecked(True)

    def set_dirty(self, dirty: bool) -> None:
        self._dirty = dirty

    def is_dirty(self) -> bool:
        return self._dirty

    def set_title(self, title: str) -> None:
        self.setWindowTitle(title or "Edi")

    def push_event(self, event: dict) -> None:
        """Push a backend event to the webview (e.g. system color-scheme change)."""
        self._bridge.emit_event(event)

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

    def forget_recent_file(self, path: str) -> None:
        """Drop ``path`` from the recents, for when its file no longer exists.

        A rename deletes the old file, and the recent list is rebuilt from
        QSettings every time the submenu opens, so the entry has to go from the
        settings rather than from the menu.
        """
        current = self.recent_files()
        if path not in current:
            return
        QSettings().setValue("recentFiles", [entry for entry in current if entry != path])

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
        if not default_name.lower().endswith((".md", ".markdown", ".txt", ".mermaid")):
            default_name = f"{default_name}.md"
        dialog.selectFile(default_name)
        self._run_dialog(dialog, callback)

    def pick_export_path(self, default_name, callback=None) -> None:
        dialog = QFileDialog(self, "Export HTML")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptSave)
        dialog.setNameFilter("HTML documents (*.html *.htm);;All files (*)")
        stem = default_name
        for ext in (".markdown", ".mermaid", ".md", ".txt"):
            if stem.lower().endswith(ext):
                stem = stem[: -len(ext)]
                break
        if not stem.lower().endswith((".html", ".htm")):
            stem = f"{stem}.html"
        dialog.selectFile(stem)
        self._run_dialog(dialog, callback)

    def pick_image_save_path(self, default_name, callback=None) -> None:
        dialog = QFileDialog(self, "Save image")
        dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptSave)
        dialog.setNameFilter("PNG images (*.png);;All files (*)")
        dialog.setDefaultSuffix("png")
        if not default_name.lower().endswith(".png"):
            default_name = f"{default_name}.png"
        dialog.selectFile(default_name)
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
