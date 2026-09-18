import { parseCellSegments } from './inline-md'
import {
  BUILTIN_ENV,
  add,
  applyFunction,
  blank,
  div,
  err,
  mul,
  neg,
  num,
  pow,
  setValue,
  sub,
  text,
  type CellValue,
  type FormulaEnv,
} from './formulas'

export const SPREADSHEET_PREFIX = '='

/** A cell whose trimmed text starts with `=` is a formula — except a leading
 * `==`, which is a markdown highlight delimiter (`==text==`), not a formula
 * (no spreadsheet syntax is `= = …`). Distinguishing them keeps cells that are
 * entirely highlighted from erroring out as `#ERROR!` formulas. */
export function isFormula(trimmed: string): boolean {
  return (
    trimmed.startsWith(SPREADSHEET_PREFIX) &&
    !trimmed.startsWith(SPREADSHEET_PREFIX + SPREADSHEET_PREFIX)
  )
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
  if (isFormula(trimmed)) {
    const formula = trimmed.slice(1).trim()
    if (!formula) {
      return { display: '', kind: 'blank' }
    }
    const result = evaluateFormula(formula, grid, visiting, env)
    if (result.kind === 'error') {
      return {
        display: result.message,
        kind: 'error',
        error: result.message,
        hint: result.hint ?? ERROR_HINTS[result.message],
      }
    }
    if (result.kind === 'number') {
      return { display: formatNumber(result.value), kind: 'formula', value: result.value }
    }
    return { display: '', kind: 'formula' }
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
    let hint: string | undefined
    if (result.kind === 'error') {
      domCell.textContent = result.message
      domCell.classList.add('spreadsheet-error')
      hint = result.hint ?? ERROR_HINTS[result.message]
    } else if (result.kind === 'number') {
      domCell.textContent = formatNumber(result.value)
    }
    const raw = formulaCell.raw.trim()
    domCell.title = hint ? `${raw} — ${hint}` : raw
  }
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '#VALUE!'
  }
  return String(Math.round(value * 10000) / 10000)
}

class SpreadsheetGrid {
  private readonly cells = new Map<string, TableCell>()
  private readonly formulas: TableCell[] = []
  private maxRow = 0
  private maxCol = 0

  set(row: number, col: number, raw: string): void {
    const trimmed = raw.trim()
    const cell: TableCell = { row, col, raw, formula: '' }
    if (isFormula(trimmed)) {
      cell.formula = trimmed.slice(1).trim()
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
    const result = this.additive()
    this.skipWs()
    if (this.pos < this.source.length) {
      return err('#ERROR!')
    }
    return result
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
      const inner = this.additive()
      this.skipWs()
      if (!this.match(')')) {
        return err('#ERROR!')
      }
      return inner
    }
    const ch = this.peek()
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
    const args: CellValue[] = []
    this.skipWs()
    if (this.peek() === ')') {
      this.pos++
      return applyFunction(name, args, this.env)
    }
    for (;;) {
      args.push(this.additive())
      this.skipWs()
      if (this.match(',')) {
        continue
      }
      if (this.match(')')) {
        return applyFunction(name, args, this.env)
      }
      return err('#ERROR!')
    }
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
  const cleaned = raw.replace(/,/g, '').trim()
  if (!cleaned) {
    return blank()
  }
  if (NUMBER_RE.test(cleaned)) {
    return num(Number(cleaned))
  }
  const unwrapped = unwrapInlineMarks(raw).replace(/,/g, '').trim()
  if (unwrapped !== cleaned && NUMBER_RE.test(unwrapped)) {
    return num(Number(unwrapped))
  }
  return text()
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
