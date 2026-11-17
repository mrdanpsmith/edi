"""Tests for reopening the last session's documents (`backend/session.py`)."""

from __future__ import annotations

import json

import pytest
from PySide6.QtCore import QSettings

from backend import session
from backend.bridge import Bridge

from tests.test_bridge import StubWindow, _invoke, _wait_for


@pytest.fixture(autouse=True)
def no_stored_session(qapp):
    settings = QSettings()
    settings.remove("session")
    settings.sync()
    yield
    settings.remove("session")
    settings.sync()


def _bridge(restore_session: bool) -> tuple[Bridge, dict[int, dict]]:
    bridge = Bridge(StubWindow(), restore_session=restore_session)
    result: dict[int, dict] = {}
    bridge.result.connect(lambda payload: result.update({json.loads(payload)["id"]: json.loads(payload)}))
    return bridge, result


def _call(bridge, result, method, payload, request_id):
    _invoke(bridge, method, payload, request_id)
    reply = _wait_for(lambda: result.get(request_id))
    assert reply["ok"] is True, reply
    return reply.get("data")


def test_the_open_documents_come_back_next_launch_with_their_grants(tmp_path):
    a, b = tmp_path / "a.md", tmp_path / "b.md"
    for doc in (a, b):
        doc.write_text("text\n", encoding="utf-8")
    first, result = _bridge(restore_session=True)
    for doc in (a, b):
        first.grants.allow_write(str(doc))
    _call(first, result, "setOpenFiles", {"paths": [str(a), str(b)], "active": str(b)}, 1)
    first.shutdown()

    second, result = _bridge(restore_session=True)
    value = _call(second, result, "getSession", {}, 2)
    assert value == {"paths": [str(a), str(b)], "active": str(b)}
    # Reopened, a document may be saved again without asking.
    assert second.grants.may_write(str(a)) and second.grants.may_write(str(b))


def test_only_documents_with_a_grant_are_kept(tmp_path):
    granted, stranger = tmp_path / "a.md", tmp_path / "secret.md"
    for doc in (granted, stranger):
        doc.write_text("text\n", encoding="utf-8")
    bridge, result = _bridge(restore_session=True)
    bridge.grants.allow_write(str(granted))
    # The page cannot grant itself access to a path by storing it as a session.
    _call(bridge, result, "setOpenFiles", {"paths": [str(granted), str(stranger)], "active": str(stranger)}, 3)
    assert session.load() == {"paths": [str(granted)], "active": None}


def test_a_document_whose_file_is_gone_is_not_reopened(tmp_path):
    kept, gone = tmp_path / "a.md", tmp_path / "gone.md"
    kept.write_text("text\n", encoding="utf-8")
    session.save([str(kept), str(gone)], str(gone))
    assert session.load() == {"paths": [str(kept)], "active": None}


def test_a_one_document_session_survives_the_ini_round_trip(tmp_path):
    doc = tmp_path / "a.md"
    doc.write_text("text\n", encoding="utf-8")
    session.save([str(doc)], str(doc))
    # An INI file hands a one-entry list back as a bare string.
    QSettings().setValue(session.PATHS_KEY, str(doc))
    assert session.load() == {"paths": [str(doc)], "active": str(doc)}


def test_a_window_that_does_not_restore_reopens_nothing(tmp_path):
    doc = tmp_path / "a.md"
    doc.write_text("text\n", encoding="utf-8")
    session.save([str(doc)], str(doc))
    bridge, result = _bridge(restore_session=False)
    assert _call(bridge, result, "getSession", {}, 4) == {"paths": [], "active": None}
    assert not bridge.grants.may_write(str(doc))
