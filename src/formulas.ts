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
  call(args: readonly CellValue[], ctx: EvalContext): CellValue
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

/** Resolve and invoke a function by name, case-insensitively. */
export function applyFunction(
  name: string,
  args: readonly CellValue[],
  env: FormulaEnv,
): CellValue {
  const fn = env.functions.get(name.toUpperCase())
  if (!fn) {
    return err('#NAME?', `Unknown function "${name}"`)
  }
  return fn.call(args, { env })
}
