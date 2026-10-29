"""Real-engine sweep over every diagram in tests/fixtures/mermaid-templates.md.

Each fenced block is rendered inside the actual QtWebEngine app in dark mode and
asserted to (1) render without a mermaid error, (2) keep every native SVG ``<text>``
readable on the dark editor background (accepting the adaptation pass flipping
hardcoded dark colors), and (3) be baked to a raster bitmap whenever it has light
native text (the QtWebEngine repaint-bug protection). Light mode is a smoke check:
render without error. Kept deliberately below tests/test_mermaid_dark_probe.py
(which asserts precise flipped color values for C4/treeView/wardley).

The same sweep also walks every label edit mode offers and renames each one
through the real gesture path (click, type, Enter), checking the invariant the
UI promises:

* every label edit mode offers can be renamed, and the rewrite lands in the
  fenced source;
* nothing is offered that the source never spelled out (a computed treemap
  total, a default axis name, a ``<<stereotype>>``).

mermaid refuses some legal edits -- renaming an implicit git branch points at a
branch that was never declared, and a requirement row's value must stay inside
its enum -- and those count as ``refused``, not failures: the patch committed
and the app said so on the diagram. A silent no-op is a failure. This is the
only check that sees mermaid's real DOM shape, so it is what catches a mermaid
upgrade changing its SVG markup or grammar. Narrow it with ``-k``, e.g.
``pytest tests/test_mermaid_templates.py -k "label_renames and Kanban"``.

The render helpers live in tests/mermaid_render.py: the mermaid visual editing
tests at the end of tests/test_window.py share them, rendering in that module's
already-open window instead of paying for another WebEngine page.

Requires ``dist/`` (see AGENTS.md) and a headless Qt (conftest handles both).
"""

import re
import warnings
from pathlib import Path

import pytest

from backend.window import DIST_DIR, MainWindow
from tests.mermaid_render import (
    LABEL_INVENTORY,
    LABEL_STATE,
    _click_first_offered,
    _dump,
    _enter_edit_mode,
    _native_text_fills,
    _pump_until,
    _render,
    _set_scheme,
    _type_and_confirm,
    _wait_baked,
)

FIXTURES = Path(__file__).parent / "fixtures" / "mermaid-templates.md"
#: Appended to whatever the editor seeded: long enough to be its own value,
#: short enough to stay inside every family's identifier rules.
SUFFIX = "X"


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

    from tests.harness_loader import harness_js

    injected = {"done": False}

    def _on_injected(_v):
        injected["done"] = True

    js(harness_js(), _on_injected)
    _pump_until(lambda: injected["done"], timeout=5.0)

    yield w
    # The label walk's renames leave the document dirty, and a dirty close is
    # refused behind a confirm prompt: the window would stay up with a modal
    # open, and every later dialog test would find that prompt instead of its own.
    w.set_dirty(False)
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


def drawn(value: str, texts: list) -> bool:
    """Whether mermaid drew the committed value.

    Whitespace-insensitive: a long label comes back wrapped across ``tspan``s
    with its spaces dropped (``Lack of TrainingX`` renders as
    ``Lack ofTrainingX``), which is the same value drawn. Substring, not exact:
    a drawn value can share its text element with a generated one (a sankey
    node shows its total under the name).
    """
    needle = "".join(value.split())
    return any(needle in "".join(text.split()) for text in texts)


def spelled_out(value: str, source: str) -> bool:
    """Whether the source spells the value, allowing for its own escaping.

    A kanban label cannot hold a raw double quote -- a quoted label is drawn as
    the text inside its quotes, so a raw one would close the run it sits in --
    and the app writes ``&quot;`` instead, with ``&`` escaped ahead of it. So a
    rename that worked can leave the source holding entities where the typed
    value has the character. Decoding before comparing asks "did the user's
    text reach the document" without treating the document's spelling of it as
    a failure; the order mirrors the app's reader, so ``&amp;quot;`` still has
    to come back as literal ``&quot;`` and not as a quote.
    """
    decoded = source.replace("&quot;", '"').replace("&amp;", "&")
    return value in decoded


def classify(value: str, state: dict) -> tuple[str, str]:
    """What the app did with one rename, and why, from what it shows after it."""
    shown = drawn(value, state.get("texts", []))
    committed = bool(state.get("source")) and spelled_out(value, state["source"])
    if state.get("input"):
        return "failed", "the editor stayed open"
    if state.get("error"):
        return "failed", "the edit left an error block behind"
    if not committed:
        return "failed", "the patch never reached the source"
    if shown:
        return "ok", ""
    if state.get("notice"):
        return "refused", "mermaid rejected the value, and the notice said so"
    # Mermaid re-read the value under its own grammar: renaming a class method
    # to `+sleep()X` declares a method returning `X`. The source is what was
    # asked for, so this is a warning, not a failure -- but it is not `ok`
    # either.
    return "rewritten", "mermaid re-read the value under its own grammar"


def wait_settled(win, before: str | None, timeout: float = 20) -> dict:
    """Poll until the rename has settled, or the timeout runs out.

    Settled is a new render (an svg id other than ``before``, the one up when
    Enter was pressed), a notice or an error block -- not "the value is drawn",
    which a rename mermaid re-reads never is, so it would always wait out the
    timeout. This never raises: an outcome with no bucket in `classify` is
    exactly what it has to report.
    """
    seen: dict = {}

    def settled() -> bool:
        seen.update(_dump(win, LABEL_STATE))
        return (seen.get("id") or before) != before or seen.get("notice") or seen.get("error")

    _pump_until(settled, timeout=timeout)
    return seen


def rename_label(win, index: int) -> tuple[str, str, str]:
    """Click the offered label at ``index``, append SUFFIX: (value, verdict, why)."""
    try:
        seeded = _click_first_offered(win, index=index)
    except AssertionError as exc:
        return "?", "failed", f"the click failed ({exc})"
    # `None` is "no editor opened", which is a failure; an *empty* seed is a field
    # that opened on a placeholder (a drawn slot's label), which is not, and has
    # no text to append to, so the suffix alone is the new text.
    if seeded is None:
        return "?", "failed", "no editor opened"
    value = f"{seeded}{SUFFIX}" if seeded else SUFFIX
    before = _dump(win, LABEL_STATE).get("id")
    try:
        _type_and_confirm(win, value)
    except AssertionError as exc:
        return value, "failed", f"the editor never closed ({exc})"
    return (value, *classify(value, wait_settled(win, before)))


@pytest.mark.parametrize("name,code", load_fixtures(), ids=[n for n, _ in load_fixtures()])
def test_every_offered_label_renames(win, name, code):
    _render(win, code)
    _enter_edit_mode(win)
    inv = _dump(win, LABEL_INVENTORY)
    assert not (inv.get("missing") or inv.get("error")), (name, "the diagram never rendered")

    failed, rewritten = [], []
    for index, label in enumerate(inv["labels"]):
        # Back to the pristine source and a fresh edit mode: a committed rename
        # would otherwise change what the next label has to match. When the
        # rename did change the source, the renamed svg stays up until the
        # pristine one replaces it, so wait for an svg newer than it.
        shown = _dump(win, LABEL_STATE)
        changed = (shown.get("source") or "").strip() != code.strip()
        _render(win, code, after=shown.get("id") if changed else None)
        _enter_edit_mode(win)
        if index >= len(_dump(win, LABEL_INVENTORY).get("labels", [])):
            failed.append(f"{label!r}: the offer did not survive a re-render")
            continue
        value, verdict, why = rename_label(win, index)
        if verdict == "failed":
            failed.append(f"{label!r} -> {value!r}: {why}")
        elif verdict == "rewritten":
            rewritten.append(f"{label!r} -> {value!r}")
    if rewritten:
        warnings.warn(f"{name}: mermaid re-read {len(rewritten)} rename(s) under its own grammar: {rewritten}")
    assert not failed, f"{name}: {len(failed)} of {len(inv['labels'])} offered labels failed:\n" + "\n".join(failed)
