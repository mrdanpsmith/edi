"""Shared WebEngine helpers for the real-engine mermaid tests.

Every ``MainWindow`` is a WebEngine page, and a small container can only bring a
couple of them up: the template sweep and the visual editing tests therefore
share this code and pass the window in. Nothing here collects tests itself.
"""

import json
import time

import pytest

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
# A board with an empty middle column: mermaid still draws it, as a shorter
# band sized to its header, which is what gives a per-column ＋ somewhere to go.
KANBAN_EMPTY = "kanban\n  Todo\n    id1[One]\n  Doing\n  Done\n    id2[Two]"
# A document that is nothing but a board, the shape that leaves the scroller's
# own white space under it: the editor's box ends with the diagram, so a double
# click below the board is a click on the scroller, not on the editor.
KANBAN_LONE = (
    "kanban\n  col1[Todo]\n  col2[In Progress]\n  col3[Done]\n"
    "    [hi]\n    [how]\n    [are]\n    [you?]"
)
# A hand-written board whose titles hold the delimiters a bare `[…]` cannot
# carry, plus one bare card (`Plain`) for the other direction. Mermaid draws a
# quoted label as the text inside the quotes, so nothing here shows a quote, and
# the app quotes a title like these itself when it writes one back out.
KANBAN_QUOTED = (
    "kanban\n  col1[Todo]\n    [\"Fix (the bug)\"]\n"
    "  col2[\"Doing (now)\"]\n    id2[Plain]\n  col3[Done]"
)
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


def _press_enter(win, value):
    """Type a value into the open label editor and press Enter, without waiting
    for the editor to close: a value the grammar cannot carry is refused *in
    place*, so the input is still there afterwards and the caller asserts that."""
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
    return typed


def _type_and_confirm(win, value, timeout=15):
    _press_enter(win, value)
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


def _pointer_drag(win, card, section, aim=None):
    """Drag kanban card ``card`` onto section ``section`` with real pointer events.

    ``aim`` picks the slot the pointer is released over. The default is the top
    of the band, i.e. the first slot; ``"last"`` is just below the middle of the
    column's last card, i.e. the last slot — which is the one that moves a card
    within its own column, since a drop above the first card is no move at all.

    Reports what the drag looked like *mid-flight*, before the release, since the
    whole point of it is the preview: a clone must not exist, the real card must
    be under the pointer, and the drop line must sit in the target column.
    """
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
          // A slot is where the pointer is released, so it is aimed inside the
          // board rather than at a band edge: the ＋ owns the bottom of a band.
          const resting = cards.filter((c) => {{
            const r = c.getBoundingClientRect();
            return r.left >= sr.left - 1 && r.right <= sr.right + 1;
          }});
          const last = resting.length ? resting[resting.length - 1].getBoundingClientRect() : null;
          const aimY = {json.dumps(aim)} === 'last' && last
            ? last.top + last.height / 2 + 6
            : sr.top + 30;
          const to = {{ x: sr.left + sr.width / 2, y: aimY }};
          const send = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {{
            bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse',
            isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
          }}));
          send(card, 'pointerdown', from.x, from.y);
          const centre = () => {{
            const r = card.getBoundingClientRect();
            return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }};
          }};
          let half = null;
          for (let i = 1; i <= 8; i++) {{
            send(window, 'pointermove',
                 from.x + (to.x - from.x) * i / 8,
                 from.y + (to.y - from.y) * i / 8);
            if (i === 4) half = {{ at: centre(), pointer: {{ x: from.x + (to.x - from.x) * 4 / 8,
                                                           y: from.y + (to.y - from.y) * 4 / 8 }} }};
          }}
          // Read the preview before the release takes it away.
          const preview = card.closest('.mermaid-preview');
          const svg = preview.querySelector('svg');
          const line = document.querySelector('.mermaid .kanban-drop-line');
          const end = centre();
          // What is painted on top where the user is looking. Both the card and
          // the line are deliberately pointer-transparent, so each is made
          // hit-testable for the probe: what answers at those pixels is the
          // top of the paint order, which is the only thing a screenshot of a
          // just-mutated DOM cannot be trusted to tell us.
          const inside = (node) => {{
            for (let n = node; n && n !== document; n = n.parentNode) if (n === card) return true;
            return false;
          }};
          const atPointer = (() => {{
            card.style.pointerEvents = 'auto';
            const hit = document.elementFromPoint(to.x, to.y);
            card.style.pointerEvents = '';
            return inside(hit);
          }})();
          // What answers along the line's own pixels. The line sits inside the
          // svg ahead of the cards, so it is over the column's own background
          // but under every card — and under the ＋, which is a positioned
          // sibling of the svg and so paints over the whole drawing, narrow as
          // it is. Sampled rather than probed once, because whether any one
          // point is covered depends on where the drag happened to be.
          const overLine = (() => {{
            if (!line) return null;
            const r = line.getBoundingClientRect();
            const y = r.top + r.height / 2;
            const answers = [];
            line.style.pointerEvents = 'auto';
            for (let i = 0; i <= 10; i++) {{
              const hit = document.elementFromPoint(r.left + r.width * i / 10, y);
              if (hit === line) answers.push('line');
              else if (inside(hit)) answers.push('card');
              else if (hit) answers.push((hit.getAttribute && hit.getAttribute('class')) || hit.tagName);
              else answers.push('null');
            }}
            line.style.pointerEvents = '';
            return [...new Set(answers)];
          }})();
          const mid = {{
            clone: document.querySelector('.mermaid-drag-card') !== null,
            lifted: card.classList.contains('kanban-dragging-card'),
            last: card.parentElement.lastElementChild === card,
            atPointer,
            overLine,
            // Tracking, measured as a delta between two points of the drag: the
            // grab offset and the lift's scaling are both constant across the
            // drag, so a card under the pointer moves exactly as the pointer
            // does, whatever the board is scaled to.
            travel: {{ dx: end.x - half.at.x, dy: end.y - half.at.y,
                       px: to.x - half.pointer.x, py: to.y - half.pointer.y }},
            target: sections[{section}].classList.contains('kanban-drop-target'),
            // Read the line as it is drawn, in the same viewport space as the
            // band, so this is about what the user sees and not about the
            // inline style that put it there.
            line: line ? {{
              x: line.getBoundingClientRect().left,
              y: line.getBoundingClientRect().top + line.getBoundingClientRect().height / 2,
              w: line.getBoundingClientRect().width,
              shown: line.style.display !== 'none',
            }} : null,
            // An svg child ahead of the cards is what puts the line under them;
            // a positioned overlay in the preview could not, since it paints
            // above the whole drawing.
            lineUnder: line
              ? line.parentElement === svg
                && line.nextElementSibling === svg.querySelector('.items')
              : null,
            // A card that travels off the board is clipped by both of these
            // unless the drag switches them off, and then it would vanish
            // under the pointer instead of following it.
            unclipped: getComputedStyle(svg).overflow === 'visible'
              && getComputedStyle(preview).overflow === 'visible',
            scrolled: preview.scrollWidth > preview.clientWidth + 1,
          }};
          send(window, 'pointerup', to.x, to.y);
          return {{ mid, from, to, sr: {{ x: sr.left, y: sr.top, w: sr.width, h: sr.height }} }};
        }})()""",
    )
    assert not out.get("missing"), "kanban card or section missing"
    return out


EDIT_STATE = (
    "(() => ({ editing: !!document.querySelector('.mermaid-editing'),"
    " marked: document.querySelectorAll('.mermaid-editables').length,"
    " button: (document.querySelector('.mermaid-edit-toggle') || {}).textContent }))()"
)

# The per-column ＋, with the band it belongs to: a button is only ever offered
# while it is centred in its own column and sits in the bottom of it, so both
# boxes are what a zoom (which rescales the section rects) has to keep agreeing
# with.
KANBAN_ADDS = (
    "(() => { const buttons = [...document.querySelectorAll('.mermaid .mermaid-kanban-add')];"
    " const sections = [...document.querySelectorAll('.mermaid .sections > g')];"
    " return { n: buttons.length, adds: buttons.map((el, i) => {"
    "   const b = el.getBoundingClientRect();"
    "   const s = sections[i] ? (sections[i].querySelector('rect') || sections[i])"
    "     .getBoundingClientRect() : null;"
    "   return { label: el.getAttribute('aria-label'),"
    "     x: b.left + b.width / 2, y: b.top + b.height / 2,"
    "     band: s ? { x: s.left + s.width / 2, top: s.top, bottom: s.bottom,"
    "       width: s.width, height: s.height } : null }; }) }; })()"
)


def _click_kanban_add(win, index):
    """Press the ＋ of column ``index`` the way a mouse does, and report what the
    editor it opened says it is about to create."""
    out = _dump(
        win,
        f"""(() => {{
          const b = document.querySelectorAll('.mermaid .mermaid-kanban-add')[{index}];
          if (!b) return {{ missing: true }};
          const r = b.getBoundingClientRect();
          const opts = {{ bubbles: true, button: 0, clientX: r.left + r.width / 2,
                         clientY: r.top + r.height / 2 }};
          for (const type of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(type, opts));
          return {{ label: b.getAttribute('aria-label') }};
        }})()""",
    )
    assert not out.get("missing"), "the column had no ＋"
    return _wait(
        win,
        "(() => { const i = document.querySelector('.mermaid-edit-input');"
        " return { v: i ? i.value : null, ph: i ? i.placeholder : null }; })()",
        lambda d: d["v"] is not None,
        timeout=10,
    )


def _dblclick_below_document(win):
    """Double-click the white space the editor's own box does not reach.

    A document of one short diagram ends the ProseMirror box just under it, and
    everything below that is the scroller's background — a click there is a click
    on the scroller, which is why a listener on ``view.dom`` never sees it and
    the browser goes on to select the nearest text on the page (the document
    name in the status bar). Reports the element the point really lands on, so a
    test can show the click was outside the editor rather than assume it.
    """
    out = _dump(
        win,
        """(() => {
          const pm = document.querySelector('.ProseMirror');
          const box = pm.parentElement;
          if (!pm || !box) return { missing: true };
          const pmRect = pm.getBoundingClientRect();
          const boxRect = box.getBoundingClientRect();
          // Far enough under the board to be past the editor's box, and never
          // so far that it leaves the scroller.
          const y = Math.min(pmRect.bottom + 24, boxRect.bottom - 8);
          const x = boxRect.left + boxRect.width / 2;
          const el = document.elementFromPoint(x, y);
          const opts = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
          for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
            (el || document.body).dispatchEvent(new MouseEvent(type, opts));
          }
          return {
            y: Math.round(y), inEditor: !!(el && el.closest && el.closest('.ProseMirror')),
            on: el ? (el.id || el.className || el.tagName) : null,
            selected: String(window.getSelection()),
          };
        })()""",
    )
    assert not out.get("missing"), "the editor or its scroller is missing"
    return out


def _zoom(win, label):
    """Press one of the hover toolbar's zoom buttons ('+', '−' or '100%')."""
    out = _dump(
        win,
        f"""(() => {{
          const bar = document.querySelector('.mermaid-toolbar');
          const b = bar && [...bar.querySelectorAll('button')]
            .find((x) => x.textContent === {json.dumps(label)});
          if (!b) return {{ missing: true }};
          b.click();
          return {{ pressed: true }};
        }})()""",
    )
    assert not out.get("missing"), f"no {label!r} zoom button"


COLUMNS = (
    "(() => { const cols = {};"
    " for (const c of document.querySelectorAll('.mermaid .items > g.node')) {"
    "   const x = Math.round(c.getBoundingClientRect().left / 100) * 100;"
    "   (cols[x] = cols[x] || []).push(c.textContent.trim());"
    " } return { cols }; })()"
)

# One entry per column band, as mermaid draws it: the header plus whatever cards
# are in it. Reading the band rather than a card is what makes this work for an
# empty column, which has no card at all to find.
SECTIONS = (
    "(() => { const out = [];"
    " for (const g of document.querySelectorAll('.mermaid .sections > g')) {"
    "   out.push((g.textContent || '').replace(/\\s+/g, ' ').trim()); }"
    " return { n: out.length, sections: out }; })()"
)

# The cards and the column bands in one read, so a card can be matched to the
# column it landed in by position. Mermaid draws the cards in a layer of its own
# (``g.items``), outside the section frames, so the two have to be joined here.
CARDS_AND_BANDS = (
    "(() => {"
    " const cards = [...document.querySelectorAll('.mermaid .items > g.node')]"
    "   .map((c) => ({ text: (c.textContent || '').trim(),"
    "     x: c.getBoundingClientRect().left }));"
    " const bands = [...document.querySelectorAll('.mermaid .sections > g')]"
    "   .map((g) => { const r = (g.querySelector('rect') || g).getBoundingClientRect();"
    "     return r.left + r.width / 2; });"
    " return { cards, bands }; })()"
)

# The new-board dialog, the way the keyboard and the button reach it: the field
# holds one column per line and Add is the primary action.
BOARD_DIALOG = (
    "(() => { const f = document.querySelector('.edi-dialog-input');"
    " const add = document.querySelector('.toolbar-primary');"
    " return { present: !!f, title: (document.querySelector('.edi-dialog-title') || {}).textContent,"
    "   columns: f ? f.value.split('\\n') : [], canAdd: !!add }; })()"
)

# The mermaid sources the document actually holds — the only statement that a
# board round-trips through the editor rather than just rendering. Read off the
# ProseMirror doc, not the DOM: a diagram in view mode is an <svg>, not its text.
DOC_SOURCE = (
    "(() => { const out = [];"
    " const walk = (n) => { if (n.type && n.type.name === 'mermaid_block')"
    "   out.push(n.attrs.value); n.forEach(walk); };"
    " const root = document.querySelector('.ProseMirror');"
    " if (root && root.pmViewDesc && root.pmViewDesc.node) walk(root.pmViewDesc.node);"
    " return { n: out.length, sources: out }; })()"
)


def _set_document(win, markdown="", expect_text=""):
    """Replace the whole document and wait for the editor to actually show it.

    ``expect_text`` is text the editor must be showing: waiting on the block
    count alone would settle immediately on a text-only document, and a command
    fired before the swap lands has no editor to act on. An empty document is not
    an option here for the same reason — empty markdown arriving with no session
    is the home screen, not a document.
    """
    _dump(win, f"(() => {{ window.ediSetContent({json.dumps(markdown)}); return {{ set: true }}; }})()")
    blocks = markdown.count("```mermaid")
    _wait(
        win,
        "(() => { const r = document.querySelector('.ProseMirror');"
        " return { blocks: document.querySelectorAll('.mermaid').length,"
        "   text: r ? r.textContent : null }; })()",
        lambda d: d["blocks"] == blocks and expect_text in (d["text"] or ""),
        timeout=10,
    )


def _why_no_dialog(win):
    """What the page looks like when the command produced no dialog."""
    return "no board dialog: " + json.dumps(
        _dump(
            win,
            "(() => ({ overlay: document.querySelectorAll('.edi-dialog-overlay').length,"
            "  view: (document.querySelector('#app')||{}).dataset"
            "   ? document.querySelector('#app').dataset.view : null,"
            "  pm: !!document.querySelector('.ProseMirror'),"
            "  blocks: document.querySelectorAll('.block-visual-mode').length,"
            "  cmd: typeof window.ediMenuCommand }))()",
        )
    )


def _open_board_dialog(win, columns=None, timeout=10):
    """Run the Insert > Kanban board command, and fill the dialog in when
    ``columns`` is given (otherwise leave it open, for a cancel)."""
    out = _dump(
        win,
        "(() => { window.ediMenuCommand('insertKanban'); return { started: true }; })()",
    )
    assert out["started"], "the menu command did not run"
    try:
        _wait(win, BOARD_DIALOG, lambda d: d["present"] and d["canAdd"], timeout=timeout)
    except AssertionError as exc:
        pytest.fail(f"{exc} ({_why_no_dialog(win)})")
    if columns is None:
        return
    _dump(
        win,
        "(() => { const f = document.querySelector('.edi-dialog-input');"
        f" f.value = {json.dumps(chr(10).join(columns))};"
        " document.querySelector('.toolbar-primary').click(); return { sent: true }; })()",
    )


def _cancel_board_dialog(win):
    """Dismiss the dialog the way Escape does."""
    _dump(
        win,
        "(() => { const f = document.querySelector('.edi-dialog-input');"
        " f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));"
        " return { cancelled: true }; })()",
    )

