"""Tests for backend theme sync (system color-scheme changes)."""

from __future__ import annotations

import json
import time

from PySide6.QtCore import Qt

import pytest

from backend import theme as theme_module
from backend.bridge import Bridge
from backend.theme import (
    _map_portal,
    apply_color_scheme,
    probe_scheme,
    watch_color_scheme,
)


def _pump_until(condition, timeout=8.0):
    from PySide6.QtWidgets import QApplication

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if condition():
            return True
        time.sleep(0.02)
    return False


class FakeBridge:
    def __init__(self):
        self.events = []

    def emit_event(self, event):
        self.events.append(event)


class FakeWindow:
    def __init__(self):
        self._bridge = FakeBridge()

    def windowHandle(self):
        return None

    def push_event(self, event):
        self._bridge.emit_event(event)


def test_bridge_emit_event_delivers_notify(qapp):
    window = FakeWindow()
    bridge = Bridge(window)
    received = []
    bridge.notify.connect(received.append)
    bridge.emit_event({"type": "colorScheme", "dark": True})
    assert _pump_until(lambda: received, timeout=5), "notify never emitted"
    assert json.loads(received[0]) == {"type": "colorScheme", "dark": True}


def test_apply_color_scheme_dark(qapp):
    window = FakeWindow()
    apply_color_scheme(window, Qt.ColorScheme.Dark)
    assert window._bridge.events == [{"type": "colorScheme", "dark": True}]


def test_apply_color_scheme_light(qapp):
    window = FakeWindow()
    apply_color_scheme(window, Qt.ColorScheme.Light)
    assert window._bridge.events == [{"type": "colorScheme", "dark": False}]


def test_apply_color_scheme_ignores_unknown(qapp):
    window = FakeWindow()
    apply_color_scheme(window, Qt.ColorScheme.Unknown)
    assert window._bridge.events == []


def test_watcher_dark_then_unknown_is_light(qapp):
    window = FakeWindow()
    watcher = watch_color_scheme(qapp, window)
    watcher.apply(Qt.ColorScheme.Dark)
    watcher.apply(Qt.ColorScheme.Unknown)
    assert window._bridge.events == [
        {"type": "colorScheme", "dark": True},
        {"type": "colorScheme", "dark": False},
    ]


def test_watcher_ignores_unknown_at_boot(qapp):
    window = FakeWindow()
    watch_color_scheme(qapp, window)
    assert window._bridge.events == []


def test_watcher_unknown_after_light_is_noop(qapp):
    window = FakeWindow()
    watcher = watch_color_scheme(qapp, window)
    watcher.apply(Qt.ColorScheme.Light)
    watcher.apply(Qt.ColorScheme.Unknown)
    assert window._bridge.events == [{"type": "colorScheme", "dark": False}]


def test_watch_color_scheme_applies_initial(qapp):
    window = FakeWindow()
    watch_color_scheme(qapp, window)
    scheme = qapp.styleHints().colorScheme()
    if scheme in (Qt.ColorScheme.Dark, Qt.ColorScheme.Light):
        expected = [{"type": "colorScheme", "dark": scheme == Qt.ColorScheme.Dark}]
    else:
        expected = []
    assert window._bridge.events == expected


def test_map_portal_values():
    assert _map_portal(1) is Qt.ColorScheme.Dark
    assert _map_portal(2) is Qt.ColorScheme.Light
    assert _map_portal(0) is None
    assert _map_portal(3) is None
    assert _map_portal("prefer-dark") is Qt.ColorScheme.Dark
    assert _map_portal("prefer-light") is Qt.ColorScheme.Light
    assert _map_portal("default") is None
    assert _map_portal("never") is None
    assert _map_portal(None) is None


def test_probe_scheme_prefers_portal(qapp, monkeypatch):
    monkeypatch.setattr(theme_module, "_probe_appearance", lambda: 1)
    assert probe_scheme(qapp) is Qt.ColorScheme.Dark


def test_probe_scheme_falls_back_to_gsettings(qapp, monkeypatch):
    monkeypatch.setattr(theme_module, "_probe_appearance", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings", lambda: "prefer-light")
    assert probe_scheme(qapp) is Qt.ColorScheme.Light


def test_probe_scheme_falls_back_to_qt_without_bus(qapp, monkeypatch):
    monkeypatch.setattr(theme_module, "_probe_appearance", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings_cli", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_kconfig", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gtk", lambda: None)
    assert probe_scheme(qapp) == qapp.styleHints().colorScheme()


def test_probe_scheme_handles_no_preference(qapp, monkeypatch):
    monkeypatch.setattr(theme_module, "_probe_appearance", lambda: 0)
    monkeypatch.setattr(theme_module, "_probe_gsettings", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings_cli", lambda: None)
    assert probe_scheme(qapp) is Qt.ColorScheme.Unknown


def test_probe_scheme_prefers_kconfig_over_gtk(qapp, monkeypatch):
    monkeypatch.setattr(theme_module, "_probe_appearance", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings_cli", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_kconfig", lambda: Qt.ColorScheme.Dark)
    monkeypatch.setattr(theme_module, "_probe_gtk", lambda: Qt.ColorScheme.Light)
    assert probe_scheme(qapp) is Qt.ColorScheme.Dark


def test_probe_scheme_prefers_gtk_when_no_kconfig(qapp, monkeypatch):
    monkeypatch.setattr(theme_module, "_probe_appearance", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings_cli", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_kconfig", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gtk", lambda: Qt.ColorScheme.Dark)
    assert probe_scheme(qapp) is Qt.ColorScheme.Dark


def test_probe_scheme_gsettings_cli_prefer_light(qapp, monkeypatch):
    monkeypatch.setattr(theme_module, "_probe_appearance", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings_cli", lambda: "prefer-light")
    assert probe_scheme(qapp) is Qt.ColorScheme.Light


def test_probe_scheme_gsettings_cli_no_preference_is_unknown(qapp, monkeypatch):
    monkeypatch.setattr(theme_module, "_probe_appearance", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings", lambda: None)
    monkeypatch.setattr(theme_module, "_probe_gsettings_cli", lambda: "default")
    assert probe_scheme(qapp) is Qt.ColorScheme.Unknown


def test_probe_gsettings_cli_gated_to_gnome(monkeypatch):
    # Gate on the desktop env only, never on a working gsettings/dconf (a
    # headless container has neither), so stub the subprocess deterministically.
    fake = _gsettings_fake_run({"gtk-theme": "'Yaru'\n"})
    monkeypatch.setattr(theme_module.subprocess, "run", fake)
    monkeypatch.setattr(theme_module.shutil, "which", lambda _name: "/usr/bin/gsettings")
    monkeypatch.delenv("XDG_CURRENT_DESKTOP", raising=False)
    monkeypatch.delenv("XDG_SESSION_DESKTOP", raising=False)
    assert theme_module._probe_gsettings_cli() is None
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")
    assert theme_module._probe_gsettings_cli() == "prefer-light"
    monkeypatch.delenv("XDG_CURRENT_DESKTOP", raising=False)
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "Pantheon")
    assert theme_module._probe_gsettings_cli() == "prefer-light"
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "KDE")
    assert theme_module._probe_gsettings_cli() is None


def _gsettings_fake_run(by_key):
    def run(args, **kwargs):
        key = args[3]
        stdout = by_key.get(key, "'default'\n")
        return type("R", (), {"returncode": 0, "stdout": stdout})()
    return run


def test_probe_gsettings_cli_reads_value(monkeypatch):
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")
    fake = _gsettings_fake_run({"color-scheme": "'prefer-dark'\n"})
    monkeypatch.setattr(theme_module.subprocess, "run", fake)
    monkeypatch.setattr(theme_module.shutil, "which", lambda _name: "/usr/bin/gsettings")
    assert theme_module._probe_gsettings_cli() == "prefer-dark"


def test_probe_gsettings_cli_reads_gtk_theme(monkeypatch):
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")
    monkeypatch.setattr(theme_module.shutil, "which", lambda _name: "/usr/bin/gsettings")
    fake = _gsettings_fake_run({"gtk-theme": "'Yaru-dark'\n"})
    monkeypatch.setattr(theme_module.subprocess, "run", fake)
    assert theme_module._probe_gsettings_cli() == "prefer-dark"
    fake = _gsettings_fake_run({"gtk-theme": "'Yaru'\n"})
    monkeypatch.setattr(theme_module.subprocess, "run", fake)
    assert theme_module._probe_gsettings_cli() == "prefer-light"


def test_probe_gsettings_cli_prefers_scheme_over_theme(monkeypatch):
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")
    fake = _gsettings_fake_run({"color-scheme": "'prefer-dark'\n", "gtk-theme": "'Yaru'\n"})
    monkeypatch.setattr(theme_module.subprocess, "run", fake)
    monkeypatch.setattr(theme_module.shutil, "which", lambda _name: "/usr/bin/gsettings")
    assert theme_module._probe_gsettings_cli() == "prefer-dark"


def test_read_gsettings_key_scrubs_bundle_env(monkeypatch):
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEI12345")
    captured = {}

    def run(args, capture_output=True, text=True, timeout=2, env=None):
        captured["env"] = env
        return type("R", (), {"returncode": 0, "stdout": "'x'\n", "stderr": ""})()

    monkeypatch.setattr(theme_module.subprocess, "run", run)
    monkeypatch.setattr(theme_module.shutil, "which", lambda _name: "/usr/bin/gsettings")
    assert theme_module._read_gsettings_key("color-scheme") == "x"
    assert "LD_LIBRARY_PATH" not in captured["env"]
    assert "GIO_MODULE_DIR" not in captured["env"]


def test_probe_gsettings_cli_error_is_none(monkeypatch):
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")
    broken = lambda *a, **k: (_ for _ in ()).throw(OSError("no gsettings"))
    monkeypatch.setattr(theme_module.subprocess, "run", broken)
    monkeypatch.setattr(theme_module.shutil, "which", lambda _name: "/usr/bin/gsettings")
    assert theme_module._probe_gsettings_cli() is None
    nonzero = lambda *a, **k: type("R", (), {"returncode": 1, "stdout": ""})()
    monkeypatch.setattr(theme_module.subprocess, "run", nonzero)
    assert theme_module._probe_gsettings_cli() is None


def test_probe_gsettings_cli_without_binary_is_none(monkeypatch):
    monkeypatch.setenv("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")
    monkeypatch.setattr(
        theme_module.subprocess,
        "run",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("run must not be called")),
    )
    monkeypatch.setattr(theme_module.shutil, "which", lambda _name: None)
    assert theme_module._probe_gsettings_cli() is None


def test_name_to_scheme():
    assert theme_module._name_to_scheme("breeze") is Qt.ColorScheme.Light
    assert theme_module._name_to_scheme("BreezeDark") is Qt.ColorScheme.Dark
    assert theme_module._name_to_scheme("Adwaita-dark") is Qt.ColorScheme.Dark
    assert theme_module._name_to_scheme("  Yaru  ") is Qt.ColorScheme.Light
    assert theme_module._name_to_scheme("") is None
    assert theme_module._name_to_scheme(None) is None
    assert theme_module._name_to_scheme(42) is None


def test_probe_kconfig_reads_color_scheme(tmp_path):
    dark = tmp_path / "dark-kdeglobals"
    dark.write_text("[General]\nColorScheme=BreezeDark\n")
    assert theme_module._probe_kconfig(str(dark)) is Qt.ColorScheme.Dark
    light = tmp_path / "light-kdeglobals"
    light.write_text("[General]\nColorScheme=breeze\n")
    assert theme_module._probe_kconfig(str(light)) is Qt.ColorScheme.Light
    missing = tmp_path / "missing-kdeglobals"
    assert theme_module._probe_kconfig(str(missing)) is None


def test_probe_gtk_prefers_dark_flag_over_name(tmp_path):
    settings = tmp_path / "settings.ini"
    settings.write_text("[Settings]\ngtk-application-prefer-dark-theme=true\ngtk-theme-name=Breeze\n")
    assert theme_module._probe_gtk(str(settings)) is Qt.ColorScheme.Dark


def test_probe_gtk_reads_theme_name(tmp_path):
    settings = tmp_path / "settings.ini"
    settings.write_text("[Settings]\ngtk-theme-name=Adwaita-dark\n")
    assert theme_module._probe_gtk(str(settings)) is Qt.ColorScheme.Dark
    settings.write_text("[Settings]\ngtk-theme-name=Adwaita\n")
    assert theme_module._probe_gtk(str(settings)) is Qt.ColorScheme.Light
    settings.write_text("[Settings]\n")
    assert theme_module._probe_gtk(str(settings)) is None