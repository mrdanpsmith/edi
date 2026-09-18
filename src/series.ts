/**
 * Excel-style series detection for the spreadsheet fill handle.
 *
 * Given the seed values of a source strip (a cell range's column or row),
 * produce the continuation values that belong in `count` consecutive cells
 * beyond the strip: an arithmetic progression when the seeds are numeric
 * (`1, 4` → `7, 10`), an embedded-number pattern when they carry a prefix
 * and/or suffix (`Q1, Q2` → `Q3`, `Item 3, Item 4` → `Item 5`), a cycled name
 * list (`Jan, Feb` → `Mar`; `Mon, Tue` → `Wed`), a repeated text cycle
 * (`Red, Green` → `Red, Green, …`), or a plain duplication of a single seed.
 */

import { BUILTIN_FUNCTION_NAMES } from './formulas'

const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTH_ABBR = MONTH_FULL.map((m) => m.slice(0, 3))
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_ABBR = DAY_FULL.map((d) => d.slice(0, 3))

/** Function names the formula parser knows; `x10`-style tokens that spell one
 * are not cell references (e.g. `=LOG10(100)` must not shift like `=LOG10`).
 * Derived from the function registry so it can never drift from the evaluator. */
const FORMULA_FUNCTIONS = BUILTIN_FUNCTION_NAMES

export function fillValues(seeds: readonly string[], count: number): string[] {
  if (count <= 0) return []
  if (seeds.length === 0) return Array(count).fill('')
  if (seeds.every((s) => s === seeds[0])) return Array(count).fill(seeds[0])
  if (seeds.length < 2) return Array(count).fill(seeds[0])
  const numeric = numericProgression(seeds, count)
  if (numeric) return numeric
  const embedded = embeddedNumberProgression(seeds, count)
  if (embedded) return embedded
  const named = namedCycle(seeds, count)
  if (named) return named
  return Array.from({ length: count }, (_, k) => seeds[k % seeds.length] ?? '')
}

function isBlankLike(seeds: readonly string[]): boolean {
  return seeds.every((s) => s.trim() === '')
}

function decimalPlaces(value: string): number {
  const match = /\.(\d+)$/.exec(value)
  return match ? match[1]!.length : 0
}

function isPlainNumber(value: string): boolean {
  return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(value.trim())
}

function formatStep(value: number, decimals: number): string {
  return decimals > 0 ? value.toFixed(decimals) : String(Math.round(value))
}

function numericProgression(seeds: readonly string[], count: number): string[] | null {
  if (seeds.some((s) => !isPlainNumber(s))) return null
  const nums = seeds.map((s) => Number(s.trim()))
  const decimals = Math.max(...seeds.map((s) => decimalPlaces(s.trim())))
  const step = (nums[nums.length - 1]! - nums[0]!) / (nums.length - 1)
  if (Math.abs(step) < 1e-12) return null
  const out: string[] = []
  let value = nums[nums.length - 1]!
  for (let i = 0; i < count; i++) {
    value += step
    out.push(formatStep(value, decimals))
  }
  return out
}

interface Embedded {
  pre: string
  numText: string
  num: number
  suf: string
}

function embeddedNumberProgression(seeds: readonly string[], count: number): string[] | null {
  const parsed: (Embedded | null)[] = seeds.map((seed) => {
    const match = /^([^\d]*?)(\d+(?:\.\d+)?)([^\d]*)$/.exec(seed)
    if (!match) return null
    return { pre: match[1]!, numText: match[2]!, num: Number(match[2]!), suf: match[3]! }
  })
  if (parsed.some((p) => !p)) return null
  const first = parsed[0]!
  if (parsed.some((p) => p!.pre !== first.pre || p!.suf !== first.suf)) return null
  const nums = parsed.map((p) => p!.num)
  const step = (nums[nums.length - 1]! - nums[0]!) / (nums.length - 1)
  if (Math.abs(step) < 1e-12) return null
  const decimals = decimalPlaces(first.numText)
  const width = first.numText.length
  const zeroPadded = first.numText.length > 1 && first.numText[0] === '0'
  const out: string[] = []
  let value = nums[nums.length - 1]!
  for (let i = 0; i < count; i++) {
    value += step
    const text =
      decimals > 0
        ? value.toFixed(decimals)
        : zeroPadded
          ? String(Math.round(value)).padStart(width, '0')
          : String(Math.round(value))
    out.push(`${first.pre}${text}${first.suf}`)
  }
  return out
}

/** Consecutive (cyclically wrapping) entries of a named list — months or
 * weekdays, full or abbreviated — continue around the list. */
function namedCycle(seeds: readonly string[], count: number): string[] | null {
  for (const list of [MONTH_FULL, MONTH_ABBR, DAY_FULL, DAY_ABBR]) {
    const index = list.indexOf(seeds[0] ?? '')
    if (index < 0) continue
    let ok = true
    for (let i = 1; i < seeds.length; i++) {
      if (seeds[i] !== list[(index + i) % list.length]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const out: string[] = []
    let k = (index + seeds.length) % list.length
    for (let i = 0; i < count; i++) {
      out.push(list[k]!)
      k = (k + 1) % list.length
    }
    return out
  }
  return null
}

// --- Formula reference shifting ---

function lettersToCol(letters: string): number {
  let col = 0
  for (const char of letters.toUpperCase()) {
    col = col * 26 + (char.charCodeAt(0) - 64)
  }
  return col
}

function colToLetters(col: number): string {
  let n = col
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

const REF_TOKEN = /(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)/g

/**
 * Shift the A1-style references in a formula by `dr` rows and `dc` columns so
 * a formula cell copied by the fill handle keeps pointing at the same
 * relative span. `$A$1`-style absolute markers (or a `$` on just one axis)
 * freeze that axis. Known function names (`SUM`, `LOG`-like tokens don't
 * exist here, but `ROUND`, `MIN`, …) are never treated as references.
 */
export function shiftFormulaRefs(formula: string, dr: number, dc: number): string {
  return formula.replace(REF_TOKEN, (match, colAbs: string, letters: string, rowAbs: string, digits: string, offset: number) => {
    if (FORMULA_FUNCTIONS.has(letters.toUpperCase())) return match
    if (offset > 0 && /[A-Za-z0-9_.]/.test(formula[offset - 1] ?? '')) return match
    const col = lettersToCol(letters)
    const row = Number(digits)
    const newCol = colAbs === '$' ? col : Math.max(1, col + dc)
    const newRow = rowAbs === '$' ? row : Math.max(1, row + dr)
    return `${colAbs}${colToLetters(newCol)}${rowAbs}${newRow}`
  })
}

/** Values a drag would place in `count` continuation cells, skipping formula
 * seeds (whose dragged values are shifted formulas, not series text). */
export function fillTextValues(seeds: readonly string[], count: number): string[] {
  if (isBlankLike(seeds)) return Array(count).fill('')
  return fillValues(seeds, count)
}

export interface SourceRect {
  r1: number
  c1: number
  r2: number
  c2: number
}

/**
 * Rewrite references that point inside a cut range by (dr, dc), so formulas
 * elsewhere keep referring to the moved cells after a cut-and-paste. Unlike
 * {@link shiftFormulaRefs}, only references that actually target `src` move —
 * a formula is not shifted as a whole — and absolute `$` markers are preserved
 * because the referenced cell itself moved.
 */
export function remapFormulaRefs(formula: string, src: SourceRect, dr: number, dc: number): string {
  return formula.replace(REF_TOKEN, (match, colAbs: string, letters: string, rowAbs: string, digits: string, offset: number) => {
    if (FORMULA_FUNCTIONS.has(letters.toUpperCase())) return match
    if (offset > 0 && /[A-Za-z0-9_.]/.test(formula[offset - 1] ?? '')) return match
    const col = lettersToCol(letters)
    const row = Number(digits)
    if (row < src.r1 || row > src.r2 || col < src.c1 || col > src.c2) return match
    return `${colAbs}${colToLetters(Math.max(1, col + dc))}${rowAbs}${Math.max(1, row + dr)}`
  })
}

/** A single A1 reference with an optional `:A1` range partner. */
const REF_RANGE_TOKEN =
  /(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*))?/g

/**
 * Rewrite the references in a formula when a row or column is inserted at
 * `at` (a 1-based spreadsheet coordinate). A lone reference at or after the
 * insertion point moves one cell along that axis — including `$`-absolute
 * ones, because the cell itself moved. A range behaves like the block of
 * cells it covers: an insertion within it, or immediately before/after it,
 * grows the range to take the new row/column in, so a `SUM(C2:C9)` above a
 * total keeps covering the data as rows are added to the block.
 */
export function insertFormulaRefs(formula: string, axis: 'row' | 'col', at: number): string {
  return formula.replace(
    REF_RANGE_TOKEN,
    (
      match,
      colAbs: string,
      letters: string,
      rowAbs: string,
      digits: string,
      colAbs2: string | undefined,
      letters2: string | undefined,
      rowAbs2: string | undefined,
      digits2: string | undefined,
      offset: number,
    ) => {
      if (FORMULA_FUNCTIONS.has(letters.toUpperCase())) return match
      if (offset > 0 && /[A-Za-z0-9_.]/.test(formula[offset - 1] ?? '')) return match
      const single = digits2 === undefined
      const r1 = Number(digits)
      const c1 = lettersToCol(letters)
      if (single) {
        const newCol = axis === 'col' && c1 >= at ? c1 + 1 : c1
        const newRow = axis === 'row' && r1 >= at ? r1 + 1 : r1
        if (newCol === c1 && newRow === r1) return match
        return `${colAbs}${colToLetters(newCol)}${rowAbs}${newRow}`
      }
      const r2 = Number(digits2)
      const c2 = lettersToCol(letters2!)
      // Inserting before the range shifts it; inserting within it or directly
      // against an end grows it instead.
      const grow = (low: number, high: number): [number, number] => {
        if (at < low) return [low + 1, high + 1]
        if (at <= high + 1) return [low, high + 1]
        return [low, high]
      }
      if (axis === 'row') {
        const [low, high] = grow(Math.min(r1, r2), Math.max(r1, r2))
        return rebuildRef(colAbs, c1, rowAbs, r1 <= r2 ? low : high, colAbs2, c2, rowAbs2, r1 <= r2 ? high : low)
      }
      const [low, high] = grow(Math.min(c1, c2), Math.max(c1, c2))
      return rebuildRef(colAbs, c1 <= c2 ? low : high, rowAbs, r1, colAbs2, c1 <= c2 ? high : low, rowAbs2, r2)
    },
  )
}

/**
 * Rewrite the references in a formula when rows or columns are removed.
 *
 * `removed` holds the 0-based **grid** indices of the deleted rows/columns
 * (the same indices the table view selects). Surviving references after the
 * deletion shift back by however many removed coordinates sat before them. A
 * range that straddles the deletion shrinks rather than swallowing the gap:
 * `SUM(C2:C9)` with row 9 removed becomes `SUM(C2:C8)`, so a total row no
 * longer ends up inside the range it is summing (which would be a cycle).
 * A reference whose cell is gone entirely becomes `#REF!`.
 */
export function deleteFormulaRefs(
  formula: string,
  axis: 'row' | 'col',
  removed: ReadonlySet<number>,
): string {
  if (removed.size === 0) return formula
  const sorted = [...removed].sort((a, b) => a - b)
  const removedBelow = (gridIndex: number): number => {
    let count = 0
    for (const index of sorted) {
      if (index >= gridIndex) break
      count++
    }
    return count
  }
  // Map a 1-based coordinate to its new position. A deleted range endpoint
  // collapses onto the neighbouring survivor (`start` keeps the cell that
  // shifted into the gap; `end` stops just above it) so the range tightens.
  const map = (coord: number, role: 'start' | 'end' | 'single'): number | null => {
    const grid = coord - 1
    const shifted = coord - removedBelow(grid)
    if (!removed.has(grid)) return shifted
    if (role === 'single') return null
    return role === 'start' ? shifted : shifted - 1
  }
  return formula.replace(
    REF_RANGE_TOKEN,
    (
      match,
      colAbs: string,
      letters: string,
      rowAbs: string,
      digits: string,
      colAbs2: string | undefined,
      letters2: string | undefined,
      rowAbs2: string | undefined,
      digits2: string | undefined,
      offset: number,
    ) => {
      if (FORMULA_FUNCTIONS.has(letters.toUpperCase())) return match
      if (offset > 0 && /[A-Za-z0-9_.]/.test(formula[offset - 1] ?? '')) return match
      const single = digits2 === undefined
      const r1 = Number(digits)
      const c1 = lettersToCol(letters)
      const r2 = single ? r1 : Number(digits2)
      const c2 = single ? c1 : lettersToCol(letters2!)
      if (axis === 'row') {
        const low = Math.min(r1, r2)
        const high = Math.max(r1, r2)
        const lowNew = map(low, single ? 'single' : 'start')
        const highNew = single ? lowNew : map(high, 'end')
        if (lowNew === null || highNew === null || lowNew > highNew) return '#REF!'
        return rebuildRef(colAbs, c1, rowAbs, r1 <= r2 ? lowNew : highNew, colAbs2, c2, rowAbs2, single ? undefined : r1 <= r2 ? highNew : lowNew)
      }
      const low = Math.min(c1, c2)
      const high = Math.max(c1, c2)
      const lowNew = map(low, single ? 'single' : 'start')
      const highNew = single ? lowNew : map(high, 'end')
      if (lowNew === null || highNew === null || lowNew > highNew) return '#REF!'
      return rebuildRef(colAbs, c1 <= c2 ? lowNew : highNew, rowAbs, r1, colAbs2, c1 <= c2 ? highNew : lowNew, rowAbs2, single ? undefined : r2)
    },
  )
}

function rebuildRef(
  colAbs: string,
  col: number,
  rowAbs: string,
  row: number,
  colAbs2: string | undefined,
  col2: number,
  rowAbs2: string | undefined,
  row2: number | undefined,
): string {
  const first = `${colAbs}${colToLetters(col)}${rowAbs}${row}`
  if (row2 === undefined) return first
  return `${first}:${colAbs2}${colToLetters(col2)}${rowAbs2}${row2}`
}