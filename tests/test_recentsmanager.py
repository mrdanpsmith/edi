"""Tests for File › Open Recent › Manage Recent Documents… (`backend/recentsmanager.py`).

Built on its own with real files, a store in a temp settings file, a temp
version-history store and stand-ins for what the window hands the dialog.
"""

from __future__ import annotations

import pytest
from PySide6.QtCore import QSettings, Qt
from PySide6.QtWidgets import QApplication, QMessageBox

from backend import history
from backend.recents import Recents
from backend.recentsmanager import RecentsManager, confirm_clear


@pytest.fixture(autouse=True)
def history_store(tmp_path, monkeypatch):
    monkeypatch.setenv(history.ROOT_ENV, str(tmp_path / "history"))


@pytest.fixture
def store(qapp, tmp_path):
    return Recents(QSettings(str(tmp_path / "recents.ini"), QSettings.Format.IniFormat))


@pytest.fixture
def docs(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    return folder


def _doc(folder, name: str, *, saved: bool = True) -> str:
    """A document on disk; ``saved`` gives it a version history, as opening it in Edi does."""
    path = folder / name
    path.write_text(f"# {name}", encoding="utf-8")
    if saved:
        history.record(str(path))
    return str(path)


@pytest.fixture
def manager(qtbot, store):
    calls = {"opened": [], "changed": 0, "flashed": []}

    def changed() -> None:
        calls["changed"] += 1

    def make() -> RecentsManager:
        dialog = RecentsManager(
            None, open_files=calls["opened"].extend, changed=changed, flash=calls["flashed"].append, store=store
        )
        dialog.calls = calls
        dialog.show()
        qtbot.addWidget(dialog)
        return dialog

    return make


def _box(qtbot) -> QMessageBox:
    def find():
        return next((w for w in QApplication.topLevelWidgets() if isinstance(w, QMessageBox) and w.isVisible()), None)

    qtbot.waitUntil(lambda: find() is not None, timeout=3000)
    return find()


def _answer(qtbot, label: str) -> None:
    """Press ``label`` in the message box that is up."""
    box = _box(qtbot)
    next(b for b in box.buttons() if b.text().replace("&", "") == label).click()


def test_lists_every_remembered_document_best_first_with_its_place(manager, store, docs):
    busy, gone, once = _doc(docs, "busy.md"), _doc(docs, "gone.md"), _doc(docs, "once.md")
    for _ in range(3):
        store.opened(busy)
    # Equal scores: the later open ranks first.
    store.opened(gone)
    store.opened(once)
    (docs / "gone.md").unlink()
    dialog = manager()
    assert dialog.rows() == [(busy, "On the list"), (once, "On the list"), (gone, "Missing")]
    assert dialog.count.text() == "3 documents remembered, 2 on the list, 1 missing"


def test_every_column_sorts(manager, store, docs):
    a, b, c = _doc(docs, "a.md"), _doc(docs, "b.md"), _doc(docs, "c.md")
    store.opened(b)
    for _ in range(3):
        store.opened(c)
    for _ in range(2):
        store.opened(a)
    dialog = manager()
    assert [path for path, _ in dialog.rows()] == [c, a, b]
    dialog.tree.sortByColumn(0, Qt.SortOrder.AscendingOrder)
    assert [path for path, _ in dialog.rows()] == [a, b, c]
    dialog.tree.sortByColumn(2, Qt.SortOrder.AscendingOrder)
    assert [path for path, _ in dialog.rows()] == [b, a, c]
    dialog.tree.sortByColumn(3, Qt.SortOrder.DescendingOrder)
    assert [path for path, _ in dialog.rows()][0] == a
    # The order chosen holds through a refresh.
    dialog.refresh()
    assert [path for path, _ in dialog.rows()][0] == a


def test_opens_are_counted_without_a_cap(manager, store, docs):
    path = _doc(docs, "daily.md")
    for _ in range(42):
        store.opened(path)
    dialog = manager()
    assert dialog.tree.topLevelItem(0).text(2) == "42"


def test_remove_forgets_the_selection_and_tells_the_page(manager, store, docs):
    a, b = _doc(docs, "a.md"), _doc(docs, "b.md")
    store.opened(a)
    store.opened(b)
    dialog = manager()
    dialog.select([a])
    dialog.remove_button.click()
    assert [path for path, _ in dialog.rows()] == [b]
    assert store.shown() == [b]
    assert dialog.calls["changed"] == 1


def test_open_is_only_for_files_that_are_there(manager, store, docs):
    here, gone = _doc(docs, "here.md"), _doc(docs, "gone.md")
    store.opened(here)
    store.opened(gone)
    (docs / "gone.md").unlink()
    dialog = manager()
    dialog.select([gone])
    assert not dialog.open_button.isEnabled()
    dialog.select([here])
    assert dialog.open_button.isEnabled()
    assert not dialog.recover_button.isEnabled()
    dialog.open_button.click()
    assert dialog.calls["opened"] == [here]


def test_recover_puts_a_deleted_document_back_and_opens_it(manager, store, docs):
    path = _doc(docs, "notes.md")
    for _ in range(3):
        store.opened(path)
    (docs / "notes.md").unlink()
    dialog = manager()
    dialog.select([path])
    assert dialog.recover_button.isEnabled()
    dialog.recover_button.click()
    assert (docs / "notes.md").read_text(encoding="utf-8") == "# notes.md"
    assert dialog.calls["opened"] == [path]
    assert dialog.calls["flashed"] == ["Recovered 1 document"]
    assert dialog.calls["changed"] == 1
    # Back on the list with its rank.
    assert dialog.rows() == [(path, "On the list")]
    assert next(row for row in store.history() if row["path"] == path)["opens"] == 3


def test_recover_asks_before_making_a_deleted_folder_again(manager, store, tmp_path, qtbot):
    folder = tmp_path / "gone-folder"
    folder.mkdir()
    path = _doc(folder, "notes.md")
    store.opened(path)
    (folder / "notes.md").unlink()
    folder.rmdir()
    dialog = manager()
    assert dialog.rows() == [(path, "Folder missing")]
    dialog.select([path])
    dialog.recover_button.click()
    _answer(qtbot, "Recreate Folder")
    assert (folder / "notes.md").is_file()
    assert dialog.calls["opened"] == [path]


def test_a_missing_document_with_no_saved_copy_can_only_be_removed(manager, store, docs):
    path = _doc(docs, "never-saved.md", saved=False)
    store.opened(path)
    (docs / "never-saved.md").unlink()
    dialog = manager()
    assert dialog.rows() == [(path, "Missing, no saved copy")]
    dialog.select([path])
    assert not dialog.recover_button.isEnabled()
    assert dialog.remove_button.isEnabled()


def test_clear_all_asks_first(manager, store, docs, qtbot):
    a = _doc(docs, "a.md")
    store.opened(a)
    dialog = manager()
    dialog.clear_button.click()
    _answer(qtbot, "Cancel")
    assert store.shown() == [a]
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
