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
    COMPOSER_FIT,
    DELETE_PROMPT,
    DOC_SOURCE,
    EDIT_STATE,
    FLOW,
    KANBAN,
    KANBAN_BARE,
    KANBAN_CARD_SLOT,
    KANBAN_CHROME,
    KANBAN_COLUMN_SLOT,
    KANBAN_EMPTY,
    KANBAN_LONE,
    KANBAN_MENU,
    KANBAN_ONE,
    KANBAN_QUOTED,
    KANBAN_SHOWN,
    KANBAN_SLOTS,
    LABEL_INVENTORY,
    LABEL_STATE,
    SEQUENCE,
    SECTIONS,
    _cancel_board_dialog,
    _click_first_offered,
    _click_done,
    _answer_delete_prompt,
    _click_kanban_column_slot,
    _click_kanban_slot,
    _click_kanban_button,
    _click_kanban_menu_item,
    _composer,
    _hover,
    _open_kanban_menu,
    _press_in_the_menu_gap,
    _click_label,
    _dblclick_below_document,
    _dump,
    _enter_edit_mode,
    _open_board_dialog,
    _pointer_drag,
    _pointer_drag_column,
    _resize_view,
    _press_enter,
    _press_key,
    _shown,
    _unhover,
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


def _drawn(cards):
    """A column's own cards, without the slot the board is drawn with.

    The board is drawn with somewhere to add a card in every column, so a column
    reports one more card than it holds. A place to add is not a card.
    """
    return [card for card in cards if card != KANBAN_CARD_SLOT]


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

    mid = _pointer_drag(window, card=0, section=1)["mid"]
    # The card under the pointer is the card itself: no clone, and it is the
    # real node that moved (and paints last, so it is on top of the board).
    assert mid["clone"] is False
    assert mid["lifted"] is True
    assert mid["last"] is True
    cols = _wait(
        window,
        COLUMNS,
        lambda d: any("Renamed" in cards for cards in d["cols"].values()),
        timeout=15,
    )["cols"]
    # Mermaid lays a column's cards out side by side, so the renamed card is the
    # right-hand one now: the drag crossed into the second column. The drawn slot
    # every column is drawn with is a place rather than content, so it is not in
    # the comparison.
    assert sorted(map(_drawn, cols.values()), key=len)[0] == ["Two"], cols
    assert ["Renamed", "Three"] in [sorted(_drawn(c)) for c in cols.values()], cols


def test_kanban_drag_shows_the_slot_before_the_release(window):
    """A drag has to say where the card will land, not only where it is.

    Inside one column the slot changes with no change in what is highlighted,
    so the line in the gap is the only thing that can answer it — and the card
    the pointer carries has to be the real one, or the board shows two of it.
    """
    _render(window, KANBAN)
    _enter_edit_mode(window)
    # The board is drawn with a slot at the foot of every column and one more
    # column at the end, so there is a place to add without any chrome at all.
    slots = _wait(
        window,
        KANBAN_SLOTS,
        lambda d: len(d["cards"]) == 2 and d["column"] is not None,
        timeout=15,
    )
    bands = _wait(
        window,
        KANBAN_CHROME,
        lambda d: len(d["bands"]) == 3 and all(b["box"] for b in d["bands"]),
        timeout=15,
    )["bands"]
    band = bands[0]["box"]

    # Card 0 down its own column, to the last slot: the drop index changes, the
    # highlighted column does not.
    drag = _pointer_drag(window, card=0, section=0, aim="last")
    mid = drag["mid"]
    assert mid["clone"] is False, "the drag drew a second copy of the card"
    assert mid["lifted"] is True
    # The card under the pointer is the one that moved, by the pointer's own
    # distance: neither twice as far, nor stuck, nor a copy that lags behind.
    travel = mid["travel"]
    assert abs(travel["dx"] - travel["px"]) <= 1.0, mid
    assert abs(travel["dy"] - travel["py"]) <= 1.0, mid
    # It is painted there too, and on top of the board it is passing over — the
    # svg paints in document order, so a card that stayed in its slot would be
    # drawn under its neighbours however well it followed the pointer.
    assert mid["atPointer"] is True, mid
    assert mid["target"] is True
    # Mermaid's svg clips and the preview scrolls, so a card that travelled off
    # the board would be cut off without the drag switching both off.
    assert mid["unclipped"] is True
    assert mid["scrolled"] is False
    # The line is in the target column, spanning it, and in the last slot — which
    # is where the release is about to act. It overhangs the column a little on
    # each side so it still shows either side of the card covering it.
    line = mid["line"]
    assert line is not None and line["shown"] is True, mid
    assert line["x"] >= band["left"] - 6, mid
    assert 0 < line["w"] <= band["right"] - band["left"] + 12, mid
    assert line["y"] > (band["top"] + band["bottom"]) / 2, mid
    # The line is an svg child ahead of the cards, so it is painted over the
    # column's own background and under every card — the dragged one included,
    # which is what reads as "this card is over the gap".
    assert mid["lineUnder"] is True, mid
    assert "line" in mid["overLine"], mid
    # The slots the drag was aimed between are still the board's own, afterwards.
    assert _wait(
        window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 2, timeout=15
    )["cards"], slots

    cols = _wait(
        window,
        COLUMNS,
        lambda d: ["Two", "One"] in [_drawn(cards) for cards in d["cols"].values()],
        timeout=15,
    )["cols"]
    # The card went to the bottom of its own column, the gap the line was in.
    assert ["Two", "One"] in [_drawn(cards) for cards in cols.values()], cols


def test_kanban_column_drag_reorders_the_board(window):
    """A column is a thing you can pick up, and a drag has to say where it lands.

    The mirror of the card drag: a card drops into a slot inside a list, so its
    line is a short bar in a band, while a list drops into a *gap* between two
    lists, so its line is a full-height vertical rule. Either way the list that
    moves is the real one — frame and cards together, since mermaid draws those in
    two separate sibling lists and only the frame is under the pointer.
    """
    _render(window, KANBAN)
    _enter_edit_mode(window)
    _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 2, timeout=15)

    drag = _pointer_drag_column(window, column=0, slot=1)
    mid = drag["mid"]
    assert mid["clone"] is False, "the drag drew a second copy of the column"
    assert mid["lifted"] is True, mid
    assert mid["cardsLifted"] is True, "the cards did not travel with their column"
    # Everything held moved by the pointer's own distance: neither twice as far
    # for the cards, nor stuck, nor a copy that lags behind.
    travel = mid["travel"]
    assert abs(travel["dx"] - travel["px"]) <= 1.0, mid
    assert abs(travel["dy"] - travel["py"]) <= 1.0, mid
    assert all(abs(m["dx"] - travel["dx"]) <= 1.0 for m in mid["cardMoved"]), mid
    assert all(abs(m["dy"] - travel["dy"]) <= 1.0 for m in mid["cardMoved"]), mid
    # Painted on top of what it is passing over: the svg paints in document order,
    # so a frame left in its place would be drawn under every column it crosses.
    assert mid["frameOnTop"] is True, mid
    assert mid["cardsOnTop"] is True, mid
    # A list that travels off the board is clipped by the svg and the scrolling
    # preview, exactly as a card is.
    assert mid["unclipped"] is True, mid

    # The line is a full-height vertical rule, in the gap the release will fill.
    line = mid["line"]
    assert line is not None and line["shown"] is True, mid
    assert line["w"] <= 8, mid
    assert line["h"] > mid["sr"]["h"] * 0.5, mid
    band = mid["sr"]
    assert line["x"] > band["x"] + band["w"], mid
    # The line is an svg child ahead of the *frames* and behind everything else,
    # so the column it is previewing is not drawn across by its own rule — a rule
    # the column is next to is one the column does not hide.
    assert mid["lineUnder"] is True, mid
    assert "line" in mid["overLine"], mid
    # And the held column is the size it was drawn at: a `scale` on the lift would
    # grow the frame about its own origin (where an svg transform scales) and push
    # the cards out through the bottom of it.
    assert mid["rigid"] is True, mid

    # `COLUMNS` is keyed by the band's x, so the dict is the board's order: a
    # column drag has to be read as the whole sequence, not as one column's cards.
    cols = _wait(
        window,
        COLUMNS,
        lambda d: [_drawn(c) for c in d["cols"].values()] == [["Three"], ["One", "Two"]],
        timeout=15,
    )["cols"]
    # Todo took its two cards along, whole, as one source patch — and it is one
    # undo away, because it is one setNodeMarkup. The column the board is drawn
    # with holds no cards, so it is not in the reading.
    assert [_drawn(c) for c in cols.values()] == [["Three"], ["One", "Two"]], cols


def _slot_sits_in_its_band(slot, band):
    """A card slot is drawn *in* its own column, at the foot of it.

    So this is one reading rather than a placement to keep: the board is drawn
    with somewhere to add a card, and mermaid draws that somewhere inside the
    band whose column it belongs to.
    """
    return (
        band["box"]["left"] - 1 <= slot["box"]["left"]
        and slot["box"]["right"] <= band["box"]["right"] + 1
        and slot["box"]["bottom"] <= band["box"]["bottom"] + 1
    )


def _slots_in_their_bands(board, slots):
    """Every card slot in the band of the column it belongs to, in board order.

    The one thing a stale drawing would break, and the only thing worth
    asserting: which column each place to add a card is standing in. Where the
    board sits on screen is its business, not the test's. The board is drawn with
    one band more than it has columns — the one the next column goes in — so the
    last band is not a column with a slot in it.
    """
    bands = board["bands"][: len(slots["cards"])]
    if len(bands) != len(slots["cards"]):
        return False
    return all(
        _slot_sits_in_its_band(slot, band) for slot, band in zip(slots["cards"], bands)
    )


def _column_slot_past_the_board(board, slots):
    """The drawn column standing past the last real one, where a new one goes."""
    column = slots["column"]
    last = board["bands"][-1]
    return (
        column is not None
        and abs(column["box"]["left"] - last["box"]["left"]) <= 1.0
        and abs(column["box"]["right"] - last["box"]["right"]) <= 1.0
    )


def test_kanban_drawn_slot_creates_a_card(window):
    """The place a card is added is drawn in the board, and it adds one there.

    Real browser only, because the whole feature is the drawing: a card slot in
    every column and a column at the end of the board, both put in the source
    only for as long as the board is being edited, and a commit that strips them.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)

    slots = _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 3, timeout=15)
    board = _wait(
        window,
        KANBAN_CHROME,
        lambda d: len(d["bands"]) == 4 and all(b["box"] for b in d["bands"]),
        timeout=15,
    )
    assert [card["text"] for card in slots["cards"]] == [KANBAN_CARD_SLOT] * 3, slots
    assert slots["column"] and slots["column"]["text"] == KANBAN_COLUMN_SLOT, slots
    assert _slots_in_their_bands(board, slots), (slots, board)
    # The drawn column *is* the last band, past the last real one, where the next
    # column goes: the place is shown rather than described.
    assert _column_slot_past_the_board(board, slots), (slots, board)
    # The empty column is the one worth checking: mermaid sizes its band to the
    # header alone, and the slot is drawn in it all the same — the place to add a
    # card does not need a card to be there already. With a slot, the band is
    # about a card tall again, which is what used to be the bar's problem.
    def band_height(band):
        return band["box"]["bottom"] - band["box"]["top"]

    assert band_height(board["bands"][1]) < band_height(board["bands"][0]), board

    # A zoom rescales the whole drawing, and there is nothing to keep in step: the
    # slot *is* the board's own card, so it is in the same column after a zoom as
    # before it.
    _zoom(window, "+")
    zoomed = _wait(
        window,
        KANBAN_SLOTS,
        lambda d: len(d["cards"]) == 3
        and d["cards"][0]["box"]["width"] > slots["cards"][0]["box"]["width"],
        timeout=15,
    )
    assert _slots_in_their_bands(_dump(window, KANBAN_CHROME), zoomed), zoomed
    _zoom(window, "100%")

    opened = _click_kanban_slot(window, 1)
    # The field is the slot's own box, so a title is typed where the card will
    # be, and the input itself is left to the one thing a user types.
    assert opened["v"] == "" and opened["ph"] == "Card title", opened
    assert abs(opened["box"]["x"] - opened["anchor"]["x"]) <= 1.0, opened
    _type_and_confirm(window, "Fresh")
    state = _wait(
        window,
        LABEL_STATE,
        lambda d: any("Fresh" in t for t in d["texts"]),
        timeout=20,
    )
    assert not state["input"] and not state["error"] and not state["notice"], state
    # The document's own source holds the card and no slots: the places to add
    # exist only for as long as the board is drawn.
    assert state["source"] and "    [Fresh]" in state["source"], state
    assert KANBAN_CARD_SLOT not in state["source"], state
    assert KANBAN_COLUMN_SLOT not in state["source"], state
    # Into the column that was pressed: the empty one, so its band grew.
    cols = _wait(
        window,
        COLUMNS,
        lambda d: any("Fresh" in cards for cards in d["cols"].values()),
        timeout=15,
    )["cols"]
    assert ["Fresh"] in [sorted(_drawn(cards)) for cards in cols.values()], cols

    # The commit re-drew the board, and with it the slots: one per column still,
    # the new card's column among them, and the drawn column at the end.
    after = _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 3, timeout=15)
    assert _slots_in_their_bands(_dump(window, KANBAN_CHROME), after), after

    # ...and the field it opens is the same one a label edit uses, so Esc is
    # the same way out of it.
    _click_kanban_slot(window, 0)
    _type(window, "Discarded")
    _dump(
        window,
        "(() => { const i = document.querySelector('.mermaid-edit-input');"
        " i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));"
        " return { closed: true }; })()",
    )
    gone = _wait(window, LABEL_STATE, lambda d: not d["input"], timeout=10)
    assert "Discarded" not in (gone["source"] or ""), gone


def _menus(board):
    """The per-column `⋯` of a `KANBAN_CHROME` snapshot, matched to their bands.

    By horizontal order, which is board order: a menu says which column it is for
    only in an aria-label, and that is no help to a test comparing boxes.
    """
    return sorted(
        (b for b in board["buttons"] if b["kind"] == "mermaid-kanban-menu"),
        key=lambda menu: menu["box"]["left"],
    )


def _menu_in_its_band(band, menu, name=None):
    """A `⋯` belongs in its own column's corner — and clear of its name.

    In the band because that is the shape it annotates and the drag and the hit
    test both read positions from; clear of the name because the name is what a
    click there renames, and a control lying across it covers that.
    """
    if not (
        band["box"]["left"] - 0.5 <= menu["box"]["left"]
        and menu["box"]["right"] <= band["box"]["right"] + 0.5
        and band["box"]["top"] - 0.5 <= menu["box"]["top"]
        and menu["box"]["bottom"] <= band["box"]["bottom"] + 0.5
    ):
        return False
    if name is None:
        return True
    return not (
        menu["box"]["left"] < name["right"]
        and name["left"] < menu["box"]["right"]
        and menu["box"]["top"] < name["bottom"]
        and name["top"] < menu["box"]["bottom"]
    )


def _placed(board):
    """Whether every control is where the board it belongs to now is.

    The one thing a stale placement breaks, and the only thing worth asserting
    after a resize: every `⋯` in its own band's corner, and no control over any
    band's name. The places to add a card are not in the list, because they are
    not controls: they are drawn in the board, so there is nothing to place. The
    drawn column at the end is drawn too, so it has no `⋯` — it is a place to
    type a name, not a column to add to, rename or delete yet.
    """
    bands = board["bands"]
    real = [b for b in bands if b["text"] != KANBAN_COLUMN_SLOT]
    menus = _menus(board)
    if len(bands) - len(real) != 1 or len(menus) != len(real):
        return False
    return all(
        _menu_in_its_band(band, menu, band["name"])
        for band, menu in zip(real, menus)
    )


def _buttons_in(shape, button):
    """Whether a control's whole box sits inside the card or band it belongs to."""
    return (
        shape["box"]["left"] - 0.5 <= button["box"]["left"]
        and button["box"]["right"] <= shape["box"]["right"] + 0.5
        and shape["box"]["top"] - 0.5 <= button["box"]["top"]
        and button["box"]["bottom"] <= shape["box"]["bottom"] + 0.5
    )


def test_kanban_chrome_is_quiet_until_the_pointer_asks(window):
    """A board's own controls are not all of the board.

    Adding used to be a ＋ on every column header *and* a ＋ in every band *and* an
    empty column standing beside the board: four positioned things per column,
    none of them drawn by mermaid, all of them answering "how do I add". Now the
    board is *drawn* with a card slot in every column and a column at the end, so
    what is left is one control per column — a quiet `⋯` in its corner — and a
    `✕` only for the card under the pointer. Real browser only: it is all
    geometry read from a mermaid rect.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)

    board = _wait(
        window,
        KANBAN_CHROME,
        lambda d: len(d["buttons"]) == 5 and len(d["cards"]) == 5 and len(d["bands"]) == 4,
        timeout=15,
    )
    # Two real cards, a slot in each of the three columns, and the drawn column.
    texts = [card["text"] for card in board["cards"]]
    assert texts.count(KANBAN_CARD_SLOT) == 3, texts
    assert sorted(t for t in texts if t != KANBAN_CARD_SLOT) == ["One", "Two"], texts
    kinds = sorted(b["kind"] for b in board["buttons"])
    # A slot is not a card, so it is nothing to delete: a ✕ per real card only.
    assert kinds == (
        ["mermaid-kanban-card-remove"] * 2 + ["mermaid-kanban-menu"] * 3
    ), kinds
    assert {b["text"] for b in board["buttons"] if b["kind"] == "mermaid-kanban-menu"} == {"⋯"}

    # Each control's whole box sits inside the card or band it names.
    for button in board["buttons"]:
        shapes = board["cards"] if button["kind"] == "mermaid-kanban-card-remove" else board["bands"]
        assert any(_buttons_in(shape, button) for shape in shapes), (button, shapes)
    # And the drawn column is the board's own, not a control laid beside it.
    slots = _dump(window, KANBAN_SLOTS)
    assert _column_slot_past_the_board(board, slots), (slots, board)

    # Nothing is on screen but the controls that belong to the whole board.
    quiet = [b for b in board["buttons"] if not b["visible"]]
    assert sorted(b["kind"] for b in quiet) == ["mermaid-kanban-card-remove"] * 2, quiet
    # A concealed control takes no clicks either, so a hidden ✕ can never eat the
    # press that was meant to drag the card it is hiding on.
    assert not any(b["clickable"] for b in quiet), quiet

    # Hovering a card reveals that card's ✕ and nothing else: there is no per-list
    # control to reveal any more, because the place to add is drawn.
    _hover(window, ".items > g.node", 0)
    assert [(b["kind"], b["label"], b["clickable"]) for b in _shown(window)] == [
        ("mermaid-kanban-card-remove", "Delete the card One", True)
    ]
    # Hovering a *slot* reveals nothing at all: it is a place, not a control.
    _hover(window, ".mermaid-kanban-slot", 0)
    assert _shown(window) == [], _shown(window)

    # Leaving the board takes it all away again.
    _unhover(window)
    assert _shown(window) == []


def test_an_empty_column_draws_its_own_place_to_add(window):
    """A board of empty columns still shows where a card goes, and takes the press.

    The shape every report was about: a board whose every column is empty, so
    mermaid sizes each band to its header alone. The place to add a card is drawn
    in that band by mermaid itself, so it is a card-shaped thing rather than a
    bar laid out over a 24px name — and the press is taken through the document's
    own hit test, because a slot nobody can reach is not a place to add.
    """
    _render(window, KANBAN_BARE)
    _enter_edit_mode(window)
    board = _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 5, timeout=15)
    slots = _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 4, timeout=15)
    assert _slots_in_their_bands(board, slots), (slots, board)
    # Every band is sized to its header alone, and the slot is drawn in it all the
    # same — so the band grew to a card's height to hold the place to add one.
    heights = {band["box"]["bottom"] - band["box"]["top"] for band in board["bands"][:4]}
    assert len(heights) == 1, board["bands"]

    opened = _click_kanban_slot(window, 1)
    assert opened["v"] == "" and opened["ph"] == "Card title", opened
    # The field is the slot's own box — its top edge and its centre line are the
    # slot's, and it is a composer so it is a little taller than the card it
    # becomes — which is what makes the slot read as turning into a card rather
    # than as opening a field elsewhere.
    assert abs(opened["box"]["x"] - opened["anchor"]["x"]) <= 1.0, opened
    assert abs(opened["box"]["top"] - opened["anchor"]["top"]) <= 1.0, opened
    assert opened["box"]["height"] >= 20, opened
    _press_key(window, "Escape")


def test_a_composer_gets_the_room_it_needs_to_be_usable(window):
    """A field taller than the band it fills is still a field you can see.

    A drawn slot is a card, so an empty column's band is sized to header *and*
    card — but a title that needs several lines takes the composer to more than
    twice that, and a field is absolutely positioned, so the part of it below the
    board contributes nothing to the block's height and is not something the
    editor can scroll to. The block grows to hold it.
    """
    _render(window, KANBAN_BARE)
    _enter_edit_mode(window)
    board = _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 5, timeout=15)
    band = board["bands"][0]["box"]

    # The short field is the slot's own box, inside the band that was drawn for it.
    _click_kanban_slot(window, 0)
    short = _composer(window)
    assert band["top"] - 0.5 <= short["box"]["top"] <= band["bottom"] + 0.5, (short, band)
    assert short["box"]["bottom"] <= band["bottom"] + 0.5, (short, band)

    # Long enough that the field has to run past the bottom of the block whatever
    # slack the document happens to leave, so what is asserted is the block
    # growing rather than the field happening to fit.
    _type(window, "a card title long enough that the composer grows well past the height of the column it was opened in")
    grown = _wait(
        window,
        COMPOSER_FIT,
        lambda d: d["box"] is not None
        and d["box"]["height"] > short["box"]["height"] + 20
        and d["box"]["bottom"] > short["box"]["bottom"] + 20
        and d["box"]["bottom"] <= d["block"]["bottom"] + 0.5,
        timeout=10,
    )
    assert grown["box"]["bottom"] > band["bottom"], (grown, band)
    assert float(grown["pad"].replace("px", "")) > 0, grown
    # ...and the room is given back, so the diagram is not left padded out.
    _press_key(window, "Escape")
    let_go = _wait(window, COMPOSER_FIT, lambda d: d["box"] is None, timeout=10)
    assert float((let_go["pad"] or "0px").replace("px", "")) == 0, let_go

    # A title that is committed leaves nothing behind either: the card takes the
    # room the composer had, in the band it was written in.
    _click_kanban_slot(window, 0)
    _type_and_confirm(window, "Ask")
    filled = _wait(
        window, DOC_SOURCE, lambda d: d["n"] == 1 and "[Ask]" in d["sources"][0], timeout=15
    )
    # Under the first column, which is where the slot it was written in was drawn.
    assert filled["sources"][0].splitlines()[2].strip() == "[Ask]", filled
    settled = _wait(window, COMPOSER_FIT, lambda d: d["box"] is None, timeout=10)
    assert float((settled["pad"] or "0px").replace("px", "")) == 0, settled


def test_the_chrome_follows_the_board_when_the_window_is_resized(window):
    """A control is placed from a rect read off the board, so it must be re-placed.

    A window resize narrows the preview while the svg keeps the size mermaid drew
    it at, and the board is *centred* in the preview, so everything the controls
    are positioned from moves without the size of anything observed changing.
    Left behind, a `⋯` and a `✕` belong to a column that has moved away from
    them — and the slots, which are part of the drawing, are re-laid-out by
    mermaid itself.
    """
    _render(window, KANBAN_BARE)
    _enter_edit_mode(window)
    _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 5, timeout=15)
    try:
        for width in (860, 640):
            _resize_view(window, width)
            board = _wait(
                window,
                KANBAN_CHROME,
                lambda d: len(d["bands"]) == 5 and _placed(d),
                timeout=10,
            )
            assert _placed(board), board
    finally:
        _resize_view(window, 1280)


def test_kanban_menu_and_drawn_add_and_delete_columns(window):
    """A column's menu is the two things that are not places on the board.

    Rename and delete, both of them named by what they do rather than by the
    column they are on: the item belongs to the `⋯` it hangs off, and that `⋯`
    already carries the name. Which column is the *prompt's* to say, and it does.
    Adding is not in the list at all, because the place a new column goes is
    *drawn* in the board — so the menu is not the only way to add one, and a
    board drawn without a slot column has nothing in it to add.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)
    _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 4, timeout=15)

    menu = _open_kanban_menu(window, 0)
    assert menu["label"] == "Todo column actions", menu
    # The whole of the column's own actions, in one list, with the one that takes
    # something away marked as such.
    assert [i["text"] for i in menu["items"]] == ["Rename column", "Delete column"], menu
    assert [i["danger"] for i in menu["items"]] == [False, True], menu
    assert menu["items"][0]["focused"] is True, menu
    # It hangs below its own ⋯ and inside the column, so it is not the next
    # column's menu opened one to the left.
    band = _dump(window, KANBAN_CHROME)["bands"][0]
    assert menu["box"]["top"] >= band["box"]["top"], (menu, band)
    assert menu["box"]["right"] <= band["box"]["right"] + 1.0, (menu, band)
    assert menu["box"]["left"] >= band["box"]["left"] - 1.0, (menu, band)
    # An item is bounded by the popover and not by its own words, so a label
    # wider than the menu wraps inside it instead of widening the menu off the
    # board. The wrapping is what a translation gets; nothing this app writes
    # today is long enough to need it.
    for item in menu["items"]:
        assert item["wrap"] == "normal", item
        assert item["box"]["right"] <= menu["box"]["right"] + 0.5, (item, menu)
        assert item["box"]["left"] >= menu["box"]["left"] - 0.5, (item, menu)

    # The gap under the ⋯ is a hole in the popover with the board showing through
    # it, and the pointer is always travelling across it on its way down. A press
    # there is a press on the menu, so the menu is still there afterwards.
    gap = _press_in_the_menu_gap(window)
    assert gap["gap"] > 0, gap
    assert gap["hits"] == "the menu", gap
    assert gap["stillOpen"] is True, gap

    # Moving the pointer off it takes the menu away again: it is a popover over a
    # board, not a dialog, so it must not keep the rest of the board out of reach.
    _hover(window, ".items > g.node", 0)
    _wait(window, KANBAN_MENU, lambda d: not d["open"], timeout=10)

    # A new column is the board's own drawn place, and it is named through the
    # label editor its own header is edited by, so the name is keyed into the band
    # rather than asked for somewhere else.
    _click_kanban_column_slot(window)
    _type_and_confirm(window, "In review")
    added = _wait(
        window,
        DOC_SOURCE,
        lambda d: d["n"] == 1 and "In review" in d["sources"][0],
        timeout=20,
    )
    assert "col1[In review]" in added["sources"][0], added
    _wait(
        window,
        SECTIONS,
        lambda d: d["n"] == 5 and any("In review" in s for s in d["sections"]),
        timeout=15,
    )

    # And "Delete" says how many cards go with it, then goes.
    _open_kanban_menu(window, 0)
    _click_kanban_menu_item(window, "Delete column")
    prompt = _wait(window, DELETE_PROMPT, lambda d: d["present"], timeout=10)
    assert prompt["title"] == "Delete the Todo column?" and prompt["danger"], prompt
    # Todo is empty by now, so the prompt must not claim it is taking cards.
    assert "cards go with it" not in prompt["note"], prompt
    _answer_delete_prompt(window, "Delete")
    dropped = _wait(
        window,
        DOC_SOURCE,
        lambda d: d["n"] == 1 and "\n  Todo\n" not in "\n" + d["sources"][0] + "\n",
        timeout=15,
    )
    assert "id2[Two]" in dropped["sources"][0], dropped
    # The column drawn at the end is still at the end: the board's own order is
    # what a delete leaves behind, and the new one was appended, not inserted.
    assert dropped["sources"][0].splitlines()[-1].strip() == "col1[In review]", dropped
    # The board re-rendered into three columns plus the place a fourth goes, so
    # the chrome is back to four bands and the band that was Todo is gone.
    board = _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 4, timeout=15)
    assert [b["text"] for b in board["bands"]] == [
        "Doing",
        "Done",
        "In review",
        KANBAN_COLUMN_SLOT,
    ], board

    # The drawn column is where the *next* one goes, and it is named through the
    # label editor its own header is edited by, so the name is keyed into the band
    # rather than asked for somewhere else.
    opened = _click_kanban_column_slot(window)
    assert opened["v"] == KANBAN_COLUMN_SLOT, opened
    _type_and_confirm(window, "Archive")
    _wait(
        window,
        DOC_SOURCE,
        lambda d: d["n"] == 1 and "Archive" in d["sources"][0],
        timeout=20,
    )
    _wait(
        window,
        SECTIONS,
        lambda d: d["n"] == 5 and "Archive" in d["sections"],
        timeout=15,
    )
    # And the board is drawn with a *new* place to add a column: the one that was
    # named is a real column now, so there is a fresh slot at the end again.
    after = _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 5, timeout=15)
    slots = _dump(window, KANBAN_SLOTS)
    assert _column_slot_past_the_board(after, slots), (slots, after)


def test_kanban_menu_offers_no_delete_on_a_board_of_one(window):
    """A board keeps at least one column, so a board of one is not offered the
    delete that would leave nothing behind. What cannot be done is not on the
    board — the menu included, which is now the only place a column is deleted
    from."""
    _set_scheme(window, False)
    _render(window, KANBAN_ONE)
    _enter_edit_mode(window)
    board = _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 2, timeout=15)

    menu = _open_kanban_menu(window, 0)
    assert [i["text"] for i in menu["items"]] == ["Rename column"], menu
    assert not any(i["danger"] for i in menu["items"]), menu
    # A board of one is drawn with the column it would need to get back to two —
    # and that drawn column is not a column, so it is neither offered the delete
    # nor counted as the second one that would make the delete possible.
    slots = _dump(window, KANBAN_SLOTS)
    assert _column_slot_past_the_board(board, slots), (slots, board)


def test_kanban_card_delete_asks_first(window):
    """A card's ✕ is only there for the card under the pointer, and it asks.

    Revealed by a real hover, because that is the promise: the control is not on
    the card until the pointer is on it. The ✕ is still the one thing on a card
    that goes red, because it is the one that takes something away.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)
    # Two real cards and a slot in every column, so a card is found by what it
    # says rather than by where it happens to be in the list of drawn cards.
    _wait(
        window,
        KANBAN_CHROME,
        lambda d: len([c for c in d["cards"] if c["text"] == KANBAN_CARD_SLOT]) == 3,
        timeout=15,
    )

    # A ✕ that is not there cannot be pressed: a Cancel takes nothing away.
    _hover(window, ".items > g.node", 0)
    _wait(
        window,
        KANBAN_CHROME,
        lambda d: any(
            b["kind"] == "mermaid-kanban-card-remove" and b["shown"] and b["label"] == "Delete the card One"
            for b in d["buttons"]
        ),
        timeout=10,
    )
    _click_kanban_button(window, "mermaid-kanban-card-remove", 0)
    prompt = _wait(window, DELETE_PROMPT, lambda d: d["present"], timeout=10)
    assert prompt["title"] == "Delete “One”?" and prompt["danger"], prompt
    assert prompt["buttons"] == ["Cancel", "Delete"], prompt
    assert "removed from the Todo column" in prompt["note"], prompt
    _answer_delete_prompt(window, "Cancel")
    _wait(window, DELETE_PROMPT, lambda d: not d["present"], timeout=10)
    kept = _wait(window, DOC_SOURCE, lambda d: d["n"] == 1, timeout=10)
    assert "id1[One]" in kept["sources"][0], kept

    # And answering it removes the card, as one source patch, leaving one ✕.
    _hover(window, ".items > g.node", 0)
    _click_kanban_button(window, "mermaid-kanban-card-remove", 0)
    _wait(window, DELETE_PROMPT, lambda d: d["present"], timeout=10)
    _answer_delete_prompt(window, "Delete")
    gone = _wait(
        window,
        DOC_SOURCE,
        lambda d: d["n"] == 1 and "id1[One]" not in d["sources"][0],
        timeout=15,
    )
    assert "id2[Two]" in gone["sources"][0], gone
    # One real card is left, and the board is still drawn with a slot in every
    # column, so what the delete removed was a card and not a place to add one.
    board = _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 4, timeout=15)
    assert [c["text"] for c in board["cards"] if c["text"] != KANBAN_CARD_SLOT] == ["Two"], board
    assert [b["label"] for b in board["buttons"] if b["kind"] == "mermaid-kanban-card-remove"] == [
        "Delete the card Two"
    ], board


def test_kanban_drawn_slot_composes_a_wrapping_title(window):
    """A drawn slot becomes a field where it stood, and the field is a composer.

    A card title is written rather than replaced and is often longer than the
    card that will hold it, so the field wraps: the whole of what is being typed
    stays visible instead of scrolling out of sight to the right. Enter still
    commits it, and Shift+Enter is not a way to write a line break into a title
    mermaid cannot read one into.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)
    _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 4, timeout=15)

    # The second slot is the second column's, and the field reads in the same
    # snapshot as the slot it came from: two boxes read at two moments are two
    # moments of the layout, not two boxes.
    _click_kanban_slot(window, 1)
    opened = _composer(
        window,
        "document.querySelectorAll('.mermaid .items > g.node.mermaid-kanban-slot')[1]",
        expression=True,
    )
    assert opened["wrap"] is True, "the card composer is not a wrapping field"
    # Where the slot was: a user who pressed it is looking at that spot, and a
    # field that appeared somewhere else is a different gesture.
    assert opened["anchor"] is not None, opened
    assert abs(opened["box"]["left"] - opened["anchor"]["left"]) <= 1.0, opened
    assert abs(opened["box"]["top"] - opened["anchor"]["top"]) <= 1.0, opened

    # A line break cannot be written into a card title, so Shift+Enter is refused
    # rather than left to make a title mermaid will not read back: the field stays
    # open, with the value the user has, and no card half-created.
    # A title longer than the pill, so the field has to grow to hold it: the whole
    # of what is being written is visible rather than scrolled out of sight.
    title = "A title long enough to wrap onto a second line of the composer"
    _type(window, title)
    grown = _composer(window)
    assert grown["input"]["height"] > opened["input"]["height"] + 8, (opened, grown)

    refused = _press_key(window, "Enter", shift=True)
    assert refused["value"] == title, refused
    # Refused means the field is still there, with the title still in it, and
    # nothing was written to the board: the shift key is not a commit key.
    still = _dump(window, "(() => { const i = document.querySelector('.mermaid-edit-input');"
                   " return { open: !!i, value: i ? i.value : null,"
                   "   broken: i ? i.value.indexOf('\\n') >= 0 : null }; })()")
    assert still == {"open": True, "value": title, "broken": False}, still
    assert _dump(window, DOC_SOURCE)["sources"][0] == KANBAN_EMPTY, "Shift+Enter wrote to the board"
    # Enter is the commit key, and the card is the title that was written.
    _press_key(window, "Enter")
    _wait(
        window,
        DOC_SOURCE,
        lambda d: d["n"] == 1 and "A title long enough to wrap" in d["sources"][0],
        timeout=20,
    )


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
    # The drawn places to add are edit mode's, so they go with it: the source is
    # the document, and it has no slots in it.
    left = _dump(window, KANBAN_SLOTS)
    assert left["cards"] == [] and left["column"] is None, "a drawn slot outlived the edit session"

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

    # A drawn slot takes the same kind of title and lands it the same way.
    _click_kanban_slot(window, 0)
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
    _click_kanban_slot(window, 1)
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
    # Real mermaid accepted the built source (col1[…] columns and all), and the
    # board came up already open for editing — drawn with a place to add a card
    # in every column and a column to add at the end.
    slots = _wait(
        window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 3 and d["column"] is not None, timeout=20
    )
    assert [c["text"] for c in slots["cards"]] == [KANBAN_CARD_SLOT] * 3, slots
    assert slots["column"]["text"] == KANBAN_COLUMN_SLOT, slots
    assert _dump(window, EDIT_STATE)["editing"], "the new board is not in edit mode"
    sections = _wait(window, SECTIONS, lambda d: d["n"] == 4, timeout=15)
    joined = " ".join(sections["sections"])
    assert all(name in joined for name in ("Todo", "Doing", "Done")), sections
    # The board round-trips: what the document holds is what mermaid rendered.
    assert _dump(window, DOC_SOURCE)["sources"] == [
        "kanban\n  col1[Todo]\n  col2[Doing]\n  col3[Done]"
    ]

    # And it behaves like any other board from here: a drawn slot creates a card,
    # in the column it was drawn in.
    _click_kanban_slot(window, 1)
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
