"""The documents open in the window, kept so the next launch can reopen them.

Quitting Edi, whether by hand or because the installer is replacing it
(``install.sh`` quits the running app before swapping it), would otherwise
lose the tabs. The page reports its open documents whenever they change
(``setOpenFiles``), and they are written to ``QSettings`` straight away, so a
crash keeps them as well as a quit. A launch reopens them (``getSession``);
see ``docs/preferences.md``.

Only documents with a path are kept. Unsaved edits are not: the quit prompt
still guards those.
"""

from __future__ import annotations

import os

from PySide6.QtCore import QSettings

PATHS_KEY = "session/paths"
ACTIVE_KEY = "session/active"


def _as_list(value) -> list[str]:
    # A one-entry list comes back from an INI file as a bare string.
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, (list, tuple)):
        return [str(entry) for entry in value if entry]
    return []


def load() -> dict:
    """The documents last open, as ``{"paths": […], "active": path | None}``.
    A document whose file is gone is left out: reopening it could only fail."""
    settings = QSettings()
    paths = [path for path in _as_list(settings.value(PATHS_KEY, [])) if os.path.isfile(path)]
    active = settings.value(ACTIVE_KEY, "")
    return {"paths": paths, "active": active if active in paths else None}


def save(paths: list[str], active: str | None) -> None:
    settings = QSettings()
    settings.setValue(PATHS_KEY, list(paths))
    settings.setValue(ACTIVE_KEY, active if active in paths else "")
    settings.sync()
