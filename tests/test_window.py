"""Tests for the native Qt shell: centered confirm dialog and close behavior.

One session-scoped window is used for the whole suite so QtWebEngine only
boots once.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from PySide6.QtCore import QEvent, QItemSelectionModel, QPointF, QUrl, Qt
from PySide6.QtGui import QMouseEvent
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
from backend.window import DIST_DIR, MainWindow, __version__

import pytest


def _pump_until(condition, timeout=8.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if condition():
            return True
        time.sleep(0.02)
    return False


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
    assert "&Save\tCtrl+S" in file_labels
    assert "Save &As…\tCtrl+Shift+S" in file_labels
    assert "&Revert" in file_labels
    assert "&Export HTML…\tCtrl+Shift+E" in file_labels
    assert "&Quit\tCtrl+Q" in file_labels

    insert_labels = [action.text() for action in window._insert_menu.actions()]
    assert insert_labels == ["&Spreadsheet…", "&Text File…", "&Image…"]

    help_labels = [action.text() for action in window._help_menu.actions()]
    assert help_labels == ["&About Edi…"]

    preview_actions = [
        action
        for action in window._view_menu.actions()
        if action.text().startswith("&Visual Mode")
    ]
    assert preview_actions
    assert preview_actions[0].isCheckable()
    assert preview_actions[0].isChecked() is True

    formatting_actions = [
        action
        for action in window._view_menu.actions()
        if action.text().startswith("&Formatting")
    ]
    assert formatting_actions
    assert formatting_actions[0].isCheckable()
    assert formatting_actions[0].isChecked() is True


def test_update_menu_state_toggles_actions(visible, qtbot):
    window = visible
    assert window._revert_action.isEnabled() is False
    assert window._editor_action.isChecked() is True
    assert window._formatting_action.isChecked() is True
    assert window._insert_actions is not None
    assert all(action.isEnabled() for action in window._insert_actions)

    window.update_menu_state(
        can_revert=True, visual_mode=False, formatting_visible=False
    )
    assert window._revert_action.isEnabled() is True
    assert window._editor_action.isChecked() is False
    assert window._formatting_action.isChecked() is False
    assert all(action.isEnabled() for action in window._insert_actions)

    window.update_menu_state(
        can_revert=False, visual_mode=True, formatting_visible=True
    )
    assert window._revert_action.isEnabled() is False
    assert window._editor_action.isChecked() is True
    assert window._formatting_action.isChecked() is True
    assert all(action.isEnabled() for action in window._insert_actions)


def test_menu_action_invokes_js_command(visible, qtbot):
    window = visible
    result = {}

    window._web.page().runJavaScript(
        "window.__menuCmd = null;"
        "window.ediMenuCommand = function (cmd) { window.__menuCmd = cmd; };"
        "true",
        lambda _v: None,
    )

    file_menu = window._file_menu
    open_action = next(action for action in file_menu.actions() if "Open" in action.text())
    open_action.trigger()

    def fetched():
        window._web.page().runJavaScript(
            "window.__menuCmd", lambda v: result.__setitem__("value", v)
        )
        return result.get("value") is not None

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == "open"


def test_view_menu_action_invokes_js_command(visible, qtbot):
    window = visible
    result = {}

    window._web.page().runJavaScript(
        "window.__menuCmd = null;"
        "window.ediMenuCommand = function (cmd) { window.__menuCmd = cmd; };"
        "true",
        lambda _v: None,
    )

    view_menu = window._view_menu
    editor_action = next(
        action for action in view_menu.actions() if action.text().startswith("&Visual Mode")
    )
    editor_action.trigger()

    def fetched():
        window._web.page().runJavaScript(
            "window.__menuCmd", lambda v: result.__setitem__("value", v)
        )
        return result.get("value") is not None

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == "toggleMode"


def test_view_menu_formatting_action_invokes_js_command(visible, qtbot):
    window = visible
    result = {}

    window._web.page().runJavaScript(
        "window.__menuCmd = null;"
        "window.ediMenuCommand = function (cmd) { window.__menuCmd = cmd; };"
        "true",
        lambda _v: None,
    )

    view_menu = window._view_menu
    formatting_action = next(
        action for action in view_menu.actions() if action.text().startswith("&Formatting")
    )
    formatting_action.trigger()

    def fetched():
        window._web.page().runJavaScript(
            "window.__menuCmd", lambda v: result.__setitem__("value", v)
        )
        return result.get("value") is not None

    qtbot.waitUntil(fetched, timeout=3000)
    assert result["value"] == "toggleFormatting"


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
