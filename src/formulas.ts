/**
 * Formula function registry — the single source of truth for what the
 * spreadsheet parser can call.
 *
 * `spreadsheet.ts` evaluates through a `FormulaEnv` (built from this registry,
 * plus any document-local definitions), and `series.ts` derives its "this token
 * is a function name, not a cell reference" set from `BUILTIN_FUNCTION_NAMES`,
 * so adding or renaming a builtin cannot drift between the evaluator, the
 * reference-shifting code, and the generated documentation.
 */

/** A value flowing through the evaluator. `set` is a range's flattened cells;
 * `error` carries the short Excel-style code in `message` and an optional
 * human-readable `hint` for tooltips. `text` carries the cleaned/unwrapped
 * string; `boolean` is a comparison/logic result; `date` holds an Excel-style
 * serial (days since 1899-12-30 — the number `25569` is the Unix epoch) with
 * local-time semantics, formatted on display and coerced to a number for
 * arithmetic. */
export type CellValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: number }
  | { kind: 'blank' }
  | {
      kind: 'set'
      items: CellValue[]
      rows: number
      cols: number
      /** The range's top-left grid cell, e.g. 1-based `row1`/`col1` of `B2:C4`
       * is `row1: 2, col1: 2`. Only real grid ranges carry an origin; bare
       * lists (`setValue` without one) are originless single columns. */
      row1?: number
      col1?: number
    }
  | { kind: 'error'; message: string; hint?: string }

export type ErrorCell = Extract<CellValue, { kind: 'error' }>

/** A deferred argument value, produced on demand. Lazy functions (`IF` and
 * friends) receive these so an unselected branch is never evaluated; eager
 * functions get the already-forced values instead. */
export type CellValueThunk = () => CellValue

export type FormulaCategory = 'aggregate' | 'math' | 'logical' | 'text' | 'date' | 'lookup' | 'utility' | 'custom'

/** The set of callable functions available to one evaluation. Builtins are
 * always present; document definitions add to (but never override) them. */
export interface FormulaEnv {
  readonly functions: ReadonlyMap<string, FormulaFunction>
  /** Clock for the volatile cells `TODAY`/`NOW`; defaults to the wall clock when
   * omitted, so tests can pin the current date. */
  readonly now?: () => Date
}

export interface EvalContext {
  readonly env: FormulaEnv
}

export interface FormulaFunction {
  /** Canonical (display) name. */
  readonly name: string
  readonly aliases?: readonly string[]
  readonly category: FormulaCategory
  /** Human-readable call form, e.g. `ROUND(number, digits)`. */
  readonly signature: string
  readonly summary: string
  readonly example?: string
  /** Documented arity. Evaluation stays lenient for builtins so existing
   * formulas that pass extra or no arguments keep their old behavior. */
  readonly minArgs: number
  readonly maxArgs: number
  /** When true, `call` receives `() => CellValue` thunks instead of already
   * forced values, so the function can skip branches it never needs
   * (`=IF(A2=0, 0, 10/A2)` must not evaluate the division). Every document
   * definition is lazy; among the builtins, only the conditionals are. */
  readonly lazy?: boolean
  call(args: readonly (CellValue | CellValueThunk)[], ctx: EvalContext): CellValue
}

// --- Value constructors and coercion -------------------------------------

export function num(value: number): CellValue {
  return { kind: 'number', value }
}

export function blank(): CellValue {
  return { kind: 'blank' }
}

export function text(value: string): CellValue {
  return { kind: 'text', value }
}

/** A date value holding an Excel date serial (days since 1899-12-30 with a
 * fractional local time-of-day), the sibling of `num`/`text`/`bool`/`blank`. */
export function dateSerial(value: number): CellValue {
  return { kind: 'date', value }
}

export function bool(value: boolean): CellValue {
  return { kind: 'boolean', value }
}

/** A range's flattened cells, passed to aggregate functions. `rows` × `cols`
 * is the range's shape in row-major order, so lookup functions (`INDEX`,
 * `VLOOKUP`, …) can recover the 2D layout; `row1`/`col1` (optional) record the
 * range's top-left grid cell so the criteria family can pair sum cells by
 * position. A bare list without a shape is treated as a single column. */
export function setValue(
  items: CellValue[],
  rows?: number,
  cols?: number,
  row1?: number,
  col1?: number,
): CellValue {
  if (rows === undefined) rows = items.length
  if (cols === undefined) cols = 1
  return { kind: 'set', items, rows, cols, row1, col1 }
}

export function err(message: string, hint?: string): ErrorCell {
  return hint === undefined ? { kind: 'error', message } : { kind: 'error', message, hint }
}

const UNIX_EPOCH_SERIAL = 25569 // days from 1899-12-30 to 1970-01-01

/** Days from the civil epoch (1970-01-01) to a local calendar date, ignoring
 * time-of-day — Howard Hinnant's `days_from_civil`. The serial model is
 * calendar-based and timezone-independent. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = month > 2 ? month - 3 : month + 9
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Inverse of {@link daysFromCivil}: civil date → days since 1970-01-01. */
function civilFromDays(z: number): [number, number, number] {
  const shifted = z + 719468
  const era = Math.floor(shifted / 146097)
  const doe = shifted - era * 146097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  )
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return [y + (m <= 2 ? 1 : 0), m, d]
}

/** Excel-style date serial → local `Date` (`+25569` days past the 1899-12-30
 * epoch); the fractional part is the local time of day. */
export function serialToDate(serial: number): Date {
  const totalSeconds = Math.floor(serial * 86400 + 0.5)
  let days = Math.floor(totalSeconds / 86400)
  let seconds = totalSeconds - days * 86400
  if (seconds < 0) {
    days -= 1
    seconds += 86400
  }
  const [year, month, day] = civilFromDays(days - UNIX_EPOCH_SERIAL)
  const hour = Math.floor(seconds / 3600)
  const minute = Math.floor((seconds % 3600) / 60)
  return new Date(year, month - 1, day, hour, minute, seconds % 60, 0)
}

/** Local `Date` → Excel-style date serial, the inverse of {@link serialToDate}.
 * Calendar based: both the date and the time-of-day contribute to the same
 * serial regardless of the machine's timezone. */
export function dateToSerial(date: Date): number {
  const days = daysFromCivil(date.getFullYear(), date.getMonth() + 1, date.getDate())
  const seconds =
    date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000
  return days + UNIX_EPOCH_SERIAL + seconds / 86400
}

/** Display form of a date serial: `YYYY-MM-DD`, or `YYYY-MM-DD HH:MM:SS` when
 * the serial carries a fractional (time-of-day) part. */
export function formatDate(serial: number): string {
  const totalSeconds = Math.floor(serial * 86400 + 0.5)
  let days = Math.floor(totalSeconds / 86400)
  let seconds = totalSeconds - days * 86400
  if (seconds < 0) {
    days -= 1
    seconds += 86400
  }
  const [year, month, day] = civilFromDays(days - UNIX_EPOCH_SERIAL)
  const pad = (n: number): string => String(n).padStart(2, '0')
  let out = `${year}-${pad(month)}-${pad(day)}`
  if (seconds !== 0) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    out += ` ${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`
  }
  return out
}

/** Format a number for display: up to four decimals, trailing zeros dropped. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '#VALUE!'
  }
  return String(Math.round(value * 10000) / 10000)
}

export function toNumber(value: CellValue): number | null {
  switch (value.kind) {
    case 'number':
      return value.value
    case 'blank':
      return 0
    case 'boolean':
      return value.value ? 1 : 0
    case 'date':
      return value.value
    case 'text': {
      const trimmed = value.value.trim()
      if (trimmed === '') return null
      const n = Number(trimmed)
      return Number.isFinite(n) ? n : null
    }
    default:
      return null
  }
}

/** The display form of a value: `formatNumber` for numbers, `TRUE`/`FALSE`,
 * a formatted date, or the text itself. Blank, sets, and errors yield `''`
 * here — functions that want those values handle them explicitly. */
export function toText(value: CellValue): string {
  switch (value.kind) {
    case 'number':
      return formatNumber(value.value)
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE'
    case 'date':
      return formatDate(value.value)
    case 'text':
      return value.value
    default:
      return ''
  }
}

/** Excel-style truthiness for logical tests: blank is false, booleans are
 * themselves, numbers/dates (and numeric text) are `≠ 0`; non-numeric text is
 * a `#VALUE!` error, matching Excel's refusal to coerce such text to a
 * boolean. */
export function isTruthy(value: CellValue): boolean | ErrorCell {
  if (value.kind === 'boolean') return value.value
  if (value.kind === 'blank') return false
  if (value.kind === 'error') return value
  const n = toNumber(value)
  if (n === null) return err('#VALUE!', 'Expected a condition (number, TRUE/FALSE, or a date)')
  return n !== 0
}

/**
 * Flatten the numeric values of aggregate arguments, descending into `set`
 * (range) values. Text, boolean, and blank values are skipped — Excel sums
 * only numbers — but dates coerce to their serial, so `SUM` can total a date
 * column. An error propagates as the error value itself.
 */
export function collectNumbers(args: readonly CellValue[]): number[] | ErrorCell {
  const out: number[] = []
  for (const arg of args) {
    if (arg.kind === 'error') {
      return arg
    }
    if (arg.kind === 'number') {
      out.push(arg.value)
      continue
    }
    if (arg.kind === 'date') {
      out.push(arg.value)
      continue
    }
    if (arg.kind === 'set') {
      for (const item of arg.items) {
        if (item.kind === 'error') {
          return item
        }
        if (item.kind === 'number' || item.kind === 'date') {
          out.push(item.value)
        }
      }
    }
  }
  return out
}

// --- Arithmetic on evaluated values --------------------------------------

function binary(
  left: CellValue,
  right: CellValue,
  op: (a: number, b: number) => number,
  divZero = false,
): CellValue {
  if (left.kind === 'error') {
    return left
  }
  if (right.kind === 'error') {
    return right
  }
  if (left.kind === 'set' || right.kind === 'set') {
    return err('#VALUE!')
  }
  const a = toNumber(left)
  const b = toNumber(right)
  if (a === null || b === null) {
    return err('#VALUE!')
  }
  if (divZero && b === 0) {
    return err('#DIV/0!', 'Division by zero')
  }
  const result = op(a, b)
  return Number.isFinite(result) ? num(result) : err('#VALUE!')
}

export const add = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a + b)
export const sub = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a - b)
export const mul = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a * b)
export const div = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a / b, true)
export const pow = (l: CellValue, r: CellValue): CellValue => binary(l, r, (a, b) => a ** b)

export function neg(value: CellValue): CellValue {
  if (value.kind === 'error') {
    return value
  }
  const n = toNumber(value)
  if (n === null) {
    return err('#VALUE!')
  }
  return num(-n)
}

// --- Comparisons -----------------------------------------------------------

export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>='

/** A sortable key for a comparison operand. Numbers (booleans, dates, blanks,
 * and numeric text) all rank before text, as in Excel — `5 < "Apples"` is
 * TRUE. A set (range) is never a valid compare operand. */
type CompareKey = { kind: 'num'; value: number } | { kind: 'text'; value: string } | ErrorCell

function compareKey(value: CellValue): CompareKey {
  switch (value.kind) {
    case 'error':
    case 'set':
      return value.kind === 'error' ? value : err('#VALUE!')
    case 'blank':
    case 'boolean':
    case 'number':
    case 'date':
      return { kind: 'num', value: toNumber(value)! }
    case 'text': {
      const n = toNumber(value)
      return n !== null ? { kind: 'num', value: n } : { kind: 'text', value: value.value }
    }
  }
}

/** Compare two evaluated values with an Excel-style operator. Errors
 * propagate; blanks equal 0; booleans/numbers/dates compare numerically;
 * any text compares after any number. */
export function compareValues(
  left: CellValue,
  right: CellValue,
  op: CompareOp,
): CellValue {
  const a = compareKey(left)
  if (a.kind === 'error') return a
  const b = compareKey(right)
  if (b.kind === 'error') return b
  if (op === '=') {
    return bool(a.kind === b.kind && a.value === b.value)
  }
  if (op === '<>') {
    return bool(a.kind !== b.kind || a.value !== b.value)
  }
  const less = a.kind !== b.kind ? a.kind === 'num' : a.value < b.value
  const equal = a.kind === b.kind && a.value === b.value
  if (op === '<') return bool(less)
  if (op === '<=') return bool(less || equal)
  if (op === '>') return bool(!less && !equal)
  return bool(!less)
}

// --- Builtin call bodies --------------------------------------------------

function sumCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.reduce((a, b) => a + b, 0))
}

function averageCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  if (values.length === 0) return err('#DIV/0!', 'No numbers to average')
  return num(values.reduce((a, b) => a + b, 0) / values.length)
}

function minCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.length === 0 ? 0 : Math.min(...values))
}

function maxCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.length === 0 ? 0 : Math.max(...values))
}

function countCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.length)
}

function productCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  return num(values.reduce((a, b) => a * b, 1))
}

/** Read a numeric argument at `index` (blank → 0), propagating errors and
 * rejecting sets — the multi-argument sibling of `firstNumber`. */
function numberAt(args: readonly CellValue[], index: number): number | ErrorCell {
  const arg = args[index]
  if (arg === undefined) return err('#VALUE!', 'Expected a number')
  if (arg.kind === 'error') return arg
  if (arg.kind === 'set') return err('#VALUE!', 'Expected a number, not a range')
  const value = toNumber(arg)
  return value === null ? err('#VALUE!', 'Expected a number') : value
}

/** Read the single numeric first argument shared by the unary math builtins. */
function firstNumber(args: readonly CellValue[]): number | ErrorCell {
  return numberAt(args, 0)
}

function absCall(args: readonly CellValue[]): CellValue {
  const value = firstNumber(args)
  if (typeof value !== 'number') return value
  return num(Math.abs(value))
}

function sqrtCall(args: readonly CellValue[]): CellValue {
  const value = firstNumber(args)
  if (typeof value !== 'number') return value
  if (value < 0) return err('#VALUE!', 'Square root of a negative number')
  return num(Math.sqrt(value))
}

function roundCall(args: readonly CellValue[]): CellValue {
  const value = firstNumber(args)
  if (typeof value !== 'number') return value
  const digits = args.length > 1 ? (toNumber(args[1]!) ?? 0) : 0
  const factor = 10 ** digits
  return num((Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor)
}

// --- Logical builtins ------------------------------------------------------

/** Excel-style `IF`: force and test the condition, then force exactly one of
 * the value branches — never both, so `=IF(A2=0, 0, 10/A2)` stays `0` when
 * the condition is TRUE. */
function ifCall(args: readonly CellValueThunk[]): CellValue {
  const truthy = isTruthy(args[0]?.() ?? blank())
  if (typeof truthy !== 'boolean') return truthy
  if (truthy) return args[1]?.() ?? blank()
  return args[2]?.() ?? blank()
}

/** Force the value only; when it is an error, force the fallback instead. */
function ifErrorCall(args: readonly CellValueThunk[]): CellValue {
  const value = args[0]?.() ?? blank()
  if (value.kind === 'error') return args[1]?.() ?? blank()
  return value
}

/** Force each condition in turn and return the value that follows the first
 * TRUE one; force nothing after it (and nothing in the row itself ahead of
 * time). `#N/A!` when no condition matches. */
function ifsCall(args: readonly CellValueThunk[]): CellValue {
  if (args.length % 2 !== 0) {
    return err('#VALUE!', 'IFS expects condition/value pairs')
  }
  for (let i = 0; i < args.length; i += 2) {
    const truthy = isTruthy(args[i]?.() ?? blank())
    if (typeof truthy !== 'boolean') return truthy
    if (truthy) return args[i + 1]?.() ?? blank()
  }
  return err('#N/A!', 'No condition was TRUE')
}

/** Excel-style `SWITCH`: force the expression once, then scan value/result
 * pairs and return the first match (text compared case-insensitively), or the
 * trailing default, or `#N/A!`. Unmatched values — and the results after the
 * match — are never forced. */
function switchCall(args: readonly CellValueThunk[]): CellValue {
  if (args.length < 3) {
    return err('#VALUE!', 'SWITCH(expression, value, result, …) needs a value and result')
  }
  const target = args[0]!()
  if (target.kind === 'error') return target
  let i = 1
  while (i + 1 < args.length) {
    if (switchMatches(target, args[i]!())) return args[i + 1]!()
    i += 2
  }
  if (i === args.length - 1) return args[i]!()
  return err('#N/A!', 'No value matched and no default was given')
}

/** `SWITCH`'s match: both sides coerced to a number compare numerically
 * (so `5` matches `"5"`, blank matches `0`), otherwise the text forms compare
 * case-insensitively — like Excel's. Errors never match. */
function switchMatches(target: CellValue, candidate: CellValue): boolean {
  const a = toNumber(target)
  const b = toNumber(candidate)
  if (a !== null && b !== null) return a === b
  return toText(target).trim().toLowerCase() === toText(candidate).trim().toLowerCase()
}

function andCall(args: readonly CellValue[]): CellValue {
  for (const arg of args) {
    const truthy = isTruthy(arg)
    if (typeof truthy !== 'boolean') return truthy
    if (!truthy) return bool(false)
  }
  return bool(true)
}

function orCall(args: readonly CellValue[]): CellValue {
  for (const arg of args) {
    const truthy = isTruthy(arg)
    if (typeof truthy !== 'boolean') return truthy
    if (truthy) return bool(true)
  }
  return bool(false)
}

function notCall(args: readonly CellValue[]): CellValue {
  const truthy = isTruthy(args[0] ?? blank())
  if (typeof truthy !== 'boolean') return truthy
  return bool(!truthy)
}

function isErrorCall(args: readonly CellValue[]): CellValue {
  return bool(args[0]?.kind === 'error')
}

function isNumberCall(args: readonly CellValue[]): CellValue {
  const value = args[0]
  // Dates are Excel-style serials on the inside, so they count as numbers.
  return bool(value?.kind === 'number' || value?.kind === 'date')
}

function isTextCall(args: readonly CellValue[]): CellValue {
  return bool(args[0]?.kind === 'text')
}

function isBlankCall(args: readonly CellValue[]): CellValue {
  return bool(args[0]?.kind === 'blank')
}

// --- Text builtins ---------------------------------------------------------

/** The display form of the argument at `index`, for the multi-argument text
 * builtins: `''` when the argument is missing or blank, an error when the
 * argument is a set (ranges are never a single text value). Errors themselves
 * propagate. */
function nthText(args: readonly CellValue[], index: number): string | ErrorCell {
  const arg = args[index]
  if (!arg) return ''
  if (arg.kind === 'error') return arg
  if (arg.kind === 'set') return err('#VALUE!', 'Expected a single text value, not a range')
  return toText(arg)
}

/** The display form of a builtin's primary argument (`LEN`, `UPPER`, …). */
function firstText(args: readonly CellValue[]): string | ErrorCell {
  return nthText(args, 0)
}

/** Flatten the display forms of the arguments for `CONCAT`/`TEXTJOIN`,
 * walking `set` (range) values cell-by-cell in row-major order — the text twin
 * of `collectNumbers`. An error at any level propagates as that error value. A
 * blank cell — like an empty string — contributes `''`, so `TEXTJOIN` can drop
 * both wholesale when `ignoreEmpty` is set. */
function collectText(args: readonly CellValue[]): string[] | ErrorCell {
  const out: string[] = []
  for (const arg of args) {
    if (arg.kind === 'error') return arg
    if (arg.kind === 'set') {
      for (const item of arg.items) {
        if (item.kind === 'error') return item
        out.push(toText(item))
      }
    } else {
      out.push(toText(arg))
    }
  }
  return out
}

/** A numeric argument truncated to an integer (Excel `INT`), for counts and
 * positions: a missing argument takes `def`, a blank coerces to `0`; a
 * non-numeric, a set, or an error argument surfaces as its error. Negative
 * results are left to each caller to handle, since they differ — `REPT` and
 * the slicing builtins reject them while `SUBSTITUTE` treats a bad instance as
 * "leave the text alone". */
function intArg(
  args: readonly CellValue[],
  index: number,
  def: number,
  message: string,
): number | ErrorCell {
  const arg = args[index]
  if (arg === undefined) return def
  if (arg.kind === 'error') return arg
  if (arg.kind === 'set') return err('#VALUE!', 'Expected a number, not a range')
  const value = toNumber(arg)
  if (value === null) return err('#VALUE!', message)
  return Math.trunc(value)
}

function concatCall(args: readonly CellValue[]): CellValue {
  const parts = collectText(args)
  if (!Array.isArray(parts)) return parts
  return text(parts.join(''))
}

function textJoinCall(args: readonly CellValue[]): CellValue {
  const delimiter = firstText(args)
  if (typeof delimiter !== 'string') return delimiter
  const ignoreEmpty = isTruthy(args[1] ?? blank())
  if (typeof ignoreEmpty !== 'boolean') return ignoreEmpty
  const parts = collectText(args.slice(2))
  if (!Array.isArray(parts)) return parts
  const kept = ignoreEmpty ? parts.filter((part) => part !== '') : parts
  return text(kept.join(delimiter))
}

function lenCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  return num(value.length)
}

function upperCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  return text(value.toUpperCase())
}

function lowerCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  return text(value.toLowerCase())
}

function trimCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  return text(value.replace(/\s+/g, ' ').trim())
}

function leftCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  const count = intArg(args, 1, 1, 'Expected a character count')
  if (typeof count !== 'number') return count
  if (count < 0) return err('#VALUE!', 'Character count cannot be negative')
  return text(value.slice(0, count))
}

function rightCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  const count = intArg(args, 1, 1, 'Expected a character count')
  if (typeof count !== 'number') return count
  if (count < 0) return err('#VALUE!', 'Character count cannot be negative')
  if (count === 0) return text('')
  return text(value.slice(-count))
}

function midCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  const start = intArg(args, 1, 1, 'Expected a start position')
  if (typeof start !== 'number') return start
  const length = intArg(args, 2, value.length, 'Expected a character count')
  if (typeof length !== 'number') return length
  if (start < 1) return err('#VALUE!', 'MID is 1-based; the start must be at least 1')
  if (length < 0) return err('#VALUE!', 'Character count cannot be negative')
  if (start - 1 >= value.length) return text('')
  return text(value.slice(start - 1, start - 1 + length))
}

function reptCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  const times = intArg(args, 1, 0, 'Expected a repeat count')
  if (typeof times !== 'number') return times
  if (times < 0) return err('#VALUE!', 'Repeat count cannot be negative')
  if (value.length * times > 32767) {
    return err('#VALUE!', 'REPT result is larger than 32767 characters')
  }
  return text(value.repeat(times))
}

function substituteCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  const oldText = nthText(args, 1)
  if (typeof oldText !== 'string') return oldText
  const newText = nthText(args, 2)
  if (typeof newText !== 'string') return newText
  const instance = intArg(args, 3, 0, 'Expected an instance number')
  if (typeof instance !== 'number') return instance
  if (oldText === '' || instance < 0) return text(value) // nothing to replace
  if (instance === 0) return text(value.split(oldText).join(newText))
  // Replace exactly the `instance`-th occurrence (1-based); fewer occurrences
  // than asked for leaves the text unchanged.
  let seen = 0
  let from = 0
  for (;;) {
    const found = value.indexOf(oldText, from)
    if (found === -1) return text(value)
    seen++
    if (seen === instance) {
      return text(value.slice(0, found) + newText + value.slice(found + oldText.length))
    }
    from = found + oldText.length
  }
}

/** The display form `EXACT` compares: `toText` of a single value, or the
 * concatenated display forms of a set's cells, row-major. */
function exactText(value: CellValue | undefined): string | ErrorCell {
  if (!value) return ''
  if (value.kind === 'error') return value
  if (value.kind === 'set') {
    let out = ''
    for (const item of value.items) {
      if (item.kind === 'error') return item
      out += toText(item)
    }
    return out
  }
  return toText(value)
}

function exactCall(args: readonly CellValue[]): CellValue {
  const left = exactText(args[0])
  if (typeof left !== 'string') return left
  const right = exactText(args[1])
  if (typeof right !== 'string') return right
  return bool(left === right)
}

function valueCall(args: readonly CellValue[]): CellValue {
  const first = args[0]
  if (first?.kind === 'error') return first
  if (first?.kind === 'set') return err('#VALUE!', 'Expected a single value, not a range')
  if (!first || first.kind === 'blank') return num(0)
  if (first.kind === 'number') return num(first.value)
  const n = toNumber(first) // booleans → 1/0, dates → their serial, text → number
  if (n === null) return err('#VALUE!', 'Expected numeric text')
  return num(n)
}

// --- Math builtins ---------------------------------------------------------

/** Wrap a raw arithmetic result, turning overflow/NaN into #VALUE! like the
 * binary operators do. */
function mathResult(value: number): CellValue {
  return Number.isFinite(value) ? num(value) : err('#VALUE!')
}

/** Excel `MOD`: the remainder has the divisor's sign (`MOD(-3, 2)` is 1), so
 * unlike JS `%` it is `n - d * INT(n/d)` — `INT` rounding down. */
function modCall(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  const d = args[1] === undefined ? err('#VALUE!', 'MOD needs a divisor') : numberAt(args, 1)
  if (typeof d !== 'number') return d
  if (d === 0) return err('#DIV/0!', 'Division by zero')
  return num(n - d * Math.floor(n / d))
}

function intCall(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  return num(Math.floor(n))
}

function truncCall(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  const digitsArg = args[1] === undefined ? 0 : numberAt(args, 1)
  if (typeof digitsArg !== 'number') return digitsArg
  const factor = 10 ** Math.trunc(digitsArg)
  return mathResult(Math.trunc(n * factor) / factor)
}

/** The shared CEILING/FLOOR shape: both need `number` and `significance` to
 * share a sign (opposite signs are `#NUM!`, like Excel), a zero operand gives
 * zero, and `round` is applied to the quotient — `ceil` rounds away from zero,
 * `floor` toward it. */
function roundStepCall(
  args: readonly CellValue[],
  round: (x: number) => number,
  name: string,
): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  const significance = args[1] === undefined ? 1 : numberAt(args, 1)
  if (typeof significance !== 'number') return significance
  if (n === 0 || significance === 0) return num(0)
  if (Math.sign(n) !== Math.sign(significance)) {
    return err('#NUM!', `${name} number and significance must share a sign`)
  }
  return mathResult(round(n / significance) * significance)
}

function ceilingCall(args: readonly CellValue[]): CellValue {
  return roundStepCall(args, Math.ceil, 'CEILING')
}

function floorCall(args: readonly CellValue[]): CellValue {
  return roundStepCall(args, Math.floor, 'FLOOR')
}

function roundDirectionalCall(
  args: readonly CellValue[],
  round: (x: number) => number,
): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  const digitsArg = args[1] === undefined ? 0 : numberAt(args, 1)
  if (typeof digitsArg !== 'number') return digitsArg
  const factor = 10 ** Math.trunc(digitsArg)
  // Round the magnitude, then re-apply the sign: ROUNDUP away from zero,
  // ROUNDDOWN toward it.
  return mathResult((Math.sign(n) * round(Math.abs(n) * factor)) / factor)
}

function roundUpCall(args: readonly CellValue[]): CellValue {
  return roundDirectionalCall(args, Math.ceil)
}

function roundDownCall(args: readonly CellValue[]): CellValue {
  return roundDirectionalCall(args, Math.floor)
}

function signCall(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  return num(Math.sign(n))
}

function powerCall(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  const p = numberAt(args, 1)
  if (typeof p !== 'number') return p
  return mathResult(n ** p)
}

function expCall(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  return mathResult(Math.exp(n))
}

function lnCall(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  if (n <= 0) return err('#NUM!', 'LN needs a positive number')
  return mathResult(Math.log(n))
}

function logCall(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  const baseArg = args[1] === undefined ? 10 : numberAt(args, 1)
  if (typeof baseArg !== 'number') return baseArg
  if (n <= 0 || baseArg <= 0 || baseArg === 1) {
    if (baseArg === 1) return err('#DIV/0!', 'LOG base cannot be 1')
    const hint = n <= 0 ? 'LOG needs a positive number' : 'LOG base must be positive'
    return err('#NUM!', hint)
  }
  return mathResult(Math.log(n) / Math.log(baseArg))
}

function log10Call(args: readonly CellValue[]): CellValue {
  const n = firstNumber(args)
  if (typeof n !== 'number') return n
  if (n <= 0) return err('#NUM!', 'LOG10 needs a positive number')
  return mathResult(Math.log10(n))
}

function piCall(_args: readonly CellValue[]): CellValue {
  return num(Math.PI)
}

function randCall(_args: readonly CellValue[]): CellValue {
  return num(Math.random())
}

function randBetweenCall(args: readonly CellValue[]): CellValue {
  const bottom = firstNumber(args)
  if (typeof bottom !== 'number') return bottom
  const top = args[1] === undefined ? err('#VALUE!', 'RANDBETWEEN needs a top value') : numberAt(args, 1)
  if (typeof top !== 'number') return top
  const lo = Math.trunc(bottom)
  const hi = Math.trunc(top)
  if (lo > hi) return err('#NUM!', 'Bottom is greater than top')
  return num(Math.floor(Math.random() * (hi - lo + 1)) + lo)
}

// --- Utility builtins ------------------------------------------------------

function uuidCall(_args: readonly CellValue[]): CellValue {
  return text(randomUuid())
}

/** A lowercase RFC 4122 version-4 UUID, via `crypto.randomUUID` when the
 * runtime has it, else a `Math.random`-seeded fallback (the version and
 * variant bits are pinned either way). */
export function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  const fill = (arr: Uint8Array): Uint8Array => arr.map(() => Math.floor(Math.random() * 256))
  const random = fill(bytes)
  random[6] = (random[6]! & 0x0f) | 0x40
  random[8] = (random[8]! & 0x3f) | 0x80
  const hex = Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function b64encodeCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  return text(utf8ToBase64(value))
}

function b64decodeCall(args: readonly CellValue[]): CellValue {
  const value = firstText(args)
  if (typeof value !== 'string') return value
  const decoded = base64ToUtf8(value)
  if (decoded === null) return err('#VALUE!', 'Invalid base64 text')
  return text(decoded)
}

/** UTF-8 → base64 (standard alphabet, no line breaks). */
export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** base64 → UTF-8, or `null` when the text is not valid base64 (wrong
 * alphabet, wrong padding, or bytes that aren't valid UTF-8). Whitespace is
 * tolerated, so wrapped/indented values decode fine. */
export function base64ToUtf8(input: string): string | null {
  const cleaned = input.replace(/\s+/g, '')
  if (cleaned === '') return ''
  const body = cleaned.replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(body)) return null
  const remainder = body.length % 4
  const padding = cleaned.length - body.length
  const paddingMatches =
    (remainder === 0 && padding === 0) ||
    (remainder === 3 && padding === 1) ||
    (remainder === 2 && padding === 2)
  if (!paddingMatches) return null
  try {
    const binary = atob(cleaned)
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    )
  } catch {
    return null
  }
}

// --- Aggregate & criteria builtins -----------------------------------------

function medianCall(args: readonly CellValue[]): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  if (values.length === 0) return num(0)
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
  return num(median)
}

/** COUNTA counts every non-blank value — text, numbers, booleans, dates, and
 * even error cells (Excel counts errors as content), so unlike the other
 * walkers it does not propagate in-range errors. */
function countaCall(args: readonly CellValue[]): CellValue {
  let count = 0
  const bump = (value: CellValue): void => {
    if (value.kind !== 'blank') count++
  }
  for (const arg of args) {
    if (arg.kind === 'set') {
      for (const item of arg.items) bump(item)
    } else {
      bump(arg)
    }
  }
  return num(count)
}

/** An absent cell: a blank, or an explicitly empty string — both count as
 * empty for COUNTBLANK, as in Excel. */
function isBlankish(value: CellValue): boolean {
  return value.kind === 'blank' || (value.kind === 'text' && value.value === '')
}

function countblankCall(args: readonly CellValue[]): CellValue {
  let count = 0
  const bump = (value: CellValue): void => {
    if (isBlankish(value)) count++
  }
  for (const arg of args) {
    if (arg.kind === 'set') {
      for (const item of arg.items) bump(item)
    } else {
      bump(arg)
    }
  }
  return num(count)
}

/** The k-th largest/smallest numeric value of the range in `args[0]`, using the
 * integer rank in `args[1]`. Ranks outside `1..n` are `#NUM!`, matching Excel. */
function kthCall(args: readonly CellValue[], order: (a: number, b: number) => number): CellValue {
  const values = collectNumbers([args[0] ?? blank()])
  if (!Array.isArray(values)) return values
  const k = args[1] === undefined ? err('#VALUE!', 'LARGE/SMALL needs a rank') : numberAt(args, 1)
  if (typeof k !== 'number') return k
  const rank = Math.trunc(k)
  if (rank < 1) return err('#NUM!', 'The rank must be at least 1')
  if (values.length === 0) return err('#NUM!', 'The range has no numbers')
  if (rank > values.length) return err('#NUM!', 'The rank exceeds the number of values')
  const sorted = [...values].sort(order)
  return num(sorted[rank - 1]!)
}

function largeCall(args: readonly CellValue[]): CellValue {
  return kthCall(args, (a, b) => b - a)
}

function smallCall(args: readonly CellValue[]): CellValue {
  return kthCall(args, (a, b) => a - b)
}

/** A `SUMIF`/`COUNTIF`/`AVERAGEIF` range argument as a rectangle: the set's
 * cells, shape, and — when it came from a real grid range — its 1-based
 * top-left origin. Any other single value is a 1×1 rectangle at no origin
 * (blank for a missing argument, so nothing matches). */
type PairTable = { items: CellValue[]; rows: number; cols: number; row1?: number; col1?: number }

function pairTable(arg: CellValue | undefined): PairTable {
  if (arg?.kind === 'set') return arg
  if (arg === undefined) return { items: [], rows: 0, cols: 0 }
  return { items: [arg], rows: 1, cols: 1 }
}

/** The sum/avg cell paired with criterion `i` of `pred`. When both rectangles
 * carry origins, Excel-style positional pairing applies: the sum range is
 * anchored at its top-left and extended to the criteria rectangle, so cells
 * outside the sum range read as blank (0 for a numeric sum). Originless sets
 * (hand-built tables, document-function ranges) fall back to flat-index
 * pairing. */
function pairedCell(pred: PairTable, sum: PairTable, i: number): CellValue {
  if (
    pred.row1 !== undefined &&
    pred.col1 !== undefined &&
    sum.row1 !== undefined &&
    sum.col1 !== undefined
  ) {
    const row = Math.floor(i / pred.cols)
    const col = i % pred.cols
    const dr = sum.row1 + row - sum.row1
    const dc = sum.col1 + col - sum.col1
    if (dr < 0 || dr >= sum.rows || dc < 0 || dc >= sum.cols) return blank()
    return sum.items[dr * sum.cols + dc] ?? blank()
  }
  return sum.items[i] ?? blank()
}

/** A sortable key for criteria comparisons, matching Excel's ordering: numbers
 * (and numeric text, and blanks as 0) rank before text, and text compares
 * case-insensitively (`COUNTIF(A1:A9,"apples")` matches `Apples`). */
type CriterionKey = { kind: 'num'; value: number } | { kind: 'text'; value: string }

function criterionKey(value: CellValue): CriterionKey {
  const n = toNumber(value)
  return n !== null ? { kind: 'num', value: n } : { kind: 'text', value: toText(value).toLowerCase() }
}

/** Compare a cell to a criteria operand with an Excel operator. Errors and sets
 * never match. */
function matchCriterion(cell: CellValue, op: CompareOp, operand: string): boolean {
  if (cell.kind === 'error' || cell.kind === 'set') return false
  const a = criterionKey(cell)
  const b = criterionKey(text(operand))
  if (op === '=') return a.kind === b.kind && a.value === b.value
  if (op === '<>') return a.kind !== b.kind || a.value !== b.value
  const less = a.kind !== b.kind ? a.kind === 'num' : a.value < b.value
  const equal = a.kind === b.kind && a.value === b.value
  if (op === '<') return less
  if (op === '<=') return less || equal
  if (op === '>') return !less && !equal
  return !less
}

/** Split a criteria string like `">5"`, `"Apples"`, `"<>done"`, or `"A*"` into
 * an operator and an operand. The equality family (`=`/`<>`/bare) supports
 * `*`/`?` wildcards with a `~` escape, matched against text cells only. A
 * dangling operator (`">"`) is the one malformed criteria and surfaces as
 * `#VALUE!`. */
function parseCriteria(
  criteria: string,
): ((cell: CellValue) => boolean) | ErrorCell {
  let op: CompareOp = '='
  let operand = criteria
  for (const opText of ['<>', '<=', '>=', '=', '<', '>'] as const) {
    if (criteria.startsWith(opText)) {
      op = opText
      operand = criteria.slice(opText.length)
      break
    }
  }
  if (op !== '=' && operand === '') {
    return err('#VALUE!', 'Criteria needs a value after the operator')
  }
  if (hasWildcard(operand) && (op === '=' || op === '<>')) {
    const re = wildcardRegex(operand)
    const exact = op === '='
    return (cell) => {
      if (cell.kind === 'error' || cell.kind === 'set') return false
      const matches = cell.kind === 'text' && re.test(cell.value)
      return exact ? matches : !matches
    }
  }
  return (cell) => matchCriterion(cell, op, operand)
}

/** True when a criteria operand uses wildcard syntax (`*`, `?`, or a `~`
 * escape), so the equality family matches text patterns instead of literals. */
function hasWildcard(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?') || pattern.includes('~')
}

/** An anchored, case-insensitive regex for a criteria pattern: `*` matches any
 * run of characters, `?` any single character, `~` escapes the next character
 * (`"~*"` matches a literal `*`). */
function wildcardRegex(pattern: string): RegExp {
  const escape = (ch: string): string => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '~') {
      const next = pattern[i + 1]
      if (next !== undefined) {
        out += escape(next)
        i++
      } else {
        out += '\\~'
      }
    } else if (ch === '*') {
      out += '.*'
    } else if (ch === '?') {
      out += '.'
    } else {
      out += escape(ch)
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

function sumIfCall(args: readonly CellValue[]): CellValue {
  const predicate = parseCriteriaFromArgs(args)
  if (typeof predicate !== 'function') return predicate
  if (args[0]?.kind === 'error') return args[0]
  if (args[2]?.kind === 'error') return args[2]
  const pred = pairTable(args[0])
  const sum = args[2] === undefined ? pred : pairTable(args[2])
  let total = 0
  for (let i = 0; i < pred.items.length; i++) {
    if (!predicate(pred.items[i]!)) continue
    const n = toNumber(pairedCell(pred, sum, i))
    if (n !== null) total += n // non-numeric sum cells are ignored, as in Excel
  }
  return num(total)
}

function countIfCall(args: readonly CellValue[]): CellValue {
  const predicate = parseCriteriaFromArgs(args)
  if (typeof predicate !== 'function') return predicate
  if (args[0]?.kind === 'error') return args[0]
  const pred = pairTable(args[0])
  let count = 0
  for (const cell of pred.items) {
    if (predicate(cell)) count++
  }
  return num(count)
}

function averageIfCall(args: readonly CellValue[]): CellValue {
  const predicate = parseCriteriaFromArgs(args)
  if (typeof predicate !== 'function') return predicate
  if (args[0]?.kind === 'error') return args[0]
  if (args[2]?.kind === 'error') return args[2]
  const pred = pairTable(args[0])
  const avg = args[2] === undefined ? pred : pairTable(args[2])
  let total = 0
  let count = 0
  for (let i = 0; i < pred.items.length; i++) {
    if (!predicate(pred.items[i]!)) continue
    const n = toNumber(pairedCell(pred, avg, i))
    if (n !== null) {
      total += n
      count++
    }
  }
  if (count === 0) return err('#DIV/0!', 'No cells matched the criteria')
  return num(total / count)
}

/** The criteria text shared by the SUMIF family, parsed once. */
function parseCriteriaFromArgs(args: readonly CellValue[]): ((cell: CellValue) => boolean) | ErrorCell {
  const criteria = nthText(args, 1)
  if (typeof criteria !== 'string') return criteria
  return parseCriteria(criteria)
}

// --- Dates and times -------------------------------------------------------

/** The calendar date parts (year, month, day) of a serial, ignoring any
 * time-of-day fraction — the proleptic Gregorian reading shared by the date
 * extractors and the `EDATE`/`EOMONTH` month arithmetic. */
function serialDateParts(serial: number): [number, number, number] {
  return civilFromDays(Math.floor(serial) - UNIX_EPOCH_SERIAL)
}

/** The rounded time-of-day parts (hours, minutes, seconds) of a serial, using
 * the same half-up rounding as `formatDate` so extraction and display agree. */
function serialTimeParts(serial: number): [number, number, number] {
  const totalSeconds = Math.floor(serial * 86400 + 0.5)
  let days = Math.floor(totalSeconds / 86400)
  let seconds = totalSeconds - days * 86400
  if (seconds < 0) {
    days -= 1
    seconds += 86400
  }
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
}

/** Days in a civil month (month is 1–12), proleptic Gregorian. */
function daysInMonth(year: number, month: number): number {
  if (month === 12) return daysFromCivil(year + 1, 1, 1) - daysFromCivil(year, 12, 1)
  return daysFromCivil(year, month + 1, 1) - daysFromCivil(year, month, 1)
}

/** Non-negative `x mod 7`, so weekday math stays correct before 1970. */
function mod7(x: number): number {
  return ((x % 7) + 7) % 7
}

/** The environment's clock as a serial (wall clock by default). */
function nowSerial(ctx: EvalContext): number {
  return dateToSerial(ctx.env.now?.() ?? new Date())
}

function todayCall(_args: readonly CellValue[], ctx: EvalContext): CellValue {
  return dateSerial(Math.floor(nowSerial(ctx)))
}

function nowCall(_args: readonly CellValue[], ctx: EvalContext): CellValue {
  return dateSerial(nowSerial(ctx))
}

/** `DATE(year, month, day)` — normalizes month/day overflow and honors Excel's
 * legacy "years 0–1899 mean +1900" mapping; month/day may be anything. */
function dateCall(args: readonly CellValue[]): CellValue {
  const year = numberAt(args, 0)
  const month = numberAt(args, 1)
  const day = numberAt(args, 2)
  if (typeof year !== 'number') return year
  if (typeof month !== 'number') return month
  if (typeof day !== 'number') return day
  let y = Math.trunc(year)
  if (y >= 0 && y <= 1899) y += 1900
  if (y < 1900 || y > 9999) return err('#NUM!', 'DATE year must be 1900–9999')
  const totalMonths = y * 12 + (Math.trunc(month) - 1)
  const cy = Math.floor(totalMonths / 12)
  const cm = totalMonths % 12 + 1
  return dateSerial(daysFromCivil(cy, cm, Math.trunc(day)) + UNIX_EPOCH_SERIAL)
}

/** Build the unary extraction calls (`YEAR`/`MONTH`/`DAY`, `HOUR`/…/`SECOND`):
 * each reads one serial-coerced argument (a date cell or a plain number) and
 * returns the matching component. */
function makeDatePartCall(
  pick: (serial: number) => number,
): (args: readonly CellValue[]) => CellValue {
  return (args: readonly CellValue[]) => {
    const serial = firstNumber(args)
    if (typeof serial !== 'number') return serial
    return num(pick(serial))
  }
}

const yearCall = makeDatePartCall((serial) => serialDateParts(serial)[0])
const monthCall = makeDatePartCall((serial) => serialDateParts(serial)[1])
const dayCall = makeDatePartCall((serial) => serialDateParts(serial)[2])
const hourCall = makeDatePartCall((serial) => serialTimeParts(serial)[0])
const minuteCall = makeDatePartCall((serial) => serialTimeParts(serial)[1])
const secondCall = makeDatePartCall((serial) => serialTimeParts(serial)[2])

/** `WEEKDAY(serial, [type])` — type 1 (default) Sunday=1…Saturday=7, type 2
 * Monday=1…Sunday=7, type 3 Monday=0…Sunday=6; any other type is `#NUM!`. */
function weekdayCall(args: readonly CellValue[]): CellValue {
  const serial = firstNumber(args)
  if (typeof serial !== 'number') return serial
  let type = 1
  const typeArg = args[1]
  if (typeArg !== undefined && typeArg.kind !== 'blank') {
    const coerced = numberAt([typeArg], 0)
    if (typeof coerced !== 'number') return coerced
    type = Math.trunc(coerced)
  }
  if (type !== 1 && type !== 2 && type !== 3) {
    return err('#NUM!', 'WEEKDAY type must be 1, 2, or 3')
  }
  let weekday = mod7(Math.floor(serial) - UNIX_EPOCH_SERIAL + 4) // 0 = Sunday … 6 = Saturday
  if (type === 2) weekday = ((weekday + 6) % 7) + 1
  else if (type === 3) weekday = mod7(weekday + 6)
  else weekday = weekday + 1
  return num(weekday)
}

/** `DAYS(end, start)` — the difference of two serial-coerced values, truncated
 * toward zero (Excel truncates, so fractional serials don't round up). */
function daysCall(args: readonly CellValue[]): CellValue {
  const end = firstNumber(args)
  const start = numberAt(args, 1)
  if (typeof end !== 'number') return end
  if (typeof start !== 'number') return start
  return num(Math.trunc(end - start))
}

/** Shared `EDATE`/`EOMONTH` machinery: add a truncated number of months to a
 * date-like serial, clamping (EDATE) or taking the end-of-month (EOMONTH) as
 * the day, exactly as Excel's calendar months behave (`Jan 31 + 1M` → Feb 29). */
function monthAddCall(
  args: readonly CellValue[],
  atMonthEnd: boolean,
): CellValue {
  const start = firstNumber(args)
  const months = numberAt(args, 1)
  if (typeof start !== 'number') return start
  if (typeof months !== 'number') return months
  const [y, m] = serialDateParts(start)
  const totalMonths = y * 12 + (m - 1) + Math.trunc(months)
  const ty = Math.floor(totalMonths / 12)
  const tm = totalMonths % 12 + 1
  const day = atMonthEnd ? daysInMonth(ty, tm) : Math.min(serialDateParts(start)[2], daysInMonth(ty, tm))
  return dateSerial(daysFromCivil(ty, tm, day) + UNIX_EPOCH_SERIAL)
}

function edateCall(args: readonly CellValue[]): CellValue {
  return monthAddCall(args, false)
}

function eomonthCall(args: readonly CellValue[]): CellValue {
  return monthAddCall(args, true)
}

// --- Lookups ---------------------------------------------------------------

/** Normalize any value to a lookup table: a set keeps its geometry; any other
 * value (scalar, blank) is a one-cell table. Errors propagate. */
function tableCells(
  arg: CellValue | undefined,
): { cells: CellValue[]; rows: number; cols: number } | ErrorCell {
  if (arg?.kind === 'set') return { cells: arg.items, rows: arg.rows, cols: arg.cols }
  if (arg === undefined || arg.kind === 'blank') return { cells: [], rows: 0, cols: 0 }
  if (arg.kind === 'error') return arg
  return { cells: [arg], rows: 1, cols: 1 }
}

/** The app's sort key ordering (numbers before text, case-insensitive text):
 * true when `a` sorts strictly before `b`. */
function keyLess(a: CriterionKey, b: CriterionKey): boolean {
  return a.kind !== b.kind ? a.kind === 'num' : a.value < b.value
}

/** Read an optional truncatable index argument, defaulting to `fallback`. */
function optionalIntAt(
  args: readonly CellValue[],
  index: number,
  fallback: number,
): number | ErrorCell {
  const arg = args[index]
  if (arg === undefined || arg.kind === 'blank') return fallback
  const n = numberAt([arg], 0)
  return typeof n !== 'number' ? n : Math.trunc(n)
}

/** `INDEX(array, [row_num], [col_num])` — the value at a 1-based position.
 * Omitted coordinates default to 1, so `INDEX(A2:A4, 2)` and `INDEX(A2:C2, 2)`
 * both read the second cell (a single index into a one-row range runs along
 * the row); a multi-column array with only `row_num` reads the first column
 * (Excel's spill behavior is out of scope). */
function indexCall(args: readonly CellValue[]): CellValue {
  const table = tableCells(args[0])
  if (!('cells' in table)) return table
  if (table.rows === 0 || table.cols === 0) return err('#REF!', 'INDEX needs a range')
  let rowNum = optionalIntAt(args, 1, 1)
  if (typeof rowNum !== 'number') return rowNum
  let colNum = optionalIntAt(args, 2, 1)
  if (typeof colNum !== 'number') return colNum
  const singleIndex =
    args[1] !== undefined && args[1].kind !== 'blank' && (args[2] === undefined || args[2].kind === 'blank')
  if (singleIndex && table.rows === 1 && table.cols > 1) {
    colNum = rowNum
    rowNum = 1
  }
  if (rowNum < 1 || colNum < 1) return err('#VALUE!', 'INDEX row and column must be 1 or greater')
  if (rowNum > table.rows || colNum > table.cols) {
    return err('#REF!', 'INDEX is outside the range')
  }
  return table.cells[(rowNum - 1) * table.cols + (colNum - 1)] ?? blank()
}

/** `MATCH(lookup_value, lookup_array, [match_type])` — the 1-based position of
 * a value in a single row or column. Type 0 is an exact match
 * (case-insensitive text), 1 default approximates "largest ≤" on ascending
 * data, −1 "smallest ≥" on descending; the scans are linear so unsorted data
 * still returns the best value deterministically. */
function matchCall(args: readonly CellValue[]): CellValue {
  const lookupValue = args[0]
  if (lookupValue?.kind === 'error') return lookupValue
  const table = tableCells(args[1])
  if (!('cells' in table)) return table
  if (table.rows > 1 && table.cols > 1) {
    return err('#N/A!', 'MATCH needs a single row or column')
  }
  if (table.rows === 0 || table.cols === 0) return err('#N/A!', 'MATCH needs a range')
  const matchType = optionalIntAt(args, 2, 1)
  if (typeof matchType !== 'number') return matchType
  if (matchType !== -1 && matchType !== 0 && matchType !== 1) {
    return err('#N/A!', 'MATCH type must be -1, 0, or 1')
  }
  const lookupKey = criterionKey(lookupValue ?? blank())
  const vector = table.cells
  if (matchType === 0) {
    for (let i = 0; i < vector.length; i++) {
      const key = criterionKey(vector[i]!)
      if (key.kind === lookupKey.kind && key.value === lookupKey.value) {
        return num(i + 1)
      }
    }
    return err('#N/A!', 'MATCH found no exact match')
  }
  let bestIndex = -1
  let bestKey: CriterionKey | null = null
  for (let i = 0; i < vector.length; i++) {
    const key = criterionKey(vector[i]!)
    const eligible =
      matchType === 1 ? !keyLess(lookupKey, key) : !keyLess(key, lookupKey)
    if (!eligible) continue
    const replaces = bestIndex === -1 ? true : matchType === 1 ? !keyLess(key, bestKey!) : keyLess(key, bestKey!)
    if (replaces) {
      bestIndex = i
      bestKey = key
    }
  }
  if (bestIndex === -1) return err('#N/A!', 'MATCH found no value in range')
  return num(bestIndex + 1)
}

/** Shared `VLOOKUP`/`HLOOKUP` machinery: match `lookup_value` against the
 * first column (or first row, when `horizontal`) and return the cell `indexNum`
 * places further in. `range_lookup` TRUE/omitted approximate-matches assuming
 * ascending order; FALSE requires an exact (case-insensitive) match. */
function lookupLikeCall(args: readonly CellValue[], horizontal: boolean): CellValue {
  const lookupValue = args[0]
  if (lookupValue?.kind === 'error') return lookupValue
  const table = tableCells(args[1])
  if (!('cells' in table)) return table
  if (table.rows === 0 || table.cols === 0) {
    return err('#REF!', 'VLOOKUP/HLOOKUP needs a range with at least one cell')
  }
  const indexNum = numberAt(args, 2)
  if (typeof indexNum !== 'number') return indexNum
  const column = Math.trunc(indexNum)
  if (column < 1) return err('#VALUE!', 'VLOOKUP/HLOOKUP index must be 1 or greater')
  const maxIndex = horizontal ? table.rows : table.cols
  if (column > maxIndex) return err('#REF!', 'VLOOKUP/HLOOKUP index is outside the range')
  const rangeArg = args[3]
  let approximate = true
  if (rangeArg !== undefined && rangeArg.kind !== 'blank') {
    if (rangeArg.kind === 'boolean') approximate = rangeArg.value
    else if (rangeArg.kind === 'number' || rangeArg.kind === 'date') approximate = rangeArg.value !== 0
    else if (rangeArg.kind === 'text') {
      const n = toNumber(rangeArg)
      if (n === null) return err('#VALUE!', 'range_lookup must be TRUE or FALSE')
      approximate = n !== 0
    } else {
      return err('#VALUE!', 'range_lookup must be TRUE or FALSE')
    }
  }
  const edgeLength = horizontal ? table.cols : table.rows
  const edge: CellValue[] = Array.from(
    { length: edgeLength },
    (_, i) => table.cells[horizontal ? i : i * table.cols]!,
  )
  const lookupKey = criterionKey(lookupValue ?? blank())
  const pick = (edgeIndex: number): CellValue => {
    const flat = horizontal ? (column - 1) * table.cols + edgeIndex : edgeIndex * table.cols + (column - 1)
    return table.cells[flat] ?? blank()
  }
  if (!approximate) {
    for (let i = 0; i < edgeLength; i++) {
      const key = criterionKey(edge[i]!)
      if (key.kind === lookupKey.kind && key.value === lookupKey.value) {
        return pick(i)
      }
    }
    return err('#N/A!', 'No exact match found in the first column')
  }
  let bestIndex = -1
  let bestKey: CriterionKey | null = null
  for (let i = 0; i < edgeLength; i++) {
    const key = criterionKey(edge[i]!)
    if (keyLess(lookupKey, key)) continue // only values ≤ lookup eligible
    if (bestIndex === -1 || !keyLess(key, bestKey!)) {
      bestIndex = i
      bestKey = key
    }
  }
  if (bestIndex === -1) return err('#N/A!', 'No value fits the range lookup')
  return pick(bestIndex)
}

function vlookupCall(args: readonly CellValue[]): CellValue {
  return lookupLikeCall(args, false)
}

function hlookupCall(args: readonly CellValue[]): CellValue {
  return lookupLikeCall(args, true)
}

// --- Capstone builtins -----------------------------------------------------

/** `CHOOSE(index, value, [value2], …)` — the value at a 1-based position.
 * Lazy like `IF`: everything except the selected argument stays unevaluated.
 * The index is truncated toward zero; values outside the argument list →
 * `#VALUE!`. */
function chooseCall(args: readonly CellValueThunk[]): CellValue {
  if (args.length < 2) {
    return err('#VALUE!', 'CHOOSE needs an index and at least one value')
  }
  const indexVal = args[0]!()
  if (indexVal.kind === 'error') return indexVal
  const index = toNumber(indexVal)
  if (index === null) return err('#VALUE!', 'CHOOSE index must be a number')
  const position = Math.trunc(index)
  if (position < 1 || position > args.length - 1) {
    return err('#VALUE!', 'CHOOSE index is outside the range')
  }
  return args[position]!()
}

/** Sample standard deviation/variance over the numeric values of the range —
 * booleans and blanks are skipped exactly as `SUM`'s `collectNumbers` does,
 * and fewer than two values → `#DIV/0!` (Excel divides by n−1). */
function deviationCall(args: readonly CellValue[], sqrt: boolean): CellValue {
  const values = collectNumbers(args)
  if (!Array.isArray(values)) return values
  if (values.length < 2) return err('#DIV/0!', 'STDEV/VAR needs at least two numbers')
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1)
  return num(sqrt ? Math.sqrt(variance) : variance)
}

function stdevCall(args: readonly CellValue[]): CellValue {
  return deviationCall(args, true)
}

function varCall(args: readonly CellValue[]): CellValue {
  return deviationCall(args, false)
}

/** `XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found],
 * [match_mode], [search_mode])` — vector lookup along a single row or column.
 * Exact match by default, case-insensitive like the rest of the engine;
 * `match_mode` 0 exact, −1 exact-or-next-smaller, 1 exact-or-next-larger,
 * 2 wildcard (`*`/`?`, `~` escape, text cells only). `search_mode` 1 (default)
 * scans first-to-last, −1 last-to-first; the scans are linear, so there are no
 * binary modes. Nothing matches → `if_not_found` or `#N/A!`. */
function xlookupCall(args: readonly CellValue[]): CellValue {
  const lookupValue = args[0]
  if (lookupValue?.kind === 'error') return lookupValue
  const lookup = tableCells(args[1])
  if (!('cells' in lookup)) return lookup
  const ret = tableCells(args[2])
  if (!('cells' in ret)) return ret
  if (lookup.rows > 1 && lookup.cols > 1) {
    return err('#VALUE!', 'XLOOKUP needs a single row or column to search')
  }
  if (ret.rows > 1 && ret.cols > 1) {
    return err('#VALUE!', 'XLOOKUP needs a single row or column to return')
  }
  if (lookup.cells.length !== ret.cells.length) {
    return err('#VALUE!', 'XLOOKUP arrays must be the same size')
  }
  const matchMode = optionalIntAt(args, 4, 0)
  if (typeof matchMode !== 'number') return matchMode
  if (matchMode !== -1 && matchMode !== 0 && matchMode !== 1 && matchMode !== 2) {
    return err('#VALUE!', 'XLOOKUP match_mode must be -1, 0, 1, or 2')
  }
  const searchMode = optionalIntAt(args, 5, 1)
  if (typeof searchMode !== 'number') return searchMode
  if (searchMode !== -1 && searchMode !== 1) {
    return err('#VALUE!', 'XLOOKUP search_mode must be 1 or -1')
  }
  const notFound = args[3] === undefined || args[3].kind === 'blank' ? null : args[3]
  const indices = Array.from({ length: lookup.cells.length }, (_, i) =>
    searchMode === 1 ? i : lookup.cells.length - 1 - i,
  )
  const lookupKey = criterionKey(lookupValue ?? blank())
  const keyMatches = (key: CriterionKey): boolean =>
    key.kind === lookupKey.kind && key.value === lookupKey.value
  if (matchMode === 0) {
    for (const i of indices) {
      if (keyMatches(criterionKey(lookup.cells[i]!))) return ret.cells[i]!
    }
    return notFound ?? err('#N/A!', 'XLOOKUP found no exact match')
  }
  if (matchMode === 2) {
    if (lookupValue?.kind === 'text') {
      const re = wildcardRegex(lookupValue.value)
      for (const i of indices) {
        const cell = lookup.cells[i]!
        if (cell.kind === 'text' && re.test(cell.value)) return ret.cells[i]!
      }
    }
    return notFound ?? err('#N/A!', 'XLOOKUP wildcard matched nothing')
  }
  // Next-smaller (−1, expect ascending) / next-larger (1, expect descending):
  // an exact hit wins; otherwise the largest ≤ or the smallest ≥ key.
  for (const i of indices) {
    if (keyMatches(criterionKey(lookup.cells[i]!))) return ret.cells[i]!
  }
  let bestIndex: number | null = null
  let bestKey: CriterionKey | null = null
  for (const i of indices) {
    const key = criterionKey(lookup.cells[i]!)
    const eligible = matchMode === -1 ? !keyLess(lookupKey, key) : !keyLess(key, lookupKey)
    if (!eligible) continue
    const replaces =
      bestIndex === null ||
      (matchMode === -1 ? keyLess(bestKey!, key) : keyLess(key, bestKey!))
    if (replaces) {
      bestIndex = i
      bestKey = key
    }
  }
  if (bestIndex === null) {
    return notFound ?? err('#N/A!', 'XLOOKUP found no value in range')
  }
  return ret.cells[bestIndex]!
}

// --- Builtin registry -----------------------------------------------------

export const BUILTIN_FORMULAS: readonly FormulaFunction[] = [
  {
    name: 'SUM',
    category: 'aggregate',
    signature: 'SUM(number, …)',
    summary: 'Adds numbers, cell references, and ranges.',
    example: '=SUM(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: sumCall,
  },
  {
    name: 'AVERAGE',
    aliases: ['AVG'],
    category: 'aggregate',
    signature: 'AVERAGE(number, …)',
    summary: 'Arithmetic mean of the numbers and ranges.',
    example: '=AVERAGE(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: averageCall,
  },
  {
    name: 'MIN',
    category: 'aggregate',
    signature: 'MIN(number, …)',
    summary: 'Smallest of the numbers and ranges (0 when none).',
    example: '=MIN(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: minCall,
  },
  {
    name: 'MAX',
    category: 'aggregate',
    signature: 'MAX(number, …)',
    summary: 'Largest of the numbers and ranges (0 when none).',
    example: '=MAX(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: maxCall,
  },
  {
    name: 'COUNT',
    category: 'aggregate',
    signature: 'COUNT(value, …)',
    summary: 'How many numeric values the arguments and ranges hold.',
    example: '=COUNT(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: countCall,
  },
  {
    name: 'PRODUCT',
    category: 'aggregate',
    signature: 'PRODUCT(number, …)',
    summary: 'Multiplies the numbers and ranges together (1 when none).',
    example: '=PRODUCT(B2:B4)',
    minArgs: 0,
    maxArgs: Infinity,
    call: productCall,
  },
  {
    name: 'MEDIAN',
    category: 'aggregate',
    signature: 'MEDIAN(number, …)',
    summary: 'The middle value of the numbers and ranges once sorted.',
    example: '=MEDIAN(B2:B9)',
    minArgs: 0,
    maxArgs: Infinity,
    call: medianCall,
  },
  {
    name: 'COUNTA',
    category: 'aggregate',
    signature: 'COUNTA(value, …)',
    summary: 'How many non-empty values the arguments and ranges hold.',
    example: '=COUNTA(A2:C4)',
    minArgs: 0,
    maxArgs: Infinity,
    call: countaCall,
  },
  {
    name: 'COUNTBLANK',
    category: 'aggregate',
    signature: 'COUNTBLANK(value, …)',
    summary: 'How many empty cells (and empty strings) the ranges hold.',
    example: '=COUNTBLANK(A2:C4)',
    minArgs: 0,
    maxArgs: Infinity,
    call: countblankCall,
  },
  {
    name: 'LARGE',
    category: 'aggregate',
    signature: 'LARGE(array, k)',
    summary: 'The k-th largest value of a range (1 is the largest).',
    example: '=LARGE(A2:C4, 2)',
    minArgs: 2,
    maxArgs: 2,
    call: largeCall,
  },
  {
    name: 'SMALL',
    category: 'aggregate',
    signature: 'SMALL(array, k)',
    summary: 'The k-th smallest value of a range (1 is the smallest).',
    example: '=SMALL(A2:C4, 2)',
    minArgs: 2,
    maxArgs: 2,
    call: smallCall,
  },
  {
    name: 'SUMIF',
    category: 'aggregate',
    signature: 'SUMIF(range, criteria, [sumRange])',
    summary: 'Adds the cells whose matching range cells meet the criteria (">5", "Apples").',
    example: '=SUMIF(A2:A9, ">5")',
    minArgs: 2,
    maxArgs: 3,
    call: sumIfCall,
  },
  {
    name: 'COUNTIF',
    category: 'aggregate',
    signature: 'COUNTIF(range, criteria)',
    summary: 'Counts the cells that meet the criteria (">5", "Apples").',
    example: '=COUNTIF(A2:A9, ">5")',
    minArgs: 2,
    maxArgs: 2,
    call: countIfCall,
  },
  {
    name: 'AVERAGEIF',
    category: 'aggregate',
    signature: 'AVERAGEIF(range, criteria, [averageRange])',
    summary: 'Averages the cells whose matching range cells meet the criteria.',
    example: '=AVERAGEIF(A2:A9, ">5")',
    minArgs: 2,
    maxArgs: 3,
    call: averageIfCall,
  },
  {
    name: 'ABS',
    category: 'math',
    signature: 'ABS(number)',
    summary: 'Absolute value of a number.',
    example: '=ABS(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: absCall,
  },
  {
    name: 'SQRT',
    category: 'math',
    signature: 'SQRT(number)',
    summary: 'Square root of a non-negative number.',
    example: '=SQRT(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: sqrtCall,
  },
  {
    name: 'ROUND',
    category: 'math',
    signature: 'ROUND(number, [digits])',
    summary: 'Rounds a number to the given decimal places (default 0).',
    example: '=ROUND(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: roundCall,
  },
  {
    name: 'MOD',
    category: 'math',
    signature: 'MOD(number, divisor)',
    summary: 'The remainder of a division; its sign follows the divisor (Excel MOD).',
    example: '=MOD(B2, 3)',
    minArgs: 2,
    maxArgs: 2,
    call: modCall,
  },
  {
    name: 'INT',
    category: 'math',
    signature: 'INT(number)',
    summary: 'Rounds a number down to the nearest integer.',
    example: '=INT(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: intCall,
  },
  {
    name: 'TRUNC',
    category: 'math',
    signature: 'TRUNC(number, [digits])',
    summary: 'Truncates a number toward zero, keeping the given decimal places.',
    example: '=TRUNC(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: truncCall,
  },
  {
    name: 'CEILING',
    category: 'math',
    signature: 'CEILING(number, [significance])',
    summary: 'Rounds a number away from zero to the nearest multiple of significance (same sign required).',
    example: '=CEILING(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: ceilingCall,
  },
  {
    name: 'FLOOR',
    category: 'math',
    signature: 'FLOOR(number, [significance])',
    summary: 'Rounds a number toward zero to the nearest multiple of significance (same sign required).',
    example: '=FLOOR(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: floorCall,
  },
  {
    name: 'ROUNDUP',
    category: 'math',
    signature: 'ROUNDUP(number, [digits])',
    summary: 'Rounds a number away from zero to the given decimal places.',
    example: '=ROUNDUP(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: roundUpCall,
  },
  {
    name: 'ROUNDDOWN',
    category: 'math',
    signature: 'ROUNDDOWN(number, [digits])',
    summary: 'Rounds a number toward zero to the given decimal places.',
    example: '=ROUNDDOWN(B2, 0)',
    minArgs: 1,
    maxArgs: 2,
    call: roundDownCall,
  },
  {
    name: 'SIGN',
    category: 'math',
    signature: 'SIGN(number)',
    summary: '1 for a positive number, -1 for a negative one, 0 for zero.',
    example: '=SIGN(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: signCall,
  },
  {
    name: 'POWER',
    category: 'math',
    signature: 'POWER(number, power)',
    summary: 'Raises a number to a power (same as the ^ operator).',
    example: '=POWER(B2, 2)',
    minArgs: 2,
    maxArgs: 2,
    call: powerCall,
  },
  {
    name: 'EXP',
    category: 'math',
    signature: 'EXP(number)',
    summary: 'e raised to a power.',
    example: '=EXP(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: expCall,
  },
  {
    name: 'LN',
    category: 'math',
    signature: 'LN(number)',
    summary: 'Natural logarithm of a positive number.',
    example: '=LN(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: lnCall,
  },
  {
    name: 'LOG',
    category: 'math',
    signature: 'LOG(number, [base])',
    summary: 'Logarithm of a positive number, to a given base (default 10).',
    example: '=LOG(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: logCall,
  },
  {
    name: 'LOG10',
    category: 'math',
    signature: 'LOG10(number)',
    summary: 'Base-10 logarithm of a positive number.',
    example: '=LOG10(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: log10Call,
  },
  {
    name: 'PI',
    category: 'math',
    signature: 'PI()',
    summary: 'The constant π (3.14159…).',
    example: '=PI()',
    minArgs: 0,
    maxArgs: 0,
    call: piCall,
  },
  {
    name: 'RAND',
    category: 'math',
    signature: 'RAND()',
    summary: 'A random number between 0 and 1 (recomputed when the table changes).',
    example: '=RAND()',
    minArgs: 0,
    maxArgs: 0,
    call: randCall,
  },
  {
    name: 'RANDBETWEEN',
    category: 'math',
    signature: 'RANDBETWEEN(bottom, top)',
    summary: 'A random whole number between bottom and top, inclusive.',
    example: '=RANDBETWEEN(1, 6)',
    minArgs: 2,
    maxArgs: 2,
    call: randBetweenCall,
  },
  {
    name: 'IF',
    category: 'logical',
    signature: 'IF(condition, valueIfTrue, [valueIfFalse])',
    summary: 'Returns the second argument when the first is TRUE, the third otherwise.',
    example: '=IF(B2>5, "High", "Low")',
    minArgs: 2,
    maxArgs: 3,
    lazy: true,
    call: ifCall,
  },
  {
    name: 'IFERROR',
    category: 'logical',
    signature: 'IFERROR(value, [valueIfError])',
    summary: 'Returns the value, or the second argument when the first is an error.',
    example: '=IFERROR(10/A2, "—")',
    minArgs: 1,
    maxArgs: 2,
    lazy: true,
    call: ifErrorCall,
  },
  {
    name: 'IFS',
    category: 'logical',
    signature: 'IFS(condition1, value1, …)',
    summary: 'Returns the value that follows the first TRUE condition; #N/A! when none match.',
    example: '=IFS(B2>90, "A", B2>80, "B", TRUE, "C")',
    minArgs: 2,
    maxArgs: Infinity,
    lazy: true,
    call: ifsCall,
  },
  {
    name: 'SWITCH',
    category: 'logical',
    signature: 'SWITCH(expression, value1, result1, …, [default])',
    summary: 'Matches the expression against the given values, case-insensitively for text, and returns the first matching result.',
    example: '=SWITCH(B2, "red", 1, "blue", 2, "other")',
    minArgs: 3,
    maxArgs: Infinity,
    lazy: true,
    call: switchCall,
  },
  {
    name: 'AND',
    category: 'logical',
    signature: 'AND(logical, …)',
    summary: 'TRUE when every argument is TRUE.',
    example: '=AND(B2>0, C2>0)',
    minArgs: 1,
    maxArgs: Infinity,
    call: andCall,
  },
  {
    name: 'OR',
    category: 'logical',
    signature: 'OR(logical, …)',
    summary: 'TRUE when any argument is TRUE.',
    example: '=OR(B2<0, C2<0)',
    minArgs: 1,
    maxArgs: Infinity,
    call: orCall,
  },
  {
    name: 'NOT',
    category: 'logical',
    signature: 'NOT(logical)',
    summary: 'The opposite of a condition: TRUE when the argument is FALSE.',
    example: '=NOT(B2>5)',
    minArgs: 1,
    maxArgs: 1,
    call: notCall,
  },
  {
    name: 'ISERROR',
    category: 'logical',
    signature: 'ISERROR(value)',
    summary: 'TRUE when the value is an error.',
    example: '=ISERROR(10/A2)',
    minArgs: 1,
    maxArgs: 1,
    call: isErrorCall,
  },
  {
    name: 'ISNUMBER',
    category: 'logical',
    signature: 'ISNUMBER(value)',
    summary: 'TRUE when the value is a number (dates count).',
    example: '=ISNUMBER(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: isNumberCall,
  },
  {
    name: 'ISTEXT',
    category: 'logical',
    signature: 'ISTEXT(value)',
    summary: 'TRUE when the value is text.',
    example: '=ISTEXT(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: isTextCall,
  },
  {
    name: 'ISBLANK',
    category: 'logical',
    signature: 'ISBLANK(value)',
    summary: 'TRUE when the value is empty (a blank cell).',
    example: '=ISBLANK(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: isBlankCall,
  },
  {
    name: 'CONCAT',
    aliases: ['CONCATENATE'],
    category: 'text',
    signature: 'CONCAT(text, …)',
    summary: 'Joins the display forms of its arguments and ranges.',
    example: '=CONCAT(A2, " ", B2)',
    minArgs: 1,
    maxArgs: Infinity,
    call: concatCall,
  },
  {
    name: 'TEXTJOIN',
    category: 'text',
    signature: 'TEXTJOIN(delimiter, ignoreEmpty, text, …)',
    summary: 'Joins values with a delimiter, skipping empty cells when ignoreEmpty is TRUE.',
    example: '=TEXTJOIN(", ", TRUE, A2:C4)',
    minArgs: 2,
    maxArgs: Infinity,
    call: textJoinCall,
  },
  {
    name: 'LEN',
    category: 'text',
    signature: 'LEN(text)',
    summary: 'How many characters the display form of a value has (blank is 0).',
    example: '=LEN(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: lenCall,
  },
  {
    name: 'UPPER',
    category: 'text',
    signature: 'UPPER(text)',
    summary: 'The text with every letter uppercased.',
    example: '=UPPER(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: upperCall,
  },
  {
    name: 'LOWER',
    category: 'text',
    signature: 'LOWER(text)',
    summary: 'The text with every letter lowercased.',
    example: '=LOWER(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: lowerCall,
  },
  {
    name: 'TRIM',
    category: 'text',
    signature: 'TRIM(text)',
    summary: 'Removes leading and trailing spaces and collapses inner runs to one space.',
    example: '=TRIM("  spaced   out ")',
    minArgs: 1,
    maxArgs: 1,
    call: trimCall,
  },
  {
    name: 'LEFT',
    category: 'text',
    signature: 'LEFT(text, [numChars])',
    summary: 'The first characters of the text (default 1).',
    example: '=LEFT(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: leftCall,
  },
  {
    name: 'RIGHT',
    category: 'text',
    signature: 'RIGHT(text, [numChars])',
    summary: 'The last characters of the text (default 1).',
    example: '=RIGHT(B2, 2)',
    minArgs: 1,
    maxArgs: 2,
    call: rightCall,
  },
  {
    name: 'MID',
    category: 'text',
    signature: 'MID(text, start, [numChars])',
    summary: 'Characters from start (1-based) onward; an empty text when start is past the end.',
    example: '=MID(B2, 3, 2)',
    minArgs: 2,
    maxArgs: 3,
    call: midCall,
  },
  {
    name: 'REPT',
    category: 'text',
    signature: 'REPT(text, times)',
    summary: 'Repeats the text the given number of times (0 gives an empty text).',
    example: '=REPT("ab", 3)',
    minArgs: 2,
    maxArgs: 2,
    call: reptCall,
  },
  {
    name: 'SUBSTITUTE',
    category: 'text',
    signature: 'SUBSTITUTE(text, oldText, [newText], [instance])',
    summary: 'Case-sensitively replaces occurrences of oldText — all of them, or only the given instance.',
    example: '=SUBSTITUTE(B2, "-", "")',
    minArgs: 2,
    maxArgs: 4,
    call: substituteCall,
  },
  {
    name: 'EXACT',
    category: 'text',
    signature: 'EXACT(text1, text2)',
    summary: 'TRUE when the two display forms are identical (case-sensitive).',
    example: '=EXACT(A2, B2)',
    minArgs: 2,
    maxArgs: 2,
    call: exactCall,
  },
  {
    name: 'VALUE',
    category: 'text',
    signature: 'VALUE(text)',
    summary: 'Turns numbers, numeric text, dates (to their serial), and booleans into a number.',
    example: '=VALUE("42")',
    minArgs: 1,
    maxArgs: 1,
    call: valueCall,
  },
  {
    name: 'TODAY',
    category: 'date',
    signature: 'TODAY()',
    summary: 'The current date (serial truncated to midnight).',
    example: '=TODAY()',
    minArgs: 0,
    maxArgs: 0,
    call: todayCall,
  },
  {
    name: 'NOW',
    category: 'date',
    signature: 'NOW()',
    summary: 'The current date and time as a date serial.',
    example: '=NOW()',
    minArgs: 0,
    maxArgs: 0,
    call: nowCall,
  },
  {
    name: 'DATE',
    category: 'date',
    signature: 'DATE(year, month, day)',
    summary: 'Builds a date from year, month, and day, normalizing month/day overflow (Excel\'s 0–1899 year mapping means +1900).',
    example: '=DATE(2024, 12, 31)',
    minArgs: 3,
    maxArgs: 3,
    call: dateCall,
  },
  {
    name: 'YEAR',
    category: 'date',
    signature: 'YEAR(serial)',
    summary: 'The year of a date or serial.',
    example: '=YEAR(DATE(2024, 1, 15))',
    minArgs: 1,
    maxArgs: 1,
    call: yearCall,
  },
  {
    name: 'MONTH',
    category: 'date',
    signature: 'MONTH(serial)',
    summary: 'The month (1–12) of a date or serial.',
    example: '=MONTH(DATE(2024, 1, 15))',
    minArgs: 1,
    maxArgs: 1,
    call: monthCall,
  },
  {
    name: 'DAY',
    category: 'date',
    signature: 'DAY(serial)',
    summary: 'The day of the month (1–31) of a date or serial.',
    example: '=DAY(DATE(2024, 1, 15))',
    minArgs: 1,
    maxArgs: 1,
    call: dayCall,
  },
  {
    name: 'HOUR',
    category: 'date',
    signature: 'HOUR(serial)',
    summary: 'The hour (0–23) of a date or time serial.',
    example: '=HOUR(NOW())',
    minArgs: 1,
    maxArgs: 1,
    call: hourCall,
  },
  {
    name: 'MINUTE',
    category: 'date',
    signature: 'MINUTE(serial)',
    summary: 'The minute (0–59) of a date or time serial.',
    example: '=MINUTE(NOW())',
    minArgs: 1,
    maxArgs: 1,
    call: minuteCall,
  },
  {
    name: 'SECOND',
    category: 'date',
    signature: 'SECOND(serial)',
    summary: 'The second (0–59) of a date or time serial.',
    example: '=SECOND(NOW())',
    minArgs: 1,
    maxArgs: 1,
    call: secondCall,
  },
  {
    name: 'WEEKDAY',
    category: 'date',
    signature: 'WEEKDAY(serial, [type])',
    summary: 'The weekday of a date or serial: type 1 (default) Sunday=1…Saturday=7, type 2 Monday=1, type 3 Monday=0.',
    example: '=WEEKDAY(DATE(2024, 1, 1))',
    minArgs: 1,
    maxArgs: 2,
    call: weekdayCall,
  },
  {
    name: 'DAYS',
    category: 'date',
    signature: 'DAYS(end, start)',
    summary: 'The days between two dates or serials, truncated toward zero.',
    example: '=DAYS(DATE(2024, 3, 1), DATE(2024, 2, 1))',
    minArgs: 2,
    maxArgs: 2,
    call: daysCall,
  },
  {
    name: 'EDATE',
    category: 'date',
    signature: 'EDATE(start, months)',
    summary: 'The date \'months\' calendar months after start, clamping the day to the month end (Jan 31 + 1 → Feb 29).',
    example: '=EDATE(DATE(2024, 1, 31), 1)',
    minArgs: 2,
    maxArgs: 2,
    call: edateCall,
  },
  {
    name: 'EOMONTH',
    category: 'date',
    signature: 'EOMONTH(start, months)',
    summary: 'The last day of the month \'months\' after start\'s month.',
    example: '=EOMONTH(DATE(2024, 1, 15), 1)',
    minArgs: 2,
    maxArgs: 2,
    call: eomonthCall,
  },
  {
    name: 'INDEX',
    category: 'lookup',
    signature: 'INDEX(array, [row_num], [col_num])',
    summary: 'The value at a 1-based row and column of a range (omitted coordinates default to 1).',
    example: '=INDEX(A2:C4, 3, 2)',
    minArgs: 1,
    maxArgs: 3,
    call: indexCall,
  },
  {
    name: 'MATCH',
    category: 'lookup',
    signature: 'MATCH(lookup_value, lookup_array, [match_type])',
    summary: 'The position of a value in a single row or column: 0 exact, 1 (default) largest ≤, -1 smallest ≥.',
    example: '=MATCH("Oranges", A2:A4, 0)',
    minArgs: 2,
    maxArgs: 3,
    call: matchCall,
  },
  {
    name: 'VLOOKUP',
    category: 'lookup',
    signature: 'VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])',
    summary: 'Finds a value in the first column of a range and returns the cell that many columns over (exact when range_lookup is FALSE, otherwise the largest matching value ≤ the lookup).',
    example: '=VLOOKUP("Pears", A2:C4, 3, FALSE)',
    minArgs: 3,
    maxArgs: 4,
    call: vlookupCall,
  },
  {
    name: 'HLOOKUP',
    category: 'lookup',
    signature: 'HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])',
    summary: 'Finds a value in the first row of a range and returns the cell that many rows down (exact when range_lookup is FALSE, otherwise the largest matching value ≤ the lookup).',
    example: '=HLOOKUP(20, A1:C2, 2, FALSE)',
    minArgs: 3,
    maxArgs: 4,
    call: hlookupCall,
  },
  {
    name: 'CHOOSE',
    category: 'logical',
    signature: 'CHOOSE(index, value, [value2], …)',
    summary: 'The value at a 1-based position in the argument list; only the chosen value is evaluated.',
    example: '=CHOOSE(2, "Low", "Medium", "High")',
    minArgs: 2,
    maxArgs: 254,
    lazy: true,
    call: chooseCall,
  },
  {
    name: 'STDEV',
    category: 'aggregate',
    signature: 'STDEV(number1, [number2], …)',
    summary: 'Sample standard deviation of the numeric values (booleans and blanks skipped).',
    example: '=STDEV(B2:B10)',
    minArgs: 1,
    maxArgs: 255,
    call: stdevCall,
  },
  {
    name: 'VAR',
    category: 'aggregate',
    signature: 'VAR(number1, [number2], …)',
    summary: 'Sample variance of the numeric values (booleans and blanks skipped).',
    example: '=VAR(B2:B10)',
    minArgs: 1,
    maxArgs: 255,
    call: varCall,
  },
  {
    name: 'XLOOKUP',
    category: 'lookup',
    signature: 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])',
    summary: 'Finds a value in a single row or column and returns the matching cell of the return array (exact by default; match_mode -1 next-smaller, 1 next-larger, 2 wildcard; search_mode -1 scans last-to-first).',
    example: '=XLOOKUP("Pears", A2:A4, B2:B4, "missing")',
    minArgs: 3,
    maxArgs: 6,
    call: xlookupCall,
  },
  {
    name: 'UUID',
    category: 'utility',
    aliases: ['GUID'],
    signature: 'UUID()',
    summary: 'A fresh random RFC 4122 version-4 UUID (lowercase, dashed). Recomputed when the table changes.',
    example: '=UUID()',
    minArgs: 0,
    maxArgs: 0,
    call: uuidCall,
  },
  {
    name: 'B64ENCODE',
    category: 'utility',
    signature: 'B64ENCODE(text)',
    summary: 'The base64 encoding of the text value (UTF-8).',
    example: '=B64ENCODE("hello")',
    minArgs: 1,
    maxArgs: 1,
    call: b64encodeCall,
  },
  {
    name: 'B64DECODE',
    category: 'utility',
    signature: 'B64DECODE(text)',
    summary: 'The original text of a base64 value; #VALUE! when the text is not valid base64.',
    example: '=B64DECODE(B2)',
    minArgs: 1,
    maxArgs: 1,
    call: b64decodeCall,
  },
]

/** Every builtin name and alias, uppercase — the canonical "is this token a
 * known function name?" set used by reference shifting and definition
 * validation. */
export const BUILTIN_FUNCTION_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_FORMULAS.flatMap((fn) => [fn.name, ...(fn.aliases ?? [])]).map((name) =>
    name.toUpperCase(),
  ),
)

export function isBuiltinName(name: string): boolean {
  return BUILTIN_FUNCTION_NAMES.has(name.toUpperCase())
}

/**
 * Build the callable lookup: builtins first, then `defs`. A definition whose
 * name or alias is a builtin is ignored, so builtins can never be overridden;
 * document definitions (which are validated before they reach here) take
 * precedence over one another in iteration order.
 */
export function buildFunctionMap(
  defs: Iterable<FormulaFunction> = [],
): Map<string, FormulaFunction> {
  const map = new Map<string, FormulaFunction>()
  for (const fn of BUILTIN_FORMULAS) {
    map.set(fn.name.toUpperCase(), fn)
    for (const alias of fn.aliases ?? []) {
      map.set(alias.toUpperCase(), fn)
    }
  }
  for (const fn of defs) {
    const keys = [fn.name, ...(fn.aliases ?? [])]
    if (keys.some((key) => isBuiltinName(key))) continue
    for (const key of keys) {
      map.set(key.toUpperCase(), fn)
    }
  }
  return map
}

/** The builtins-only environment; the default for every `solve` call. */
export const BUILTIN_ENV: FormulaEnv = { functions: buildFunctionMap() }

/** Resolve and invoke a function by name, case-insensitively. Eager functions
 * receive the values of their forced argument thunks; lazy ones receive the
 * thunks unchanged so they can choose not to evaluate branches at all. */
export function invokeFunction(
  name: string,
  argThunks: readonly CellValueThunk[],
  env: FormulaEnv,
): CellValue {
  const fn = env.functions.get(name.toUpperCase())
  if (!fn) {
    return err('#NAME?', `Unknown function "${name}"`)
  }
  const ctx: EvalContext = { env }
  if (fn.lazy) {
    return fn.call(argThunks, ctx)
  }
  const args = argThunks.map((thunk) => thunk())
  return fn.call(args, ctx)
}

/** Eager wrapper over {@link invokeFunction}: forces every argument before
 * dispatch, so callers that already hold values (tests, the `applyFunction`
 * in the DSL) can invoke any function including the lazy conditionals. */
export function applyFunction(
  name: string,
  args: readonly CellValue[],
  env: FormulaEnv,
): CellValue {
  return invokeFunction(
    name,
    args.map((arg) => () => arg),
    env,
  )
}
