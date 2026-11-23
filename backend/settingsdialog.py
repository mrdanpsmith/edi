"""Edi › Settings…: the app's options and its stored-data actions.

A native dialog, never a page in the editor, for the same reason the actions it
holds are the shell's own: nothing running in the page can list, wipe or write
back the version history, the recent documents, the allowed image sites or the
approved code. The page only hears about the options it applies itself (the
hover band and git commits in Version History), through the window's
``preferenceChanged`` event.

The dialog owns no state. It is handed each option's current value and a
setter, and each data action's callback; every change takes effect as it is
made, so there is nothing to apply and the only button is Close.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QGroupBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)


@dataclass(frozen=True)
class Option:
    """A checkbox: its label, its value now, and what to call when it changes."""

    key: str
    label: str
    checked: bool
    changed: Callable[[bool], None]


@dataclass(frozen=True)
class Action:
    """A button that opens one of the shell's own dialogs or prompts.

    ``run`` gets the Settings dialog, so what it opens stacks on top of it
    rather than behind it.
    """

    key: str
    label: str
    run: Callable[[QWidget], object]


class SettingsDialog(QDialog):
    """General options above, the stored-data actions below, and Close."""

    def __init__(
        self,
        parent: QWidget | None,
        *,
        options: Sequence[Option],
        actions: Sequence[Action],
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("Settings")
        self.setWindowModality(Qt.WindowModality.WindowModal)
        self.checkboxes: dict[str, QCheckBox] = {}
        self.buttons: dict[str, QPushButton] = {}

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 14)
        layout.setSpacing(14)

        general = QGroupBox("General")
        general_layout = QVBoxLayout(general)
        for option in options:
            box = QCheckBox(option.label)
            box.setChecked(option.checked)
            box.toggled.connect(option.changed)
            general_layout.addWidget(box)
            self.checkboxes[option.key] = box
        layout.addWidget(general)

        data = QGroupBox("Privacy && Data")
        data_layout = QVBoxLayout(data)
        for action in actions:
            button = QPushButton(action.label)
            # Not the dialog's default button: Return closes Settings, it does
            # not start forgetting things.
            button.setAutoDefault(False)
            button.clicked.connect(lambda _checked=False, run=action.run: run(self))
            data_layout.addWidget(button)
            self.buttons[action.key] = button
        layout.addWidget(data)

        close = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        close.rejected.connect(self.reject)
        layout.addWidget(close)

        self.setMinimumWidth(380)
        self.adjustSize()
