"""Shared fixtures for the window tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from PySide6.QtCore import QSettings, QSize
from PySide6.QtWidgets import QApplication

from backend.window import DIST_DIR, MainWindow
from tests.mermaid_render import _pump_until


@pytest.fixture(scope="session")
def window(qapp):
    if not (DIST_DIR / "index.html").is_file():
        pytest.fail(
            f"frontend build not found at {DIST_DIR / 'index.html'}; "
            "run `npm run build` before the backend tests"
        )
    if not (DIST_DIR / "harness.js").is_file():
        pytest.fail(
            f"frontend build not found at {DIST_DIR / 'harness.js'}; "
            "run `npm run build` before the backend tests"
        )
    win = MainWindow()
    win.resize(1280, 800)
    win.show()

    state = {"ready": False}

    def probe():
        win._web.page().runJavaScript(
            """
            (function () {
              if (!window.qt || !window.qt.webChannelTransport) return false;
              return !!window.bridge && typeof window.bridge.invoke === 'function';
            })()
            """,
            lambda v: state.__setitem__("ready", bool(v)),
        )

    def ready():
        probe()
        return state["ready"]

    assert _pump_until(ready, timeout=12.0), "webview bridge never became ready"

    from tests.harness_loader import harness_js

    injected = {"done": False}

    def _on_injected(_v):
        injected["done"] = True

    win._web.page().runJavaScript(harness_js(), _on_injected)
    _pump_until(lambda: injected["done"], timeout=5.0)

    yield win
    win.close()


@pytest.fixture
def visible(window, qtbot):
    if not window.isVisible():
        window.show()
    qtbot.waitUntil(window.isVisible, timeout=3000)
    return window


@pytest.fixture
def stored_recents():
    settings = QSettings()
    settings.setValue("recentFiles", [])
    settings.sync()
    yield settings


# Re-export for convenience.
__all__ = ["window", "visible", "stored_recents"]