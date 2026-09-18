# Handoff — Phase 1 (logical functions) complete; Phase 2 pickup points

Status: **Phase 1 implemented, tree green** on top of Phase 0 (HEAD `57a3121`).
The Phase 1 changes sit in the working tree, uncommitted and unpushed — commit
them as the Phase 1 unit (see pickup points). Source of truth for the whole
program: `docs/formula-builtins-plan.md` (Phase 1 now marked complete there).

## Tree state (verified this session)

- HEAD `57a3121` (the Phase 0 commit), branch `feature/spreadsheet-editor`
  ahead of origin by 9 commits.
- Gates re-run on this revision, each to its own exit:
  - `npm run check` → tsc clean + eslint + **972 vitest passed** (was 946 at
    the Phase 0 handoff; +26 from the new logical/laziness tests)
  - `npm run build` → exit 0
  - `.venv/bin/pytest tests/` → **199 passed** (unchanged), 94% coverage
- Help → Formula Reference + README updated: logical functions listed, `#N/A!`
  added to the error vocabulary, README now documents comparisons, string
  literals, `TRUE`/`FALSE`, and the lazy conditionals.

## What Phase 1 delivered

1. **Lazy dispatch** (`src/formulas.ts`): optional `lazy` on `FormulaFunction`,
   the `CellValueThunk` type, and `invokeFunction(name, argThunks, env)` —
   forces thunks for eager fns, hands `() => CellValue` thunks to lazy ones.
   `applyFunction` stays as the eager wrapper (tests call this).
2. **Both evaluators collect lazily** (`src/spreadsheet.ts` `functionCall`,
   `src/formulaDsl.ts` `functionCall`). The parsers are single-pass recursive
   descent, so an argument cannot be "remembered as a closure over parse-time
   state". Each argument is parsed eagerly (position advances, syntax is
   validated) and *for a lazy callee* its **source slice** is kept; forcing
   re-parses the slice with a fresh parser sharing the same grid/visiting/env
   (or DSL scope/env). Eager callees keep the already-computed value, so
   nothing is parsed twice. This is the one non-obvious design decision in the
   phase — recorded in the plan doc's Design notes.
3. **Registry**: `IF`, `IFERROR`, `IFS`, `SWITCH` (lazy) + `AND`, `OR`, `NOT`,
   `ISERROR`, `ISNUMBER`, `ISTEXT`, `ISBLANK` (eager, cheap — `AND`/`OR` do
   NOT short-circuit). New names automatically hit autocomplete, reference
   shifting (`BUILTIN_FUNCTION_NAMES`), the generated reference, and the
   `edi-formula` reserved-name check.
4. **Document definitions are lazy too** (`src/formulaDsl.ts`
   `makeFormulaFunction`): parameters bind as **memoized** thunks, so a body
   like `IF(c, a, b)` only forces the branches it reads, and a parameter read
   several times (`D(x) = x + x`) forces its argument exactly once.
5. `#N/A!` joined `ERROR_HINTS`/reference/README for `IFS`/`SWITCH` no-match.

## Operational lessons carried forward

- **Gate habit:** one full `npm run check` exit plus `npm run build` and
  `.venv/bin/pytest tests/` (in that order, dist must exist) is the bar. The
  lone first-look edit that failed tsc was reverted before landing — land
  dispatch on its own, then builtins, if a future phase gets hairy.
- **Byte-copy discipline** still applies for fiddly refactors (`cp` then read
  the copy; `git checkout -- <file>` to revert, never `sed`-through-stdin).

## What Phase 2 needs (the actual work)

Per plan doc Phase 2 (text functions):

1. **Registry** (`src/formulas.ts` `BUILTIN_FORMULAS`): add `CONCAT` (alias
   `CONCATENATE`), `TEXTJOIN(delim, ignoreEmpty, …)`, `LEN`, `UPPER`, `LOWER`,
   `TRIM`, `LEFT`, `RIGHT`, `MID` (1-based), `REPT`, `SUBSTITUTE`, `EXACT`
   (→ bool), `VALUE` (→ number). All eager; the lazy machinery is already in
   place and needs no changes.
2. **Range iteration**: `CONCAT`/`TEXTJOIN`/`EXACT` must walk `set` (range)
   args, flattening cell text via `toText` (`collectNumbers` is the existing
   model — a text-twin lives in `src/formulas.ts`). Blank handling: `TEXTJOIN`
   needs `ignoreEmpty`; `EXACT` compares `toText` forms.
3. **Indexing edge cases**: `MID`/`LEFT`/`RIGHT` operate on characters, 1-based;
   clamp out-of-range starts/lengths to Excel behavior rather than JS
   `String.slice` leniency where the two differ.
4. **Coercion**: `VALUE("…")` should accept numbers, numeric text, dates
   (→ serial), and booleans; non-numeric → `#VALUE!` preserving the message
   convention (`err('#VALUE!', hint)`).
5. **Autocomplete/reference** regenerate automatically. No new categories —
   the `text` category is already in `FormulaCategory` and the reference map.

## Phase 2 quick-wins worth noting

- The reference intro already documents string literals and comparison results;
  Phase 2 needs no parser changes at all unless a text builtin wants a new
  literal form (it shouldn't).
- `#NAME?` collision protection is automatic for the new names — no registry
  work beyond adding the entries.