"""Run executable code blocks, mirroring the previous Rust backend."""

from __future__ import annotations

import codecs
import os
import signal
import struct
import subprocess
import sys
import threading
import time

try:
    import fcntl
    import pty
    import termios
except ImportError:
    # Windows has no POSIX pseudo-terminals ('termios' is missing).
    fcntl = None
    pty = None
    termios = None

import select

EXEC_TIMEOUT_SECONDS = 30

# The terminal a streamed run's output goes to. A program sizing a progress bar
# reads the pty's window size, which is 0×0 until it is set; 80 columns fits the
# output area beside a document.
TERMINAL_COLUMNS = 80
TERMINAL_ROWS = 24

# What the output area draws (`src/terminal.ts`): 16, 256 and 24-bit color, and
# the cursor moves progress output uses. It is the run's terminal, so it is
# described here rather than inherited from the terminal Edi was started from.
_TERMINAL_ENV = {"TERM": "xterm-256color", "COLORTERM": "truecolor"}

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


def run_command(shebang: str) -> list[str] | None:
    """The command a block with ``shebang`` would run, as the reader is shown
    it before agreeing, or ``None`` when it cannot run at all (and so needs no
    agreement: the run itself reports why)."""
    try:
        program, args, _env = _resolve_run(shebang)
    except ValueError:
        return None
    # The last argument only tells the interpreter to read the code from stdin.
    return [program, *args[:-1]]


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


def _open_terminal() -> tuple[int | None, int | None]:
    """A pty's (master, slave) fds, sized like a terminal; (None, None) without ptys."""
    if pty is None:
        return None, None
    master, slave = pty.openpty()
    if fcntl is not None and termios is not None:
        size = struct.pack("HHHH", TERMINAL_ROWS, TERMINAL_COLUMNS, 0, 0)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
    return master, slave


def _slave_or_pipe(terminal: tuple[int | None, int | None]):
    """What a child's stream is attached to: the pty's slave, or a pipe without one."""
    slave = terminal[1]
    return slave if slave is not None else subprocess.PIPE


class _OutputText:
    """A stream's bytes as the text to send, one chunk at a time.

    Decoded across chunk boundaries, so a character split between two reads is
    not replaced. ``\\r\\n`` (what a pty's line discipline sends for each
    newline, and a Windows program's own line ending) is folded to ``\\n``, while
    a ``\\r`` alone is kept: it is how a progress line returns to its start to
    rewrite itself. A chunk ending in ``\\r`` holds it back until the next chunk
    says whether a ``\\n`` follows.
    """

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._held_cr = False

    def feed(self, raw: bytes, final: bool = False) -> str:
        text = self._decoder.decode(raw, final)
        if self._held_cr:
            text = "\r" + text
            self._held_cr = False
        if text.endswith("\r") and not final:
            text = text[:-1]
            self._held_cr = True
        return text.replace("\r\n", "\n")


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

    stdout and stderr are each attached to a pseudo-terminal of their own, so
    the two stay distinguishable while the program sees the terminal it would
    in a shell. Interpreters that block-buffer a pipe (Python, Ruby, Node,
    Perl, ...) line-buffer a tty, so ``print``/``echo`` output arrives as it is
    written, and tools that color only a terminal (``ls``, ``grep``, test
    runners, progress bars) color their output. Chunks are sent as they are
    read, not a line at a time, with ``\\r`` kept, so a progress line that
    rewrites itself shows each rewrite; the page draws them (``src/terminal.ts``).
    On Windows there is no pty, so both stream over ordinary pipes instead.
    """
    program, args, env = _resolve_run(shebang)

    # The ptys are optional: on platforms without them (Windows) both streams use
    # ordinary pipes instead. A single code path takes the optional slave fds.
    terminals = {"stdout": _open_terminal(), "stderr": _open_terminal()}
    if terminals["stdout"][0] is not None:
        env.update(_TERMINAL_ENV)
    # Same allow-listed interpreter, same explicit argv; streaming adds ptys
    # but nothing shell-related.
    try:
        proc = subprocess.Popen(  # nosec B603
            [program, *args],
            stdin=subprocess.PIPE,
            stdout=_slave_or_pipe(terminals["stdout"]),
            stderr=_slave_or_pipe(terminals["stderr"]),
            env=env,
            start_new_session=_NEW_SESSION,
        )
    except FileNotFoundError as exc:
        for master, _slave in terminals.values():
            if master is not None:
                os.close(master)
        raise ValueError(f"Failed to start {program}: {exc}") from exc
    finally:
        for _master, slave in terminals.values():
            if slave is not None:
                # The parent closes its copy of the slave; the child keeps the one
                # it inherited. If Popen failed the slave is still open here, so
                # closing it in finally means we never leak it and never
                # double-close.
                try:
                    os.close(slave)
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

    chunks: dict[str, list[str]] = {"stdout": [], "stderr": []}

    def emit(stream_name: str, text: str) -> None:
        if text:
            chunks[stream_name].append(text)
            on_output(stream_name, text)

    def pipe_reader(handle, stream_name) -> None:
        output = _OutputText()
        try:
            while raw := handle.read1(4096):
                emit(stream_name, output.feed(raw))
        finally:
            emit(stream_name, output.feed(b"", final=True))
            try:
                handle.close()
            except OSError:
                pass

    def pty_reader(fd, stream_name) -> None:
        # Use select so we never block forever once the child exits (a read on
        # the master then raises EIO rather than returning EOF).
        output = _OutputText()
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
                emit(stream_name, output.feed(raw))
        finally:
            emit(stream_name, output.feed(b"", final=True))
            try:
                os.close(fd)
            except OSError:
                pass

    readers = []
    for stream_name, (master, _slave) in terminals.items():
        if master is not None:
            target, handle = pty_reader, master
        else:
            target, handle = pipe_reader, getattr(proc, stream_name)
        readers.append(threading.Thread(target=target, args=(handle, stream_name), daemon=True))
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
        "stdout": "".join(chunks["stdout"]),
        "stderr": "".join(chunks["stderr"]),
        "timedOut": timed_out,
        "stopped": stopped,
    }
