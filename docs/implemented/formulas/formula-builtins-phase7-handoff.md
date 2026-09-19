# Handoff — Phase 7 (utility builtins + the Use values tool) complete

Status: **Phase 7 implemented, tree green** on top of Phase 6 (Phase 5 is HEAD
`9585f29`; Phases 0–7 all sit uncommitted in the working tree as one unit,
ready to commit). Source of truth: `docs/formula-builtins-plan.md` (Phase 7
marked complete there).

## Tree state (verified this session)

- Gates re-run on the combined Phase 6 + Phase 7 revision:
  - `npm run typecheck` → clean
  - Targeted suites → green: formulas (105), spreadsheet (337 combined with
    formulas/reference), table view (134, incl. the two new Use-values tests)
  - Full `npm run check`, `npm run build`, and `.venv/bin/pytest tests/` still
    to re-run as the closing gate (pytest flooded 11 flakes once last session;
    an identical rerun was green — rerun before suspecting a regression)
- README + plan doc updated; `Help → Formula Reference`, autocomplete, and
  definition-collision checks picked up `UUID`/`GUID`/`B64ENCODE`/`B64DECODE`
  automatically (new `utility` category, the first category-shape change since
  Phase 5's `lookup`).

## What Phase 7 delivered

1. **`UUID()`** (alias `GUID`) — random RFC 4122 v4, lowercase, dashed, dropped
   into the new `utility` category. Volatile by the engine's natural model
   (recomputed every solve, exactly like `RAND`/`NOW`). `crypto.randomUUID`
   when available, else a `Math.random` fallback with the version/variant bits
   pinned — `randomUuid()` is exported and its format is pinned by regex in
   tests.
2. **`B64ENCODE(text)` / `B64DECODE(text)`** — base64 over the text value model,
   UTF‑8 in/out via `TextEncoder`/`TextDecoder` (`btoa`/`atob` for the base64
   step). Encode coerces its argument through the standard `firstText` path
   (errors propagate, a range → `#VALUE!`, blank → `''`); decode requires
   *valid* base64 — whitespace is tolerated, padding length is enforced
   (0 for 0−mod, 1 for 3−mod, 2 for 2−mod), and non-UTF‑8 bytes → `#VALUE!`
   (`fatal: true`). It is a text-to-text transformer; there is deliberately no
   binary value kind.
3. **Use values** — a selection tool (toolbar button, enabled whenever any
   selected cell holds a formula per `isFormula`) that replaces every formula
   cell in the selection with its **currently rendered** display — read from
   the last `fillCellContents` solve (`renderedSolution`), never re-solved by
   the tool, the spreadsheet analogue of Excel's copy → paste-values. This is
   the important part: a fresh solve inside the tool would re-roll volatile
   cells (`UUID`, `RAND`, `NOW`), baking values the user never saw; freezing
   from the render keeps "what you see is exactly what gets written". All
   selected cells go out in a single commit (the selection = the anchor→active
   rectangle plus any Ctrl+click `extra` cells). Non-formula cells are left
   untouched. Works on error cells too (freezes the `#DIV/0!` text). Fully
   undoable via the normal CodeMirror history. This is the surgical complement
   to the pre-existing whole-table `Resolve formulas?` checkbox (values saved +
   formulas carried in a comment + rehydration on open), which remains the
   right choice when the whole table should commute between live and static.

## Semantics worth preserving

- **Volatility is a feature now**: the no-cache model makes `UUID` regenerate on
  every solve; Use values is the escape hatch that turns generated values into
  literals. Do not add caching to make volatile functions "stable once" — the
  selection-wide Use values is the documented, undoable path instead.
- **`B64*` primary-argument handling matches `LEN`/`UPPER`** (via `firstText`):
  error args propagate, a single range is rejected with `#VALUE!`. Keep them
  scalar-only.
- **Padding is enforced**, not forgiving: `aGVsbG8=` decodes, `aGVsbG8==` and
  unpadded-but-remainder-1 forms are rejected. The regex is body-only, so `=`
  can't sneak past the tail. The exported `base64ToUtf8`/`utf8ToBase64` are the
  testable seam.
- **Bake keeps the marks question open** (now applied per selected cell): using
  values on a styled formula (`**=A2+B2**`) writes the plain display (`5`),
  dropping the `**`. The whole-table resolve path preserves marks; Use values
  is deliberately plain. If that ever matters, extend `useValues` to carry the
  marks over.

## What's left (honest)

- The phased program is 0–7 complete. Remaining idea-list (no commitment) was
  re-scoped after the earlier handoffs: `TEXT`/`TEXTSPLIT`, array results,
  binary search modes, stable-never-recompute generators. None are owed.
- `B64DECODE` returning arbitrary bytes would need a binary value kind that
  doesn't exist; the UTF‑8-only contract is the honest boundary.

## Operational lessons carried forward

- **Toolbar singleton buttons survive grid rebuilds**: the Use values button is
  built in `buildTools` (once per node view), the grid rebuilds under it, so the
  test grabbed `tool(view, 'Use values')` before clicking and it stayed valid —
  unlike anything in the grid.
- **The tool's enablement runs off `renderSelection()`**, which already runs on
  every selection move; keep it on the cheapest predicate (a scan over
  `collectSelected()` calling `isFormula(raw)`), not a per-move solve —
  `updateStatus` already solved on selection moves, so a second full solve per
  arrow-key would have been wasteful.
- **Excel's paste-values works because results are cached**; Edi's solver is a
  pure function with the whole grid re-solved on every rebuild (and the status
  bar used to solve on every selection move too). Any tool that "freezes
  values" must therefore capture the *rendered* solution (`renderedSolution`,
  set by `fillCellContents`) rather than re-solving — re-solving re-rolls
  volatile cells and bakes values the user never saw. The status bar now reads
  the same rendered solution instead of solving per selection move.
- **`attrs.value` is the source-of-truth assertion** in table tests: the table
  node stores its markdown in `node.attrs.value`, and `doc.textBetween` does
  not reach it.
- New builtins needed zero parser changes and auto-propagated to the
  reference/autocomplete/collision-set — the registry remains the single source
  of truth.