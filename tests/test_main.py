"""Tests for the app entry point (``backend/main.py``).

Covers ``main()`` wiring and the packaged-build ``_run_selftest`` probe using
fake page/window objects, so no browser round-trip is needed. The real
smoke-test behaviour is exercised by the packaged binary in CI (``EDI_SELFTEST``).
"""

from __future__ import annotations

import json
import os
import runpy
import sys
import time
import warnings

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtWidgets import QApplication

import backend.main as main_module

import pytest


class _FakeWindow:
    def __init__(self, page: object | None = None) -> None:
        self._web = _FakeWeb(page)

    def resize(self, width: int, height: int) -> None:
        self._resized = (width, height)

    def show(self) -> None:
        self._shown = True


class _FakeWeb:
    def __init__(self, page: object | None) -> None:
        self._page = page

    def page(self) -> object:
        return self._page


class _FakePage(QObject):
    """Emulates the QtWebEngine page surface ``_run_selftest`` uses."""

    loadFinished = Signal(bool)

    def __init__(self, snapshot: str) -> None:
        super().__init__()
        self.snapshot = snapshot
        self.probed = False

    def runJavaScript(self, script: str, callback=None) -> None:
        if "JSON.stringify(window.__selftest)" in script:
            callback(self.snapshot)
        else:
            self.probed = True
            callback(True)


class _FakeQTimer:
    """Captures ``QTimer.singleShot`` calls so tests can fire them on demand."""

    slots: list[tuple[int, object]] = []

    @classmethod
    def singleShot(cls, ms: int, slot) -> None:
        cls.slots.append((ms, slot))

    @classmethod
    def drain(cls) -> None:
        pending, cls.slots = cls.slots, []
        for _ms, slot in pending:
            slot()


class _StubTimer:
    def __init__(self, interval: float, fn) -> None:
        self.fn = fn

    def start(self) -> None:
        pass


def _pump(condition, timeout: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if condition():
            return True
        time.sleep(0.005)
    return False


def _patch_selftest_harness(monkeypatch) -> list[int]:
    """Make ``_run_selftest`` safe to drive from a test and record ``os._exit``."""
    exits: list[int] = []
    monkeypatch.setattr(main_module.os, "_exit", lambda code: exits.append(code))
    monkeypatch.setattr(main_module, "QTimer", _FakeQTimer)
    monkeypatch.setattr(main_module.threading, "Timer", _StubTimer)
    return exits


def _app() -> QApplication:
    return QApplication.instance() or QApplication([])


class _AppProxy:
    """Delegates to the real app but records ``setWindowIcon`` calls.

    The session app is shared across tests, so a real ``setWindowIcon`` would
    leak into later assertions; recording instead keeps tests independent.
    """

    def __init__(self, real: QApplication) -> None:
        self._real = real
        self.set_icon_calls: list[object] = []

    def setApplicationName(self, name: str) -> None:
        self._real.setApplicationName(name)

    def setOrganizationName(self, name: str) -> None:
        self._real.setOrganizationName(name)

    def setDesktopFileName(self, name: str) -> None:
        self._real.setDesktopFileName(name)

    def setWindowIcon(self, icon) -> None:
        self.set_icon_calls.append(icon)

    def exec(self) -> int:
        return self._real.exec()


@pytest.fixture(autouse=True)
def _reset_timer_slots():
    _FakeQTimer.slots = []
    yield
    _FakeQTimer.slots = []


def test_main_sets_up_app_and_runs(monkeypatch):
    app = _app()
    proxy = _AppProxy(app)
    monkeypatch.setattr(main_module, "QApplication", lambda argv: proxy)
    monkeypatch.setattr(main_module, "MainWindow", _FakeWindow)
    QTimer.singleShot(0, app.quit)

    assert main_module.main() == 0
    assert app.applicationName() == "Edi"
    assert app.desktopFileName() == "edi"
    assert len(proxy.set_icon_calls) == 1


def test_main_without_app_icon(monkeypatch):
    app = _app()
    proxy = _AppProxy(app)
    monkeypatch.setattr(main_module, "QApplication", lambda argv: proxy)
    monkeypatch.setattr(main_module, "MainWindow", _FakeWindow)
    monkeypatch.setattr(main_module, "load_app_icon", lambda: None)
    QTimer.singleShot(0, app.quit)

    assert main_module.main() == 0
    assert proxy.set_icon_calls == []


def test_main_selftest_branch_sets_webengine_flags(monkeypatch):
    app = _app()
    monkeypatch.setattr(main_module, "QApplication", lambda argv: app)
    monkeypatch.setattr(main_module, "MainWindow", _FakeWindow)
    monkeypatch.setenv("EDI_SELFTEST", "1")
    monkeypatch.setenv("QTWEBENGINE_DISABLE_SANDBOX", "1")
    monkeypatch.setenv(
        "QTWEBENGINE_CHROMIUM_FLAGS", "--disable-dev-shm-usage --disable-gpu"
    )
    calls: dict = {}

    def fake_selftest(app: QApplication, window: _FakeWindow) -> None:
        calls["window"] = window

    monkeypatch.setattr(main_module, "_run_selftest", fake_selftest)
    QTimer.singleShot(0, app.quit)

    assert main_module.main() == 0
    assert isinstance(calls["window"], _FakeWindow)
    assert os.environ.get("QTWEBENGINE_DISABLE_SANDBOX") == "1"
    assert "--disable-dev-shm-usage" in os.environ["QTWEBENGINE_CHROMIUM_FLAGS"]


def test_run_selftest_passes_and_exits_zero(monkeypatch, capsys):
    app = _app()
    exits = _patch_selftest_harness(monkeypatch)
    page = _FakePage(
        snapshot='{"title":"Edi","editor":true,"mermaid":true,"bridge":true,"ping":true}'
    )
    monkeypatch.setattr(main_module, "load_app_icon", lambda: object())

    main_module._run_selftest(app, _FakeWindow(page))
    _FakeQTimer.drain()
    page.loadFinished.emit(True)
    _FakeQTimer.drain()

    out = capsys.readouterr().out
    assert out.startswith("SELFTEST ")
    payload = json.loads(out[len("SELFTEST ") :])
    assert payload["editor"] is True
    assert payload["mermaid"] is True
    assert payload["icon"] is True
    assert exits == [0]


def test_run_selftest_waits_for_page_load(monkeypatch, capsys):
    app = _app()
    exits = _patch_selftest_harness(monkeypatch)
    page = _FakePage(snapshot='{"editor":true,"mermaid":true}')
    monkeypatch.setattr(main_module, "load_app_icon", lambda: object())

    main_module._run_selftest(app, _FakeWindow(page))
    _FakeQTimer.drain()

    assert page.probed is True
    assert exits == []  # still waiting: loadFinished has not fired

    page.loadFinished.emit(True)
    _FakeQTimer.drain()

    out = capsys.readouterr().out
    assert out.startswith("SELFTEST ")
    assert exits == [0]


def test_run_selftest_failure_exits_nonzero(monkeypatch, capsys):
    app = _app()
    exits = _patch_selftest_harness(monkeypatch)
    page = _FakePage(snapshot="not json")
    monkeypatch.setattr(main_module, "load_app_icon", lambda: object())

    main_module._run_selftest(app, _FakeWindow(page))
    page.loadFinished.emit(True)
    _FakeQTimer.drain()

    out = capsys.readouterr().out
    payload = json.loads(out[len("SELFTEST ") :])
    assert payload.get("editor") is not True
    assert exits == [1]


def test_run_selftest_watchdog_fires(monkeypatch, capsys):
    app = _app()
    exits = _patch_selftest_harness(monkeypatch)
    timers: list[_StubTimer] = []

    def stub_timer(interval: float, fn):
        timer = _StubTimer(interval, fn)
        timers.append(timer)
        return timer

    monkeypatch.setattr(main_module.threading, "Timer", stub_timer)

    main_module._run_selftest(app, _FakeWindow(_FakePage(snapshot="{}")))
    assert len(timers) == 1
    timers[0].fn()

    out = capsys.readouterr().out
    assert "SELFTEST_TIMEOUT" in out
    assert exits == [1]


def test_main_entry_point_runs_as_module(monkeypatch):
    """The ``if __name__ == "__main__"`` guard runs main() and exits cleanly."""
    monkeypatch.delenv("EDI_SELFTEST", raising=False)

    class _FakeQApplication:
        def __init__(self, argv) -> None:
            pass

        @classmethod
        def instance(cls):
            # pytest-qt's teardown hook probes QApplication.instance(); report
            # none so it skips event processing while the patch is active.
            return None

        def setApplicationName(self, name: str) -> None:
            pass

        def setOrganizationName(self, name: str) -> None:
            pass

        def setDesktopFileName(self, name: str) -> None:
            pass

        def setWindowIcon(self, icon) -> None:
            pass

        def exec(self) -> int:
            return 0

    # The fresh module executed by runpy resolves imports through the cached
    # packages, so patching these names is visible to it without re-importing.
    from PySide6 import QtWidgets

    from backend import window

    monkeypatch.setattr(QtWidgets, "QApplication", _FakeQApplication)
    monkeypatch.setattr(window, "MainWindow", _FakeWindow)
    monkeypatch.setattr(window, "load_app_icon", lambda: None)
    monkeypatch.setattr(sys, "argv", ["edi"])

    with warnings.catch_warnings():
        # runpy re-executes an already-imported module; the RuntimeWarning is
        # expected and harmless (main.py has no module-level side effects).
        warnings.simplefilter("ignore", RuntimeWarning)
        with pytest.raises(SystemExit) as exc_info:
            runpy.run_module("backend.main", run_name="__main__")
    assert exc_info.value.code == 0
