"""``shared/edi-contract.json`` against the Python side of the boundary.

Three surfaces cross between Python and TypeScript as bare strings, and every
one of them used to drift silently: a renamed menu command left a menu item
that did nothing, a renamed bridge method answered ``Unknown method``, and a
changed preference default disagreed between the store and the page. The
manifest is the single source of truth for the *names*; this file is the
Python half of that gate and ``src/contract.test.ts`` is the TypeScript half
(failing ``tsc --noEmit``, so a rename breaks ``npm run check`` rather than the
running app).

The menu commands are read off a **built menu bar**, not out of the source:
``MainWindow._link_command`` names every action as it is wired, so what is
checked is the menu this file's own reader would dispatch from — a command
that is declared somewhere but never attached to an action cannot pass, and an
action wired to a name the manifest lacks cannot either.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PySide6.QtWidgets import QMainWindow

from backend.bridge import Bridge
from backend.preferences import DEFAULTS, NAMES
from backend.window import MainWindow
from tests.test_bridge import StubWindow

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = REPO_ROOT / "shared" / "edi-contract.json"


@pytest.fixture(scope="module")
def contract() -> dict:
    """The manifest, parsed once for the whole module."""
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


class _MenusOnly(MainWindow):
    """A window that builds its menu bar and none of the webview.

    ``MainWindow.__init__`` is skipped deliberately (``QMainWindow.__init__``
    is called straight instead): it constructs the ``QWebEngineView``, the
    ``Bridge`` and the preference injection, none of which the menu bar reads.
    What ``_build_menus`` needs beyond that is ``_zoom_actions`` — the one
    attribute it *fills* rather than assigns — plus a recent-files list, so
    ``openRecent`` is declared like it is in a real window.

    This is the brief's runtime collection route for the menu commands: the
    alternative (a regex over ``window.py``) would be a second parser for the
    same file, and one that happily matches a command in a comment.
    """

    def __init__(self) -> None:
        QMainWindow.__init__(self)
        self._zoom_actions = {}
        self._build_menus()
        self._refresh_recent_menu()

    def recent_files(self) -> list[str]:
        # One entry, so the submenu holds an action carrying openRecent; the
        # real store reads QSettings and would answer with whatever the
        # developer's own recent list happens to be.
        return ["/tmp/one-recent-document.md"]


def _built_menu_commands() -> set[str]:
    """Every command name carried by an action in a freshly built menu bar.

    Walks the bar's menus recursively, skipping separators and the two actions
    that are deliberately not commands (Quit closes the window, About opens a
    dialog — neither is routed to the page, so neither carries a name).
    """
    window = _MenusOnly()
    commands: set[str] = set()

    def walk(menu) -> None:
        for action in menu.actions():
            if action.isSeparator():
                continue
            data = action.data()
            if isinstance(data, str):
                commands.add(data)
            if action.menu() is not None:
                walk(action.menu())

    walk(window.menuBar())
    # A walk that found nothing would compare equal to a manifest that listed
    # nothing; the menu bar is not allowed to be empty of commands.
    assert commands, "the built menu bar declared no commands at all"
    return commands


def test_every_bridge_method_is_declared_and_vice_versa(contract):
    """(a) ``Bridge._handlers`` and ``bridgeMethods`` name the same methods."""
    bridge = Bridge(StubWindow())
    assert set(bridge._handlers) == set(contract["bridgeMethods"])


def test_the_built_menubar_declares_exactly_the_declared_commands(contract, qapp):
    """(b) the real menu bar and ``menuCommands`` name the same commands.

    ``qapp`` first: constructing a widget with no QApplication under the
    offscreen platform does not raise, it segfaults.
    """
    assert _built_menu_commands() == set(contract["menuCommands"])


def test_the_preference_defaults_are_the_declared_ones(contract):
    """(c) the store's defaults and names are the manifest's, exactly."""
    assert DEFAULTS == contract["preferences"]
    assert NAMES == frozenset(contract["preferences"])


def test_the_bridge_error_codes_are_the_declared_ones(contract):
    """(d) every ``code`` the bridge can reply with is one the page knows."""
    from backend.bridge import NOT_PERMITTED

    assert set(contract["errorCodes"]) == {NOT_PERMITTED}


def test_both_name_sections_are_sorted(contract):
    """Sorted, so a rename shows up in a diff as one changed line."""
    for section in ("menuCommands", "bridgeMethods"):
        names = list(contract[section])
        assert names, f"{section} is empty"
        assert names == sorted(names), f"{section} is not in sorted order"
