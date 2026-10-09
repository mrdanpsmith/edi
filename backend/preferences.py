"""Preferences that outlive a run: the View menu's options and the zoom level.

**These are app facts, not web storage, so they live in ``QSettings`` beside the
recent-files list rather than in the page.** The page used to keep them in
``localStorage``, which cannot survive a run of this app at all: ``MainWindow``
never creates a ``QWebEngineProfile``, so the page gets the *default* one, and
that one is off-the-record — ``QWebEngineProfile.defaultProfile()`` reports
``isOffTheRecord() == True`` and every byte of web storage it holds is discarded
when the process exits. Zoom, the toolbar row and the hover band therefore came
back at their defaults every launch, which is exactly what a packaged build
showed: ``scripts/build-pyzip.sh`` extracts to a fresh temp directory per run,
so even a persistent web profile would have keyed the app's origin by a path
that no longer exists.

So the flow is deliberately two-shaped, one shape per side of the bridge:

* **Read** — :meth:`Preferences.all` is *injected* into the page by
  ``window.py``'s document-creation script, before the app's own bundle runs,
  because zoom has to be applied before the editor's first paint and a
  ``QWebChannel`` round trip cannot be waited on synchronously.
* **Write** — the page calls ``setPreference`` and forgets about it.

The key names are the same strings ``setMenuState`` already publishes, so the
View menu's checkmarks are the store's own field names rather than a second
spelling of them.
"""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import QSettings

#: Every preference, its default, and how a stored value is read back.
#: Defaults must match ``DEFAULT_PREFERENCES`` in ``src/preferences.ts``; the
#: frontend is the source of truth for what a *valid* value is (the zoom ladder
#: in ``src/zoom.ts`` in particular), so nothing here clamps — an out-of-range
#: level is stored as asked for and clamped on the way in to the editor.
DEFAULTS: dict[str, Any] = {
    "zoomFactor": 1.0,
    "toolbarVisible": True,
    "hoverBand": True,
}

#: Names the page may ask to change. A name outside this set is ignored rather
#: than written, so a stale page cannot grow the settings file.
NAMES = frozenset(DEFAULTS)


def _as_bool(value: Any, default: bool) -> bool:
    """Read a boolean out of ``QSettings``, which may hand back a string.

    QSettings' own format round-trips a Python ``bool`` as one, so the string
    branch is for a hand-edited ``Edi.conf`` — where ``bool("false")`` would be
    ``True``, turning a preference off by editing it.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _as_float(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if number == number else default  # NaN is not a zoom level


_COERCE = {"zoomFactor": _as_float, "toolbarVisible": _as_bool, "hoverBand": _as_bool}


class Preferences:
    """The persisted app preferences, one key each in ``QSettings``.

    ``QSettings()`` uses the org="Edi" / app="Edi" names set in ``backend.main``
    (Linux: ``~/.config/Edi/Edi.conf``), which is the same file and the same
    round trip the recent-files list already uses.

    Tests pass their own ``QSettings`` pointed at a temp file: the store is a
    user's file, and a test suite that wrote to the developer's real one would
    be a test suite that changes the developer's editor.
    """

    def __init__(self, settings: QSettings | None = None) -> None:
        self._settings = settings if settings is not None else QSettings()

    def all(self) -> dict[str, Any]:
        """Every known preference, defaults filled in, values coerced."""
        return {
            name: _COERCE[name](self._settings.value(name, default), default)
            for name, default in DEFAULTS.items()
        }

    def get(self, name: str) -> Any:
        """One preference, or its default if ``name`` is not a known one."""
        default = DEFAULTS.get(name)
        if default is None:
            raise KeyError(name)
        return _COERCE[name](self._settings.value(name, default), default)

    def set(self, name: str, value: Any) -> bool:
        """Change one preference; ``False`` if ``name`` is not a known one.

        The write is not synced. ``QSettings`` flushes on its own schedule and
        at destruction, which is what makes a zoom dragged through a dozen
        rungs with the wheel cheap.
        """
        default = DEFAULTS.get(name)
        if default is None:
            return False
        self._settings.setValue(name, _COERCE[name](value, default))
        return True
