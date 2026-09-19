# Handoff — Phase 6 (criteria debt payoff + capstone) complete

Status: **Phase 6 implemented, tree green** on top of Phase 5 (HEAD `9585f29`;
Phases 0–5 committed; the Phase 6 unit — this session's changes — sits
uncommitted in the working tree, ready to commit as a single unit). Source of
truth: `docs/formula-builtins-plan.md` (Phase 6 now marked complete there; the
program's original phased list is fully delivered).

## Tree state (verified this session)

- Gates re-run on the Phase 6 revision:
  - `npm run check` → tsc clean + eslint + **all vitest passed** (Phase 5 was
    1050; Phase 6 added 22, taking it to 1072)
  - `npm run build` → exit 0
  - `.venv/bin/pytest tests/` → 199 passed (a first run surfaced 11 QtWebEngine
    page-load timing flakes; an identical rerun was fully green — the known
    headless flake in AGENTS.md, not a regression)
- README and the plan doc updated; `Help → Formula Reference` and autocomplete
  picked up `CHOOSE`/`STDEV`/`VAR`/`XLOOKUP` automatically (no new category —
  they slot into `logical`/`aggregate`/`lookup`).

## What Phase 6 delivered

1. **Range origin** (the debt payoff's foundation): the `set` value now carries
   optional `row1`/`col1` (its 1-based top-left grid cell), added to the
   `CellValue.set` member and `setValue(items, rows?, cols?, row1?, col1?)`;
   `rangeValue` in `spreadsheet.ts` stamps the real origin. Hand-built sets and
   document-function range parameters remain originless.
2. **Positional `SUMIF`/`AVERAGEIF`**: pairs each matching criteria cell with
   the sum cell at `(sum.row1 + dr, sum.col1 + dc)` for the criteria offset
   `(dr, dc)` — the sum range's top-left anchors the rectangle; cells outside
   its own rectangle read blank (0). Same-shape, same-origin ranges (the common
   case) produce byte-identical results to the old flat walk. Originless sets
   fall back to flat-index pairing, so nothing already working changes.
   **Documented caveat**: the formula layer has no grid access, so Excel's
   extension of the sum range *past the rectangle the user referenced* is not
   reproduced (a narrower sum range reads blank past its right edge/bottom).
3. **Criteria wildcards**: `parseCriteria` now translates `*`/`?`/`~` for the
   equality family (`=`, `<>`, bare) into a `wildcardRegex` (anchored,
   case-insensitive) that matches **text cells only**, like Excel
   (`COUNTIF(A2:A9,"A*")`, `"~*"` → literal `*`). Range operators (`>` etc.)
   stay literal. The same regex power backs `XLOOKUP` match_mode 2.
4. **Capstone batch**:
   - `CHOOSE(index, value, …)` — **lazy** (the sole new `lazy: true` builtin);
     index truncated toward zero; `<1` or past the list → `#VALUE!`.
   - `STDEV`/`VAR` — sample statistics over `collectNumbers` (numbers + dates,
     booleans/blanks skipped); fewer than two values → `#DIV/0!`.
   - `XLOOKUP` — vector lookup reusing `tableCells`/`criterionKey`/`wildcardRegex`
     and the `optionalIntAt`/`keyLess` machinery from Phase 5; match_mode 0
     (default) exact / −1 next-smaller / 1 next-larger / 2 wildcard; search_mode
     1 (default) / −1; custom `if_not_found` overrides `#N/A!`; 2D arrays, size
     mismatch, bad mode → `#VALUE!`.

## Semantics worth preserving

- Wildcards match **text cells only** (`"*"` does not count numbers/blanks), and
  `<>` wildcard patterns are the logical negation — both pinned in tests.
- The positional sum pairing derives the offset from the **criteria** rectangle
  and anchors the **sum** rectangle at its own top-left; the two origins need
  not match (`SUMIF(A2:A4, "x", C3)` reads column C offsets, not page-center).
- `CHOOSE` exclusivity: unselected arguments are never forced — verified through
  the eager `applyFunction` wrapper (lazy dispatch keeps the thunk unconsumed),
  in a DSL definition, and against `#DIV/0!` args.
- `STDEV`/`VAR` follow `SUM`'s value discipline: dates coerce to serials,
  booleans/blanks are skipped, an error cell in the range propagates.
- The `#VALUE!`/`#DIV/0!`/`#N/A!` error codes are the only ones this phase
  touches — no new codes, the four-way rule holds.

## What's left (honest)

- The phased builtin program 0–6 is complete. The only documented divergence
  remaining is the SUMIF/AVERAGEIF sum-range extension caveat above; it needs
  grid access inside the formula layer (a larger architectural change), and the
  current behavior is a strict improvement over the old flat pairing.
- Everything else in the handoffs was new-capability speculation (`TEXT`,
  `TEXTSPLIT`, array results, binary search modes) — none of it owed.

## Operational lessons carried forward

- **Gate habit** unchanged: `npm run check` → `npm run build` →
  `.venv/bin/pytest tests/`; a flaky first pytest run should be re-run once
  before suspecting a regression (the 11 QtWebEngine timing flakes were green on
  the identical rerun).
- **2D geometry is now the norm**: keep stamping `row1`/`col1` on sets that
  originate from `rangeValue`; any future set-consuming function should reuse
  `tableCells`/`pairTable` rather than flattening blindly.
- **Excel parity without grid access** has a ceiling: positional alignment
  within referenced rectangles is reproducible; extension *into* grid cells the
  user didn't reference is not. Document the ceiling instead of faking it.
- **Lazy builtins need the DSL slice path** — `CHOOSE` worked with zero parser
  changes because Phase 1's source-slice thunks were already generic; keep new
  conditional functions on `lazy: true` + `CellValueThunk[]` and they inherit it.

## Phase 6 quick-wins worth noting

- The origin stamp was a three-line change (`setValue` + the type + one line in
  `rangeValue`); all 22 new tests plus the untouched 1050 pinned the blast
  radius.
- `XLOOKUP`'s wildcard mode and the criteria wildcards share one translator
  (`wildcardRegex`), so the two features can't drift.
- `CHOOSE` required no changes to either parser, `invokeFunction`, or the DSL —
  Phase 1's machinery was already built for it.