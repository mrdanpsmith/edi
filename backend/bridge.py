"""Bridge between the Qt shell and the webview frontend.

The page calls ``bridge.invoke(method, requestId, payloadJson)`` and awaits a
reply on the ``result`` signal::

    {"id": <requestId>, "ok": true, "data": <value>}
    {"id": <requestId>, "ok": false, "error": "<message>"}

QWebChannel strips trailing JS callbacks, so this id-based request/response
channel (instead of return values) is how the frontend awaits native calls.
Blocking work (file IO, subprocesses) runs on worker threads; ``result`` is a
signal, so emitting from a worker thread is delivered safely on the main
thread via a queued connection.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import threading
import time

from PySide6.QtCore import Q_ARG, QMimeData, QMetaObject, QObject, Qt, Signal, Slot
from PySide6.QtGui import QGuiApplication, QImage

from . import history
from .exec import kill_process_tree, run_code_block, run_code_block_streamed
from .files import read_any_text_file, read_text_file, rename_text_file, write_text_file
from .tables import parse_table_file
from .watcher import DiskWatcher

# The error code a refused file access replies with (`shared/edi-contract.json`
# → `errorCodes`), so the page can tell "not yours to write" from a failure.
NOT_PERMITTED = "notPermitted"
# A save refused because the file changed on disk since Edi last read it: the
# page shows what changed rather than overwriting it (`backend/watcher.py`).
CHANGED_ON_DISK = "changedOnDisk"


class ChangedOnDisk(Exception):
    """A write that would replace text Edi has never shown the reader."""


def _file_bytes(path: str) -> bytes:
    with open(os.path.realpath(path), "rb") as handle:
        return handle.read()


class NotPermitted(Exception):
    """A file access the user never handed to Edi."""


class PathGrants:
    """The files the *user* gave Edi, which are the only ones the page may touch.

    The page is not trusted with paths: a markdown file is content from
    anywhere, and a script that ever ran in the page could otherwise ask the
    bridge to write `~/.zshrc` or read `~/.ssh/id_rsa`. A path is granted only
    where the user named it outside the page — a native file dialog, the
    command line, the OS asking Edi to open a document, the backend's own
    recent list — and the bridge refuses everything else.

    Writing a file implies reading it. Paths are compared by `realpath`, so a
    symlink or a `..` spelling is the file it names. Grants live as long as the
    window: a new run starts with none but what it was launched with.
    """

    def __init__(self) -> None:
        self._writable: set[str] = set()
        self._readable: set[str] = set()
        # Documents Edi has opened without a write grant (a followed link):
        # the only paths the shell will ask the user about saving.
        self._opened: set[str] = set()
        self._lock = threading.Lock()

    @staticmethod
    def _key(path: str) -> str:
        return os.path.normcase(os.path.realpath(path))

    def allow_write(self, path: str) -> None:
        with self._lock:
            self._writable.add(self._key(path))

    def allow_read(self, path: str) -> None:
        with self._lock:
            self._readable.add(self._key(path))

    def note_opened(self, path: str) -> None:
        with self._lock:
            self._opened.add(self._key(path))

    def may_write(self, path: str) -> bool:
        with self._lock:
            return self._key(path) in self._writable

    def check_confirmable(self, path: str) -> None:
        """Only a document Edi opened may be offered to the user for saving,
        so the page cannot put an arbitrary path in front of them."""
        with self._lock:
            if self._key(path) not in self._opened:
                raise NotPermitted(f"Edi has not opened this document: {path}")

    def may_read(self, path: str) -> bool:
        key = self._key(path)
        with self._lock:
            return key in self._readable or key in self._writable

    def check_write(self, path: str) -> None:
        if not self.may_write(path):
            raise NotPermitted(f"Edi was not given this file to write: {path}")

    def check_read(self, path: str) -> None:
        if not self.may_read(path):
            raise NotPermitted(f"Edi was not given this file to read: {path}")

    def check_rename(self, old_path: str, new_path: str) -> None:
        """A rename or move takes a writable document to a path the user named
        outside the page — the shell's Rename or Move prompt grants it — so the
        page cannot move a document anywhere it likes, nor onto a file of its
        choosing."""
        self.check_write(old_path)
        if os.path.basename(new_path) in ("", ".", ".."):
            raise NotPermitted(f"Not a file name: {new_path}")
        if not self.may_write(new_path):
            raise NotPermitted(f"Edi was not given this destination: {new_path}")


class Bridge(QObject):
    result = Signal(str)
    stream = Signal(str)
    notify = Signal(str)

    def __init__(self, window, pending_files: list[str] | None = None) -> None:
        super().__init__()
        self._window = window
        self.grants = PathGrants()
        self._pending_files = list(pending_files or [])
        # Named on the command line: the user's own choice, so they may be saved.
        for path in self._pending_files:
            self.grants.allow_write(path)
        # Set when the page first asks for pending files (at the end of its
        # init). Until then an open-document event is queued rather than pushed
        # over the notify signal, which would be lost before the page listens.
        self._frontend_ready = False
        self._procs: dict[int, subprocess.Popen] = {}
        # Worker threads, so `shutdown` can wait for them (see `_spawn`).
        self._workers: set[threading.Thread] = set()
        self._workers_lock = threading.Lock()
        # Documents changed on disk by something else (`backend/watcher.py`).
        # A child of this bridge: its Qt objects go with it, on the main thread.
        self.disk = DiskWatcher(self.emit_event, parent=self)
        self._handlers = {
            "confirm": self._confirm,
            "alert": self._alert,
            "pickOpenPath": self._pick_open_path,
            "pickSavePath": self._pick_save_path,
            "pickExportPath": self._pick_export_path,
            "pickImageSavePath": self._pick_image_save_path,
            "pickImportPath": self._pick_import_path,
            "pickTextImportPath": self._pick_text_import_path,
            "pickTypedOpenPath": self._pick_typed_open_path,
            "pickRenamePath": self._pick_rename_path,
            "confirmWritePath": self._confirm_write_path,
            "pickImageImportPath": self._pick_image_import_path,
            "readTextFile": self._read_text_file,
            "readAnyTextFile": self._read_any_text_file,
            "writeTextFile": self._write_text_file,
            "renameTextFile": self._rename_text_file,
            "listHistory": self._list_history,
            "readHistoryVersion": self._read_history_version,
            "clearHistory": self._clear_history,
            "writeBinaryFile": self._write_binary_file,
            "parseTableFile": self._parse_table_file,
            "copyTable": self._copy_table,
            "copyText": self._copy_text,
            "copyContent": self._copy_content,
            "copyImage": self._copy_image,
            "readClipboardText": self._read_clipboard_text,
            "runCodeBlock": self._run_code_block,
            "streamCodeBlock": self._stream_code_block,
            "stopCodeBlock": self._stop_code_block,
            "openUrl": self._open_url,
            "printHtml": self._print_html,
            "setDirty": self._set_dirty,
            "setTitle": self._set_title,
            "setMenuState": self._set_menu_state,
            "getPreferences": self._get_preferences,
            "setPreference": self._set_preference,
            "getRecentFiles": self._get_recent_files,
            "addRecentFile": self._add_recent_file,
            "getPendingFiles": self._get_pending_files,
            "quit": self._quit,
            "ping": self._ping,
        }

    @Slot(str, int, str)
    def invoke(self, method: str, request_id: int, payload: str) -> None:
        try:
            args = json.loads(payload or "{}")
        except json.JSONDecodeError:
            self._reply_error(request_id, f"Invalid payload: {payload!r}")
            return
        handler = self._handlers.get(method)
        if handler is None:
            self._reply_error(request_id, f"Unknown method: {method}")
            return
        try:
            handler(request_id, args)
        except NotPermitted as exc:
            self._reply_error(request_id, str(exc), code=NOT_PERMITTED)
        except Exception as exc:  # noqa: BLE001
            self._reply_error(request_id, str(exc))

    def _confirm(self, request_id: int, args: dict) -> None:
        message = args.get("message", "Continue?")
        self._window.confirm(message, lambda accepted: self._reply(request_id, accepted))

    def _alert(self, request_id: int, args: dict) -> None:
        message = args.get("message", "")
        self._window.alert(message)
        self._reply(request_id, None)

    # A native dialog is the user naming a file outside the page, so its answer is
    # what grants the page that file (see `PathGrants`).

    def _granting(self, request_id: int, grant):
        """A dialog callback that grants each chosen path, then replies with it."""

        def reply(chosen) -> None:
            for path in chosen if isinstance(chosen, list) else [chosen]:
                if path:
                    grant(str(path))
            self._reply(request_id, chosen or None)

        return reply

    def _pick_open_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_open_path(self._granting(request_id, self.grants.allow_write))

    def _pick_typed_open_path(self, request_id: int, args: dict) -> None:
        # The page supplies only the folder a relative path resolves against;
        # the path itself is typed by the user into the shell's own prompt, so
        # it grants write access the same way the file picker does.
        base_dir = args.get("baseDir")
        self._window.pick_typed_open_path(
            str(base_dir) if base_dir else None,
            self._granting(request_id, self.grants.allow_write),
        )

    def _pick_rename_path(self, request_id: int, args: dict) -> None:
        # Only a document Edi may write can be renamed; the destination is typed
        # into the shell's own prompt, so it is granted like a file picker's.
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return
        self.grants.check_write(str(path))
        self._window.pick_rename_path(str(path), self._granting(request_id, self.grants.allow_write))

    def _confirm_write_path(self, request_id: int, args: dict) -> None:
        # A document opened by following a link is readable but not writable.
        # Saving it asks the user in a native prompt naming the file, which the
        # page cannot draw or answer, so a yes grants it like a Save dialog.
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return
        if self.grants.may_write(str(path)):
            self._reply(request_id, True)
            return
        self.grants.check_confirmable(str(path))

        def reply(accepted: bool) -> None:
            if accepted:
                self.grants.allow_write(str(path))
            self._reply(request_id, bool(accepted))

        self._window.confirm_write_path(str(path), reply)

    def _pick_save_path(self, request_id: int, args: dict) -> None:
        self._window.pick_save_path(
            str(args.get("defaultName", "Untitled")),
            self._granting(request_id, self.grants.allow_write),
        )

    def _pick_export_path(self, request_id: int, args: dict) -> None:
        self._window.pick_export_path(
            str(args.get("defaultName", "Untitled")),
            self._granting(request_id, self.grants.allow_write),
        )

    def _pick_image_save_path(self, request_id: int, args: dict) -> None:
        self._window.pick_image_save_path(
            str(args.get("defaultName", "diagram")),
            self._granting(request_id, self.grants.allow_write),
        )

    def _pick_import_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_import_path(self._granting(request_id, self.grants.allow_read))

    def _pick_text_import_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_text_import_path(self._granting(request_id, self.grants.allow_read))

    def _pick_image_import_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_image_import_path(lambda path: self._reply(request_id, path or None))

    def _parse_table_file(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return
        self.grants.check_read(str(path))

        def work() -> None:
            try:
                result = parse_table_file(str(path))
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, result)

        self._spawn(work)

    def _copy_table(self, request_id: int, args: dict) -> None:
        mime = QMimeData()
        mime.setHtml(str(args.get("html") or ""))
        mime.setText(str(args.get("plain") or ""))
        QGuiApplication.clipboard().setMimeData(mime)
        self._reply(request_id, None)

    def _copy_text(self, request_id: int, args: dict) -> None:
        QGuiApplication.clipboard().setText(str(args.get("text") or ""))
        self._reply(request_id, None)

    def _copy_content(self, request_id: int, args: dict) -> None:
        mime = QMimeData()
        mime.setHtml(str(args.get("html") or ""))
        mime.setText(str(args.get("text") or ""))
        markdown = str(args.get("markdown") or "")
        if markdown:
            mime.setData("text/markdown", markdown.encode("utf-8"))
        QGuiApplication.clipboard().setMimeData(mime)
        self._reply(request_id, None)

    def _copy_image(self, request_id: int, args: dict) -> None:
        """Put a PNG (base64, rasterized by the webview) on the clipboard.

        The frontend rasterizes the diagram with its own Chromium renderer
        (pixel-identical to what the user sees) and ships the PNG bytes here;
        Qt's job is only to own the clipboard.
        """
        data = str(args.get("data") or "")
        if not data:
            self._reply_error(request_id, "Missing image data")
            return
        try:
            raw = base64.b64decode(data, validate=False)
        except (ValueError, TypeError) as exc:
            self._reply_error(request_id, f"Invalid image data: {exc}")
            return
        image = QImage.fromData(raw, "PNG")  # pyright: ignore[reportArgumentType]
        if image.isNull():
            self._reply_error(request_id, "Invalid PNG data")
            return
        mime = QMimeData()
        # Provide the raw PNG bytes explicitly. On macOS the Cocoa clipboard
        # plugin lazily serializes QImage → TIFF for NSPasteboard; that lazy
        # conversion can crash (SIGTRAP). Setting the PNG data directly lets
        # the pasteboard serve it without the problematic conversion path.
        mime.setData("image/png", raw)
        mime.setImageData(image)
        QGuiApplication.clipboard().setMimeData(mime)
        self._reply(request_id, None)

    def _read_clipboard_text(self, request_id: int, _args: dict) -> None:
        mime = QGuiApplication.clipboard().mimeData()
        markdown = bytes(mime.data("text/markdown").data()).decode("utf-8", "replace")
        self._reply(request_id, {"text": mime.text(), "html": mime.html(), "markdown": markdown})

    def _read_text_file(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return
        # A document type may be read without a grant — a link to another note
        # opens it — but only the backend's own recent list makes it writable:
        # a document opened by following a link asks the user once, in the
        # shell's own prompt, before its first save (`confirmWritePath`, and
        # `fileController.saveTo`).
        if str(path) in self._window.recent_files():
            self.grants.allow_write(str(path))

        def work() -> None:
            try:
                content = read_text_file(str(path))
                data = _file_bytes(str(path))
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                # What the reader is now shown is the file's known state: a
                # later change by anything else is reported against it.
                self.disk.seen(str(path), data)
                history.record_opened(str(path))
                self.grants.note_opened(str(path))
                self._reply(request_id, content)

        self._spawn(work)

    def _read_any_text_file(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return
        self.grants.check_read(str(path))

        def work() -> None:
            try:
                content = read_any_text_file(str(path))
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, content)

        self._spawn(work)

    def _write_text_file(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return
        self.grants.check_write(str(path))
        # Only a document save asks for a version; an HTML export writes
        # through this same method and is not the document's history.
        keep_version = bool(args.get("history"))

        def work() -> None:
            try:
                if keep_version and self.disk.changed_since_seen(str(path)):
                    raise ChangedOnDisk(f"The file changed on disk since Edi read it: {path}")
                write_text_file(str(path), str(args.get("content") or ""))
            except ChangedOnDisk as exc:
                self._reply_error(request_id, str(exc), code=CHANGED_ON_DISK)
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                if keep_version:
                    self._seen_written(str(path))
                    history.record(str(path))
                self._reply(request_id, None)

        self._spawn(work)

    def _rename_text_file(self, request_id: int, args: dict) -> None:
        """Save a document under a new name and delete the old file, in one step.

        The write and the delete belong to a single call on purpose: the frontend
        must never be able to save the new name, fail, and leave the document on
        disk twice (or nowhere). ``rename_text_file`` refuses to do half of it.
        """
        old_path = args.get("oldPath")
        new_path = args.get("newPath")
        if not old_path or not new_path:
            self._reply_error(request_id, "Missing path")
            return
        self.grants.check_rename(str(old_path), str(new_path))

        def work() -> None:
            try:
                # A rename deletes the old file, so it must not delete a
                # change the reader was never shown either.
                if self.disk.changed_since_seen(str(old_path)):
                    raise ChangedOnDisk(f"The file changed on disk since Edi read it: {old_path}")
                rename_text_file(
                    str(old_path), str(new_path), str(args.get("content") or "")
                )
            except ChangedOnDisk as exc:
                self._reply_error(request_id, str(exc), code=CHANGED_ON_DISK)
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self.grants.allow_write(str(new_path))
                # The old name no longer names anything, so it is not something
                # the recent list should offer a click away.
                self._window.forget_recent_file(str(old_path))
                self.disk.forget(str(old_path))
                self._seen_written(str(new_path))
                history.move(str(old_path), str(new_path))
                self._reply(request_id, None)

        self._spawn(work)

    def _seen_written(self, path: str) -> None:
        """Edi wrote ``path``: what is there now is Edi's, not news to report."""
        try:
            self.disk.seen(path, _file_bytes(path))
        except OSError:
            pass

    def _list_history(self, request_id: int, args: dict) -> None:
        """The saved versions of a document the user gave Edi, newest first."""
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return
        self.grants.check_read(str(path))
        # The page sends its `gitHistory` preference: a tracked document's
        # commits are listed beside Edi's versions (`backend/githistory.py`).
        use_git = bool(args.get("git", False))

        def work() -> None:
            try:
                versions = history.list_combined(str(path), use_git)
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, versions)

        self._spawn(work)

    def _clear_history(self, request_id: int, args: dict) -> None:
        """Forget a document's saved versions, keeping the file as it is now as
        the first version. The whole store is cleared from the native menu
        (``MainWindow._clear_all_history``), never from the page."""
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return
        self.grants.check_read(str(path))

        def work() -> None:
            try:
                history.clear(str(path))
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, None)

        self._spawn(work)

    def _read_history_version(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        version_id = args.get("id")
        if not path or not version_id:
            self._reply_error(request_id, "Missing path or version")
            return
        self.grants.check_read(str(path))
        source = "git" if args.get("source") == "git" else "edi"

        def work() -> None:
            try:
                content = history.read_from(str(path), str(version_id), source)
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, content)

        self._spawn(work)

    def _write_binary_file(self, request_id: int, args: dict) -> None:
        """Persist a base64-encoded blob (e.g. a rasterized diagram PNG).

        The payload is base64 text from the page, so it round-trips QtWebChannel
        cleanly. We validate the decoded bytes with QImage (adds a PNG header
        check) but write back the *original* bytes — re-encoding could change
        the file the user asked for.
        """
        path = args.get("path")
        data = args.get("data")
        if not path or not data:
            self._reply_error(request_id, "Missing path or data")
            return
        self.grants.check_write(str(path))

        def work() -> None:
            try:
                raw = base64.b64decode(str(data), validate=True)
                if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValueError("Not a PNG payload")
                image = QImage.fromData(raw, "PNG")  # pyright: ignore[reportArgumentType]
                if image.isNull():
                    raise ValueError("Invalid PNG data")
                with open(str(path), "wb") as fh:
                    fh.write(raw)
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, None)

        self._spawn(work)

    def _run_code_block(self, request_id: int, args: dict) -> None:
        shebang = str(args.get("shebang") or "")
        source = str(args.get("source") or "")

        def work() -> None:
            try:
                result = run_code_block(shebang, source)
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, result)

        self._spawn(work)

    def _stream_code_block(self, request_id: int, args: dict) -> None:
        """Start a code block run whose output streams over ``stream``.

        Each chunk arrives as a JSON object on the ``stream`` signal tagged with
        this ``request_id``; the normal ``result`` reply resolves once the
        process finishes (or is stopped/times out).
        """
        shebang = str(args.get("shebang") or "")
        source = str(args.get("source") or "")

        def on_output(stream_name: str, text: str) -> None:
            self._send_stream(
                {
                    "id": request_id,
                    "kind": "output",
                    "stream": stream_name,
                    "text": text,
                }
            )

        def on_start(process) -> None:
            self._procs[request_id] = process

        def is_stopped() -> bool:
            # The stop handler pops the id from _procs, signalling the run to
            # kill its child and finish early.
            return request_id not in self._procs

        def work() -> None:
            try:
                result = run_code_block_streamed(
                    shebang, source, on_output, is_stopped, on_start=on_start
                )
            except Exception as exc:  # noqa: BLE001
                self._procs.pop(request_id, None)
                self._send_stream({"id": request_id, "kind": "done", "ok": False})
                self._reply_error(request_id, str(exc))
            else:
                self._procs.pop(request_id, None)
                self._send_stream({"id": request_id, "kind": "done", "ok": True})
                self._reply(request_id, result)

        self._spawn(work)

    def _stop_code_block(self, request_id: int, args: dict) -> None:
        run_id = int(args.get("id", request_id))
        proc = self._procs.pop(run_id, None)
        if proc is not None:
            kill_process_tree(proc)
        self._reply(request_id, None)

    def shutdown(self) -> None:
        """Kill every code block still running: the app is going away.

        The timeout lives on a daemon thread that dies with the process, and
        each run leads its own session, so nothing else would ever stop them.
        """
        for run_id in list(self._procs):
            proc = self._procs.pop(run_id, None)
            if proc is not None:
                kill_process_tree(proc)
        self.disk.close()
        self.join_workers()

    def _spawn(self, work) -> None:
        """Run a request's blocking ``work`` on a worker thread.

        Tracked so ``join_workers`` can wait for them. That matters for more
        than tidiness: a worker's closure holds this bridge, so a worker that
        outlives every other reference frees the bridge — and its Qt children,
        the disk watcher among them — on the worker's thread, which is not
        allowed. Whoever frees a bridge joins its workers first, on the main
        thread (``shutdown``, and the test fixtures).
        """
        thread = threading.Thread(target=work, daemon=True)
        with self._workers_lock:
            self._workers = {t for t in self._workers if t.is_alive()}
            self._workers.add(thread)
        thread.start()

    def join_workers(self, timeout: float = 2.0) -> None:
        """Wait, up to ``timeout`` seconds in all, for every worker still running.

        Bounded so quitting never hangs on a stuck read; code-block runs are
        killed before this in ``shutdown``, so their workers end promptly."""
        with self._workers_lock:
            workers = list(self._workers)
        deadline = time.monotonic() + timeout
        for thread in workers:
            thread.join(max(0.0, deadline - time.monotonic()))
        with self._workers_lock:
            self._workers = {t for t in self._workers if t.is_alive()}

    def _open_url(self, request_id: int, args: dict) -> None:
        url = str(args.get("url") or "")
        if not url:
            self._reply_error(request_id, "Missing url")
            return
        self._window.open_external_url(url)
        self._reply(request_id, None)

    def _print_html(self, request_id: int, args: dict) -> None:
        html = str(args.get("html") or "")
        if not html:
            self._reply_error(request_id, "Missing html")
            return
        # Only the base for relative images; nothing is read through the bridge.
        document_path = args.get("documentPath")

        def done(printed: bool, error: str | None) -> None:
            if error:
                self._reply_error(request_id, error)
            else:
                self._reply(request_id, printed)

        self._window.print_html(html, str(document_path) if document_path else None, done)

    def _set_dirty(self, request_id: int, args: dict) -> None:
        self._window.set_dirty(bool(args.get("dirty")))
        self._reply(request_id, None)

    def _set_title(self, request_id: int, args: dict) -> None:
        self._window.set_title(str(args.get("title", "")))
        self._reply(request_id, None)

    def _set_menu_state(self, request_id: int, args: dict) -> None:
        self._window.update_menu_state(
            has_document=bool(args.get("hasDocument")),
            can_revert=bool(args.get("canRevert")),
            can_copy_path=bool(args.get("canCopyPath")),
            toolbar_visible=bool(args.get("toolbarVisible")),
            hover_band=bool(args.get("hoverBand", True)),
            git_history=bool(args.get("gitHistory", True)),
            can_rename=bool(args.get("canRename")),
            zoom_factor=float(args.get("zoomFactor") or 1.0),
            can_zoom_in=bool(args.get("canZoomIn", True)),
            can_zoom_out=bool(args.get("canZoomOut", True)),
        )
        self._reply(request_id, None)

    def _get_preferences(self, request_id: int, _args: dict) -> None:
        # Normally unused: the page is handed its preferences by an injected
        # script before the bundle runs (`window.py`), because a round trip
        # cannot be awaited before the editor's first paint. This exists so the
        # store is still reachable over the bridge — which is what makes the
        # injected snapshot verifiable rather than the only way in.
        self._reply(request_id, self._window.preferences())

    def _set_preference(self, request_id: int, args: dict) -> None:
        name = str(args.get("name", ""))
        if name:
            self._window.set_preference(name, args.get("value"))
        self._reply(request_id, None)

    def _get_recent_files(self, request_id: int, _args: dict) -> None:
        self._reply(request_id, self._window.recent_files())

    def _add_recent_file(self, request_id: int, args: dict) -> None:
        path = args.get("path", "")
        # The recent list grants write access when a path in it is reopened, so
        # it only takes paths that already have one: otherwise adding a path
        # and reading it back would be a grant the page gave itself.
        if path and self.grants.may_write(str(path)):
            self._window.add_recent_file(str(path))
        self._reply(request_id, None)

    def _get_pending_files(self, request_id: int, _args: dict) -> None:
        # File paths passed on the command line (e.g. Edi opened for a .md file
        # from the file manager) or queued by a cold-launch QFileOpenEvent; the
        # frontend opens them once the page boots. The page's first call also
        # marks it ready, so later file-open events can be pushed immediately
        # instead of waiting for another boot.
        self._frontend_ready = True
        self._reply(request_id, list(self._pending_files))

    def add_pending_files(self, paths: list[str]) -> None:
        """Queue paths for the page's next boot (it has not asked yet)."""
        self.grant_opened(paths)
        for path in paths:
            if path and path not in self._pending_files:
                self._pending_files.append(path)

    def grant_opened(self, paths: list[str]) -> None:
        """The OS asked Edi to open these: the user's choice, so they may be saved."""
        for path in paths:
            if path:
                self.grants.allow_write(path)

    def reset_frontend_ready(self) -> None:
        """Forget that the page is listening (a reload starts a fresh one)."""
        self._frontend_ready = False

    @property
    def frontend_ready(self) -> bool:
        return self._frontend_ready

    def _quit(self, request_id: int, _args: dict) -> None:
        self._window.close()
        self._reply(request_id, None)

    def _ping(self, request_id: int, args: dict) -> None:
        self._reply(request_id, args.get("now", 0))

    def _reply(self, request_id: int, data) -> None:
        self._send_result(json.dumps({"id": request_id, "ok": True, "data": data}, default=str))

    def _reply_error(self, request_id: int, message: str, code: str | None = None) -> None:
        reply: dict = {"id": request_id, "ok": False, "error": message}
        if code is not None:
            reply["code"] = code
        self._send_result(json.dumps(reply))

    def _send_stream(self, message: dict) -> None:
        # Skip emitting anything for a run the frontend has already stopped.
        if message["id"] not in self._procs and message["kind"] != "done":
            return
        QMetaObject.invokeMethod(
            self,
            "_emit_stream",
            Qt.ConnectionType.QueuedConnection,
            Q_ARG(str, json.dumps(message)),
        )

    @Slot(str)
    def _emit_stream(self, payload: str) -> None:
        self.stream.emit(payload)

    def _send_result(self, payload: str) -> None:
        # Defer the emit to the next event-loop turn. QtWebEngine drops a
        # webchannel signal emitted synchronously while a JS-invoked slot is
        # still on the stack (and after the page is hidden/re-shown), so all
        # replies go through a queued main-thread invocation. This is also
        # what lets worker threads deliver results safely.
        QMetaObject.invokeMethod(
            self,
            "_emit_result",
            Qt.ConnectionType.QueuedConnection,
            Q_ARG(str, payload),
        )

    @Slot(str)
    def _emit_result(self, payload: str) -> None:
        self.result.emit(payload)

    def emit_event(self, event: dict) -> None:
        QMetaObject.invokeMethod(
            self,
            "_emit_notify",
            Qt.ConnectionType.QueuedConnection,
            Q_ARG(str, json.dumps(event, separators=(",", ":"))),
        )

    @Slot(str)
    def _emit_notify(self, payload: str) -> None:
        self.notify.emit(payload)
