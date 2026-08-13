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

import json
import threading

from PySide6.QtCore import Q_ARG, QMimeData, QMetaObject, QObject, Qt, Signal, Slot
from PySide6.QtGui import QGuiApplication

from .exec import run_code_block
from .files import read_text_file, write_text_file
from .tables import parse_table_file


class Bridge(QObject):
    result = Signal(str)

    def __init__(self, window) -> None:
        super().__init__()
        self._window = window
        self._handlers = {
            "confirm": self._confirm,
            "pickOpenPath": self._pick_open_path,
            "pickSavePath": self._pick_save_path,
            "pickExportPath": self._pick_export_path,
            "pickImportPath": self._pick_import_path,
            "readTextFile": self._read_text_file,
            "writeTextFile": self._write_text_file,
            "parseTableFile": self._parse_table_file,
            "copyTable": self._copy_table,
            "runCodeBlock": self._run_code_block,
            "setDirty": self._set_dirty,
            "setMenuState": self._set_menu_state,
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
        except Exception as exc:  # noqa: BLE001
            self._reply_error(request_id, str(exc))

    def _confirm(self, request_id: int, args: dict) -> None:
        message = args.get("message", "Continue?")
        self._window.confirm(message, lambda accepted: self._reply(request_id, accepted))

    def _pick_open_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_open_path(lambda path: self._reply(request_id, path or None))

    def _pick_save_path(self, request_id: int, args: dict) -> None:
        self._window.pick_save_path(
            str(args.get("defaultName", "Untitled")),
            lambda path: self._reply(request_id, path or None),
        )

    def _pick_export_path(self, request_id: int, args: dict) -> None:
        self._window.pick_export_path(
            str(args.get("defaultName", "Untitled")),
            lambda path: self._reply(request_id, path or None),
        )

    def _pick_import_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_import_path(lambda path: self._reply(request_id, path or None))

    def _parse_table_file(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return

        def work() -> None:
            try:
                result = parse_table_file(str(path))
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, result)

        threading.Thread(target=work, daemon=True).start()

    def _copy_table(self, request_id: int, args: dict) -> None:
        mime = QMimeData()
        mime.setHtml(str(args.get("html") or ""))
        mime.setText(str(args.get("plain") or ""))
        QGuiApplication.clipboard().setMimeData(mime)
        self._reply(request_id, None)

    def _read_text_file(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return

        def work() -> None:
            try:
                content = read_text_file(str(path))
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, content)

        threading.Thread(target=work, daemon=True).start()

    def _write_text_file(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return

        def work() -> None:
            try:
                write_text_file(str(path), str(args.get("content") or ""))
            except Exception as exc:  # noqa: BLE001
                self._reply_error(request_id, str(exc))
            else:
                self._reply(request_id, None)

        threading.Thread(target=work, daemon=True).start()

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

        threading.Thread(target=work, daemon=True).start()

    def _set_dirty(self, request_id: int, args: dict) -> None:
        self._window.set_dirty(bool(args.get("dirty")))
        self._reply(request_id, None)

    def _set_menu_state(self, request_id: int, args: dict) -> None:
        self._window.update_menu_state(
            can_revert=bool(args.get("canRevert")),
            preview_visible=bool(args.get("previewVisible")),
        )
        self._reply(request_id, None)

    def _quit(self, request_id: int, _args: dict) -> None:
        self._window.close()
        self._reply(request_id, None)

    def _ping(self, request_id: int, args: dict) -> None:
        self._reply(request_id, args.get("now", 0))

    def _reply(self, request_id: int, data) -> None:
        self._send_result(json.dumps({"id": request_id, "ok": True, "data": data}, default=str))

    def _reply_error(self, request_id: int, message: str) -> None:
        self._send_result(json.dumps({"id": request_id, "ok": False, "error": message}))

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
