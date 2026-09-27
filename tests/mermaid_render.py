"""Shared WebEngine helpers for the real-engine mermaid tests.

Every ``MainWindow`` is a WebEngine page, and a small container can only bring a
couple of them up: the template sweep and the visual editing tests therefore
share this code and pass the window in. Nothing here collects tests itself.
"""

import json
import time

from PySide6.QtWidgets import QApplication

def _pump_until(condition, timeout=8.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if condition():
            return True
        time.sleep(0.02)
    return False


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

    payload = json.dumps(f"```mermaid\n{code}\n```")
    js(f"window.ediSetContent({payload}); true")

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




FLOW = "graph TD\n  A[Alpha]\n  B[Beta]\n  A -->|Yes| B"
KANBAN = "kanban\n  Todo\n    id1[One]\n    id2[Two]\n  Doing\n    id3[Three]"
SEQUENCE = (
    "sequenceDiagram\n  participant Alice\n  participant Bob\n"
    "  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice"
)


def _wait(win, script, predicate, timeout=15):
    """Poll ``script`` (an object-returning expression) until ``predicate`` holds."""
    seen = {"v": {}}

    def probe():
        seen["v"] = _dump(win, script)
        return predicate(seen["v"])

    assert _pump_until(probe, timeout=timeout), f"never satisfied: {seen['v']}"
    return seen["v"]


def _enter_edit_mode(win, timeout=15):
    """Click the real Edit button and wait for the labels to be marked."""
    clicked = _dump(
        win,
        "(() => { const b = document.querySelector('.mermaid-edit-toggle');"
        " if (!b) return { missing: true };"
        " b.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));"
        " return { label: b.textContent }; })()",
    )
    assert not clicked.get("missing"), "the hover toolbar had no Edit button"
    return _wait(
        win,
        "(() => ({ n: document.querySelectorAll('.mermaid-editables').length }))()",
        lambda d: d["n"] > 0,
        timeout=timeout,
    )["n"]


def _click_label(win, text):
    """Click the first marked label whose text is ``text``, with a real click."""
    found = _dump(
        win,
        f"""(() => {{
          const el = [...document.querySelectorAll('.mermaid-editables')]
            .find((e) => e.textContent.trim() === {json.dumps(text)});
          if (!el) return {{ missing: true }};
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const at = document.elementFromPoint(x, y) || el;
          for (const type of ['mousedown', 'mouseup', 'click']) {{
            at.dispatchEvent(new MouseEvent(type,
              {{ bubbles: true, button: 0, clientX: x, clientY: y }}));
          }}
          return {{ x, y, target: at.tagName }};
        }})()""",
    )
    assert not found.get("missing"), f"no editable label {text!r}"
    return _wait(
        win,
        "(() => { const i = document.querySelector('.mermaid-edit-input');"
        " return { v: i ? i.value : null }; })()",
        lambda d: d["v"] is not None,
        timeout=10,
    )["v"]


def _type_and_confirm(win, value, timeout=15):
    typed = _dump(
        win,
        f"""(() => {{
          const i = document.querySelector('.mermaid-edit-input');
          if (!i) return {{ missing: true }};
          i.value = {json.dumps(value)};
          i.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', bubbles: true }}));
          return {{ typed: true }};
        }})()""",
    )
    assert not typed.get("missing"), "no label editor was open"
    _wait(
        win,
        "(() => ({ gone: !document.querySelector('.mermaid-edit-input') }))()",
        lambda d: d["gone"],
        timeout=timeout,
    )


def _type(win, value):
    """Type into the open label editor and leave it open -- the half-finished
    state the toggle button and an outside double click have to resolve."""
    typed = _dump(
        win,
        f"""(() => {{
          const i = document.querySelector('.mermaid-edit-input');
          if (!i) return {{ missing: true }};
          i.value = {json.dumps(value)};
          i.dispatchEvent(new Event('input', {{ bubbles: true }}));
          return {{ typed: i.value }};
        }})()""",
    )
    assert not typed.get("missing"), "no label editor was open"
    return typed


def _click_done(win):
    """Press the hover toolbar's Done button the way a mouse does: the press
    first, which is what keeps the open label editor focused, and only then the
    click that turns edit mode off."""
    pressed = _dump(
        win,
        "(() => { const b = document.querySelector('.mermaid-edit-toggle');"
        " if (!b) return { missing: true };"
        " const opts = { bubbles: true, button: 0 };"
        " b.dispatchEvent(new MouseEvent('mousedown', opts));"
        " b.dispatchEvent(new MouseEvent('mouseup', opts));"
        " b.dispatchEvent(new MouseEvent('click', opts));"
        " return { label: b.textContent }; })()",
    )
    assert not pressed.get("missing"), "the hover toolbar had no Done button"
    return pressed


LABEL_INVENTORY = (
    "(() => { const svg = document.querySelector('.mermaid .mermaid-preview svg');"
    " if (!svg) return { missing: true };"
    " return { error: !!document.querySelector('.mermaid-error'),"
    "  labels: [...svg.querySelectorAll('.mermaid-editables')].map((e) => e.textContent.trim()),"
    "  allText: [...svg.querySelectorAll('text, .nodeLabel, .edgeLabel, .labelText,"
    "   .loopText, .titleText, .sectionTitle, .taskText')]"
    "   .map((e) => e.textContent.trim()).filter(Boolean) }; })()"
)

# The node view instance is private, but the doc view desc always holds the
# current node, so the patched fenced source is readable from it -- which is how
# a committed patch is told apart from a no-op when mermaid refuses the result.
LABEL_STATE = (
    "(() => { const svg = document.querySelector('.mermaid .mermaid-preview svg');"
    " return { texts: svg"
    "   ? [...svg.querySelectorAll('text, .nodeLabel, .edgeLabel, .labelText, .loopText,"
    "      .titleText, .sectionTitle, .taskText')].map((e) => e.textContent.trim())"
    "   : [],"
    "  input: !!document.querySelector('.mermaid-edit-input'),"
    "  editing: !!document.querySelector('.mermaid-editing'),"
    "  editable: !!document.querySelector('.mermaid-editables'),"
    "  invalid: !!document.querySelector('.mermaid-edit-invalid'),"
    "  notice: !!document.querySelector('.mermaid-edit-notice'),"
    "  error: !!document.querySelector('.mermaid-error'),"
    "  source: (() => { const out = [];"
    "   const walk = (n) => { if (n.attrs && typeof n.attrs.value === 'string' && n.attrs.value)"
    "     out.push(n.attrs.value); n.forEach(walk); };"
    "   const root = document.querySelector('.ProseMirror');"
    "   if (root && root.pmViewDesc && root.pmViewDesc.node) walk(root.pmViewDesc.node);"
    "   return out.length ? out.join(' | ') : null; })() }; })()"
)


def _click_first_offered(win, startswith=None, index=None):
    """Click an offered label -- the first whose text starts with ``startswith``,
    or the one at ``index`` when the caller is walking the inventory in order --
    and return the value the editor seeded: the source spelling, which is not
    always the rendered text (a sankey node shares its element with a generated
    value, a requirement row is drawn under mermaid's own idea of the key)."""
    if startswith is not None and index is not None:
        raise ValueError("pass startswith or index, not both")
    if startswith is not None:
        pick = f"all.find((e) => e.textContent.trim().startsWith({json.dumps(startswith)}))"
    elif index is not None:
        pick = f"all[{index}]"
    else:
        pick = "all[0]"
    out = _dump(
        win,
        f"""(() => {{
          const all = [...document.querySelectorAll('.mermaid-editables')];
          const el = {pick};
          if (!el) return {{ missing: true }};
          const r = el.getBoundingClientRect();
          const opts = {{ bubbles: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }};
          for (const type of ['mousedown', 'mouseup', 'click'])
            el.dispatchEvent(new MouseEvent(type, opts));
          return {{ picked: el.textContent.trim() }};
        }})()""",
    )
    assert not out.get("missing"), "no offered label matched"
    return _wait(
        win,
        "(() => { const i = document.querySelector('.mermaid-edit-input');"
        " return { v: i ? i.value : null }; })()",
        lambda d: d["v"] is not None,
        timeout=10,
    )["v"]


TEXTS = (
    "(() => { const s = document.querySelector('.mermaid .mermaid-preview svg');"
    " return { texts: s"
    " ? [...s.querySelectorAll('text, .nodeLabel')].map((e) => e.textContent.trim())"
    " .filter(Boolean) : [] }; })()"
)


def _wait_text(win, wanted, timeout=15):
    return _wait(
        win,
        TEXTS,
        lambda d: all(w in d["texts"] for w in wanted),
        timeout=timeout,
    )["texts"]


def _pointer_drag(win, card, section):
    """Drag kanban card ``card`` onto section ``section`` with real pointer events."""
    out = _dump(
        win,
        f"""(() => {{
          const cards = [...document.querySelectorAll('.mermaid .items > g.node')];
          const sections = [...document.querySelectorAll('.mermaid .sections > g')];
          const card = cards[{card}];
          const section = sections[{section}];
          if (!card || !section) return {{ missing: true }};
          const cr = card.getBoundingClientRect();
          const sr = (section.querySelector('rect') || section).getBoundingClientRect();
          const from = {{ x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 }};
          const to = {{ x: sr.left + sr.width / 2, y: sr.top + 30 }};
          const send = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {{
            bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse',
            isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
          }}));
          send(card, 'pointerdown', from.x, from.y);
          for (let i = 1; i <= 8; i++) {{
            send(window, 'pointermove',
                 from.x + (to.x - from.x) * i / 8,
                 from.y + (to.y - from.y) * i / 8);
          }}
          const clone = document.querySelector('.mermaid-drag-card') !== null;
          send(window, 'pointerup', to.x, to.y);
          return {{ clone, from, to }};
        }})()""",
    )
    assert not out.get("missing"), "kanban card or section missing"
    return out


EDIT_STATE = (
    "(() => ({ editing: !!document.querySelector('.mermaid-editing'),"
    " marked: document.querySelectorAll('.mermaid-editables').length,"
    " button: (document.querySelector('.mermaid-edit-toggle') || {}).textContent }))()"
)

COLUMNS = (
    "(() => { const cols = {};"
    " for (const c of document.querySelectorAll('.mermaid .items > g.node')) {"
    "   const x = Math.round(c.getBoundingClientRect().left / 100) * 100;"
    "   (cols[x] = cols[x] || []).push(c.textContent.trim());"
    " } return { cols }; })()"
)
