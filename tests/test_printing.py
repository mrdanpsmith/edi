"""Tests for printing the exported page from a hidden webview."""

from __future__ import annotations

import os
import tempfile

import pytest
from PySide6.QtCore import QCoreApplication, QEvent, QUrl
from PySide6.QtPrintSupport import QPrintDialog, QPrinter
from PySide6.QtWidgets import QWidget

from backend.printing import PrintJob, with_base
from tests.mermaid_render import _pump_until

PAGE = '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <title>t</title>\n  </head>\n  <body><p>Hi</p></body>\n</html>\n'


def test_with_base_points_relative_urls_at_the_document_folder(tmp_path):
    document = tmp_path / "notes & more" / "a.md"
    page = with_base(PAGE, str(document))
    href = QUrl.fromLocalFile(str(document.parent) + os.sep).toString()
    assert f'<base href="{href.replace("&", "&amp;")}" />' in page
    assert page.index("<base") < page.index("<title>")


def test_with_base_leaves_an_untitled_page_alone():
    assert with_base(PAGE, None) == PAGE


@pytest.fixture
def parent(qapp):
    """The job's parent widget, torn down with everything it spawned.

    A job's dialog and view go by `deleteLater`, which only a running event loop
    honours; `_pump_until` is not one. Left pending, a dead print dialog is
    still the app's modal widget when a later window test asks, and the suite
    segfaults there.
    """
    widget = QWidget()
    yield widget
    widget.deleteLater()
    QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)


def test_start_opens_the_print_dialog_and_a_cancel_reports_not_printed(parent):
    results: list[tuple[bool, str | None]] = []
    job = PrintJob(parent, PAGE, None, lambda printed, error: results.append((printed, error)))
    job.start()
    dialogs = parent.findChildren(QPrintDialog)
    assert len(dialogs) == 1
    assert dialogs[0].isVisible()
    dialogs[0].reject()
    assert _pump_until(lambda: results)
    assert results == [(False, None)]


def _print_to_pdf(parent, tmp_path, page_html):
    out = tmp_path / "out.pdf"
    printer = QPrinter(QPrinter.PrinterMode.HighResolution)
    printer.setOutputFormat(QPrinter.OutputFormat.PdfFormat)
    printer.setOutputFileName(str(out))
    results: list[tuple[bool, str | None]] = []
    job = PrintJob(parent, page_html, None, lambda printed, error: results.append((printed, error)))
    job.print_to(printer)
    assert _pump_until(lambda: results, timeout=30.0)
    return out, results, job


def test_print_to_writes_the_page_and_reports_once(parent, tmp_path):
    before = set(os.listdir(tempfile.gettempdir()))
    out, results, job = _print_to_pdf(parent, tmp_path, PAGE)
    assert results == [(True, None)]
    assert out.read_bytes().startswith(b"%PDF")
    # The temporary page is gone once the print reports back.
    leftover = {n for n in set(os.listdir(tempfile.gettempdir())) - before if n.startswith("edi-print-")}
    assert leftover == set()
    job._finish(printed=True)  # a late second signal must not report again
    assert results == [(True, None)]
