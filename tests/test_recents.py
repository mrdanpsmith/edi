"""Tests for the recent-documents ranking (`backend/recents.py`)."""

from __future__ import annotations

import json

import pytest
from PySide6.QtCore import QSettings

from backend import recents
from backend.recents import Recents

DAY = 86400.0


class Clock:
    def __init__(self) -> None:
        self.now = 1_800_000_000.0

    def __call__(self) -> float:
        return self.now

    def days(self, count: float) -> None:
        self.now += count * DAY


@pytest.fixture
def settings(qapp, tmp_path):
    return QSettings(str(tmp_path / "recents.ini"), QSettings.Format.IniFormat)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def missing():
    return set()


@pytest.fixture
def store(settings, clock, missing):
    return Recents(settings, now=clock, exists=lambda path: path not in missing)


def test_a_document_opened_daily_outranks_a_week_of_one_off_files(store, clock):
    for day in range(10):
        store.opened("/daily.md")
        for index in range(3):
            store.opened(f"/once-{day}-{index}.md")
        clock.days(1)
    shown = store.shown()
    assert len(shown) == recents.SHOWN
    assert shown[0] == "/daily.md"


def test_the_latest_opens_are_shown_whatever_their_score(store, clock):
    for index in range(recents.SHOWN):
        for _ in range(5):
            store.opened(f"/regular-{index}.md")
    clock.days(1)
    store.opened("/new-a.md")
    store.opened("/new-b.md")
    shown = store.shown()
    assert len(shown) == recents.SHOWN
    # Scored at one open each they would not make the list; they are the
    # two most recent opens, so they do.
    assert "/new-a.md" in shown and "/new-b.md" in shown


def test_old_opens_fade(store, clock):
    for _ in range(5):
        store.opened("/was-busy.md")
    clock.days(60)
    store.opened("/today.md")
    store.opened("/today.md")
    assert store.shown() == ["/today.md", "/was-busy.md"]


def test_a_missing_file_is_hidden_and_comes_back_with_its_rank(store, missing):
    for _ in range(3):
        store.opened("/branch-only.md")
    store.opened("/other.md")
    missing.add("/branch-only.md")
    assert store.shown() == ["/other.md"]
    missing.clear()
    assert store.shown() == ["/branch-only.md", "/other.md"]


def test_a_missing_file_does_not_take_a_shown_place(store, missing, clock):
    for index in range(recents.SHOWN + 2):
        store.opened(f"/doc-{index}.md")
        clock.days(0.01)
    missing.add("/doc-0.md")
    shown = store.shown()
    assert len(shown) == recents.SHOWN
    assert "/doc-0.md" not in shown


def test_the_number_of_documents_is_capped_but_not_the_opens(store, settings, clock):
    for index in range(recents.TRACKED + 10):
        store.opened(f"/doc-{index}.md")
        clock.days(0.01)
    stored = json.loads(settings.value(recents.KEY))
    assert len(stored) == recents.TRACKED
    for _ in range(250):
        store.opened("/doc-0.md")
    busy = next(row for row in store.history() if row["path"] == "/doc-0.md")
    assert busy["opens"] == 250


def test_the_running_score_is_the_sum_of_every_open_decayed(store, clock):
    # Opens 14, 7 and 0 days ago weigh 1/4, 1/2 and 1.
    store.opened("/a.md")
    clock.days(7)
    store.opened("/a.md")
    clock.days(7)
    store.opened("/a.md")
    (row,) = store.history()
    assert row["score"] == pytest.approx(1.75)
    clock.days(7)
    (row,) = store.history()
    assert row["score"] == pytest.approx(0.875)
    assert row["opens"] == 3


def test_entries_holding_open_times_are_read_as_a_count_and_a_score(store, settings, clock):
    week = 7 * DAY
    settings.setValue(
        recents.KEY,
        json.dumps([{"path": "/old-shape.md", "opens": [clock.now, clock.now - week, clock.now - 2 * week]}]),
    )
    (row,) = store.history()
    assert row["opens"] == 3
    assert row["score"] == pytest.approx(1.75)
    store.opened("/old-shape.md")
    stored = json.loads(settings.value(recents.KEY))
    assert stored == [{"path": "/old-shape.md", "count": 4, "last": clock.now, "score": pytest.approx(2.75)}]


def test_move_onto_a_remembered_name_merges_the_two(store, clock):
    store.opened("/new.md")
    clock.days(7)
    store.opened("/old.md")
    store.opened("/old.md")
    store.move("/old.md", "/new.md")
    (row,) = store.history()
    assert row["path"] == "/new.md"
    assert row["opens"] == 3
    assert row["score"] == pytest.approx(2.5)


def test_forget_drops_the_document_and_its_history(store):
    store.opened("/a.md")
    store.opened("/b.md")
    store.forget("/b.md")
    assert store.shown() == ["/a.md"]
    store.forget("/never.md")
    assert store.shown() == ["/a.md"]


def test_move_keeps_the_rank_under_the_new_name(store):
    for _ in range(4):
        store.opened("/old.md")
    store.opened("/other.md")
    store.move("/old.md", "/new.md")
    assert store.shown() == ["/new.md", "/other.md"]
    # Moving something never opened is not an open of its new name.
    store.move("/never.md", "/elsewhere.md")
    assert store.shown() == ["/new.md", "/other.md"]


def test_history_lists_every_document_with_its_rank_and_place(store, missing):
    for _ in range(3):
        store.opened("/busy.md")
    store.opened("/gone.md")
    missing.add("/gone.md")
    rows = store.history()
    assert [row["path"] for row in rows] == ["/busy.md", "/gone.md"]
    busy, gone = rows
    assert busy["opens"] == 3 and busy["shown"] and busy["exists"]
    assert busy["score"] == pytest.approx(3.0)
    assert not gone["shown"] and not gone["exists"]


def test_clear_forgets_everything_including_the_old_list(store, settings):
    store.opened("/a.md")
    settings.setValue(recents.LEGACY_KEY, ["/old.md"])
    store.clear()
    assert store.history() == []
    assert store.shown() == []
    assert not settings.contains(recents.LEGACY_KEY)


def test_the_old_list_is_read_once_in_order(store, settings):
    settings.setValue(recents.LEGACY_KEY, ["/first.md", "/second.md", "/third.md"])
    assert store.shown() == ["/first.md", "/second.md", "/third.md"]
    assert not settings.contains(recents.LEGACY_KEY)
    assert settings.contains(recents.KEY)


def test_a_hand_broken_store_reads_as_what_is_still_valid(store, settings):
    settings.setValue(
        recents.KEY,
        json.dumps([
            {"path": "/good.md", "opens": [1_800_000_000.0]},
            {"path": "", "opens": [1]},
            {"path": "/no-opens.md", "opens": []},
            {"path": "/bad-opens.md", "opens": ["yesterday", True]},
            "junk",
        ]),
    )
    assert store.shown() == ["/good.md"]
    settings.setValue(recents.KEY, "{not json")
    assert store.shown() == []
