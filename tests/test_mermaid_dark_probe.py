import json

import pytest

from backend.window import DIST_DIR, MainWindow
from tests.test_window import _pump_until

C4 = 'C4Context\nPerson(user, "User")\nSystem(app, "App")\nRel(user, app, "Uses")'
TREE = 'treeView-beta\nRoot\n  Child\n    Grandchild'
WARDLEY = 'wardley-beta\n  size [400, 300]\n  component "App" [0.5, 0.3]\n  anchor "Root" [0.1, 0.8]\n  "Root" -> "App"\n'
FLOW = 'flowchart TD\n  A --> B'

C4_MARKER = "[...s.querySelectorAll('text')].some(t => t.textContent === 'User')"
TREE_MARKER = "!!s.querySelector('.treeView-node-label')"
WARDLEY_MARKER = "s.querySelectorAll('text').length >= 2"
FLOW_MARKER = "s.querySelectorAll('text, foreignObject').length >= 1"


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


def _load(win, code, marker, dark):
    js = win._web.page().runJavaScript
    js(f"window.ediSetContent({json.dumps('```mermaid\n' + code + '\n```')}); true")
    out = {"done": False}
    want = ("dark" if dark else "light")

    def probe():
        def read(v):
            out.clear()
            out.update(json.loads(v) if isinstance(v, str) else {})

        js(
            f"JSON.stringify((() => {{"
            f" if (document.documentElement.dataset.colorScheme !== '{want}') return {{ done: false }};"
            f" const s = document.querySelector('.mermaid .mermaid-preview svg') || document.querySelector('.mermaid .mermaid-source svg');"
            f" if (!s) return {{ done: false }};"
            f" if (!({marker})) return {{ done: false }};"
            f" const img = document.querySelector('.mermaid img.mermaid-img');"
            f" return {{ done: true, baked: !!img }}; }})())",
            read,
        )
        return out.get("done", False)

    assert _pump_until(probe, timeout=30), f"diagram never rendered: {out}"


def _wait_baked(win, timeout=30):
    js = win._web.page().runJavaScript
    out = {"v": False}

    def read(v):
        out["v"] = bool(v)

    def probe():
        js("!!document.querySelector('.mermaid img.mermaid-img')", read)
        return out["v"]

    return _pump_until(probe, timeout=timeout)


def _peek(win, expr):
    js = win._web.page().runJavaScript
    out = {"v": False}
    js(f"!!({expr})", lambda v: out.__setitem__("v", bool(v)))
    _pump_until(lambda: out["v"], timeout=5)
    return out["v"]


def _dump(win, script):
    js = win._web.page().runJavaScript
    out = {}
    js(f"JSON.stringify({script})", lambda v: out.update(json.loads(v) if isinstance(v, str) else {}))
    _pump_until(lambda: bool(out), timeout=5)
    return out


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


C4_PROBE = """(() => {
  const svg = document.querySelector('.mermaid .mermaid-preview svg') || document.querySelector('.mermaid .mermaid-source svg');
  const uses = [...svg.querySelectorAll('text')].find(t => t.textContent === 'Uses');
  const relG = uses ? uses.parentElement : null;
  const line = relG ? [...relG.children].find(e => e.tagName === 'line') : null;
  const user = [...svg.querySelectorAll('text')].find(t => t.textContent === 'User');
  const marker = svg.querySelector('marker path');
  return {
    bg: document.documentElement.dataset.colorScheme,
    usesComputed: uses ? getComputedStyle(uses).fill : null,
    usesInline: uses ? uses.style.fill : null,
    lineComputed: line ? getComputedStyle(line).stroke : null,
    lineInline: line ? line.style.stroke : null,
    markerComputed: marker ? getComputedStyle(marker).fill : null,
    markerInline: marker ? marker.style.fill : null,
    userComputed: user ? getComputedStyle(user).fill : null,
  };
})()"""

TREE_PROBE = """(() => {
  const svg = document.querySelector('.mermaid .mermaid-preview svg') || document.querySelector('.mermaid .mermaid-source svg');
  const img = document.querySelector('.mermaid img.mermaid-img');
  const labels = [...svg.querySelectorAll('.treeView-node-label')];
  const edges = [...svg.querySelectorAll('.treeView-node-line')];
  return {
    bg: document.documentElement.dataset.colorScheme,
    labelComputed: labels.length ? getComputedStyle(labels[0]).fill : null,
    labelInline: labels.length ? labels[0].style.fill : null,
    edgeComputed: edges.length ? getComputedStyle(edges[0]).stroke : null,
    edgeInline: edges.length ? edges[0].style.stroke : null,
    card: svg.classList.contains('mermaid-light-card'),
    baked: !!img,
  };
})()"""

WARDLEY_PROBE = """(() => {
  const svg = document.querySelector('.mermaid .mermaid-preview svg') || document.querySelector('.mermaid .mermaid-source svg');
  const texts = [...svg.querySelectorAll('text')].map(t => getComputedStyle(t).fill)
    .filter(Boolean).filter(f => f !== 'none');
  const rects = [...svg.querySelectorAll('rect')];
  const coverage = rects.map(r => getComputedStyle(r).fill).filter(f => f && f !== 'none');
  return {
    bg: document.documentElement.dataset.colorScheme,
    textFills: texts,
    rectFills: coverage,
  };
})()"""

FLOW_PROBE = """(() => {
  const svg = document.querySelector('.mermaid .mermaid-preview svg') || document.querySelector('.mermaid .mermaid-source svg');
  const texts = [...svg.querySelectorAll('text')]
    .filter(t => !t.closest('foreignObject'))
    .map(t => ({ t: t.textContent, f: getComputedStyle(t).fill }))
    .filter(x => x.f && x.f !== 'none');
  return { bg: document.documentElement.dataset.colorScheme, texts };
})()"""


def test_c4_adapt(win, capsys):
    _set_scheme(win, True)
    _load(win, C4, C4_MARKER, True)
    dark = _dump(win, C4_PROBE)
    _set_scheme(win, False)
    _load(win, C4, C4_MARKER, False)
    light = _dump(win, C4_PROBE)
    with capsys.disabled():
        print("C4-DARK", json.dumps(dark))
        print("C4-LIGHT", json.dumps(light))
    assert dark["bg"] == "dark"
    assert dark["usesComputed"] == "rgb(230, 237, 243)", dark  # rel label flipped readable
    assert dark["usesInline"], dark  # inline so bake survives
    assert dark["lineComputed"] == "rgb(139, 148, 158)", dark  # connector line flipped
    assert dark["lineInline"], dark
    assert dark["userComputed"] == "rgb(255, 255, 255)", dark  # white-on-navy kept
    assert light["usesComputed"] == "rgb(68, 68, 68)", light  # stock in light mode
    assert light["lineComputed"] == "rgb(68, 68, 68)", light
    assert not dark["usesInline"] or dark["usesInline"] == "rgb(230, 237, 243)"
    assert not light["lineInline"] or light["lineInline"] == "rgb(68, 68, 68)"


def test_treeview_adapt_no_card(win, capsys):
    _set_scheme(win, True)
    _load(win, TREE, TREE_MARKER, True)
    dark = _dump(win, TREE_PROBE)
    assert _wait_baked(win), dark  # dark render actually bakes to a raster
    _set_scheme(win, False)
    _load(win, TREE, TREE_MARKER, False)
    light = _dump(win, TREE_PROBE)
    with capsys.disabled():
        print("TREE-DARK", json.dumps(dark))
        print("TREE-LIGHT", json.dumps(light))
    assert dark["bg"] == "dark"
    assert dark["labelComputed"] in ("rgb(230, 237, 243)", "rgb(0, 0, 0)"), dark
    assert dark["edgeComputed"] in ("rgb(139, 148, 158)", "rgb(0, 0, 0)"), dark
    assert dark["card"] is False, dark  # no white card needed anymore
    assert light["labelComputed"] in ("rgb(0, 0, 0)", "black"), light
    assert light["edgeComputed"] in ("rgb(0, 0, 0)", "black"), light


def test_wardley_axes_readable(win, capsys):
    _set_scheme(win, True)
    _load(win, WARDLEY, WARDLEY_MARKER, True)
    dark = _dump(win, WARDLEY_PROBE)
    _set_scheme(win, False)
    _load(win, WARDLEY, WARDLEY_MARKER, False)
    light = _dump(win, WARDLEY_PROBE)
    with capsys.disabled():
        print("WARDLEY-DARK", json.dumps(dark))
        print("WARDLEY-LIGHT", json.dumps(light))
    assert dark["bg"] == "dark"
    assert "rgb(13, 17, 23)" in dark["rectFills"], dark  # diagram paints its own dark bg
    for f in dark["textFills"]:
        lum = relative_luminance(f)
        assert lum > 0.4, (f, dark)  # all labels readable on the dark chart bg
    assert light["rectFills"] and relative_luminance(light["rectFills"][0]) > 0.9, light  # light bg in light mode
    for f in light["textFills"]:
        lum = relative_luminance(f)
        assert lum < 0.6, (f, light)


def test_flowchart_untouched(win, capsys):
    _set_scheme(win, True)
    _load(win, FLOW, FLOW_MARKER, True)
    dark = _dump(win, FLOW_PROBE)
    _set_scheme(win, False)
    _load(win, FLOW, FLOW_MARKER, False)
    light = _dump(win, FLOW_PROBE)
    with capsys.disabled():
        print("FLOW-DARK", json.dumps(dark))
        print("FLOW-LIGHT", json.dumps(light))
    for t in dark["texts"]:
        assert relative_luminance(t["f"]) > 0.4, (t, dark)  # theme-driven = already readable
    for t in light["texts"]:
        assert relative_luminance(t["f"]) < 0.6, (t, light)


def relative_luminance(color: str) -> float:
    m = __import__("re").match(r"rgb\((\d+),\s*(\d+),\s*(\d+)\)", color or "")
    if not m:
        return -1.0
    chan = [int(c) / 255 for c in m.groups()]

    def linear(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    l = [linear(c) for c in chan]
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]