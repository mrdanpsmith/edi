"""Audit every label the Mermaid editing layer offers, against real mermaid.

For each diagram in ``tests/fixtures/mermaid-templates.md`` this walks into edit
mode, inventories what got marked editable, then renames each of those labels
through the real gesture path (click, type, Enter) and classifies what the app
did. The invariant it checks is the one the UI promises:

* every label edit mode offers can be renamed, and the rewrite lands in the
  fenced source;
* nothing is offered that the source never spelled out (a computed treemap
  total, a default axis name, a ``<<stereotype>>``).

mermaid refuses some legal edits -- renaming an implicit git branch points at a
branch that was never declared, and a requirement row's value must stay inside
its enum -- and those count as ``refused``, not failures: the patch committed
and the app said so on the diagram. A silent no-op is a failure.

This needs a real ``dist/`` build and a second WebEngine page, so it is a tool
rather than a test: the cheap slice of the same invariant runs on every commit
in ``tests/test_window.py`` (``test_every_offered_label_rename_resolves``),
inside the session window, one rename per diagram.

Usage::

    npm run build
    .venv/bin/python scripts/mermaid-label-probe.py
    .venv/bin/python scripts/mermaid-label-probe.py --type erDiagram,kanban
    .venv/bin/python scripts/mermaid-label-probe.py --first

Exits non-zero when any offered label fails to resolve, or a diagram fails to
render at all.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import NoReturn

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
# Before PySide6: Qt has to know it is headless before the platform loads.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-dev-shm-usage --disable-gpu")

from PySide6.QtWidgets import QApplication  # noqa: E402

from backend.window import DIST_DIR, MainWindow  # noqa: E402
from tests.mermaid_render import (  # noqa: E402
    LABEL_INVENTORY,
    LABEL_STATE,
    _click_first_offered,
    _dump,
    _enter_edit_mode,
    _pump_until,
    _render,
    _type_and_confirm,
)

FIXTURES = ROOT / "tests/fixtures/mermaid-templates.md"
#: Appended to whatever the editor seeded: long enough to be its own value,
#: short enough to stay inside every family's identifier rules.
SUFFIX = "X"


def fail(message: str) -> NoReturn:
    print(f"mermaid-label-probe: {message}")
    raise SystemExit(2)


def diagram_type(body: str) -> str | None:
    """The diagram's keyword, skipping YAML frontmatter and ``%%`` comments.

    A few templates open with ``---`` / ``title: ...`` (packet, radar), so the
    keyword is the first bare word after that.
    """
    in_frontmatter = False
    for line in body.split("\n"):
        text = line.strip()
        if in_frontmatter:
            in_frontmatter = text != "---"
            continue
        if text == "---":
            in_frontmatter = True
            continue
        if not text or text.startswith("%%"):
            continue
        head = text.split()[0]
        if ":" not in head and re.fullmatch(r"[A-Za-z][\w-]*", head):
            return head
        return None
    return None


def diagram_sources(path: Path) -> dict[str, str]:
    """The first fenced mermaid block per diagram type, in file order."""
    sources: dict[str, str] = {}
    for block in re.findall(r"```mermaid\n(.*?)```", path.read_text(), re.S):
        body = block.strip("\n")
        kind = diagram_type(body)
        if kind:
            sources.setdefault(kind, body)
    return sources


def drawn(value: str, texts: list) -> bool:
    """Whether mermaid drew the committed value.

    Whitespace-insensitive: a long label comes back wrapped across ``tspan``s
    with its spaces dropped (``Lack of TrainingX`` renders as
    ``Lack ofTrainingX``), which is the same value drawn.
    """
    needle = "".join(value.split())
    return any(needle in "".join(text.split()) for text in texts)


def classify(value: str, state: dict) -> tuple[str, str]:
    """What the app did with one rename, and why, from what it shows after it."""
    shown = drawn(value, state.get("texts", []))
    committed = bool(state.get("source")) and value in state["source"]
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
    # either, and the report says so.
    return "rewritten", "mermaid re-read the value under its own grammar"


def wait_settled(win, value: str, timeout: float = 20) -> dict:
    """Poll until the rename has visibly landed, or the timeout runs out.

    Unlike the test helper this never raises: an outcome the tool has no bucket
    for is exactly what it is here to report.
    """
    seen: dict = {}

    def settled() -> bool:
        seen.update(_dump(win, LABEL_STATE))
        return (
            drawn(value, seen.get("texts", []))
            or seen.get("notice")
            or seen.get("error")
        )

    _pump_until(settled, timeout=timeout)
    return seen


def rename_label(win, index: int, label: str) -> dict:
    """Click the offered label at ``index``, append SUFFIX, and classify the result."""
    seeded = _click_first_offered(win, index=index)
    if not seeded:
        return {"text": label, "verdict": "failed", "why": "no editor opened"}
    value = seeded + SUFFIX
    try:
        _type_and_confirm(win, value)
    except AssertionError as exc:  # the input never closed: the editor is stuck
        return {"text": label, "seeded": seeded, "value": value, "verdict": "failed", "why": f"the editor never closed ({exc})"}
    # A drawn value can share its text element with a generated one (a sankey
    # node shows its total under the name), which is why `drawn` matches on a
    # substring rather than an exact element.
    verdict, why = classify(value, wait_settled(win, value))
    return {"text": label, "seeded": seeded, "value": value, "verdict": verdict, "why": why}


def probe_type(win, kind: str, source: str, first_only: bool) -> dict:
    """Inventory one diagram, then rename each label it offered."""
    _render(win, source)
    _enter_edit_mode(win)
    inv = _dump(win, LABEL_INVENTORY)
    entry = {
        "type": kind,
        "source": source,
        "offered": len(inv.get("labels", [])),
        "rendered": len(inv.get("allText", [])),
        "withheld": sorted(set(inv.get("allText", [])) - set(inv.get("labels", []))),
        "labels": [],
    }
    if inv.get("missing") or inv.get("error"):
        return {**entry, "verdict": "failed", "why": "mermaid-error: the diagram never rendered"}

    print(f"   offered {entry['offered']} of {entry['rendered']} rendered texts: "
          f"{[l for l in inv['labels']][:12]}", flush=True)
    for index, label in enumerate(inv["labels"]):
        # Back to the pristine source and a fresh edit mode: a committed rename
        # would otherwise change what the next label has to match.
        _render(win, source)
        _enter_edit_mode(win)
        fresh = _dump(win, LABEL_INVENTORY).get("labels", [])
        try:
            result = (
                {"text": label, "verdict": "failed", "why": "the offer did not survive a re-render"}
                if index >= len(fresh)
                else rename_label(win, index, fresh[index])
            )
        except AssertionError as exc:
            # A label the walk cannot click at all. Recorded, not fatal: the rest
            # of the matrix is still worth having.
            result = {"text": label, "verdict": "failed", "why": f"the click failed ({exc})"}
        entry["labels"].append(result)
        mark = "PASS" if result["verdict"] != "failed" else "FAIL"
        print(f"   {mark} {result['text']!r} -> {result.get('value', '?')!r} "
              f"{result.get('why') or result['verdict']}", flush=True)
        if first_only:
            break
    return entry


def wait_for_bridge(win, timeout: float = 90) -> None:
    """A WebEngine page that never finishes loading looks like an empty document.

    The probe is re-issued on every poll: one call made before the page loads
    answers ``undefined`` and its callback never fires again.
    """
    seen: dict = {}
    js = win._web.page().runJavaScript
    script = "JSON.stringify({ bridge: typeof window.bridge, content: typeof window.ediSetContent })"

    def ready() -> bool:
        js(script, lambda raw: seen.update(json.loads(raw) if isinstance(raw, str) else {}))
        return seen.get("bridge") == "object" and seen.get("content") == "function"

    if not _pump_until(ready, timeout=timeout):
        fail("the webview bridge never became ready (a flaky boot, not a label bug) -- retry")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--type", help="comma-separated diagram types (default: all in the fixture file)")
    parser.add_argument("--out", default=str(ROOT / "build/mermaid-label-probe.json"), help="where to write the full report")
    parser.add_argument("--first", action="store_true", help="one label per diagram instead of all of them")
    args = parser.parse_args()

    if not (DIST_DIR / "index.html").exists():
        fail(f"no frontend build at {DIST_DIR}; run `npm run build` first")
    if not FIXTURES.exists():
        fail(f"no fixture file at {FIXTURES}")
    sources = diagram_sources(FIXTURES)
    if args.type:
        wanted = [t.strip() for t in args.type.split(",") if t.strip()]
        unknown = [t for t in wanted if t not in sources]
        if unknown:
            fail(f"not in {FIXTURES.name}: {', '.join(unknown)}")
        sources = {t: sources[t] for t in wanted}
    if not sources:
        fail(f"no mermaid blocks in {FIXTURES}")

    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.resize(1400, 900)
    win.show()
    wait_for_bridge(win)

    report = [probe_type(win, kind, source, args.first) for kind, source in sources.items()]

    print()
    tally = {"ok": 0, "refused": 0, "rewritten": 0, "failed": 0}
    for entry in report:
        counts = {"ok": 0, "refused": 0, "rewritten": 0, "failed": 0}
        for label in entry["labels"]:
            counts[label["verdict"]] += 1
        if entry.get("verdict") == "failed":
            counts["failed"] += 1
        for name, n in counts.items():
            tally[name] += n
        print(
            f"{entry['type']:<20} offered {counts['ok'] + counts['refused'] + counts['failed']:>3}"
            f" of {entry['rendered']:>3} texts   ok {counts['ok']:>3}"
            f"  refused {counts['refused']:>2}  rewritten {counts['rewritten']:>2}"
            f"  failed {counts['failed']:>2}  {entry.get('why', '')}"
        )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    print(
        f"\n{tally['ok']} renamed, {tally['refused']} refused by mermaid, "
        f"{tally['rewritten']} re-read by mermaid, {tally['failed']} failed"
        f" -- report in {out}"
    )
    return 1 if tally["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
