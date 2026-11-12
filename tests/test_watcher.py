"""Tests for noticing documents changed on disk (`backend/watcher.py`)."""

from __future__ import annotations

import json
import os
import threading
import time

import pytest
from PySide6.QtWidgets import QApplication

from backend import history
from backend.watcher import DiskWatcher

from tests.test_bridge import StubWindow, _invoke, _wait_for


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv(history.ROOT_ENV, str(tmp_path / "history"))


@pytest.fixture
def watcher(qapp):
    events: list[dict] = []
    disk = DiskWatcher(events.append)
    yield disk, events
    # On this (the main) thread, where its Qt objects live: see the module docstring.
    disk.close()


def _settle(seconds: float = 0.8) -> None:
    """Let file-system notifications arrive and the settle timer fire."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        QApplication.processEvents()
        time.sleep(0.01)


def _replace(path, text: str) -> None:
    """Write the way agents and editors do: a temporary file renamed over the target."""
    staged = path.with_name(f".{path.name}.tmp")
    staged.write_text(text, encoding="utf-8")
    os.replace(staged, path)


def test_a_change_by_another_writer_is_reported_once_and_recorded(watcher, tmp_path):
    disk, events = watcher
    doc = tmp_path / "notes.md"
    doc.write_text("mine\n", encoding="utf-8")
    disk.seen(str(doc), doc.read_bytes())
    _settle(0.1)

    _replace(doc, "theirs\n")
    _wait_for(lambda: events or None)
    _settle()
    assert events == [{"type": "diskChanged", "path": str(doc)}]
    assert disk.changed_since_seen(str(doc)) is True
    versions = _wait_for(lambda: history.list_versions(str(doc)) or None)
    assert versions[0]["message"] == "Changed outside Edi"


def test_a_burst_of_writes_is_one_event(watcher, tmp_path):
    disk, events = watcher
    doc = tmp_path / "notes.md"
    doc.write_text("0\n", encoding="utf-8")
    disk.seen(str(doc), doc.read_bytes())
    _settle(0.1)
    for i in range(5):
        _replace(doc, f"{i + 1}\n")
        time.sleep(0.02)
    _settle(1.2)
    assert events == [{"type": "diskChanged", "path": str(doc)}]


def test_the_file_as_edi_left_it_is_not_news(watcher, tmp_path):
    disk, events = watcher
    doc = tmp_path / "notes.md"
    doc.write_text("mine\n", encoding="utf-8")
    disk.seen(str(doc), doc.read_bytes())
    _settle(0.1)
    # Edi's own save: the bytes are told to the watcher as it writes them.
    disk.seen(str(doc), b"saved\n")
    _replace(doc, "saved\n")
    _settle()
    assert events == []
    assert disk.changed_since_seen(str(doc)) is False


def test_a_deleted_file_is_reported_and_its_return_too(watcher, tmp_path):
    disk, events = watcher
    doc = tmp_path / "notes.md"
    doc.write_text("mine\n", encoding="utf-8")
    disk.seen(str(doc), doc.read_bytes())
    _settle(0.1)

    doc.unlink()
    _wait_for(lambda: events or None)
    assert events == [{"type": "diskDeleted", "path": str(doc)}]
    # Nothing to lose by saving over a file that is gone.
    assert disk.changed_since_seen(str(doc)) is False

    doc.write_text("mine\n", encoding="utf-8")
    _wait_for(lambda: events[1:] or None)
    assert events[1] == {"type": "diskChanged", "path": str(doc)}


def test_a_forgotten_file_is_not_watched(watcher, tmp_path):
    disk, events = watcher
    doc = tmp_path / "notes.md"
    doc.write_text("mine\n", encoding="utf-8")
    disk.seen(str(doc), doc.read_bytes())
    _settle(0.1)
    disk.forget(str(doc))
    _settle(0.1)
    _replace(doc, "theirs\n")
    _settle()
    assert events == []
    assert disk.changed_since_seen(str(doc)) is False


def test_a_closed_watcher_reports_nothing_and_ignores_late_news(watcher, tmp_path):
    disk, events = watcher
    doc = tmp_path / "notes.md"
    doc.write_text("mine\n", encoding="utf-8")
    disk.seen(str(doc), doc.read_bytes())
    _settle(0.1)
    disk.close()
    # A worker still finishing when the bridge shuts down.
    disk.seen(str(doc), doc.read_bytes())
    _settle(0.1)
    _replace(doc, "theirs\n")
    _settle()
    assert events == []
    assert disk.watched() == []
    assert disk.changed_since_seen(str(doc)) is False


def test_a_bridge_shutdown_waits_for_its_workers(qapp, tmp_path):
    from backend.bridge import Bridge

    bridge = Bridge(StubWindow())
    finished = threading.Event()

    def slow() -> None:
        time.sleep(0.2)
        finished.set()

    bridge._spawn(slow)
    bridge.shutdown()
    # Joined: no worker is left holding the bridge, so it is freed here, on
    # the main thread, and never on a worker's.
    assert finished.is_set()


# ── through the bridge ────────────────────────────────────────────────────


@pytest.fixture
def bridge(qapp):
    from backend.bridge import Bridge

    window = StubWindow()
    result: dict[int, dict] = {}
    events: list[dict] = []
    bridge = Bridge(window)
    bridge.result.connect(lambda payload: result.update({json.loads(payload)["id"]: json.loads(payload)}))
    bridge.notify.connect(lambda payload: events.append(json.loads(payload)))
    return bridge, result, events


def test_reading_a_document_records_it_and_watches_it(bridge, tmp_path):
    bridge_obj, result, events = bridge
    doc = tmp_path / "agent.md"
    doc.write_text("# Written by an agent\n", encoding="utf-8")

    _invoke(bridge_obj, "readTextFile", {"path": str(doc)}, 1)
    assert _wait_for(lambda: result.get(1))["ok"] is True
    assert [v["message"] for v in history.list_versions(str(doc))] == ["Opened in Edi"]

    _settle(0.1)
    _replace(doc, "# Rewritten by the agent\n")
    _wait_for(lambda: events or None)
    assert events == [{"type": "diskChanged", "path": str(doc)}]


def test_a_save_over_an_unseen_change_is_refused_until_it_is_read(bridge, tmp_path):
    bridge_obj, result, _events = bridge
    doc = tmp_path / "agent.md"
    doc.write_text("first\n", encoding="utf-8")
    bridge_obj.grants.allow_write(str(doc))
    _invoke(bridge_obj, "readTextFile", {"path": str(doc)}, 2)
    assert _wait_for(lambda: result.get(2))["ok"] is True

    _replace(doc, "the agent's\n")
    _invoke(bridge_obj, "writeTextFile", {"path": str(doc), "content": "mine", "history": True}, 3)
    refused = _wait_for(lambda: result.get(3))
    assert refused["ok"] is False and refused["code"] == "changedOnDisk"
    assert doc.read_text(encoding="utf-8") == "the agent's\n"

    # Reading it again is the reader having seen it: now the save goes through.
    _invoke(bridge_obj, "readTextFile", {"path": str(doc)}, 4)
    assert _wait_for(lambda: result.get(4))["ok"] is True
    _invoke(bridge_obj, "writeTextFile", {"path": str(doc), "content": "mine", "history": True}, 5)
    assert _wait_for(lambda: result.get(5))["ok"] is True
    assert doc.read_text(encoding="utf-8") == "mine"


def test_edis_own_save_is_not_reported_as_a_change(bridge, tmp_path):
    bridge_obj, result, events = bridge
    doc = tmp_path / "notes.md"
    doc.write_text("first\n", encoding="utf-8")
    bridge_obj.grants.allow_write(str(doc))
    _invoke(bridge_obj, "readTextFile", {"path": str(doc)}, 6)
    assert _wait_for(lambda: result.get(6))["ok"] is True
    _invoke(bridge_obj, "writeTextFile", {"path": str(doc), "content": "second\n", "history": True}, 7)
    assert _wait_for(lambda: result.get(7))["ok"] is True
    _settle()
    assert events == []


def test_a_rename_over_an_unseen_change_is_refused(bridge, tmp_path):
    bridge_obj, result, _events = bridge
    old = tmp_path / "notes.md"
    old.write_text("first\n", encoding="utf-8")
    bridge_obj.grants.allow_write(str(old))
    _invoke(bridge_obj, "readTextFile", {"path": str(old)}, 8)
    assert _wait_for(lambda: result.get(8))["ok"] is True
    _replace(old, "the agent's\n")

    new = tmp_path / "ideas.md"
    bridge_obj.grants.allow_write(str(new))
    _invoke(bridge_obj, "renameTextFile", {"oldPath": str(old), "newPath": str(new), "content": "mine"}, 9)
    refused = _wait_for(lambda: result.get(9))
    assert refused["code"] == "changedOnDisk"
    assert old.read_text(encoding="utf-8") == "the agent's\n"
    assert not new.exists()
