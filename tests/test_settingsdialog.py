"""Tests for Settings… (`backend/settingsdialog.py`).

The dialog on its own, with stand-ins for the setters and actions the window
hands it. The window's wiring (which preference each option writes, what the
page hears) is in `tests/window/test_window.py`.
"""

from __future__ import annotations

import pytest
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QDialogButtonBox

from backend.settingsdialog import Action, Option, SettingsDialog


@pytest.fixture
def dialog(qtbot):
    calls: dict[str, list] = {"band": [], "updates": [], "ran": []}
    made = SettingsDialog(
        None,
        options=[
            Option("hoverBand", "Show the hover band", True, calls["band"].append),
            Option("automaticUpdates", "Check for updates", False, calls["updates"].append),
        ],
        actions=[
            Action("history", "Manage Version History…", lambda parent: calls["ran"].append(("history", parent))),
            Action("approvedCode", "Forget Approved Code…", lambda parent: calls["ran"].append(("code", parent))),
        ],
    )
    made.calls = calls
    qtbot.addWidget(made)
    made.show()
    return made


def test_each_option_shows_its_value_and_reports_a_change(dialog):
    band = dialog.checkboxes["hoverBand"]
    updates = dialog.checkboxes["automaticUpdates"]
    assert band.text() == "Show the hover band" and band.isChecked()
    assert not updates.isChecked()

    band.click()
    updates.click()
    assert dialog.calls["band"] == [False]
    assert dialog.calls["updates"] == [True]


def test_each_action_runs_with_the_dialog_as_its_parent(dialog):
    """What an action opens stacks on Settings, not behind it on the window."""
    dialog.buttons["history"].click()
    dialog.buttons["approvedCode"].click()
    assert dialog.calls["ran"] == [("history", dialog), ("code", dialog)]


def test_the_options_and_actions_are_grouped_and_close_is_the_only_button(dialog):
    from PySide6.QtWidgets import QGroupBox

    titles = [box.title() for box in dialog.findChildren(QGroupBox)]
    assert titles == ["General", "Privacy && Data"]
    box = dialog.findChild(QDialogButtonBox)
    assert [button.text() for button in box.buttons()] == ["Close"]


def test_no_action_is_the_default_button_and_escape_closes(dialog, qtbot):
    """No data button is a default button, so Return cannot forget anything."""
    assert not any(button.autoDefault() or button.isDefault() for button in dialog.buttons.values())
    qtbot.keyClick(dialog, Qt.Key.Key_Escape)
    assert not dialog.isVisible()
    assert dialog.calls["ran"] == []
