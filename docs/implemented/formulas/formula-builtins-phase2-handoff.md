# Handoff — Phase 2 (text functions) complete; Phase 3 pickup points

Status: **Phase 2 implemented, tree green** on top of Phase 1 (HEAD
`d073541`). Source of truth for the whole program:
`docs/formula-builtins-plan.md` (Phase 2 now marked complete there).

## Tree state (verified this session)

- HEAD `d073541` (the Phase 1 commit), branch `feature/spreadsheet-editor`.
- Gates re-run on the Phase 2 revision:
  - `npm run check` → tsc clean + eslint + **all vitest passed** (Phase 1 was 972;
    the text-function tests added ~40)
  - `npm run build` → exit 0
  - `.venv/bin/pytest tests/` → passed, backend coverage unchanged
- README supported-functions list + reference intro updated; autocomplete,
  reference-shifting, and `Help → Formula Reference` picked up the new names
  automatically (they derive from `BUILTIN_FORMULAS`).

## What Phase 2 delivered

1. **Registry** (`src/formulas.ts` `BUILTIN_FORMULAS`, category `text`):
   `CONCAT` (alias `CONCATENATE`), `TEXTJOIN(delim, ignoreEmpty, …)`, `LEN`,
   `UPPER`, `LOWER`, `TRIM`, `LEFT`, `RIGHT`, `MID`, `REPT`, `SUBSTITUTE`,
   `EXACT` (→ bool), `VALUE` (→ number). All **eager** — the Phase 1 lazy
   machinery needed zero changes.
2. **Range iteration**: `collectText` is the text twin of `collectNumbers` —
   walks `set` (range) args cell-by-cell in row-major order, propagates errors,
   and renders each cell through `toText`. **Blank handling**: `TEXTJOIN`
   keeps a placeholder `''` for blanks, so `ignoreEmpty=FALSE` preserves the
   delimiter gaps Excel shows (`TEXTJOIN("-",FALSE,"a",C3,"b")` → `a--b`)
   while `TRUE` drops both true blanks and `""` (Excel ignores both). `EXACT`
   flattens a range to its concatenated `toText` form before comparing.
3. **Indexing edge cases** (`intArg` helper): `LEFT`/`RIGHT`/`MID` counts are
   truncated to integers (Excel `INT`), a missing count defaults (LEFT/RIGHT →
   1, MID → rest of the string), negative counts are `#VALUE!`, `MID` start < 1
   is `#VALUE!`, and `MID` past the end returns `""`. `REPT` enforces Excel's
   32767-character result cap up front (`value.length * times > 32767`) instead
   of risking a JS `RangeError`/engine throw on a huge repeat.
4. **Coercion**: `VALUE` accepts numbers, numeric text, dates (→ serial),
   booleans (→ 1/0), and a blank cell (→ 0); `""` and unparseable text are
   `#VALUE!` with the `err('#VALUE!', hint)` convention — matching Excel, where
   `VALUE("")` errors but `VALUE(blank_cell)` is 0.
5. **Single-value discipline**: `LEN`/`UPPER`/`LOWER`/`TRIM`/`LEFT`/`RIGHT`/
   `MID`/`REPT`/`SUBSTITUTE`/`VALUE` error `#VALUE!` on a set argument (the
   `firstText`/`nthText` helpers), mirroring how the math unary `firstNumber`
   already rejects ranges; `CONCAT`/`TEXTJOIN`/`EXACT` are the range-aware
   ones.

## Semantics worth preserving (Excel parity)

- `toText` renders numbers via `formatNumber`, booleans as `TRUE`/`FALSE`, and
  dates via `formatDate`, so `CONCAT`/`LEN`/`EXACT` see the same string the
  cell displays.
- `SUBSTITUTE`: instance 0 = replace all; instance n = that occurrence
  (1-based, case-sensitive); empty needle or an instance beyond the count
  leaves the text unchanged (Excel does not error on a bad instance).
- `TRIM` collapses *all* whitespace runs to a single space (slightly broader
  than Excel's space-only trim — deliberate for markdown text).
- `RIGHT(…, 0)` returns `""` (guards against JS `slice(-0)` = whole string).

## What Phase 3 needs (the actual work)

Per plan doc Phase 3 (math & aggregate gap-fillers):

1. **Math**: `MOD`, `INT`, `TRUNC`, `CEILING(x, [step])`, `FLOOR(x, [step])`,
   `ROUNDUP`, `ROUNDDOWN`, `SIGN`, `POWER`, `EXP`, `LN`, `LOG(x, [base])`,
   `LOG10`, `PI`, `RAND`, `RANDBETWEEN`.
   - `MOD`'s sign follows the divisor (Excel), not JS `%`; guard zero divisor.
   - `CEILING`/`FLOOR` with a `step`: Excel rounds *away/toward zero* on the
     significance's sign — decide and document the negative-step behavior.
   - `PI()` and `RAND()` take zero arguments — the current evaluator already
     accepts `fn()`, but note the reference intro says ranges "wherever a
     function expects a list"; `RAND()` reads its args as none.
2. **Aggregate**: `MEDIAN`, `COUNTA`, `COUNTBLANK`, `LARGE(range, k)`,
   `SMALL(range, k)`.
   - `COUNTA` counts non-blank cells (text, numbers, booleans, dates, errors);
     `COUNTBLANK` counts blanks (and `""`?). `collectNumbers` currently ignores
     blanks — these need a count-twin or parameterized walker.
   - `LARGE`/`SMALL`: the `k` argument is 1-based and must be re-sorted each
     call; Excel errors `#NUM!` for `k` outside `[1, n]` — `#NUM!` is **not** in
     the current error vocabulary, so decide (`#VALUE!` vs adding `#NUM!` to
     `ERROR_HINTS`/reference/README/tests).
3. **Criteria variants**: `SUMIF(range, "criteria", [sumrange])`, `COUNTIF`,
   `AVERAGEIF` with operator-prefixed criteria strings (`">5"`, `"Apples"`);
   wildcards deferred.
   - Criteria strings need a small parser: leading `= <> < <= > >=` operator or
     bare match; compare against each cell's `compareKey`-style value.
   - `andCall`/`orCall` currently use `isTruthy`; criteria against ranges feed
     range-iteration, so plan a `collect` walker reuse (see `collectText`).
4. **Suggestions**: reuse `firstText`/`intArg` patterns for `DEGREES`-style
   unary math; keep `collectNumbers` semantics for aggregates; add `MEDIAN`'s
   sort-based middle. No new categories needed — `math`/`aggregate` exist.

## Operational lessons carried forward

- **Gate habit** unchanged: `npm run check` → `npm run build` →
  `.venv/bin/pytest tests/` (dist must exist first).
- **Excel behaviors are the spec**: where JS and Excel differ (`slice(-0)`,
  `%` sign, `INT` truncation, 32767 cap, `VALUE("")`), encode Excel's behavior
  explicitly rather than leaning on JS leniency.
- **Error-vocabulary additions must be four-way**: a new code (`#NUM!`,
  `#NAME?` already patched) touches `ERROR_HINTS`, the reference Errors block,
  README, and the table tooltip tests — check before introducing one.

## Phase 2 quick-wins worth noting

- No parser changes were needed at all: string literals, comparisons, and
  `TRUE`/`FALSE` (Phase 0) plus lazy dispatch (Phase 1) were exactly what text
  functions need. `CONCAT("Item ", B2)` worked the first time the parser saw it.
- `#NAME?` collision protection for the new names (`TEXTJOIN`, `SUBSTITUTE`,
  …) is automatic — no registry work beyond the entries.