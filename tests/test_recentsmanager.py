"""Tests for File › Open Recent › Manage Recent Documents… (`backend/recentsmanager.py`).

Built on its own with a store in a temp settings file, a fixed existence check
and stand-ins for what the window hands the dialog.
"""

from __future__ import annotations

import pytest
from PySide6.QtCore import QSettings
from PySide6.QtWidgets import QApplication, QMessageBox

from backend.recents import Recents
from backend.recentsmanager import RecentsManager, confirm_clear


@pytest.fixture
def missing():
    return set()


@pytest.fixture
def store(qapp, tmp_path, missing):
    settings = QSettings(str(tmp_path / "recents.ini"), QSettings.Format.IniFormat)
    return Recents(settings, exists=lambda path: path not in missing)


@pytest.fixture
def manager(qtbot, store):
    calls = {"opened": [], "changed": 0}

    def changed() -> None:
        calls["changed"] += 1

    def make() -> RecentsManager:
        dialog = RecentsManager(None, open_files=calls["opened"].extend, changed=changed, store=store)
        dialog.calls = calls
        dialog.show()
        qtbot.addWidget(dialog)
        return dialog

    return make


def _answer(qtbot, label: str) -> None:
    """Press ``label`` in the message box that is up."""

    def box():
        return next((w for w in QApplication.topLevelWidgets() if isinstance(w, QMessageBox) and w.isVisible()), None)

    qtbot.waitUntil(lambda: box() is not None, timeout=3000)
    found = box()
    button = next(b for b in found.buttons() if b.text().replace("&", "") == label)
    button.click()


def test_lists_every_remembered_document_best_first_with_its_place(manager, store, missing):
    for _ in range(3):
        store.opened("/docs/busy.md")
    # Equal scores: the later open ranks first.
    store.opened("/docs/gone.md")
    store.opened("/docs/once.md")
    missing.add("/docs/gone.md")
    dialog = manager()
    assert dialog.rows() == [
        ("/docs/busy.md", "On the list"),
        ("/docs/once.md", "On the list"),
        ("/docs/gone.md", "Missing"),
    ]
    assert "3 documents remembered, 2 on the list, 1 missing" == dialog.count.text()


def test_remove_forgets_the_selection_and_tells_the_page(manager, store):
    store.opened("/a.md")
    store.opened("/b.md")
    dialog = manager()
    dialog.select(["/a.md"])
    dialog.remove_button.click()
    assert [path for path, _ in dialog.rows()] == ["/b.md"]
    assert store.shown() == ["/b.md"]
    assert dialog.calls["changed"] == 1


def test_open_is_only_for_files_that_are_there(manager, store, missing):
    store.opened("/here.md")
    store.opened("/gone.md")
    missing.add("/gone.md")
    dialog = manager()
    dialog.select(["/gone.md"])
    assert not dialog.open_button.isEnabled()
    dialog.select(["/here.md"])
    assert dialog.open_button.isEnabled()
    dialog.open_button.click()
    assert dialog.calls["opened"] == ["/here.md"]


def test_clear_all_asks_first(manager, store, qtbot):
    store.opened("/a.md")
    dialog = manager()
    dialog.clear_button.click()
    _answer(qtbot, "Cancel")
    assert store.shown() == ["/a.md"]
    dialog.clear_button.click()
    _answer(qtbot, "Clear")
    assert dialog.rows() == []
    assert store.history() == []
    assert dialog.calls["changed"] == 1
    assert not dialog.clear_button.isEnabled()


def test_confirm_clear_alone_clears_on_a_yes(qapp, qtbot, store):
    store.opened("/a.md")
    done = []
    confirm_clear(None, store, lambda: done.append(True))
    _answer(qtbot, "Clear")
    assert done == [True]
    assert store.history() == []
