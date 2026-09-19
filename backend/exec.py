"""Run executable code blocks, mirroring the previous Rust backend."""

from __future__ import annotations

import os
import subprocess
import threading
import time

try:
    import pty
except ImportError:
    pty = None  # Windows has no POSIX pseudo-terminals ('termios' is missing)

import select

EXEC_TIMEOUT_SECONDS = 30

_INTERPRETERS = {
    "python": ("python3", "-"),
    "python3": ("python3", "-"),
    "py": ("python3", "-"),
    "sh": ("sh", "-s"),
    "shell": ("sh", "-s"),
    "bash": ("bash", "-s"),
    "node": ("node", "-"),
    "js": ("node", "-"),
    "javascript": ("node", "-"),
    "ruby": ("ruby", "-"),
    "rb": ("ruby", "-"),
    "perl": ("perl", "-"),
    "pl": ("perl", "-"),
}


def _basename(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def parse_shebang(line: str) -> list[str] | None:
    rest = line.strip().removeprefix("#!").strip()
    if not rest:
        return None
    tokens = rest.split()
    if tokens[0].lower() == "env" or _basename(tokens[0]).lower() == "env":
        interpreter_at = next(
            (index for index, token in enumerate(tokens[1:], start=1) if not token.startswith("-")),
            None,
        )
        if interpreter_at is None:
            return None
        return tokens[interpreter_at:]
    tokens[0] = _basename(tokens[0])
    return tokens


def interpreter_command(interpreter: str, flags: list[str]) -> tuple[str, list[str]] | None:
    entry = _INTERPRETERS.get(interpreter.lower())
    if entry is None:
        return None
    program, stdin_arg = entry
    return program, [*flags, stdin_arg]


def strip_shebang_line(source: str) -> str:
    newline = source.find("\n")
    if newline >= 0:
        first = source[:newline].rstrip("\r")
        if first.startswith("#!"):
            return source[newline + 1 :]
    elif source.rstrip("\r").startswith("#!"):
        return ""
    return source


def run_code_block(shebang: str, source: str) -> dict:
    parts = parse_shebang(shebang)
    if parts is None:
        raise ValueError(f"Invalid shebang: {shebang}")
    interpreter, flags = parts[0], parts[1:]
    resolved = interpreter_command(interpreter, flags)
    if resolved is None:
        raise ValueError(f"Unsupported interpreter: {interpreter}")
    program, args = resolved

    env = dict(os.environ)
    if program == "python3":
        env.pop("PYTHONHOME", None)
        env.pop("PYTHONPATH", None)

    # Running the code block the user chose to execute is the whole point of this
    # feature: the interpreter binary is allow-listed and nothing is
    # shell-evaluated.
    try:
        proc = subprocess.Popen(  # nosec B603
            [program, *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError as exc:
        raise ValueError(f"Failed to start {program}: {exc}") from exc

    try:
        stdout, stderr = proc.communicate(
            strip_shebang_line(source).encode("utf-8"),
            timeout=EXEC_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise TimeoutError(f"Execution timed out after {EXEC_TIMEOUT_SECONDS} seconds")

    return {
        "exitCode": proc.returncode if proc.returncode is not None and proc.returncode >= 0 else None,
        "stdout": stdout.decode("utf-8", errors="replace"),
        "stderr": stderr.decode("utf-8", errors="replace"),
        "timedOut": False,
    }


def run_code_block_streamed(
    shebang: str,
    source: str,
    on_output,
    is_stopped,
    on_start=None,
) -> dict:
    """Run a code block, streaming stdout/stderr chunks to ``on_output``.

    ``on_output(stream, text)`` is called with ``"stdout"`` or ``"stderr"`` and
    a UTF-8 decoded chunk as it arrives, so the caller can render output
    incrementally instead of waiting for the process to exit. ``is_stopped()``
    is polled; when it returns True the child is killed and the returned dict
    reports ``stopped``. ``on_start(proc)`` (if given) is called with the live
    ``Popen`` so a caller can later kill it. Reader threads drain each stream
    concurrently, so stdout/stderr both stream live and interleave by arrival.

    stdout is attached to a pseudo-terminal: interpreters that block-buffer when
    their output is a pipe (Python, Ruby, Node, Perl, ...) fall back to
    line-buffering when they see a tty, so ``print``/``echo`` output arrives
    incrementally just as it would when run from a real shell. stderr stays an
    ordinary pipe (it is unbuffered everywhere) so the two stay distinguishable.
    On Windows there is no pty, so stdout streams over an ordinary pipe instead
    (still incremental, just without the tty line-buffering hint).
    """
    parts = parse_shebang(shebang)
    if parts is None:
        raise ValueError(f"Invalid shebang: {shebang}")
    interpreter, flags = parts[0], parts[1:]
    resolved = interpreter_command(interpreter, flags)
    if resolved is None:
        raise ValueError(f"Unsupported interpreter: {interpreter}")
    program, args = resolved

    env = dict(os.environ)
    if program == "python3":
        env.pop("PYTHONHOME", None)
        env.pop("PYTHONPATH", None)

    has_pty = pty is not None
    if has_pty:
        stdout_master, stdout_slave = pty.openpty()
    # Same allow-listed interpreter, same explicit argv; streaming adds a pty
    # but nothing shell-related.
    try:
        proc = subprocess.Popen(  # nosec B603
            [program, *args],
            stdin=subprocess.PIPE,
            stdout=stdout_slave if has_pty else subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            start_new_session=has_pty,
        )
    except FileNotFoundError as exc:
        if has_pty:
            os.close(stdout_master)
        raise ValueError(f"Failed to start {program}: {exc}") from exc
    finally:
        if has_pty:
            # The parent closes its copy of the slave; the child keeps the one it
            # inherited. If Popen failed the slave is still open here, so closing it
            # in finally means we never leak it and never double-close.
            try:
                os.close(stdout_slave)
            except OSError:
                pass

    if on_start is not None:
        on_start(proc)

    proc.stdin.write(strip_shebang_line(source).encode("utf-8"))
    proc.stdin.close()

    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    def pipe_reader(handle, stream_name, chunks) -> None:
        try:
            for raw in iter(handle.readline, b""):
                if not raw:
                    break
                text = raw.decode("utf-8", errors="replace")
                chunks.append(text)
                on_output(stream_name, text)
        finally:
            try:
                handle.close()
            except OSError:
                pass

    def pty_reader(fd, stream_name, chunks) -> None:
        # The line discipline emits \r\n for each newline, so normalize \r away.
        # Use select so we never block forever once the child exits (a read on
        # the master then raises EIO rather than returning EOF).
        buf = b""
        try:
            while True:
                ready, _, _ = select.select([fd], [], [], 1.0)
                if not ready:
                    continue
                try:
                    raw = os.read(fd, 4096)
                except OSError:
                    break
                if not raw:
                    break
                buf += raw
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    text = line.replace(b"\r", b"").decode("utf-8", errors="replace")
                    if text:
                        chunks.append(text + "\n")
                        on_output(stream_name, text + "\n")
        finally:
            if buf:
                text = buf.replace(b"\r", b"").decode("utf-8", errors="replace")
                if text:
                    chunks.append(text + "\n")
                    on_output(stream_name, text + "\n")
            try:
                os.close(fd)
            except OSError:
                pass

    readers = [
        threading.Thread(
            target=pty_reader if has_pty else pipe_reader,
            args=(stdout_master if has_pty else proc.stdout, "stdout", stdout_chunks),
            daemon=True,
        ),
        threading.Thread(target=pipe_reader, args=(proc.stderr, "stderr", stderr_chunks), daemon=True),
    ]
    for thread in readers:
        thread.start()

    timed_out = False
    stopped = False
    try:
        proc.wait(timeout=EXEC_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        proc.wait()

    if is_stopped() and not timed_out:
        stopped = True
        proc.kill()

    for thread in readers:
        thread.join(timeout=5)

    return {
        "exitCode": proc.returncode if proc.returncode is not None and proc.returncode >= 0 else None,
        "stdout": "".join(stdout_chunks),
        "stderr": "".join(stderr_chunks),
        "timedOut": timed_out,
        "stopped": stopped,
    }
