"""Shared environment for tests: offscreen Qt + WebEngine sandbox off.

Must run before PySide6 is imported anywhere.
"""

import atexit
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")

import pytest


@pytest.fixture(scope="session")
def qapp():
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([])
    yield app


def pytest_sessionfinish(session, exitstatus) -> None:
    # QtWebEngine segfaults at interpreter exit in headless/container runs: its
    # Chromium teardown fires after pytest is fully done and segfaults, which
    # marks a green CI job as failed (exit 139). Bypass Qt teardown with
    # os._exit, passing through pytest's real exit status. Registered only now
    # (not at import) so real crashes mid-run still propagate as signals.
    status = int(exitstatus)

    def _hard_exit() -> None:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(status)

    atexit.register(_hard_exit)
