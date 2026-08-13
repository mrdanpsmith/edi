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
        self.closed = False
        self.confirm_messages: list[str] = []

    def confirm(self, message, callback=None) -> None:
        self.confirm_messages.append(message)
        if callback is not None:
            callback(True)

    def set_dirty(self, dirty: bool) -> None:
        self.dirty = dirty

    def pick_open_path(self, callback=None) -> None:
        if callback is not None:
            callback(None)

    def pick_save_path(self, default_name, callback=None) -> None:
        if callback is not None:
            callback(f"/tmp/{default_name}.md")

    def pick_export_path(self, default_name, callback=None) -> None:
        if callback is not None:
            callback(f"/tmp/{default_name}.html")

    def close(self) -> None:
        self.closed = True


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


def test_confirm_uses_window(bridge):
    bridge_obj, window, result = bridge
    _invoke(bridge_obj, "confirm", {"message": "Continue?"})
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert message["data"] is True
    assert window.confirm_messages == ["Continue?"]


def test_quit_closes_window(bridge):
    bridge_obj, window, result = bridge
    _invoke(bridge_obj, "quit")
    message = _wait_for(lambda: result.get(1))
    assert message["ok"] is True
    assert window.closed is True


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
