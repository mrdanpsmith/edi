"""Process lifetime of streamed code-block runs (no Qt needed)."""

from __future__ import annotations

import os
import sys
import time

import pytest

from backend import exec as exec_module

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX process groups")

# Starts a grandchild, prints its pid and waits on it: killing only `sh` would
# leave the `sleep` running.
SPAWNS_GRANDCHILD = "sleep 60 &\necho $!\nwait\n"


def _alive(pid: int) -> bool:
    """Whether `pid` is still running. A zombie is not: it is dead and only
    waiting to be reaped, and the orphaned grandchild is reaped by PID 1 — which
    in a CI container (`tail -f /dev/null`) never does, so `kill(pid, 0)` keeps
    succeeding for a process that has long been killed."""
    if os.path.isdir("/proc/self"):
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
                # The state is the field after the parenthesised command name.
                return handle.read().rsplit(")", 1)[1].split()[0] != "Z"
        except FileNotFoundError:
            return False
    # No /proc (macOS), where the orphan is reaped promptly: the signal probe.
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _wait_until(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def _grandchild_pid(events) -> int:
    text = "".join(chunk for stream, chunk in events if stream == "stdout")
    return int(text.split()[0])


def test_stop_kills_what_the_block_started():
    events: list[tuple[str, str]] = []
    state: dict = {}

    def on_output(stream, text):
        events.append((stream, text))
        if stream == "stdout" and "proc" in state and not state.get("stopped"):
            # What the bridge's stop handler does.
            state["stopped"] = True
            exec_module.kill_process_tree(state["proc"])

    result = exec_module.run_code_block_streamed(
        "#!sh",
        SPAWNS_GRANDCHILD,
        on_output,
        lambda: state.get("stopped", False),
        on_start=lambda proc: state.__setitem__("proc", proc),
    )

    assert result["stopped"] is True
    assert _wait_until(lambda: not _alive(_grandchild_pid(events)))


def test_timeout_kills_what_the_block_started(monkeypatch):
    monkeypatch.setattr(exec_module, "EXEC_TIMEOUT_SECONDS", 1)
    events: list[tuple[str, str]] = []

    result = exec_module.run_code_block_streamed(
        "#!sh", SPAWNS_GRANDCHILD, lambda s, t: events.append((s, t)), lambda: False
    )

    assert result["timedOut"] is True
    assert _wait_until(lambda: not _alive(_grandchild_pid(events)))


def test_a_run_sees_a_sized_color_terminal_on_stdout_and_stderr():
    # What a tool decides to color by: both streams are ttys, and TERM and the
    # window size describe what the output area draws.
    source = (
        "import os, sys\n"
        "print(sys.stdout.isatty(), os.environ['TERM'], os.environ['COLORTERM'])\n"
        "print(*os.get_terminal_size(1))\n"
        "print('\\033[31mred\\033[0m')\n"
        "print(sys.stderr.isatty(), file=sys.stderr)\n"
    )

    result = exec_module.run_code_block_streamed("#!python3", source, lambda s, t: None, lambda: False)

    assert result["exitCode"] == 0
    assert result["stdout"] == "True xterm-256color truecolor\n80 24\n\x1b[31mred\x1b[0m\n"
    assert result["stderr"] == "True\n"


def test_a_progress_line_streams_its_carriage_returns_before_any_newline():
    # A progress bar rewrites one line with `\r` and only ends it at the end; each
    # rewrite must reach the page while the run is still going.
    source = "printf ' 50%%'\nsleep 1\nprintf '\\r100%%\\n'\n"
    events: list[tuple[str, str]] = []

    result = exec_module.run_code_block_streamed("#!sh", source, lambda s, t: events.append((s, t)), lambda: False)

    assert events[0] == ("stdout", " 50%")
    # The pty's `\r\n` is folded to `\n`; the progress line's own `\r` is kept.
    assert result["stdout"] == " 50%\r100%\n"


def test_output_text_keeps_split_characters_and_split_line_endings():
    output = exec_module._OutputText()
    euro = "€".encode()
    assert output.feed(b"a" + euro[:1]) == "a"
    assert output.feed(euro[1:] + b"\r") == "€"
    assert output.feed(b"\nb\r") == "\nb"
    assert output.feed(b"c") == "\rc"
    assert output.feed(b"\r", final=True) == "\r"


def test_a_block_that_writes_before_reading_its_source_does_not_hang():
    # `sh -s` runs the first line before reading the rest: it fills the stderr
    # pipe while most of a large source is still unwritten. Feeding stdin before
    # the readers started deadlocked here until the timeout (which itself could
    # not fire, being behind the blocked write).
    source = "head -c 300000 /dev/zero | tr '\\0' x >&2\n" + "# padding\n" * 30000 + "echo done\n"
    started = time.monotonic()

    result = exec_module.run_code_block_streamed("#!sh", source, lambda s, t: None, lambda: False)

    assert time.monotonic() - started < 15
    assert result["timedOut"] is False
    assert result["exitCode"] == 0
    assert result["stdout"].strip() == "done"
    assert len(result["stderr"]) >= 300000
