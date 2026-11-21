"""The recent documents: File › Open Recent and the launcher's list.

Ranked by *frecency*, not by last open alone. Every open counts toward a
document's score, and an open's weight halves every ``HALF_LIFE_DAYS``. A
document opened every day stays near the top through a week of one-off files;
a file opened once sinks within days. Ranking by last open alone would push a
daily document off the list after a handful of other files.

The score is kept as a running total rather than worked out from every open:
each document stores its open count, its last open, and its score as of that
open. At any later moment the score is that value decayed by the time since,
and an open decays it to now and adds 1. That is exactly the sum of every
open's decayed weight, with nothing to cap: the count grows as long as the
document is opened.

The ``SHOWN`` documents on the list are the best-scored ones that still exist,
plus the ``ALWAYS_SHOWN`` most recently opened, so a file opened a minute ago
is never missing from the list just because it has no history yet.

A document whose file is gone is skipped but keeps its history: a git branch
switch, an unmounted drive or a sync tool can bring the file back, and it
returns with its rank. That holds for a file Edi itself moved to the Trash, so
Manage Recent Documents can recover it. It leaves the history only by ageing
out, or when removed there.

Only opens count. A save is not the reader choosing the document again, and
counting saves would rank a document by how often it was saved.

Stored as JSON under ``recentDocuments`` in ``QSettings``, one entry per
document, best first. Two older shapes are read and replaced on the next
write: entries holding a list of open times (``opens``), and the ``recentFiles``
list (last opened first).

Every path here came in with a write grant (``Bridge._add_recent_file``), and
the shown list grants write access again when a path on it is reopened.
"""

from __future__ import annotations

import json
import os
import time
from typing import Callable

from PySide6.QtCore import QSettings

KEY = "recentDocuments"
LEGACY_KEY = "recentFiles"

#: Documents on File › Open Recent and the launcher.
SHOWN = 8
#: The most recently opened documents, shown whatever their score.
ALWAYS_SHOWN = 3
#: Documents remembered, shown or not. Room for the files that fall off the
#: shown list in a busy week to come back when they are opened again.
TRACKED = 50
HALF_LIFE_DAYS = 7.0

_DAY = 86400.0

#: ``{"path": str, "count": int, "last": epoch seconds, "score": score at last}``
Entry = dict


def _decay(seconds: float) -> float:
    return 0.5 ** (max(seconds, 0.0) / _DAY / HALF_LIFE_DAYS)


def _score(entry: Entry, now: float) -> float:
    return entry["score"] * _decay(now - entry["last"])


def _ranked(entries: list[Entry], now: float) -> list[Entry]:
    """Best score first; the later last open breaks a tie."""
    return sorted(entries, key=lambda entry: (_score(entry, now), entry["last"]), reverse=True)


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value == value else None  # not NaN


def _entry(item) -> Entry | None:
    """One stored entry, in either shape, or ``None`` if a hand edit broke it."""
    if not isinstance(item, dict):
        return None
    path = item.get("path")
    if not isinstance(path, str) or not path:
        return None
    opens = item.get("opens")
    if isinstance(opens, list):
        # The shape before running scores: the last open times themselves.
        stamps = sorted((stamp for stamp in map(_number, opens) if stamp is not None), reverse=True)
        if not stamps:
            return None
        last = stamps[0]
        return {"path": path, "count": len(stamps), "last": last, "score": sum(_decay(last - t) for t in stamps)}
    count, last, score = item.get("count"), _number(item.get("last")), _number(item.get("score"))
    if isinstance(count, bool) or not isinstance(count, int) or count < 1 or last is None or score is None or score <= 0:
        return None
    return {"path": path, "count": count, "last": last, "score": score}


def _clean(raw) -> list[Entry]:
    """The stored entries, with anything a hand edit broke left out."""
    entries: list[Entry] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        entry = _entry(item)
        if entry is not None and entry["path"] not in seen:
            seen.add(entry["path"])
            entries.append(entry)
    return entries


def _legacy(value, now: float) -> list[Entry]:
    """The old last-opened-first list, as one open each, a minute apart.

    A minute keeps the old order and is too little to separate the scores of
    documents the reader will now open again for real.
    """
    if isinstance(value, str):
        value = [value] if value else []
    paths = [str(path) for path in value if path] if isinstance(value, (list, tuple)) else []
    unique = list(dict.fromkeys(paths))
    return [{"path": path, "count": 1, "last": now - 60.0 * index, "score": 1.0} for index, path in enumerate(unique)]


class Recents:
    """The recent-documents history in ``QSettings``.

    Tests pass their own ``settings``, clock and existence check: the history
    is the user's file, and the ranking depends on time and on what is on disk.
    """

    def __init__(
        self,
        settings: QSettings | None = None,
        now: Callable[[], float] = time.time,
        exists: Callable[[str], bool] = os.path.isfile,
    ) -> None:
        self._settings = settings
        self._now = now
        self._exists = exists

    def _store(self) -> QSettings:
        # A fresh QSettings each time when none was given, as `session.py`
        # does: the app's org and name are set after this module is imported.
        return self._settings if self._settings is not None else QSettings()

    def _load(self) -> list[Entry]:
        settings = self._store()
        raw = settings.value(KEY, None)
        if raw is None and settings.contains(LEGACY_KEY):
            entries = _legacy(settings.value(LEGACY_KEY, []), self._now())
            self._save(entries)
            settings.remove(LEGACY_KEY)
            return entries
        try:
            return _clean(json.loads(raw)) if isinstance(raw, str) else []
        except ValueError:
            return []

    def _save(self, entries: list[Entry]) -> None:
        self._store().setValue(KEY, json.dumps(entries, separators=(",", ":")))

    def _shown(self, entries: list[Entry], now: float) -> list[str]:
        existing = [entry for entry in entries if self._exists(entry["path"])]
        latest = sorted(existing, key=lambda entry: entry["last"], reverse=True)[:ALWAYS_SHOWN]
        best = _ranked(existing, now)
        chosen = {entry["path"] for entry in latest}
        for entry in best:
            if len(chosen) >= SHOWN:
                break
            chosen.add(entry["path"])
        return [entry["path"] for entry in best if entry["path"] in chosen]

    def shown(self) -> list[str]:
        """The documents to offer, best first: existing files only, ``SHOWN`` at most."""
        return self._shown(self._load(), self._now())

    def history(self) -> list[dict]:
        """Every tracked document, best first, for File › Open Recent › Manage.

        Each is ``{"path", "opens", "lastOpened", "score", "exists", "shown"}``:
        ``opens`` is every open counted, and ``shown`` says whether it is on
        the list right now.
        """
        now = self._now()
        entries = self._load()
        shown = set(self._shown(entries, now))
        return [
            {
                "path": entry["path"],
                "opens": entry["count"],
                "lastOpened": entry["last"],
                "score": _score(entry, now),
                "exists": self._exists(entry["path"]),
                "shown": entry["path"] in shown,
            }
            for entry in _ranked(entries, now)
        ]

    def clear(self) -> None:
        """Forget every document and its history."""
        settings = self._store()
        settings.setValue(KEY, "[]")
        settings.remove(LEGACY_KEY)

    def opened(self, path: str) -> None:
        """Count an open of ``path``."""
        now = self._now()
        entries = self._load()
        entry = next((entry for entry in entries if entry["path"] == path), None)
        if entry is None:
            entries.append({"path": path, "count": 1, "last": now, "score": 1.0})
        else:
            entry.update(count=entry["count"] + 1, score=_score(entry, now) + 1.0, last=now)
        self._save(_ranked(entries, now)[:TRACKED])

    def forget(self, path: str) -> None:
        """Drop ``path`` and its history (Manage Recent Documents' Remove)."""
        entries = self._load()
        kept = [entry for entry in entries if entry["path"] != path]
        if len(kept) != len(entries):
            self._save(kept)

    def move(self, old_path: str, new_path: str) -> None:
        """Carry ``old_path``'s history to ``new_path``, for a rename, a move or
        a recovery to another folder.

        The document is the same one, so it keeps its rank. A history
        ``new_path`` already had (an older file of that name, now overwritten)
        is merged in: counts add, and both scores are taken to the later open.
        """
        entries = self._load()
        old = next((entry for entry in entries if entry["path"] == old_path), None)
        if old is None or old_path == new_path:
            return
        target = next((entry for entry in entries if entry["path"] == new_path), None)
        rest = [entry for entry in entries if entry["path"] not in (old_path, new_path)]
        merged = {**old, "path": new_path}
        if target is not None:
            last = max(old["last"], target["last"])
            merged = {
                "path": new_path,
                "count": old["count"] + target["count"],
                "last": last,
                "score": _score(old, last) + _score(target, last),
            }
        self._save(_ranked([*rest, merged], self._now()))
