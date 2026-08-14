"""Tests for the external-URL opener (link handling).

The pyzip onefile bootloader exports ``LD_LIBRARY_PATH`` pointing at a bundle
dir of Ubuntu 22.04 libraries; a browser child that inherits it loads those
older libs and breaks (e.g. Waterfox: "Couldn't load XPCOM"). These tests pin
the behaviour that ``xdg-open`` children get a clean environment.
"""

from __future__ import annotations

import os
import subprocess

import pytest

from backend.window import _child_env, _xdg_open


def test_child_env_strips_loader_overrides(monkeypatch):
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEIabc123")
    monkeypatch.setenv("LD_PRELOAD", "/some/evil.so")
    monkeypatch.setenv("HOME", "/home/test")
    env = _child_env()
    assert "LD_LIBRARY_PATH" not in env
    assert "LD_PRELOAD" not in env
    assert env["HOME"] == "/home/test"


def test_xdg_open_spawns_handler_with_clean_environment(monkeypatch):
    captured = {}

    class FakePopen:
        def __init__(self, args, **kwargs):
            captured["args"] = args
            captured["env"] = kwargs.get("env")

    monkeypatch.setattr(subprocess, "Popen", FakePopen)
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEIabc123")
    monkeypatch.setenv("LD_PRELOAD", "/some/evil.so")

    assert _xdg_open("https://example.com/a") is True
    assert captured["args"] == ["xdg-open", "https://example.com/a"]
    assert "LD_LIBRARY_PATH" not in captured["env"]
    assert "LD_PRELOAD" not in captured["env"]


def test_xdg_open_discards_stdio(monkeypatch):
    captured = {}

    class FakePopen:
        def __init__(self, args, **kwargs):
            captured.update(
                stdin=kwargs.get("stdin"),
                stdout=kwargs.get("stdout"),
                stderr=kwargs.get("stderr"),
            )

    monkeypatch.setattr(subprocess, "Popen", FakePopen)
    assert _xdg_open("https://example.com") is True
    assert captured["stdin"] is subprocess.DEVNULL
    assert captured["stdout"] is subprocess.DEVNULL
    assert captured["stderr"] is subprocess.DEVNULL


def test_xdg_open_reports_failure_when_handler_missing(monkeypatch):
    def raising_popen(*_args, **_kwargs):
        raise FileNotFoundError("xdg-open not found")

    monkeypatch.setattr(subprocess, "Popen", raising_popen)
    assert _xdg_open("https://example.com") is False
