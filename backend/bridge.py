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
import subprocess
import threading

from PySide6.QtCore import Q_ARG, QByteArray, QMimeData, QMetaObject, QObject, QRectF, Qt, Signal, Slot
from PySide6.QtGui import QGuiApplication, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

from .exec import run_code_block, run_code_block_streamed
from .files import read_any_text_file, read_text_file, write_text_file
from .tables import parse_table_file


class Bridge(QObject):
    result = Signal(str)
    stream = Signal(str)
    notify = Signal(str)

    def __init__(self, window) -> None:
        super().__init__()
        self._window = window
        self._procs: dict[int, subprocess.Popen] = {}
        self._handlers = {
            "confirm": self._confirm,
            "alert": self._alert,
            "pickOpenPath": self._pick_open_path,
            "pickSavePath": self._pick_save_path,
            "pickExportPath": self._pick_export_path,
            "pickImportPath": self._pick_import_path,
            "pickTextImportPath": self._pick_text_import_path,
            "pickImageImportPath": self._pick_image_import_path,
            "readTextFile": self._read_text_file,
            "readAnyTextFile": self._read_any_text_file,
            "writeTextFile": self._write_text_file,
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
            "setDirty": self._set_dirty,
            "setTitle": self._set_title,
            "setMenuState": self._set_menu_state,
            "getRecentFiles": self._get_recent_files,
            "addRecentFile": self._add_recent_file,
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

    def _alert(self, request_id: int, args: dict) -> None:
        message = args.get("message", "")
        self._window.alert(message)
        self._reply(request_id, None)

    def _pick_open_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_open_path(lambda paths: self._reply(request_id, paths or None))

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

    def _pick_text_import_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_text_import_path(lambda path: self._reply(request_id, path or None))

    def _pick_image_import_path(self, request_id: int, _args: dict) -> None:
        self._window.pick_image_import_path(lambda path: self._reply(request_id, path or None))

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

    def _copy_text(self, request_id: int, args: dict) -> None:
        QGuiApplication.clipboard().setText(str(args.get("text") or ""))
        self._reply(request_id, None)

    def _copy_content(self, request_id: int, args: dict) -> None:
        mime = QMimeData()
        mime.setHtml(str(args.get("html") or ""))
        mime.setText(str(args.get("text") or ""))
        QGuiApplication.clipboard().setMimeData(mime)
        self._reply(request_id, None)

    def _copy_image(self, request_id: int, args: dict) -> None:
        """Rasterize a mermaid SVG to a PNG on the clipboard.

        The webview can't rasterize the diagram itself: drawing an SVG into a
        canvas taints it under QtWebEngine's file:// origin, so Qt renders the
        SVG natively (QSvgRenderer) instead.
        """
        svg = str(args.get("svg") or "")
        if not svg:
            self._reply_error(request_id, "Missing svg")
            return
        renderer = QSvgRenderer()
        renderer.load(QByteArray(svg.encode("utf-8")))
        if not renderer.isValid():
            self._reply_error(request_id, "Invalid SVG data")
            return
        size = renderer.defaultSize()
        if size.isEmpty():
            size = renderer.viewBoxF().size().toSize()
        if size.isEmpty():
            self._reply_error(request_id, "SVG has no size")
            return
        # 2x for a crisp paste; diagrams pasted into Confluence/Word etc.
        scale = 2
        image = QImage(
            max(1, size.width() * scale),
            max(1, size.height() * scale),
            QImage.Format.Format_ARGB32,
        )
        image.fill(Qt.GlobalColor.white)
        painter = QPainter(image)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        renderer.render(painter, QRectF(0, 0, image.width(), image.height()))
        painter.end()

        mime = QMimeData()
        mime.setImageData(image)
        QGuiApplication.clipboard().setMimeData(mime)
        self._reply(request_id, None)

    def _read_clipboard_text(self, request_id: int, _args: dict) -> None:
        mime = QGuiApplication.clipboard().mimeData()
        self._reply(request_id, {"text": mime.text(), "html": mime.html()})

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

    def _read_any_text_file(self, request_id: int, args: dict) -> None:
        path = args.get("path")
        if not path:
            self._reply_error(request_id, "Missing path")
            return

        def work() -> None:
            try:
                content = read_any_text_file(str(path))
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

        threading.Thread(target=work, daemon=True).start()

    def _stop_code_block(self, request_id: int, args: dict) -> None:
        run_id = int(args.get("id", request_id))
        proc = self._procs.pop(run_id, None)
        if proc is not None:
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass
        self._reply(request_id, None)

    def _open_url(self, request_id: int, args: dict) -> None:
        url = str(args.get("url") or "")
        if not url:
            self._reply_error(request_id, "Missing url")
            return
        self._window.open_external_url(url)
        self._reply(request_id, None)

    def _set_dirty(self, request_id: int, args: dict) -> None:
        self._window.set_dirty(bool(args.get("dirty")))
        self._reply(request_id, None)

    def _set_title(self, request_id: int, args: dict) -> None:
        self._window.set_title(str(args.get("title", "")))
        self._reply(request_id, None)

    def _set_menu_state(self, request_id: int, args: dict) -> None:
        self._window.update_menu_state(
            can_revert=bool(args.get("canRevert")),
            formatting_visible=bool(args.get("formattingVisible")),
        )
        self._reply(request_id, None)

    def _get_recent_files(self, request_id: int, _args: dict) -> None:
        self._reply(request_id, self._window.recent_files())

    def _add_recent_file(self, request_id: int, args: dict) -> None:
        path = args.get("path", "")
        if path:
            self._window.add_recent_file(str(path))
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
