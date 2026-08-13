"""Edi entry point."""

from __future__ import annotations

import os
import sys

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

    Fires the probe after the webview has had time to boot, prints the
    snapshot a little later, then quits. The quit timer guarantees the app
    never hangs in a broken environment.
    """

    def probe() -> None:
        window._web.page().runJavaScript(_PROBE_JS, lambda _v: None)

    def read() -> None:
        window._web.page().runJavaScript(
            "JSON.stringify(window.__selftest)", lambda v: print("SELFTEST", v)
        )

    QTimer.singleShot(5000, probe)
    QTimer.singleShot(9000, read)
    QTimer.singleShot(12000, app.quit)


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
