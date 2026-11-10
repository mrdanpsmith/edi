"""Shared environment for tests: offscreen Qt + WebEngine sandbox off.

Must run before PySide6 is imported anywhere.
"""

import atexit
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
# The same flags CI sets. Without --disable-gpu a local offscreen run (macOS
# especially) keeps losing its GPU context and eventually segfaults mid-suite.
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-dev-shm-usage --disable-gpu")

# Isolate QSettings/QStandardPaths from the developer's real config: test mode
# must be enabled before any PySide6 module (or QSettings) is first used.
import shutil
import tempfile

from PySide6.QtCore import QSettings, QStandardPaths

QStandardPaths.setTestModeEnabled(True)

# Test mode alone is not enough. It redirects QStandardPaths, which is where
# QSettings' INI files live on Linux, but QSettings' *native* format is a plist
# on macOS (~/Library/Preferences/com.edi.Edi.plist) and the registry on
# Windows, and test mode moves neither. `test_main.py` names the shared app
# Edi/Edi, so a bare `QSettings()` in the tests then read and wrote the
# developer's real settings: `stored_recents` emptied their recent documents
# and left the fixtures' `/docs/a.md` in their place. So every test-run
# `QSettings()` is an INI file in a throwaway directory, on every platform.
_SETTINGS_DIR = tempfile.mkdtemp(prefix="edi-test-settings-")
QSettings.setDefaultFormat(QSettings.Format.IniFormat)
for _scope in (QSettings.Scope.UserScope, QSettings.Scope.SystemScope):
    QSettings.setPath(QSettings.Format.IniFormat, _scope, _SETTINGS_DIR)
# Removed at exit; `pytest_sessionfinish`'s hard exit removes it itself.
atexit.register(shutil.rmtree, _SETTINGS_DIR, ignore_errors=True)

# The same for document version history (`backend/history.py`): a test save
# must never commit into the developer's real history store.
_HISTORY_DIR = tempfile.mkdtemp(prefix="edi-test-history-")
os.environ["EDI_HISTORY_DIR"] = _HISTORY_DIR
atexit.register(shutil.rmtree, _HISTORY_DIR, ignore_errors=True)

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
        # os._exit skips the atexit handlers still queued (atexit runs last-in,
        # first-out), the settings directory's removal among them.
        shutil.rmtree(_SETTINGS_DIR, ignore_errors=True)
        shutil.rmtree(_HISTORY_DIR, ignore_errors=True)
        os._exit(status)

    atexit.register(_hard_exit)
