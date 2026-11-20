"""The sites the page may load from (`backend/remote.py`)."""

from __future__ import annotations

from PySide6.QtCore import QSettings, QUrl

import pytest

from backend.remote import SETTINGS_KEY, AllowedHosts, RemoteRequestInterceptor, normalize_host


@pytest.fixture
def settings(tmp_path):
    return QSettings(str(tmp_path / "edi.ini"), QSettings.Format.IniFormat)


class _Request:
    """The two calls the interceptor makes on a `QWebEngineUrlRequestInfo`."""

    def __init__(self, url: str) -> None:
        self._url = QUrl(url)
        self.blocked: bool | None = None

    def requestUrl(self) -> QUrl:  # noqa: N802 (Qt name)
        return self._url

    def block(self, value: bool) -> None:
        self.blocked = value


def _intercept(hosts: AllowedHosts, url: str) -> bool:
    request = _Request(url)
    RemoteRequestInterceptor(hosts).interceptRequest(request)  # pyright: ignore[reportArgumentType]
    return request.blocked is True


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("I.Imgur.COM", "i.imgur.com"), ("example.org.", "example.org"), ("[::1]", "::1"), ("a b", None), ("a/b", None), ("", None)],
)
def test_normalize_host(raw, expected):
    assert normalize_host(raw) == expected


def test_an_ipv6_site_allowed_as_the_page_spells_it_matches_requests(settings):
    hosts = AllowedHosts(settings)
    hosts.allow(["[::1]"], remember=False)
    assert not _intercept(hosts, "http://[::1]:8000/a.png")


def test_a_run_answer_lasts_until_quit_and_is_not_saved(settings):
    hosts = AllowedHosts(settings)
    hosts.allow(["Example.org"], remember=False)
    assert hosts.is_allowed("example.org")
    assert not AllowedHosts(settings).is_allowed("example.org")


def test_a_saved_answer_survives_a_restart(settings):
    AllowedHosts(settings).allow(["i.imgur.com"], remember=True)
    again = AllowedHosts(settings)
    assert again.is_allowed("I.IMGUR.com")
    assert again.saved() == ["i.imgur.com"]


def test_a_site_is_matched_exactly(settings):
    hosts = AllowedHosts(settings)
    hosts.allow(["i.imgur.com"], remember=False)
    assert not hosts.is_allowed("imgur.com")
    assert not hosts.is_allowed("evil.i.imgur.com")


def test_forget_takes_back_every_answer(settings):
    hosts = AllowedHosts(settings)
    hosts.allow(["a.example"], remember=True)
    hosts.allow(["b.example"], remember=False)
    hosts.forget()
    assert hosts.allowed() == []
    assert settings.value(SETTINGS_KEY) is None
    assert AllowedHosts(settings).allowed() == []


def test_a_single_saved_site_reads_back_from_a_bare_string(settings):
    settings.setValue(SETTINGS_KEY, "example.org")
    assert AllowedHosts(settings).saved() == ["example.org"]


@pytest.mark.parametrize(
    "url",
    ["https://example.org/a.png", "http://example.org/a.png", "wss://example.org/socket", "HTTPS://EXAMPLE.ORG/x"],
)
def test_requests_to_a_site_not_allowed_are_blocked(settings, url):
    assert _intercept(AllowedHosts(settings), url)


def test_requests_to_an_allowed_site_go_through(settings):
    hosts = AllowedHosts(settings)
    hosts.allow(["example.org"], remember=False)
    assert not _intercept(hosts, "https://example.org/a.png")
    assert _intercept(hosts, "https://other.example/a.png")


@pytest.mark.parametrize("url", ["file:///tmp/a.png", "data:image/png;base64,AAAA", "qrc:///qtwebchannel/qwebchannel.js"])
def test_local_requests_are_never_blocked(settings, url):
    assert not _intercept(AllowedHosts(settings), url)
