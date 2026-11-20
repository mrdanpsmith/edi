"""Noticing a newer Edi (`backend/updates.py`)."""

from __future__ import annotations

import io
import json
import ssl
import threading
import time

import truststore

from PySide6.QtCore import QObject, QSettings
from PySide6.QtWidgets import QApplication

import pytest

from backend import __version__
from backend.updates import (
    CHECK_INTERVAL_SECONDS,
    LATEST_RELEASE_API,
    RELEASES_API,
    UpdateCheck,
    UpdateResult,
    UpdateSettings,
    fetch_latest_version,
    is_newer,
    macos_install_command,
    parse_version,
    release_page,
)


@pytest.fixture
def settings(tmp_path):
    return QSettings(str(tmp_path / "edi.ini"), QSettings.Format.IniFormat)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1.2.3", (1, 2, 3, 1, 0)),
        ("v10.0.1", (10, 0, 1, 1, 0)),
        (" 1.0.0 ", (1, 0, 0, 1, 0)),
        ("1.0.0-rc.2", (1, 0, 0, 0, 2)),
        ("1.2", None),
        ("1.2.3-rc1", None),
        ("1.2.3-rc.0", None),
        ("1.2.3-beta.1", None),
        ("v", None),
    ],
)
def test_parse_version(text, expected):
    assert parse_version(text) == expected


def test_is_newer_compares_numerically():
    assert is_newer("1.10.0", "1.9.9")
    assert not is_newer("1.2.0", "1.2.0")
    assert not is_newer("1.1.9", "1.2.0")
    assert not is_newer("garbage", "1.2.0")


def test_a_release_is_newer_than_its_candidates():
    assert is_newer("1.0.0", "1.0.0-rc.3")
    assert is_newer("1.0.1", "1.0.0-rc.1")
    assert not is_newer("0.32.0", "1.0.0-rc.1")
    assert is_newer("1.0.0-rc.10", "1.0.0-rc.2")
    assert not is_newer("1.0.0-rc.1", "1.0.0")


def test_release_page_is_built_from_the_version_alone():
    assert release_page("1.2.0") == "https://github.com/mrdanpsmith/edi/releases/tag/v1.2.0"
    with pytest.raises(ValueError):
        release_page("1.2.0/../../evil")


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def test_fetch_reads_only_the_tag_and_names_no_one():
    seen = {}

    def opener(request, timeout, context):
        seen["url"] = request.full_url
        seen["agent"] = request.get_header("User-agent")
        seen["timeout"] = timeout
        seen["context"] = context
        return _Response(json.dumps({"tag_name": "v1.4.2", "html_url": "https://evil.example"}).encode())

    # The current version is given, never the repository's: it spends time on
    # candidates, which take the other path.
    assert fetch_latest_version(opener, current="1.4.0") == "1.4.2"
    assert seen["url"] == LATEST_RELEASE_API
    assert seen["agent"] == f"Edi/{__version__}"
    assert seen["timeout"] > 0
    # Verified against the OS trust store, with hostname checks on.
    assert isinstance(seen["context"], truststore.SSLContext)
    assert seen["context"].verify_mode == ssl.CERT_REQUIRED
    assert seen["context"].check_hostname


def _releases(*releases):
    """An opener answering GitHub's release list, recording what was asked."""
    asked = []

    def opener(request, timeout, context):
        asked.append(request.full_url)
        return _Response(json.dumps(list(releases)).encode())

    return opener, asked


def test_a_release_asks_only_for_the_latest_release():
    opener, asked = _releases()

    def latest_only(request, timeout, context):
        asked.append(request.full_url)
        return _Response(json.dumps({"tag_name": "v1.2.0"}).encode())

    assert fetch_latest_version(latest_only, current="1.1.0") == "1.2.0"
    assert asked == [LATEST_RELEASE_API]


def test_a_candidate_hears_about_the_next_candidate():
    opener, asked = _releases(
        {"tag_name": "v1.0.0-rc.9", "draft": True},
        {"tag_name": "nightly"},
        {"tag_name": "v1.0.0-rc.2", "prerelease": True},
        {"tag_name": "v1.0.0-rc.1", "prerelease": True},
        {"tag_name": "v0.31.0"},
    )
    assert fetch_latest_version(opener, current="1.0.0-rc.1") == "1.0.0-rc.2"
    assert asked == [RELEASES_API]
    assert UpdateResult("1.0.0-rc.2", None, "1.0.0-rc.1").newer


def test_a_candidate_hears_about_its_release():
    opener, _ = _releases(
        {"tag_name": "v1.0.0", "prerelease": False},
        {"tag_name": "v1.0.0-rc.3", "prerelease": True},
    )
    assert fetch_latest_version(opener, current="1.0.0-rc.3") == "1.0.0"


def test_the_newest_candidate_is_told_it_is_the_newest():
    opener, _ = _releases({"tag_name": "v1.0.0-rc.2", "prerelease": True}, {"tag_name": "v0.31.0"})
    latest = fetch_latest_version(opener, current="1.0.0-rc.2")
    assert not UpdateResult(latest, None, "1.0.0-rc.2").newer


def test_the_macos_upgrade_line_pins_a_candidate():
    assert macos_install_command("1.0.0-rc.2") == (
        "curl -fsSL https://github.com/mrdanpsmith/edi/releases/download/v1.0.0-rc.2/install.sh"
        " | EDI_VERSION=1.0.0-rc.2 bash"
    )
    assert macos_install_command("1.0.0") == (
        "curl -fsSL https://github.com/mrdanpsmith/edi/releases/latest/download/install.sh | bash"
    )


@pytest.mark.parametrize(
    ("current", "body"),
    [
        ("1.0.0", {"tag_name": "nightly"}),
        ("1.0.0", {}),
        ("1.0.0", ["v1.0.0"]),
        ("1.0.0-rc.1", {"tag_name": "v1.0.0"}),
        ("1.0.0-rc.1", [{"tag_name": "nightly"}, {"tag_name": "v2.0.0", "draft": True}]),
    ],
)
def test_fetch_refuses_an_answer_that_names_no_version(current, body):
    with pytest.raises(ValueError):
        fetch_latest_version(lambda _request, timeout, context: _Response(json.dumps(body).encode()), current=current)


def test_automatic_checks_are_off_until_turned_on(settings):
    updates = UpdateSettings(settings)
    assert not updates.automatic()
    assert not updates.due()
    updates.set_automatic(True)
    assert UpdateSettings(settings).due()


def test_an_automatic_check_waits_a_day(settings):
    updates = UpdateSettings(settings)
    updates.set_automatic(True)
    updates.mark_checked(1_000_000.0)
    assert not updates.due(1_000_000.0 + CHECK_INTERVAL_SECONDS - 1)
    assert updates.due(1_000_000.0 + CHECK_INTERVAL_SECONDS)
    # A clock moved back does not silence the check for good.
    assert updates.due(999_000.0)


def test_a_hand_edited_setting_reads_back(settings):
    settings.setValue("updates/automatic", "true")
    settings.setValue("updates/lastCheck", "not a time")
    updates = UpdateSettings(settings)
    assert updates.automatic()
    assert updates.last_check() == 0.0


class _Receiver(QObject):
    def __init__(self) -> None:
        super().__init__()
        self.results: list[tuple[UpdateResult, bool]] = []

    def got(self, result: UpdateResult) -> None:
        self.results.append((result, threading.current_thread() is threading.main_thread()))


def _deliver(fetch) -> tuple[UpdateResult, bool]:
    receiver = _Receiver()
    check = UpdateCheck(fetch)
    check.finished.connect(receiver.got)
    check.start()
    deadline = time.monotonic() + 5
    while not receiver.results and time.monotonic() < deadline:
        QApplication.processEvents()
    assert receiver.results, "the check never finished"
    return receiver.results[0]


def test_a_check_answers_on_the_receivers_thread(qapp):
    result, on_main = _deliver(lambda: "99.0.0")
    assert result == UpdateResult("99.0.0", None)
    assert result.newer
    assert on_main


def test_a_failed_check_says_why(qapp):
    def offline() -> str:
        raise OSError("network is unreachable")

    result, _ = _deliver(offline)
    assert result.latest is None
    assert result.error == "network is unreachable"
    assert not result.newer
