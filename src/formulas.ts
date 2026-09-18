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

/** Read the single numeric first argument shared by the unary math builtins. */
function firstNumber(args: readonly CellValue[]): number | ErrorCell {
  const first = args[0]
  if (!first) return err('#VALUE!', 'Expected a number')
  if (first.kind === 'error') return first
  const value = toNumber(first)
  if (value === null) return err('#VALUE!', 'Expected a number')
  return value
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
