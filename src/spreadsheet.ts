import { parseCellSegments, renderCellHtml, styleCellDisplay, type CellMark } from './inline-md'
import {
  BUILTIN_ENV,
  add,
  applyFunction,
  blank,
  bool,
  compareValues,
  div,
  err,
  formatNumber,
  invokeFunction,
  mul,
  neg,
  num,
  pow,
  setValue,
  sub,
  text,
  toText,
  type CellValue,
  type CellValueThunk,
  type CompareOp,
  type FormulaEnv,
} from './formulas'

export { formatNumber } from './formulas'

export const SPREADSHEET_PREFIX = '='

/** Outer inline marks that could wrap a formula cell. A fast gate for the
 * marked-formula scan below: anything that doesn't start with one of these can
 * never be a formula, so plain cells stay cheap instead of running the
 * markdown parser on every cell of a table. */
const MARKED_START_RE = /^(?:\*\*|\*|~~|\^|~|==|`)/

/**
 * The runnable body of a formula cell and the inline marks that style its
 * result, or `null` when the cell is not a formula at all.
 *
 * A plain `…=…` cell yields `{ body, marks: [] }`. A *marked formula* — a
 * cell whose whole content is one uniformly-marked run whose text starts with
 * `=` (e.g. `**=SUM(A1:A3)**`) — is also a formula; its marks style the
 * computed result, so the format toolbar's bold/italic/etc. buttons work on
 * formula cells. Cells whose marks differ between runs (a formula that embeds
 * `` ** `` inside a string literal), and cells containing links or masked
 * pills, never match and stay literal. A leading `==` is markdown highlight
 * (`==text==`), never a formula.
 */
export function formulaParts(
  raw: string,
): { body: string; marks: readonly CellMark[] } | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith(SPREADSHEET_PREFIX)) {
    if (trimmed.startsWith(SPREADSHEET_PREFIX + SPREADSHEET_PREFIX)) {
      return null
    }
    return { body: trimmed.slice(1).trim(), marks: [] }
  }
  if (!MARKED_START_RE.test(trimmed)) {
    return null
  }
  const segments = parseCellSegments(raw)
  if (segments.length === 0) return null
  const marks = segments[0]!.marks
  let text = ''
  for (const seg of segments) {
    if (seg.href !== null || seg.masked !== null) return null
    if (seg.marks.length !== marks.length || seg.marks.some((m, i) => m !== marks[i])) {
      return null
    }
    text += seg.text
  }
  const unwrapped = text.trim()
  if (
    !unwrapped.startsWith(SPREADSHEET_PREFIX) ||
    unwrapped.startsWith(SPREADSHEET_PREFIX + SPREADSHEET_PREFIX)
  ) {
    return null
  }
  return { body: unwrapped.slice(1).trim(), marks }
}

/** A cell whose trimmed text starts with `=` is a formula — except a leading
 * `==`, which is a markdown highlight delimiter (`==text==`), not a formula
 * (no spreadsheet syntax is `= = …`). Distinguishing them keeps cells that are
 * entirely highlighted from erroring out as `#ERROR!` formulas. Cells wrapped
 * in uniform inline marks (`**=SUM(A1:A3)**`) are formulas too. */
export function isFormula(raw: string): boolean {
  return formulaParts(raw) !== null
}

export interface CellRef {
  row: number
  col: number
}

export interface CellSolution {
  display: string
  kind: 'formula' | 'text' | 'blank' | 'error'
  error?: string
  /** Human-readable explanation shown as a tooltip beside the error code. */
  hint?: string
  value?: number
  /** True when `display` is cell markdown (a formula styled by outer inline
   * marks), so renderers HTML-render it instead of showing it verbatim. */
  styled?: boolean
  /** True for non-numeric formula results (text, `TRUE`/`FALSE`, dates), whose
   * displayed text is cell markdown rendered like any other text cell. */
  rendersMarkdown?: boolean
}

export interface SpreadsheetSolution {
  rows: number
  cols: number
  cells: CellSolution[][]
}

interface CellRange {
  row1: number
  col1: number
  row2: number
  col2: number
}

interface TableCell {
  row: number
  col: number
  raw: string
  formula: string
}

// A1 references accept optional `$` absolute markers on either axis (`$A$2`,
// `A$2`, `$A2`); they only matter when a reference is shifted, so evaluation
// ignores them and resolves the cell the letters/digits name.
const CELL_REF = /^\$?([A-Za-z]+)\$?([1-9][0-9]*)$/
const RANGE_REF = /^\$?([A-Za-z]+)\$?([1-9][0-9]*):\$?([A-Za-z]+)\$?([1-9][0-9]*)$/
const NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)$/

/**
 * Resolve a raw pipe-table grid into per-cell display values. Formula cells
 * (`=…`) are evaluated against the whole grid; error cells carry the message
 * in both `display` and `error`. Non-formula cells display their raw text.
 * `env` supplies the callable functions (builtins plus any document
 * definitions); it defaults to the builtins.
 */
export function solve(rows: string[][], env: FormulaEnv = BUILTIN_ENV): SpreadsheetSolution {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const grid = new SpreadsheetGrid()
  rows.forEach((row, r) => {
    for (let c = 0; c < maxCols; c++) {
      grid.set(r + 1, c + 1, row[c] ?? '')
    }
  })
  const visiting = new Set<string>()
  const cells: CellSolution[][] = rows.map((row, r) =>
    Array.from({ length: maxCols }, (_, c) =>
      solveCell(grid, row[c] ?? '', r + 1, c + 1, visiting, env),
    ),
  )
  return { rows: rows.length, cols: maxCols, cells }
}

function solveCell(
  grid: SpreadsheetGrid,
  raw: string,
  _row: number,
  _col: number,
  visiting: Set<string>,
  env: FormulaEnv,
): CellSolution {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { display: '', kind: 'blank' }
  }
  const parts = formulaParts(raw)
  if (parts) {
    const { body, marks } = parts
    if (!body) {
      return { display: '', kind: 'blank' }
    }
    const result = evaluateFormula(body, grid, visiting, env)
    if (result.kind === 'error') {
      const message = result.message
      return {
        display: marks.length ? styleCellDisplay(message, marks) : message,
        kind: 'error',
        error: message,
        hint: result.hint ?? ERROR_HINTS[message],
        styled: marks.length > 0,
      }
    }
    if (result.kind === 'number') {
      const display = formatNumber(result.value)
      return {
        display: marks.length ? styleCellDisplay(display, marks) : display,
        kind: 'formula',
        value: result.value,
        styled: marks.length > 0,
      }
    }
    const display = toText(result)
    return {
      display: marks.length ? styleCellDisplay(display, marks) : display,
      kind: 'formula',
      styled: marks.length > 0,
      rendersMarkdown: true,
    }
  }
  return { display: raw, kind: 'text' }
}

export function computeSpreadsheet(container: HTMLElement, env: FormulaEnv = BUILTIN_ENV): void {
  for (const table of Array.from(container.querySelectorAll('table'))) {
    applyToTable(table, env)
  }
}

function applyToTable(table: HTMLTableElement, env: FormulaEnv): void {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) {
    return
  }
  const grid = new SpreadsheetGrid()
  const domCells: HTMLTableCellElement[][] = []
  rows.forEach((tr, rowIndex) => {
    const cells = Array.from(tr.children).filter(
      (child): child is HTMLTableCellElement => child.tagName === 'TD' || child.tagName === 'TH',
    )
    domCells.push(cells)
    cells.forEach((cell, colIndex) => {
      grid.set(rowIndex + 1, colIndex + 1, cell.textContent ?? '')
    })
  })
  for (const formulaCell of grid.formulaCells()) {
    const visiting = new Set<string>()
    const result = evaluateFormula(formulaCell.formula, grid, visiting, env)
    const domCell = domCells[formulaCell.row - 1]?.[formulaCell.col - 1]
    if (!domCell) {
      continue
    }
    domCell.classList.add('spreadsheet-formula')
    const marks = formulaParts(formulaCell.raw)?.marks ?? []
    let hint: string | undefined
    if (result.kind === 'error') {
      domCell.textContent = result.message
      domCell.classList.add('spreadsheet-error')
      hint = result.hint ?? ERROR_HINTS[result.message]
    } else if (result.kind === 'number') {
      const display = formatNumber(result.value)
      domCell.innerHTML = marks.length ? renderCellHtml(styleCellDisplay(display, marks)) : display
    } else {
      const display = toText(result)
      domCell.innerHTML = marks.length
        ? renderCellHtml(styleCellDisplay(display, marks))
        : renderCellHtml(display)
    }
    const raw = formulaCell.raw.trim()
    domCell.title = hint ? `${raw} — ${hint}` : raw
  }
}

class SpreadsheetGrid {
  private readonly cells = new Map<string, TableCell>()
  private readonly formulas: TableCell[] = []
  private maxRow = 0
  private maxCol = 0

  set(row: number, col: number, raw: string): void {
    const cell: TableCell = { row, col, raw, formula: '' }
    const parts = formulaParts(raw.trim())
    if (parts) {
      cell.formula = parts.body
      this.formulas.push(cell)
    }
    this.cells.set(cellKey(row, col), cell)
    this.maxRow = Math.max(this.maxRow, row)
    this.maxCol = Math.max(this.maxCol, col)
  }

  get(row: number, col: number): TableCell | undefined {
    return this.cells.get(cellKey(row, col))
  }

  /** False for a coordinate outside the table, so a formula can report a
   * dangling reference instead of silently treating it as an empty cell. */
  inBounds(row: number, col: number): boolean {
    return row >= 1 && col >= 1 && row <= this.maxRow && col <= this.maxCol
  }

  formulaCells(): readonly TableCell[] {
    return this.formulas
  }
}

/** Human-readable tooltip text for each error code. `#NAME?` is handled at the
 * source, where the offending name is still known. */
const ERROR_HINTS: Record<string, string> = {
  '#REF!': 'Reference outside the table',
  '#DIV/0!': 'Division by zero',
  '#VALUE!': 'Expected a number',
  '#N/A!': 'IFS/SWITCH found no matching result',
  '#CYCLE!': 'Circular reference',
  '#ERROR!': 'Could not parse the formula',
}

function evaluateFormula(
  formula: string,
  grid: SpreadsheetGrid,
  visiting: Set<string>,
  env: FormulaEnv,
): CellValue {
  try {
    return new FormulaParser(formula, grid, visiting, env).parse()
  } catch {
    return err('#ERROR!')
  }
}

class FormulaParser {
  private pos = 0

  constructor(
    private readonly source: string,
    private readonly grid: SpreadsheetGrid,
    private readonly visiting: Set<string>,
    private readonly env: FormulaEnv,
  ) {}

  parse(): CellValue {
    const result = this.comparison()
    this.skipWs()
    if (this.pos < this.source.length) {
      return err('#ERROR!')
    }
    return result
  }

  /** Comparison level, above additive: `A2>5`, `B2<>"Done"`. Left-associative,
   * so `1<2<3` chains. Comparisons produce a `boolean` value. */
  private comparison(): CellValue {
    let left = this.additive()
    for (;;) {
      this.skipWs()
      const op = this.matchComparisonOp()
      if (!op) return left
      left = compareValues(left, this.additive(), op)
    }
  }

  private matchComparisonOp(): CompareOp | null {
    if (this.match('<>')) return '<>'
    if (this.match('<=')) return '<='
    if (this.match('>=')) return '>='
    if (this.match('=')) return '='
    if (this.match('<')) return '<'
    if (this.match('>')) return '>'
    return null
  }

  private additive(): CellValue {
    let left = this.multiplicative()
    for (;;) {
      this.skipWs()
      if (this.match('+')) {
        left = add(left, this.multiplicative())
      } else if (this.match('-')) {
        left = sub(left, this.multiplicative())
      } else {
        return left
      }
    }
  }

  private multiplicative(): CellValue {
    let left = this.unary()
    for (;;) {
      this.skipWs()
      if (this.match('*')) {
        left = mul(left, this.unary())
      } else if (this.match('/')) {
        left = div(left, this.unary())
      } else {
        return left
      }
    }
  }

  private unary(): CellValue {
    this.skipWs()
    if (this.match('-')) {
      return neg(this.unary())
    }
    if (this.match('+')) {
      return this.unary()
    }
    return this.power()
  }

  private power(): CellValue {
    const left = this.atom()
    this.skipWs()
    if (this.match('^')) {
      return pow(left, this.unary())
    }
    return left
  }

  private atom(): CellValue {
    this.skipWs()
    if (this.match('#REF!')) {
      return err('#REF!')
    }
    if (this.match('(')) {
      const inner = this.comparison()
      this.skipWs()
      if (!this.match(')')) {
        return err('#ERROR!')
      }
      return inner
    }
    const ch = this.peek()
    if (ch === '"') {
      const value = this.readString()
      if (value === null) return err('#ERROR!')
      return text(value)
    }
    if (ch !== undefined && (/[0-9]/.test(ch) || ch === '.')) {
      return num(this.readNumber())
    }
    const start = this.pos
    while (this.pos < this.source.length && /[A-Za-z0-9_.$]/.test(this.source[this.pos]!)) {
      this.pos++
    }
    const ident = this.source.slice(start, this.pos)
    if (!ident) {
      return err('#ERROR!')
    }
    this.skipWs()
    if (this.peek() !== '(' && this.peek() !== ':') {
      const upperIdent = ident.toUpperCase()
      if (upperIdent === 'TRUE') return bool(true)
      if (upperIdent === 'FALSE') return bool(false)
    }
    if (this.match(':')) {
      const start2 = this.pos
      while (this.pos < this.source.length && /[A-Za-z0-9_.$]/.test(this.source[this.pos]!)) {
        this.pos++
      }
      const ident2 = this.source.slice(start2, this.pos)
      const range = parseRange(`${ident}:${ident2}`)
      if (!range) {
        return err('#REF!')
      }
      return this.rangeValue(range)
    }
    if (this.peek() === '(') {
      return this.functionCall(ident)
    }
    const ref = parseCellRef(ident)
    if (!ref) {
      return err('#NAME?', `Unknown name "${ident}"`)
    }
    return this.cellValue(ref.row, ref.col)
  }

  private functionCall(name: string): CellValue {
    this.match('(')
    this.skipWs()
    // Only lazy functions receive `() => CellValue` thunks; eager ones get the
    // already-evaluated values, so an argument is never parsed twice. Arguments
    // are still parsed eagerly for a lazy call (to advance past them and
    // validate the commas/close) but the values are dropped; the branch is
    // re-evaluated from its source slice only when the function forces it.
    const fn = this.env.functions.get(name.toUpperCase())
    const lazy = fn?.lazy === true
    if (this.peek() === ')') {
      this.pos++
      return invokeFunction(name, [], this.env)
    }
    const args: CellValue[] = []
    const argThunks: CellValueThunk[] = []
    for (;;) {
      const start = this.pos
      const value = this.comparison()
      if (lazy) {
        const slice = this.source.slice(start, this.pos)
        argThunks.push(() => new FormulaParser(slice, this.grid, this.visiting, this.env).parse())
      } else {
        args.push(value)
      }
      this.skipWs()
      if (this.match(',')) {
        continue
      }
      if (this.match(')')) break
      return err('#ERROR!')
    }
    if (lazy) return invokeFunction(name, argThunks, this.env)
    return applyFunction(name, args, this.env)
  }

  private cellValue(row: number, col: number): CellValue {
    const cell = this.grid.get(row, col)
    if (!cell) {
      return this.grid.inBounds(row, col) ? blank() : err('#REF!')
    }
    if (cell.formula) {
      const key = cellKey(row, col)
      if (this.visiting.has(key)) {
        return err('#CYCLE!')
      }
      this.visiting.add(key)
      const result = evaluateFormula(cell.formula, this.grid, this.visiting, this.env)
      this.visiting.delete(key)
      return result
    }
    return parseCellValue(cell.raw)
  }

  private rangeValue(range: CellRange): CellValue {
    const items: CellValue[] = []
    for (let row = range.row1; row <= range.row2; row++) {
      for (let col = range.col1; col <= range.col2; col++) {
        const value = this.cellValue(row, col)
        if (value.kind === 'error') {
          return value
        }
        items.push(value)
      }
    }
    return setValue(items)
  }

  private readNumber(): number {
    const start = this.pos
    while (this.pos < this.source.length && /[0-9.]/.test(this.source[this.pos]!)) {
      this.pos++
    }
    return Number(this.source.slice(start, this.pos))
  }

  /** A doubled `""` inside a literal is an escaped quote; `null` on an
   * unterminated literal (no closing `"`). */
  private readString(): string | null {
    this.pos++ // opening "
    let out = ''
    let closed = false
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos]!
      if (ch === '"') {
        if (this.source[this.pos + 1] === '"') {
          out += '"'
          this.pos += 2
          continue
        }
        this.pos++
        closed = true
        break
      }
      out += ch
      this.pos++
    }
    return closed ? out : null
  }

  private match(op: string): boolean {
    if (this.source.startsWith(op, this.pos)) {
      this.pos += op.length
      return true
    }
    return false
  }

  private peek(): string | undefined {
    return this.source[this.pos]
  }

  private skipWs(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos]!)) {
      this.pos++
    }
  }
}

/**
 * Recover the plain text of a cell when its whole content is one inline run
 * wrapped in minor formatting marks (`**100**`, `*100*`, `` `100` ``, `==x==`,
 * `~5~`, `^6^`, and nested combos like `***7***`). The text is returned without
 * its marks, so a styled number still reads as a number for formula math. Mixed
 * content, links, masked pills, and escaped markers fail the single-run check
 * and return the raw string, staying literal.
 */
function unwrapInlineMarks(raw: string): string {
  const segments = parseCellSegments(raw)
  if (segments.length === 1 && !segments[0]!.masked && segments[0]!.href === null) {
    return segments[0]!.text
  }
  return raw
}

function parseCellValue(raw: string): CellValue {
  const trimmed = raw.trim()
  const cleaned = trimmed.replace(/,/g, '')
  if (!cleaned) {
    return blank()
  }
  if (NUMBER_RE.test(cleaned)) {
    return num(Number(cleaned))
  }
  const unwrapped = unwrapInlineMarks(raw).trim()
  if (unwrapped !== trimmed) {
    const uCleaned = unwrapped.replace(/,/g, '')
    if (NUMBER_RE.test(uCleaned)) {
      return num(Number(uCleaned))
    }
    return text(unwrapped)
  }
  return text(trimmed)
}

export function parseCellRef(raw: string): CellRef | null {
  const match = CELL_REF.exec(raw)
  if (!match) {
    return null
  }
  return { col: lettersToCol(match[1]!), row: Number(match[2]) }
}

function parseRange(raw: string): CellRange | null {
  const match = RANGE_REF.exec(raw)
  if (!match) {
    return null
  }
  const col1 = lettersToCol(match[1]!)
  const row1 = Number(match[2])
  const col2 = lettersToCol(match[3]!)
  const row2 = Number(match[4])
  return {
    row1: Math.min(row1, row2),
    col1: Math.min(col1, col2),
    row2: Math.max(row1, row2),
    col2: Math.max(col1, col2),
  }
}

function lettersToCol(letters: string): number {
  let col = 0
  for (const char of letters.toUpperCase()) {
    col = col * 26 + (char.charCodeAt(0) - 64)
  }
  return col
}

export function colToLetters(col: number): string {
  let n = col
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

function cellKey(row: number, col: number): string {
  return `${colToLetters(col)}${row}`
}
