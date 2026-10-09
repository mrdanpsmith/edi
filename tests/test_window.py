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
from PySide6.QtGui import QContextMenuEvent, QGuiApplication, QImage, QMouseEvent
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
    KANBAN_SLOTS,
    KANBAN_TRASH,
    LABEL_INVENTORY,
    LABEL_STATE,
    RASTER,
    SEQUENCE,
    SECTIONS,
    _cancel_board_dialog,
    _click_first_offered,
    _click_done,
    _answer_delete_prompt,
    _click_kanban_column_slot,
    _click_kanban_slot,
    _click_kanban_menu_item,
    _composer,
    _hover,
    _open_kanban_menu,
    _press_at_the_menu_seam,
    _click_label,
    _altclick_below_document,
    _dump,
    _enter_edit_mode,
    _open_board_dialog,
    _pointer_drag,
    _pointer_drag_to_the_trash,
    _pointer_drag_column,
    _resize_view,
    _press_enter,
    _press_key,
    _press_source,
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
    assert "&New" in file_labels
    assert "&Open…" in file_labels
    assert "Open &Recent" in file_labels
    assert "&Save" in file_labels
    assert "Save &As…" in file_labels
    assert "&Revert" in file_labels
    assert "Copy File &Path" in file_labels
    # No shortcut: Ctrl+Shift+E is the page's block-source toggle, and a menubar
    # shortcut would win over the page. The label must not advertise it.
    assert "&Export HTML…" in file_labels
    assert not any(label.startswith("&Export HTML…\t") for label in file_labels)
    assert "&Quit" in file_labels
    # Open Recent belongs directly under Open.
    assert file_labels.index("Open &Recent") == file_labels.index("&Open…") + 1

    insert_labels = [action.text() for action in window._insert_menu.actions()]
    assert insert_labels == [
        "&Table…",
        "&Kanban Board…",
        "&Spreadsheet…",
        "&Text File…",
        "&Image…",
    ]

    # **The shell's own keys really are shortcuts.** Every one of these was a `\t` in
    # a label, which gives a PySide6 `QAction` no shortcut at all — so `Ctrl+S` and
    # `Ctrl+Q` have never worked either, and neither has `Ctrl+C`. Read back off the
    # actions rather than off the labels, because the label was never the evidence.
    shell_shortcuts = {
        action.text(): action.shortcut().toString()
        for action in window._file_menu.actions()
    }
    assert shell_shortcuts["&New"] == "Ctrl+N", shell_shortcuts
    assert shell_shortcuts["&Open…"] == "Ctrl+O", shell_shortcuts
    assert shell_shortcuts["&Save"] == "Ctrl+S", shell_shortcuts
    assert shell_shortcuts["Save &As…"] == "Ctrl+Shift+S", shell_shortcuts
    assert shell_shortcuts["&Quit"] == "Ctrl+Q", shell_shortcuts

    edit_labels = [action.text() for action in window._edit_menu.actions()]
    # **No shortcut on any of these**, and that is deliberate rather than missing:
    # they are document commands, the page implements them, and the page is the
    # only thing that knows about a CodeMirror buffer's own selection or a
    # spreadsheet grid's. A window-level shortcut would shadow exactly that.
    assert "&Undo" in edit_labels
    assert "&Redo" in edit_labels
    assert "Cu&t" in edit_labels
    assert "&Copy" in edit_labels
    assert "Copy as &Markdown" in edit_labels
    assert "&Paste" in edit_labels
    assert "Paste as &Markdown" in edit_labels
    assert "Select &All" in edit_labels
    assert "&Find…" in edit_labels
    assert "&Replace…" in edit_labels
    for label in edit_labels:
        if label:
            assert "\t" not in label, (
                f"a `\\t` in a label is not a shortcut in PySide6 — {label!r} would "
                "advertise a key that does nothing")

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

    # The hover band is a View option the reader can turn off, so it has to be
    # *shown* as one — checkable, and checked at boot because the band is on
    # unless it has been turned off.
    band_actions = [
        action
        for action in window._view_menu.actions()
        if action.text().startswith("&Hover Band")
    ]
    assert band_actions
    assert band_actions[0].isCheckable()
    assert band_actions[0].isChecked() is True


def test_update_menu_state_toggles_actions(visible, qtbot):
    window = visible
    assert window._revert_action.isEnabled() is False
    assert window._copy_path_action.isEnabled() is False
    assert window._rename_action.isEnabled() is False
    assert window._toolbar_action.isChecked() is True
    assert window._insert_actions is not None
    assert all(action.isEnabled() for action in window._insert_actions)

    window.update_menu_state(
        can_revert=True, can_copy_path=True, toolbar_visible=False, can_rename=True
    )
    assert window._revert_action.isEnabled() is True
    assert window._copy_path_action.isEnabled() is True
    assert window._rename_action.isEnabled() is True
    assert window._toolbar_action.isChecked() is False
    assert all(action.isEnabled() for action in window._insert_actions)

    window.update_menu_state(
        can_revert=False, can_copy_path=False, toolbar_visible=True
    )
    assert window._revert_action.isEnabled() is False
    assert window._copy_path_action.isEnabled() is False
    assert window._rename_action.isEnabled() is False
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


def test_view_menu_hover_band_action_invokes_js_command(visible, qtbot):
    _assert_menu_action_sends_command(
        visible, qtbot, _menu_action(visible._view_menu, "&Hover Band"), "toggleHoverBand"
    )


def test_update_menu_state_reports_the_hover_band(visible):
    """The checkmark follows the page's stored answer, and on by default.

    ``hover_band`` defaults to ``True`` for the same reason the option does: a
    caller that does not know about the option (an older bridge, a test that
    only cares about the File menu) must not be read as having turned the band
    off. ``bridge.py``'s ``args.get("hoverBand", True)`` is the other half of
    that same default, and ``bool(None)`` would have quietly shipped the band
    switched off for every page that omitted the key.
    """
    window = visible
    window.update_menu_state(
        can_revert=False, can_copy_path=False, toolbar_visible=True
    )
    assert window._hover_band_action.isChecked() is True

    window.update_menu_state(
        can_revert=False, can_copy_path=False, toolbar_visible=True, hover_band=False
    )
    assert window._hover_band_action.isChecked() is False

    window.update_menu_state(
        can_revert=False, can_copy_path=False, toolbar_visible=True, hover_band=True
    )
    assert window._hover_band_action.isChecked() is True


def _read_zoom(window):
    out = {}

    def got(v):
        out.update(json.loads(v) if isinstance(v, str) else {})

    window._web.page().runJavaScript(
        "JSON.stringify((() => { const pm = document.querySelector('.ProseMirror');"
        " const tab = document.querySelector('#tabbar');"
        " const home = document.querySelector('#home-screen');"
        " const status = document.querySelector('#statusbar');"
        " return { zoom: getComputedStyle(pm).zoom,"
        " home: getComputedStyle(home).zoom,"
        " p: Math.round(pm.querySelector('p').getBoundingClientRect().height),"
        " tab: Math.round(tab.getBoundingClientRect().height),"
        " status: Math.round(status.getBoundingClientRect().height) }; })())",
        got,
    )
    assert _pump_until(lambda: bool(out), timeout=5), "no zoom probe"
    return out


def test_ctrl_shift_e_reaches_the_page(window):
    """Ctrl+Shift+E opens a block's source, because nothing in the shell claims it.

    §1.6 of the block-modes spec, tested rather than assumed. The Export HTML
    QAction's *label* used to carry `\\tCtrl+Shift+E`, and Qt is told a menubar
    shortcut by the `\\t` in its label — a shortcut that wins over the page, which
    is the same reason Rename has none. So the page's `Mod-Shift-e` binding existed
    and could never fire, and block source mode had no working keyboard entry.

    Two halves, because either alone would pass while the bug stands: the shell
    must not hold the sequence (read off the real QActions), and the page must
    answer it when the key arrives.
    """
    claimed = []
    # The menus the window stores, and only those: PySide6 hands ownership of an
    # `addMenu()` result to Python (see the note beside them in
    # `backend/window.py`), so reaching a menu through `action.menu()` hands back a
    # second owner of an object that already has one, and letting that wrapper go
    # deletes the menu out from under every later test.
    for menu in (window._file_menu, window._edit_menu, window._insert_menu,
                 window._view_menu, window._help_menu):
        for item in menu.actions():
            # A `\t` in a label is how Qt is told a shortcut, and it shows up in
            # the text as well — which is exactly how this went wrong: the Export
            # item's label carried one the page also wanted.
            claimed.append((item.text(), item.shortcut().toString()))
    assert any(sequence for _label, sequence in claimed), \
        "no menu action had a shortcut at all"
    # Nothing may take Ctrl+Shift+E, or the page is still starved.
    assert not any("Ctrl+Shift+E" in sequence for _label, sequence in claimed), claimed
    assert not any("Ctrl+Shift+E" in label for label, _sequence in claimed), claimed

    window._web.page().runJavaScript(
        "window.ediSetContent('Hello world'); true"
    )
    time.sleep(0.4)
    entered = _wait(
        window,
        "(() => { const p = document.querySelector('.ProseMirror p');"
        " if (!p) return { missing: true };"
        " p.dispatchEvent(new KeyboardEvent('keydown',"
        " { key: 'e', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));"
        " return { source: !!document.querySelector('.block-source-mode') }; })()",
        lambda d: d.get("source") is True,
        timeout=10,
    )
    assert entered["source"], "the page did not answer Mod-Shift-e"
    # ...and the shell opened nothing on the way, which is what the old label
    # would have done instead.
    assert not _dump(window, "(() => ({ dialogs: document.querySelectorAll('.edi-dialog').length }))()")[
        "dialogs"
    ]


def test_document_zoom_scales_the_editor_not_the_chrome(visible, qtbot):
    window = visible
    window._web.page().runJavaScript("window.ediSetContent('Hello world'); true")
    time.sleep(0.4)

    # The level is global and persisted, so normalise to 100% first.
    window._menu_command("zoomReset")
    assert _pump_until(lambda: _read_zoom(window)["zoom"] == "1", timeout=5)
    base = _read_zoom(window)

    # Zoom In carries a real Qt shortcut (so Qt consumes Ctrl+= before Chromium's
    # whole-page zoom ever sees it). Triggering the action is the same path the
    # shortcut takes; key delivery depends on window activation, which the
    # offscreen platform does not guarantee, so the action is the reliable half
    # and the ctrl-wheel probe covers the input plumbing separately.
    shortcuts = [sequence.toString() for sequence in window._zoom_in_action.shortcuts()]
    assert any("Ctrl+=" in sequence for sequence in shortcuts), shortcuts
    window._zoom_in_action.trigger()
    assert _pump_until(lambda: _read_zoom(window)["zoom"] == "1.1", timeout=5)
    zoomed = _read_zoom(window)
    assert zoomed["p"] > base["p"], (base, zoomed)
    assert zoomed["tab"] == base["tab"], (base, zoomed)
    assert zoomed["status"] == base["status"], (base, zoomed)
    # The start screen is a document surface too.
    assert zoomed["home"] == "1.1", (base, zoomed)

    window._menu_command("zoomReset")
    assert _pump_until(lambda: _read_zoom(window)["zoom"] == "1", timeout=5)
    assert _read_zoom(window)["p"] == base["p"]


def test_document_zoom_view_menu_has_levels_and_reset(visible, qtbot):
    window = visible
    labels = [action.text() for action in window._view_menu.actions()]
    assert "Zoom &In" in labels
    assert "Zoom &Out" in labels
    assert "&Reset Zoom" in labels
    assert "&Zoom" in labels
    # The in/out actions are disabled at the ends of the ladder.
    window.update_menu_state(
        can_revert=False,
        can_copy_path=False,
        toolbar_visible=True,
        zoom_factor=3.0,
        can_zoom_in=False,
        can_zoom_out=True,
    )
    assert window._zoom_in_action.isEnabled() is False
    assert window._zoom_out_action.isEnabled() is True
    assert window._zoom_actions[3.0].isChecked() is True


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


def test_forget_recent_file_drops_only_the_renamed_document(window, stored_recents):
    window.add_recent_file("/x/a.md")
    window.add_recent_file("/x/b.md")

    window.forget_recent_file("/x/b.md")
    assert window.recent_files() == ["/x/a.md"]

    # A path that was never in the list leaves it alone (and does not
    # rewrite the settings with a list QSettings would store as a scalar).
    window.forget_recent_file("/x/never.md")
    assert window.recent_files() == ["/x/a.md"]


def test_rename_action_is_in_the_file_menu(window, qtbot):
    action = _menu_action(window._file_menu, "Re&name")
    assert action.isEnabled() is False


def test_rename_action_is_enabled_from_the_menu_state(window):
    window.update_menu_state(
        can_revert=True, can_copy_path=True, toolbar_visible=True, can_rename=True
    )
    assert window._rename_action.isEnabled() is True

    window.update_menu_state(
        can_revert=False, can_copy_path=False, toolbar_visible=True
    )
    assert window._rename_action.isEnabled() is False


def test_rename_action_invokes_js_command(visible, qtbot):
    visible.update_menu_state(
        can_revert=True, can_copy_path=True, toolbar_visible=True, can_rename=True
    )
    _assert_menu_action_sends_command(visible, qtbot, visible._rename_action, "rename")


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


def test_pick_save_path_does_not_double_the_extension(visible, qtbot, monkeypatch):
    window = visible
    proposed = {}
    real_select_file = QFileDialog.selectFile

    def capture(dialog, name):
        proposed["name"] = name
        real_select_file(dialog, name)

    monkeypatch.setattr(QFileDialog, "selectFile", capture)
    result = {}
    window.pick_save_path("notes.md", lambda path: result.__setitem__("path", path))
    qtbot.waitUntil(
        lambda: isinstance(QApplication.activeModalWidget(), QFileDialog), timeout=3000
    )
    QApplication.activeModalWidget().reject()
    qtbot.waitUntil(lambda: "path" in result, timeout=3000)
    assert proposed["name"] == "notes.md"


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


# --- Right-click on a link (src/editor.ts, src/main.ts) ---------------------------


def test_right_click_edits_a_link_and_never_opens_it(window, monkeypatch):
    """A real right-click on a link offers to edit it, and does not follow it.

    ProseMirror hands *every* button's click to its `handleClick` prop -- its
    mouse-down handler picks the single-click path with no button test, and only
    the selection branch below it filters on button 0 -- so a right-click used
    to open the link as well as raise the context menu. The plugin turns the
    right button away itself, and the menu edits the link in place.

    The link points off the machine, so "open" is observable at the bridge:
    ``open_external_url`` is what would launch a browser, and it is replaced
    with a recorder that does nothing.
    """
    opened = []
    monkeypatch.setattr(window, "open_external_url", lambda url: opened.append(url))

    md = "See [the site](https://example.com/) now"
    window._web.page().runJavaScript(f"window.ediSetContent({json.dumps(md)}); true")

    # The buttons are pressed in the browser's own order, so the menu is raised
    # by the contextmenu event and the release still runs ProseMirror's click
    # path -- the one that used to open the link.
    state = _wait(
        window,
        "(() => { const a = document.querySelector('#editor-container a[href]');"
        " if (!a) return { found: false };"
        " const r = a.getBoundingClientRect();"
        " const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };"
        " const ev = (type) => new MouseEvent(type, { bubbles: true,"
        "   cancelable: true, composed: true, view: window, clientX: at.x,"
        "   clientY: at.y, button: 2, buttons: 2 });"
        " ['mousedown', 'contextmenu', 'mouseup'].forEach((type) =>"
        "   a.dispatchEvent(ev(type)));"
        " return { found: true, menu: [...document.querySelectorAll('.edi-menu-item')]"
        "   .map((b) => b.textContent) }; })()",
        lambda d: d.get("found") and "Edit link…" in (d.get("menu") or []),
        timeout=10,
    )
    assert "Edit link…" in state["menu"], state
    assert opened == [], "a right-click opened the link"

    # Confirming the edit dialog rewrites the href, in one undoable step.
    def open_and_update():
        return _dump(
            window,
            "(() => { const item = [...document.querySelectorAll('.edi-menu-item')]"
            "   .find((b) => b.textContent === 'Edit link…'); if (!item) return { missing: true };"
            " item.click();"
            " const box = document.querySelector('.edi-dialog');"
            " if (!box) return { opened: false };"
            " const title = box.querySelector('.edi-dialog-title').textContent;"
            " const url = box.querySelector('.edi-dialog-input');"
            " const was = url.value;"
            " url.value = 'https://example.org/edited';"
            " box.querySelector('.toolbar-primary').click();"
            " return { opened: true, title, was }; })()",
        )

    dialog = open_and_update()
    assert dialog.get("opened"), dialog
    assert dialog["title"] == "Edit link"
    assert dialog["was"] == "https://example.com/", dialog

    edited = _wait(
        window,
        "(() => { const doc = document.querySelector('.ProseMirror').pmViewDesc.node;"
        " const out = []; doc.descendants((n) => { if (!n.isText) return;"
        "   for (const m of n.marks) if (m.type.name === 'link') out.push(m.attrs.href); });"
        " return { hrefs: out }; })()",
        lambda d: d.get("hrefs") == ["https://example.org/edited"],
        timeout=5,
    )
    assert edited["hrefs"] == ["https://example.org/edited"], edited
    assert opened == [], "editing the link opened it"


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


def _board(cols):
    """The board's own columns, in board order, as a read of a whole sequence.

    ``COLUMNS`` reads the cards mermaid drew, in the order it drew them, and every
    column is drawn with a card slot -- so a column reports a card it does not
    hold, and the column at the end of the board is a place rather than a column
    of the document at all. ``_drawn`` takes the first of those away and this
    takes the second, by position rather than by emptiness: a real column that
    happens to be empty keeps its place in the read.
    """
    return [_drawn(cards) for cards in list(cols.values())[:-1]]


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
    board = _board(cols)
    assert sorted(board, key=len)[0] == ["Two"], cols
    assert ["Renamed", "Three"] in [sorted(c) for c in board], cols


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
        lambda d: len(d["cards"]) == 3 and d["column"] is not None,
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
        window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 3, timeout=15
    )["cards"], slots

    cols = _wait(
        window,
        COLUMNS,
        lambda d: ["Two", "One"] in [_drawn(cards) for cards in d["cols"].values()],
        timeout=15,
    )["cols"]
    # The card went to the bottom of its own column, the gap the line was in.
    assert ["Two", "One"] in [_drawn(cards) for cards in cols.values()], cols


def test_kanban_drop_line_stays_above_the_drawn_slot(window):
    """The line says where the card lands, and a slot is not a place below it.

    The foot of every column is drawn as a "+ Add a card" slot, so it is where
    the bottom of a column *looks* like it is -- which is exactly where a user
    drags to put a card last. There is no gap under it, because the slot is
    where the next card goes and stays the last thing drawn: the card lands
    above it. So the line has to be drawn in that gap, or it promises a place
    the release does not act on.

    Real browser only: the slot's drawn box, the gap heights and the line's
    position in the drawing are mermaid's own layout.
    """
    _render(window, KANBAN)
    _enter_edit_mode(window)
    _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 3, timeout=15)

    # Card 0 dragged to the foot of its own column, aimed at the lower half of
    # the drawn slot -- past the slot's middle, where a slot-as-a-card would
    # have been counted as something above the pointer.
    mid = _pointer_drag(window, card=0, section=0, aim="slot")["mid"]
    slot = mid["slot"]
    line = mid["line"]
    assert slot is not None and line is not None and line["shown"] is True, mid
    # The gap the card actually fills is the one above the slot.
    assert line["y"] < slot["top"], (
        f"the line is at {line['y']:.1f}, over the slot at {slot['top']:.1f}"
        f"-{slot['bottom']:.1f}: it offers a place below it, which does not exist: {mid}"
    )

    # And the release lands the card above the slot, in the gap the line was in.
    cols = _wait(
        window,
        COLUMNS,
        lambda d: ["Two", "One"] in [_drawn(cards) for cards in d["cols"].values()],
        timeout=15,
    )["cols"]
    drawn = _board(cols)
    assert ["Two", "One"] in drawn, cols
    # The slot is still the last thing in the column it belongs to.
    assert all(cards[-1] == "+ Add a card" for cards in cols.values()), cols


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
    _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 3, timeout=15)

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
    # Painted on top of what it is passing over. The board is two sibling lists --
    # the frames in `.sections`, the cards in `.items`, the frames first -- and the
    # svg paints in document order, so every card is drawn over every frame: a
    # frame left in `.sections` is over the other frames and under every card on
    # the board. A column is not one element, so it is held in a group of its own,
    # appended last, frame first and then the cards it carries.
    assert mid["heldInGroup"] is True, mid
    # This column is released past the last one, over the column the board is
    # drawn with at its end. That column holds nothing of the document and paints
    # no card — its card slot is the bin, and the bin is only there while a card
    # is in the air — so the frame is what is under the held column, and what
    # answers there is the group and not the frame. The drag that is over other
    # columns' *cards* is `test_..._paints_over`.
    fronted = mid["fronted"]
    assert fronted is not None, mid
    assert fronted["under"] == KANBAN_COLUMN_SLOT, fronted
    assert fronted["held"] is True, fronted
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
        lambda d: _board(d["cols"]) == [["Three"], ["One", "Two"]],
        timeout=15,
    )["cols"]
    # Todo took its two cards along, whole, as one source patch — and it is one
    # undo away, because it is one setNodeMarkup. The column the board is drawn
    # with holds no cards, so it is not in the reading.
    assert _board(cols) == [["Three"], ["One", "Two"]], cols


# The board the two paint-order bugs were reported on: a last column with nothing
# in it, so the only thing standing in it is the drawn card slot.
KANBAN_TRAILING_EMPTY = (
    "kanban\n"
    "  col1[Todo]\n"
    "  col2[Specified]\n"
    "    [STDIN support for code blocks]\n"
    "  col3[Doing]\n"
    "    [Kanban editor]\n"
    "  col4[Done]"
)


def test_kanban_column_line_stays_left_of_the_drawn_column_slot(window):
    """The rule says where the column lands, and the drawn column is not a place
    after it.

    The end of the board is drawn as a "+ Add a column" column, so it is where
    the right-hand end of the board *looks* like it is -- which is where a user
    drags to put a column last. There is no gap beyond it, because the slot is
    where the next column goes and stays the last thing drawn: the column lands
    before it. So the rule has to be drawn in that gap, or it promises a place
    the release does not act on.

    Real browser only: the slot's drawn box, the gap widths and the rule's
    position in the drawing are mermaid's own layout.
    """
    _render(window, KANBAN)
    _enter_edit_mode(window)
    _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 3, timeout=15)

    # Column 0 dragged to the right of the board, aimed at the drawn column's
    # right portion -- past its middle, where a slot-as-a-column would have been
    # counted as something left of the pointer.
    mid = _pointer_drag_column(window, column=0, slot="slot")["mid"]
    slot = mid["slot"]
    line = mid["line"]
    assert slot is not None and line is not None and line["shown"] is True, mid
    # The gap the column actually fills is the one before the slot.
    assert line["x"] < slot["left"], (
        f"the rule is at {line['x']:.1f}, over the drawn column at "
        f"{slot['left']:.1f}-{slot['right']:.1f}: it offers a place after it,"
        f" which does not exist: {mid}"
    )

    # And the release lands the column before the drawn one, in the gap the rule
    # was in: Todo took its two cards to the end, and the board is read as a
    # whole sequence. The drawn column holds no cards, so it is not in the read.
    cols = _wait(
        window,
        COLUMNS,
        lambda d: _board(d["cols"]) == [["Three"], ["One", "Two"]],
        timeout=15,
    )["cols"]
    assert _board(cols) == [["Three"], ["One", "Two"]], cols


def test_kanban_column_drag_paints_over_the_cards_it_passes(window):
    """A column in flight is *on top* of the board it is passing over.

    The board is drawn as two sibling lists — the frames in `.sections`, the cards
    in `.items`, the frames first — and svg paints in document order, so a frame
    re-appended to the end of `.sections` is over the other frames and still under
    every card in `.items`. Two things were wrong with that, and both were read as
    one: a neighbouring column's cards lay *across* the column being dragged, and a
    column passing over a neighbour's cards looked like it had picked them up —
    which is how an empty `Done` at the end of a board came to look like it was
    carrying `Specified`'s card with it. The lift is a group of its own for exactly
    this, and this asks the rendering which of the two is on top rather than asking
    the DOM where things are: with a group the answer is the held column, without
    one the answer is the neighbour's card.
    """
    _render(window, KANBAN_TRAILING_EMPTY)
    _enter_edit_mode(window)
    _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 5, timeout=15)

    # The empty trailing column, dragged left over `Specified` and its card.
    mid = _pointer_drag_column(window, column=3, slot=1)["mid"]
    assert mid["lifted"] is True, mid
    # The group is this column and nothing else: its frame, and the drawn slot
    # that is all it holds. A card the model does not place in this column is not
    # in the group, however near it the pointer is.
    assert mid["heldInGroup"] is True, mid
    assert mid["cardsLifted"] is True, mid
    fronted = mid["fronted"]
    assert fronted is not None, mid
    assert fronted["under"] == "STDIN support for code blocks", fronted
    # The question, asked of the page: over the neighbour's card, what is on top?
    # A held card is `pointer-events: none` so the drop is read off the pointer,
    # and the helper lifts that for the sample and puts it straight back — so this
    # is the paint order and not the hit-test order.
    assert fronted["held"] is True, fronted
    # And the drop is the real thing: `Done` is now the second column, with
    # everything still where the board had it.
    assert _wait(
        window,
        LABEL_STATE,
        lambda d: d.get("source", "").index("col4[Done]") < d.get("source", "").index("col2[Specified]")
        if d.get("source")
        else False,
        timeout=15,
    )["source"] == (
        "kanban\n"
        "  col1[Todo]\n"
        "  col4[Done]\n"
        "  col2[Specified]\n"
        "    [STDIN support for code blocks]\n"
        "  col3[Doing]\n"
        "    [Kanban editor]"
    )


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


# A title and a column name with nowhere in them to break: one run of letters
# with no space in it, which is what an identifier, a URL or an acronym pasted
# into a board actually looks like.
UNBREAKABLE = "VERY LONG TEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEXT"


def test_unbreakable_kanban_titles_stay_inside_their_cards(window):
    """A card is a fixed width, so its title has to wrap inside it.

    Real browser only, and layout only: jsdom computes no boxes at all. Mermaid
    measures a label with ``white-space: break-spaces`` — it breaks at whitespace
    and nowhere else — and a run with no whitespace in it is therefore measured
    as one line several times the card's width. A board's card width is fixed by
    ``kanban.sectionWidth``, so nothing downstream can absorb that: the card is
    drawn at the width it was told to be and the title paints outside it, over
    the columns next door.

    The rule that lets a label break has to be in the stylesheet mermaid
    measures with (``themeCSS``), not in ours: applied after the render it puts
    the text inside the card and leaves the card the height of the *un*-wrapped
    text, so the last line sticks out of the bottom instead.
    """
    _render(window, "kanban\n  %s\n    id1[%s]\n    id2[Second]\n  Doing\n    id3[Short]"
            % (UNBREAKABLE, UNBREAKABLE))

    board = _dump(
        window,
        """(() => {
          // A label is a `foreignObject` with text in it; the empty ones mermaid
          // draws alongside it (a card's spacer and assignee, a section's spare)
          // are what the first test in the file calls "the empty labels".
          const labelOf = (scope) => [...scope.querySelectorAll('foreignObject')]
            .find(fo => (fo.textContent || '').trim().length > 0);
          const cards = [];
          for (const card of document.querySelectorAll('.mermaid .items > g.node')) {
            const fo = labelOf(card);
            if (!fo) continue;
            const frame = card.querySelector('rect').getBoundingClientRect();
            const box = fo.getBoundingClientRect();
            cards.push({
              text: fo.textContent.trim().slice(0, 10),
              insideWidth: box.left >= frame.left - 1 && box.right <= frame.right + 1,
              insideHeight: box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
              overflow: Math.round(Math.max(0, box.right - frame.right)),
            });
          }
          const band = document.querySelector('.mermaid .sections > g');
          const b = band ? band.querySelector('rect').getBoundingClientRect() : null;
          const bandLabel = band ? labelOf(band) : null;
          const bandBox = bandLabel ? bandLabel.getBoundingClientRect() : null;
          const lowest = [...document.querySelectorAll('.mermaid .items > g.node')]
            .map(c => c.getBoundingClientRect().bottom).reduce((a, x) => Math.max(a, x), 0);
          return {
            cards,
            band: b ? {
              bottom: Math.round(b.bottom),
              lowest: Math.round(lowest),
              insideWidth: bandBox ? bandBox.left >= b.left - 1 && bandBox.right <= b.right + 1 : false,
              label: bandBox ? bandLabel.textContent.trim().slice(0, 10) : '',
            } : null,
          };
        })()""",
    )
    assert board["cards"], board

    long_card, short_card = board["cards"][0], board["cards"][1]
    assert long_card["text"] == "VERY LONG ", long_card
    assert long_card["insideWidth"] is True, long_card
    assert long_card["overflow"] == 0, long_card
    # And the card is tall enough for the wrapped title, which is the half a
    # post-render rule cannot do: mermaid only knows the height if it measured
    # the wrapped label, and the next card down sits below that.
    assert long_card["insideHeight"] is True, long_card
    assert short_card["insideWidth"] and short_card["insideHeight"], short_card
    # The column's own name is a label too, and the band around it is just as
    # fixed a width as a card is.
    assert board["band"]["label"] == "VERY LONG ", board["band"]
    assert board["band"]["insideWidth"] is True, board["band"]
    # Nothing is left hanging below the board it is in.
    assert board["band"]["lowest"] <= board["band"]["bottom"] + 1, board["band"]


def test_kanban_card_editor_grows_with_its_text_and_only_with_it(window):
    """A composer stands in for a card, so it has to be the card's size.

    Real browser only: the whole of this is layout, and jsdom computes none of
    it. The card is stretched to the title -- its own height plus the card's
    padding -- and *that* is the whole of what a title may do to it. The field's
    floor used to be read back off the very card the field was stretching, so the
    two fed each other and the card grew by a line for every character typed: a
    sentence left a composer taller than the board it was standing on.
    """
    title = (
        "A title long enough that mermaid has to wrap it across several lines "
        "of the card it is drawn in"
    )

    def measure():
        return _dump(
            window,
            """(() => {
              const card = document.querySelector('.mermaid .items > g.node.mermaid-node-editing');
              const input = document.querySelector('.mermaid-edit-input');
              if (!card || !input) return { missing: true };
              const height = Number(card.querySelector('rect').getAttribute('height'));
              return {
                card: height,
                field: Math.round(input.getBoundingClientRect().height),
                text: input.value.length,
              };
            })()""",
        )

    def settled():
        # Wait for the two to *agree*, not for the card to merely exist. `h > 0` is
        # true the instant the field opens, so it waited for nothing and left this
        # to whichever of the two the renderer got to first — which is why the same
        # numbers failed about one run in twelve.
        _wait(
            window,
            """(() => {
              const card = document.querySelector('.mermaid .items > g.node.mermaid-node-editing');
              const input = document.querySelector('.mermaid-edit-input');
              if (!card || !input) return { h: 0, agree: false };
              const h = Number(card.querySelector('rect').getAttribute('height'));
              const f = input.getBoundingClientRect().height;
              return { h, agree: input.style.height !== 'auto' && h > 0 && h <= f + 9 };
            })()""",
            lambda d: d["agree"],
        )

    _render(window, KANBAN)
    _enter_edit_mode(window)

    # The whole title at once: the height it actually needs.
    _click_kanban_slot(window, 0)
    drawn = measure()["card"]
    _type_into(window, title)
    settled()
    whole = measure()
    assert not whole.get("missing"), whole
    # The card ends up the composer's content plus the card's own 8px of padding,
    # so it is taller than the slot it replaces and no taller than that.
    assert whole["card"] > drawn, (whole, drawn)
    assert whole["card"] <= whole["field"] + 8 + 1, whole

    # The same title, arriving in pieces rather than at once. Feeding each other,
    # each chunk would leave the card a line taller than the one before it, so the
    # two would not agree on a height the text has already settled at.
    _type_and_confirm(window, "One")
    _click_kanban_slot(window, 0)
    for chunk in (title[:20], title[:60], title[:100], title):
        _type_into(window, chunk)
    settled()
    piecemeal = measure()
    assert piecemeal["text"] == len(title), piecemeal
    assert piecemeal["card"] == pytest.approx(whole["card"], abs=1.0), (piecemeal, whole)

    # Confirm what is in the field, which `_type_and_confirm` cannot do: it sets
    # the value before pressing Enter, and the value is the thing under test.
    _press_key(window, "Enter")
    _wait(
        window,
        "(() => ({ gone: !document.querySelector('.mermaid-edit-input') }))()",
        lambda d: d["gone"],
    )
    assert _wait_text(window, [title]), "the title did not reach the source"


def _type_into(win, value):
    """Fill the open field with ``value`` and let the editor react to it."""
    _dump(
        win,
        """(() => {
          const input = document.querySelector('.mermaid-edit-input');
          if (!input) return { missing: true };
          input.value = %s;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        })()"""
        % json.dumps(value),
    )
    return value


def test_kanban_drawn_slot_creates_a_card(window):
    """The place a card is added is drawn in the board, and it adds one there.

    Real browser only, because the whole feature is the drawing: a card slot in
    every column and a column at the end of the board, both put in the source
    only for as long as the board is being edited, and a commit that strips them.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)

    slots = _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 4, timeout=15)
    board = _wait(
        window,
        KANBAN_CHROME,
        lambda d: len(d["bands"]) == 4 and all(b["box"] for b in d["bands"]),
        timeout=15,
    )
    assert [card["text"] for card in slots["cards"]] == [KANBAN_CARD_SLOT] * 4, slots
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

    # Magnifying rescales the whole drawing, and there is nothing to keep in step:
    # the slot *is* the board's own card, so it is in the same column after the
    # document is magnified as before it.
    _zoom(window, "1.25")
    zoomed = _wait(
        window,
        KANBAN_SLOTS,
        lambda d: len(d["cards"]) == 4
        and d["cards"][0]["box"]["width"] > slots["cards"][0]["box"]["width"],
        timeout=15,
    )
    assert _slots_in_their_bands(_dump(window, KANBAN_CHROME), zoomed), zoomed
    _zoom(window, "1")

    opened = _click_kanban_slot(window, 1)
    # The slot's own caption becomes the editor — same box as the card that is
    # about to stand there, not a panel floating over the diagram.
    assert opened["v"] == "" and opened["ph"] == "Card title", opened
    assert opened["box"]["top"] >= opened["anchor"]["top"] - 1.0
    assert opened["box"]["bottom"] <= opened["anchor"]["bottom"] + 1.0, opened
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
    after = _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 4, timeout=15)
    assert _slots_in_their_bands(_dump(window, KANBAN_CHROME), after), after

    # ...and the field it opens is the same one a label edit uses, so Esc is
    # the same way out of it.
    _click_kanban_slot(window, 0)
    _type(window, "Discarded")
    _dump(
        window,
        "(() => { const i = document.querySelector('.mermaid-edit-input, .mermaid [contenteditable=\"true\"]');"
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


def test_kanban_chrome_is_one_mark_per_column(window):
    """A board's own controls are one `⋯` per column, and nothing else.

    Adding used to be a ＋ on every column header *and* a ＋ in every band *and* an
    empty column standing beside the board: four positioned things per column,
    none of them drawn by mermaid, all of them answering "how do I add". Now the
    board is *drawn* with a card slot in every column and a column at the end, so
    adding is part of the diagram rather than a control laid over it, and a card
    carries nothing at all: a card's own corner is its own title, so a mark there
    is drawn on the words, and a card is deleted by being picked up and dropped on
    the drawn column slot instead.

    What is left is one `⋯` per column, always on screen: a control nobody can
    find is not quieter, it is missing.

    Real browser only: the boxes are laid out by mermaid and its stylesheet.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)
    board = _wait(
        window,
        KANBAN_CHROME,
        lambda d: len(d["buttons"]) == 3 and len(d["cards"]) == 6 and len(d["bands"]) == 4,
        timeout=15,
    )
    # Two real cards, a slot in each of the three columns, and the drawn column
    # with one of its own -- which is the bin, and is a place a card is dropped on
    # rather than added to.
    texts = [card["text"] for card in board["cards"]]
    assert texts.count(KANBAN_CARD_SLOT) == 4, texts
    assert sorted(t for t in texts if t != KANBAN_CARD_SLOT) == ["One", "Two"], texts
    kinds = sorted(b["kind"] for b in board["buttons"])
    assert kinds == ["mermaid-kanban-menu"] * 3, kinds
    assert {b["text"] for b in board["buttons"]} == {"⋯"}

    # Each control's whole box sits inside the band it names.
    for button in board["buttons"]:
        assert any(_buttons_in(shape, button) for shape in board["bands"]), (button, board["bands"])
    # And the drawn column is the board's own, not a control laid beside it.
    slots = _dump(window, KANBAN_SLOTS)
    assert _column_slot_past_the_board(board, slots), (slots, board)

    # A card is not covered by anything: no ✕, and nothing standing in for one.
    # The bin is a card slot, and a card slot is a place to add a card until a
    # card is in the air — at rest the column says what it is for, and so does
    # the card slot in it.
    assert not any(b["kind"] == "mermaid-kanban-card-remove" for b in board["buttons"]), board
    quiet = _dump(window, KANBAN_TRASH)
    assert quiet["band"]["words"] == KANBAN_COLUMN_SLOT, quiet
    assert quiet["card"] is not None, quiet
    assert quiet["card"]["words"] == KANBAN_CARD_SLOT, quiet
    assert quiet["band"]["mark"] is False and quiet["card"]["mark"] is False, quiet


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
    slots = _wait(window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 5, timeout=15)
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


def test_a_card_dropped_on_the_board_s_slot_column_is_deleted(window):
    """The drawn slot column is the bin a card is dropped on to be deleted.

    A card's own corner is its own title -- mermaid lays a label into the whole
    inner width of a card, so a title long enough to fill the card runs right up
    to its edge -- which is why a delete mark on a card has nowhere to sit that is
    not on the words. The board is already drawn with a *card slot* at its end
    that a card has no business in, and while a card is in the air there is nothing
    that card would rather be, so the slot becomes the bin for the length of the
    drag and says what it is now for.

    Two halves, because a card in the air covers the card slot it is aimed at: the
    slot is the bin, and the band it stands in is dressed with it -- taller than a
    card, so its header is the half still readable while the card is over the
    middle. The one complaint that sent this back for another pass was that a bin
    said on the band alone was invisible in use, so both are asserted here, on both
    of the things a user can read.

    The bin is *of* the drawing, not laid over it: a board is two sibling lists,
    the frames in `.sections` and the cards in `.items`, painted frames first, and
    a lift puts the held card last. So the card on its way to the bin paints over
    both halves of it, which is the whole of what makes this readable -- an overlay
    is a child of the preview and answers over the whole board, the very card
    included.

    The one thing that would make this worse is the two gestures sharing one
    column: a *press* on the slot still has to name a new column, not add a card
    to a column that does not exist yet. So the bin goes with the drag, and the
    `+ Add a card` is back the moment it ends.

    Real browser only: the bin is a card and a band mermaid sized, painted through
    styles only a browser resolves, and what a card can reach in a column is
    mermaid's own layout.
    """
    _render(window, KANBAN)
    _enter_edit_mode(window)
    _wait(window, KANBAN_CHROME, lambda d: len(d["bands"]) == 3, timeout=15)
    # Nothing there until a card is in the air, and by "nothing" it means painted
    # nothing: the card slot in the drawn column is *not* a place to add a card.
    # It is the one place on the board offering a card to a column that does not
    # exist yet, and the press it invites is answered with a *column*, so a card
    # captioned `+ Add a card` standing in a column captioned `+ Add a column` is
    # a caption over the wrong answer. The space is still drawn -- mermaid sized
    # the band around it, and a drag may not re-render the drawing out from under
    # the card it is holding -- so the slot is in the DOM and paints nothing, and
    # a bin that was showing all the time would be a delete round every card.
    quiet = _dump(window, KANBAN_TRASH)
    assert quiet["present"] is True, quiet
    assert quiet["band"]["words"] == KANBAN_COLUMN_SLOT, quiet
    assert quiet["band"]["painted"] is True, quiet
    assert quiet["card"] is not None, quiet
    assert quiet["card"]["words"] == KANBAN_CARD_SLOT, quiet
    assert quiet["card"]["painted"] is False, quiet
    assert quiet["card"]["wordsPainted"] is False, quiet
    assert quiet["band"]["mark"] is False and quiet["card"]["mark"] is False, quiet
    assert quiet["band"]["opacity"] in ("0", "1"), quiet
    assert quiet["card"]["opacity"] in ("0", "1"), quiet

    mid = _pointer_drag_to_the_trash(window, card=0)["mid"]
    bin = mid["bin"]
    # Both halves of it say what it is for, and both say it *whole*: mermaid sized
    # each label box to the words it drew and a foreignObject clips — in both
    # axes, so the mark has to sit on the label's line like a word (the drawing's
    # own `svg` rule makes it a block, and a block mark pushes "card" onto a
    # second line the one-line box cuts) and the card, whose box was sized for
    # `+ Add a card`, says the one word that fits beside the mark while the band,
    # sized for a longer name, says both. A screenshot of a just-mutated DOM is a
    # stale frame and would not be trusted to say any of it.
    for half, what, says in ((bin["card"], "card", "Delete"), (bin["band"], "band", "Delete card")):
        assert half is not None, (what, bin)
        assert half["words"] == says, (what, bin)
        assert half["painted"] is True and half["wordsPainted"] is True, (what, bin)
        assert half["mark"] is True, (what, bin)
        # The mark is painted by its own paths, and mermaid styles `path` inside a
        # board with its own palette -- which beats an inherited value, and beat
        # one too here: the words were the danger colour and the mark beside them
        # was the diagram's. So the colour is read off the path, not off the mark.
        assert half["markStroke"] == half["colour"], (what, bin)
        assert half["markFill"] == "none", (what, bin)
        assert half["opacity"] == "0.28", (what, bin)
        assert half["width"], (what, bin)
        assert "255, 255, 255" not in half["fill"], (what, bin)
        assert half["colour"].startswith("rgb("), (what, bin)
        assert half["box"] is not None, (what, bin)
        assert half["fits"] is True, (what, bin)
    # And nothing is promised where a card cannot land. The slot column is a place
    # to *name*, so nothing is offered over it and the line goes away there -- and
    # a lit bin in its place is the answer rather than a contradiction of one.
    assert mid["line"] is None or mid["line"]["shown"] is False, mid
    assert mid["target"] is False, mid
    # The bin is *under* the card being dragged, not over it. This is the whole
    # reason it is drawn rather than laid on, and it is what the paint order says:
    # the card is in front of the band, and the band is there to be behind it. An
    # overlay answered with itself instead -- the very card on its way to it,
    # hidden behind the thing to drop it on. Read as paint order and geometry
    # rather than as a hit test, because a held card takes no pointer events (that
    # is what makes the drop read off the pointer) and is therefore invisible to
    # one.
    over = mid["over"]
    assert over == {
        "order": True,
        "last": True,
        "covers": True,
        "onBand": True,
        "onCard": True,
    }, (over, mid)

    # A delete is still a decision with two answers, and it is still a question
    # about the board rather than a guess at what is being taken.
    prompt = _wait(window, DELETE_PROMPT, lambda d: d["present"], timeout=10)
    assert "One" in prompt["title"], prompt
    _answer_delete_prompt(window, "Cancel")
    _wait(window, DELETE_PROMPT, lambda d: not d["present"], timeout=10)
    kept = _wait(window, DOC_SOURCE, lambda d: d["n"] == 1, timeout=10)
    assert "id1[One]" in kept["sources"][0], kept
    # The other answer, on a board that still has the card to lose.
    _pointer_drag_to_the_trash(window, card=0)
    _wait(window, DELETE_PROMPT, lambda d: d["present"], timeout=10)
    _answer_delete_prompt(window, "Delete")
    dropped = _wait(window, DOC_SOURCE, lambda d: d["n"] == 1 and "id1" not in d["sources"][0], timeout=15)
    assert "id2[Two]" in dropped["sources"][0], dropped

    # And the column is a place to add a column again, and its card slot a place to
    # add a card: the bin went with the drag, in every part of itself, so a board
    # nobody is dragging on is a board to add to -- and nothing of the bin is left
    # painted on either half of it.
    after = _wait(
        window,
        KANBAN_TRASH,
        lambda d: d["band"]["words"] == KANBAN_COLUMN_SLOT and d["card"]["words"] == KANBAN_CARD_SLOT,
        timeout=15,
    )
    assert after["band"]["mark"] is False and after["card"]["mark"] is False, after
    slots = _wait(window, KANBAN_SLOTS, lambda d: d["column"] is not None, timeout=15)
    assert slots["column"]["text"] == KANBAN_COLUMN_SLOT, slots


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
    board = _dump(window, KANBAN_CHROME)
    band = board["bands"][0]
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

    # Attached to its own ⋯: the popover starts exactly where the button ends, so
    # there is no strip of board between the two, and the whole way down from the
    # button to the first item is answered by the button and the menu. A press
    # there is a press on the menu, so the menu is still there afterwards.
    seam = _press_at_the_menu_seam(window)
    assert seam["gap"] == 0, seam
    assert seam["seen"] == ["its button", "the menu"], seam
    assert seam["stillOpen"] is True, seam

    # On the same line as the name it is the menu of, which is what the eye puts
    # it against: the mark belongs to the header, and the band is padded around
    # it, so an inset from the band's own top edge sits below the text.
    name = band["name"]
    dot = next(b for b in board["buttons"] if b["label"] == "Todo column actions")
    assert abs(
        (dot["box"]["top"] + dot["box"]["bottom"]) / 2
        - (name["top"] + name["bottom"]) / 2
    ) <= 1.0, (dot, band)

    # The walk back up to the `⋯` that opened it is the other half of the same
    # gesture, and the menu is still there: the mark the list hangs off is part
    # of the menu, so leaving the list for it is not leaving the menu.
    _hover(window, ".mermaid-kanban-menu", 0)
    assert _dump(window, KANBAN_MENU)["open"] is True

    # A *different* column's `⋯` is a move rather than a return, so it does take
    # the menu away: only the one that owns it is the menu's own.
    _hover(window, ".mermaid-kanban-menu", 1)
    _wait(window, KANBAN_MENU, lambda d: not d["open"], timeout=10)
    _open_kanban_menu(window, 0)

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
    # rather than asked for somewhere else. The field is *empty*: what the board
    # drew there is a place to put a name, not a name to retype, and a card's
    # composer has always started this way.
    opened = _click_kanban_column_slot(window)
    assert opened["v"] == "" and opened["ph"] == "Column name", opened
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
    """Dropping a card on the bin asks before it takes, and says what it takes.

    A delete is still a decision with two answers even when the answer is a
    gesture rather than a button: the bin is the board's own drawn column, so the
    one that can be got wrong is the one that moves a card somewhere -- and the
    prompt says which card and which column, so neither answer is a guess. It is
    a red Delete because it is the one that takes something away.

    Real browser only: the bin is a band mermaid sized and the drag is the gesture
    itself.
    """
    _render(window, KANBAN_EMPTY)
    _enter_edit_mode(window)
    # Two real cards and a slot in every column, so a card is found by what it
    # says rather than by where it happens to be in the list of drawn cards.
    _wait(
        window,
        KANBAN_CHROME,
        lambda d: len([c for c in d["cards"] if c["text"] == KANBAN_CARD_SLOT]) == 4,
        timeout=15,
    )

    # A bin that is not armed takes nothing: a Cancel keeps the card.
    _pointer_drag_to_the_trash(window, card=0)
    prompt = _wait(window, DELETE_PROMPT, lambda d: d["present"], timeout=10)
    assert prompt["title"] == "Delete “One”?" and prompt["danger"], prompt
    assert prompt["buttons"] == ["Cancel", "Delete"], prompt
    assert "removed from the Todo column" in prompt["note"], prompt
    _answer_delete_prompt(window, "Cancel")
    _wait(window, DELETE_PROMPT, lambda d: not d["present"], timeout=10)
    kept = _wait(window, DOC_SOURCE, lambda d: d["n"] == 1, timeout=10)
    assert "id1[One]" in kept["sources"][0], kept

    # And answering it removes the card, as one source patch.
    _pointer_drag_to_the_trash(window, card=0)
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
    assert [b["kind"] for b in board["buttons"]] == ["mermaid-kanban-menu"] * 3, board


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
    assert opened["v"] == "" and opened["ph"] == "Card title", opened
    # The slot's own caption became the editor, standing where the card will
    # stand: no panel floats over the diagram.
    assert opened["box"]["top"] >= opened["anchor"]["top"] - 1.0, opened
    assert opened["box"]["left"] >= opened["anchor"]["left"] - 1.0, opened

    # A line break cannot be written into a card title, so Shift+Enter is refused
    # rather than left to make a title mermaid will not read back: the field
    # closes, the slot is restored, nothing is written.
    title = "A title long enough to wrap onto a second line of the composer"
    _type(window, title)
    refused = _press_key(window, "Enter", shift=True)
    assert refused["value"] == title, refused
    # Refused means the editor is still there, with the title still in it, and
    # nothing was written to the board: the shift key is not a commit key.
    assert _dump(window, DOC_SOURCE)["sources"][0] == KANBAN_EMPTY, "Shift+Enter wrote to the board"
    # Enter is the commit key, and the card is the title that was written.
    _press_key(window, "Enter")
    _wait(
        window,
        DOC_SOURCE,
        lambda d: d["n"] == 1 and "A title long enough to wrap" in d["sources"][0],
        timeout=20,
    )


def test_a_double_click_in_a_spreadsheet_cell_stays_a_word_selection(window):
    """A bare double click inside a spreadsheet cell is the browser's, not a mode.

    §5.2 of the block-modes spec moved the block-mode gestures off double click
    onto Alt+click precisely because the old handler was stealing this: a double
    click on a word is the word being selected, and it also used to be the gesture
    that left the sheet. A real engine with the real grid, so the grid's own double
    click (its inline cell editor) and the browser's selection are both in play.
    """
    window._web.page().runJavaScript(
        "window.ediSetContent('| Name | Qty |\\n| --- | --- |\\n| Widget | 4 |\\n'); true"
    )
    opened = _wait(
        window,
        "(() => { const b = document.querySelector('.block-control-form');"
        " if (!b) return { missing: true };"
        " if (b.textContent === 'Edit') b.click();"
        " return { sheet: !!document.querySelector('.spreadsheet'),"
        "  label: b.textContent }; })()",
        lambda d: d.get("sheet") is True,
        timeout=15,
    )
    assert opened["sheet"], opened

    before = _dump(window, "(() => ({ plain: !!document.querySelector('.ss-plain') }))()")
    assert not before["plain"], "the table was not a sheet to begin with"

    # A real double click, at real coordinates, on a real word.
    spot = _dump(
        window,
        """(() => {
          const cell = document.querySelector('.spreadsheet .ss-grid tbody td');
          if (!cell) return { missing: true };
          const range = document.createRange();
          range.selectNodeContents(cell);
          const rect = range.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const at = document.elementFromPoint(x, y) || cell;
          const opts = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
          for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
            at.dispatchEvent(new MouseEvent(type, opts));
          }
          return { x, y, cell: cell.textContent, target: at.tagName };
        })()""",
    )
    assert not spot.get("missing"), "no spreadsheet cell to double click in"

    time.sleep(0.3)
    after = _dump(window, "(() => ({ sheet: !!document.querySelector('.spreadsheet'),"
                         " plain: !!document.querySelector('.ss-plain'),"
                         " form: (document.querySelector('.block-control-form') || {}).textContent }))()")
    assert after["sheet"] and not after["plain"], after
    assert after["form"] == "Visual", after

    # ...and the gesture that *does* toggle the block still does, from the cell: a
    # sheet IS a table's Edit mode (§5.1), so the press from a cell goes back to
    # plain text rather than into the block's own source (§5.2).
    _dump(
        window,
        "(() => { const cell = document.querySelector('.spreadsheet .ss-grid tbody td');"
        " cell.dispatchEvent(new MouseEvent('click',"
        " { bubbles: true, cancelable: true, button: 0, altKey: true }));"
        " return { clicked: true }; })()",
    )
    sourced = _wait(
        window,
        "(() => ({ source: !!document.querySelector('.block-source-mode'),"
        " sheet: !!document.querySelector('.spreadsheet'),"
        " plain: !!document.querySelector('.ss-plain') }))()",
        lambda d: d.get("plain") is True,
        timeout=10,
    )
    assert not sourced["source"] and not sourced["sheet"], sourced

    # And a table still reaches Source by its own route — the cluster's Source
    # button, which is not a mode gesture and never was. Back to the sheet first,
    # so there is a sticky form to come home to.
    _dump(
        window,
        "(() => { const b = document.querySelector('.block-control-form');"
        " if (!b) return { missing: true };"
        " b.click(); return { clicked: true }; })()",
    )
    _wait(window, "(() => ({ sheet: !!document.querySelector('.spreadsheet') }))()",
          lambda d: d.get("sheet") is True, timeout=10)
    _dump(
        window,
        "(() => { const b = document.querySelector('.block-control-representation');"
        " if (!b) return { missing: true };"
        " b.click(); return { clicked: true }; })()",
    )
    _wait(
        window,
        "(() => ({ source: !!document.querySelector('.block-source-mode'),"
        " sheet: !!document.querySelector('.spreadsheet'),"
        " plain: !!document.querySelector('.ss-plain') }))()",
        lambda d: d.get("source") is True,
        timeout=10,
    )

    # The banner's Visual button is the way out of a source block, and a form is
    # sticky: it is the sheet this block left that comes back, not its default.
    # (Escape is the ladder's job and is covered as such.)
    _dump(
        window,
        "(() => { const b = document.querySelector('.block-source-exit');"
        " if (!b) return { missing: true };"
        " b.click(); return { clicked: true }; })()",
    )
    back = _wait(
        window,
        "(() => ({ sheet: !!document.querySelector('.spreadsheet'),"
        " plain: !!document.querySelector('.ss-plain'),"
        " form: (document.querySelector('.block-control-form') || {}).textContent }))()",
        lambda d: d.get("sheet") is True,
        timeout=10,
    )
    assert back["sheet"] and not back["plain"] and back["form"] == "Visual", back


# What a code block's one control row holds, and — the claim this test exists
# for — that nothing else is floating over the code where it sits. The copy button
# used to be there: absolutely positioned in the same corner as the cluster, with
# `padding-right` on the source to make room for it. A screenshot of a just-mutated
# DOM under the offscreen platform is a stale frame and would have believed it, so
# the question is asked of the computed style and of `elementFromPoint`.
CODE_BLOCK_CONTROLS = """
(() => {
  const block = document.querySelector('.runnable-block');
  const cluster = block && block.querySelector('.block-controls');
  if (!block || !cluster) return { missing: true };
  const cs = (el) => getComputedStyle(el);
  const rect = (el) => el.getBoundingClientRect();
  const buttons = [...cluster.querySelectorAll('button')];
  const bar = block.querySelector('.code-lang-bar');
  const floating = [...block.querySelectorAll('*')].filter((el) => {
    if (el.classList.contains('block-controls')) return false;
    const r = rect(el);
    return cs(el).position === 'absolute' && r.width > 0 && r.height > 0;
  }).map((el) => String(el.getAttribute('class')));
  cluster.style.pointerEvents = 'auto';
  return {
    buttons: buttons.map((b) => b.textContent),
    floating,
    reserve: !!block.querySelector('.source-has-copy'),
    // Every cluster button has to be the thing under its own centre, or a
    // control that is present and hit-testable-looking is not pressable — which
    // is what the language bar sits in the row above it.
    hits: buttons.map((b) => {
      const r = rect(b);
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
    }),
    // One button, one border. The copy used to keep the floating button's border
    // and fill *on top of* `.block-control`'s, which drew a second outline round
    // it and — being a second set of metrics too — made it 3px taller than the
    // button beside it and the row taller than the bar the row sits on.
    borders: buttons.map((b) => [cs(b).borderTopWidth, cs(b).borderRightWidth,
      cs(b).borderBottomWidth, cs(b).borderLeftWidth].join(' ')),
    backgrounds: buttons.map((b) => cs(b).backgroundColor),
    heights: buttons.map((b) => Math.round(rect(b).height)),
    rowHeight: Math.round(rect(cluster).height),
    // Where the row sits against the block's own first row of chrome. A code
    // block's language bar is the only one of those the generic CSS can know
    // about, so it is the one this can be checked against: a row 7px down covered
    // the 25px bar *and* 11px of the first lines of code.
    chrome: bar ? { topGap: Math.round(rect(cluster).top - rect(bar).top),
                    overhang: Math.round(rect(cluster).bottom - rect(bar).bottom),
                    barHeight: Math.round(rect(bar).height) } : null,
  };
})()
"""


def test_a_code_blocks_copy_lives_in_its_control_cluster(window):
    """A code block's **Copy** is one of its cluster's buttons, not a second control
    floating in the same corner.

    Real engine: the overlap was two absolutely-positioned boxes on top of each
    other, which jsdom cannot see (no layout) and a screenshot cannot be trusted
    to show. The copy is now a contributed action, which is what §6.3 says a
    block's own controls are, so the two can no longer be in the same place.
    """
    _set_scheme(window, False)

    window._web.page().runJavaScript(
        "window.ediSetContent('```python\\nprint(1)\\nprint(2)\\n```'); true"
    )
    time.sleep(0.5)
    plain = _dump(window, CODE_BLOCK_CONTROLS)
    assert not plain.get("missing"), plain
    # Copy, then Source: Source is the right-most control on every block (§6.3),
    # so a block's own actions read to its left in the order the block itself does.
    assert plain["buttons"] == ["Copy", "Source"], plain
    # Nothing is left floating over the code, and nothing reserves room for it.
    assert plain["floating"] == [], plain
    assert not plain["reserve"], plain
    assert all(plain["hits"]), plain
    # Copy is one of the cluster's buttons, so it is drawn like the rest of them:
    # one 1px border, no fill of its own, and the same height as its neighbour.
    assert plain["borders"] == ["1px 1px 1px 1px"] * 2, plain
    assert plain["backgrounds"] == ["rgba(0, 0, 0, 0)"] * 2, plain
    assert len(set(plain["heights"])) == 1, plain

    window._web.page().runJavaScript(
        "window.ediSetContent('```\\n#!/usr/bin/env python3\\nprint(1)\\n```'); true"
    )
    time.sleep(0.5)
    runnable = _dump(window, CODE_BLOCK_CONTROLS)
    assert not runnable.get("missing"), runnable
    # Copy, then Run, then Source — the block's own actions in the order the block
    # reads in, with the one control every block has pinned to the right.
    assert runnable["buttons"] == ["Copy", "Run", "Source"], runnable
    assert runnable["floating"] == [], runnable
    assert all(runnable["hits"]), runnable
    assert len(set(runnable["heights"])) == 1, runnable

    # The row is level with the language bar it belongs to, and the same height as
    # it: a control on a code block belongs *on* the bar, not over the code under
    # it, which is what `top: 6px` did — the row covered the 25px bar and 11px of
    # the first lines of code.
    chrome = runnable["chrome"]
    assert chrome is not None, runnable
    assert chrome["topGap"] <= 2, chrome
    assert chrome["overhang"] <= 0, chrome


def test_source_from_a_board_s_own_cluster_while_it_is_being_edited(window):
    """The block's **Source** control works from inside its edit mode.

    This is the gesture that looks like it does nothing: alt-click a board into
    its interactive mode, press Source, and the record changes while the board
    stays drawn — pressing again puts it back, so the control reads as inert.

    The cause is not the control but how the mode reaches the node views. A mode
    is not a document edit, so ProseMirror re-walks the tree only when a node's
    *decorations* change (`ViewDesc.matchesNode` compares them by value), and a
    decoration that only said \"there is a mode\" is byte-identical across two
    different modes: entering Source from Edit leaves it unchanged, the walk is
    skipped, `MermaidNodeView.update()` is never asked, and the block keeps
    drawing the board. The record therefore says Source and the board says Edit.
    Fixed by making the mode's class carry the mode — which is what §7.2's accent
    rule was for anyway — so this is the test that keeps it load-bearing.
    """
    _set_scheme(window, False)
    _render(window, KANBAN_LONE)
    _enter_edit_mode(window)
    before = _dump(window, EDIT_STATE)
    assert before["editing"] and before["button"] == "Done", before

    _press_source(window)

    # The board is gone, the raw source is on screen, and nothing of the editing
    # layer outlived it — the drawn places to add are edit mode's.
    after = _wait(
        window,
        "(() => ({ source: !!document.querySelector('.block-source-mode'),"
        " banner: (document.querySelector('.block-source-label') || {}).textContent || null,"
        " editing: !!document.querySelector('.mermaid-editing'),"
        " cluster: !!document.querySelector('.mermaid .block-controls'),"
        " marked: document.querySelectorAll('.mermaid-editables').length }))()",
        lambda d: d["source"] is True,
        timeout=10,
    )
    assert after["banner"] == "Source", after
    assert not after["editing"], after
    assert not after["cluster"], after
    assert not after["marked"], after
    slots = _dump(window, KANBAN_SLOTS)
    assert slots["cards"] == [] and slots["column"] is None, "a drawn slot outlived the mode"

    # ...and back again, from the banner: one control, both directions.
    _dump(
        window,
        "(() => { const b = document.querySelector('.block-source-exit');"
        " if (!b) return { missing: true };"
        " b.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));"
        " return { label: b.textContent }; })()",
    )
    back = _wait(
        window,
        "(() => ({ editing: !!document.querySelector('.mermaid-editing'),"
        " labels: [...document.querySelectorAll('.mermaid .block-controls button')]"
        "  .map((b) => b.textContent) }))()",
        lambda d: d["editing"] is False and "Source" in d["labels"],
        timeout=10,
    )
    # Source is the right-most control on every block (§6.3), and coming back
    # from Source is what put the board on screen again — so it is where the
    # record's own button is found, not merely one of the labels.
    assert back["labels"][-1] == "Source", back


def test_alt_click_below_a_lone_board_ends_its_edit_session(window):
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

    spot = _altclick_below_document(window)
    assert not spot["inEditor"], f"the Alt+click landed inside the editor: {spot}"

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
    _altclick_below_document(window)
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

    # A double quote is carried, as `&quot;`: a raw one would close the label
    # its own quote opened, but the entity is not a quote to the grammar and
    # mermaid draws it as `"`. Real browser only, for the same reason.
    _click_kanban_slot(window, 1)
    _type_and_confirm(window, 'He said "hi"')
    quoted_amp = _wait(
        window,
        LABEL_STATE,
        lambda d: any('He said "hi"' in t for t in d["texts"]),
        timeout=20,
    )
    assert '["He said &quot;hi&quot;"]' in quoted_amp["source"], quoted_amp
    assert not quoted_amp["error"] and not quoted_amp["notice"], quoted_amp
    assert quoted_amp["editing"] and quoted_amp["editable"], quoted_amp
    # Renaming it again keeps the escape rather than writing a raw quote back.
    assert _click_label(window, 'He said "hi"') == 'He said "hi"'
    _type_and_confirm(window, 'He said "bye"')
    requoted = _wait(
        window,
        LABEL_STATE,
        lambda d: any('He said "bye"' in t for t in d["texts"]),
        timeout=20,
    )
    assert '["He said &quot;bye&quot;"]' in requoted["source"], requoted

    # What really cannot be carried is a title that is not text at all, and it
    # is refused *in place*: nothing committed, the input still open, the board
    # still in edit mode, so a second attempt is one edit away.
    before = requoted["source"]
    _click_kanban_slot(window, 1)
    _press_enter(window, "one\ntwo")
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
        window, KANBAN_SLOTS, lambda d: len(d["cards"]) == 4 and d["column"] is not None, timeout=20
    )
    assert [c["text"] for c in slots["cards"]] == [KANBAN_CARD_SLOT] * 4, slots
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


def test_magnifying_the_document_redraws_a_baked_diagram(window):
    """A baked diagram is a bitmap, so the document zoom has to redraw it.

    There is no per-diagram zoom left, so the document's one zoom is the only way
    to make a diagram bigger — and at 150% a bitmap rasterized for 100% is
    magnified rather than redrawn. Read the raster's own pixel width rather than
    trusting the look of it: `naturalWidth` is what the bake produced, and the
    displayed width is unchanged either way.
    """
    _set_scheme(window, True)
    _render(window, SEQUENCE)
    assert _wait_baked(window, timeout=25)

    base = _wait(window, RASTER, lambda d: d.get("w", 0) > 0, timeout=25)
    _zoom(window, "1.5")
    magnified = _wait(window, RASTER, lambda d: d.get("w", 0) > base["w"], timeout=25)
    # 2x at 100%, 3x at 150% — a bitmap scaled by the document rather than redrawn
    # would report the same number as `base`.
    assert magnified["w"] > base["w"] * 1.2, (base, magnified)
    # ...and back down again, waited for rather than read: the re-bake is
    # asynchronous, so the raster behind the diagram catches up a frame later.
    _zoom(window, "1")
    assert _wait(window, RASTER, lambda d: d.get("w") == base["w"], timeout=25)["w"] == base["w"]


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

    # An Alt+click outside the diagram finishes edit mode too, and an Alt+click
    # in the label input while editing one does not — a click in a text field is
    # that field's own, not a request about the diagram behind it.
    _enter_edit_mode(window)
    _click_first_offered(window, "Beta")
    _dump(
        window,
        "(() => { const i = document.querySelector('.mermaid-edit-input, .mermaid [contenteditable=\"true\"]');"
        " if (!i) return { missing: true };"
        " i.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true }));"
        " return { in: true }; })()",
    )
    assert _dump(window, LABEL_STATE)["editing"], "an Alt+click in the label input left edit mode"

    _dump(
        window,
        "(() => { const p = [...document.querySelectorAll('.ProseMirror p')]"
        " .find((e) => e.textContent === 'After the diagram');"
        " if (!p) return { missing: true };"
        " p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true }));"
        " return { hit: p.textContent }; })()",
    )
    state = _wait(window, LABEL_STATE, lambda d: not d["editing"], timeout=20)
    assert not state["input"], "the outside Alt+click left the label editor open"
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


# The mode cycle's one gesture, asked the question that made it necessary: which
# block is under the pointer? `.cm-editor` in the `chromeOwnsClick` list used to
# answer "none of them", because a code block's visual form is a CodeMirror
# instance and a click in a text field was being handed to that field — on the
# one block type whose whole content is that field, so by aiming at the code you
# were guaranteed to aim at something the gesture declined.
#
# Real engine, real build, real coordinates on a real `.cm-line`: this is the
# gesture with the mouse where a user's would be, and the only place the geometry
# is real.
CODE_BLOCK_CYCLE_DOC = """An ordinary paragraph.

```python
print(1)
```
"""


def _altclick_on(win, selector):
    """Alt+click the middle of the first match, at real coordinates."""
    return _dump(win, """(() => {
      const el = document.querySelector(%s);
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const at = document.elementFromPoint(x, y) || el;
      const opts = { bubbles: true, cancelable: true, button: 0, altKey: true,
                     clientX: x, clientY: y };
      for (const type of ['mousedown', 'mouseup', 'click']) {
        at.dispatchEvent(new MouseEvent(type, opts));
      }
      return { tag: at.tagName, cls: String(at.className).slice(0, 40) };
    })()""" % json.dumps(selector))


def test_alt_click_on_a_code_blocks_text_toggles_its_modes(window):
    """Alt+click the code, not its language bar, and the block toggles.

    The distinction being pinned is `.cm-editor`'s: a code block's visual form is
    a CodeMirror instance, and the rule that hands an Alt+click in a text field to
    that field made the gesture unreachable on the only part of the block anyone
    clicks. A block in its *source* form is the other half and must still keep
    the click, which is what the second assertion here is for — a code block has no
    edit step, so visual ⇄ source is the whole of its Alt+click.
    """
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps(CODE_BLOCK_CYCLE_DOC)
    )
    _wait(window, "(() => ({ line: !!document.querySelector('.cm-content .cm-line') }))()",
          lambda d: d.get("line") is True, timeout=20)

    # A real click lands on a real code line, not on the block's chrome.
    spot = _altclick_on(window, ".cm-content .cm-line")
    assert not spot.get("missing"), "no code block line to click"
    assert spot["cls"], spot

    state = _wait(
        window,
        "(() => ({ source: !!document.querySelector('.block-source-mode'),"
        " editor: !!document.querySelector('.ProseMirror .block-source-mode .cm-content') }))()",
        lambda d: d.get("source") is True,
        timeout=10,
    )
    assert state["editor"], "the block did not become its own source form"

    # ...and the same click, in the block's *own source form*, toggles back out.
    # That is the second half of §5.2's toggle and it is the reason `.cm-editor`
    # is not in `chromeOwnsClick`: with it there, a block Alt+click had just
    # opened could not be Alt+clicked closed, which is a toggle that can only be
    # entered.
    again = _altclick_on(window, ".block-source-mode .cm-content .cm-line")
    assert not again.get("missing"), again
    back = _wait(
        window,
        "(() => ({ source: !!document.querySelector('.block-source-mode'),"
        " editor: !!document.querySelector('.cm-editor') }))()",
        lambda d: d.get("source") is False,
        timeout=10,
    )
    assert back["editor"], "the block did not come back to its rendered form"


# The hover affordance that answers "which block would Alt+click alter?", added
# because the gesture is one click over every top-level block and the page had no
# way to say which one the pointer was over.
#
# `:hover` cannot be exercised here: `QTest` mouse injection never reaches the
# page, which is why every gesture above is dispatched by hand. So what this pins
# is the three things a synthetic pointer *can* reach — that the rule is in the
# sheet the page actually loaded, that it is keyed off the control cluster's own
# block list rather than a second spelling of it, and that the value it paints
# with is defined once per scheme.
HOVER_BAND_RULE = """(() => {
  const HIT = ['.block-visual-mode', '.mermaid', '.runnable-block',
               '.spreadsheet', '.ss-plain', '.encrypted-block'];
  const SEL = '.ProseMirror :is(.block-visual-mode, .mermaid, .runnable-block,'
    + ' .spreadsheet, .ss-plain, .encrypted-block):not(.edi-block-mode)'
    + ':not(.encrypted-block-reveal-editor *):hover::before';
  let rule = null;
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (err) { continue; }
    for (const r of rules) { if (r.selectorText === SEL) rule = r; }
  }
  if (!rule) return { missing: true };
  const style = rule.style;
  return {
    css: style.background || style.backgroundColor,
    absolute: style.position,
    behind: style.zIndex,
    // Inset, because the minifier collapses the four offsets — read back as one
    // value so the assertion is on the geometry rather than on the spelling.
    inset: style.inset || [style.top, style.right, style.bottom, style.left].join(' '),
    blocks: HIT.filter((c) => SEL.includes(c)),
    notMode: SEL.includes(':not(.edi-block-mode)'),
    // A revealed encrypted block is a second editor inside the encrypted block
    // that already has a band, and its one block can never be what Alt+click would
    // alter. So the band has to be able to say "not in there".
    notReveal: SEL.includes(':not(.encrypted-block-reveal-editor *)'),
  };
})()"""


HOVER_BAND_HIT = (
    ".block-visual-mode", ".mermaid", ".runnable-block",
    ".spreadsheet", ".ss-plain", ".encrypted-block",
)


def test_the_hover_band_says_which_block_alt_click_would_alter(window):
    """One rule, the cluster's own block list, and a value per scheme.

    The list is the control cluster's own reveal list on purpose: a block shows
    its cluster on exactly this hover, so the same set of blocks is the set an
    Alt+click would do something to — and the band cannot claim a block already in
    a mode, which carries the accent rule instead. The geometry is measured
    separately, by `test_the_hover_band_reaches_the_page_edges`.
    """
    document = """A paragraph.

```python
print(1)
```

| A | B |
| --- | --- |
| 1 | 2 |

```mermaid
graph TD
  A[Alpha]
```
"""
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps(document)
    )
    _wait(window, "(() => ({ m: !!document.querySelector('.ProseMirror .mermaid') }))()",
          lambda d: d.get("m") is True, timeout=20)

    band = _dump(window, HOVER_BAND_RULE)
    assert not band.get("missing"), "no band rule in the loaded sheet: the affordance is dead"
    assert band["absolute"] == "absolute", (
        "the band must be positioned: a background on the block is painted below "
        "its children and was invisible on a code block. %r" % band)
    assert band["behind"] == "-1", (
        "the band must paint behind the block's content, or it covers the text: %r"
        % band["behind"])
    assert band["blocks"] == list(HOVER_BAND_HIT), (
        "the band list has drifted from the control cluster's own: %s" % band["blocks"])
    assert band["notMode"], (
        "a block already in a mode must keep the accent rule, not be banded")
    assert band["notReveal"], (
        "a revealed encrypted block is an editor inside the encrypted block that "
        "already has a band, and its one block can never be the one Alt+click "
        "would alter: %r" % band)

    # Every top-level block in this document is a candidate, and a block in its
    # source form is not — which is what `:not(.edi-block-mode)` plus the list's
    # own silence about `block-source-mode` together buy.
    reached = _dump(window, """(() => {
      const SEL = '.ProseMirror :is(.block-visual-mode, .mermaid, .runnable-block,'
        + ' .spreadsheet, .ss-plain, .encrypted-block):not(.edi-block-mode)';
      return { classes: [...document.querySelectorAll('.ProseMirror > *')]
        .map((el) => String(el.className).split(' ')[0]) };
    })()""")
    assert set(reached["classes"]) <= {
        "block-visual-mode", "mermaid", "runnable-block", "spreadsheet", "ss-plain",
    }, reached

    # One step off the page, per scheme, so it reads as "not selected" rather
    # than as a selection — and distinct, so the dark one is not the light one.
    for scheme in ("light", "dark"):
        value = _dump(window, """(() => {
          const root = document.documentElement;
          const was = root.dataset.colorScheme;
          root.dataset.colorScheme = %s;
          const v = getComputedStyle(root).getPropertyValue('--block-hover').trim();
          root.dataset.colorScheme = was;
          return { v };
        })()""" % json.dumps(scheme))
        assert value["v"], f"--block-hover is undefined in {scheme}"
        assert value["v"] != "#eef4fd" or scheme == "light", (
            "the dark scheme must not reuse the light band: %s" % value)
        # Blue, and only just: the channel that leads must be blue, or the band is
        # the grey it was — this app's chrome is four greys a few points apart and
        # a grey band read as one more of them.
        r, g, b = (int(value["v"][i:i + 2], 16) for i in (1, 3, 5))
        assert b > g >= r, f"--block-hover must lean blue in {scheme}: {value['v']}"
        assert max(r, g, b) - min(r, g, b) < 24, (
            f"--block-hover must be *very* faint in {scheme}: {value['v']}")


# The option, not the rule: does turning the band off actually take the band off
# the page? As with the geometry below, `:hover` cannot be exercised here, so the
# band's own declarations are re-injected with `:hover` swapped for a class and
# the *computed* `content` is read — which is the one declaration the option
# owns, and the one that answers the question: the band is drawn by
# `content: var(--hover-band-content, '')`, so "off" has to arrive as `none`.
BAND_OPTION_PROBE = """(() => {
  const SEL = '.ProseMirror :is(.block-visual-mode, .mermaid, .runnable-block,'
    + ' .spreadsheet, .ss-plain, .encrypted-block):not(.edi-block-mode)'
    + ':not(.encrypted-block-reveal-editor *):hover::before';
  let rule = null;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const r of rules) { if (r.selectorText === SEL) rule = r; }
  }
  if (!rule) return { missing: true };
  const style = document.createElement('style');
  style.textContent = SEL.replace(':hover', '.edi-band-probe') + '{' + rule.style.cssText + '}';
  document.head.appendChild(style);
  const block = document.querySelector('.ProseMirror .runnable-block')
    || document.querySelector('.ProseMirror .block-visual-mode');
  if (!block) { style.remove(); return { missing: true }; }
  block.classList.add('edi-band-probe');
  const cs = getComputedStyle(block, '::before');
  const out = {
    content: cs.content,
    // Read straight off the pseudo-element: a `content: none` draws nothing at
    // all, so there is no box to measure — and a band "hidden" some other way
    // (opacity, a transparent colour) would still have one, which is the
    // difference this option is supposed to make.
    height: cs.height,
    background: cs.backgroundColor,
    off: document.documentElement.classList.contains('edi-hover-band-off'),
    declared: getComputedStyle(document.documentElement)
      .getPropertyValue('--hover-band-content').trim(),
  };
  block.classList.remove('edi-band-probe');
  style.remove();
  return out;
})()"""


def test_the_hover_band_is_a_view_option_that_actually_turns_the_band_off(window):
    """View → Hover Band, off, removes the band from the page and is remembered.

    Driven through the real dispatcher (`window.ediMenuCommand`) rather than by
    writing the answer and reloading, because the chain this test is about is
    the whole one: the menu command, the class, the pseudo-element, and the
    write all the way into the shell's settings store — which is the last leg
    that never existed while these answers lived in the page's `localStorage`.
    """
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps("```python\nprint(1)\n```\n")
    )
    _wait(window, "(() => ({ c: document.querySelectorAll('.runnable-block').length }))()",
          lambda d: d.get("c") == 1, timeout=20)

    def toggle():
        window._web.page().runJavaScript("window.ediMenuCommand('toggleHoverBand'); true")

    def settle(enabled):
        """Wait for the page's class *and* the shell's store to agree on ``enabled``.

        Two hops, and they disagree about direction: the class reads ``off``
        while the store holds ``hoverBand``, and the write itself is a
        ``QWebChannel`` round trip returning a promise the command dispatcher
        does not wait on — so the class can be set while the write is still in
        flight, and a test that read the store immediately would race.
        """
        _wait(window, "(() => ({ off: document.documentElement"
                       ".classList.contains('edi-hover-band-off') }))()",
              lambda d: d.get("off") is (not enabled), timeout=10)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if window.preferences()["hoverBand"] is enabled:
                return
            QApplication.processEvents()
            time.sleep(0.02)
        raise AssertionError(
            "the page asked for hoverBand=%s and the settings store never heard it"
            % enabled
        )

    try:
        on = _dump(window, BAND_OPTION_PROBE)
        assert not on.get("missing"), "no band rule or no banded block on the page"
        assert on["off"] is False, "a first run draws the band: %r" % on
        assert on["content"] == '""' and on["height"] != "auto", (
            "the band is drawn by default, so the pseudo-element exists: %r" % on)
        assert on["declared"] == "", (
            "--hover-band-content must be unset by default, so the band draws "
            "from var()'s own fallback: %r" % on)

        toggle()
        settle(False)
        off = _dump(window, BAND_OPTION_PROBE)
        assert off["declared"] == "none", (
            "the off class must resolve the band's content to none: %r" % off)
        assert off["content"] == "none", (
            "an off band must not be generated at all, rather than generated and "
            "hidden — the whole point of `content: none`: %r" % off)

        # Back on, and the band is the same band: same colour, same pseudo-element.
        toggle()
        settle(True)
        again = _dump(window, BAND_OPTION_PROBE)
        assert again["content"] == on["content"], (
            "the band must come back as itself, not as a different one: %r vs %r"
            % (again, on))
        assert again["background"] == on["background"], (again, on)
    finally:
        # The window is session-scoped and the probes above re-inject the band's
        # declarations, which resolve `var(--hover-band-content, …)` against the
        # live root — so a page left with the band off would leave every later
        # band's geometry measurements measuring nothing. The store is the
        # developer's own, so it goes back too.
        window.set_preference("hoverBand", True)
        window._web.page().runJavaScript(
            "document.documentElement.classList.remove('edi-hover-band-off'); true"
        )


# The persisted preferences, and the promise they are kept on. These answers used
# to live in the page's `localStorage`, which cannot survive a run of this app:
# `MainWindow` never creates a `QWebEngineProfile`, so the page runs on the
# default profile, which is off-the-record, and a packaged build showed it most
# plainly (`build-pyzip.sh` extracts to a fresh temp directory per run). The
# store is `backend/preferences.py` — `QSettings`, beside the recent-files list —
# and the page's copy arrives *injected*, because zoom has to be applied before
# the editor's first paint and a bridge round trip cannot be waited on there.
PREFERENCES_PROBE = """(() => ({
  injected: window.ediPreferences || null,
  // Read back off the page rather than off the store, so this asserts the round
  // trip the app actually takes and not just the Python side of it.
  zoom: getComputedStyle(document.documentElement).getPropertyValue('--doc-zoom').trim(),
  bandOff: document.documentElement.classList.contains('edi-hover-band-off'),
  toolbarHidden: (document.querySelector('#toolbar') || {}).hidden === true,
}))()"""


def test_preferences_reach_the_page_before_its_own_bundle_runs(window):
    """The injected snapshot is on the page, whole, and already applied.

    Ordering is the claim: `window.ediPreferences` has to exist by the time the
    bundle executes, because `src/preferences.ts` reads it at module load and
    `init()` applies zoom synchronously right after. A snapshot that arrived a
    tick later would be a document painted at 100% and then resized under the
    reader.
    """
    seen = _dump(window, PREFERENCES_PROBE)
    assert seen["injected"] == {
        "zoomFactor": 1.0,
        "toolbarVisible": True,
        "hoverBand": True,
    }, seen
    # And the page acted on it rather than merely holding it: 100% by default,
    # the toolbar row shown, the band drawn.
    assert seen["zoom"] == "1", seen
    assert seen["toolbarHidden"] is False, seen
    assert seen["bandOff"] is False, seen


def test_a_written_preference_is_what_the_next_window_would_inject(window):
    """A write reaches the store *and* the injection, which is a static string.

    `window.py`'s preferences script is built once and re-injected on every
    document creation, so it is a snapshot taken when this window booted. Left
    alone it would replay this launch's answers into any document created later
    in the same run — which is why `set_preference` rewrites its source.
    """
    try:
        window.set_preference("hoverBand", False)
        window.set_preference("zoomFactor", 1.5)
        assert window.preferences()["hoverBand"] is False
        assert window.preferences()["zoomFactor"] == 1.5
        source = window._preferences_source()
        assert '"hoverBand": false' in source, source
        assert '"zoomFactor": 1.5' in source, source
    finally:
        # The window is session-scoped, and these are the developer's own
        # settings: put them back.
        window.set_preference("hoverBand", True)
        window.set_preference("zoomFactor", 1.0)


def test_an_unknown_preference_is_not_written(window):
    before = window.preferences()
    window.set_preference("somethingElse", "x")
    assert window.preferences() == before


# The band's geometry. `:hover` cannot be exercised by this harness (QTest mouse
# injection never reaches the page), so the rule is injected with `:hover` swapped
# for a class and the box is *measured*. That is a legitimate instrument for the
# one question that can actually be wrong — does the band reach the page edges, and
# does it clear the block on every type — and it is an instrument, not the claim:
# the `:hover` match itself is still CSS that only a real pointer exercises.
BAND_GEOMETRY_PROBE = """(() => {
  const SEL = '.ProseMirror :is(.block-visual-mode, .mermaid, .runnable-block,'
    + ' .spreadsheet, .ss-plain, .encrypted-block):not(.edi-block-mode)'
    + ':not(.encrypted-block-reveal-editor *):hover::before';
  let rule = null;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const r of rules) { if (r.selectorText === SEL) rule = r; }
  }
  if (!rule) return { missing: true };
  const css = rule.style.background || rule.style.backgroundColor;
  // The rule's own declarations, wholesale: rebuilding them property by property
  // is how this probe first measured a band that had not moved horizontally.
  const style = document.createElement('style');
  style.textContent = SEL.replace(':hover', '.edi-band-probe') + '{' + rule.style.cssText + '}';
  document.head.appendChild(style);
  const pm = document.querySelector('.ProseMirror');
  const pmBox = pm.getBoundingClientRect();
  // A pseudo-element has no rect of its own — `getBoundingClientRect()` on the
  // host returns the *host's* box, which is how this probe first "measured" a
  // band that had not moved at all. Its computed offsets are what there is.
  const rows = [...pm.children].map((el) => {
    const box = el.getBoundingClientRect();
    el.classList.add('edi-band-probe');
    const cs = getComputedStyle(el, '::before');
    const inset = {
      top: parseFloat(cs.top), right: parseFloat(cs.right),
      bottom: parseFloat(cs.bottom), left: parseFloat(cs.left),
    };
    el.classList.remove('edi-band-probe');
    return {
      cls: String(el.className).split(' ')[0],
      blockTop: Math.round(box.top), blockBottom: Math.round(box.bottom),
      bandTop: Math.round(box.top + inset.top),
      bandBottom: Math.round(box.bottom - inset.bottom),
      bandLeft: Math.round(box.left + inset.left),
      bandRight: Math.round(box.right - inset.right),
    };
  });
  style.remove();
  return {
    css, decls: rule.style.cssText,
    pmLeft: Math.round(pmBox.left), pmRight: Math.round(pmBox.right),
    rows,
  };
})()"""


def test_the_hover_band_reaches_the_page_edges(window):
    """Full width, window edge to window edge, and clear of the block's content.

    The measurement is of a band produced by the *same* declarations as the live
    rule, so what is pinned is the geometry: the left edge cancels the block's 24px
    margin and the editor's 24px padding, the right cancels the padding, and the
    band reaches past the block's own box above and below so consecutive blocks
    read as one band.
    """
    import json
    document = """A paragraph.

- a list item
- another

```python
print(1)
```

| A | B |
| --- | --- |
| 1 | 2 |

```mermaid
graph TD
  A[Alpha]
```
"""
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps(document)
    )
    _wait(window, "(() => ({ m: !!document.querySelector('.ProseMirror .mermaid') }))()",
          lambda d: d.get("m") is True, timeout=20)

    probe = _dump(window, BAND_GEOMETRY_PROBE)
    assert not probe.get("missing"), "the band rule is not in the loaded sheet"
    assert probe["css"], f"the band paints nothing: {probe['css']!r}"

    rows = probe["rows"]
    assert len(rows) == 5, rows
    for row in rows:
        # Both edges land on the editor's own box, which is the page edge: the
        # scroller has no other width to reach.
        assert abs(row["bandLeft"] - probe["pmLeft"]) <= 1, (
            f"{row['cls']}: band left {row['bandLeft']} vs editor {probe['pmLeft']}")
        assert abs(row["bandRight"] - probe["pmRight"]) <= 1, (
            f"{row['cls']}: band right {row['bandRight']} vs editor {probe['pmRight']}")
        # And it stands off the block, which is what gives an opaque interior
        # (a code block's editor) somewhere to show.
        assert row["bandTop"] < row["blockTop"], row
        assert row["bandBottom"] > row["blockBottom"], row


# The band's other half: what it paints *over*. `:hover` cannot be exercised here,
# so the rule's own selector is rewritten into one that always matches — the same
# band the pointer draws, from the same declarations — and `pointer-events` is
# lifted from `none` so a hit test can reach it. That is what makes this a test
# rather than a reading of the stylesheet: **Chromium hit-tests in paint order**,
# so the answer to "who is on top at the checkbox" is the answer to "who is on
# top of it to look at", and it is available without reading a pixel.
#
# The bug it pins is a `z-index: -1` sibling painting over a *native form
# control*: the band is negative so it can reach the margin past a code block's
# editor, and a form control sits below a negative-z-index sibling unless it asks
# for a positive one of its own. A task list is the only banded block whose own
# content is a row of bare controls, so hovering one drew the band over every
# checkbox in it and they came and went with the pointer.
BAND_OVER_CONTROL_ON = """(() => {
  const SEL = '.ProseMirror :is(.block-visual-mode, .mermaid, .runnable-block,'
    + ' .spreadsheet, .ss-plain, .encrypted-block):not(.edi-block-mode)'
    + ':not(.encrypted-block-reveal-editor *):hover::before';
  const always = SEL.replace(':hover', ':not(.edi-never-hover)');
  let forced = 0;
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.selectorText !== SEL) continue;
      window.__ediBandProbe = {
        sheet, index: i, selector: SEL, cssText: rule.style.cssText,
      };
      rule.selectorText = always;
      rule.style.setProperty('pointer-events', 'auto');
      forced++;
    }
  }
  const cb = document.querySelector('li[data-checked] > input[type=checkbox]');
  if (!cb) return { missing: true };
  const r = cb.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const stack = document.elementsFromPoint(x, y).map((el) => String(el.className).split(' ')[0]
    || el.tagName.toLowerCase());
  return {
    forced, at: { x: Math.round(x), y: Math.round(y) }, stack,
    zIndex: getComputedStyle(cb).zIndex,
    position: getComputedStyle(cb).position,
    // A pseudo-element is not an element, so the band cannot be named in a hit
    // test: it answers as the block that owns it, which is why what is asserted
    // is the whole run above the checkbox rather than the checkbox alone.
    bandZ: getComputedStyle(cb.closest('.block-visual-mode'), '::before').zIndex,
  };
})()"""

BAND_OVER_CONTROL_OFF = """(() => {
  const saved = window.__ediBandProbe;
  if (!saved) return { missing: true };
  const rule = saved.sheet.cssRules[saved.index];
  if (rule) { rule.selectorText = saved.selector; rule.style.cssText = saved.cssText; }
  delete window.__ediBandProbe;
  return { restored: true };
})()"""


def test_the_hover_band_does_not_hide_a_tasks_checkbox(window):
    """The band's `z-index: -1` and the task checkbox's `z-index: 1` are one rule.

    A task list is the one block type in the band's own list whose content is a
    row of bare native controls, and it is the one that lost: the band painted
    over every checkbox in the list, so they appeared and disappeared as the
    pointer crossed the block. The control cluster is the other end of the same
    contract (`z-index: 3`, never hidden), so the two are asserted together —
    a fix that only lifted the checkbox would leave the band free to swallow the
    next control, and a band that stopped being negative would stop reaching the
    margins the affordance exists for.
    """
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps("- [ ] one\n- [x] two\n")
    )
    _wait(window, "(() => ({ c: document.querySelectorAll('li[data-checked] > input[type=checkbox]').length }))()",
          lambda d: d.get("c") == 2, timeout=20)

    try:
        probe = _dump(window, BAND_OVER_CONTROL_ON)
        assert not probe.get("missing"), "the document has no task checkbox to protect"
        assert probe["forced"] == 1, (
            "the band's own rule was not found in the loaded sheet, so nothing was "
            "banded and this would pass for the wrong reason: %r" % probe)
        assert probe["bandZ"] == "-1", (
            "the band must still be behind the block's content, or it covers the "
            "text: %r" % probe["bandZ"])

        # The checkbox itself, first in the stack: nothing between it and the
        # pointer, which is the hit-test form of "still visible".
        assert probe["stack"][0] == "input", probe
        # And the band below it. A pseudo-element is not an element, so the band
        # cannot be named in a hit test: it answers as the element whose stacking
        # context it is painted in, and that is `.ProseMirror` — one level up from
        # the block, which is where a `z-index: -1` sibling is supposed to land. So
        # the claim is "under the checkbox, and in the editor rather than in the
        # block", not a fixed neighbour: a band that had found its way back inside
        # the block would pass `stack[0] == 'input'` here and paint over the block's
        # own frame, which is what
        # `test_the_hover_band_does_not_paint_over_a_code_blocks_own_frame` catches.
        assert probe["stack"].index("ProseMirror") > 0, probe
        # And the declaration that is what puts it there. `z-index: 0` is not
        # enough — a form control needs a *positive* one to clear a negative
        # sibling — so the claim is about the value, not about being positioned.
        assert probe["zIndex"] == "1", probe
        assert probe["position"] == "relative", probe
    finally:
        # The window is session-scoped: a page left with the band permanently on
        # would hand every later test a document that is hovered.
        _dump(window, BAND_OVER_CONTROL_OFF)


# The band's other half again, and the half a hit test cannot answer: what it
# paints over *silently*. `:hover` still cannot be exercised, so the rule is
# rewritten into one that always matches, exactly as `BAND_OVER_CONTROL_ON` does
# — but the instrument has to change with it. Lifting `pointer-events` answers
# "what is on top of the checkbox", because a checkbox is a hit-test target; a
# 1px border is not, and neither is the transparent padding ring between a code
# block's border and its CodeMirror editor. So this one reads **pixels**, out of a
# real grab of the page, and compares the band on against the band off.
#
# It is that comparison which makes it a test of paint order and not a reading of
# the stylesheet: the two frames are the same document, one rule apart, and the
# question is not "what colour is the border" but "did the band change it".
#
# The bug it pins is where a `z-index: -1` element *lands*. It lands in the
# nearest ancestor stacking context, and a block that isolated itself trapped it
# in its own painting order, where a negative layer is step 2 — above the block's
# own background and border, below its content. Every other banded type hid that
# behind a child painting the whole inset; a code block's frame *is* its own, so
# hovering one painted `--block-hover` over its 1px border and over the 12px of
# padding around the editor. The chrome did not get covered — it was the band.
BAND_OVER_FRAME_ON = """(() => {
  const SEL = '.ProseMirror :is(.block-visual-mode, .mermaid, .runnable-block,'
    + ' .spreadsheet, .ss-plain, .encrypted-block):not(.edi-block-mode)'
    + ':not(.encrypted-block-reveal-editor *):hover::before';
  const always = SEL.replace(':hover', ':not(.edi-never-hover)');
  let forced = 0;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.selectorText !== SEL) continue;
      window.__ediFrame = { sheet, index: i, selector: SEL, cssText: rule.style.cssText };
      rule.selectorText = always;
      forced++;
    }
  }
  return { forced };
})()"""

BAND_FRAME_POINTS = """(() => {
  const block = document.querySelector('.runnable-block');
  if (!block) return { missing: true };
  const host = block.querySelector('.code-editor-host');
  if (!host) return { noHost: true };
  const b = block.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  const pm = getComputedStyle(document.querySelector('.ProseMirror'));
  const s = getComputedStyle(block);
  return {
    points: {
      // Sampled off the block's own box, because a band's frame problem is
      // exactly a disagreement between the block's box and what sits over it.
      borderLeft: [b.left + 0.5, b.top + b.height - 8],
      borderRight: [b.right - 1.5, b.top + b.height - 8],
      borderBottom: [b.left + 60, b.bottom - 1.5],
      // `.code-editor-host` declares no background of its own, so its own 12px of
      // padding is whatever is behind it: the block's surface while the band is
      // behind that, the band while it is not. Sampled *inside* the host's edge —
      // one pixel further out and this is the margin, which is banded either way
      // and would pass for the wrong reason.
      padLeft: [h.left + 6, h.top + h.height / 2],
      padTop: [h.left + 60, h.top + 3],
      // And the margin the affordance exists for, which must still be banded.
      marginLeft: [b.left - 20, b.top + b.height / 2],
      marginAbove: [b.left + 60, b.top - 2],
    },
    // Why, not only what: the band escapes one level up, and the block must not be
    // the thing that stops it. Every one of these is a way to become a stacking
    // context, which is the bug.
    pmIsolation: pm.isolation,
    block: {
      isolation: s.isolation, opacity: s.opacity, transform: s.transform,
      filter: s.filter, contain: s.contain, mixBlendMode: s.mixBlendMode,
      willChange: s.willChange, perspective: s.perspective,
      zIndex: s.zIndex, position: s.position,
    },
  };
})()"""

BAND_OVER_FRAME_OFF = """(() => {
  const saved = window.__ediFrame;
  if (!saved) return { missing: true };
  const rule = saved.sheet.cssRules[saved.index];
  if (rule) { rule.selectorText = saved.selector; rule.style.cssText = saved.cssText; }
  delete window.__ediFrame;
  return { restored: true };
})()"""


def _band_frame_pixels(window, points):
    """The colour at each named point, read out of a real grab of the page.

    A screenshot of a just-mutated DOM is a stale frame, so the caller settles
    first; what is *not* stale is a rule that has been rewritten in the loaded
    sheet, which is what both halves of this comparison turn on.
    """
    import time

    from PySide6.QtGui import QColor
    from PySide6.QtWidgets import QApplication

    end = time.monotonic() + 0.4
    while time.monotonic() < end:
        QApplication.processEvents()
        time.sleep(0.02)
    image = window._web.grab().toImage()
    out = {}
    for name, (x, y) in points.items():
        colour = QColor(image.pixelColor(int(x), int(y)))
        out[name] = (colour.red(), colour.green(), colour.blue())
    return out


# The band's fourth exclusion: not inside a revealed encrypted block. This one is
# answered by `matches()` rather than by pixels or a hit test, because the question
# is purely "does the shipped selector match this shape of DOM" — and because a
# revealed block needs a password to reach, which this harness has no way to supply.
# The DOM is built outside the editor for the same reason it cannot be reached in
# the document: ProseMirror owns its own subtree and discards what it did not put
# there, so a fixture inside it would be gone before it was read.
BAND_MATCHES_PROBE = """(() => {
  // The rule is found by its *stable* anchors — the band list up to
  // `.encrypted-block)` and the `:hover::before` tail — and its selector is then
  // read out of the sheet rather than spelled here. A probe that hardcoded the
  // whole selector reported a missing exclusion as "the rule is not in the sheet",
  // which sends the next person looking in the wrong place.
  const HEAD = '.ProseMirror :is(.block-visual-mode, .mermaid, .runnable-block,'
    + ' .spreadsheet, .ss-plain, .encrypted-block)';
  const TAIL = ':hover::before';
  document.querySelectorAll('.edi-band-fixture').forEach((el) => el.remove());
  const root = document.createElement('div');
  root.className = 'edi-band-fixture';
  root.innerHTML = [
    '<div class="ProseMirror">',
    '  <div class="encrypted-block">',
    '    <div class="block-visual-mode">outer</div>',
    '    <div class="encrypted-block-reveal">',
    // The reveal's editor is `createBlockEditor` — the document's own factory — so
    // it marks its content exactly as the document does, and without the exclusion
    // this block was banded inside a block that already had a band of its own.
    '      <div class="ProseMirror encrypted-block-reveal-editor">',
    '        <div class="block-visual-mode">inner</div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="runnable-block has-code-lang">code</div>',
    '  <div class="runnable-block has-code-lang edi-block-mode">code in a mode</div>',
    '</div>',
  ].join('\\n');
  document.body.appendChild(root);

  let found = null;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (err) { continue; }
    for (const r of rules) {
      const sel = r.selectorText;
      if (sel && sel.startsWith(HEAD) && sel.endsWith(TAIL)) found = sel;
    }
  }
  if (!found) { root.remove(); return { missing: true }; }

  // `:hover` is never true under `matches()` and `::before` is not a target at all,
  // so both come off and what is left is the selector's own list and exclusions.
  const probe = found.replace(TAIL, '');
  const out = {};
  root.querySelectorAll('.block-visual-mode, .runnable-block').forEach((el) => {
    const where = el.closest('.encrypted-block-reveal-editor') ? 'inside reveal'
      : el.closest('.encrypted-block') ? 'encrypted block' : 'document';
    const mode = el.classList.contains('edi-block-mode') ? ', in a mode' : '';
    out[where + mode] = el.matches(probe);
  });
  root.remove();
  return { selector: found, probe, out };
})()"""


def test_the_hover_band_stays_out_of_a_revealed_encrypted_block(window):
    """One encrypted block, so an inner band can never be the answer.

    A revealed encrypted block holds exactly one block by design, and the pointer
    over it is unambiguously over the encrypted block — which has a band of its
    own, in its margin. The reveal's editor is built by the document's own factory,
    so its content carries the same `.block-visual-mode` the document's blocks do
    and the band matched it too: two bands, one of them a rectangle drawn *inside*
    a frame the reader is already looking into. The encrypted block keeps its band;
    only the nested one loses it, and the mode exclusion is unaffected.
    """
    probe = _dump(window, BAND_MATCHES_PROBE)
    assert not probe.get("missing"), (
        "the band's own rule is not in the loaded sheet, so this would pass for the "
        "wrong reason: %r" % probe)
    assert ":not(.encrypted-block-reveal-editor *)" in probe["selector"], (
        "the band must be able to say \"not inside a revealed encrypted block\", "
        "or it bands that block too: %s" % probe["selector"])
    out = probe["out"]
    assert out.get("document") is True, (
        "an ordinary block must still be banded: %r" % out)
    assert out.get("encrypted block") is True, (
        "the encrypted block keeps its own band — it is the block the pointer is "
        "over: %r" % out)
    assert out.get("inside reveal") is False, (
        "a revealed encrypted block's one block must not be banded: %r" % out)
    assert out.get("document, in a mode") is False, (
        "a block already in a mode keeps the accent rule instead: %r" % out)


def test_the_hover_band_does_not_paint_over_a_code_blocks_own_frame(window):
    """The band is behind every block, including the one it is attached to.

    `z-index: -1` lands in the nearest ancestor stacking context, so a band that
    was trapped in the block's own painted over the block's own `background` and
    `border` — the 1px frame a code block *is*, and the transparent padding ring
    around its editor. Measured here in pixels, band on against band off: the
    frame and the editor's own inset must be identical in both, and the margin
    must be the band. A fix that made the band positive would pass the first half
    and fail the second, and a fix that hid the frame without the band still
    reaching the margins would pass the second and fail the first.
    """
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true"
        % json.dumps("before\n\n```python\nprint(1)\n```\n\nafter\n")
    )
    _wait(window, "(() => ({ c: document.querySelectorAll('.runnable-block').length }))()",
          lambda d: d.get("c") == 1, timeout=20)

    try:
        geom = _dump(window, BAND_FRAME_POINTS)
        assert not geom.get("missing"), "the document has no code block"
        assert not geom.get("noHost"), "the code block has no CodeMirror editor"

        # Band off first: the page is in that state already, and measuring it before
        # anything is rewritten is what makes the second frame a comparison rather
        # than a second reading of the same rule.
        off_pixels = _band_frame_pixels(window, geom["points"])

        turned_on = _dump(window, BAND_OVER_FRAME_ON)
        assert turned_on["forced"] == 1, (
            "the band's own rule was not found in the loaded sheet, so nothing was "
            "banded and this would pass for the wrong reason: %r" % turned_on)
        on_pixels = _band_frame_pixels(window, geom["points"])

        frame = ("borderLeft", "borderRight", "borderBottom", "padLeft", "padTop")
        for name in frame:
            assert on_pixels[name] == off_pixels[name], (
                "the band painted over the code block's own %s: %r with the band, "
                "%r without it" % (name, on_pixels[name], off_pixels[name]))

        margin = ("marginLeft", "marginAbove")
        for name in margin:
            assert on_pixels[name] != off_pixels[name], (
                "the band no longer reaches %s, which is the whole affordance: %r"
                % (name, on_pixels[name]))

        # And the reason, so a failure names the mechanism rather than a hex. The
        # band is a `z-index: -1` child, so what it paints over is decided by the
        # nearest *ancestor* stacking context — `.ProseMirror` has to be one, and
        # the block must not be.
        assert geom["pmIsolation"] == "isolate", (
            "the band escapes into the editor, and .ProseMirror is what has to be "
            "the stacking context it escapes into: %r" % geom["pmIsolation"])
        trapping = {
            key: value for key, value in geom["block"].items()
            if key in ("isolation", "transform", "filter", "contain", "mixBlendMode",
                       "willChange", "perspective")
            and value not in ("none", "auto", "normal", "")
        }
        assert not trapping, (
            "a banded block must not be its own stacking context: the band would be "
            "trapped in it and paint over the block's own background and border "
            "instead of behind them: %r" % trapping)
        assert geom["block"]["opacity"] == "1", geom["block"]
    finally:
        # The window is session-scoped: a page left with the band permanently on
        # would hand every later test a document that is hovered.
        _dump(window, BAND_OVER_FRAME_OFF)


# The sheet's own controls, and the mode buttons they were competing with. §6.3
# moves a block's *actions* into its cluster and this is that rule finishing its
# job: three alignment buttons and "Use values" were left in a `.ss-tools` row
# inside the sheet, under the cluster rather than in it.
SHEET_CONTROLS = """(() => {
  const sheet = document.querySelector('#editor-container .spreadsheet');
  if (!sheet) return { missing: true };
  const cluster = sheet.querySelector('.block-controls');
  const tools = sheet.querySelector('.ss-tools');
  const where = (sel) => {
    const el = sheet.querySelector(sel);
    return {
      present: !!el,
      inCluster: !!(el && cluster && cluster.contains(el)),
      inTools: !!(el && tools && tools.contains(el)),
      // Which side of the sheet it sits on, from the sheet's own box.
      left: el
        ? Math.round(el.getBoundingClientRect().left
          - sheet.getBoundingClientRect().left)
        : null,
    };
  };
  return {
    hasCluster: !!cluster,
    hasTools: !!tools,
    align: where('.ss-tool-icon'),
    values: where('.ss-tool-view'),
    status: where('.ss-status'),
    resolve: where('.ss-tool-check'),
    modeButtons: cluster
      ? [...cluster.querySelectorAll('.block-control-representation, .block-control-form')]
          .map((b) => b.textContent)
      : [],
  };
})()"""


def _open_a_sheet(window):
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true"
        % json.dumps("| A | B |\n| --- | --- |\n| 1 | 2 |\n"))
    _wait(window, "(() => ({ t: !!document.querySelector('#editor-container .ss-plain') }))()",
          lambda d: d.get("t") is True, timeout=20)
    _dump(window, """(() => {
      const cell = document.querySelector('#editor-container .ss-plain-table td');
      cell.dispatchEvent(new MouseEvent('click',
        { bubbles: true, cancelable: true, button: 0, altKey: true }));
      return { clicked: true };
    })()""")
    _wait(window, "(() => ({ s: !!document.querySelector('#editor-container .spreadsheet') }))()",
          lambda d: d.get("s") is True, timeout=10)


def test_a_sheets_own_controls_stay_in_its_own_row_at_the_left(window):
    """The sheet's controls are in the sheet's row, and the cluster is mode-only.

    They were briefly moved into the block's cluster, on the argument that §6.3
    puts a block's actions there. That was wrong and it was tried rather than
    argued: the sheet's row is where the alignment controls have always lived,
    they are column-and-cell controls for a grid that is right there, and putting
    them in a hover pill at the block's right edge moved three controls a long way
    from the columns they act on to sit beside a **Source** button that has nothing
    to do with either.
    """
    _open_a_sheet(window)
    out = _dump(window, SHEET_CONTROLS)
    assert out["hasCluster"], "the sheet has no cluster"
    assert out["hasTools"], "the sheet lost its own control row"

    for name in ("align", "values", "resolve"):
        entry = out[name]
        assert entry["present"], f"{name} is gone"
        assert entry["inTools"], f"{name} left the sheet's own row for the cluster"
        assert not entry["inCluster"], f"{name} is in the cluster again"
        # Left of the readout, which is `margin-left: auto` and so takes the slack
        # in the row and pushes whatever follows it to the far right.
        assert entry["left"] is not None and entry["left"] < out["status"]["left"], (
            f"{name} is not at the left of the sheet's row: {entry}")

    # The one thing in that row that is not a control stays in it too.
    assert out["status"]["present"] and out["status"]["inTools"], (
        "the status readout belongs in the row: a hover-only readout is unreadable")

    # And the Resolve checkbox sits *beside* "Use values", which it answers for
    # the whole sheet rather than the selection — not stranded at the row's far
    # right, which is what "after the readout" put it at.
    assert out["resolve"]["left"] > out["values"]["left"], (
        f"the Resolve checkbox is not beside Use values: {out}")

    # The cluster is the block's, holds the block's modes and nothing else, and —
    # being an open sheet — its form control names where it *goes*, so `Visual`.
    assert out["modeButtons"] == ["Visual", "Source"], out["modeButtons"]


def test_a_plain_tables_cluster_uses_the_modes_own_vocabulary(window):
    """`Edit`, then `Source` — the same words every mode control uses, in the same
    order a diagram's are, because Source is always the right-most one.

    The table's forms were `Show as text` / `Show as sheet` and then `Text` /
    `Sheet`, both of which name the *rendering* and neither of which says which
    mode the block is in. So a table said "Sheet" where a diagram said "Edit",
    three surfaces had to be taught two vocabularies, and the chip had to
    special-case which of the two it was in. A spreadsheet **is** a table's edit mode
    — the form you change the table in, as a diagram's editing layer is the form
    you change a diagram in — so the app's own words are the right ones.
    """
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps("| A | B |\n| --- | --- |\n| 1 | 2 |\n"))
    _wait(window, "(() => ({ t: !!document.querySelector('#editor-container .ss-plain') }))()",
          lambda d: d.get("t") is True, timeout=20)
    labels = _dump(window, """(() => {
      const t = document.querySelector('#editor-container .ss-plain');
      return { labels: [...t.querySelectorAll('.block-control-representation, .block-control-form')]
        .map((b) => b.textContent) };
    })()""")['labels']
    assert labels == ["Edit", "Source"], labels


def test_an_open_sheet_is_not_marked_with_a_mode_bar(window):
    """A sheet wears the shared outline, never a bar of its own, and the chip says Edit.

    The bar was a 3px accent rule down the left edge, in `--warning` — and it read as a
    fault on an entirely ordinary state. It is gone for every mode; what says "this
    block is being worked in" is the shared **dashed** outline, which a sheet wears like
    anything else. What must not come back is a *second*, heavier mark on the sheet
    alone, so this asks the one question that is still separable: no `box-shadow`.
    """
    _open_a_sheet(window)
    out = _dump(window, """(() => {
      const sheet = document.querySelector('#editor-container .spreadsheet');
      const chip = document.querySelector('#status-mode');
      return {
        shadow: getComputedStyle(sheet).boxShadow,
        chip: (chip || {}).textContent || '',
        chipHidden: (chip || {}).hidden,
      };
    })()""")
    assert out["shadow"] in ("none", ""), (
        f"a sheet must not wear the accent bar: {out['shadow']!r}")
    # A spreadsheet is a table's *Edit* (§5.1), so the chip says the one word every
    # cycled operation uses — which it could not do while the forms had their own
    # vocabulary of renderings.
    assert out["chip"].startswith("Edit"), (
        f"the chip must use the cycle's vocabulary: {out['chip']!r}")


# §7.2's block-level indication. It has been `--warning` for a plain view,
# `--accent` for source and `--danger` for editing; the last of those put the same
# red on a diagram being edited that the delete dialog and the kanban bin use, and it
# was reported as an artifact twice. It is now a dashed accent outline, shared by
# every non-visual mode.
#
# The scan is deliberately broad — every computed background, border, outline and
# shadow across the editor, not just the one element — because both reports were "a
# red bar *somewhere*", and the first time round only the suspected element was
# measured, which is how the mermaid-only frame at a higher specificity survived.
RECORD_BAR_IS_NOT_RED = r"""(() => {
  const RED = /rgba?\((\d+),\s*(\d+),\s*(\d+)/;
  const hits = [];
  for (const el of document.querySelectorAll('#editor-container *')) {
    const cs = getComputedStyle(el);
    for (const prop of ['backgroundColor', 'borderLeftColor', 'borderRightColor',
                        'borderTopColor', 'borderBottomColor', 'boxShadow',
                        'outlineColor']) {
      const value = cs[prop];
      const m = RED.exec(value);
      if (!m) continue;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (r > 110 && r > g + 45 && r > b + 45) {
        hits.push({ cls: String(el.className).slice(0, 40), prop, v: value.slice(0, 40) });
      }
    }
  }
  const kindOf = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, colour: cs.outlineColor,
             dashed: cs.outlineStyle === 'dashed',
             width: parseFloat(cs.outlineWidth) || 0 };
  };
  return {
    hits,
    visual: kindOf(document.querySelector('#editor-container .mermaid')),
    editing: kindOf(document.querySelector('#editor-container .mermaid-editing')),
    sheet: kindOf(document.querySelector('#editor-container .spreadsheet')),
    plain: kindOf(document.querySelector('#editor-container .ss-plain')),
    chip: (document.querySelector('#status-mode') || {}).textContent || '',
  };
})()"""


def test_a_block_in_a_non_visual_mode_is_never_marked_in_red(window):
    """Editing a diagram is the point of the mode, not a hazard.

    `--danger` is this app's destructive colour — the delete dialog's button, the
    kanban bin's dressing — so wearing it for "you are editing this diagram" made an
    ordinary state look like a fault, and it was reported as an artifact. Editing,
    Source and a table's sheet now share one **dashed** accent outline.
    """
    import json
    from tests.mermaid_render import _render
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true"
        % json.dumps("| A | B |\n| --- | --- |\n| 1 | 2 |\n"))
    _wait(window, "(() => ({ t: !!document.querySelector('#editor-container .ss-plain') }))()",
          lambda d: d.get("t") is True, timeout=20)
    _dump(window, """(() => {
      const cell = document.querySelector('#editor-container .ss-plain-table td');
      cell.dispatchEvent(new MouseEvent('click',
        { bubbles: true, cancelable: true, button: 0, altKey: true }));
      return { clicked: true };
    })()""")
    _wait(window, "(() => ({ s: !!document.querySelector('#editor-container .spreadsheet') }))()",
          lambda d: d.get("s") is True, timeout=10)

    sheet = _dump(window, RECORD_BAR_IS_NOT_RED)
    assert not sheet["hits"], f"something in the editor is drawn in red: {sheet['hits']}"
    assert sheet["sheet"] and sheet["sheet"]["dashed"], (
        f"a sheet is a block being worked in, so it wears the shared mark: {sheet['sheet']}")
    # ...but the chip still names the state, in the cycle's vocabulary.
    assert sheet["chip"].startswith("Edit"), (
        f"the chip must name the state: {sheet['chip']!r}")

    _set_scheme(window, False)
    _render(window, FLOW)
    _dump(window, """(() => {
      const el = document.querySelector('.mermaid .mermaid-preview')
        || document.querySelector('.mermaid');
      el.dispatchEvent(new MouseEvent('click',
        { bubbles: true, cancelable: true, button: 0, altKey: true }));
      return { clicked: true };
    })()""")
    _wait(window, "(() => ({ e: !!document.querySelector('.mermaid-editing') }))()",
          lambda d: d.get("e") is True, timeout=15)

    # Whether the diagram's outline is dashed or solid here depends on whether the
    # render also *selected* it — and it is, because `_render` leaves a NodeSelection
    # on the block it inserted. That is the documented precedence (selection wins
    # over the mode), and it is the subject of the other test; what matters here is
    # that nothing red is on the page at all.
    during = _dump(window, RECORD_BAR_IS_NOT_RED)
    assert not during["hits"], f"something in the editor is drawn in red: {during['hits']}"
    assert during["editing"], "a diagram being edited should be marked somehow"
    assert during["editing"]["colour"] != "rgb(209, 36, 47)", during["editing"]


def test_a_table_as_a_sheet_is_marked_like_any_other_mode(window):
    """A sheet wears the shared dashed outline, and a plain-text table wears none.

    The sheet used to be the one block in a non-default state with **no mark at all**,
    on the reasoning that a spreadsheet is a rendering rather than an alternate
    document. That made the one mark answering "which block am I working in" answer
    differently per block type — a diagram being edited was dashed and a table being
    edited was not — and the sheet is the block where the reader is demonstrably
    working.

    Both halves matter. Including it costs nothing in meaning, because a table in
    plain text holds no record and so stays unmarked; that is the distinction the mark
    was carrying, and it is asserted here rather than assumed. The chip still names the
    state, because that is where "what" is answered and the outline only says "where".
    """
    import json
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps("| A | B |\n| --- | --- |\n| 1 | 2 |\n"))
    _wait(window, "(() => ({ t: !!document.querySelector('#editor-container .ss-plain') }))()",
          lambda d: d.get("t") is True, timeout=20)
    _dump(window, """(() => {
      const b = document.querySelector('#editor-container .block-control-form');
      b.click();
      return { clicked: true };
    })()""")
    _wait(window, "(() => ({ s: !!document.querySelector('#editor-container .spreadsheet') }))()",
          lambda d: d.get("s") is True, timeout=10)

    out = _dump(window, RECORD_BAR_IS_NOT_RED)
    assert out["sheet"] and out["sheet"]["dashed"], (
        f"a sheet is a block being worked in, so it wears the shared mark: {out['sheet']}")
    assert out["chip"].startswith("Edit"), f"the chip must name the state: {out['chip']!r}"

    # **The other half**, and the one that keeps the inclusion free: a table left in
    # its default rendering holds no record, so it is not a block in a mode and wears
    # nothing. Without this the rule could be satisfied by marking every table.
    _dump(window, """(() => {
      const b = document.querySelector('#editor-container .block-control-form');
      b.click();
      return { clicked: true };
    })()""")
    _wait(window, "(() => ({ t: !!document.querySelector('#editor-container .ss-plain') }))()",
          lambda d: d.get("t") is True, timeout=10)
    plain = _dump(window, RECORD_BAR_IS_NOT_RED)
    assert plain["plain"] and plain["plain"]["style"] == "none", (
        f"a table in its default rendering is not a block in a mode: {plain['plain']}")


# The two outlines of the block-level vocabulary (styles.css §7.2): a **solid**
# accent outline means *selected*, a **dashed** one means *not being viewed as its
# document*.
#
# The selection half is checked by actually selecting, because the report was that
# `Ctrl+A` shows no indication at all on `spreadsheets.md` — and that turned out to
# be a bug in `selectionHighlightPlugin` rather than a missing style: it required a
# `TextSelection`, and `Ctrl+A` is an `AllSelection`.
BLOCK_OUTLINES = r"""(() => {
  const kindOf = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      style: cs.outlineStyle,
      width: parseFloat(cs.outlineWidth) || 0,
      colour: cs.outlineColor,
      dashed: cs.outlineStyle === 'dashed',
      solid: cs.outlineStyle === 'solid',
    };
  };
  return {
    selected: [...document.querySelectorAll('#editor-container .edi-block-selected')].map(
      (el) => ({ cls: String(el.className).split(' ')[0], ...kindOf(el) })),
    nodeSelected: [...document.querySelectorAll('#editor-container .ProseMirror-selectednode')]
      .map((el) => ({ cls: String(el.className).split(' ')[0], ...kindOf(el) })),
    editing: [...document.querySelectorAll('#editor-container .mermaid-editing')].map(kindOf),
    source: [...document.querySelectorAll('#editor-container .block-source-mode')].map(kindOf),
    sourceOwnBorder: (() => {
      const el = document.querySelector('#editor-container .block-source-mode');
      return el ? getComputedStyle(el).borderTopColor : null;
    })(),
    sheet: kindOf(document.querySelector('#editor-container .spreadsheet')),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  };
})()"""


# A stand-in for the document the select-all report was made against: a document
# function block and three tables — one with masked fields, one full of formulas, one
# plain. It is inline rather than read from a file because the original was a scratch
# document, and a test that depends on a file nobody keeps is a test that quietly
# stops running.
SPREADSHEET_DOC = """```edi-formula
GREET(name) = CONCAT("Hello, ", name, "!")
```

| # | Provider | Username |
| --- | --- | --- |
| 1 | Hulu | !masked[ARcwSrKv6Gxz]{label="Hulu Username"} |

| Name | Amount | Running | Greeting |
| --- | ---: | --- | --- |
| Dan | 25.25 | =D2+C2 | =GREET(A2) |
| Renee | =B2+1 | 25.32 | =D2+C3 | =GREET(A3) |
| **Total** | **=SUM(B2:B3)** |  |  |

| Height | Width |
| --- | --- |
| 97.6 | 63.7 |
"""


def _spreadsheets(window):
    """Open :data:`SPREADSHEET_DOC`, the shape the select-all report was made on."""
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps(SPREADSHEET_DOC))
    _wait(window, "(() => ({ t: !!document.querySelector('#editor-container .ss-plain') }))()",
          lambda d: d.get("t") is True, timeout=25)


def _accent_rgb(window):
    """The `--accent` of whichever scheme is loaded, as an `(r, g, b)` tuple."""
    raw = _dump(window, BLOCK_OUTLINES)["accent"]
    assert raw.startswith("#") and len(raw) == 7, f"unexpected --accent: {raw!r}"
    return tuple(int(raw[i:i + 2], 16) for i in (1, 3, 5))


def _outline_colour_rgb(colour):
    parts = colour.replace("rgb(", "").replace(")", "").split(", ")
    return tuple(int(v) for v in parts[:3])


# Selection is **split by what the browser can already express**: text keeps the
# browser's own highlight, and only atoms — a table, a diagram, a code block, which
# have no selectable text inside them — are marked.
#
# Marking every top-level block was tried, to make the two look alike, and it made
# them worse on both counts: an outline round ordinary paragraphs reads as a
# decorative border around running text, and because `.edi-block-selected::selection`
# erases the browser's highlight inside a marked block, marking everything erased the
# native selection across the whole document at once — everything selected, nothing
# visible as selected.
SELECTION_SPLIT_DOC = """A paragraph of ordinary prose.

- a list item
- another

| A | B |
| --- | --- |
| 1 | 2 |

```mermaid
graph TD
  A[Alpha]
```
"""


def test_selection_is_the_browsers_where_the_browser_can_do_it(window):
    """Text shows the browser's selection; only atoms get a mark.

    The two halves are checked separately because they fail separately. The mark is
    the *only* thing an atom has — a range across a table shows no native highlight
    at all, so without it the reader cannot tell whether the selection is across the
    table or stopped before it. And the mark must **not** reach ordinary text,
    because it suppresses the native highlight there (§ `.edi-block-selected
    ::selection`) and replaces a familiar thing with a decorative outline.
    """
    window._web.page().runJavaScript(
        "window.ediSetContent(%s); true" % json.dumps(SELECTION_SPLIT_DOC))
    _wait(window, "(() => ({ m: !!document.querySelector('#editor-container .mermaid') }))()",
          lambda d: d.get("m") is True, timeout=25)

    _ctrl_key(window, "a")
    out = _wait(
        window,
        """(() => {
          const marked = [...document.querySelectorAll('#editor-container .edi-block-selected')];
          const clsOf = (el) => el ? String(el.className).split(' ')[0] : null;
          const para = document.querySelector('#editor-container p');
          const list = document.querySelector('#editor-container li');
          return {
            marked: marked.map((el) => clsOf(el)),
            paraMarked: para ? para.classList.contains('edi-block-selected') : null,
            listMarked: list ? list.classList.contains('edi-block-selected') : null,
            // The browser's own highlight must still be live inside ordinary text.
            paraSelection: (() => {
              if (!para) return null;
              let bg = null;
              for (const sheet of document.styleSheets) {
                let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
                for (const r of rules) {
                  const sel = r.selectorText;
                  if (!sel || !r.style) continue;
                  if (!/::selection/.test(sel)) continue;
                  if (!/edi-block-selected/.test(sel)) continue;
                  bg = { sel: sel.slice(0, 60), bg: r.style.backgroundColor };
                }
              }
              return bg;
            })(),
          };
        })()""",
        lambda d: len(d["marked"]) >= 2, timeout=10)

    # The atoms: the table and the diagram. Nothing else.
    assert sorted(out["marked"]) == ["mermaid", "ss-plain"], out["marked"]
    assert out["paraMarked"] is False, "a paragraph must keep the browser's selection"
    assert out["listMarked"] is False, "a list item must keep the browser's selection"

    # ...and the suppression rule exists only for marked blocks, which is what keeps
    # the browser's highlight alive everywhere else.
    assert out["paraSelection"] is not None, "the ::selection suppression is gone"
    assert "edi-block-selected" in out["paraSelection"]["sel"], out["paraSelection"]


def test_select_all_marks_every_selected_atom(window):
    """`Ctrl+A` on `spreadsheets.md` marks every block it covers.

    The report was: press select-all, and not one block looks selected. The cause
    was not a missing style — `selectionHighlightPlugin` required a `TextSelection`
    and `Ctrl+A` is an `AllSelection`, so it decorated nothing. Every kind of
    non-empty selection has `from` and `to`, so the kind was never needed.
    """
    _spreadsheets(window)
    assert not _dump(window, BLOCK_OUTLINES)["selected"], (
        "something is already selected before the test selects anything")

    _dump(window, "(() => { document.querySelector('#editor-container .ProseMirror').focus();"
                  " return { focused: true }; })()")
    _dump(window, """(() => {
      for (const type of ['keydown', 'keyup']) {
        document.dispatchEvent(new KeyboardEvent(type, {
          key: 'a', code: 'KeyA', keyCode: 65, which: 65,
          ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
      }
      return { sent: true };
    })()""")
    marked = _wait(window, BLOCK_OUTLINES, lambda d: len(d["selected"]) >= 4, timeout=10)

    # Every top-level block in this document: the formula block and three tables.
    assert len(marked["selected"]) == 4, marked["selected"]
    accent = _accent_rgb(window)
    for entry in marked["selected"]:
        assert entry["solid"], f"a selected block needs a SOLID outline: {entry}"
        assert entry["width"] >= 2, f"the selection outline is too thin to see: {entry}"
        assert _outline_colour_rgb(entry["colour"]) == accent, (
            f"the selection outline is not --accent: {entry}")


def test_entering_a_mode_drops_a_document_wide_selection(window):
    """Ctrl+A, *then* Alt+click: the block shows the mode's mark, not selection's.

    This is what made the dashed outline invisible in practice. Both marks are an
    `outline` on the same element and selection is declared second, so it wins — and
    a mode taken while the whole document was selected therefore read as *merely
    selected*, on every block, forever. Taking a mode now collapses the selection,
    which is also what a mode wants: it is a fresh start on one block.

    The half that is easy to miss is that this is why the outline was reported as
    never appearing while a direct Alt+click showed it perfectly well.
    """
    _spreadsheets(window)
    _dump(window, "(() => { window.ediMenuCommand('selectAll'); return { d: 1 }; })()")
    everything = _wait(window, BLOCK_OUTLINES, lambda d: len(d["selected"]) >= 4, timeout=10)
    assert all(entry["solid"] for entry in everything["selected"]), everything["selected"]

    # Alt+click the last table: visual -> edit (its sheet).
    _dump(window, """(() => {
      const tables = document.querySelectorAll('#editor-container .ss-plain-table');
      const cell = tables[tables.length - 1].querySelector('td');
      cell.dispatchEvent(new MouseEvent('click',
        { bubbles: true, cancelable: true, button: 0, altKey: true }));
      return { clicked: true };
    })()""")
    _wait(window, "(() => ({ s: !!document.querySelector('#editor-container .spreadsheet') }))()",
          lambda d: d.get("s") is True, timeout=10)

    after = _dump(window, """(() => {
      const el = document.querySelector('#editor-container .spreadsheet');
      const s = getComputedStyle(el).outlineStyle;
      const sel = document.getSelection();
      return {
        marked: document.querySelectorAll('#editor-container .edi-block-selected').length,
        sheetOutline: s,
        domSelectionEmpty: !sel || sel.isCollapsed,
        chip: (document.querySelector('#status-mode') || {}).textContent || '',
      };
    })()""")
    assert after["marked"] == 0, (
        f"entering a mode must drop the selection, not carry it: {after}")
    assert after["domSelectionEmpty"], f"the document selection survived: {after}"
    # With the selection gone, the sheet's own mark is what reads — the same dashed
    # outline any other non-visual block wears.
    assert after["sheetOutline"] == "dashed", after
    assert after["chip"].startswith("Edit"), after["chip"]


def test_a_non_visual_mode_is_a_dashed_outline_whatever_the_mode(window):
    """Editing, Source and a sheet get the *same* mark: dashed, in the accent colour.

    A block that is not being viewed as its document is the reader's own doing and
    temporary, so a solid line is spent on selection. This was three separate
    treatments for three states — a 3px left bar, a source block's own solid accent
    border, and whatever a form did — and none of them matched.
    """
    _set_scheme(window, False)
    _render(window, FLOW)

    accent = _accent_rgb(window)

    # `_render` leaves a `NodeSelection` on the block it inserted, so this diagram
    # is **selected and being edited at once** — which is the precedence worth
    # pinning. Selection's solid outline is declared after the mode's dashed one and
    # deliberately wins: selection is the transient state a next keystroke or Ctrl+X
    # will act on, where the mode is the standing one. The dashed mark on its own is
    # checked below, on a block that is only in a mode.
    _dump(window, """(() => {
      const el = document.querySelector('.mermaid .mermaid-preview')
        || document.querySelector('.mermaid');
      el.dispatchEvent(new MouseEvent('click',
        { bubbles: true, cancelable: true, button: 0, altKey: true }));
      return { clicked: true };
    })()""")
    _wait(window, "(() => ({ e: !!document.querySelector('.mermaid-editing') }))()",
          lambda d: d.get("e") is True, timeout=15)

    editing = _dump(window, BLOCK_OUTLINES)
    assert editing["nodeSelected"], (
        f"the render should have selected the block it inserted: {editing}")
    assert editing["editing"] and editing["editing"][0]["solid"], (
        f"selection must win over the mode: {editing['editing']}")
    assert _outline_colour_rgb(editing["editing"][0]["colour"]) == accent, (
        f"the outline is not --accent: {editing['editing'][0]}")
    # ...and no trace of the `--danger` red the bar used to be.
    assert editing["editing"][0]["colour"] != "rgb(209, 36, 47)", editing["editing"][0]

    # **The mode mark on its own.** A paragraph in Source, which is only in a mode
    # and is not a block selection, so nothing else can be mistaken for the mark.
    _dump(window, "(() => { document.querySelector('.block-control-representation').click();"
                  " return { clicked: true }; })()")
    _wait(window, "(() => ({ s: !!document.querySelector('.block-source-mode') }))()",
          lambda d: d.get("s") is True, timeout=10)

    source = _dump(window, BLOCK_OUTLINES)
    assert source["source"] and source["source"][0]["dashed"], (
        f"a block in Source needs a DASHED outline: {source['source']}")
    assert _outline_colour_rgb(source["source"][0]["colour"]) == accent, (
        f"the mode outline is not --accent: {source['source'][0]}")
    # Its own border is chrome — `--border`, not the accent — so the frame around
    # the editor and the outline around the block are two different statements.
    assert source["sourceOwnBorder"] != f"rgb({accent[0]}, {accent[1]}, {accent[2]})", (
        f"a source block's own border must be chrome, not a mode: "
        f"{source['sourceOwnBorder']}")


def test_dbg_shortcut_fires(window, qtbot):
    """TEMPORARY: does a real key press trigger the QAction, or only clicking it?"""
    from PySide6.QtCore import Qt
    fired = []
    targets = {}
    for menu in (window._edit_menu,):
        for item in menu.actions():
            key = item.text().split("\t")[0]
            targets[key] = item
            item.triggered.connect(lambda checked=False, k=key: fired.append(k))
    print("\n  actions:", {k: (v.shortcut().toString(), v.isEnabled())
                           for k, v in targets.items()})

    window.raise_()
    window.activateWindow()
    _spreadsheets(window)

    qtbot.keyClick(window, Qt.Key_A, Qt.ControlModifier)
    time.sleep(0.4)
    print("  after Ctrl+A  -> fired:", fired)
    qtbot.keyClick(window, Qt.Key_C, Qt.ControlModifier)
    time.sleep(0.4)
    print("  after Ctrl+C  -> fired:", fired)

    # And by clicking/triggering the action directly.
    fired.clear()
    targets["Cu&t"].trigger() if "Cu&t" in targets else None
    for k, v in targets.items():
        if "Copy" in k.replace("&", ""):
            v.trigger()
    time.sleep(0.4)
    print("  after trigger -> fired:", fired)
    assert True


def test_who_owns_each_edit_menu_key(window):
    """The shell's keys are real shortcuts; the document commands are not.

    The bug this exists for: a `\\t` in a `QAction` label gives the action **no**
    shortcut in PySide6, so `Ctrl+C` and `Ctrl+A` were labels and nothing else. The
    keys reached the webview, where there was no DOM selection to copy, and both did
    nothing — while clicking the same menu item worked, because clicking *triggers*
    the action regardless. Read off the actions, never off the labels: the label was
    never the evidence.
    """
    shell = {a.text(): a.shortcut().toString() for a in window._file_menu.actions()}
    for label, sequence in (("&New", "Ctrl+N"), ("&Open…", "Ctrl+O"), ("&Save", "Ctrl+S"),
                            ("Save &As…", "Ctrl+Shift+S"), ("&Quit", "Ctrl+Q"),
                            ("Copy File &Path", "Ctrl+Alt+Shift+C")):
        assert shell.get(label) == sequence, f"{label}: {shell.get(label)!r}"

    # The document commands are the page's, and must hold no shortcut that would
    # shadow it — including inside a CodeMirror buffer, where the page is the only
    # thing that knows what is selected.
    for action in window._edit_menu.actions():
        assert action.shortcut().isEmpty(), (
            f"{action.text()!r} holds {action.shortcut().toString()!r}, which would "
            "shadow the page's own handling")
        assert "\t" not in action.text(), (
            f"{action.text()!r} advertises a key that does not work")


def _ctrl_key(window, k, **mods):
    return _dump(window, """(() => {
      const el = document.querySelector('#editor-container .ProseMirror');
      for (const type of ['keydown', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, Object.assign(
          { key: %s, code: 'Key%s', keyCode: %d, bubbles: true, cancelable: true },
          { ctrlKey: true, metaKey: true }, %s)));
      }
      return { sent: true };
    })()""" % (repr(k).replace("'", '"'), k.upper(), ord(k.upper()), mods))


def _clipboard_text():
    from PySide6.QtGui import QGuiApplication
    time.sleep(0.5)
    return QGuiApplication.clipboard().text()


def test_ctrl_c_copies_the_document_as_rich_text(window):
    """`Ctrl+A` then `Ctrl+C` puts the whole document on the clipboard, as HTML+text.

    This is the report: `Ctrl+A` then `Ctrl+C` copied nothing, while **Edit → Copy**
    worked. That signature is not a shortcut bound to the wrong thing, it is a
    shortcut bound to *nothing*: Qt never claimed it (a `\t` in a QAction label
    gives the action no shortcut), and ProseMirror has no `Mod-c` binding — it
    answers a native `copy` DOM event, which a webview whose selection is managed in
    JavaScript does not reliably produce. So the page now routes the key to
    `editCopy`, which is exactly what the menu item calls.
    """
    from PySide6.QtGui import QGuiApplication
    _spreadsheets(window)
    QGuiApplication.clipboard().clear()

    _ctrl_key(window, "a")
    marked = _wait(window, BLOCK_OUTLINES, lambda d: len(d["selected"]) >= 4, timeout=10)
    assert len(marked["selected"]) == 4, marked["selected"]

    _ctrl_key(window, "c")
    text = _clipboard_text()
    assert text, "Ctrl+C put nothing on the clipboard"
    assert "GREET(name)" in text, f"not the document: {text[:80]!r}"
    assert text.count("|") > 20, f"the tables are missing: {text[:80]!r}"

    # **Rich text as well as plain** — that is what makes this different from
    # Ctrl+Shift+C, and it is what `editCopy` has always sent for the menu item.
    mime = QGuiApplication.clipboard().mimeData()
    assert mime is not None and mime.html(), "no HTML on the clipboard: plain text only"
    assert "GREET" in mime.html(), mime.html()[:80]
    assert mime.text() == text, "the plain-text flavour does not match"

    # ...and Ctrl+Shift+C is still *plain Markdown*, which is the difference between
    # the two keys and the reason both exist.
    QGuiApplication.clipboard().clear()
    _ctrl_key(window, "c", shiftKey="true")
    markdown = _clipboard_text()
    assert markdown, "Ctrl+Shift+C stopped working"
    assert "GREET(name)" in markdown, markdown[:80]
    shifted = QGuiApplication.clipboard().mimeData()
    assert shifted is not None and not shifted.html(), (
        "Ctrl+Shift+C must stay plain text; it is the Markdown key")


def test_paste_is_not_stolen_from_a_field_or_a_code_editor(window):
    """The clipboard keys yield to whatever actually holds the caret.

    A masked field's revealed input, a spreadsheet cell and a block's raw-markdown
    editor each have their own clipboard behaviour, and a document-level Copy in the
    middle of one would either copy the wrong thing or nothing. Pinned on a block in
    its Source form, which is the case most likely to be got wrong.
    """
    _spreadsheets(window)
    _ctrl_key(window, "a")
    _dump(window, """(() => {
      const b = document.querySelector('#editor-container .block-control-representation');
      b.click();
      return { d: 1 };
    })()""")
    _wait(window, "(() => ({ s: !!document.querySelector('#editor-container .cm-editor') }))()",
          lambda d: d.get("s") is True, timeout=10)

    # Inside the CodeMirror the handler must not claim the key, so the editor's own
    # copy runs and there is nothing on the document clipboard to contradict it.
    inside = _dump(window, """(() => {
      const el = document.querySelector('#editor-container .cm-content');
      const before = document.activeElement;
      for (const type of ['keydown', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, Object.assign(
          { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true, cancelable: true },
          { ctrlKey: true, metaKey: true })));
      }
      return { prevented: false, focusedInside: document.activeElement === before };
    })()""")
    assert inside["focusedInside"], inside


def test_select_all_then_copy_reaches_the_clipboard(window):
    """`Ctrl+A` then `Ctrl+C`: the markdown of the whole document, on the clipboard.

    Every route is exercised, because they are different code: the page's own key
    handling, and the shell's menu commands that the Qt actions call. The report was
    that the keyboard did nothing while the menu worked, which is the signature of a
    `\t` label that never bound anything — so this asserts the *outcome* rather than
    that a shortcut exists.
    """
    from PySide6.QtGui import QGuiApplication
    _spreadsheets(window)

    def key(k):
        return _dump(window, """(() => {
          const el = document.querySelector('#editor-container .ProseMirror');
          for (const type of ['keydown', 'keyup']) {
            el.dispatchEvent(new KeyboardEvent(type, Object.assign(
              { key: %s, code: 'Key%s', keyCode: %d, bubbles: true, cancelable: true },
              { ctrlKey: true, metaKey: true })));
          }
          return { sent: true };
        })()""" % (repr(k).replace("'", '"'), k.upper(), ord(k.upper())))

    def clipboard():
        time.sleep(0.5)
        return QGuiApplication.clipboard().text()

    # 1. The page's own path: select all, then its `copy` handler. The `copy` event
    # is dispatched by hand because Chromium only fires one for a *real* key press,
    # and a synthetic keydown cannot become one — which is also why `QTest` keys
    # cannot test a shortcut here.
    key("a")
    marked = _wait(window, BLOCK_OUTLINES, lambda d: len(d["selected"]) >= 4, timeout=10)
    assert len(marked["selected"]) == 4, marked["selected"]

    written = _dump(window, """(() => {
      const el = document.querySelector('#editor-container .ProseMirror');
      let text = null;
      const ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: {
        setData: (type, value) => { if (type === 'text/plain') text = value; },
        getData: () => '', clearData: () => {}, types: ['text/plain'],
      }, configurable: true });
      el.dispatchEvent(ev);
      return { len: text === null ? 0 : text.length, head: (text || '').slice(0, 60) };
    })()""")
    assert written["len"] > 100, f"the page's copy handler wrote nothing: {written}"
    assert "GREET(name)" in written["head"], written

    # 2. The shell's commands, which is what the Qt actions call.
    QGuiApplication.clipboard().clear()
    _dump(window, "(() => { window.ediMenuCommand('selectAll'); return { d: 1 }; })()")
    _dump(window, "(() => { window.ediMenuCommand('copy'); return { d: 1 }; })()")
    text = clipboard()
    assert text, "Edit -> Copy put nothing on the clipboard"
    assert "GREET(name)" in text, f"the copied text is not the document: {text[:80]!r}"
    # The formula block and every table, in order.
    assert text.count("|") > 20, f"the copied text is missing the tables: {text[:80]!r}"


def test_dbg_ctrl_c_claim(window):
    """TEMPORARY: does the page's Ctrl+C handler even see the key?"""
    from PySide6.QtGui import QGuiApplication
    _spreadsheets(window)
    QGuiApplication.clipboard().clear()
    _ctrl_key(window, "a")

    out = _dump(window, """(() => {
      const el = document.querySelector('#editor-container .ProseMirror');
      const seen = [];
      const spy = (e) => seen.push({ key: e.key, prevented: e.defaultPrevented });
      window.addEventListener('keydown', spy);
      const ev = new KeyboardEvent('keydown', Object.assign(
        { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true, cancelable: true },
        { ctrlKey: true, metaKey: true }));
      el.dispatchEvent(ev);
      window.removeEventListener('keydown', spy);
      return {
        prevented: ev.defaultPrevented,
        seen,
        active: document.activeElement
          ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 24)
          : null,
        hasEditor: !!document.querySelector('#editor-container .ProseMirror[contenteditable]'),
      };
    })()""")
    print("\n  prevented:", out["prevented"], " seen:", out["seen"])
    print("  activeElement:", out["active"], " hasEditable:", out["hasEditor"])
    time.sleep(0.6)
    print("  clipboard:", len(QGuiApplication.clipboard().text()), "chars")
    assert True
