"""Tests for the native bridge dispatch (no WebEngine needed)."""

from __future__ import annotations

import json
import time

from PySide6.QtCore import QObject
from PySide6.QtWidgets import QApplication

import backend.exec as exec_module
from backend.bridge import Bridge
from backend.exec import parse_shebang, run_code_block, strip_shebang_line

import pytest


class StubWindow(QObject):
    def __init__(self) -> None:
        super().__init__()
        self.dirty = False
        self.title = "Edi"
        self.closed = False
        self.confirm_messages: list[str] = []
        self.alert_messages: list[str] = []
        self.can_revert = False
        self.formatting_visible = True
        self.opened_urls: list[str] = []

    def confirm(self, message, callback=None) -> None:
        self.confirm_messages.append(message)
        if callback is not None:
            callback(True)

    def alert(self, message) -> None:
        self.alert_messages.append(message)

    def set_dirty(self, dirty: bool) -> None:
        self.dirty = dirty

    def set_title(self, title: str) -> None:
        self.title = title

    def update_menu_state(
        self, can_revert=False, formatting_visible=True
    ) -> None:
        self.can_revert = can_revert
        self.formatting_visible = formatting_visible

    def pick_open_path(self, callback=None) -> None:
        if callback is not None:
            callback(None)

    def pick_save_path(self, default_name, callback=None) -> None:
        if callback is not None:
            callback(f"/tmp/{default_name}.md")

    def pick_export_path(self, default_name, callback=None) -> None:
        if callback is not None:
            callback(f"/tmp/{default_name}.html")

    def pick_import_path(self, callback=None) -> None:
        if callback is not None:
            callback("/tmp/table.csv")

    def pick_text_import_path(self, callback=None) -> None:
        if callback is not None:
            callback("/tmp/notes.txt")

    def pick_image_import_path(self, callback=None) -> None:
        if callback is not None:
            callback("/tmp/pic.png")

    def close(self) -> None:
        self.closed = True

    def open_external_url(self, url: str) -> None:
        self.opened_urls.append(url)


@pytest.fixture
def bridge(qapp):
    window = StubWindow()
    result: dict[int, dict] = {}

    def on_result(payload):
        message = json.loads(payload)
        result[message["id"]] = message

    bridge = Bridge(window)
    bridge.result.connect(on_result)
    return bridge, window, result


@pytest.fixture
def stream_bridge(qapp):
    """A bridge that captures both ``result`` replies and ``stream`` chunks."""
    window = StubWindow()
    result: dict[int, dict] = {}
    stream_events: list[dict] = []

    def on_result(payload):
        message = json.loads(payload)
        result[message["id"]] = message

    def on_stream(payload):
        stream_events.append(json.loads(payload))

    bridge = Bridge(window)
    bridge.result.connect(on_result)
    bridge.stream.connect(on_stream)
    return bridge, window, result, stream_events


def _invoke(bridge, method, payload=None, request_id=1):
    bridge.invoke(method, request_id, json.dumps(payload or {}))


def _wait_for(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        QApplication.processEvents()
        value = predicate()
        if value is not None:
            return value
        time.sleep(0.01)
    raise AssertionError("timed out waiting for bridge reply")


def test_ping_round_trip(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "ping", {"now": 7})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] == 7


def test_unknown_method(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "nope")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is False
    assert "Unknown method" in message["error"]


def test_set_dirty(bridge):
    bridge_obj, window, result = bridge
    _invoke(bridge_obj, "setDirty", {"dirty": True})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert window.dirty is True


def test_set_title(bridge):
    bridge_obj, window, result = bridge
    _invoke(bridge_obj, "setTitle", {"title": "notes.md — Edi"})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert window.title == "notes.md — Edi"


def test_set_menu_state(bridge):
    bridge_obj, window, result = bridge
    _invoke(
        bridge_obj,
        "setMenuState",
        {
            "canRevert": True,
            "formattingVisible": False,
        },
    )
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert window.can_revert is True
    assert window.formatting_visible is False


def test_pick_import_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "pickImportPath")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] == "/tmp/table.csv"


def test_pick_open_path_multiple_files(bridge):
    bridge_obj, window, result = bridge
    window.pick_open_path = lambda callback: callback(["/tmp/a.md", "/tmp/b.md"])
    _invoke(bridge_obj, "pickOpenPath")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] == ["/tmp/a.md", "/tmp/b.md"]


def test_pick_open_path_cancel_returns_none(bridge):
    bridge_obj, window, result = bridge
    window.pick_open_path = lambda callback: callback([])
    _invoke(bridge_obj, "pickOpenPath")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] is None


def test_pick_text_import_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "pickTextImportPath")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] == "/tmp/notes.txt"


def test_pick_image_import_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "pickImageImportPath")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] == "/tmp/pic.png"


def test_read_any_text_file(bridge, tmp_path):
    bridge_obj, _window, result = bridge
    target = tmp_path / "notes.log"
    target.write_text("log line", encoding="utf-8")
    _invoke(bridge_obj, "readAnyTextFile", {"path": str(target)}, request_id=2)
    message = _wait_for(lambda: result.get(2))
    assert message["ok"] is True
    assert message["data"] == "log line"


def test_parse_table_file_csv(bridge, tmp_path):
    bridge_obj, _window, result = bridge
    target = tmp_path / "data.csv"
    target.write_text("a,b\n1,2\n", encoding="utf-8")

    _invoke(bridge_obj, "parseTableFile", {"path": str(target)}, 30)
    message = _wait_for(lambda: result.get(30))
    assert message["ok"] is True
    assert message["data"]["name"] == "data"
    assert message["data"]["rows"] == [["a", "b"], ["1", "2"]]


def test_parse_table_file_missing_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "parseTableFile", {}, 31)
    message = _wait_for(lambda: result.get(31))
    assert message["ok"] is False
    assert "Missing path" in message["error"]


def test_parse_table_file_bad_file(bridge, tmp_path):
    bridge_obj, _window, result = bridge
    target = tmp_path / "broken.ods"
    target.write_bytes(b"not a zip archive")
    _invoke(bridge_obj, "parseTableFile", {"path": str(target)}, 32)
    message = _wait_for(lambda: result.get(32))
    assert message["ok"] is False


def test_copy_table_sets_clipboard(bridge):
    from PySide6.QtGui import QGuiApplication

    bridge_obj, _window, result = bridge
    _invoke(
        bridge_obj,
        "copyTable",
        {"html": "<table><tr><td>x</td></tr></table>", "plain": "x"},
        40,
    )
    message = _wait_for(lambda: result.get(40))
    assert message["ok"] is True
    mime = QGuiApplication.clipboard().mimeData()
    assert mime.hasText()
    assert mime.text() == "x"
    assert mime.hasHtml()
    assert "<table>" in mime.html()


def test_copy_text_sets_clipboard(bridge):
    from PySide6.QtGui import QGuiApplication

    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "copyText", {"text": "hello"}, 41)
    message = _wait_for(lambda: result.get(41))
    assert message["ok"] is True
    assert QGuiApplication.clipboard().text() == "hello"


def test_copy_content_sets_html_and_text_clipboard(bridge):
    from PySide6.QtGui import QGuiApplication

    bridge_obj, _window, result = bridge
    _invoke(
        bridge_obj,
        "copyContent",
        {"html": "<strong>bold</strong>", "text": "bold"},
        42,
    )
    message = _wait_for(lambda: result.get(42))
    assert message["ok"] is True
    mime = QGuiApplication.clipboard().mimeData()
    assert mime.hasText()
    assert mime.text() == "bold"
    assert mime.hasHtml()
    assert "<strong>bold</strong>" in mime.html()


def test_confirm_uses_window(bridge):
    bridge_obj, window, result = bridge
    _invoke(bridge_obj, "confirm", {"message": "Continue?"})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] is True
    assert window.confirm_messages == ["Continue?"]


def test_alert_uses_window(bridge):
    bridge_obj, window, result = bridge
    _invoke(bridge_obj, "alert", {"message": "Something broke"})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] is None
    assert window.alert_messages == ["Something broke"]


def test_quit_closes_window(bridge):
    bridge_obj, window, result = bridge
    _invoke(bridge_obj, "quit")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert window.closed is True


def test_open_url_forwards_to_window(bridge):
    bridge_obj, window, result = bridge
    _invoke(bridge_obj, "openUrl", {"url": "https://example.com/a"})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert window.opened_urls == ["https://example.com/a"]


def test_open_url_missing_url_errors(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "openUrl", {})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is False
    assert "Missing url" in message["error"]


def test_write_and_read_round_trip(bridge, tmp_path):
    bridge_obj, _window, result = bridge
    target = tmp_path / "notes.md"

    _invoke(bridge_obj, "writeTextFile", {"path": str(target), "content": "hello edi"}, 10)
    write = _wait_for(lambda: result.get(10))
    assert write["ok"] is True

    _invoke(bridge_obj, "readTextFile", {"path": str(target)}, 11)
    read = _wait_for(lambda: result.get(11))
    assert read["ok"] is True
    assert read["data"] == "hello edi"


def test_read_missing_file_errors(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "readTextFile", {"path": "/nonexistent/notes.md"}, 12)
    message = _wait_for(lambda: result.get(12))
    assert message["ok"] is False
    assert "Not a file" in message["error"]


def test_run_code_block_python(bridge):
    bridge_obj, _window, result = bridge
    _invoke(
        bridge_obj,
        "runCodeBlock",
        {"shebang": "#!/usr/bin/env python3", "source": "print('hi from edi')"},
        20,
    )
    message = _wait_for(lambda: result.get(20))
    assert message["ok"] is True
    assert message["data"]["stdout"].strip() == "hi from edi"
    assert message["data"]["exitCode"] == 0
    assert message["data"]["timedOut"] is False


def test_run_code_block_unsupported_interpreter(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "runCodeBlock", {"shebang": "#!brainfuck", "source": "+++"}, 21)
    message = _wait_for(lambda: result.get(21))
    assert message["ok"] is False
    assert "Unsupported interpreter" in message["error"]


def test_stream_code_block_outputs_chunks_and_done(stream_bridge):
    bridge_obj, _window, result, stream_events = stream_bridge
    rid = 50
    _invoke(
        bridge_obj,
        "streamCodeBlock",
        {"shebang": "#!sh", "source": "echo first; echo second"},
        rid,
    )
    done = _wait_for(lambda: next((e for e in stream_events if e["kind"] == "done"), None))
    assert done["id"] == rid
    assert done["ok"] is True
    text = "".join(e.get("text", "") for e in stream_events if e["kind"] == "output")
    assert "first" in text
    assert "second" in text
    message = _wait_for(lambda: result.get(rid))
    assert message["ok"] is True
    assert message["data"]["exitCode"] == 0
    assert message["data"]["stopped"] is False


def test_stream_python_stdout_is_incremental(stream_bridge):
    """A pty makes Python line-buffer stdout, so output streams before exit.

    Python block-buffers stdout when it is a pipe, which would hold every
    ``print`` until the process exits. Streaming through a pty makes the
    interpreter fall back to line buffering, so chunks arrive while the program
    is still running.
    """
    bridge_obj, _window, result, stream_events = stream_bridge
    rid = 60
    _invoke(
        bridge_obj,
        "streamCodeBlock",
        {
            "shebang": "#!python3",
            "source": "import time\nprint('N 1')\ntime.sleep(2)\nprint('N 2')",
        },
        rid,
    )

    def got_count(n):
        return (
            len([e for e in stream_events if e["kind"] == "output" and "N" in e.get("text", "")])
            >= n
        )

    # The first line arrives while the process is still sleeping, before the
    # run has finished (its result reply has not been sent yet).
    def first_line_streamed_before_completion():
        if rid in result:
            # The run finished before we ever observed a chunk — not incremental.
            return None
        return got_count(1) or None

    assert _wait_for(first_line_streamed_before_completion, timeout=10)
    assert rid not in result, "output should stream before the run completes"

    done = _wait_for(lambda: next((e for e in stream_events if e["kind"] == "done"), None))
    assert done["ok"] is True
    text = "".join(e.get("text", "") for e in stream_events if e["kind"] == "output")
    assert "N 1" in text
    assert "N 2" in text
    message = _wait_for(lambda: result.get(rid))
    assert message["ok"] is True
    assert message["data"]["stdout"] == "N 1\nN 2\n"


def test_stop_code_block_kills_running_process(stream_bridge):
    bridge_obj, _window, result, stream_events = stream_bridge
    rid = 51
    _invoke(
        bridge_obj,
        "streamCodeBlock",
        {"shebang": "#!sh", "source": "for i in $(seq 1 200); do echo $i; sleep 0.05; done"},
        rid,
    )
    # Wait until the process is registered, then stop it.
    _wait_for(lambda: bridge_obj._procs.get(rid))
    _invoke(bridge_obj, "stopCodeBlock", {"id": rid}, rid)
    done = _wait_for(lambda: next((e for e in stream_events if e["kind"] == "done"), None))
    assert done["ok"] is True
    message = _wait_for(lambda: result.get(rid))
    assert message["ok"] is True
    assert message["data"]["stopped"] is True


def test_run_code_block_timeout(bridge, monkeypatch):
    monkeypatch.setattr(exec_module, "EXEC_TIMEOUT_SECONDS", 1)
    bridge_obj, _window, result = bridge
    _invoke(
        bridge_obj,
        "runCodeBlock",
        {"shebang": "#!sh", "source": "sleep 5"},
        22,
    )
    message = _wait_for(lambda: result.get(22))
    assert message["ok"] is False
    assert "timed out" in message["error"]


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("#!python", ["python"]),
        ("#!/usr/bin/env python3", ["python3"]),
        ("#!/usr/bin/env -S python3 -u", ["python3", "-u"]),
        ("#!/bin/bash", ["bash"]),
        ("#!node --experimental-foo", ["node", "--experimental-foo"]),
        ("#!", None),
        ("", None),
    ],
)
def test_parse_shebang(line, expected):
    assert parse_shebang(line) == expected


def test_strip_shebang_line():
    assert strip_shebang_line("#!/bin/sh\necho hi") == "echo hi"
    assert strip_shebang_line("#!/bin/sh") == ""
    assert strip_shebang_line("echo hi") == "echo hi"


def test_run_code_block_direct():
    result = run_code_block("#!/usr/bin/env python3", "print('direct')")
    assert result["stdout"].strip() == "direct"
    assert result["exitCode"] == 0


def test_invalid_payload_replies_error(bridge):
    bridge_obj, _window, result = bridge
    bridge_obj.invoke("ping", 1, "{not json")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is False
    assert "Invalid payload" in message["error"]


def test_handler_exception_replies_error(bridge, monkeypatch):
    bridge_obj, window, result = bridge

    def boom(_message, _callback=None):
        raise RuntimeError("boom")

    monkeypatch.setattr(window, "confirm", boom)
    _invoke(bridge_obj, "confirm", {"message": "x"})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is False
    assert "boom" in message["error"]


def test_pick_save_path_replies_default_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "pickSavePath", {"defaultName": "notes"}, 60)
    message = _wait_for(lambda: result.get(60))
    assert message["ok"] is True
    assert message["data"] == "/tmp/notes.md"


def test_pick_export_path_replies_default_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "pickExportPath", {"defaultName": "out"}, 61)
    message = _wait_for(lambda: result.get(61))
    assert message["ok"] is True
    assert message["data"] == "/tmp/out.html"


def test_read_text_file_missing_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "readTextFile", {}, 62)
    message = _wait_for(lambda: result.get(62))
    assert message["ok"] is False
    assert "Missing path" in message["error"]


def test_read_any_text_file_missing_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "readAnyTextFile", {}, 63)
    message = _wait_for(lambda: result.get(63))
    assert message["ok"] is False
    assert "Missing path" in message["error"]


def test_read_any_text_file_error(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "readAnyTextFile", {"path": "/nonexistent/notes.log"}, 64)
    message = _wait_for(lambda: result.get(64))
    assert message["ok"] is False


def test_write_text_file_missing_path(bridge):
    bridge_obj, _window, result = bridge
    _invoke(bridge_obj, "writeTextFile", {}, 65)
    message = _wait_for(lambda: result.get(65))
    assert message["ok"] is False
    assert "Missing path" in message["error"]


def test_write_text_file_error(bridge, tmp_path):
    bridge_obj, _window, result = bridge
    blocker = tmp_path / "blocker"
    blocker.write_text("x", encoding="utf-8")
    _invoke(
        bridge_obj,
        "writeTextFile",
        {"path": str(blocker / "sub" / "out.md"), "content": "x"},
        66,
    )
    message = _wait_for(lambda: result.get(66))
    assert message["ok"] is False


def test_parse_shebang_env_without_interpreter_returns_none():
    assert parse_shebang("#!/usr/bin/env -S") is None


def test_run_code_block_empty_shebang_raises():
    with pytest.raises(ValueError, match="Invalid shebang"):
        run_code_block("#!", "print('x')")


def test_run_code_block_interpreter_not_found(monkeypatch):
    monkeypatch.setitem(exec_module._INTERPRETERS, "edi", ("edi-nonexistent", "-"))
    with pytest.raises(ValueError, match="Failed to start"):
        run_code_block("#!edi", "print('x')")
