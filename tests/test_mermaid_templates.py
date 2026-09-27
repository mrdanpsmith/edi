"""Real-engine sweep over every diagram in tests/fixtures/mermaid-templates.md.

Each fenced block is rendered inside the actual QtWebEngine app in dark mode and
asserted to (1) render without a mermaid error, (2) keep every native SVG ``<text>``
readable on the dark editor background (accepting the adaptation pass flipping
hardcoded dark colors), and (3) be baked to a raster bitmap whenever it has light
native text (the QtWebEngine repaint-bug protection). Light mode is a smoke check:
render without error. Kept deliberately below tests/test_mermaid_dark_probe.py
(which asserts precise flipped color values for C4/treeView/wardley).

The render helpers live in tests/mermaid_render.py: the mermaid visual editing
tests at the end of tests/test_window.py share them, rendering in that module's
already-open window instead of paying for another WebEngine page.

Requires ``dist/`` (see AGENTS.md) and a headless Qt (conftest handles both).
"""

import re
from pathlib import Path

import pytest

from backend.window import DIST_DIR, MainWindow
from tests.mermaid_render import (
    _native_text_fills,
    _pump_until,
    _render,
    _set_scheme,
    _wait_baked,
)

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
