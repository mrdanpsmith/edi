"""Run executable code blocks, mirroring the previous Rust backend."""

from __future__ import annotations

import os
import subprocess

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

    try:
        proc = subprocess.Popen(
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
