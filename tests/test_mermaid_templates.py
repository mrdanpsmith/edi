"""Real-engine sweep over every diagram in tests/fixtures/mermaid-templates.md.

Each fenced block is rendered inside the actual QtWebEngine app in dark mode and
asserted to (1) render without a mermaid error, (2) keep every native SVG ``<text>``
readable on the dark editor background (accepting the adaptation pass flipping
hardcoded dark colors), and (3) be baked to a raster bitmap whenever it has light
native text (the QtWebEngine repaint-bug protection). Light mode is a smoke check:
render without error. Kept deliberately below tests/test_mermaid_dark_probe.py
(which asserts precise flipped color values for C4/treeView/wardley).

Requires ``dist/`` (see AGENTS.md) and a headless Qt (conftest handles both).
"""

import json
import re
from pathlib import Path

import pytest

from backend.window import DIST_DIR, MainWindow
from tests.test_window import _pump_until

FIXTURES = Path(__file__).parent / "fixtures" / "mermaid-templates.md"


def load_fixtures():
    text = FIXTURES.read_text()
    blocks = re.findall(r"```mermaid\n(.*?)```", text, re.S)
    names = re.findall(r"^## (.+)$", text, re.M)
    assert len(names) == len(blocks), "mermaid-templates.md malformed: names/block count mismatch"
    return list(zip(names, blocks))


@pytest.fixture(scope="module")
def win(qapp):
    assert (DIST_DIR / "index.html").is_file()
    w = MainWindow()
    w.resize(1280, 800)
    w.show()
    js = w._web.page().runJavaScript
    ready = {"v": False}

    def probe_ready():
        js(
            "!!window.bridge && typeof window.bridge.invoke === 'function'",
            lambda v: ready.__setitem__("v", bool(v)),
        )
        return ready["v"]

    assert _pump_until(probe_ready, timeout=15), "bridge never ready"
    yield w
    w.close()
    w.deleteLater()


def _dump(win, script):
    js = win._web.page().runJavaScript
    out = {}
    js(f"JSON.stringify({script})", lambda v: out.update(json.loads(v) if isinstance(v, str) else {}))
    _pump_until(lambda: bool(out), timeout=5)
    return out


def _set_scheme(win, dark):
    win.push_event({"type": "colorScheme", "dark": dark})
    js = win._web.page().runJavaScript
    got = {"v": None}

    def read(v):
        got["v"] = v

    def probe():
        js("document.documentElement.dataset.colorScheme", read)
        return got["v"] == ("dark" if dark else "light")

    assert _pump_until(probe, timeout=10), f"scheme never became dark={dark}: {got}"


def _render(win, code, timeout=20):
    """Insert ``code`` and wait for the current render: a freshly-id'd svg or an
    error block. Renders replace the previous svg with a new id, so an id change
    distinguishes the new content from a stale previous diagram."""
    js = win._web.page().runJavaScript
    prev = {"id": None, "errT": None}

    def snapshot():
        return _dump(
            win,
            "(() => { const s = document.querySelector('.mermaid .mermaid-preview svg');"
            " const e = document.querySelector('.mermaid-error');"
            " return { id: s ? s.id : null,"
            " err: !!e, errT: e ? String(e.textContent).slice(0, 80) : null }; })()",
        )

    js(f"window.ediSetContent({json.dumps('```mermaid\n' + code + '\n```')}); true")

    def probe():
        nonlocal prev
        d = snapshot()
        fresh = (d.get("id") and d.get("id") != prev["id"]) or (
            d.get("err") and d.get("errT") != prev["errT"]
        )
        if fresh or (d.get("err") and not d.get("id")):
            prev = d
            return True
        if d.get("id"):
            prev = d
        return False

    assert _pump_until(probe, timeout=timeout), f"diagram never rendered: {prev}"
    return prev


def _native_text_fills(win):
    return _dump(
        win,
        "(() => { const s = document.querySelector('.mermaid .mermaid-preview svg');"
        " const fills = s ? [...s.querySelectorAll('text, text tspan')]"
        "  .filter(t => !t.closest('foreignObject'))"
        "  .map(t => getComputedStyle(t).fill)"
        "  .filter(f => f && f !== 'none') : [];"
        " return { fills }; })()",
    ).get("fills", [])


def _wait_baked(win, timeout=30):
    js = win._web.page().runJavaScript
    out = {"v": False}

    def read(v):
        out["v"] = bool(v)

    def probe():
        js("!!document.querySelector('.mermaid img.mermaid-img')", read)
        return out["v"]

    return _pump_until(probe, timeout=timeout)


def relative_luminance(color: str) -> float:
    m = re.match(r"rgb\((\d+),\s*(\d+),\s*(\d+)\)", color or "")
    if not m:
        return -1.0
    chan = [int(c) / 255 for c in m.groups()]

    def linear(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    l = [linear(c) for c in chan]
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]


def contrast_between(color: str, bg: str) -> float:
    l1, l2 = relative_luminance(color), relative_luminance(bg)
    if l1 < 0 or l2 < 0:
        return -1.0
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


# The app's dark editor background (MERMAID_DARK_BACKGROUND / --bg). Also the
# fallback the adaptation pass uses when a diagram paints no backdrop.
DARK_BG = "rgb(13, 17, 23)"


@pytest.mark.parametrize("name,code", load_fixtures(), ids=[n for n, _ in load_fixtures()])
def test_template_renders_and_readable_dark(win, name, code):
    _set_scheme(win, True)
    _render(win, code)
    fills = _native_text_fills(win)
    for fill in fills:
        assert contrast_between(fill, DARK_BG) >= 4.5, (name, fill, "text unreadable on dark")
    if fills:  # light native text needs the baked-raster repaint protection
        assert _wait_baked(win), (name, "dark render never baked")
    _set_scheme(win, False)
    st = _render(win, code, timeout=20)
    assert not st["err"], (name, st["errT"])