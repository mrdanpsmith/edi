"""The persisted preferences: defaults, round-trip, and coercion.

Every test here runs against a ``QSettings`` pointed at a temp file. The real
store is a user's file (``~/.config/Edi/Edi.conf``), and a test suite that wrote
to the developer's own would be a test suite that silently changes their
editor's zoom level.
"""

import json
import math
import os
import subprocess
import sys
from pathlib import Path

import pytest
from PySide6.QtCore import QSettings

from backend.preferences import DEFAULTS, NAMES, Preferences

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def prefs(tmp_path):
    return Preferences(QSettings(str(tmp_path / "prefs.ini"), QSettings.Format.IniFormat))


def test_a_fresh_store_is_entirely_defaults(prefs):
    assert prefs.all() == {"zoomFactor": 1.0, "toolbarVisible": True, "hoverBand": True}


def test_the_defaults_are_the_ones_the_frontend_ships(prefs):
    # Zoom at 100%, the toolbar row on, the hover band on — the three answers a
    # reader has to be given before they have expressed a preference.
    assert DEFAULTS == {"zoomFactor": 1.0, "toolbarVisible": True, "hoverBand": True}
    assert NAMES == frozenset(DEFAULTS)


def test_a_value_survives_a_new_store_over_the_same_file(prefs, tmp_path):
    prefs.set("zoomFactor", 1.5)
    prefs.set("toolbarVisible", False)
    prefs.set("hoverBand", False)

    reopened = Preferences(QSettings(str(tmp_path / "prefs.ini"), QSettings.Format.IniFormat))
    assert reopened.all() == {"zoomFactor": 1.5, "toolbarVisible": False, "hoverBand": False}


def _in_a_fresh_interpreter(path, expression):
    """Run one expression against a store over ``path``, in its own process.

    Two of these are two runs of the app, which is the only honest way to test
    "remembered": ``QSettings`` caches per path *within* a process, so a second
    ``Preferences`` over the same file in this interpreter would read that cache
    and pass even if ``setValue`` had never reached the disk at all — which is
    the shape of the bug that put these answers in the page's off-the-record web
    storage in the first place.
    """
    script = (
        "import json\n"
        "from PySide6.QtCore import QSettings\n"
        "from backend.preferences import Preferences\n"
        f"store = Preferences(QSettings({str(path)!r}, QSettings.Format.IniFormat))\n"
        f"print(json.dumps({expression}, sort_keys=True))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=REPO_ROOT,
        env={**os.environ, "QT_QPA_PLATFORM": "offscreen"},
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def test_a_write_reaches_the_file_and_the_next_process_reads_it(tmp_path):
    path = tmp_path / "prefs.ini"
    _in_a_fresh_interpreter(
        path,
        "[store.set(name, value) for name, value in"
        " [('zoomFactor', 1.5), ('toolbarVisible', False), ('hoverBand', False)]] or 'written'",
    )
    # A separate process, so nothing of this one's cache is involved.
    assert _in_a_fresh_interpreter(path, "store.all()") == json.dumps(
        {"zoomFactor": 1.5, "toolbarVisible": False, "hoverBand": False}, sort_keys=True
    )


def test_a_store_nobody_wrote_to_is_defaults_in_the_next_process(tmp_path):
    assert _in_a_fresh_interpreter(tmp_path / "absent.ini", "store.all()") == json.dumps(
        DEFAULTS, sort_keys=True
    )


def test_a_set_value_can_be_asked_back_individually(prefs):
    prefs.set("hoverBand", False)
    assert prefs.get("hoverBand") is False
    assert prefs.get("zoomFactor") == 1.0
    with pytest.raises(KeyError):
        prefs.get("nonsense")


def test_an_unknown_name_is_refused_rather_than_written(prefs, tmp_path):
    """A stale page must not be able to grow the settings file."""
    assert prefs.set("somethingElse", "x") is False
    stored = Preferences(QSettings(str(tmp_path / "prefs.ini"), QSettings.Format.IniFormat))
    assert set(stored.all()) == NAMES


def test_a_hand_edited_file_cannot_switch_a_boolean_on_by_editing_it(prefs, tmp_path):
    """`bool("false")` is ``True``, so the string branch has to be explicit.

    QSettings round-trips a Python bool as one, so this only happens when a
    person edits ``Edi.conf`` — but editing it to turn a preference *off* and
    having it come back on is the worst possible answer.
    """
    settings = QSettings(str(tmp_path / "prefs.ini"), QSettings.Format.IniFormat)
    settings.setValue("hoverBand", "false")
    settings.setValue("toolbarVisible", "0")
    settings.sync()
    assert Preferences(settings).all()["hoverBand"] is False
    assert Preferences(settings).all()["toolbarVisible"] is False


def test_a_hand_edited_level_survives_only_if_it_is_a_number(prefs, tmp_path):
    settings = QSettings(str(tmp_path / "prefs.ini"), QSettings.Format.IniFormat)
    settings.setValue("zoomFactor", "1.25")
    assert Preferences(settings).get("zoomFactor") == 1.25

    settings.setValue("zoomFactor", "nonsense")
    assert Preferences(settings).get("zoomFactor") == 1.0

    settings.setValue("zoomFactor", float("nan"))
    assert Preferences(settings).get("zoomFactor") == 1.0
    assert not math.isnan(Preferences(settings).get("zoomFactor"))


def test_a_level_is_stored_as_asked_and_clamped_by_the_page(prefs):
    """``Edi.conf`` holds what was asked for; the ladder is the frontend's.

    The zoom ladder lives in ``src/zoom.ts`` and the View submenu's rungs are a
    mirror of it, so the store does not second-guess a level — a future rung the
    frontend adds must be storable without a change here. A level off the ladder
    is clamped on the way back in to the editor, which is where the ladder is.
    """
    prefs.set("zoomFactor", 1.23)
    assert prefs.get("zoomFactor") == 1.23
    prefs.set("zoomFactor", 42)
    assert prefs.get("zoomFactor") == 42


def test_a_write_does_not_need_an_explicit_sync(prefs, tmp_path):
    """The write is buffered, and must be readable without asking.

    ``QSettings`` flushes on its own schedule, which is what keeps a zoom
    dragged through a dozen wheel rungs cheap; a test that forces a ``sync()``
    everywhere would hide the opposite regression.
    """
    prefs.set("zoomFactor", 0.8)
    assert Preferences(QSettings(str(tmp_path / "prefs.ini"), QSettings.Format.IniFormat)).get(
        "zoomFactor"
    ) == 0.8
