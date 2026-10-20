"""Cached loader for the typed test harness (dist/harness.js)."""

from __future__ import annotations

from pathlib import Path

from backend.window import DIST_DIR

_HARNESS_JS: str | None = None


def harness_js() -> str:
    """Return the harness source, cached for the whole session."""
    global _HARNESS_JS
    if _HARNESS_JS is None:
        path = DIST_DIR / "harness.js"
        if not path.is_file():
            raise FileNotFoundError(
                f"frontend build not found at {path}; run `npm run build`"
            )
        _HARNESS_JS = path.read_text(encoding="utf-8")
    return _HARNESS_JS


def edi_wait(win, script, predicate, timeout=15.0):
    """Poll ``script`` until ``predicate`` holds, dumping page state on timeout."""
    import time
    from PySide6.QtWidgets import QApplication

    seen = {"v": {}}

    def probe():
        from tests.mermaid_render import _dump

        seen["v"] = _dump(win, script)
        return predicate(seen["v"])

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if probe():
            return seen["v"]
        time.sleep(0.02)
    raise AssertionError(f"never satisfied: {seen['v']}")


__all__ = ["harness_js", "edi_wait"]