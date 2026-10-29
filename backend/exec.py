"""Run executable code blocks, mirroring the previous Rust backend."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
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


def _resolve_run(shebang: str) -> tuple[str, list[str], dict[str, str]]:
    '''Parse the shebang and build the interpreter argv + environment.

    Shared by :func:`run_code_block` and :func:`run_code_block_streamed` so the
    two paths cannot drift on shebang handling or environment setup.
    '''
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
    return program, list(args), env


def kill_process_tree(proc: subprocess.Popen) -> None:
    """Kill a code block's interpreter and everything it started.

    Killing only the interpreter leaves its children running — an `sh` block's
    `sleep 600`, a server it launched — still holding the output pipes open, so
    the readers never see EOF either. On POSIX every run leads its own session
    (`start_new_session`), so its process group is exactly its tree; Windows has
    no groups to signal, and `taskkill /T` walks the tree instead.
    """
    if proc.poll() is not None and sys.platform == "win32":
        return
    try:
        if sys.platform == "win32":
            # Fixed argv, no shell; taskkill is a system binary.
            subprocess.run(  # nosec B603 B607
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    try:
        proc.kill()
    except (ProcessLookupError, OSError):
        pass


# A run leads its own process group on POSIX, so the group can be killed whole.
_NEW_SESSION = sys.platform != "win32"


def run_code_block(shebang: str, source: str) -> dict:
    program, args, env = _resolve_run(shebang)

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
            start_new_session=_NEW_SESSION,
        )
    except FileNotFoundError as exc:
        raise ValueError(f"Failed to start {program}: {exc}") from exc

    try:
        stdout, stderr = proc.communicate(
            strip_shebang_line(source).encode("utf-8"),
            timeout=EXEC_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        kill_process_tree(proc)
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
    program, args, env = _resolve_run(shebang)

    # The pty is optional: on platforms without one (Windows) stdout streams over
    # an ordinary pipe instead. A single code path takes the optional slave fd.
    stdout_master: int | None = None
    stdout_slave: int | None = None
    if pty is not None:
        stdout_master, stdout_slave = pty.openpty()  # pyright: ignore[reportOptionalMemberAccess]
    # Same allow-listed interpreter, same explicit argv; streaming adds a pty
    # but nothing shell-related.
    try:
        proc = subprocess.Popen(  # nosec B603
            [program, *args],
            stdin=subprocess.PIPE,
            stdout=stdout_slave if stdout_slave is not None else subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            start_new_session=_NEW_SESSION,
        )
    except FileNotFoundError as exc:
        if stdout_master is not None:
            os.close(stdout_master)
        raise ValueError(f"Failed to start {program}: {exc}") from exc
    finally:
        if stdout_slave is not None:
            # The parent closes its copy of the slave; the child keeps the one it
            # inherited. If Popen failed the slave is still open here, so closing it
            # in finally means we never leak it and never double-close.
            try:
                os.close(stdout_slave)
            except OSError:
                pass

    if on_start is not None:
        on_start(proc)

    def feed_stdin(handle, data: bytes) -> None:
        # On its own thread, after the readers are running: a child that writes
        # before it reads, or never reads stdin at all, would otherwise block this
        # write — and with it the timeout — once a pipe buffer fills.
        try:
            handle.write(data)
        except (BrokenPipeError, OSError):
            pass  # the child exited or closed stdin; its output says why
        finally:
            try:
                handle.close()
            except (BrokenPipeError, OSError):
                pass

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

    if stdout_master is not None:
        stdout_reader = pty_reader
        stdout_handle = stdout_master
    else:
        stdout_reader = pipe_reader
        stdout_handle = proc.stdout  # pyright: ignore[reportOptionalMemberAccess]
    readers = [
        threading.Thread(
            target=stdout_reader,
            args=(stdout_handle, "stdout", stdout_chunks),
            daemon=True,
        ),
        threading.Thread(target=pipe_reader, args=(proc.stderr, "stderr", stderr_chunks), daemon=True),
    ]
    for thread in readers:
        thread.start()
    threading.Thread(
        target=feed_stdin,
        args=(proc.stdin, strip_shebang_line(source).encode("utf-8")),
        daemon=True,
    ).start()

    timed_out = False
    stopped = False
    try:
        proc.wait(timeout=EXEC_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_process_tree(proc)
        proc.wait()

    if is_stopped() and not timed_out:
        stopped = True
        # The stop handler killed the tree already; a stop that raced the
        # interpreter's own exit can still leave its children behind.
        kill_process_tree(proc)

    for thread in readers:
        thread.join(timeout=5)

    return {
        "exitCode": proc.returncode if proc.returncode is not None and proc.returncode >= 0 else None,
        "stdout": "".join(stdout_chunks),
        "stderr": "".join(stderr_chunks),
        "timedOut": timed_out,
        "stopped": stopped,
    }
