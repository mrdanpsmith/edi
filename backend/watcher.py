"""Notice when a document Edi has open is changed on disk by something else.

Edi is often the reader of files an agent or another tool writes. Without this,
a document rewritten behind an open tab went unnoticed, and the next save
replaced the other writer's text with the tab's. So the bridge tells the
watcher the bytes it last read or wrote for each document (``seen``), and:

- a change on disk to anything else is pushed to the page as a ``diskChanged``
  event (``diskDeleted`` when the file is gone), and recorded as a version
  ("Changed outside Edi", `backend/history.py`);
- a save over a file that changed since Edi last read it is refused
  (``changed_since_seen``), so the page can show the reader what changed instead
  of overwriting it.

Edi's own writes are not reported: the bridge calls ``seen`` with the bytes it
wrote, so the change notification that follows finds the file as Edi left it.

``QFileSystemWatcher`` stops watching a file that is *replaced*, which is how
editors and agents save (write a temporary file, rename it over the target), and
on macOS it keeps listing a file or folder that was deleted while never
reporting on it again. So the watches are kept in step with the disk
(``_sync``): each target is re-added whenever the file or folder at that path is
a different one from the one watched. The parent folder is watched too, which is
what reports a file that is briefly gone and then back; while that folder is
gone (a branch switch that removes the whole folder), its nearest existing
ancestor is watched instead, and a change there checks every document below it.

Native notifications are not complete: a file and its folders deleted in quick
succession can produce no signal at all. So a slow poll (``POLL_MS``) checks only
whether each document *exists* as Edi believes, which is what a branch switch
changes. Bursts of writes are coalesced: a document is checked once its file has
been quiet for ``SETTLE_MS``.

**Lifetime.** The watcher and its timers are Qt objects living on the main
thread, children of the ``Bridge`` that owns them, so they go when it goes — and
the bridge must therefore be shut down and freed on the main thread. Freeing it
from a worker thread (the last reference dropped by a finished bridge request)
destroys inotify's socket notifier and the timers off their thread, which
segfaulted the Linux test suite. ``Bridge.shutdown`` calls ``close`` and waits
for the bridge's workers; see ``docs/disk-changes.md``.
"""

from __future__ import annotations

import hashlib
import os
import threading
from collections.abc import Callable

from PySide6.QtCore import QFileSystemWatcher, QObject, Qt, QTimer, Signal, Slot

from . import history

SETTLE_MS = 300
POLL_MS = 2000


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _identity(path: str) -> tuple[int, int] | None:
    """Which file or folder is at ``path`` now: a replaced one is a different one."""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return (stat.st_dev, stat.st_ino)


def _nearest_folder(path: str) -> str:
    """The document's folder or, while that is gone, its nearest existing ancestor."""
    folder = os.path.dirname(os.path.abspath(path))
    while not os.path.isdir(folder):
        parent = os.path.dirname(folder)
        if parent == folder:
            break
        folder = parent
    return folder


def _below(path: str, folder: str) -> bool:
    return os.path.abspath(path).startswith(os.path.join(folder, ""))


def _read(path: str) -> bytes | None:
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except OSError:
        return None


class DiskWatcher(QObject):
    """Watch documents for changes Edi did not make. Lives on the main thread;
    ``seen``, ``forget``, ``watched`` and ``changed_since_seen`` may be called
    from any thread."""

    _watch = Signal(str)
    _unwatch = Signal(str)

    def __init__(self, notify: Callable[[dict], None], parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._notify = notify
        self._lock = threading.Lock()
        self._closed = False
        # Path (as the page spells it) → digest of the bytes Edi last read or wrote.
        self._seen: dict[str, str] = {}
        # Path → digest last reported to the page, so one change is one event.
        self._reported: dict[str, str] = {}
        self._missing: set[str] = set()
        self._timers: dict[str, QTimer] = {}
        # Watched path → the identity of the file or folder it was when added.
        self._identities: dict[str, tuple[int, int]] = {}
        self._poll = QTimer(self)
        self._poll.setInterval(POLL_MS)
        self._poll.timeout.connect(self._poll_existence)
        self._watcher = QFileSystemWatcher(self)
        self._watcher.fileChanged.connect(self._schedule)
        self._watcher.directoryChanged.connect(self._folder_changed)
        queued = Qt.ConnectionType.QueuedConnection
        self._watch.connect(self._start_watching, queued)
        self._unwatch.connect(self._stop_watching, queued)

    def close(self) -> None:
        """Stop watching everything. Main thread only (``Bridge.shutdown``).

        The Qt objects are not deleted here: they belong to the bridge and go
        with it. A late ``seen`` from a worker still finishing is ignored."""
        with self._lock:
            self._closed = True
            self._seen.clear()
        for timer in self._timers.values():
            timer.stop()
        self._timers.clear()
        self._poll.stop()
        watched = self._watcher.files() + self._watcher.directories()
        if watched:
            self._watcher.removePaths(watched)
        self._identities.clear()

    # ── called by the bridge, from any thread ─────────────────────────────

    def seen(self, path: str, data: bytes) -> None:
        """Edi has just read or written ``data`` as ``path``: that is the file's
        known state, and the one a later change is measured against."""
        with self._lock:
            if self._closed:
                return
            self._seen[path] = digest(data)
            self._reported.pop(path, None)
            self._missing.discard(path)
        self._watch.emit(path)

    def forget(self, path: str) -> None:
        with self._lock:
            if self._closed:
                return
            self._seen.pop(path, None)
            self._reported.pop(path, None)
            self._missing.discard(path)
        self._unwatch.emit(path)

    def watched(self) -> list[str]:
        """The documents Edi has read or written this run."""
        with self._lock:
            return list(self._seen)

    def changed_since_seen(self, path: str) -> bool:
        """Whether ``path`` holds something other than what Edi last read or
        wrote. A file Edi never read, or one that is gone, has nothing to lose."""
        with self._lock:
            known = self._seen.get(path)
        if known is None:
            return False
        data = _read(path)
        return data is not None and digest(data) != known

    # ── the watcher itself, on the main thread ────────────────────────────

    @Slot(str)
    def _start_watching(self, path: str) -> None:
        self._sync()

    @Slot(str)
    def _stop_watching(self, path: str) -> None:
        timer = self._timers.pop(path, None)
        if timer is not None:
            timer.stop()
        self._sync()

    def _sync(self) -> None:
        """Watch each document that exists and its folder (or nearest existing
        ancestor), and nothing else. A target that is gone, or is no longer the
        file or folder that was watched, is dropped and watched afresh."""
        with self._lock:
            if self._closed:
                return
            paths = list(self._seen)
        wanted: dict[str, tuple[int, int]] = {}
        for path in paths:
            for target in (path, _nearest_folder(path)):
                identity = _identity(target)
                if identity is not None:
                    wanted[target] = identity
        watched = set(self._watcher.files()) | set(self._watcher.directories())
        stale = [
            target
            for target in watched
            if target not in wanted or self._identities.get(target) != wanted[target]
        ]
        if stale:
            self._watcher.removePaths(stale)
            for target in stale:
                self._identities.pop(target, None)
            watched.difference_update(stale)
        for target, identity in wanted.items():
            if target not in watched and self._watcher.addPath(target):
                self._identities[target] = identity
        if paths and not self._poll.isActive():
            self._poll.start()
        elif not paths:
            self._poll.stop()

    @Slot()
    def _poll_existence(self) -> None:
        """The backstop for notifications that never came: a document whose
        existence is not what Edi believes is checked."""
        with self._lock:
            mismatched = [p for p in self._seen if os.path.exists(p) == (p in self._missing)]
        for path in mismatched:
            self._schedule(path)

    @Slot(str)
    def _folder_changed(self, folder: str) -> None:
        # Below, not only in: while a document's folder is gone its ancestor is
        # watched, and the folder coming back is reported there.
        with self._lock:
            paths = [p for p in self._seen if _below(p, folder)]
        for path in paths:
            self._schedule(path)

    @Slot(str)
    def _schedule(self, path: str) -> None:
        with self._lock:
            if path not in self._seen:
                return
        timer = self._timers.get(path)
        if timer is None:
            timer = QTimer(self)
            timer.setSingleShot(True)
            timer.timeout.connect(lambda p=path: self.check(p))
            self._timers[path] = timer
        timer.start(SETTLE_MS)

    def check(self, path: str) -> None:
        """Compare ``path`` on disk with what Edi knows, and report a difference once."""
        with self._lock:
            known = self._seen.get(path)
        if known is None:
            return
        data = _read(path)
        # Gone, back or replaced: watch what is there now.
        self._sync()
        if data is None:
            with self._lock:
                first = path not in self._missing
                self._missing.add(path)
            if first:
                self._notify({"type": "diskDeleted", "path": path})
            return
        current = digest(data)
        with self._lock:
            was_missing = path in self._missing
            self._missing.discard(path)
            # A file that comes back is reported even unchanged: the page is
            # showing it as deleted, and the event is what clears that.
            if not was_missing and (current == known or self._reported.get(path) == current):
                return
            self._reported[path] = current
        threading.Thread(
            target=history.record, args=(path, "Changed outside Edi"), daemon=True
        ).start()
        self._notify({"type": "diskChanged", "path": path})
