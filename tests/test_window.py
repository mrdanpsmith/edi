"""Tests for the native Qt shell: centered confirm dialog and close behavior.

One session-scoped window is used for the whole suite so QtWebEngine only
boots once.
"""

from __future__ import annotations

import sys
import time
import base64
import json
from pathlib import Path

from PySide6.QtCore import QBuffer, QEvent, QIODevice, QItemSelectionModel, QPoint, QPointF, QSettings, QSize, QUrl, Qt
from PySide6.QtGui import QContextMenuEvent, QImage, QMouseEvent
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QFileDialog,
    QFileSystemModel,
    QLabel,
    QListView,
    QMessageBox,
)

import backend.window as window_module
from backend.window import (
    DIST_DIR,
    MainWindow,
    __version__,
    _AppWebView,
    _is_main_index_file,
)

import pytest

from tests.mermaid_render import (  # re-exported: the other test modules import these
    BOARD_DIALOG,
    CARDS_AND_BANDS,
    COLUMNS,
    DOC_SOURCE,
    EDIT_STATE,
    FLOW,
    KANBAN,
    KANBAN_ADDS,
    KANBAN_EMPTY,
    KANBAN_LONE,
    KANBAN_QUOTED,
    LABEL_INVENTORY,
    LABEL_STATE,
    SEQUENCE,
    SECTIONS,
    _cancel_board_dialog,
    _click_first_offered,
    _click_done,
    _click_kanban_add,
    _click_label,
    _dblclick_below_document,
    _dump,
    _enter_edit_mode,
    _open_board_dialog,
    _pointer_drag,
    _press_enter,
    _pump_until,
    _render,
    _set_document,
    _set_scheme,
    _type,
    _type_and_confirm,
    _wait,
    _wait_baked,
    _wait_text,
    _zoom,
)


@pytest.fixture(scope="session")
def window(qapp):
    if not (DIST_DIR / "index.html").is_file():
        pytest.fail(
            f"frontend build not found at {DIST_DIR / 'index.html'}; "
            "run `npm run build` before the backend tests"
        )
    win = MainWindow()
    win.resize(1280, 800)
    win.show()

    state = {"ready": False}

    def probe():
        win._web.page().runJavaScript(
            """
            (function () {
              if (!window.qt || !window.qt.webChannelTransport) return false;
              return !!window.bridge && typeof window.bridge.invoke === 'function';
            })()
            """,
            lambda v: state.__setitem__("ready", bool(v)),
        )

    def ready():
        probe()
        return state["ready"]

    assert _pump_until(ready, timeout=12.0), "webview bridge never became ready"
    yield win
    win.close()


@pytest.fixture
def visible(window, qtbot):
    if not window.isVisible():
        window.show()
    qtbot.waitUntil(window.isVisible, timeout=3000)
    return window


@pytest.fixture
def stored_recents():
    """Empty the persisted recent-files list, restoring the real value after.

    QSettings() resolves its file at first use per-process and then caches the
    location, so XDG_CONFIG_HOME cannot redirect it mid-session; save and
    restore the value instead so the test stays self-contained.
    """
    settings = QSettings()
    saved = settings.value("recentFiles", [])
    settings.setValue("recentFiles", [])
    try:
        yield settings
    finally:
        settings.setValue("recentFiles", saved)


def test_window_minimum_size(window):
    assert window.minimumSize() == QSize(800, 560)
    window.resize(100, 100)
    assert window.size() == window.minimumSize()
    window.resize(1280, 800)


def _call_confirm(window):
    window._web.page().runJavaScript(
        "window.__confirmResult = 'pending';"
        "window.bridge.result.connect(function (payload) {"
        "  var message = JSON.parse(payload);"
        "  if (message.id === 9001) {"
        "    window.__confirmResult = message.ok ? message.data : message.error;"
        "  }"
        "});"
        "window.bridge.invoke('confirm', 9001, JSON.stringify({ message: 'Discard changes?' }));"
        "true",
        lambda _v: None,
    )


def _wait_modal(qtbot, timeout=3000):
    box = {"value": None}

    def active_box():
        widget = QApplication.activeModalWidget()
        if isinstance(widget, QMessageBox):
            box["value"] = widget
            return True
        return False

    qtbot.waitUntil(active_box, timeout=timeout)
    return box["value"]


def _dismiss_box(box, qtbot, button):
    button.click()
    qtbot.waitUntil(lambda: QApplication.activeModalWidget() is None, timeout=2000)


def _read_confirm_result(window, qtbot):
    result = {}

    def fetch():
        window._web.page().runJavaScript(
            "window.__confirmResult", lambda v: result.__setitem__("value", v)
        )
        return result.get("value") is not None and result["value"] != "pending"

    qtbot.waitUntil(fetch, timeout=3000)
    return result["value"]


def test_confirm_dialog_is_centered(visible, qtbot):
    window = visible
    _call_confirm(window)
    box = _wait_modal(qtbot)
    wc = box.frameGeometry().center()
    fc = window.frameGeometry().center()
    assert abs(wc.x() - fc.x()) <= 2
    assert abs(wc.y() - fc.y()) <= 2
    _dismiss_box(box, qtbot, box.button(QMessageBox.StandardButton.Yes))
    assert _read_confirm_result(window, qtbot) is True


def test_confirm_dialog_no_returns_false(visible, qtbot):
    window = visible
    _call_confirm(window)
    box = _wait_modal(qtbot)
    _dismiss_box(box, qtbot, box.button(QMessageBox.StandardButton.No))
    assert _read_confirm_result(window, qtbot) is False


def _call_alert(window):
    window._web.page().runJavaScript(
        "window.bridge.invoke('alert', 9002, JSON.stringify({ message: 'Something broke' }));"
        "true",
        lambda _v: None,
    )


def test_alert_dialog_shows_single_ok_button(visible, qtbot):
    window = visible
    _call_alert(window)
    box = _wait_modal(qtbot)
    buttons = box.buttons()
    assert [b.text() for b in buttons] == ["OK"]
    _dismiss_box(box, qtbot, box.button(QMessageBox.StandardButton.Ok))


def test_close_clean_exits_without_prompt(visible, qtbot):
    window = visible
    window.close()
    qtbot.waitUntil(lambda: not window.isVisible(), timeout=3000)
    assert QApplication.activeModalWidget() is None


def test_close_dirty_prompts_and_cancel_keeps_window(visible, qtbot):
    window = visible
    window.set_dirty(True)
    window.close()

    box = _wait_modal(qtbot)
    _dismiss_box(box, qtbot, box.button(QMessageBox.StandardButton.No))

    qtbot.waitUntil(window.isVisible, timeout=3000)
    window.set_dirty(False)


def test_close_dirty_confirm_closes(visible, qtbot):
    window = visible
    window.set_dirty(True)
    window.close()

    box = _wait_modal(qtbot)
    _dismiss_box(box, qtbot, box.button(QMessageBox.StandardButton.Yes))

    qtbot.waitUntil(lambda: not window.isVisible(), timeout=3000)
    window.set_dirty(False)


def test_bridge_ping_round_trip(visible, qtbot):
    window = visible
    result = {}

    def fetch():
        window._web.page().runJavaScript(
            "window.__pingResult",
            lambda v: result.__setitem__("value", v),
        )
        return result.get("value") not in (None, "", "pending")

    window._web.page().runJavaScript(
        "window.__pingResult = 'pending';"
        "window.bridge.result.connect(function (payload) {"
        "  var message = JSON.parse(payload);"
        "  if (message.id === 7001) window.__pingResult = message.ok && message.data === 42;"
        "});"
        "window.bridge.invoke('ping', 7001, JSON.stringify({ now: 42 }));"
        "true",
        lambda _v: None,
    )
    qtbot.waitUntil(fetch, timeout=3000)
    assert result["value"] is True


def test_pick_open_path_cancel_returns_none(visible, qtbot):
    window = visible
    result = {}

    window._web.page().runJavaScript(
        "window.__openResult = 'pending';"
        "window.bridge.result.connect(function (payload) {"
        "  var message = JSON.parse(payload);"
        "  if (message.id === 2001) window.__openResult = message.ok ? message.data : message.error;"
        "});"
        "window.bridge.invoke('pickOpenPath', 2001, '{}');"
        "true",
        lambda _v: None,
    )

    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    QApplication.activeModalWidget().reject()

    def fetched():
        window._web.page().runJavaScript(
            "JSON.stringify(window.__openResult)", lambda v: result.__setitem__("value", v)
        )
        return "value" in result and result["value"] is not None and result["value"] != '"pending"'

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == "null"


def test_pick_open_path_returns_multiple_files(visible, qtbot, tmp_path):
    window = visible
    first = tmp_path / "one.md"
    second = tmp_path / "two.md"
    first.write_text("one", encoding="utf-8")
    second.write_text("two", encoding="utf-8")
    result = {}

    window.pick_open_path(lambda paths: result.__setitem__("paths", paths))
    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    dialog = QApplication.activeModalWidget()
    try:
        dialog.setDirectory(str(tmp_path))
        qtbot.waitUntil(lambda: dialog.findChild(QListView) is not None, timeout=3000)
        view = next(v for v in dialog.findChildren(QListView) if isinstance(v.model(), QFileSystemModel))
        model = view.model()

        def index_of(name):
            root = view.rootIndex()
            for row in range(model.rowCount(root)):
                index = model.index(row, 0, root)
                if model.fileName(index) == name:
                    return index
            return None

        qtbot.waitUntil(
            lambda: index_of("one.md") is not None and index_of("two.md") is not None,
            timeout=3000,
        )
        flags = QItemSelectionModel.SelectionFlag.Select | QItemSelectionModel.SelectionFlag.Rows
        view.selectionModel().select(index_of("one.md"), flags)
        view.selectionModel().select(index_of("two.md"), flags)
        dialog.accept()
    finally:
        if QApplication.activeModalWidget() is dialog:
            dialog.reject()
    qtbot.waitUntil(lambda: "paths" in result, timeout=3000)
    assert result["paths"] == [str(first), str(second)]


def test_pick_import_path_cancel_returns_none(visible, qtbot):
    window = visible
    result = {}

    window._web.page().runJavaScript(
        "window.__importResult = 'pending';"
        "window.bridge.result.connect(function (payload) {"
        "  var message = JSON.parse(payload);"
        "  if (message.id === 3001) window.__importResult = message.ok ? message.data : message.error;"
        "});"
        "window.bridge.invoke('pickImportPath', 3001, '{}');"
        "true",
        lambda _v: None,
    )

    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    QApplication.activeModalWidget().reject()

    def fetched():
        window._web.page().runJavaScript(
            "JSON.stringify(window.__importResult)", lambda v: result.__setitem__("value", v)
        )
        return (
            "value" in result and result["value"] is not None and result["value"] != '"pending"'
        )

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == "null"


def test_pick_image_import_path_cancel_returns_none(visible, qtbot):
    window = visible
    result = {}

    window._web.page().runJavaScript(
        "window.__imageImportResult = 'pending';"
        "window.bridge.result.connect(function (payload) {"
        "  var message = JSON.parse(payload);"
        "  if (message.id === 3002) window.__imageImportResult = message.ok ? message.data : message.error;"
        "});"
        "window.bridge.invoke('pickImageImportPath', 3002, '{}');"
        "true",
        lambda _v: None,
    )

    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    QApplication.activeModalWidget().reject()

    def fetched():
        window._web.page().runJavaScript(
            "JSON.stringify(window.__imageImportResult)",
            lambda v: result.__setitem__("value", v),
        )
        return (
            "value" in result and result["value"] is not None and result["value"] != '"pending"'
        )

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == "null"


def test_menu_bar_has_file_insert_view_and_help_menus(visible, qtbot):
    window = visible
    menubar = window.menuBar()
    titles = [action.text() for action in menubar.actions()]
    assert "&File" in titles
    assert "&Insert" in titles
    assert "&View" in titles
    assert "&Help" in titles

    file_labels = [action.text() for action in window._file_menu.actions()]
    assert "&New\tCtrl+N" in file_labels
    assert "&Open…\tCtrl+O" in file_labels
    assert "Open &Recent" in file_labels
    assert "&Save\tCtrl+S" in file_labels
    assert "Save &As…\tCtrl+Shift+S" in file_labels
    assert "&Revert" in file_labels
    assert "Copy File &Path\tCtrl+Shift+C" in file_labels
    assert "&Export HTML…\tCtrl+Shift+E" in file_labels
    assert "&Quit\tCtrl+Q" in file_labels
    # Open Recent belongs directly under Open.
    assert file_labels.index("Open &Recent") == file_labels.index("&Open…\tCtrl+O") + 1

    insert_labels = [action.text() for action in window._insert_menu.actions()]
    assert insert_labels == [
        "&Table…",
        "&Kanban Board…",
        "&Spreadsheet…",
        "&Text File…",
        "&Image…",
    ]

    edit_labels = [action.text() for action in window._edit_menu.actions()]
    assert "&Undo\tCtrl+Z" in edit_labels
    assert "&Redo\tCtrl+Shift+Z" in edit_labels
    assert "Cu&t\tCtrl+X" in edit_labels
    assert "&Copy\tCtrl+C" in edit_labels
    assert "&Paste\tCtrl+V" in edit_labels
    assert "Select &All\tCtrl+A" in edit_labels
    assert "&Find…\tCtrl+F" in edit_labels
    assert "&Replace…\tCtrl+H" in edit_labels

    help_labels = [action.text() for action in window._help_menu.actions()]
    assert help_labels == ["&Edi Guide…", "&Formula Reference…", "", "&About Edi…"]

    toolbar_actions = [
        action
        for action in window._view_menu.actions()
        if action.text().startswith("&Toolbar")
    ]
    assert toolbar_actions
    assert toolbar_actions[0].isCheckable()
    assert toolbar_actions[0].isChecked() is True


def test_update_menu_state_toggles_actions(visible, qtbot):
    window = visible
    assert window._revert_action.isEnabled() is False
    assert window._copy_path_action.isEnabled() is False
    assert window._toolbar_action.isChecked() is True
    assert window._insert_actions is not None
    assert all(action.isEnabled() for action in window._insert_actions)

    window.update_menu_state(
        can_revert=True, can_copy_path=True, toolbar_visible=False
    )
    assert window._revert_action.isEnabled() is True
    assert window._copy_path_action.isEnabled() is True
    assert window._toolbar_action.isChecked() is False
    assert all(action.isEnabled() for action in window._insert_actions)

    window.update_menu_state(
        can_revert=False, can_copy_path=False, toolbar_visible=True
    )
    assert window._revert_action.isEnabled() is False
    assert window._copy_path_action.isEnabled() is False
    assert window._toolbar_action.isChecked() is True
    assert all(action.isEnabled() for action in window._insert_actions)


def _menu_action(menu, prefix):
    return next(action for action in menu.actions() if action.text().startswith(prefix))


def _swap_menu_command(window, body):
    """Record what the menu sends instead of acting on it.

    The real dispatcher is kept in ``window.__realMenuCommand``: these tests
    replace a page global, and the session window is shared with the real-engine
    mermaid tests, so a stub left behind would silently no-op every later
    command (``_restore_menu_command`` puts it back).
    """
    window._web.page().runJavaScript(
        "window.__menuCmd = null; window.__menuArgs = null;"
        "window.__realMenuCommand = window.ediMenuCommand;"
        "window.ediMenuCommand = function (cmd, arg) { " + body + " };"
        "true",
        lambda _v: None,
    )


def _restore_menu_command(window):
    window._web.page().runJavaScript(
        "if (window.__realMenuCommand) window.ediMenuCommand = window.__realMenuCommand;"
        "true",
        lambda _v: None,
    )


def _assert_menu_action_sends_command(visible, qtbot, action, expected):
    """Trigger ``action`` and assert the page's dispatcher received ``expected``."""
    window = visible
    result = {}

    _swap_menu_command(window, "window.__menuCmd = cmd;")
    action.trigger()
    _restore_menu_command(window)

    def fetched():
        window._web.page().runJavaScript(
            "window.__menuCmd", lambda v: result.__setitem__("value", v)
        )
        return result.get("value") is not None

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == expected


def test_menu_action_invokes_js_command(visible, qtbot):
    _assert_menu_action_sends_command(
        visible, qtbot, _menu_action(visible._file_menu, "&Open…"), "open"
    )


def test_copy_file_path_action_invokes_js_command(visible, qtbot):
    visible.update_menu_state(
        can_revert=True, can_copy_path=True, toolbar_visible=True
    )
    _assert_menu_action_sends_command(
        visible, qtbot, visible._copy_path_action, "copyFilePath"
    )


def test_view_menu_toolbar_action_invokes_js_command(visible, qtbot):
    _assert_menu_action_sends_command(
        visible, qtbot, _menu_action(visible._view_menu, "&Toolbar"), "toggleToolbar"
    )


def test_help_menu_edi_guide_action_invokes_js_command(visible, qtbot):
    _assert_menu_action_sends_command(
        visible, qtbot, _menu_action(visible._help_menu, "&Edi Guide"), "helpGuide"
    )


def test_about_action_opens_dialog_with_logo_and_version(visible, qtbot):
    window = visible
    about_action = next(
        action for action in window._help_menu.actions() if "About" in action.text()
    )
    about_action.trigger()

    dialog = {"value": None}

    def active_dialog():
        widget = QApplication.activeModalWidget()
        if isinstance(widget, QDialog):
            dialog["value"] = widget
            return True
        return False

    qtbot.waitUntil(active_dialog, timeout=3000)
    box = dialog["value"]
    assert box.windowTitle() == "About Edi"

    labels = box.findChildren(QLabel)
    texts = {label.text() for label in labels}
    assert "Edi" in texts
    assert f"Version {__version__}" in texts
    assert any(label.pixmap() is not None and not label.pixmap().isNull() for label in labels)

    box.accept()
    qtbot.waitUntil(lambda: QApplication.activeModalWidget() is None, timeout=2000)


def test_page_allows_non_main_frame_navigation(visible):
    page = visible._web.page()
    assert (
        page.acceptNavigationRequest(
            QUrl("https://example.com/iframe"),
            QWebEnginePage.NavigationType.NavigationTypeLinkClicked,
            False,
        )
        is True
    )


def test_is_main_index_file_accepts_windows_and_native_separators():
    """QUrl.toLocalFile() keeps forward slashes on Windows while Path uses
    backslashes; _AppPage must match index.html either way or the webview
    renders blank."""
    expected = str(DIST_DIR / "index.html")
    assert _is_main_index_file(expected) is True
    assert _is_main_index_file(expected.replace("/", "\\")) is True


def test_main_frame_index_navigation_is_accepted(visible):
    page = visible._web.page()
    url = QUrl.fromLocalFile(str(DIST_DIR / "index.html"))
    assert (
        page.acceptNavigationRequest(
            url,
            QWebEnginePage.NavigationType.NavigationTypeTyped,
            True,
        )
        is True
    )


def test_load_app_icon_none_when_no_icon_file(monkeypatch):
    monkeypatch.setattr(window_module, "_find_icon", lambda: None)
    assert window_module.load_app_icon() is None


def test_load_about_logo_none_when_no_icon_file(monkeypatch):
    monkeypatch.setattr(window_module, "_find_icon", lambda: None)
    assert window_module.load_about_logo() is None


def test_load_about_logo_none_when_pixmap_null(monkeypatch, tmp_path):
    bogus = tmp_path / "bogus.png"
    bogus.write_bytes(b"not a png")
    monkeypatch.setattr(window_module, "_find_icon", lambda: bogus)
    assert window_module.load_about_logo() is None


def test_load_qwebchannel_js_raises_without_vendored_or_resource(monkeypatch):
    monkeypatch.setattr(window_module, "_QWEBCHANNEL_JS", Path("/nonexistent/qwebchannel.js"))

    class _FakeQFile:
        class OpenModeFlag:
            ReadOnly = 0

        def __init__(self, *_args, **_kwargs):
            pass

        def open(self, *_args, **_kwargs):
            return False

        def readAll(self):
            return b""

    monkeypatch.setattr(window_module, "QFile", _FakeQFile)
    with pytest.raises(FileNotFoundError, match="qwebchannel.js"):
        window_module._load_qwebchannel_js()


def test_load_qwebchannel_js_uses_resource_fallback(monkeypatch):
    monkeypatch.setattr(window_module, "_QWEBCHANNEL_JS", Path("/nonexistent/qwebchannel.js"))

    class _FakeQFile:
        class OpenModeFlag:
            ReadOnly = 0

        def __init__(self, *_args, **_kwargs):
            pass

        def open(self, *_args, **_kwargs):
            return True

        def readAll(self):
            return b"resource qwebchannel js"

    monkeypatch.setattr(window_module, "QFile", _FakeQFile)
    assert window_module._load_qwebchannel_js() == "resource qwebchannel js"


def test_find_icon_returns_none_when_no_candidates(monkeypatch):
    monkeypatch.setattr(sys, "_MEIPASS", "/nonexistent/meipass", raising=False)
    monkeypatch.setattr(Path, "is_file", lambda _self: False)
    assert window_module._find_icon() is None
    assert window_module.load_app_icon() is None
    assert window_module.load_about_logo() is None


def test_open_external_url_falls_back_to_desktop_service(visible, monkeypatch):
    window = visible
    captured = {}

    class _FakeDesktop:
        @staticmethod
        def openUrl(url):
            captured["url"] = url.toString()

    monkeypatch.setattr(window_module, "_xdg_open", lambda _url: False)
    monkeypatch.setattr(window_module, "QDesktopServices", _FakeDesktop)
    window.open_external_url("https://example.com/x")
    assert captured["url"] == "https://example.com/x"


def test_is_dirty_reflects_set_dirty(visible):
    window = visible
    window.set_dirty(True)
    assert window.is_dirty() is True
    window.set_dirty(False)
    assert window.is_dirty() is False


def test_set_title_updates_window_title(visible):
    window = visible
    window.set_title("notes.md — Edi")
    assert window.windowTitle() == "notes.md — Edi"
    window.set_title("")
    assert window.windowTitle() == "Edi"


def test_app_url_selftest_query():
    assert window_module._app_url(is_selftest=True).query() == "selftest=1"
    assert window_module._app_url(is_selftest=False).query() == ""
    assert (
        window_module._app_url(is_selftest=True).toLocalFile()
        == str(DIST_DIR / "index.html")
    )


def test_recent_files_single_entry_reads_back_across_processes(window, stored_recents):
    # QSettings' native format stores a one-element QStringList as a scalar
    # (`recentFiles=/only/x.md`), so a fresh process reads a str, not a list.
    # Simulate that persisted shape and confirm it still round-trips.
    stored_recents.setValue("recentFiles", "/only/x.md")
    assert window.recent_files() == ["/only/x.md"]


def test_right_click_context_menu_is_suppressed(window):
    web = window._web
    assert isinstance(web, _AppWebView)
    event = QContextMenuEvent(
        QContextMenuEvent.Reason.Mouse,
        QPoint(20, 20),
        QPoint(20, 20),
    )
    QApplication.sendEvent(web, event)
    assert event.isAccepted()
    QApplication.processEvents()
    assert QApplication.activePopupWidget() is None


def test_add_recent_file_deduplicates_and_caps(window, stored_recents):
    assert window.recent_files() == []

    window.add_recent_file("/x/a.md")
    window.add_recent_file("/x/b.md")
    window.add_recent_file("/x/a.md")  # dup moves back to the front
    assert window.recent_files() == ["/x/a.md", "/x/b.md"]

    for i in range(10):
        window.add_recent_file(f"/x/f{i}.md")
    recent = window.recent_files()
    assert len(recent) == window_module.RECENT_LIMIT
    assert recent[0] == "/x/f9.md"
    assert "/x/b.md" not in recent


def test_open_recent_menu_lists_stored_recent_files(window, stored_recents):
    stored_recents.setValue("recentFiles", ["/docs/a.md", "/other/b.md"])
    window._refresh_recent_menu()

    entries = window._recent_menu.actions()
    assert [action.text() for action in entries] == [
        "a.md — /docs",
        "b.md — /other",
    ]
    assert [action.toolTip() for action in entries] == ["/docs/a.md", "/other/b.md"]
    assert all(action.isEnabled() for action in entries)


def test_open_recent_menu_replaces_previous_entries(window, stored_recents):
    stored_recents.setValue("recentFiles", ["/docs/a.md"])
    window._refresh_recent_menu()
    stored_recents.setValue("recentFiles", ["/other/b.md"])
    window._refresh_recent_menu()

    assert [action.text() for action in window._recent_menu.actions()] == [
        "b.md — /other"
    ]


def test_open_recent_menu_is_disabled_placeholder_when_empty(window, stored_recents):
    window._refresh_recent_menu()

    entries = window._recent_menu.actions()
    assert [action.text() for action in entries] == ["No recent documents"]
    assert entries[0].isEnabled() is False


def test_recent_label_falls_back_to_the_raw_path():
    assert window_module._recent_label("notes.md") == "notes.md"
    assert window_module._recent_label("/docs/notes.md") == "notes.md — /docs"


def test_open_recent_action_invokes_js_command_with_path(
    visible, qtbot, stored_recents
):
    window = visible
    stored_recents.setValue("recentFiles", ["/docs/a.md"])
    result = {}

    _swap_menu_command(window, "window.__menuArgs = cmd + ':' + (arg || '');")

    window._refresh_recent_menu()
    window._recent_menu.actions()[0].trigger()
    _restore_menu_command(window)

    def fetched():
        window._web.page().runJavaScript(
            "window.__menuArgs", lambda v: result.__setitem__("value", v)
        )
        return result.get("value") is not None

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == "openRecent:/docs/a.md"


def test_pick_save_path_cancel_returns_none(visible, qtbot):
    window = visible
    result = {}
    window.pick_save_path("notes", lambda path: result.__setitem__("path", path))

    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    QApplication.activeModalWidget().reject()
    qtbot.waitUntil(lambda: "path" in result, timeout=3000)
    assert result["path"] is None


def test_pick_export_path_cancel_returns_none(visible, qtbot):
    window = visible
    result = {}
    window.pick_export_path("out", lambda path: result.__setitem__("path", path))

    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    QApplication.activeModalWidget().reject()
    qtbot.waitUntil(lambda: "path" in result, timeout=3000)
    assert result["path"] is None


def test_pick_image_save_path_cancel_returns_none(visible, qtbot):
    window = visible
    result = {}
    window.pick_image_save_path("diagram", lambda path: result.__setitem__("path", path))

    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    QApplication.activeModalWidget().reject()
    qtbot.waitUntil(lambda: "path" in result, timeout=3000)
    assert result["path"] is None


def test_save_image_flow_via_bridge(visible, qtbot, tmp_path):
    """Save-image round trip: dialog yields a path, then writeBinaryFile writes
    the rasterized base64 PNG (validated by QImage) to disk byte-for-byte."""
    window = visible
    target = tmp_path / "diagram.png"

    image = QImage(4, 4, QImage.Format_ARGB32)
    image.fill(Qt.GlobalColor.darkCyan)
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    assert image.save(buffer, "PNG")
    png = bytes(buffer.data())
    encoded = base64.b64encode(png).decode("ascii")

    js = (
        "window.__saveFlow = 'pending';"
        "window.bridge.result.connect(function (payload) {"
        "  var message = JSON.parse(payload);"
        "  if (message.id === 4010) {"
        "    if (message.ok) window.bridge.invoke('writeBinaryFile', 4011, "
        f"JSON.stringify({json.dumps({'path': str(target), 'data': encoded})}));"
        "    else window.__saveFlow = 'pick failed: ' + message.error;"
        "  } else if (message.id === 4011) {"
        "    window.__saveFlow = message.ok ? 'written' : 'write failed: ' + message.error;"
        "  }"
        "});"
        "window.bridge.invoke('pickImageSavePath', 4010, '{\"defaultName\":\"diagram\"}');"
        "true"
    )
    window._web.page().runJavaScript(js, lambda _v: None)

    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    dialog = QApplication.activeModalWidget()
    dialog.selectFile(str(target))
    dialog.accept()

    result = {}

    def fetched():
        window._web.page().runJavaScript(
            "window.__saveFlow", lambda v: result.__setitem__("value", v)
        )
        return (
            "value" in result and result["value"] is not None and result["value"] != "pending"
        )

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == "written"
    assert target.read_bytes() == png


def test_pick_text_import_path_cancel_returns_none(visible, qtbot):
    window = visible
    result = {}
    window.pick_text_import_path(lambda path: result.__setitem__("path", path))

    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    QApplication.activeModalWidget().reject()
    qtbot.waitUntil(lambda: "path" in result, timeout=3000)
    assert result["path"] is None


def test_about_dialog_drag_and_release(visible):
    dialog = window_module._AboutDialog(visible)

    press = QMouseEvent(
        QEvent.Type.MouseButtonPress,
        QPointF(50, 30),
        QPointF(500, 400),
        Qt.MouseButton.LeftButton,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )
    dialog.mousePressEvent(press)
    assert press.isAccepted()
    assert dialog._drag_offset is not None

    move = QMouseEvent(
        QEvent.Type.MouseMove,
        QPointF(80, 60),
        QPointF(530, 430),
        Qt.MouseButton.NoButton,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )
    dialog.mouseMoveEvent(move)
    assert move.isAccepted()

    release = QMouseEvent(
        QEvent.Type.MouseButtonRelease,
        QPointF(80, 60),
        QPointF(530, 430),
        Qt.MouseButton.NoButton,
        Qt.MouseButton.LeftButton,
        Qt.KeyboardModifier.NoModifier,
    )
    dialog.mouseReleaseEvent(release)
    assert dialog._drag_offset is None


def test_about_dialog_non_drag_mouse_events(visible):
    dialog = window_module._AboutDialog(visible)

    right_press = QMouseEvent(
        QEvent.Type.MouseButtonPress,
        QPointF(5, 5),
        QPointF(5, 5),
        Qt.MouseButton.RightButton,
        Qt.MouseButton.RightButton,
        Qt.KeyboardModifier.NoModifier,
    )
    dialog.mousePressEvent(right_press)
    assert dialog._drag_offset is None

    no_button_move = QMouseEvent(
        QEvent.Type.MouseMove,
        QPointF(5, 5),
        QPointF(5, 5),
        Qt.MouseButton.NoButton,
        Qt.MouseButton.NoButton,
        Qt.KeyboardModifier.NoModifier,
    )
    dialog.mouseMoveEvent(no_button_move)
    assert dialog._drag_offset is None


def test_runnable_code_block_result_cell_shows_output(visible, qtbot):
    import json as _json

    window = visible
    result = {}

    def js(code, cb):
        window._web.page().runJavaScript(code, cb or (lambda _v: None))

    md = (
        "```\n"
        "#!/usr/bin/env python3\n"
        'print("Hello, World!")\n'
        "```"
    )
    js("window.ediSetContent(" + _json.dumps(md) + "); true", None)
    time.sleep(1.0)

    button = {"clicked": False, "click": None}

    def run_button_clicked():
        if not button["clicked"]:
            button["clicked"] = True
            def done(v):
                button["click"] = v
            js(
                "(function(){var b=document.querySelector('.exec-run');"
                "if(!b) return 'NOBTN'; b.click(); return 'CLICKED';})()",
                done,
            )
        return button["click"] is not None

    assert _pump_until(run_button_clicked, timeout=5), "Run button not rendered"
    assert button["click"] == "CLICKED"

    # Output appears incrementally while the run is in flight: the run streams
    # stdout live (line by line via a pty), so the cell fills up before the
    # process exits. Wait for the run to finish (Run returns to its idle state)
    # so the final trimmed result is what we assert against.
    def run_finished():
        def done(v):
            result["done"] = v
        js(
            "(document.querySelector('.exec-run')||{}).textContent||''",
            done,
        )
        return result.get("done") == "Run"

    assert _pump_until(run_finished, timeout=20), "run never completed"

    def read_output():
        def done(v):
            result["out"] = v
        js(
            "(document.querySelector('.exec-output')||{}).textContent||''",
            done,
        )
        return result.get("out") not in (None, "")

    assert _pump_until(read_output, timeout=20), "output cell never populated"
    assert result["out"] == "Hello, World!"


# --- Mermaid visual editing (src/mermaid-edit.ts) ---------------------------------
# These stay in this module on purpose: they render in the session window above,
# after every other test has run. A module of their own would need a second
# MainWindow -- another WebEngine page -- and the real-engine template sweep
# already takes two, which is all a small container can bring up.


def test_visual_edit_mode_and_label_commit(window):
    _render(window, FLOW)
    assert _dump(window, EDIT_STATE)["marked"] == 0, "the preview is not read-only"

    _enter_edit_mode(window)
    state = _dump(window, EDIT_STATE)
    assert state["editing"], "the block did not get the editing class"
    assert state["marked"] >= 3, state  # Alpha, Beta and the Yes edge label
    assert state["button"] == "Done", state

    assert _click_label(window, "Alpha") == "Alpha"
    _type_and_confirm(window, "Renamed")
    # The bug this pins: the source was patched but the SVG kept the old
    # glyphs, because the node view skipped the re-render.
    texts = _wait_text(window, ["Renamed"])
    assert "Alpha" not in texts, texts
    assert not _dump(
        window,
        "(() => ({ notice: !!document.querySelector('.mermaid-edit-notice'),"
        " error: !!document.querySelector('.mermaid-error') }))()",
    )["notice"]


def test_kanban_label_edit_and_card_drag(window):
    _render(window, KANBAN)
    _enter_edit_mode(window)

    # Chromium makes SVG nodes natively draggable, and its own drag swallows
    # the pointer stream: the card would snap back and nothing would happen.
    assert _dump(
        window,
        "(() => { const c = document.querySelector('.mermaid .items > g.node');"
        " const e = new Event('dragstart', { bubbles: true, cancelable: true });"
        " c.dispatchEvent(e); return { prevented: e.defaultPrevented }; })()",
    )["prevented"], "a native drag would swallow the pointer stream"

    assert _click_label(window, "One") == "One"
    _type_and_confirm(window, "Renamed")
    _wait_text(window, ["Renamed"])

    _pointer_drag(window, card=0, section=1)
    cols = _wait(
        window,
        COLUMNS,
        lambda d: any("Renamed" in cards for cards in d["cols"].values()),
        timeout=15,
    )["cols"]
    # Mermaid lays a column's cards out side by side, so the renamed card is the
    # right-hand one now: the drag crossed into the second column.
    assert sorted(cols.values(), key=len)[0] == ["Two"], cols
    assert ["Renamed", "Three"] in [sorted(c) for c in cols.values()], cols


def _add_sits_in_its_band(add):
    """A ＋ is only ever offered centred in its own column and in the bottom of
    it, so that is what both a zoom and the re-render have to preserve."""
    band = add["band"]
    return (
        abs(add["x"] - band["x"]) <= 1.0
        and add["y"] > (band["top"] + band["bottom"]) / 2
        and add["y"] <= band["bottom"] + 1.0
    )



def test_kanban_add_button_creates_a_card(window):
    """The per-column ＋ creates a card in that column, as one source patch.

    Real browser only, because the whole feature is geometry: a button placed
    from the section rect, repositioned when the zoom toolbar rescales it, and
    rebuilt by the re-render the commit triggers.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)

    adds = _wait(window, KANBAN_ADDS, lambda d: d["n"] == 3, timeout=15)
    assert [a["label"] for a in adds["adds"]] == [
        "Add a card to Todo",
        "Add a card to Doing",
        "Add a card to Done",
    ], adds
    assert all(_add_sits_in_its_band(add) for add in adds["adds"]), adds
    # The empty column is the one worth checking: mermaid sizes its band to the
    # header alone, so the band (and the ＋ in it) is much shorter (50px against
    # 79px for a column holding a card).
    empty = adds["adds"][1]
    assert empty["band"]["height"] * 1.5 < adds["adds"][0]["band"]["height"], adds

    # A zoom rescales every section rect, so the overlay has to follow it. The
    # whole diagram is re-centred as it widens, so "followed" means the ＋ is
    # still in its own band, not that it moved right.
    _zoom(window, "+")
    zoomed = _wait(
        window,
        KANBAN_ADDS,
        lambda d: d["n"] == 3
        and d["adds"][0]["band"]["width"] > adds["adds"][0]["band"]["width"]
        and all(_add_sits_in_its_band(a) for a in d["adds"]),
        timeout=15,
    )
    _zoom(window, "100%")

    opened = _click_kanban_add(window, 1)
    assert opened["v"] == "" and opened["ph"] == "New card in Doing", opened
    _type_and_confirm(window, "Fresh")
    state = _wait(
        window,
        LABEL_STATE,
        lambda d: any("Fresh" in t for t in d["texts"]),
        timeout=20,
    )
    assert not state["input"] and not state["error"] and not state["notice"], state
    assert state["source"] and "    [Fresh]" in state["source"], state
    # Into the column that was pressed: the empty one, so its band grew.
    cols = _wait(
        window,
        COLUMNS,
        lambda d: any("Fresh" in cards for cards in d["cols"].values()),
        timeout=15,
    )["cols"]
    assert ["Fresh"] in [sorted(cards) for cards in cols.values()], cols

    # The render replaced the SVG and with it the overlay, so the ＋ are back --
    # still one per column, and still in their own bands.
    adds = _wait(window, KANBAN_ADDS, lambda d: d["n"] == 3, timeout=15)
    assert all(_add_sits_in_its_band(add) for add in adds["adds"]), adds
    assert adds["adds"][1]["band"]["height"] > empty["band"]["height"], adds

    # ...and the input it opens is the same one a label edit uses, so Esc is
    # the same way out of it.
    _click_kanban_add(window, 0)
    _type(window, "Discarded")
    _dump(
        window,
        "(() => { const i = document.querySelector('.mermaid-edit-input');"
        " i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));"
        " return { closed: true }; })()",
    )
    after = _wait(window, LABEL_STATE, lambda d: not d["input"], timeout=10)
    assert "Discarded" not in (after["source"] or ""), after
    assert _dump(window, KANBAN_ADDS)["n"] == 3, "the ＋ did not survive a cancelled card"


def test_double_click_below_a_lone_board_ends_its_edit_session(window):
    """A double click under a board that is the whole document ends its edit
    session — the gesture that turns the mode off should not have to land back
    on the diagram.

    Real browser only, and the geometry is the whole point: the editor's box is
    only as tall as its content, so a document of one board leaves the space
    below it on the *scroller*. A listener on the editor's own box never sees
    that click (and the browser answers it by selecting the document name in the
    status bar instead), which is what this test pins down.
    """
    _set_scheme(window, False)
    _render(window, KANBAN_LONE)
    _enter_edit_mode(window)
    assert _dump(window, EDIT_STATE)["editing"], "the board never opened for editing"

    spot = _dblclick_below_document(window)
    assert not spot["inEditor"], f"the double click landed inside the editor: {spot}"

    after = _wait(window, EDIT_STATE, lambda d: not d["editing"], timeout=10)
    assert not after["marked"], after
    # The ＋ are edit mode's, so they go with it.
    assert _dump(window, KANBAN_ADDS)["n"] == 0, "the ＋ outlived the edit session"

    # ...and the gesture is not the editor's own: a second one is harmless, and
    # the board can be reopened and ended again.
    _enter_edit_mode(window)
    assert _dump(window, EDIT_STATE)["editing"], "the board did not reopen"
    _dblclick_below_document(window)
    assert _wait(window, EDIT_STATE, lambda d: not d["editing"], timeout=10)["marked"] == 0


def test_every_quoted_kanban_delimiter_renders_and_reads_back(window):
    """Every character `KANBAN_QUOTE_CHARS` (src/mermaid-edit.ts) quotes renders
    when quoted, and reads back without the quotes.

    Real browser only. Real mermaid rejects only `]`, `(`, `)` and `}` in a
    *bare* label -- a 40-diagram sweep, one per character, found `[`, `{`, `<`
    and a stray `>` all render -- so the set is deliberately wider than the
    minimum, for two reasons of our own: a bare `@{ … }` is eaten as metadata,
    and a bare `>` is a shape `kanbanLabelSpan` refuses to map back. This pins
    the half that could actually break: quoting is *always* writable, so the
    superset costs invisible quotes and never a board.
    """
    _set_scheme(window, False)
    chars = list("[](){}@>")
    # One diagram per character: a board that fails to parse takes only itself
    # down, so all eight verdicts arrive in a single render pass.
    doc = "".join('```mermaid\nkanban\n  Todo\n    ["Fix ' + ch + ' it"]\n```\n\n' for ch in chars)
    _set_document(window, doc, expect_text="Fix")

    def drawn(d):
        return all(f"Fix {ch} it" in " ".join(d["texts"]) for ch in chars)

    state = _wait(
        window,
        "(() => { const bs = [...document.querySelectorAll('.mermaid')];"
        " const labels = (b) => { const s = b.querySelector('.mermaid-preview svg');"
        "   return s ? [...s.querySelectorAll("
        "     'text, .nodeLabel, .edgeLabel, .labelText, .loopText, .titleText,"
        " .sectionTitle, .taskText')].map((t) => t.textContent.trim()) : []; };"
        " return { n: bs.length,"
        "   errs: bs.map((b) => { const e = b.querySelector('.mermaid-error');"
        "     return e ? e.textContent.replace(/\\s+/g, ' ').slice(0, 70) : null; }),"
        "   texts: bs.flatMap(labels) }; })()",
        lambda d: d["n"] == len(chars) and (drawn(d) or any(d["errs"])),
        timeout=25,
    )
    assert not any(state["errs"]), state["errs"]
    assert drawn(state), state["texts"]
    # Drawn as the text inside the quotes: a board never shows them.
    assert not any('"' in t for t in state["texts"]), state["texts"]


def test_kanban_titles_holding_delimiters_stay_editable(window):
    """A title holding a delimiter is quoted in the source and drawn without the
    quotes -- and adding or renaming one keeps working.

    Real browser only: whether ``["Fix (bug)"]`` parses, draws as ``Fix (bug)``
    and accepts a rename is mermaid's own grammar, which no jsdom test can
    confirm. This is the path that used to strand a board on its last good
    render, so it asserts the board is still *editable* throughout, not just
    that the text is somewhere.
    """
    _set_scheme(window, False)
    _render(window, KANBAN_QUOTED)
    _enter_edit_mode(window)

    # Drawn as the text inside the quotes: the board never shows them.
    drawn = _wait(
        window,
        LABEL_STATE,
        lambda d: any("Fix (the bug)" in t for t in d["texts"]),
        timeout=20,
    )
    assert not any('"' in t for t in drawn["texts"]), drawn

    # Offered for editing, because the span is the whole quoted run.
    assert _click_label(window, "Fix (the bug)") == "Fix (the bug)"
    _type_and_confirm(window, "Ship (v2)")
    renamed = _wait(
        window,
        LABEL_STATE,
        lambda d: any("Ship (v2)" in t for t in d["texts"]),
        timeout=20,
    )
    assert renamed["source"].count('"Ship (v2)"') == 1, renamed
    assert not renamed["error"] and not renamed["notice"], renamed
    # The quoted column header, the other shape our own quoting writes.
    assert _click_label(window, "Doing (now)") == "Doing (now)"
    _type_and_confirm(window, "Doing (later)")
    header = _wait(
        window,
        LABEL_STATE,
        lambda d: any("Doing (later)" in t for t in d["texts"]),
        timeout=20,
    )
    assert header["source"].count('"Doing (later)"') == 1, header

    # A bare card is renamed into a title that needs quoting, in place.
    assert _click_label(window, "Plain") == "Plain"
    _type_and_confirm(window, "Ship (v1)")
    quoted = _wait(
        window,
        LABEL_STATE,
        lambda d: any("Ship (v1)" in t for t in d["texts"]),
        timeout=20,
    )
    assert '["Ship (v1)"]' in quoted["source"], quoted
    assert not quoted["error"] and not quoted["notice"], quoted

    # The ＋ takes the same kind of title and lands it the same way.
    _click_kanban_add(window, 0)
    _type_and_confirm(window, "Add (the log)")
    added = _wait(
        window,
        LABEL_STATE,
        lambda d: any("Add (the log)" in t for t in d["texts"]),
        timeout=20,
    )
    assert '    ["Add (the log)"]' in added["source"], added
    assert not added["error"] and not added["notice"], added

    # What no quoting can carry -- a double quote would close the label its own
    # quote opened -- is refused in place: nothing committed, the input still
    # open, the board still in edit mode, so a second attempt is one edit away.
    before = added["source"]
    _click_kanban_add(window, 1)
    _press_enter(window, 'a"b')
    refused = _wait(
        window,
        LABEL_STATE,
        lambda d: d["notice"] or d["invalid"],
        timeout=10,
    )
    assert refused["input"], f"the refused title closed the editor anyway: {refused}"
    assert refused["source"] == before, f"a refused title changed the source: {refused}"
    assert refused["editing"] and refused["editable"], f"the board stopped being editable: {refused}"
    assert not refused["error"], f"a refused title was committed anyway: {refused}"


def test_kanban_board_command_inserts_a_board_ready_to_fill(window):
    """Insert → Kanban Board… asks for columns and drops in a board that is
    already open for editing, so its per-column ＋ can be pressed straight away.

    Real browser only: it is the built source that has to satisfy real mermaid
    (``col1[…]`` columns and all) and the round-trip back out to markdown.
    """
    _set_scheme(window, False)
    # A document to insert into, so the editor is real before the command runs.
    _set_document(window, "# Tasks\n", "Tasks")
    _open_board_dialog(window, ["Todo", "Doing", "Done"])
    adds = _wait(window, KANBAN_ADDS, lambda d: d["n"] == 3, timeout=20)
    assert [add["label"] for add in adds["adds"]] == [
        "Add a card to Todo",
        "Add a card to Doing",
        "Add a card to Done",
    ], adds

    # Real mermaid accepted the built source (col1[…] columns and all), and the
    # board came up already open for editing — the ＋ above are its own.
    assert _dump(window, EDIT_STATE)["editing"], "the new board is not in edit mode"
    sections = _wait(window, SECTIONS, lambda d: d["n"] == 3, timeout=15)
    joined = " ".join(sections["sections"])
    assert all(name in joined for name in ("Todo", "Doing", "Done")), sections
    # The board round-trips: what the document holds is what mermaid rendered.
    assert _dump(window, DOC_SOURCE)["sources"] == [
        "kanban\n  col1[Todo]\n  col2[Doing]\n  col3[Done]"
    ]

    # And it behaves like any other board from here: a ＋ creates a card, in the
    # column it was pressed in.
    _click_kanban_add(window, 1)
    _type_and_confirm(window, "Write the spec")
    state = _wait(
        window, LABEL_STATE, lambda d: any("Write the spec" in t for t in d["texts"]), timeout=20
    )
    assert not state["notice"], state
    filled = _wait(
        window,
        CARDS_AND_BANDS,
        lambda d: any(c["text"] == "Write the spec" for c in d["cards"]),
        timeout=15,
    )
    card = next(c for c in filled["cards"] if c["text"] == "Write the spec")
    landed = min(range(len(filled["bands"])), key=lambda k: abs(card["x"] - filled["bands"][k]))
    assert sections["sections"][landed] == "Doing", (card, filled, sections)
    _wait(
        window,
        DOC_SOURCE,
        lambda d: d["sources"]
        == ["kanban\n  col1[Todo]\n  col2[Doing]\n    [Write the spec]\n  col3[Done]"],
        timeout=10,
    )

    # A cancelled dialog inserts nothing at all.
    _open_board_dialog(window)
    _cancel_board_dialog(window)
    _wait(window, BOARD_DIALOG, lambda d: not d["present"], timeout=10)
    assert _dump(window, DOC_SOURCE)["sources"] == [
        "kanban\n  col1[Todo]\n  col2[Doing]\n    [Write the spec]\n  col3[Done]"
    ]


def test_sequence_participant_wrapped_in_a_tspan_is_editable(window):
    _set_scheme(window, True)
    _render(window, SEQUENCE)
    # Sequence diagrams paint light native text, so the view mode bakes them to
    # a bitmap; edit mode has to unbake, or no label stays clickable.
    _wait_baked(window, timeout=25)
    markup = _dump(
        window,
        "(() => { const t = document.querySelector('.mermaid-preview svg text.actor');"
        " return { hasTspan: !!(t && t.querySelector('tspan')),"
        " text: t ? t.textContent.trim() : '' }; })()",
    )
    assert markup["hasTspan"], markup  # the shape this test is really about
    assert markup["text"] in ("Alice", "Bob"), markup  # mermaid's own order

    _enter_edit_mode(window)
    assert not _dump(
        window, "(() => ({ img: !!document.querySelector('.mermaid img.mermaid-img') }))()"
    )["img"], "edit mode left the diagram baked"

    assert _click_label(window, "Alice") == "Alice"
    _type_and_confirm(window, "Zoe")
    # Mermaid draws each participant twice (lifeline head and foot), so one
    # rename must repaint both: proof the tspan-wrapped label was really the
    # one that got committed.
    texts = _wait_text(window, ["Zoe"])
    assert texts.count("Zoe") == 2, texts
    assert "Alice" not in texts, texts
    _set_scheme(window, False)


# One case per distinct patch strategy, so a regression in any of them names
# itself. The probe (scripts/mermaid-label-probe.py) walks every label of every
# template; this is the cheap slice that runs on every commit, and it can only
# afford one rename per diagram. `expect` is which of the app's two documented
# outcomes the rename must take: "drawn" (mermaid rendered it) or "refused" (it
# refused the rewritten source and the editor said so, last good diagram up).
LABEL_CASES = [
    pytest.param(FLOW, "Alpha", "drawn", id="flowchart-text"),
    pytest.param(SEQUENCE, "Alice", "drawn", id="sequence-tspan"),
    pytest.param("classDiagram\n  class Shape {\n    +area()\n  }", "Shape", "drawn", id="class-entity"),
    pytest.param("stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy", "Idle", "drawn", id="state-entity"),
    # `date` is a type here and `placed` its name: whole-word matching is what
    # keeps the type from also matching inside a name like `order_date`.
    pytest.param(
        "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n"
        "    string id PK\n    date placed\n  }",
        "CUSTOMER",
        "drawn",
        id="er-entity",
    ),
    # Mermaid draws the row under its own idea of the key, so the input holds
    # the value alone -- exactly the span the patch replaces.
    pytest.param(
        "requirementDiagram\n  requirement test_req {\n    id: 1\n"
        "    text: the test text\n    risk: high\n    verifymethod: test\n  }",
        "Text: ",
        "drawn",
        id="requirement-value-only",
    ),
    # A sankey node shares its element with its computed total.
    pytest.param(
        "sankey-beta\n\nAgricultural waste,Bio-conversion,124.729\nBio-conversion,Liquid,0.597",
        "Agricultural waste",
        "drawn",
        id="sankey-first-line",
    ),
    # `main` is mermaid's implicit first branch: it is named by the `checkout`
    # alone, so a rename points at a branch that was never declared and mermaid
    # refuses the source. The patch still has to land, and the notice has to
    # appear -- that is the whole contract for an invalid value.
    # Ids on the commits: mermaid draws a bare `commit` as the literal word,
    # and that word is in the source on every line, so no commit label maps.
    pytest.param(
        'gitGraph\n    commit id: "Initial commit"\n    branch develop\n    checkout develop\n'
        '    commit id: "Feature work"\n    checkout main\n    merge develop\n    commit id: "Release v1.0"',
        "main",
        "refused",
        id="git-branch-refused",
    ),
    # Mermaid draws the root's total next to its label; the total is not in the
    # source, so it must not be offered (GENERATED_BY_FAMILY in mermaid-edit.ts).
    pytest.param('treemap-beta\n"Root"\n  "Alpha": 40\n  "Beta": 10', None, "withheld", id="treemap-withholds-total"),
]


def test_leaving_edit_mode_resolves_the_label_being_edited(window):
    """Finishing a diagram while a label is being retyped has to land, not
    strand. Real browser only: Done's own press keeps the label input focused,
    so nothing else (no blur) will resolve it -- the toggle has to. And a double
    click outside the diagram finishes edit mode the same way, while leaving
    the click to the page underneath."""
    md = f"```mermaid\n{FLOW}\n```\n\nAfter the diagram\n"
    window._web.page().runJavaScript(f"window.ediSetContent({json.dumps(md)}); true")
    _wait(
        window,
        "(() => ({ n: document.querySelectorAll('.mermaid .mermaid-preview svg').length }))()",
        lambda d: d["n"] > 0,
        timeout=20,
    )

    _enter_edit_mode(window)
    seeded = _click_first_offered(window, "Alpha")
    assert seeded == "Alpha", seeded
    _type(window, "Beta")

    # Done, mid-edit.
    _click_done(window)
    state = _wait(
        window,
        LABEL_STATE,
        lambda d: not d["input"] and not d["editing"],
        timeout=20,
    )
    assert not state["editable"], "the diagram kept its edit layer after Done"
    assert not state["error"], state
    assert state["source"] and "A[Beta]" in state["source"], "Done dropped the pending edit"
    assert any("Beta" in t for t in state["texts"]), state

    # A double click outside the diagram finishes edit mode too, and a double
    # click in the label input while editing one does not.
    _enter_edit_mode(window)
    _click_first_offered(window, "Beta")
    _dump(
        window,
        "(() => { const i = document.querySelector('.mermaid-edit-input');"
        " if (!i) return { missing: true };"
        " i.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));"
        " return { in: true }; })()",
    )
    assert _dump(window, LABEL_STATE)["editing"], "a double click in the label input left edit mode"

    _dump(
        window,
        "(() => { const p = [...document.querySelectorAll('.ProseMirror p')]"
        " .find((e) => e.textContent === 'After the diagram');"
        " if (!p) return { missing: true };"
        " p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));"
        " return { hit: p.textContent }; })()",
    )
    state = _wait(window, LABEL_STATE, lambda d: not d["editing"], timeout=20)
    assert not state["input"], "the outside double click left the label editor open"
    assert not state["editable"], state


@pytest.mark.parametrize("source, needle, expect", LABEL_CASES)
def test_every_offered_label_rename_resolves(window, source, needle, expect):
    _render(window, source)
    offered = _enter_edit_mode(window)
    inv = _dump(window, LABEL_INVENTORY)
    assert not inv.get("error"), inv
    assert offered == len(inv["labels"]) and offered > 0, inv

    if expect == "withheld":
        # Only the withholding claim: the computed total is on screen, and no
        # label showing it was offered.
        assert "50" in inv["allText"], inv
        assert "50" not in inv["labels"], inv
        assert "Root" in inv["labels"], inv
        return

    if needle:
        assert any(lbl.startswith(needle) for lbl in inv["labels"]), (needle, inv["labels"])
        if "erDiagram" in source:
            assert "date" in inv["labels"], inv
    seeded = _click_first_offered(window, needle)
    assert seeded, "the editor seeded an empty value"
    value = seeded + "X"
    _type_and_confirm(window, value)
    # A drawn value can share its text element with a generated one (a sankey
    # node shows its total below its name), hence the substring test.
    drawn = lambda d: any(value in t for t in d["texts"])  # noqa: E731
    state = _wait(window, LABEL_STATE, lambda d: drawn(d) or d["notice"] or d["error"], timeout=20)
    assert not state["input"], state
    assert not state["error"], "a visual edit left an error block behind"
    assert not state["invalid"], "the label went ambiguous once edited"
    # The one thing that is never acceptable: the editor closed and the source
    # never changed, which is what an unmappable patch looks like from here.
    assert state["source"] and value in state["source"], "the patch never reached the source"
    if expect == "drawn":
        assert drawn(state), state
    else:
        assert state["notice"], "mermaid refused the source without saying so"
        assert not drawn(state), state
