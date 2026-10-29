import type { CellValue, ErrorCell, CompareOp } from './formula-types'

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

export const UNIX_EPOCH_SERIAL = 25569 // days from 1899-12-30 to 1970-01-01

/** Days from the civil epoch (1970-01-01) to a local calendar date, ignoring
 * time-of-day — Howard Hinnant's `days_from_civil`. The serial model is
 * calendar-based and timezone-independent. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = month > 2 ? month - 3 : month + 9
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Inverse of {@link daysFromCivil}: civil date → days since 1970-01-01. */
export function civilFromDays(z: number): [number, number, number] {
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

/** Format a number for display: up to four decimals, trailing zeros dropped.
 * Outside the range four decimals can show — a magnitude past 1e15, or a
 * non-zero one under 0.0001 — ten significant digits instead, so `1e305`
 * does not display as `Infinity` (the ×10000 overflowed) nor `0.00001` as `0`. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '#VALUE!'
  }
  const magnitude = Math.abs(value)
  if (magnitude !== 0 && (magnitude >= 1e15 || magnitude < 1e-4)) {
    return String(Number(value.toPrecision(10)))
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
