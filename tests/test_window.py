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
    COLUMNS,
    EDIT_STATE,
    FLOW,
    KANBAN,
    SEQUENCE,
    _click_label,
    _dump,
    _enter_edit_mode,
    _pointer_drag,
    _pump_until,
    _render,
    _set_scheme,
    _type_and_confirm,
    _wait,
    _wait_baked,
    _wait_text,
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
    assert insert_labels == ["&Table…", "&Spreadsheet…", "&Text File…", "&Image…"]

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


def _assert_menu_action_sends_command(visible, qtbot, action, expected):
    """Trigger ``action`` and assert the page's dispatcher received ``expected``."""
    window = visible
    result = {}

    window._web.page().runJavaScript(
        "window.__menuCmd = null;"
        "window.ediMenuCommand = function (cmd) { window.__menuCmd = cmd; };"
        "true",
        lambda _v: None,
    )

    action.trigger()

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

    window._web.page().runJavaScript(
        "window.__menuArgs = null;"
        "window.ediMenuCommand = function (cmd, arg) {"
        "  window.__menuArgs = cmd + ':' + (arg || '');"
        "};"
        "true",
        lambda _v: None,
    )

    window._refresh_recent_menu()
    window._recent_menu.actions()[0].trigger()

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
