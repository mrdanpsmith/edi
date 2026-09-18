# Formula Built-ins Expansion Plan

Goal: grow the spreadsheet engine past its original 9 builtin functions so document-local `edi-formula` definitions can build real business rules (tax tiers, labels, aging, conditions, text assembly).

Current builtins (Phases 0–6 complete): `SUM`, `AVERAGE` (alias `AVG`), `MIN`, `MAX`, `COUNT`, `PRODUCT`, `MEDIAN`, `COUNTA`, `COUNTBLANK`, `LARGE`, `SMALL`, `STDEV`, `VAR`, `SUMIF`, `COUNTIF`, `AVERAGEIF` (criteria support `*`/`?` wildcards with `~` escape), the math `ABS`, `SQRT`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `MOD`, `INT`, `TRUNC`, `CEILING`, `FLOOR`, `SIGN`, `POWER`, `EXP`, `LN`, `LOG`, `LOG10`, `PI`, `RAND`, `RANDBETWEEN`, the logical `IF`, `IFERROR`, `IFS`, `SWITCH`, `CHOOSE` (all lazy), `AND`, `OR`, `NOT`, `ISERROR`, `ISNUMBER`, `ISTEXT`, `ISBLANK`, the text `CONCAT` (alias `CONCATENATE`), `TEXTJOIN`, `LEN`, `UPPER`, `LOWER`, `TRIM`, `LEFT`, `RIGHT`, `MID`, `REPT`, `SUBSTITUTE`, `EXACT`, `VALUE`, the date/time `TODAY`, `NOW`, `DATE`, `YEAR`, `MONTH`, `DAY`, `HOUR`, `MINUTE`, `SECOND`, `WEEKDAY`, `DAYS`, `EDATE`, `EOMONTH`, and the lookup `INDEX`, `MATCH`, `VLOOKUP`, `HLOOKUP`, `XLOOKUP`.

## What the engine is missing

1. **Text values carry no payload.** `CellValue`'s text variant is `{ kind: 'text' }` — the string is dropped by `parseCellValue` (`src/spreadsheet.ts`). `solveCell` only displays numbers, so a formula returning text/boolean currently renders as **blank**. `CONCAT`, `LEN`, `LEFT`, and `IF` returning words are impossible until text stores its string and the display path handles non-numeric results.
2. **No string literals.** Both the main formula parser and the `edi-formula` body parser handle only numbers, refs, names, parens. `CONCAT("Item ", B2)` needs `"…"` literals in both.
3. **No comparisons or booleans.** Grammar is only `+ - * / ^` and unary minus. `IF` / `SUMIF` need conditions → add `= <> < <= > >=`, `TRUE`/`FALSE`, and a boolean value kind.
4. **No date/time model.** Nothing represents a date; no cell number formats exist.
5. **Fixed categories.** `FormulaCategory` is `aggregate | math | custom` with a hardcoded label/order list in `src/formulaReference.ts`; new groups must be registered there (docs generator) plus README and tests.
6. **No volatility.** Values recompute on every rebuild/serialize (no cache), so `NOW`/`RAND` refresh whenever the table changes; an idle doc never ticks. That is the chosen behavior — no timers.

## Confirmed decisions

- **Dates** = a dedicated `date` value kind carrying an Excel-style serial (days since 1899-12-30, fractional day = time, **local time**). Displays formatted (`2026-09-18 14:32:00`) but coerces to a number for arithmetic.
- **Grammar** gets comparison operators + string literals + `TRUE`/`FALSE` (both parsers), Excel-style: `=IF(A2>5,"High","Low")`.
- **Text results render as markdown**, consistent with text cells. Pipe escaping already handled — `tableToPipes` escapes `|` → `\|` (`src/spreadsheet-util.ts:113`), and live tables store the raw formula anyway.
- **Volatile functions** recompute on edit/rebuild only. No timer.

## Design notes

- **Lazy arguments.** The evaluator currently evaluates every argument eagerly. `IF`/`IFERROR`/`IFS`/`SWITCH` must not evaluate unselected branches (else `IF(A2=0, 0, 10/A2)` yields `#DIV/0!` when the else branch isn't taken). Add optional `lazy` to `FormulaFunction`; new `invokeFunction(name, argThunks, env)` forces thunks for eager fns and passes `() => CellValue` to lazy ones. `applyFunction` stays as an eager wrapper for tests. Document-local definitions get the same laziness automatically.
- **`#NAME?` collision rule stays sacred**: builtin names/aliases are never overridable by `edi-formula` defs.
- **Def-body dependency scan** (`CALL_RE`, `src/formulaDsl.ts:57`) must strip string literals before scanning, so `"SUM("` inside a literal can't false-positive as a dependency.
- **Text values** should carry the cleaned/unwrapped string so `CONCAT(A2, …)` of `**hi**` yields `hi`.
- **`TRUE`/`FALSE` vs refs**: `TRUE` alone is not a valid ref (no row digits), so it's safe as a literal; still only treat as literal when not followed by `(` or `:` so `TRUE1` stays a reference.
- **Single-pass parsers make laziness a re-parse.** Both `functionCall`s are recursive-descent with a mutable position that must advance while arguments are scanned, so a lazy branch cannot be a closure over "parse at this spot later". The implemented form: each argument is still parsed eagerly (the position advances and syntax is validated), but for a **lazy** callee the *source slice* of the argument is kept and forced as `() => new FormulaParser(slice, grid, visiting, env).parse()` (or the `BodyParser` twin). An unselected branch is thus read once to be discarded (pure: reads only, no caching, so the net result is correct) and never forced; eager callees keep the already-computed value so nothing is re-parsed. `src/formulaDsl.ts` memoizes each parameter thunk on top, so a lazy definition reading a parameter twice forces it once.

## Phase 0 — value model & grammar (prerequisite, lands first)

**`src/formulas.ts`**
- `CellValue`: text gains `value: string`; add `boolean` (`value: boolean`) and `date` (`value: number` = serial). Constructors `text(value)`, `bool(v)`, `dateSerial(v)` (name avoids the future `DATE` builtin).
- Coercion helpers:
  - `toNumber`: bool → 1/0, date → serial, numeric-text → `Number`, non-numeric text → `null` (preserves `#VALUE!` for binary ops).
  - `toText`: number → `formatNumber`, bool → `TRUE`/`FALSE`, date → formatted, blank → `''`.
  - `isTruthy`: blank → false, bool → itself, number → `≠ 0`, non-numeric text → `#VALUE!`.
  - `collectNumbers`: dates coerce to serials; booleans stay skipped (Excel `SUM` behavior).
- `FormulaCategory` union gains `'logical' | 'text' | 'date'`.

**`src/spreadsheet.ts`** (main parser) **and `src/formulaDsl.ts`** (body parser) — mirrored in both:
- String literals `"…"` with `""` → `"` in `atom()`.
- Comparison operators `= <> < <= > >=` in a precedence level below additive; results are boolean.
- `TRUE`/`FALSE` literals.
- `parseCellValue` stores the cleaned string in `text(value)`; `solveCell` displays non-number results (text verbatim, `TRUE`/`FALSE`, date via `formatDate`).

**Docs/tests**
- `src/formulaReference.ts`: extend `CATEGORY_LABELS` / `CATEGORY_ORDER`.
- README (lines ~22-39): supported functions/operators/literals.
- Reference intro: operators, string literals, `TRUE`/`FALSE`.
- Update `spreadsheet.test.ts` + `formulaDsl.test.ts`.

## Phase 1 — logic functions

**Status: complete** — implemented and verified (`npm run check` → 972 vitest,
`npm run build` → OK, `.venv/bin/pytest` → 199 passed). Commit it as its own
unit; the handoff records what landed and the Phase 2 pickup points
(`docs/formula-builtins-phase1-handoff.md`).

`IF`, `IFERROR`, `AND`, `OR`, `NOT`, `IFS`, `SWITCH` — all with proper laziness
where needed (IF/IFERROR/IFS/SWITCH), plus cheap info helpers `ISERROR`,
`ISNUMBER`, `ISTEXT`, `ISBLANK`.

Delivered:
- Lazy dispatch in `src/formulas.ts`: optional `lazy` on `FormulaFunction`, the
  `CellValueThunk` type, and `invokeFunction(name, argThunks, env)` (forces
  thunks for eager fns, passes them through to lazy ones); `applyFunction`
  remains the eager wrapper used by tests.
- Both evaluators' `functionCall` (`src/spreadsheet.ts`, `src/formulaDsl.ts`)
  capture lazy arguments as re-parseable source slices (see Design notes).
- Every `edi-formula` definition is lazy: parameters bind as **memoized**
  thunks, so a `IF(c, a, b)`-style body skips branches it never reads and a
  parameter read several times is forced exactly once.
- `AND`/`OR`/`NOT`/`IS*` are eager and cheap as planned (no short-circuit).
- `#N/A!` joined the error vocabulary for `IFS`/`SWITCH` no-match results
  (reference doc, README, and table tooltip hints updated).

## Phase 2 — text functions

**Status: complete** — implemented and verified (`npm run check`,
`npm run build`, `.venv/bin/pytest tests/` green). Handoff:
`docs/formula-builtins-phase2-handoff.md`.

`CONCAT` (alias `CONCATENATE`), `TEXTJOIN(delim, ignoreEmpty, …)`, `LEN`, `UPPER`, `LOWER`, `TRIM`, `LEFT`, `RIGHT`, `MID` (1-based), `REPT`, `SUBSTITUTE`, `EXACT` (→ bool), `VALUE` (→ number). CONCAT/TEXTJOIN/EXACT iterate set/range args via `toText`.

Delivered:
- All 13 text functions in `BUILTIN_FORMULAS` (category `text`), fully eager —
  the lazy machinery needed no changes.
- `collectText` in `src/formulas.ts`: the text twin of `collectNumbers`,
  walking set/range values cell-by-major with error propagation; `TEXTJOIN`
  keeps placeholder holes when `ignoreEmpty` is FALSE and drops blanks (and
  empty strings) when TRUE.
- Excel indexing semantics: `LEFT`/`RIGHT`/`MID` are 1-based, truncate
  fractional counts (INT) and clamp; negative counts and `MID` start < 1 are
  `#VALUE!`; `MID` past the end gives `""`; `REPT` guards the 32767-char Excel
  cap instead of letting the JS engine throw on a huge repeat.
- `SUBSTITUTE` matches Excel's case-sensitive behavior: instance 0 = all,
  instance n = that occurrence only, bad instance or empty needle leaves the
  text unchanged.
- `VALUE` accepts numbers, numeric text, booleans, dates (→ serial), and
  blanks (→ 0); `""` and unparseable text are `#VALUE!`, like Excel.
- `EXACT` compares `toText` forms case-sensitively (a blank equals `""`), and
  flattens a range to its concatenated text.
- README/Reference updated; autocomplete, reference-shifting, and the
  generated reference picked everything up automatically.

## Phase 3 — math & aggregate gap-fillers

**Status: complete** — implemented and verified (`npm run check`,
`npm run build`, `.venv/bin/pytest tests/` green). Handoff:
`docs/formula-builtins-phase3-handoff.md`.

- Math: `MOD`, `INT`, `TRUNC`, `CEILING(x, [step])`, `FLOOR(x, [step])`, `ROUNDUP`, `ROUNDDOWN`, `SIGN`, `POWER`, `EXP`, `LN`, `LOG(x, [base])`, `LOG10`, `PI`, `RAND`, `RANDBETWEEN`.
- Aggregate: `MEDIAN`, `COUNTA`, `COUNTBLANK`, `LARGE(range, k)`, `SMALL(range, k)`.
- Criteria variants: `SUMIF(range, "criteria", [sumrange])`, `COUNTIF(range, "criteria")`, `AVERAGEIF(…)` with operator-prefixed criteria strings (`">5"`, `"Apples"`); wildcards deferred.

## Phase 4 — dates/times

**Status: complete** — implemented and verified (`npm run check`,
`npm run build`, `.venv/bin/pytest tests/` green). Handoff:
`docs/formula-builtins-phase4-handoff.md`.

`TODAY`, `NOW`, `DATE(y, m, d)`, `YEAR`/`MONTH`/`DAY`, `HOUR`/`MINUTE`/`SECOND`, `WEEKDAY(serial, [type])`, `DAYS(end, start)`, `EDATE(start, months)`, `EOMONTH(start, months)`.
- Dates coerce to serials for arithmetic (`=NOW()-B2`).
- Local timezone semantics.

## Phase 5 — lookup

**Status: complete** — implemented and verified (`npm run check`,
`npm run build`, `.venv/bin/pytest tests/` green). Handoff:
`docs/formula-builtins-phase5-handoff.md`.

`INDEX(array, [row_num], [col_num])`, `MATCH(lookup_value, lookup_array, [match_type])`, `VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])`, `HLOOKUP(`…)`.
- Ranges are now a 2D shape (`rows` × `cols` in row-major order), so lookup functions can index a table; this is the "2D range semantics" the phase was originally deferred on.
- Lookups match case-insensitively and order numbers before text (`criterionKey`).
- `INDEX` defaults omitted coordinates to 1; a single index into a one-row range runs along the row; `< 1` is `#VALUE!`, out of bounds is `#REF!`.
- `MATCH` type 0 = exact, 1 (default) = largest ≤, −1 = smallest ≥ (linear scans); type outside `{-1, 0, 1}` or a 2D array → `#N/A!`.
- `VLOOKUP`/`HLOOKUP` require a valid index in range (`#VALUE!`/`#REF!`); `range_lookup` FALSE forces exact match, TRUE/omitted approximates (largest value ≤).
- Added the `lookup` category to the Help → Formula Reference.

## Phase 6 — criteria debt payoff + capstone

**Status: complete** — implemented and verified (`npm run check` → 1072 vitest,
`npm run build` → OK, `.venv/bin/pytest tests/` → 199 passed). Handoff:
`docs/formula-builtins-phase6-handoff.md`. Pays down the two Phase-3 deferrals
now that Phase 5's range geometry exists, then adds a final builtin batch:

1. **Range origin**: the `set` value gains `row1`/`col1` (the range's top-left
   grid cell), stamped by `rangeValue` in `spreadsheet.ts`; hand-built sets and
   document-function ranges stay originless.
2. **Positional `SUMIF`/`AVERAGEIF`**: with origin + shape, the sum/avg range
   pairs by grid position — the sum range's top-left anchors the rectangle, and
   matched cells land at `(sum_row1 + dr, sum_col1 + dc)` for the criteria
   offset `(dr, dc)`. Cells the sum range's own rectangle doesn't cover read
   blank (0). This is exact for the common same-shape, same-origin case (still
   covered); originless sets fall back to the flat-index pairing. Note: the
   engine has no grid access inside the formula layer, so Excel's extension of
   the sum range *beyond the rectangle the user referenced* is not reproduced —
   a narrower sum range reads blank past its right edge/bottom, where Excel
   would read the live grid.
3. **Criteria wildcards**: `*` (any run), `?` (one character), `~` escape in the
   equality family (`=`, `<>`, bare); wildcards match text cells only, like
   Excel (`COUNTIF(A2:A9,"A*")` counts cells starting with `A`, `"~*"` matches a
   literal `*`).
4. **Capstone batch**:
   - `CHOOSE(index, value, [value2], …)` — lazy like `IF`: only the selected
     value is evaluated; index is truncated toward zero and must be within range
     (`#VALUE!` otherwise).
   - `STDEV`/`VAR` — sample standard deviation / variance over the numeric
     values of a range (booleans and blanks skipped, as Excel sums do);
     fewer than two values → `#DIV/0!`.
   - `XLOOKUP(lookup, lookup_array, return_array, [if_not_found], [match_mode],
     [search_mode])` — vector lookup reusing the lookup key machinery; default
     exact first-to-last match, `match_mode` 0 exact / −1 next smaller /
     1 next larger / 2 wildcard, `search_mode` 1 first-to-last / −1 last-to-
     first (anything else → `#VALUE!`; no binary modes, the scans are linear);
     custom `if_not_found` replaces the default `#N/A!`.

`CHOOSE` joins the `logical` category, `STDEV`/`VAR` the `aggregate`, `XLOOKUP`
the `lookup` — no reference-category changes needed.

## Suggested function list (recap)

| Category | Functions |
| --- | --- |
| Logic | `IF`, `IFERROR`, `AND`, `OR`, `NOT`, `IFS`, `SWITCH`, `CHOOSE`, `ISERROR`, `ISNUMBER`, `ISTEXT`, `ISBLANK` |
| Text | `CONCAT`/`CONCATENATE`, `TEXTJOIN`, `LEN`, `UPPER`, `LOWER`, `TRIM`, `LEFT`, `RIGHT`, `MID`, `REPT`, `SUBSTITUTE`, `EXACT`, `VALUE` |
| Math | `MOD`, `INT`, `TRUNC`, `CEILING`, `FLOOR`, `ROUNDUP`, `ROUNDDOWN`, `SIGN`, `POWER`, `EXP`, `LN`, `LOG`, `LOG10`, `PI`, `RAND`, `RANDBETWEEN` |
| Aggregate | `MEDIAN`, `COUNTA`, `COUNTBLANK`, `LARGE`, `SMALL`, `STDEV`, `VAR`, `SUMIF`, `COUNTIF`, `AVERAGEIF` |
| Date | `TODAY`, `NOW`, `DATE`, `YEAR`, `MONTH`, `DAY`, `HOUR`, `MINUTE`, `SECOND`, `WEEKDAY`, `DAYS`, `EDATE`, `EOMONTH` |
| Lookup | `INDEX`, `MATCH`, `VLOOKUP`, `HLOOKUP`, `XLOOKUP` |

Priority: logic + text are the must-haves (they make `edi-formula` derivatives genuinely powerful); math/aggregate fill gaps; dates round it out; lookups build on them all; Phase 6 closed the criteria debt and capped the set.

## Verification per phase

- `npm run check` and `npm run build` after each phase.
- `.venv/bin/pytest tests/` after the frontend build (backend tests load `dist/`).
- Rebuild `dist/` after source changes.

## Known tradeoffs

- Eager evaluation for functions other than IF/IFERROR/IFS/SWITCH — an unselected branch is never *forced* (lazy args), but errors in *selected*, non-conditional args still surface. (`AND`/`OR` are eager and do not short-circuit.) The single-pass scanner still parses every lazy argument once to advance its position; the unselected slice's value is discarded and never forced.
- Text formula results render as markdown (may need care if output starts with `=` or breaks tables — pipes are escaped).
- Dates are Excel serials, local-time; no cell number formats exist, so date display comes from the `date` value kind, not formatting.