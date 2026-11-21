"""The recent documents: File › Open Recent and the launcher's list.

Ranked by *frecency*, not by last open alone. Each document keeps the times it
was last opened, every open counts toward its score, and an open's weight
halves every ``HALF_LIFE_DAYS``. A document opened every day stays near the
top through a week of one-off files; a file opened once sinks within days.
Ranking by last open alone would push a daily document off the list after a
handful of other files.

The ``SHOWN`` documents on the list are the best-scored ones that still exist,
plus the ``ALWAYS_SHOWN`` most recently opened, so a file opened a minute ago
is never missing from the list just because it has no history yet.

A document whose file is gone is skipped but keeps its history: a git branch
switch, an unmounted drive or a sync tool can bring the file back, and it
returns with its rank. It leaves the history only by ageing out, or straight
away when Edi itself renames or trashes it.

Only opens count. A save is not the reader choosing the document again, and
counting saves would rank a document by how often it was saved.

Stored as JSON under ``recentDocuments`` in ``QSettings``, one entry per
document, best first. The older ``recentFiles`` list (last opened first) is
read once and replaced.

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
#: Opens remembered per document. Older opens weigh almost nothing anyway.
OPENS_KEPT = 10
HALF_LIFE_DAYS = 7.0

_DAY = 86400.0

Entry = dict  # {"path": str, "opens": [epoch seconds, newest first]}


def _score(entry: Entry, now: float) -> float:
    return sum(0.5 ** (max(now - opened, 0.0) / _DAY / HALF_LIFE_DAYS) for opened in entry["opens"])


def _last_open(entry: Entry) -> float:
    return entry["opens"][0] if entry["opens"] else 0.0


def _ranked(entries: list[Entry], now: float) -> list[Entry]:
    """Best score first; the later last open breaks a tie."""
    return sorted(entries, key=lambda entry: (_score(entry, now), _last_open(entry)), reverse=True)


def _clean(raw) -> list[Entry]:
    """The stored entries, with anything a hand edit broke left out."""
    entries: list[Entry] = []
    seen: set[str] = set()
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        opens = item.get("opens")
        if not isinstance(path, str) or not path or path in seen or not isinstance(opens, list):
            continue
        stamps = sorted(
            (float(stamp) for stamp in opens if isinstance(stamp, (int, float)) and not isinstance(stamp, bool)),
            reverse=True,
        )
        if stamps:
            seen.add(path)
            entries.append({"path": path, "opens": stamps[:OPENS_KEPT]})
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
    return [{"path": path, "opens": [now - 60.0 * index]} for index, path in enumerate(unique)]


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
        latest = sorted(existing, key=_last_open, reverse=True)[:ALWAYS_SHOWN]
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
        ``opens`` counts the opens remembered (at most ``OPENS_KEPT``), and
        ``shown`` says whether it is on the list right now.
        """
        now = self._now()
        entries = self._load()
        shown = set(self._shown(entries, now))
        return [
            {
                "path": entry["path"],
                "opens": len(entry["opens"]),
                "lastOpened": _last_open(entry),
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
            entry = {"path": path, "opens": []}
            entries.append(entry)
        entry["opens"] = [now, *entry["opens"]][:OPENS_KEPT]
        self._save(_ranked(entries, now)[:TRACKED])

    def forget(self, path: str) -> None:
        """Drop ``path`` and its history, for a file Edi itself trashed."""
        entries = self._load()
        kept = [entry for entry in entries if entry["path"] != path]
        if len(kept) != len(entries):
            self._save(kept)

    def move(self, old_path: str, new_path: str) -> None:
        """Carry ``old_path``'s history to ``new_path``, for a rename or move.

        The renamed document is the same document, so it keeps its rank. A
        history ``new_path`` already had (an older file of that name, now
        overwritten) is merged in.
        """
        entries = self._load()
        old = next((entry for entry in entries if entry["path"] == old_path), None)
        if old is None:
            return
        rest = [entry for entry in entries if entry["path"] not in (old_path, new_path)]
        target = next((entry for entry in entries if entry["path"] == new_path), None)
        opens = sorted([*old["opens"], *(target["opens"] if target else [])], reverse=True)
        self._save(_ranked([*rest, {"path": new_path, "opens": opens[:OPENS_KEPT]}], self._now()))
