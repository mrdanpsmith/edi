"""Tests for File › Manage Version History… (`backend/historymanager.py`).

The dialog needs Qt widgets but no page, so it is built here on its own with
stand-ins for what the window hands it.
"""

from __future__ import annotations

import os

import pytest
from PySide6.QtWidgets import QApplication, QFileDialog, QMessageBox

from backend import history
from backend.historymanager import HistoryManager


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setenv(history.ROOT_ENV, str(tmp_path / "store"))


@pytest.fixture
def docs(tmp_path):
    folder = tmp_path / "docs"
    folder.mkdir()
    return folder


@pytest.fixture
def manager(qapp, qtbot):
    calls = {"opened": [], "flashed": [], "watched": []}

    def make() -> HistoryManager:
        dialog = HistoryManager(
            None,
            open_files=calls["opened"].extend,
            flash=calls["flashed"].append,
            watched=lambda: list(calls["watched"]),
        )
        dialog.calls = calls
        dialog.show()
        qtbot.addWidget(dialog)
        return dialog

    return make


def _save(path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    history.record(str(path))


def _rows(dialog) -> list[tuple[str, str]]:
    tree = dialog.tree
    return sorted((tree.topLevelItem(i).text(0), tree.topLevelItem(i).text(2)) for i in range(tree.topLevelItemCount()))


def _prompt(qtbot, cls=QMessageBox):
    found = {}

    def ready():
        for widget in QApplication.topLevelWidgets():
            if isinstance(widget, cls) and widget.isVisible():
                found["widget"] = widget
                return True
        return False

    qtbot.waitUntil(ready, timeout=3000)
    return found["widget"]


def _click(qtbot, box: QMessageBox, text: str) -> None:
    button = next(b for b in box.buttons() if b.text() == text)
    button.click()
    qtbot.waitUntil(lambda: not box.isVisible(), timeout=3000)


def test_it_lists_every_document_and_filters_by_where_it_stands(manager, docs):
    _save(docs / "kept.md", "kept\n")
    _save(docs / "gone.md", "gone\n")
    (docs / "gone.md").unlink()
    dialog = manager()

    assert dialog.filter.currentText() == "All documents"
    assert _rows(dialog) == [("gone.md", "Missing"), ("kept.md", "On disk")]
    assert dialog.count.text() == "2 of 2 documents"
    dialog.filter.setCurrentIndex(1)
    assert _rows(dialog) == [("gone.md", "Missing")]
    dialog.filter.setCurrentIndex(2)
    assert _rows(dialog) == [("kept.md", "On disk")]


def test_selecting_one_previews_its_newest_version_and_says_what_can_be_done(manager, docs):
    _save(docs / "kept.md", "old\n")
    _save(docs / "kept.md", "# Newest\n")
    _save(docs / "gone.md", "gone\n")
    (docs / "gone.md").unlink()
    dialog = manager()

    dialog.select([os.path.realpath(docs / "kept.md")])
    assert dialog.preview.toPlainText() == "# Newest\n"
    assert dialog.delete_button.isEnabled() and not dialog.recover_button.isEnabled()
    dialog.select([os.path.realpath(docs / "gone.md")])
    assert dialog.recover_button.isEnabled()
    dialog.select([os.path.realpath(docs / "gone.md"), os.path.realpath(docs / "kept.md")])
    assert dialog.preview.toPlainText() == "2 documents selected."
    assert not dialog.recover_button.isEnabled()


def test_delete_history_asks_then_removes_only_the_selection(manager, docs, qtbot):
    for name in ("a.md", "b.md", "c.md"):
        _save(docs / name, name)
    dialog = manager()
    dialog.calls["watched"].append(str(docs / "a.md"))
    dialog.select([os.path.realpath(docs / "a.md"), os.path.realpath(docs / "b.md")])

    dialog.delete_button.click()
    box = _prompt(qtbot)
    assert box.text() == "Delete the version history of 2 documents?"
    _click(qtbot, box, "Delete History")

    # a.md is open, so it starts again; b.md is gone; c.md was not selected.
    assert sorted(os.path.basename(d["path"]) for d in history.stored_documents()) == ["a.md", "c.md"]
    assert [v["message"] for v in history.list_versions(str(docs / "a.md"))] == ["History cleared"]
    assert dialog.calls["flashed"] == ["Deleted the history of 2 documents"]
    assert (docs / "b.md").exists()


def test_cancelling_delete_keeps_everything(manager, docs, qtbot):
    _save(docs / "a.md", "a")
    dialog = manager()
    dialog.select([os.path.realpath(docs / "a.md")])
    dialog.delete_button.click()
    box = _prompt(qtbot)
    box.button(QMessageBox.StandardButton.Cancel).click()
    qtbot.waitUntil(lambda: not box.isVisible(), timeout=3000)
    assert len(history.stored_documents()) == 1


def test_recover_puts_a_document_back_where_its_folder_still_is_and_opens_it(manager, docs):
    _save(docs / "gone.md", "gone\n")
    (docs / "gone.md").unlink()
    dialog = manager()
    dialog.select([os.path.realpath(docs / "gone.md")])

    dialog.recover_button.click()
    assert (docs / "gone.md").read_text(encoding="utf-8") == "gone\n"
    assert dialog.calls["opened"] == [os.path.realpath(docs / "gone.md")]
    assert dialog.calls["flashed"] == ["Recovered 1 document"]
    assert _rows(dialog) == [("gone.md", "On disk")]


def test_recover_into_a_wiped_folder_asks_once_and_names_the_folders(manager, docs, qtbot):
    folder = docs / "2025" / "q4"
    folder.mkdir(parents=True)
    for name in ("plan.md", "ideas.md"):
        _save(folder / name, name)
        (folder / name).unlink()
    folder.rmdir()
    (docs / "2025").rmdir()
    dialog = manager()
    dialog.select([os.path.realpath(folder / "plan.md"), os.path.realpath(folder / "ideas.md")])

    dialog.recover_button.click()
    box = _prompt(qtbot)
    assert "no longer exists" in box.text()
    assert str(docs / "2025") in box.informativeText().replace("~", os.path.expanduser("~"))
    _click(qtbot, box, "Recreate Folder")

    assert sorted(p.name for p in folder.iterdir()) == ["ideas.md", "plan.md"]
    assert len(dialog.calls["opened"]) == 2


def test_skipping_a_wiped_folder_creates_nothing(manager, docs, qtbot):
    folder = docs / "gone-folder"
    folder.mkdir()
    _save(folder / "a.md", "a")
    (folder / "a.md").unlink()
    folder.rmdir()
    dialog = manager()
    dialog.select([os.path.realpath(folder / "a.md")])

    dialog.recover_button.click()
    _click(qtbot, _prompt(qtbot), "Skip")
    assert not folder.exists()
    assert dialog.calls["opened"] == []


def test_recover_to_another_folder_keeps_the_name_and_the_history(manager, docs, tmp_path, qtbot, monkeypatch):
    folder = docs / "gone-folder"
    folder.mkdir()
    _save(folder / "a.md", "one\n")
    _save(folder / "a.md", "two\n")
    (folder / "a.md").unlink()
    folder.rmdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    dialog = manager()
    dialog.select([os.path.realpath(folder / "a.md")])

    dialog.recover_button.click()
    _click(qtbot, _prompt(qtbot), "Choose Another Folder…")
    picker = _prompt(qtbot, QFileDialog)
    monkeypatch.setattr(picker, "selectedFiles", lambda: [str(elsewhere)])
    picker.accept()

    qtbot.waitUntil(lambda: (elsewhere / "a.md").exists(), timeout=3000)
    assert (elsewhere / "a.md").read_text(encoding="utf-8") == "two\n"
    assert len(history.list_versions(str(elsewhere / "a.md"))) == 2
    assert not folder.exists()


def test_recover_reports_what_it_could_not_put_back(manager, docs, qtbot, monkeypatch):
    _save(docs / "a.md", "a")
    (docs / "a.md").unlink()
    dialog = manager()
    dialog.select([os.path.realpath(docs / "a.md")])

    # Something appears at the path between listing and writing.
    real_recover = history.recover

    def racing(path, destination, make_folders=False):
        (docs / "a.md").write_text("theirs", encoding="utf-8")
        return real_recover(path, destination, make_folders=make_folders)

    monkeypatch.setattr(history, "recover", racing)
    dialog.recover_button.click()
    box = _prompt(qtbot)
    assert box.text() == "1 document could not be recovered."
    assert (docs / "a.md").read_text(encoding="utf-8") == "theirs"
    assert dialog.calls["opened"] == []
