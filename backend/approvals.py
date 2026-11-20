"""Which code blocks the reader has agreed to run.

A runnable block can do anything the reader can: read and change their files,
use the network, start programs. A document can come from anywhere, so a block
runs only after the reader has seen its code in the shell's own prompt
(``MainWindow.confirm_run``), which the page can neither draw nor answer.

What is remembered is the **code**, not the document: a hash of the shebang and
the source. So a block runs again without asking only while it is exactly the
code the reader approved; an edit, a ``git pull`` or another tool's change asks
again. The prompt's "Don't ask again for this document until Edi quits" covers
a document the reader is writing code in, where every edit would otherwise ask.
View › Forget Approved Code… takes every answer back.

The hashes are kept in ``QSettings`` under ``approvedCode``, newest first, at
most ``MAX_APPROVALS``; the oldest fall off and simply ask again.
"""

from __future__ import annotations

import hashlib

from PySide6.QtCore import QSettings

SETTINGS_KEY = "approvedCode"
MAX_APPROVALS = 1000


def code_digest(shebang: str, source: str) -> str:
    """The identity of a run: what it would execute, and nothing else."""
    return hashlib.sha256(f"{shebang}\0{source}".encode("utf-8")).hexdigest()


class CodeApprovals:
    """Approved code, and the documents trusted until Edi quits.

    Used on the main thread only (the bridge asks before it spawns a run).
    """

    def __init__(self, settings: QSettings | None = None) -> None:
        self._settings = settings
        self._documents: set[str] = set()
        self._approved: list[str] = self._read()

    def _store(self) -> QSettings:
        return self._settings if self._settings is not None else QSettings()

    def _read(self) -> list[str]:
        value = self._store().value(SETTINGS_KEY, [])
        if isinstance(value, str):
            items = [value]
        elif isinstance(value, (list, tuple)):
            items = list(value)
        else:
            items = []
        return [str(item) for item in items if isinstance(item, str) and len(item) == 64][:MAX_APPROVALS]

    def is_approved(self, document: str, digest: str) -> bool:
        return (bool(document) and document in self._documents) or digest in self._approved

    def approve(self, digest: str) -> None:
        self._approved = [digest, *(item for item in self._approved if item != digest)][:MAX_APPROVALS]
        self._store().setValue(SETTINGS_KEY, self._approved)

    def trust_until_quit(self, document: str) -> None:
        if document:
            self._documents.add(document)

    def count(self) -> int:
        return len(self._approved) + len(self._documents)

    def forget(self) -> None:
        self._approved = []
        self._documents.clear()
        self._store().remove(SETTINGS_KEY)
