# Handoff — Phase 4 (dates/times) complete; Phase 5 pickup points

Status: **Phase 4 implemented, tree green** on top of Phase 3 (HEAD
`d073541`; Phases 2–4 sit uncommitted in the working tree, ready to commit as
units per the earlier handoffs' convention). Source of truth for the whole
program: `docs/formula-builtins-plan.md` (Phase 4 now marked complete there).

## Tree state (verified this session)

- HEAD `d073541` (the Phase 1 commit), branch `feature/spreadsheet-editor`.
- Gates re-run on the Phase 4 revision:
  - `npm run check` → tsc clean + eslint + **all vitest passed** (Phase 3 was
    1022; the date tests added 14, taking it to 1036)
  - `npm run build` → exit 0
  - `.venv/bin/pytest tests/` → passed, backend coverage unchanged
- README supported-functions list updated; autocomplete, reference-shifting,
  and `Help → Formula Reference` picked up the new names automatically (they
  derive from `BUILTIN_FORMULAS`; the reference's `CATEGORY_ORDER` already
  included `date`).

## What Phase 4 delivered

1. **Clock injection**: `FormulaEnv` gained an optional `now?: () => Date`
   (defaults to the wall clock). `TODAY`/`NOW` are the only consumers; tests
   pin the date with `{ ...BUILTIN_ENV, now: () => new Date(2024, 5, 15, 9) }`
   and it flows through `solve(rows, env)`. Document-local definitions built
   by `formulaDefs.ts` construct their own env without a clock, so a cell calls
   `TODAY()` with the plugin env (wall clock) — that's the desired runtime
   behavior; only the solver's env needs the injection.
2. **Value model**: nothing changed — the `date` kind, `dateSerial`,
   `dateToSerial`/`serialToDate` (calendar-based, tz-independent),
   `formatDate` (`YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS`), and `toNumber`
   (date → serial) were already present from Phase 0. `→ toText` renders dates,
   and `solveCell` falls through to `toText` for date-kind results.
3. **Builders/computers**:
   - `DATE(y, m, d)` truncates each arg and normalizes month/day overflow via
     `y*12 + m` month arithmetic; honors Excel's legacy `0–1899 → +1900` year
     mapping (`DATE(100, 5, 6)` → `2000-05-06`); years outsides 0–9999 →
     `#NUM!`. `DATE(1900, 1, 0)` → `1899-12-31` (negative serials allowed).
   - `EDATE(start, months)`/`EOMONTH(start, months)` step **calendar** months
     (truncating the months argument toward zero) and clamp/pick the day
     against the target month's length (`EDATE(2024-01-31, 1)` → `2024-02-29`).
   - `TODAY()` = floor(now serial) (midnight), `NOW()` = full serial.
4. **Extractors** (`makeDatePartCall` factory + `weekdayCall`/`daysCall`):
   - `YEAR`/`MONTH`/`DAY` read the calendar parts of the truncated day;
     `HOUR`/`MINUTE`/`SECOND` read the fixed `formatDate`-style half-up-rounded
     time fraction, so extraction and display never disagree.
   - `WEEKDAY(serial, [type])`: type 1 (default) Sunday=1…Saturday=7, type 2
     Monday=1, type 3 Monday=0; any other type → `#NUM!`. Weekday math uses a
     `mod7` wrap so pre-1970 serials stay correct.
   - `DAYS(end, start)` = `trunc(end − start)` (Excel truncates toward zero),
     accepting date cells or raw serials.
   - All of these accept date values **or** plain numbers (serials) — e.g.
     `HOUR(0.5)` = 12, `DAY(0)` = 30 — via the existing `firstNumber`/`numberAt`
     coercion; anything that is not number-coercible is `#VALUE!`.

## Semantics worth preserving (Excel parity)

- The serial epoch is 1899-12-30 (`UNIX_EPOCH_SERIAL = 25569`); utilities are
  calendar-based (Howard Hinnant `days_from_civil`), so they are immune to the
  machine timezone — `dateToSerial(new Date(2024, 5, 15, 9))` always yields
  2024-06-15 serial regardless of TZ. Keep new date code on these and never
  introduce `Date.UTC`/`getTimezoneOffset` arithmetic.
- Extractors round the time fraction with the same `floor(serial*86400 + 0.5)`
  as `formatDate`; a second's decimal rounding therefore agrees with display.
- `DATE` and `EDATE`/`EOMONTH` deliberately do **not** replicate the Excel 1900
  leap-phantom-day: our `DATE(1900,2,29)` normalizes to `1900-03-01` rather
  than the serial-60 ghost, and a serial of exactly 60 renders as `1900-03-01`.
  Documented tradeoff, consistent with the display/formatting model.
- Negative serials are legal and render pre-1900 dates (`formatDate` supports
  them); `YEAR(0)` = 1899.
- The 1900-system year mapping only applies to the `DATE` constructor (0–1899
  → +1900), exactly like Excel. `dateToSerial`/`serialToDate` never remap.

## What Phase 5 needs (the actual work)

Per plan doc Phase 5 (lookup — future, out of scope, so this is a *scoping*
note rather than a pickup list):

1. `VLOOKUP`, `HLOOKUP`, `INDEX`, `MATCH`, `XLOOKUP`-style lookups are the
   plan's Phase 5; the plan explicitly defers them because they need **2D
   range semantics** the flat `set` value currently lacks.
2. Two prior simplifications were accepted pending exactly that 2D work:
   - `SUMIF`/`AVERAGEIF` sum/average ranges align **positionally by flat
     index** with the criteria range — exact for same-shape ranges, divergent
     from Excel when the two ranges differ in shape.
   - `LARGE`/`SMALL` and the criteria family flatten ranges row-major.
   Lookups should land **after** a `{ kind: 'range', ... }` geometry-aware
   value (or a parallel extraction path in `spreadsheet.ts`) so the positional
   flat-index alignment and the criteria walker can be upgraded together.
3. If Phase 5 is skipped, the next natural increment is string/conditional
   built-ins: `IFS`-adjacent `CHOOSE`, text `TEXT`/`TEXTSPLIT`, or statistical
   `STDEV`/`VAR` (straight `collectNumbers` extensions, no value-model work).
4. **Suggestions**: `EDATE`/`EOMONTH`/`DATE` are the patterns to copy for any
   future calendar builtin; `makeDatePartCall` is already the extractor
   factory. Keep volatile cells (`TODAY`/`NOW`/`RAND`/`RANDBETWEEN`) on the env
   clock / wall clock — do not cache them in document state, so re-evaluations
   stay honest.

## Operational lessons carried forward

- **Gate habit** unchanged: `npm run check` → `npm run build` →
  `.venv/bin/pytest tests/`.
- **Excel behaviors are the spec**: encode Excel's year mapping, trunc-toward-
  zero, month clamping, and weekday numbering explicitly (this phase used no
  JS `Date`-getter shortcuts for calendar math — only `daysFromCivil`/`mod7`).
- **Volatility is injectable**: any future time/random builtin should read the
  `env.now` clock (or an equivalent seam) rather than calling `Date.now()` /
  `Math.random()` inside the call body, so tests stay deterministic.
- **Four-way error-code rule still applies** if `#VALUE!`/`#NUM!` domains grow;
  this phase introduced no new codes.

## Phase 4 quick-wins worth noting

- **Zero parser and zero value-model changes**: the `date` kind, serial
  converters, and `dateToSerial` were Phase-0 infrastructure that simply had
  no producers until now. Registering the 13 functions was the whole wiring.
- `WEEKDAY`'s three numbering schemes and `EDATE`'s month clamp are the only
  genuinely fiddly logic, and both are covered by unit + e2e assertions pinned
  to real known-day checks (2024-01-01 Monday, 2024-02-29 Thursday).
- The reference's generated intro already mentioned dates (serial note), so the
  reference picked up `TODAY`/`NOW` etc. with no editorial changes.