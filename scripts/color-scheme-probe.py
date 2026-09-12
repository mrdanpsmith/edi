"""Live color-scheme observer for Edi theme diagnostics.

Run it on a real desktop, then toggle the system theme (dark -> default ->
dark). Every second it prints what each layer reports: Qt's cached scheme,
the XDG portal / gsettings keys (raw), the scheme the app would resolve, and
what the webview's ``prefers-color-scheme`` media query reports.

Usage::

    .venv/bin/python scripts/color-scheme-probe.py

Ctrl-C to stop. Paste the output when reporting an issue.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PySide6.QtCore import QSettings, QTimer
from PySide6.QtWidgets import QApplication
from PySide6.QtWebEngineWidgets import QWebEngineView

from backend.theme import (
    _probe_appearance,
    _probe_gsettings,
    _probe_gsettings_cli,
    _probe_gtk,
    _probe_kconfig,
    probe_scheme,
)


def main() -> int:
    app = QApplication(sys.argv)

    web = QWebEngineView()
    web.setFixedSize(320, 200)
    web.show()
    web.setUrl(
        "data:text/html;charset=utf-8,<body style='background:#888'>color scheme probe</body>"
    )
    state = {"web": "loading", "started": time.monotonic()}

    def read_web():
        web.page().runJavaScript(
            "matchMedia('(prefers-color-scheme: dark)').matches",
            lambda value: state.__setitem__("web", value),
        )

    portal_raw = {"v": None}
    gsettings_raw = {"v": None}
    gsettings_cli_raw = {"v": None}
    kconfig_name = {"v": None}
    gtk_name = {"v": None}

    def read_files():
        gsettings_cli_raw["v"] = _probe_gsettings_cli()
        s = QSettings(os.path.expanduser("~/.config/kdeglobals"), QSettings.IniFormat)
        kconfig_name["v"] = s.value("ColorScheme")
        s = QSettings(os.path.expanduser("~/.config/gtk-3.0/settings.ini"), QSettings.IniFormat)
        gtk_name["v"] = s.value("Settings/gtk-theme-name")

    def tick():
        hints = app.styleHints()
        portal_raw["v"] = _probe_appearance()
        gsettings_raw["v"] = _probe_gsettings()
        read_files()
        resolved = probe_scheme(app)
        print(
            f"[{time.monotonic() - state['started']:5.1f}s] "
            f"Qt={hints.colorScheme().name} "
            f"| portal={portal_raw['v']!r} "
            f"| gsettings={gsettings_raw['v']!r} "
            f"| gs-cli={gsettings_cli_raw['v']!r} "
            f"| kde={kconfig_name['v']!r} "
            f"| gtk={gtk_name['v']!r} "
            f"| resolved={resolved.name} "
            f"| web:dark={state['web']}",
            flush=True,
        )
        read_web()

    QTimer.singleShot(1500, read_web)
    QTimer.singleShot(2500, tick)
    timer = QTimer()
    timer.setInterval(1000)
    timer.timeout.connect(tick)
    timer.start()
    print(
        "Reading every second. Toggle the system theme now. Ctrl-C to stop.",
        flush=True,
    )
    print(f"DE={os.environ.get('XDG_CURRENT_DESKTOP')!r}", flush=True)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())