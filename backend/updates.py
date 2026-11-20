"""Telling the reader a newer Edi exists.

Edi has no updater: a new version is installed the way the first one was
(README, "Upgrading"). What it can do is notice one. Asking GitHub tells GitHub
the reader's address and that they run Edi, so it happens only when the reader
asks: Help › Check for Updates…, or, once they turn it on, Help › Check for
Updates Automatically, at most once a day at launch.

The request is the shell's, made with ``urllib`` from a worker thread, never the
page's: the page loads nothing remote unasked (``backend/remote.py``), and it
should not be the part of Edi that talks to the network. Only the release's tag
is read from the answer. The link offered to the reader is built here from that
version, not taken from the response.

**The server is verified against the operating system's trust store**
(``truststore``: the Security framework on macOS, the certificate store on
Windows, the system CA bundle on Linux). A frozen build's own OpenSSL looks for
CA files where the build machine kept them (``/opt/homebrew/…`` from a Homebrew
Python), which a reader's machine need not have; a bundled CA list would only be
as current as the last Edi release. The OS store is kept current by the OS.
"""

from __future__ import annotations

import json
import re
import ssl
import threading
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

import truststore
from PySide6.QtCore import QObject, QSettings, Signal

from . import __version__

REPOSITORY = "mrdanpsmith/edi"
LATEST_RELEASE_API = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
# The newest releases, candidates included: asked only by a candidate.
RELEASES_API = f"https://api.github.com/repos/{REPOSITORY}/releases?per_page=30"
AUTOMATIC_KEY = "updates/automatic"
LAST_CHECK_KEY = "updates/lastCheck"
CHECK_INTERVAL_SECONDS = 24 * 60 * 60
TIMEOUT_SECONDS = 10

_VERSION = re.compile(r"^v?(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-rc\.([1-9]\d{0,3}))?$")


def parse_version(text: str) -> tuple[int, int, int, int, int] | None:
    """A release (``1.2.3``) or a release candidate (``1.2.3-rc.1``), with or
    without a leading ``v``, as a tuple that sorts the way releases do: every
    candidate before its release, and ``rc.10`` after ``rc.2``. ``None`` for
    anything else.
    """
    match = _VERSION.match(text.strip())
    if match is None:
        return None
    major, minor, patch = (int(part) for part in match.groups()[:3])
    candidate = match.group(4)
    if candidate is None:
        return major, minor, patch, 1, 0
    return major, minor, patch, 0, int(candidate)


def is_candidate(version: str) -> bool:
    parts = parse_version(version)
    return parts is not None and parts[3] == 0


def is_newer(latest: str, current: str = __version__) -> bool:
    latest_parts, current_parts = parse_version(latest), parse_version(current)
    return latest_parts is not None and current_parts is not None and latest_parts > current_parts


def release_page(version: str) -> str:
    """The release's page on GitHub, for a version ``parse_version`` accepted."""
    if parse_version(version) is None:
        raise ValueError(f"Not a version: {version!r}")
    return f"https://github.com/{REPOSITORY}/releases/tag/v{version.lstrip('v')}"


def macos_install_command(version: str) -> str:
    """The curl installer line that upgrades a Mac to ``version``. A candidate
    is never the latest release, so it is pinned, with its own release's
    installer (``docs/releasing.md``, "Release candidates")."""
    if is_candidate(version):
        tag = f"v{version.lstrip('v')}"
        return (
            f"curl -fsSL https://github.com/{REPOSITORY}/releases/download/{tag}/install.sh"
            f" | EDI_VERSION={version.lstrip('v')} bash"
        )
    return f"curl -fsSL https://github.com/{REPOSITORY}/releases/latest/download/install.sh | bash"


def _get_json(url: str, opener: Callable) -> object:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": f"Edi/{__version__}"},
    )
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # A fixed https URL, not one from a document or the page.
    with opener(request, timeout=TIMEOUT_SECONDS, context=context) as response:  # nosec B310
        return json.loads(response.read().decode("utf-8"))


def fetch_latest_version(opener: Callable = urllib.request.urlopen, current: str = __version__) -> str:
    """The newest version the reader should be offered, e.g. ``"1.2.0"``.

    On a release that is GitHub's latest release, which is never a candidate,
    so nobody on a release is offered one. On a candidate it is the newest of
    the recent releases, candidates included: a tester on ``1.2.0-rc.1`` hears
    about ``rc.2`` and then about ``1.2.0``. Drafts, and tags that are not a
    release or a candidate, are passed over.

    Sends a generic client name and nothing about the reader.
    """
    if not is_candidate(current):
        data = _get_json(LATEST_RELEASE_API, opener)
        tag = data.get("tag_name") if isinstance(data, dict) else None
        if not isinstance(tag, str) or parse_version(tag) is None:
            raise ValueError("GitHub did not name a release version")
        return tag.strip().lstrip("v")
    data = _get_json(RELEASES_API, opener)
    tags = [
        release["tag_name"].strip().lstrip("v")
        for release in (data if isinstance(data, list) else [])
        if isinstance(release, dict)
        and not release.get("draft")
        and isinstance(release.get("tag_name"), str)
        and parse_version(release["tag_name"]) is not None
    ]
    if not tags:
        raise ValueError("GitHub did not name a release version")
    return max(tags, key=lambda tag: parse_version(tag) or ())


@dataclass(frozen=True)
class UpdateResult:
    latest: str | None
    error: str | None
    current: str = __version__

    @property
    def newer(self) -> bool:
        return self.latest is not None and is_newer(self.latest, self.current)


class UpdateSettings:
    """Whether to check at launch, and when Edi last checked."""

    def __init__(self, settings: QSettings | None = None) -> None:
        self._settings = settings

    def _store(self) -> QSettings:
        return self._settings if self._settings is not None else QSettings()

    def automatic(self) -> bool:
        value = self._store().value(AUTOMATIC_KEY, False)
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)

    def set_automatic(self, on: bool) -> None:
        self._store().setValue(AUTOMATIC_KEY, bool(on))

    def last_check(self) -> float:
        value = self._store().value(LAST_CHECK_KEY, 0.0)
        if not isinstance(value, (int, float, str)):
            return 0.0
        try:
            return float(value)
        except ValueError:
            return 0.0

    def mark_checked(self, now: float | None = None) -> None:
        self._store().setValue(LAST_CHECK_KEY, time.time() if now is None else now)

    def due(self, now: float | None = None) -> bool:
        """An automatic check is wanted now: it is on, and the last check is a
        day old (or in the future, from a clock that moved back)."""
        if not self.automatic():
            return False
        elapsed = (time.time() if now is None else now) - self.last_check()
        return elapsed >= CHECK_INTERVAL_SECONDS or elapsed < 0


class UpdateCheck(QObject):
    """One check, off the main thread. ``finished`` is delivered on the thread
    of whatever it is connected to, so a window's method runs on the UI thread."""

    finished = Signal(object)

    def __init__(self, fetch: Callable[[], str] = fetch_latest_version, parent=None) -> None:
        super().__init__(parent)
        self._fetch = fetch

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        try:
            result = UpdateResult(self._fetch(), None)
        except Exception as exc:  # noqa: BLE001 (any failure is "could not check")
            result = UpdateResult(None, str(exc) or exc.__class__.__name__)
        self.finished.emit(result)
