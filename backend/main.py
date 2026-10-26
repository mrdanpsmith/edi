"""Edi entry point."""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from contextlib import suppress
import threading

from PySide6.QtCore import QEvent, QTimer
from PySide6.QtGui import QFileOpenEvent
from PySide6.QtWidgets import QApplication

from .theme import watch_color_scheme
from .window import MainWindow, load_app_icon

# QtWebEngine's runJavaScript does not await Promises, so the selftest probe
# writes its snapshot to window.__selftest synchronously; a later call reads
# it back and prints it.
_PROBE_JS = """
    window.__selftest = {
      title: document.title,
      editor: !!document.querySelector('.ProseMirror'),
      mermaid: !!document.querySelector('.mermaid'),
      bridge: !!window.bridge,
      ping: null,
    };
    if (window.bridge && typeof window.bridge.invoke === 'function') {
      window.bridge.result.connect(function (payload) {
        var message = JSON.parse(payload);
        if (message.id === 4242) window.__selftest.ping = message.ok && message.data === 7;
      });
      window.bridge.invoke('ping', 4242, JSON.stringify({ now: 7 }));
    }
    true
    """


def _file_open_path(event: QEvent) -> str | None:
    """The local path carried by a ``QFileOpenEvent``, if there is one."""
    if not isinstance(event, QFileOpenEvent):
        return None
    url = event.url()
    if url.isLocalFile():
        return url.toLocalFile() or None
    return event.file() or None


class _EdiApplication(QApplication):
    """QApplication that accepts macOS open-document Apple Events.

    Finder does not pass a double-clicked file as a command-line argument: it
    launches (or reuses) the app and sends ``kAEOpenDocuments``. Qt turns that
    into a ``QFileOpenEvent``. A cold launch can deliver it before ``main()``
    has built the window, so paths are queued until ``set_file_open_handler``
    attaches the running window; a warm launch is forwarded to that window,
    which opens them as tabs rather than starting a second process.
    """

    def __init__(self, argv: list[str]) -> None:
        # Set before super(): the platform plugin can deliver the first event
        # while QApplication is still initialising.
        self._file_open_handler: Callable[[list[str]], None] | None = None
        self._queued_files: list[str] = []
        super().__init__(argv)

    def set_file_open_handler(self, handler: Callable[[list[str]], None]) -> None:
        self._file_open_handler = handler
        queued, self._queued_files = self._queued_files, []
        if queued:
            handler(queued)

    def event(self, event: QEvent) -> bool:
        if event.type() == QEvent.Type.FileOpen:
            path = _file_open_path(event)
            if path:
                if self._file_open_handler is None:
                    if path not in self._queued_files:
                        self._queued_files.append(path)
                else:
                    self._file_open_handler([path])
            return True
        return super().event(event)


def _selftest_exit(line: str, code: int) -> None:
    """Emit the selftest verdict and exit.

    The verdict goes to stdout (``SELFTEST {...}`` or ``SELFTEST_TIMEOUT``); on
    Windows GUI builds there is no attached console, so when ``EDI_SELFTEST_OUT``
    names a file the same line is also written (and flushed) there. All exit
    paths bypass normal Qt/Python teardown (``os._exit``) so a wedged renderer
    cannot hang the smoke test or swallow buffered output.
    """
    print(line, flush=True)
    out = os.environ.get("EDI_SELFTEST_OUT")
    if out:
        try:
            with open(out, "w", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        except OSError:
            pass
    os._exit(code)


def _run_selftest(app: QApplication, window: MainWindow) -> None:
    """Smoke-test a packaged build: webview rendered + bridge round-trip.

    Fires the probe after the webview has had time to boot, waits for the page
    to finish loading (``loadFinished``), then reads the snapshot back.
    Emits a single ``SELFTEST {...}`` line and exits 0 on success; a short
    watchdog exits 1 with ``SELFTEST_TIMEOUT`` if the page never loads.
    """

    if os.environ.get("EDI_SELFTEST_OUT"):
        # Windowed builds have no console, so write a boot heartbeat before
        # kicking off the Qt timers: lets the smoke script tell "onefile is
        # still self-extracting / Qt is still starting" apart from "Python
        # booted but QtWebEngine never finished loading".
        try:
            with open(os.environ["EDI_SELFTEST_OUT"], "w", encoding="utf-8") as fh:
                fh.write("SELFTEST_BOOTING\n")
                fh.flush()
        except OSError:
            pass

    page = window._web.page()
    loaded = {"ok": False}
    page.loadFinished.connect(lambda ok: loaded.__setitem__("ok", ok))

    def probe() -> None:
        page.runJavaScript(_PROBE_JS, lambda _v: None)

    def read() -> None:
        if not loaded["ok"]:
            QTimer.singleShot(3000, read)
            return

        def on_done(v: object) -> None:
            ok = isinstance(v, str) and '"editor":true' in v and '"mermaid":true' in v
            icon_ok = load_app_icon() is not None
            data: dict = {}
            if isinstance(v, str):
                try:
                    data = json.loads(v)
                except json.JSONDecodeError:
                    pass
            data["icon"] = icon_ok
            _selftest_exit("SELFTEST " + json.dumps(data), 0 if ok and icon_ok else 1)

        page.runJavaScript("JSON.stringify(window.__selftest)", on_done)

    QTimer.singleShot(3000, probe)
    QTimer.singleShot(5000, read)
    # A plain thread (not a QTimer) so the watchdog still fires even if the Qt
    # event loop is wedged waiting on the renderer/GPU process.
    threading.Timer(25.0, lambda: _selftest_exit("SELFTEST_TIMEOUT", 1)).start()


def main() -> int:
    if os.environ.get("EDI_SELFTEST"):
        # Headless smoke tests must never touch the GPU: QtWebEngine's GPU
        # process otherwise tries to init GL with the 22.04-bundled Mesa
        # against the host's newer stack and crashes before the page loads.
        # The flags must be in the environment before QApplication is created.
        os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
        os.environ.setdefault(
            "QTWEBENGINE_CHROMIUM_FLAGS", "--disable-dev-shm-usage --disable-gpu"
        )
    app = _EdiApplication(sys.argv)
    app.setApplicationName("Edi")
    app.setOrganizationName("Edi")
    app.setDesktopFileName("edi")
    icon = load_app_icon()
    if icon is not None:
        app.setWindowIcon(icon)
    pending_files = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    window = MainWindow(pending_files)
    # Queued cold-launch file events are delivered as soon as the window can
    # take them; warm-launch events arrive here too, through the same handler.
    app.set_file_open_handler(window.open_files)
    window.resize(1280, 800)
    window.show()
    watch_color_scheme(app, window)
    if os.environ.get("EDI_SELFTEST"):
        _run_selftest(app, window)
    if sys.platform == "win32":
        # Persistent taskbar identity so Windows groups the app under the .exe
        # icon instead of a generic placeholder (and taskbar pinning works).
        # Must not be the application title string.
        import ctypes

        # Best-effort taskbar identity; failure is cosmetic only.
        with suppress(AttributeError, OSError):
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
                "com.mrdanpsmith.edi"
            )
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
