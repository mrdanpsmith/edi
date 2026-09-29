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
    """Run ``script`` in the page and read its value back.

    Every probe here must therefore evaluate to an *object*: a bare array comes
    back as an empty string rather than as JSON, and a probe that returns one
    fails as a `JSONDecodeError` about a value the reader never saw.
    """
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
# A board of exactly one column: the shape that cannot be deleted at all, so the
# delete is not offered. KANBAN_LONE below is a different thing (one column of
# cards among three), which is why this one is spelled out rather than reused.
KANBAN_ONE = "kanban\n  col1[Review]\n    id1[Ship it]"
KANBAN_LONE = (
    "kanban\n  col1[Todo]\n  col2[In Progress]\n  col3[Done]\n"
    "    [hi]\n    [how]\n    [are]\n    [you?]"
)
# A board of four empty columns, the shape every one of the three reports was
# about: every band is sized to its header alone, so the space a bar, a composer
# or a new column needs is not there until something makes room.
KANBAN_BARE = (
    "kanban\n  col1[Todo]\n  col2[In progress]\n  col3[Review]\n  col4[Done]"
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


def _press_key(win, key, shift=False):
    """Press a key in the open field and leave it open, with modifiers.

    What is observable is the field's *reaction* — still open, value unchanged, no
    commit — which is the whole of a refused keystroke. A synthetic keydown cannot
    insert a character, so this is not a claim about the browser's own editing; it
    is a claim about what the editor did with the key.
    """
    out = _dump(
        win,
        f"""(() => {{
          const i = document.querySelector('.mermaid-edit-input');
          if (!i) return {{ missing: true }};
          i.dispatchEvent(new KeyboardEvent('keydown', {{
            key: {json.dumps(key)}, shiftKey: {json.dumps(bool(shift))},
            bubbles: true, cancelable: true,
          }}));
          return {{ value: i.value }};
        }})()""",
    )
    assert not out.get("missing"), "no field was open"
    return out


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
  "  noticeText: (document.querySelector('.mermaid-edit-notice') || {}).textContent || '',"
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
    and return the value the editor seeded, or ``None`` when no field opened.
    The seeded value is the source spelling, which is not always the rendered text
    (a sankey node shares its element with a generated value, a requirement row is
    drawn under mermaid's own idea of the key), and it can be **empty**: the label
    on a drawn slot is a placeholder to be typed over, so it is written in a field
    with nothing in it. Callers must compare against ``None``, not test the value
    for truth. When the caller passes ``anchor``, the field is read together with
    whatever it was opened from, in one snapshot.
    """
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
          // A gap is where the pointer is released, so it is aimed inside the
          // board rather than at a band edge. The drawn slot at the foot of the
          // column is not one of the column's cards, so the last gap is the one
          // below its last *card* rather than the one below the slot.
          const resting = cards.filter((c) => {{
            if (c.classList.contains('mermaid-kanban-slot')) return false;
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


def _pointer_drag_column(win, column, slot):
    """Drag kanban column ``column`` to final index ``slot`` with real pointer events.

    The mirror of :func:`_pointer_drag`: where a card lands in a slot inside a
    column, a column lands in a *gap* between two columns, so the indicator is a
    full-height vertical rule and the release point is a horizontal position.

    Reports what the drag looked like mid-flight, before the release, since the
    whole point of it is the preview: no clone, the real frame and its cards
    lifted together, and the rule in the gap the release will act on.
    """
    out = _dump(
        win,
        f"""(() => {{
          const cards = [...document.querySelectorAll('.mermaid .items > g.node')];
          const sections = [...document.querySelectorAll('.mermaid .sections > g')];
          const section = sections[{column}];
          if (!section) return {{ missing: true }};
          const frame = section.querySelector('rect') || section;
          const sr = frame.getBoundingClientRect();
          const box = (r) => ({{ left: r.left, right: r.right, top: r.top, bottom: r.bottom }});
          const inside = (r, x, y) => x >= r.left - 1 && x <= r.right + 1
            && y >= r.top - 1 && y <= r.bottom + 1;
          // A grab point is a piece of the frame that is neither one of its cards
          // nor its header label: mermaid's cards are ~15px narrower than the
          // band, so the strip down its left edge belongs to the column alone.
          const label = section.querySelector('.cluster-label, .cluster-title');
          const labelRect = label ? label.getBoundingClientRect() : null;
          let from = null;
          outer:
          for (let dy of [0, -12, 12, -24, 24]) {{
            for (let dx = 3; dx <= 14; dx += 2) {{
              const x = sr.left + dx;
              const y = (sr.top + sr.bottom) / 2 + dy;
              if (y < sr.top + 2 || y > sr.bottom - 2) continue;
              if (cards.some((c) => inside(c.getBoundingClientRect(), x, y))) continue;
              if (labelRect && inside(labelRect, x, y)) continue;
              from = {{ x, y }};
              break outer;
            }}
          }}
          if (!from) return {{ missing: 'no-frame' }};
          // Aim past the right edge of the board for the last slot, into the gap
          // for any other: the release reads the pointer's x, not a section. The
          // drawn column at the end is a place rather than a column, so a gap is
          // counted between the real ones and the aim means what it meant before
          // the board was drawn with it.
          const others = sections.flatMap((s, i) => (i === {column}
            || s.classList.contains('mermaid-kanban-column-slot') ? []
            : [box(s.getBoundingClientRect())]));
          const to = {{ x: {slot} >= others.length
              ? Math.max(...others.map((r) => r.right)) + 24
              : (others[{slot} - 1].right + others[{slot}].left) / 2,
            y: sr.top + 12 }};
          const send = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, {{
            bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse',
            isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y,
          }}));
          const mine = cards.filter((c) => {{
            const r = c.getBoundingClientRect();
            return r.left >= sr.left - 1 && r.right <= sr.right + 1;
          }});
          send(section, 'pointerdown', from.x, from.y);
          const at = () => frame.getBoundingClientRect();
          let half = null;
          for (let i = 1; i <= 8; i++) {{
            send(window, 'pointermove',
                 from.x + (to.x - from.x) * i / 8,
                 from.y + (to.y - from.y) * i / 8);
            if (i === 4) half = {{ left: at().left, top: at().top,
                                    cards: mine.map((c) => {{ const r = c.getBoundingClientRect();
                                                               return {{ left: r.left, top: r.top }}; }}) }};
          }}
          const preview = section.closest('.mermaid-preview');
          const svg = preview.querySelector('svg');
          const line = document.querySelector('.mermaid .kanban-drop-line');
          // Where every card of the column is, as a delta from halfway through
          // the drag. Read from the rendered rect, not from the transform: the
          // transform is mermaid's own position *plus* the drag, and the card it
          // is carried by is what has to track the pointer.
          const cardMoved = mine.map((c, i) => {{
            const r = c.getBoundingClientRect();
            const h = half.cards[i];
            return {{ dx: r.left - h.left, dy: r.top - h.top }};
          }});
          const lineRect = line ? line.getBoundingClientRect() : null;
          const overLine = (() => {{
            if (!lineRect || !line) return null;
            const answers = [];
            line.style.pointerEvents = 'auto';
            for (let i = 0; i <= 10; i++) {{
              const hit = document.elementFromPoint(lineRect.left + lineRect.width / 2,
                                                    lineRect.top + lineRect.height * i / 10);
              answers.push(hit === line ? 'line'
                : (hit && hit.getAttribute && hit.getAttribute('class')) || (hit && hit.tagName) || 'null');
            }}
            line.style.pointerEvents = '';
            return [...new Set(answers)];
          }})();
          const mid = {{
            clone: document.querySelector('.mermaid-drag-card') !== null,
            lifted: section.classList.contains('kanban-dragging-column'),
            // One class for the whole unit: the cards are carried, not pointed
            // at, so they are part of what is lifted rather than a drag of their own.
            cardsLifted: mine.every((c) => c.classList.contains('kanban-dragging-column')),
            // Paint order: svg paints in document order, so a frame left in its
            // place is drawn under every column it is passing over. The cards are
            // re-appended as a block, so it is the *set* that has moved to the end
            // of `.items` — they travel together and never overlap each other.
            // Where the held unit *is*, which for a column is a group of its
            // own rather than a place in either of mermaid's two lists: the board
            // is drawn as the frames in `.sections` and then the cards in
            // `.items`, so every card is painted over every frame, and a frame
            // re-appended to the end of `.sections` is over the other frames and
            // nothing else. The group is the last child of the svg, so it is over
            // the whole board, and it holds the frame first and then the cards
            // the frame carries -- the order the board is itself drawn in.
            heldInGroup: (() => {{
              const group = svg.querySelector('.kanban-drag-layer');
              if (!group || group !== svg.lastElementChild) return false;
              const kids = [...group.children];
              return kids[0] === section && kids.length === mine.length + 1
                && kids.slice(1).every((el, i) => el === mine[i]);
            }})(),
            // And the question that is actually about paint: is anything on the
            // board drawn over the held column? A neighbour's cards on top of the
            // column passing over them read as cards it picked up, so this is
            // sampled where the held frame and another column's card overlap, and
            // asks what is on top *there*. A held card is `pointer-events: none`
            // so the drop is read off the pointer and not off what it passes
            // over -- which also makes it invisible to a hit test, so the group is
            // made hittable for the sample and put straight back. (A screenshot
            // would not do: the DOM under the offscreen platform is a frame
            // behind.)
            fronted: (() => {{
              const group = svg.querySelector('.kanban-drag-layer');
              if (!group) return null;
              const a = frame.getBoundingClientRect();
              // The card the held column is passing *over* -- not merely the first
              // one left on the board, which is beside it and answers nothing.
              // Nothing to compare against is a real answer too: a column released
              // past the last one overlaps no card, and there is nothing to be in
              // front of.
              const over = cards
                .filter((c) => !group.contains(c))
                .map((c) => ({{ c, b: c.getBoundingClientRect() }}))
                .find(({{ b }}) => Math.max(a.left, b.left) < Math.min(a.right, b.right)
                  && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom));
              if (!over) return null;
              const left = Math.max(a.left, over.b.left);
              const right = Math.min(a.right, over.b.right);
              const top = Math.max(a.top, over.b.top);
              const bottom = Math.min(a.bottom, over.b.bottom);
              const kids = [...group.children];
              for (const el of kids) el.style.pointerEvents = 'auto';
              const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
              for (const el of kids) el.style.pointerEvents = '';
              return {{ under: (over.c.textContent || '').trim(),
                        hit: hit ? (hit.getAttribute && hit.getAttribute('class')) || hit.tagName : 'null',
                        held: !!hit && group.contains(hit) }};
            }})(),
            // Tracking, as a delta between two points of the drag: the grab offset
            // is constant, so what is held moves with the pointer by the pointer's
            // own distance, whatever the board is scaled to.
            travel: {{ dx: at().left - half.left, dy: at().top - half.top,
                       px: to.x - (from.x + (to.x - from.x) * 4 / 8),
                       py: to.y - (from.y + (to.y - from.y) * 4 / 8) }},
            cardMoved,
            line: lineRect ? {{ x: lineRect.left, y: lineRect.top,
                                w: lineRect.width, h: lineRect.height,
                                shown: line.style.display !== 'none' }} : null,
            // `.sections` comes before `.items`, so a line in front of both
            // draws across the column it is previewing. It goes in front of the
            // frames and behind everything else.
            lineUnder: line ? line.parentElement === svg
              && line.nextElementSibling === svg.querySelector('.sections') : null,
            // A column is a frame with a padding and cards inside it, so a lift
            // that grows it — a `scale` about the frame's own origin, which is
            // where an svg transform scales — pushes the cards out through the
            // bottom and drops the ones outside the section as well. Held means
            // moved, and the frame is the same size it was.
            rigid: Math.abs(at().width - sr.width) < 0.5 && Math.abs(at().height - sr.height) < 0.5,
            overLine,
            unclipped: getComputedStyle(svg).overflow === 'visible'
              && getComputedStyle(preview).overflow === 'visible',
            sr: {{ x: sr.left, y: sr.top, w: sr.width, h: sr.height }},
          }};
          send(window, 'pointerup', to.x, to.y);
          return {{ mid, from, to }};
        }})()""",
    )
    assert out.get("missing") is None, f"no column to grab: {out.get('missing')}"
    return out


EDIT_STATE = (
    "(() => ({ editing: !!document.querySelector('.mermaid-editing'),"
    " marked: document.querySelectorAll('.mermaid-editables').length,"
    " button: (document.querySelector('.mermaid-edit-toggle') || {}).textContent }))()"
)

# The words the drawn slots are written with, which are the editor's own: a card
# slot reads "+ Add a card" and the column at the end of the board reads
# "+ Add a column", so a test can tell a slot from a card by its own text.
KANBAN_CARD_SLOT = "+ Add a card"
KANBAN_COLUMN_SLOT = "+ Add a column"

# The drawn slots, with the band each belongs to: a card slot *is* the drawing, so
# a zoom that rescales the section rects has to keep the two agreeing.
KANBAN_SLOTS = (
    "(() => { const box = (el) => { const r = el.getBoundingClientRect();"
    "   return { x: r.left + r.width / 2, y: r.top + r.height / 2,"
    "     left: r.left, right: r.right, top: r.top, bottom: r.bottom,"
    "     width: r.width, height: r.height }; };"
    " const cards = [...document.querySelectorAll('.mermaid .items > g.node.mermaid-kanban-slot')];"
    " const column = document.querySelector('.mermaid .sections > g.mermaid-kanban-column-slot');"
    " return { cards: cards.map((el) => ({ text: (el.textContent || '').trim(), box: box(el) })),"
    "   column: column ? { text: (column.textContent || '').replace(/\\s+/g, ' ').trim(),"
    "     box: box(column.querySelector('rect') || column) } : null }; })()"
)


# The board's chrome, read the way a user meets it: a quiet `⋯` per real column,
# and a `✕` that is only there for the card under the pointer. Adding is not in
# the list: the board is *drawn* with somewhere to add, so the slots
# (`KANBAN_SLOTS`) are the rest of it.
KANBAN_CHROME = (
    "(() => { const box = (el) => { const r = el.getBoundingClientRect();"
    "   return { x: r.left + r.width / 2, y: r.top + r.height / 2,"
    "     left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };"
    " const cards = [...document.querySelectorAll('.mermaid .items > g.node')]"
    "   .map((c) => ({ text: (c.textContent || '').trim(), box: box(c) }));"
    " const bands = [...document.querySelectorAll('.mermaid .sections > g')]"
    "   .map((g) => ({ text: (g.textContent || '').replace(/\\s+/g, ' ').trim(),"
    "     box: box(g.querySelector('rect') || g),"
    # The column's own name, which sits in the top of its band and is what a
    # click there renames — so nothing else may be laid over it.
    "     name: (() => { const l = g.querySelector('.cluster-label, .cluster-title');"
    "       return l ? box(l) : null; })() }));"
    " const shown = (el) => el.classList.contains('is-shown');"
    " const buttons = [...document.querySelectorAll('.mermaid .mermaid-kanban-btn')].map((el) => ({"
    "   kind: [...el.classList].find((c) => c.startsWith('mermaid-kanban-')"
    "     && !c.endsWith('btn')) || '',"
    "   label: el.getAttribute('aria-label'), text: (el.textContent || '').trim(),"
    "   visible: getComputedStyle(el).opacity !== '0', shown: shown(el),"
    "   clickable: getComputedStyle(el).pointerEvents !== 'none', box: box(el) }));"
    " return { cards, bands, buttons }; })()"
)

# Only the controls the pointer has revealed, by label: the whole point of the
# hover is that the rest are *not* there, so a test that read the full inventory
# would be asserting the set rather than the reveal.
KANBAN_SHOWN = (
    "(() => ({ shown: [...document.querySelectorAll('.mermaid .mermaid-kanban-btn.is-shown')]"
    " .map((el) => ({ kind: [...el.classList].find((c) => c.startsWith('mermaid-kanban-')"
    "     && !c.endsWith('btn')) || '', label: el.getAttribute('aria-label'),"
    # Revealed and pressable are two different things, and a control that is
    # only the first is a control that does nothing when you press it: the press
    # falls through to the diagram underneath.
    "     clickable: getComputedStyle(el).pointerEvents !== 'none' })) }))()"
)

# The open `⋯` menu, with its items: the whole of a column's own actions, which
# used to be two floating marks in its header.
KANBAN_MENU = (
    "(() => { const d = document.querySelector('.mermaid .mermaid-kanban-menu-list');"
    " const b = d ? [...d.querySelectorAll('.mermaid-kanban-menu-item')] : [];"
    " const r = d ? d.getBoundingClientRect() : null;"
    " return { open: !!d, label: d ? d.getAttribute('aria-label') : null,"
    "   items: b.map((x) => { const r = x.getBoundingClientRect();"
    "     return { text: (x.textContent || '').trim(),"
    "       danger: x.classList.contains('is-danger'),"
    "       focused: x === document.activeElement,"
    # An item is bounded by the popover, not by its own words: the width is
    # fixed and the text wraps inside it, because a label this app does not
    # write yet (a translation) must not be able to widen the menu.
    "       wrap: getComputedStyle(x).whiteSpace,"
    "       box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }; }),"
    "   box: r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null }; })()"
)


def _hover(win, selector, index, timeout=10):
    """Move the pointer onto the ``index``-th ``selector`` element.

    A real `pointerover`, at the element's own centre: the chrome is revealed by
    where the pointer *is*, not by a class a test sets, so a test that skipped the
    gesture would be asserting nothing about what a user can see.
    """
    out = _dump(
        win,
        f"""(() => {{
          const el = document.querySelectorAll('.mermaid {selector}')[{index}];
          if (!el) return {{ missing: true }};
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          el.dispatchEvent(new PointerEvent('pointerover', {{
            bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse',
            isPrimary: true, button: 0, buttons: 0, clientX: x, clientY: y,
          }}));
          return {{ at: {{ x: Math.round(x), y: Math.round(y) }} }};
        }})()""",
    )
    assert not out.get("missing"), f"the board had no {selector}[{index}]"
    return out


def _shown(win):
    """The controls the pointer has revealed, and only those.

    A single read, not a wait: the reveal happens in the handler of the very event
    the hover dispatched, so there is nothing to wait for — and a wait here would
    be free to settle on the set from an earlier hover and pass for this one.
    """
    return _dump(win, KANBAN_SHOWN)["shown"]


def _unhover(win):
    """Take the pointer off the board, so the reveal is taken back."""
    return _dump(
        win,
        "(() => { const p = document.querySelector('.mermaid-preview');"
        " p.dispatchEvent(new PointerEvent('pointerleave'));"
        " return { left: true }; })()",
    )


def _open_kanban_menu(win, column):
    """Press the ``column``-th `⋯` and report the items of the menu it opened."""
    out = _dump(
        win,
        f"""(() => {{
          const b = document.querySelectorAll('.mermaid .mermaid-kanban-menu')[{column}];
          if (!b) return {{ missing: true }};
          const r = b.getBoundingClientRect();
          const opts = {{ bubbles: true, button: 0, clientX: r.left + r.width / 2,
                         clientY: r.top + r.height / 2 }};
          for (const type of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(type, opts));
          return {{ label: b.getAttribute('aria-label') }};
        }})()""",
    )
    assert not out.get("missing"), "the column had no ⋯"
    return _wait(win, KANBAN_MENU, lambda d: d["open"], timeout=10)


def _press_in_the_menu_gap(win):
    """Press in the gap between a `⋯` and the list it opened, and report the hit.

    The gap is a hole in a popover with the board visible through it, so it is the
    one place a pointer *aimed* at the menu lands on the board — and a press that
    reaches the board takes the menu away. The bridge is what closes the hole, and
    `elementFromPoint` is what says whether it did: a `::before` is not an
    element, so the hit test reports the list it belongs to.
    """
    out = _dump(
        win,
        """(() => {
          const list = document.querySelector('.mermaid .mermaid-kanban-menu-list');
          const button = document.querySelector('.mermaid .mermaid-kanban-menu');
          if (!list || !button) return { missing: true };
          const l = list.getBoundingClientRect(), b = button.getBoundingClientRect();
          const x = Math.round(l.right - 8), y = Math.round((b.bottom + l.top) / 2);
          const hit = document.elementFromPoint(x, y);
          if (hit) for (const type of ['pointerdown', 'mousedown']) {
            hit.dispatchEvent(new PointerEvent(type, {
              bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
              isPrimary: true, button: 0, clientX: x, clientY: y }));
          }
          return { x, y, gap: Math.round(l.top - b.bottom),
            hits: hit ? (hit.closest('.mermaid-kanban-menu-list') ? 'the menu'
              : (hit.getAttribute('class') || hit.tagName.toLowerCase())) : null,
            stillOpen: !!document.querySelector('.mermaid .mermaid-kanban-menu-list') };
        })()""",
    )
    assert not out.get("missing"), "no open menu to press the gap of"
    return out


def _click_kanban_menu_item(win, text):
    """Press the menu item that says ``text``, by its own label.

    The item, not the `⋯`: a menu item is a real control with a real name, and
    choosing it by what it says is the only way the test can tell a rename from a
    delete.
    """
    out = _dump(
        win,
        f"""(() => {{
          const item = [...document.querySelectorAll('.mermaid .mermaid-kanban-menu-item')]
            .find((x) => (x.textContent || '').trim() === {json.dumps(text)});
          if (!item) return {{ missing: true }};
          item.click();
          return {{ pressed: (item.textContent || '').trim() }};
        }})()""",
    )
    assert not out.get("missing"), f"the menu had no {text!r} item"
    return out


# The open inline field, with what it says it is for.
#
# ``anchor`` is a selector for the thing the field was opened from, read in the
# *same* snapshot as the field: a board re-renders and the page settles between
# two reads, so comparing a box taken before the press against one taken after it
# would be comparing two moments of the layout rather than two boxes. Callers
# assert ``field.box`` against ``field.anchor`` for that reason.
def _composer_js(anchor, expression=False):
    """The open field, read together with whatever it was opened from.

    ``anchor`` is a CSS selector, or — with ``expression`` — a JavaScript
    expression that evaluates to the element itself: an indexed pick for the
    drawn slots, which share one selector between them and are told apart by
    their order on the board.
    """
    raw = anchor if expression else json.dumps(anchor)
    return (
        "(() => { const i = document.querySelector('.mermaid-edit-input');"
        f" const raw = {raw};"
        " const a = raw && raw.nodeType ? raw"
        "   : (typeof raw === 'string' && raw ? document.querySelector(raw) : null);"
        " const box = (e) => { const r = e.getBoundingClientRect();"
        "   return { x: r.left + r.width / 2, y: r.top + r.height / 2,"
        "     top: r.top, left: r.left, right: r.right, bottom: r.bottom,"
        "     width: r.width, height: r.height }; };"
        " return { v: i ? i.value : null, ph: i ? i.placeholder : null,"
        "   wrap: i ? i.tagName === 'TEXTAREA' : null,"
        "   box: i ? box(i.closest('.mermaid-edit-field')) : null,"
        "   input: i ? box(i) : null,"
        "   anchor: a ? box(a) : null,"
        "   block: (() => { const b = document.querySelector('.mermaid');"
        "     return b ? box(b) : null; })() }; })()"
    )


def _composer(win, anchor=None, expression=False):
    """Wait for the inline field to open, and read it with its anchor.

    ``expression`` passes ``anchor`` to `_composer_js` as JavaScript rather than
    as a selector, which is how a slot that shares one selector with every other
    slot is told apart by its order on the board.
    """
    return _wait(
        win, _composer_js(anchor, expression), lambda d: d["v"] is not None, timeout=10
    )


# The open field and the block it is in, which is what "the editor is tall enough
# for this" is made of: a field is absolutely positioned, so the block around it
# is the only thing that can make room for one that is taller than its slot.
COMPOSER_FIT = (
    "(() => { const f = document.querySelector('.mermaid-edit-field');"
    " const b = document.querySelector('.mermaid');"
    " const box = (e) => { const r = e.getBoundingClientRect();"
    "   return { top: r.top, left: r.left, right: r.right, bottom: r.bottom,"
    "     width: r.width, height: r.height }; };"
    " const pad = b ? getComputedStyle(b).paddingBottom : null;"
    " return { box: f ? box(f) : null, block: b ? box(b) : null, pad: pad }; })()"
)

# The delete prompt, with its answer: the title names what goes and the note says
# what goes with it, so a click on the wrong ✕ is still catchable here.
DELETE_PROMPT = (
    "(() => { const d = document.querySelector('.edi-dialog');"
    " const buttons = d ? [...d.querySelectorAll('.edi-dialog-actions button')]"
    "   .map((b) => (b.textContent || '').trim()) : [];"
    " return { present: !!d, title: d ? (d.querySelector('.edi-dialog-title') || {}).textContent : null,"
    "   note: d ? (d.querySelector('.edi-dialog-note') || {}).textContent : null,"
    "   buttons, danger: !!(d && d.querySelector('.toolbar-danger')) }; })()"
)


def _resize_view(win, width, height=None):
    """Resize the page itself, the way dragging a window edge does."""
    win._web.resize(width, height or win._web.height())


def _click_kanban_button(win, kind, index, timeout=10):
    """Press the ``index``-th button of class ``kind`` the way a mouse does."""
    out = _dump(
        win,
        f"""(() => {{
          const b = document.querySelectorAll('.mermaid .{kind}')[{index}];
          if (!b) return {{ missing: true }};
          const r = b.getBoundingClientRect();
          const opts = {{ bubbles: true, button: 0, clientX: r.left + r.width / 2,
                         clientY: r.top + r.height / 2 }};
          for (const type of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(type, opts));
          return {{ label: b.getAttribute('aria-label') }};
        }})()""",
    )
    assert not out.get("missing"), f"the board had no {kind}"
    return out


def _answer_delete_prompt(win, answer, timeout=10):
    """Answer the delete prompt by pressing its own ``Cancel``/``Delete`` button.

    The button, not a synthetic Escape: a confirmation is a decision with two
    answers, and the two are deliberately not symmetric — one is inert and the
    other removes something.
    """
    _wait(win, DELETE_PROMPT, lambda d: d["present"], timeout=timeout)
    _dump(
        win,
        f"""(() => {{
          const b = [...document.querySelectorAll('.edi-dialog-actions button')]
            .find((x) => (x.textContent || '').trim() === {json.dumps(answer)});
          if (!b) return {{ missing: true }};
          b.click();
          return {{ answered: true }};
        }})()""",
    )


def _click_kanban_slot(win, index):
    """Click the ``index``-th drawn card slot the way a mouse does.

    A slot is part of the drawing rather than a control on top of it, so this one
    is a click *at* its centre with the hit test, not a dispatched event at the
    element: a slot nobody can reach is not a place to add a card. The field it
    opens is read in the same snapshot as the slot it came from, so the two boxes
    are one moment of the layout.
    """
    out = _dump(
        win,
        f"""(() => {{
          const b = document.querySelectorAll('.mermaid .items > g.node.mermaid-kanban-slot')[{index}];
          if (!b) return {{ missing: true }};
          const r = b.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const at = document.elementFromPoint(x, y);
          if (!at || !(at === b || b.contains(at))) return {{
            reached: false, hit: at ? (at.className || at.tagName) : null }};
          const opts = {{ bubbles: true, button: 0, clientX: x, clientY: y }};
          for (const type of ['mousedown', 'mouseup', 'click'])
            at.dispatchEvent(new MouseEvent(type, opts));
          return {{ reached: true, slot: {{ x, y }} }};
        }})()""",
    )
    assert not out.get("missing"), f"the board had no card slot[{index}]"
    assert out.get("reached"), f"the click inside card slot[{index}] reached {out}"
    # Read against the slot it came from, in the same snapshot: the board settles
    # between two reads, so two boxes read at two moments are two moments of the
    # layout rather than two boxes.
    anchor = (
        "document.querySelectorAll("
        f"'.mermaid .items > g.node.mermaid-kanban-slot')[{index}]"
    )
    return _wait(
        win,
        _composer_js(anchor, expression=True),
        lambda d: d["v"] is not None and d["anchor"] is not None,
        timeout=10,
    )


def _click_kanban_column_slot(win):
    """Click the drawn column the board would have next, and read the field its
    own header opened."""
    out = _dump(
        win,
        """(() => {
          const b = document.querySelector('.mermaid .sections > g.mermaid-kanban-column-slot');
          if (!b) return { missing: true };
          const r = (b.querySelector('rect') || b).getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + 12;
          const at = document.elementFromPoint(x, y);
          if (!at || !(at === b || b.contains(at))) return {
            reached: false, hit: at ? (at.className || at.tagName) : null };
          const opts = { bubbles: true, button: 0, clientX: x, clientY: y };
          for (const type of ['mousedown', 'mouseup', 'click'])
            at.dispatchEvent(new MouseEvent(type, opts));
          return { reached: true };
        })()""",
    )
    assert not out.get("missing"), "the board had no column slot"
    assert out.get("reached"), f"the click inside the column slot reached {out}"
    return _wait(win, _composer_js(None), lambda d: d["v"] is not None, timeout=10)


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

