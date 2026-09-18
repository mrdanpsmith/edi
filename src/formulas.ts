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
  | { kind: 'set'; items: CellValue[] }
  | { kind: 'error'; message: string; hint?: string }

export type ErrorCell = Extract<CellValue, { kind: 'error' }>

/** A deferred argument value, produced on demand. Lazy functions (`IF` and
 * friends) receive these so an unselected branch is never evaluated; eager
 * functions get the already-forced values instead. */
export type CellValueThunk = () => CellValue

export type FormulaCategory = 'aggregate' | 'math' | 'logical' | 'text' | 'date' | 'custom'

/** The set of callable functions available to one evaluation. Builtins are
 * always present; document definitions add to (but never override) them. */
export interface FormulaEnv {
  readonly functions: ReadonlyMap<string, FormulaFunction>
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

/** A range's flattened cells, passed to aggregate functions. */
export function setValue(items: CellValue[]): CellValue {
  return { kind: 'set', items }
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

/** A `SUMIF`/`COUNTIF`/`AVERAGEIF` range argument, normalized to cells: a set
 * (range) is exposed item by item, any other single value is treated as a
 * one-cell range (blank for a missing argument, so nothing matches). */
function rangeCells(arg: CellValue | undefined): CellValue[] {
  if (arg?.kind === 'set') return arg.items
  if (arg === undefined) return []
  return [arg]
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

/** Split a criteria string like `">5"`, `"Apples"`, or `"<>done"` into an
 * operator and a bare operand; `*` wildcards are deferred. A dangling operator
 * (`">"`) is the one malformed criteria and surfaces as `#VALUE!`. */
function parseCriteria(criteria: string): ((cell: CellValue) => boolean) | ErrorCell {
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
  return (cell) => matchCriterion(cell, op, operand)
}

function sumIfCall(args: readonly CellValue[]): CellValue {
  const predicate = parseCriteriaFromArgs(args)
  if (typeof predicate !== 'function') return predicate
  if (args[0]?.kind === 'error') return args[0]
  if (args[2]?.kind === 'error') return args[2]
  const range = rangeCells(args[0])
  const sums = args[2] === undefined ? range : rangeCells(args[2])
  let total = 0
  for (let i = 0; i < range.length; i++) {
    if (!predicate(range[i]!)) continue
    const n = toNumber(sums[i] ?? blank())
    if (n !== null) total += n // non-numeric sum cells are ignored, as in Excel
  }
  return num(total)
}

function countIfCall(args: readonly CellValue[]): CellValue {
  const predicate = parseCriteriaFromArgs(args)
  if (typeof predicate !== 'function') return predicate
  if (args[0]?.kind === 'error') return args[0]
  const range = rangeCells(args[0])
  let count = 0
  for (const cell of range) {
    if (predicate(cell)) count++
  }
  return num(count)
}

function averageIfCall(args: readonly CellValue[]): CellValue {
  const predicate = parseCriteriaFromArgs(args)
  if (typeof predicate !== 'function') return predicate
  if (args[0]?.kind === 'error') return args[0]
  if (args[2]?.kind === 'error') return args[2]
  const range = rangeCells(args[0])
  const averages = args[2] === undefined ? range : rangeCells(args[2])
  let total = 0
  let count = 0
  for (let i = 0; i < range.length; i++) {
    if (!predicate(range[i]!)) continue
    const n = toNumber(averages[i] ?? blank())
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
