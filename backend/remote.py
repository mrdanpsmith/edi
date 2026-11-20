"""Which sites the page may load anything from.

A document is untrusted input, and a remote image is a request: its server
learns when the document was opened, and from what address. So the page loads
nothing from a site the reader has not allowed. The page shows what a document
would load and asks (``src/remoteImages.ts``); this module is what holds it to
the answer, for every request the web engine makes, whatever started it: an
``<img>``, a CSS ``url()``, an image inside a diagram's SVG, or the print view.

A site is a host name, matched exactly: allowing ``i.imgur.com`` does not allow
``imgur.com``. An answer lasts until Edi quits ("Load") or is saved in
``QSettings`` ("Always load from these sites") until the reader forgets it from
the View menu.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Iterable

from PySide6.QtCore import QCoreApplication, QSettings
from PySide6.QtWebEngineCore import (
    QWebEngineProfile,
    QWebEngineUrlRequestInfo,
    QWebEngineUrlRequestInterceptor,
)

SETTINGS_KEY = "allowedImageHosts"
REMOTE_SCHEMES = frozenset({"http", "https", "ws", "wss"})
# A host name as the page can send one: letters, digits, dots, hyphens, an
# IPv6 literal's colons. Anything else is not a site the reader was shown.
_HOST = re.compile(r"^[a-z0-9.:-]{1,253}$")
MAX_HOSTS_PER_REQUEST = 100


def normalize_host(host: str) -> str | None:
    """``host`` as it is stored and matched, or ``None`` if it is not one.

    An IPv6 literal loses its brackets: the page's ``URL.hostname`` keeps them
    and ``QUrl.host()`` drops them, and both must name the same site."""
    cleaned = host.strip().lower().rstrip(".").removeprefix("[").removesuffix("]")
    return cleaned if _HOST.match(cleaned) else None


class AllowedHosts:
    """The sites the page may load from: this run's answers and the saved ones.

    Read on the web engine's IO thread (``RemoteRequestInterceptor``) and
    written on the main thread, so every access holds the lock, and a read
    touches only the in-memory sets, never ``QSettings``.
    """

    def __init__(self, settings: QSettings | None = None) -> None:
        self._settings = settings
        self._lock = threading.Lock()
        self._session: set[str] = set()
        self._saved: set[str] = set(self._read_saved())

    def _store(self) -> QSettings:
        return self._settings if self._settings is not None else QSettings()

    def _read_saved(self) -> list[str]:
        value = self._store().value(SETTINGS_KEY, [])
        # A one-element list comes back from the native format as a bare str.
        if isinstance(value, str):
            items = [value]
        elif isinstance(value, (list, tuple)):
            items = list(value)
        else:
            items = []
        return [host for host in (normalize_host(str(item)) for item in items) if host]

    def is_allowed(self, host: str) -> bool:
        key = normalize_host(host)
        if key is None:
            return False
        with self._lock:
            return key in self._session or key in self._saved

    def allow(self, hosts: Iterable[str], remember: bool) -> None:
        keys = {key for key in (normalize_host(host) for host in hosts) if key}
        with self._lock:
            if remember:
                self._saved |= keys
                saved = sorted(self._saved)
            else:
                self._session |= keys
                saved = None
        if saved is not None:
            self._store().setValue(SETTINGS_KEY, saved)

    def allowed(self) -> list[str]:
        with self._lock:
            return sorted(self._session | self._saved)

    def saved(self) -> list[str]:
        with self._lock:
            return sorted(self._saved)

    def forget(self) -> None:
        """Forget every answer, saved and for this run, so nothing loads unasked."""
        with self._lock:
            self._session.clear()
            self._saved.clear()
        self._store().remove(SETTINGS_KEY)


class RemoteRequestInterceptor(QWebEngineUrlRequestInterceptor):
    """Block every request to a remote site that ``hosts`` does not allow."""

    def __init__(self, hosts: AllowedHosts, parent=None) -> None:
        super().__init__(parent)
        self._hosts = hosts

    def interceptRequest(self, info: QWebEngineUrlRequestInfo) -> None:  # noqa: N802 (Qt override)
        url = info.requestUrl()
        if url.scheme().lower() in REMOTE_SCHEMES and not self._hosts.is_allowed(url.host()):
            info.block(True)


_shared: tuple[AllowedHosts, RemoteRequestInterceptor] | None = None


def shared_hosts() -> AllowedHosts:
    """The process's allowed sites, installed on the default web profile.

    One for the whole process, parented to the application: the profile is
    shared by every view (the app's page and the print view) and does not own
    its interceptor, so an interceptor that went away with a window would leave
    the profile calling a deleted object. "Until Edi quits" is this lifetime.
    """
    global _shared
    if _shared is None:
        hosts = AllowedHosts()
        interceptor = RemoteRequestInterceptor(hosts, parent=QCoreApplication.instance())
        QWebEngineProfile.defaultProfile().setUrlRequestInterceptor(interceptor)
        _shared = (hosts, interceptor)
    return _shared[0]
