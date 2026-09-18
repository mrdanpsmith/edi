# Handoff — Phase 3 (math & aggregate gap-fillers) complete; Phase 4 pickup points

Status: **Phase 3 implemented, tree green** on top of Phase 2 (HEAD
`d073541`; Phases 2 + 3 sit uncommitted in the working tree, ready to commit
as one unit per the earlier handoffs' convention). Source of truth for the
whole program: `docs/formula-builtins-plan.md` (Phase 3 now marked complete
there).

## Tree state (verified this session)

- HEAD `d073541` (the Phase 1 commit), branch `feature/spreadsheet-editor`.
- Gates re-run on the Phase 3 revision:
  - `npm run check` → tsc clean + eslint + **all vitest passed** (Phase 2 was
    1000; the Phase 3 tests added 22, taking it to 1022)
  - `npm run build` → exit 0
  - `.venv/bin/pytest tests/` → passed, backend coverage unchanged
- README supported-functions/error list updated; `#NUM!` added to the error
  vocabulary (ERROR_HINTS, reference, README); autocomplete,
  reference-shifting, and `Help → Formula Reference` picked up the new names
  automatically (they derive from `BUILTIN_FORMULAS`).

## What Phase 3 delivered

1. **Error vocabulary**: `#NUM!` added, the Phase 2 handoff's flagged decision.
   Domains that produce it: `LN`/`LOG`/`LOG10` of ≤ 0, `LOG` base 1
   (→ `#DIV/0!`, Excel parity), `RANDBETWEEN` with bottom > top,
   `CEILING`/`FLOOR` with number and significance of opposite signs,
   `LARGE`/`SMALL` with `k` outside `[1, n]` or an empty/non-numeric range.
   Legacy `SQRT` keeps its `#VALUE!` domain error (pre-existing, left alone).
2. **Math** (category `math`, next to `ROUND`):
   - `MOD(n, d)` uses Excel's `n - d * floor(n / d)` (remainder takes the
     divisor's sign; e.g. `MOD(-3, 2) = 1`); zero divisor → `#DIV/0!`.
   - `INT` floors; `TRUNC(number, [digits])` truncates toward zero; both accept
     negative digits (`TRUNC(1234.5, -2)` → `1200`).
   - `CEILING` (away from zero) and `FLOOR` (toward zero) round to a multiple of
     `significance` (default 1); number and significance must share a sign
     (opposite → `#NUM!`), and a zero significance yields 0. Uses
     `roundStepCall` with `roundStep(n, sig, Math.ceil)`.
   - `ROUNDUP`/`ROUNDDOWN` round the magnitude away/toward zero on the digits
     argument, then re-apply the sign (`roundDirectionalCall`).
   - `SIGN`, `POWER`, `EXP`, `LN`, `LOG(number, [base])` (default 10), `LOG10`,
     `PI()`, `RAND()` (0..1, recomputed per evaluation — a volatile cell), and
     `RANDBETWEEN(bottom, top)` (inclusive floor/ceil of coerced bounds).
3. **Aggregate** (category `aggregate`, after `PRODUCT`):
   - `MEDIAN` sorts `collectNumbers` output and takes the middle; even counts
     average the two middles; empty → `num(0)` (codebase MIN/MAX style).
   - `COUNTA` counts every non-blank cell (errors count too — deliberately NOT
     error-propagating, per Excel); `COUNTBLANK` counts blanks plus `""`
     (`isBlankish` helper); both flatten sets/ranges.
   - `LARGE(array, k)`/`SMALL(array, k)`: `k` from `numberAt` + `trunc`,
     1-based, re-sorted per call; `#NUM!` outside `[1, n]` or no numbers.
4. **Criteria variants** shared machinery (`parseCriteriaFromArgs`, `rangeCells`,
   `criterionKey`, `matchCriterion`):
   - Operator-prefixed criteria strings: `= <> < <= > >=` + operand, or a bare
     operand (case-insensitive text match, numbers-before-text ordering).
   - `criterionKey` coerces: numeric text (`"5"`) and numbers compare
     numerically; non-numeric text compares lowercased; an exact match on `""`
     targets blanks. Cell errors in the range never match (and are skipped, not
     propagated) — Excel throws nothing for them here.
   - `SUMIF`/`AVERAGEIF` optional `sumRange` aligns **positionally by flat
     index** with the criteria range — correct for same-shape ranges (the
     normal case), and only differs from Excel when the ranges have different
     shapes (2D offset alignment needs geometry the flat `set` value does not
     carry; Phase 5's lookup work is where that should live).
   - `SUMIF` no match → 0; `AVERAGEIF` no match → `#DIV/0!` (Excel parity);
     a dangling operator (`">"`) → `#VALUE!`.

## Semantics worth preserving (Excel parity)

- `MOD` sign follows the divisor (`n - d*floor(n/d)`), never JS `%`.
- `CEILING`/`FLOOR` with a step honor the significance's sign — opposite signs
  are a `#NUM!` domain error, **not** a negation of the rounding direction.
- `ROUNDUP`/`ROUNDDOWN` round the magnitude, then restore the sign, so
  `ROUNDUP(-3.2, 0) = -4` and `ROUNDDOWN(-3.9, 0) = -3`.
- `TRUNC` never rounds (no magnitude bump), which is the Excel—`INT` split.
- Arithmetic helpers all route through `mathResult(args, v)` so Infinity/NaN
  results (e.g. `2^1000`) come out `#NUM!` instead of an opaque `#VALUE!`.
- Criteria text is case-insensitive but values are compared by kind first
  (numeric vs text), so `COUNTIF(cells, "<>Apples")` counts non-Apple text AND
  numbers, like Excel.
- Range iteration reuses `collectNumbers` (via `collectNumbers([arg])`) so
  blanks/excluded cells drop out exactly as the arithmetic aggregates behave.

## What Phase 4 needs (the actual work)

Per plan doc Phase 4 (dates/times):

1. `TODAY()`, `NOW()`, `DATE(y, m, d)`, `YEAR`/`MONTH`/`DAY`,
   `HOUR`/`MINUTE`/`SECOND`, `WEEKDAY(serial, [type])`, `DAYS(end, start)`,
   `EDATE(start, months)`, `EOMONTH(start, months)`.
2. Serial conversion: `epoch ms / 86400000 + 25569`; the value model already
   has a `date` kind (see `toNumber`/`toText`/`formatDate` in `src/formulas.ts`)
   — `TODAY`/`NOW` need a time source; decide whether to read the wall clock
   directly or thread a clock through the env for testability.
3. Display: `YYYY-MM-DD` for integral serials, `YYYY-MM-DD HH:MM:SS` when
   fractional (`formatDate` in `src/formulas.ts` is the precedent; watch the
   UTC-vs-local trap — serials are UTC-based).
4. **Suggestions**: `DATE(y, m, d)` returns a `date` value; `YEAR` etc. read it
   back; `DAYS` returns the integer serial difference; `EDATE`/`EOMONTH` are
   calendar (not 30/360) arithmetic — treat month overflow like Excel
   (`EDATE(2024-01-31, 1)` → Feb 29). Use `numberAt`/`firstNumber` for the
   unary reads. No new categories — `datetime` is already a category label.
5. Consider whether random/time volatility should recompute on every table
   change (RAND already does; a `NOW()` would too — note this in `getMarkdown`
   caching if it becomes an issue).

## Operational lessons carried forward

- **Gate habit** unchanged: `npm run check` → `npm run build` →
  `.venv/bin/pytest tests/` (dist must exist first — it does from the build).
- **Excel behaviors are the spec**: encode Excel's sign/domain/alignment rules
  explicitly rather than leaning on JS (`%`, `Intl`, `toFixed`).
- **Error-vocabulary additions must be four-way**: `#NUM!` (this phase)
  touched `ERROR_HINTS` in `src/spreadsheet.ts`, the reference Errors block,
  README, and tests — the tooltip hint for `#NUM!` is "Number out of the
  argument's valid domain". Check before introducing another code.
- **Date kinds flow through `toText`/`toNumber` untouched** — Phase 4 mostly
  adds reads/writes around the existing `date` value kind, so it should not
  need parser changes.
- **Criteria alignment caveat documented above**: keep `sumRange` the same
  shape as the criteria `range` — positional flat-index pairing is exact only
  then.

## Phase 3 quick-wins worth noting

- Again **zero parser changes**: numeric literals, optional args, and the
  existing `fn()` arity handling covered `PI()`/`RAND()`/optional significances.
- `RAND` and friends are `math`/`aggregate` with value kinds that the existing
  machinery already renders; no reference-shifting or autocomplete edits.
- The criteria parser is ~60 lines and shared by all three `*IF`s — extend it
  (wildcards `*?` are the plan's deferred item) rather than forking per-function.