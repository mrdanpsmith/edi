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

const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MONTH_ABBR = MONTH_FULL.map((m) => m.slice(0, 3))
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_ABBR = DAY_FULL.map((d) => d.slice(0, 3))

/** Function names the formula parser knows; `x10`-style tokens that spell one
 * are not cell references (e.g. `=LOG10(100)` must not shift like `=LOG10`). */
const FORMULA_FUNCTIONS = new Set([
  'SUM', 'AVERAGE', 'AVG', 'MIN', 'MAX', 'COUNT', 'PRODUCT', 'ABS', 'SQRT', 'ROUND',
])

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