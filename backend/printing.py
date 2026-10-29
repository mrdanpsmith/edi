"""Print a standalone HTML page through the native print dialog.

The page hands over the same document HTML that Export writes. It is printed
from a hidden webview of its own, never the app's view: the app's page carries
the toolbar, tabs and block controls, and the bridge.
"""

from __future__ import annotations

import html as html_lib
import os
import tempfile
from typing import Callable

from PySide6.QtCore import QUrl, Qt
from PySide6.QtPrintSupport import QPrintDialog, QPrinter
from PySide6.QtWebEngineCore import QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QDialog, QWidget


def with_base(page_html: str, document_path: str | None) -> str:
    """``page_html`` with a ``<base>`` at the document's folder, so relative images resolve.

    The page is loaded from a temporary file, not ``setHtml``: ``setHtml`` caps
    content at 2 MB, and baked Mermaid diagrams are inline PNGs.
    """
    if not document_path:
        return page_html
    folder = os.path.dirname(os.path.abspath(document_path))
    href = QUrl.fromLocalFile(folder + os.sep).toString()
    return page_html.replace("<head>", f'<head>\n    <base href="{html_lib.escape(href)}" />', 1)


class PrintJob:
    """One print: dialog, then load, then print, then ``done(printed, error)`` exactly once.

    A cancelled dialog is ``done(False, None)``; a page that will not load or a
    print that fails is ``done(False, message)``.
    """

    def __init__(
        self,
        parent: QWidget,
        page_html: str,
        document_path: str | None,
        done: Callable[[bool, str | None], None],
    ) -> None:
        self._parent = parent
        self._html = with_base(page_html, document_path)
        self._done = done
        self._printer = QPrinter(QPrinter.PrinterMode.HighResolution)
        self._view: QWebEngineView | None = None
        self._path: str | None = None

    def start(self) -> None:
        dialog = QPrintDialog(self._printer, self._parent)

        def chosen(result: int) -> None:
            dialog.deleteLater()
            if result == QDialog.DialogCode.Accepted:
                self.print_to(self._printer)
            else:
                self._finish(printed=False)

        dialog.finished.connect(chosen)
        # Non-blocking, like `_run_dialog`, but spelled out: PySide6's
        # QPrintDialog binds only `open(receiver, member)`, so the bare
        # `open()` raises. Window-modal + show is what `QDialog.open()` does.
        dialog.setWindowModality(Qt.WindowModality.WindowModal)
        dialog.show()

    def print_to(self, printer: QPrinter) -> None:
        """Load the page and print it on ``printer`` (the dialog's, or a test's PDF)."""
        self._printer = printer
        fd, self._path = tempfile.mkstemp(prefix="edi-print-", suffix=".html")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(self._html)

        # Never shown: Chromium lays out and prints a hidden view. The document
        # needs no script (Mermaid arrives baked), so none runs.
        view = QWebEngineView(self._parent)
        view.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptEnabled, False)
        view.loadFinished.connect(self._loaded)
        view.printFinished.connect(self._printed)
        self._view = view
        view.load(QUrl.fromLocalFile(self._path))

    def _loaded(self, ok: bool) -> None:
        if self._view is None:
            return
        if not ok:
            self._finish(error="Could not lay out the document for printing")
            return
        self._view.print(self._printer)

    def _printed(self, ok: bool) -> None:
        if ok:
            self._finish(printed=True)
        else:
            self._finish(error="Printing failed")

    def _finish(self, printed: bool = False, error: str | None = None) -> None:
        if self._view is not None:
            self._view.deleteLater()
            self._view = None
        if self._path is not None:
            try:
                os.remove(self._path)
            except OSError:
                pass
            self._path = None
        done, self._done = self._done, None
        if done is not None:
            done(printed, error)
