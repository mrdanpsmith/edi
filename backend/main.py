"""Edi entry point."""

from __future__ import annotations

import os
import sys
import threading

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from .window import MainWindow, load_app_icon

# QtWebEngine's runJavaScript does not await Promises, so the selftest probe
# writes its snapshot to window.__selftest synchronously; a later call reads
# it back and prints it.
_PROBE_JS = """
    window.__selftest = {
      title: document.title,
      cm: !!document.querySelector('.cm-content'),
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


def _run_selftest(app: QApplication, window: MainWindow) -> None:
    """Smoke-test a packaged build: webview rendered + bridge round-trip.

    Fires the probe after the webview has had time to boot, waits for the page
    to finish loading (``loadFinished``), then reads the snapshot back. Prints
    a single ``SELFTEST {...}`` line and exits 0 on success; a short watchdog
    exits 1 with ``SELFTEST_TIMEOUT`` if the page never loads. All exit paths
    bypass normal Qt/Python teardown (``os._exit``) so a wedged renderer cannot
    hang the smoke test or swallow buffered output.
    """

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
            ok = isinstance(v, str) and '"cm":true' in v and '"mermaid":true' in v
            print("SELFTEST", v, flush=True)
            os._exit(0 if ok else 1)

        page.runJavaScript("JSON.stringify(window.__selftest)", on_done)

    QTimer.singleShot(3000, probe)
    QTimer.singleShot(5000, read)
    # A plain thread (not a QTimer) so the watchdog still fires even if the Qt
    # event loop is wedged waiting on the renderer/GPU process.
    threading.Timer(
        25.0, lambda: (print("SELFTEST_TIMEOUT", flush=True), os._exit(1))
    ).start()


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Edi")
    app.setOrganizationName("Edi")
    icon = load_app_icon()
    if icon is not None:
        app.setWindowIcon(icon)
    window = MainWindow()
    window.resize(1280, 800)
    window.show()
    if os.environ.get("EDI_SELFTEST"):
        _run_selftest(app, window)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
