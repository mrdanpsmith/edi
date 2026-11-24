"""Where the app actions (About, Check for Updates, Settings, Quit) go, per platform.

Built with ``sys.platform`` set to each value, so both layouts are checked on
every host: `tests/window/test_window.py` sees only the one it runs on.
"""

from __future__ import annotations

import sys

import pytest

from tests.test_contract import _MenusOnly


def _labels(menu) -> list[str]:
    return [action.text() for action in menu.actions()]


@pytest.mark.parametrize("platform", ["linux", "win32"])
def test_linux_and_windows_have_no_app_menu_and_keep_the_actions_where_they_expect(
    platform, qapp, monkeypatch
):
    monkeypatch.setattr(sys, "platform", platform)
    window = _MenusOnly()

    assert _labels(window.menuBar()) == ["&File", "&Edit", "&Insert", "&View", "&Window", "&Help"]
    assert _labels(window._file_menu)[-2:] == ["", "&Quit Edi"]
    assert _labels(window._edit_menu)[-2:] == ["", "&Settings…"]
    assert _labels(window._help_menu) == [
        "&Edi Guide…", "&Formula Reference…", "", "&About Edi…", "Check for &Updates…",
    ]


def test_macos_appends_the_app_actions_to_help_for_qt_to_move(qapp, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    window = _MenusOnly()

    assert _labels(window.menuBar()) == ["&File", "&Edit", "&Insert", "&View", "&Window", "&Help"]
    # No separators: Qt moves these four into the application menu, and a
    # separator left behind would trail the Help items.
    assert _labels(window._help_menu) == [
        "&Edi Guide…", "&Formula Reference…",
        "&About Edi…", "Check for &Updates…", "&Settings…", "&Quit Edi",
    ]
    assert "&Quit Edi" not in _labels(window._file_menu)
    assert "&Settings…" not in _labels(window._edit_menu)
