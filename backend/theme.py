"""Keep the webview in sync with the system color scheme.

On Linux the desktop announces a change to the XDG/a11y settings; the scheme
key lands on ``org.freedesktop.appearance|color-scheme`` (or, failing that,
``org.gnome.desktop.interface|color-scheme``). Qt normally forwards this as
``QStyleHints.colorSchemeChanged``, but its portal watcher is unreliable on
some desktops (a dark-to-default round trip is a classic drop), and when the
transition is missed Qt's *cached* value goes stale too — so re-reading Qt is
not enough.

Instead the resolved scheme is probed directly over D-Bus (portal setting,
then gsettings, then ``QStyleHints`` as the last resort) and re-applied on
every plausible trigger:

- the ``colorSchemeChanged`` signal when it does fire,
- window focus regain,
- and a slow poll (2 s) as the catch-all.

A scheme change to "no preference" from a previously-dark state is treated as
a return to light; many desktops report exactly that (value 0) for a "default"
theme instead of an explicit light preference.
"""

from __future__ import annotations

import os
import subprocess
import sys

from PySide6.QtCore import QObject, QSettings, QTimer, Qt
from PySide6.QtDBus import QDBusConnection, QDBusInterface, QDBusReply


def _log(message: str) -> None:
    if os.environ.get("EDI_THEME_DEBUG"):
        print(f"[theme] {message}", file=sys.stderr, flush=True)


def apply_color_scheme(window, scheme) -> None:
    """Notify the webview of a resolved ``scheme`` (Dark/Light/Unknown)."""
    if scheme not in (Qt.ColorScheme.Dark, Qt.ColorScheme.Light):
        return
    window.push_event({"type": "colorScheme", "dark": scheme == Qt.ColorScheme.Dark})


def _map_portal(value) -> Qt.ColorScheme | None:
    """Map a portal/gsettings ``color-scheme`` value onto ``Qt.ColorScheme``.

    The XDG portal returns an int (0 = no preference, 1 = prefer dark,
    2 = prefer light) while the GNOME settings schema uses strings
    (``prefer-dark`` / ``prefer-light`` / ``default`` / ``never``).
    """
    if isinstance(value, int):
        return {1: Qt.ColorScheme.Dark, 2: Qt.ColorScheme.Light}.get(value)
    if isinstance(value, str):
        return {"prefer-dark": Qt.ColorScheme.Dark, "prefer-light": Qt.ColorScheme.Light}.get(
            value
        )
    return None


def _read_dbus(service: str, path: str, interface: str, method: str, args) -> object | None:
    bus = QDBusConnection.sessionBus()
    if not bus.isConnected():
        return None
    try:
        registered = QDBusReply(bus.interface().isServiceRegistered(service))
        if not registered.isValid() or not registered.value():
            return None
        iface = QDBusInterface(service, path, interface, bus)
        if not iface.isValid():
            return None
        iface.setTimeout(250)
        reply = QDBusReply(iface.call(method, *args))
        return reply.value() if reply.isValid() else None
    except Exception:
        return None


def _probe_appearance():
    """Read the XDG appearance ``color-scheme`` setting (returns raw value)."""
    return _read_dbus(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Settings",
        "Read",
        ("org.freedesktop.appearance", "color-scheme"),
    )


def _probe_gsettings():
    """Read the GNOME ``color-scheme`` schema key (raw value)."""
    return _read_dbus(
        "org.gnome.desktop.interface",
        "/org/gnome/desktop/interface",
        "org.gnome.desktop.interface",
        "Get",
        ("color-scheme",),
    )


def _name_to_scheme(name) -> Qt.ColorScheme | None:
    """Map a theme/file name onto a scheme (dark if the name says so)."""
    if not isinstance(name, str) or not name.strip():
        return None
    return Qt.ColorScheme.Dark if "dark" in name.strip().lower() else Qt.ColorScheme.Light


def _probe_kconfig(path: str | None = None) -> Qt.ColorScheme | None:
    """Read KDE's ``[General] ColorScheme`` from ``~/.config/kdeglobals``.

    The Qt platform theme reads exactly this key from KConfig; probing the
    file directly works even when the frozen bundle's theme plugin is degraded.
    """
    try:
        settings = QSettings(path or os.path.expanduser("~/.config/kdeglobals"), QSettings.IniFormat)
        return _name_to_scheme(settings.value("ColorScheme"))
    except Exception:
        return None


def _probe_gtk(path: str | None = None) -> Qt.ColorScheme | None:
    """Read the active GTK theme from ``~/.config/gtk-3.0/settings.ini``."""
    try:
        settings = QSettings(
            path or os.path.expanduser("~/.config/gtk-3.0/settings.ini"), QSettings.IniFormat
        )
        prefer_dark = settings.value("Settings/gtk-application-prefer-dark-theme")
        if str(prefer_dark).lower() in ("true", "yes", "1"):
            return Qt.ColorScheme.Dark
        return _name_to_scheme(settings.value("Settings/gtk-theme-name"))
    except Exception:
        return None


_GSETTINGS_SCHEMA = "org.gnome.desktop.interface"
_GSETTINGS_SCHEME_KEY = "color-scheme"
_GSETTINGS_THEME_KEY = "gtk-theme"


def _gnome_session() -> bool:
    """True inside a modern GNOME stack (GNOME/Ubuntu/Pantheon sessions)."""
    for var in ("XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP"):
        value = os.environ.get(var, "").lower()
        if "gnome" in value or value.startswith("ubuntu") or value == "pantheon":
            return True
    return False


def _read_gsettings_key(key: str) -> object | None:
    """Run one ``gsettings get`` with the bundle env scrubbed.

    The onefile sets ``LD_LIBRARY_PATH`` to its extraction dir; if the bundle
    ships its own glib, the spawned ``gsettings`` loads it, its GIO module
    path is wrong, the dconf backend fails to load and gsettings silently
    falls back to defaults — which reads ``default``/light during dark.
    Unset the redirectors so the child resolves your system glib/dconf.
    """
    env = dict(os.environ)
    for var in ("LD_LIBRARY_PATH", "GIO_MODULE_DIR", "GSETTINGS_BACKEND", "GSETTINGS_SCHEMA_DIR"):
        env.pop(var, None)
    try:
        result = subprocess.run(
            ["gsettings", "get", _GSETTINGS_SCHEMA, key],
            capture_output=True,
            text=True,
            timeout=2,
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if os.environ.get("EDI_THEME_DEBUG") and result.stderr.strip():
        _log(f"gsettings stderr for {key!r}: {result.stderr.strip()!r}")
    if result.returncode != 0:
        return None
    return result.stdout.strip().strip("'") or None


def _probe_gsettings_cli() -> object | None:
    """Read the GNOME appearance via ``gsettings`` (a subprocess).

    Consulted only in GNOME-style sessions. On Ubuntu and friends, toggling
    dark switches the *GTK theme name* (``Yaru`` -> ``Yaru-dark``) and leaves
    the ``color-scheme`` key at ``default``; plain GNOME does the opposite.
    Either one is enough, so both are read and combined. A subprocess keeps
    the value independent of the frozen bundle's Qt portal/theme registration
    (which otherwise pins Qt's own scheme hint at a stale value).
    """
    if not _gnome_session():
        return None
    try:
        scheme = _read_gsettings_key(_GSETTINGS_SCHEME_KEY)
        theme = _read_gsettings_key(_GSETTINGS_THEME_KEY)
    except (OSError, subprocess.SubprocessError):
        return None
    if os.environ.get("EDI_THEME_DEBUG"):
        _log(f"gsettings raw scheme={scheme!r} theme={theme!r}")
    if scheme in ("prefer-dark", "prefer-light"):
        return scheme
    if theme:
        return "prefer-dark" if "dark" in theme.lower() else "prefer-light"
    return scheme


def probe_scheme(app) -> Qt.ColorScheme:
    """Resolve the current system color scheme.

    Order: XDG portal -> gsettings D-Bus -> gsettings CLI (GNOME only; a
    subprocess, immune to the frozen bundle's broken portal/app-id
    registration) -> KDE ``kdeglobals`` -> GTK ``settings.ini`` ->
    ``QStyleHints`` as the last resort.

    A reachable setting that expresses *no preference* (portal value 0 /
    ``default``) resolves to ``Unknown`` rather than falling through, so a
    dark-to-default round trip is not silently overwritten by a stale Qt hint.
    """
    for producer in (_probe_appearance, _probe_gsettings, _probe_gsettings_cli):
        value = producer()
        if value is None:
            continue
        scheme = _map_portal(value)
        if scheme is not None:
            return scheme
        return Qt.ColorScheme.Unknown
    for producer in (_probe_kconfig, _probe_gtk):
        scheme = producer()
        if scheme is not None:
            return scheme
    return app.styleHints().colorScheme()


class _ColorSchemeWatcher:
    """Tracks the last pushed scheme so ``Unknown`` can be interpreted.

    ``Unknown`` means "no preference" (value 0) on most Linux desktops, which
    is what a dark-to-default switch lands on rather than ``Light``. If Dark
    was pushed before and Unknown arrives now, treat it as the return to light
    instead of ignoring it and leaving the app stuck in dark mode.
    """

    def __init__(self, window) -> None:
        self._window = window
        self._pushed = Qt.ColorScheme.Unknown
        self._dark = None

    def apply(self, scheme) -> None:
        if scheme == Qt.ColorScheme.Dark:
            if self._dark is not True:
                self.apply_color_scheme(True)
            self._pushed = Qt.ColorScheme.Dark
        elif scheme == Qt.ColorScheme.Light:
            if self._dark is not False:
                self.apply_color_scheme(False)
            self._pushed = Qt.ColorScheme.Light
        elif scheme == Qt.ColorScheme.Unknown and self._pushed == Qt.ColorScheme.Dark:
            self._pushed = Qt.ColorScheme.Light
            self.apply_color_scheme(False)

    def apply_color_scheme(self, dark) -> None:
        self._dark = dark
        apply_color_scheme(self._window, Qt.ColorScheme.Dark if dark else Qt.ColorScheme.Light)
        _log(f"push {'dark' if dark else 'light'}")


def watch_color_scheme(app, window):
    """Track the system color scheme and push changes to ``window``.

    Re-probes via ``probe_scheme`` on every trigger, so a transition that one
    channel drops is caught by the next (Qt signal, 2 s poll).
    """
    hints = app.styleHints()

    def on_signal(scheme):
        _log(f"trigger signal={scheme.name}")
        watcher.apply(scheme)

    def on_poll():
        resolved = probe_scheme(app)
        _log(
            f"trigger poll resolved={resolved.name} "
            f"gs-cli={_probe_gsettings_cli()!r} hints={hints.colorScheme().name}"
        )
        watcher.apply(resolved)

    watcher = _ColorSchemeWatcher(window)
    hints.colorSchemeChanged.connect(on_signal)
    if isinstance(app, QObject):
        timer = QTimer(app)
        timer.setInterval(2000)
        timer.timeout.connect(on_poll)
        timer.start()
    resolved = probe_scheme(app)
    if os.environ.get("EDI_THEME_DEBUG"):
        _log(
            f"watch_color_scheme started "
            f"DE={os.environ.get('XDG_CURRENT_DESKTOP')!r} "
            f"portal={_probe_appearance()!r} "
            f"gsettings={_probe_gsettings()!r} "
            f"gs-cli={_probe_gsettings_cli()!r} "
            f"kconfig={_probe_kconfig()!r} "
            f"gtk={_probe_gtk()!r} "
            f"hints={hints.colorScheme().name} "
            f"resolved={resolved.name}"
        )
    watcher.apply(resolved)
    return watcher