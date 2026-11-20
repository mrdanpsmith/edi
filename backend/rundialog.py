"""The prompt that stands between a code block and running it.

The shell's own dialog, so nothing in the page can draw it, fill it in or answer
it. It shows what would run: the interpreter and its flags, and the code itself,
because a block's code is what the reader is agreeing to (``backend/approvals.py``).
Cancel is the default, so a stray Return runs nothing.
"""

from __future__ import annotations

import shlex

from PySide6.QtCore import Qt
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QLabel,
    QPlainTextEdit,
    QVBoxLayout,
)

RUN_DIALOG_NAME = "ediRunCodeDialog"


class RunCodeDialog(QDialog):
    def __init__(self, parent, document: str, command: list[str], source: str, can_trust: bool) -> None:
        super().__init__(parent)
        self.setObjectName(RUN_DIALOG_NAME)
        self.setWindowTitle("Run code?")
        self.setWindowModality(Qt.WindowModality.WindowModal)
        self.setMinimumWidth(520)

        layout = QVBoxLayout(self)
        heading = QLabel(f"Run this code from {document} with {shlex.join(command)}?")
        heading.setTextFormat(Qt.TextFormat.PlainText)
        heading.setWordWrap(True)
        font = heading.font()
        font.setBold(True)
        heading.setFont(font)
        layout.addWidget(heading)

        warning = QLabel(
            "Code can do anything you can: read and change your files, use the network "
            "and start programs. Run it only if you trust where the document came from. "
            "Edi will not ask again for this exact code."
        )
        warning.setTextFormat(Qt.TextFormat.PlainText)
        warning.setWordWrap(True)
        layout.addWidget(warning)

        self.code = QPlainTextEdit(source)
        self.code.setObjectName("code")
        self.code.setReadOnly(True)
        self.code.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        self.code.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont))
        line = self.code.fontMetrics().lineSpacing()
        self.code.setMinimumHeight(line * min(max(source.count("\n") + 2, 4), 16))
        layout.addWidget(self.code)

        self.trust: QCheckBox | None = None
        if can_trust:
            self.trust = QCheckBox(f"Don't ask again for {document} until Edi quits")
            self.trust.setObjectName("trust")
            layout.addWidget(self.trust)

        buttons = QDialogButtonBox()
        self.run_button = buttons.addButton("Run", QDialogButtonBox.ButtonRole.AcceptRole)
        self.cancel_button = buttons.addButton(QDialogButtonBox.StandardButton.Cancel)
        self.run_button.setAutoDefault(False)
        self.cancel_button.setDefault(True)
        self.cancel_button.setFocus()
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def trusts_document(self) -> bool:
        return self.trust is not None and self.trust.isChecked()
