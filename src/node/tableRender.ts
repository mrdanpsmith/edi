import type { Node as ProseNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import {
  inlineMarkdownToHtml,
  type TableAlign,
} from '../spreadsheet-util'
import { colToLetters } from '../cellRef'
import { solve, isFormula, type SpreadsheetSolution } from '../spreadsheet'
import { formulaEnvFor } from '../formulaDefs'
import {
  COL_PAD,
  INSERT_CORRIDOR,
  INSERT_EDGE,
  MIN_COL_WIDTH,
  ROW_GUTTER_WIDTH,
  bindMaskedPillsIn,
  cellKey,
  cellTitle,
  highlightTableCell,
  searchActiveCell,
  type CellRef,
  type FillRect,
} from './tableShared'
import type { TableSelection } from './tableSelection'

/** The state and commit hooks the renderer reads while drawing. It owns the
 * sheet's DOM (tools, fx bar, grid, insert guide, fill handle) but never the
 * document rows or the selection; those stay with the coordinator. */
export interface TableRenderHost {
  readonly dom: HTMLElement
  readonly view: EditorView
  rows(): string[][]
  align(): TableAlign[]
  selection(): TableSelection
  node(): ProseNode
  position(): number | undefined
  editing(): { row: number; col: number } | null
  editOverlay(): HTMLInputElement | null
  pointRange(): { r1: number; c1: number; r2: number; c2: number } | null
  cutSource(): { r1: number; c1: number; r2: number; c2: number } | null
  fillDrag(): FillRect | null
  fillPreview(drag: FillRect): string
  wireFxInput(input: HTMLInputElement): void
  commitFxEdit(): void
  commitRows(nextRows: string[][], anchor: CellRef, active: CellRef): void
  onGridMouseDown(event: MouseEvent): void
  onGridKeydown(event: KeyboardEvent): void
  onDblClick(event: MouseEvent): void
  onGridFocus(): void
  updatePointCursor(): void
  onStartFill(event: MouseEvent): void
  onAutofill(): void
  alignColumns(align: TableAlign): void
  useValues(): void
  setResolved(resolved: boolean): void
  insertAt(axis: 'col' | 'row', index: number): void
}

/**
 * Draws the spreadsheet: the static chrome, the grid and every repaint of the
 * selection, formula values, fill handle and insert guide. Interaction decisions
 * are still the coordinator's; this module only turns them into DOM.
 */
export class TableRenderer {
  grid: HTMLElement | null = null
  gridWrap: HTMLElement | null = null
  colEls: HTMLTableColElement[] = []
  cornerEl: HTMLElement | null = null
  headCells: HTMLElement[] = []
  rowGutters: HTMLElement[] = []
  cells: HTMLElement[][] = []
  fxInput: HTMLInputElement | null = null
  nameBox: HTMLElement | null = null
  statusEl: HTMLElement | null = null
  resolveInput: HTMLInputElement | null = null
  valuesButton: HTMLButtonElement | null = null
  fillHandleEl: HTMLElement | null = null
  alignButtons: Array<{ align: TableAlign; el: HTMLElement }> = []
  insertGuide: HTMLElement | null = null
  insertGuideLine: HTMLElement | null = null
  insertGuidePlus: HTMLElement | null = null
  insertGuideTarget: { axis: 'col' | 'row'; index: number; x: number; y: number } | null = null
  private renderedSolution: SpreadsheetSolution | null = null
  private fillTooltipEl: HTMLElement | null = null

  constructor(private readonly host: TableRenderHost) {}

  build(): void {
    this.host.dom.appendChild(this.buildTools())
    this.buildFxBar()
    this.buildGrid()
    this.buildInsertGuide()
  }

  get lastSolution(): SpreadsheetSolution | null {
    return this.renderedSolution
  }

  // --- Static chrome ---

  /**
   * The sheet's own control row, at the **left** of the sheet's chrome and below
   * the grid's own header: the three alignment buttons, **Use values**, the
   * "Resolve formulas?" checkbox, and the status readout on their own.
   */
  private buildTools(): HTMLElement {
    const tools = document.createElement('div')
    tools.className = 'ss-tools'
    for (const [align, title, markup] of [
      ['left', 'Align selected column left (click again to clear)', '<path d="M2 4h12M2 8h8M2 12h12"/>'],
      ['center', 'Align selected column center (click again to clear)', '<path d="M2 4h12M4 8h8M2 12h12"/>'],
      ['right', 'Align selected column right (click again to clear)', '<path d="M2 4h12M6 8h8M2 12h12"/>'],
    ] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ss-tool ss-tool-icon'
      button.dataset.align = align
      button.title = title
      button.setAttribute('aria-label', title)
      button.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
        `stroke-linecap="round" aria-hidden="true">${markup}</svg>`
      button.addEventListener('click', () => {
        this.host.commitFxEdit()
        this.host.alignColumns(align)
      })
      tools.appendChild(button)
      this.alignButtons.push({ align, el: button })
    }
    const valuesBtn = document.createElement('button')
    valuesBtn.type = 'button'
    valuesBtn.className = 'ss-tool ss-tool-view'
    valuesBtn.textContent = 'Use values'
    valuesBtn.title =
      'Replace the selected cells’ formulas with their current computed values (they stop recalculating — undo with Ctrl+Z)'
    valuesBtn.addEventListener('click', () => {
      this.host.useValues()
    })
    this.valuesButton = valuesBtn
    // **Before** the status, not after it. `.ss-status` is `margin-left: auto`, so
    // it takes the slack in the row and shoves everything after it to the far
    // right — which put "Use values" 970px from the alignment buttons it belongs
    // beside. The controls are the left of the row; the readout alone takes the
    // right, and the label of the group next to it is what says so.
    tools.appendChild(valuesBtn)
    const resolveLabel = document.createElement('label')
    resolveLabel.className = 'ss-tool ss-tool-check'
    resolveLabel.title =
      'Save this table’s computed values to markdown instead of its formulas (the formulas stay in a comment and are restored when the file is opened)'
    const resolveInput = document.createElement('input')
    resolveInput.type = 'checkbox'
    resolveInput.checked = Boolean(this.host.node().attrs._resolved)
    resolveInput.addEventListener('change', () => {
      this.host.commitFxEdit()
      this.host.setResolved(resolveInput.checked)
    })
    this.resolveInput = resolveInput
    const resolveText = document.createElement('span')
    resolveText.textContent = 'Resolve formulas?'
    resolveLabel.appendChild(resolveInput)
    resolveLabel.appendChild(resolveText)
    // Also **before** the status, and for the same reason: it is a control about
    // the values in this sheet — the same question "Use values" answers, for the
    // whole sheet rather than the selection — so it belongs beside that button,
    // not stranded at the far right of the row with the readout.
    tools.appendChild(resolveLabel)
    const status = document.createElement('span')
    status.className = 'ss-status'
    tools.appendChild(status)
    this.statusEl = status
    return tools
  }

  private buildFxBar(): void {
    const fxbar = document.createElement('div')
    fxbar.className = 'ss-fxbar'
    const nameBox = document.createElement('span')
    nameBox.className = 'ss-namebox'
    fxbar.appendChild(nameBox)
    this.nameBox = nameBox
    const fxInput = document.createElement('input')
    fxInput.type = 'text'
    fxInput.className = 'ss-fx-input'
    fxInput.spellcheck = false
    fxInput.placeholder = 'fx'
    fxbar.appendChild(fxInput)
    this.fxInput = fxInput
    this.host.wireFxInput(fxInput)

    this.host.dom.appendChild(fxbar)
  }

  // --- Grid ---

  buildGrid(): void {
    // Rebuilding replaces the grid element; keep keyboard focus on it so typing
    // still starts an edit after a structural change (e.g. Delete clearing a cell).
    const refocus =
      this.grid !== null &&
      (document.activeElement === this.grid || this.grid.contains(document.activeElement))
    const oldWrap = this.gridWrap
    const wrap = document.createElement('div')
    wrap.className = 'ss-table-scroll'
    const grid = document.createElement('table')
    grid.className = 'ss-grid'
    grid.tabIndex = 0
    this.grid = grid
    this.gridWrap = wrap

    const rows = this.host.rows()
    const cols = rows[0]?.length ?? 0

    const colgroup = document.createElement('colgroup')
    const gutterCol = document.createElement('col')
    gutterCol.className = 'ss-gutter'
    gutterCol.style.width = `${ROW_GUTTER_WIDTH}px`
    colgroup.appendChild(gutterCol)
    this.colEls = []
    for (let c = 0; c < cols; c++) {
      const col = document.createElement('col')
      colgroup.appendChild(col)
      this.colEls.push(col)
    }
    grid.appendChild(colgroup)

    const head = document.createElement('thead')
    const headRow = document.createElement('tr')
    const corner = document.createElement('th')
    corner.className = 'ss-corner'
    headRow.appendChild(corner)
    this.cornerEl = corner
    this.headCells = []
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th')
      th.className = 'ss-col'
      th.dataset.col = String(c)
      const label = document.createElement('span')
      label.className = 'ss-cell-content'
      label.textContent = colToLetters(c + 1)
      th.appendChild(label)
      headRow.appendChild(th)
      this.headCells.push(th)
    }
    head.appendChild(headRow)

    const body = document.createElement('tbody')
    this.rowGutters = []
    this.cells = []
    const align = this.host.align()
    for (let r = 0; r < rows.length; r++) {
      const tr = document.createElement('tr')
      const gutter = document.createElement('th')
      gutter.className = 'ss-row'
      gutter.dataset.row = String(r)
      const gutterLabel = document.createElement('span')
      gutterLabel.className = 'ss-gutter-label'
      gutterLabel.textContent = String(r + 1)
      gutter.appendChild(gutterLabel)
      tr.appendChild(gutter)
      this.rowGutters.push(gutter)
      const rowCells: HTMLElement[] = []
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td')
        td.className = r === 0 ? 'ss-cell ss-header' : 'ss-cell'
        td.dataset.row = String(r)
        td.dataset.col = String(c)
        td.dataset.align = align[c] ?? 'none'
        tr.appendChild(td)
        rowCells.push(td)
      }
      this.cells.push(rowCells)
      body.appendChild(tr)
    }

    grid.appendChild(head)
    grid.appendChild(body)
    wrap.appendChild(grid)

    if (oldWrap && oldWrap.parentNode === this.host.dom) this.host.dom.replaceChild(wrap, oldWrap)
    else this.host.dom.appendChild(wrap)

    // Measure against real layout so defaults follow the cell content
    this.fillCellContents()
    this.applySizing(cols)

    grid.addEventListener('mousedown', (event) => this.host.onGridMouseDown(event))
    grid.addEventListener('focus', () => this.host.onGridFocus())
    grid.addEventListener('keydown', (event) => this.host.onGridKeydown(event))
    grid.addEventListener('dblclick', (event) => this.host.onDblClick(event))
    wrap.addEventListener('scroll', () => this.hideInsertGuide())
    if (refocus) grid.focus()
  }

  /** A floating overlay showing where a hover insert would land: a blue rule
   * between the target rows/columns with a `+` button at its end. */
  private buildInsertGuide(): void {
    const guide = document.createElement('div')
    guide.className = 'ss-insert-guide'
    guide.hidden = true
    const line = document.createElement('div')
    line.className = 'ss-insert-line'
    guide.appendChild(line)
    const plus = document.createElement('button')
    plus.type = 'button'
    plus.className = 'ss-insert-plus'
    plus.textContent = '+'
    plus.setAttribute('aria-label', 'Insert here')
    plus.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    plus.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.commitInsertGuide()
    })
    guide.appendChild(plus)
    this.insertGuide = guide
    this.insertGuideLine = line
    this.insertGuidePlus = plus
    this.host.dom.appendChild(guide)
    this.host.dom.addEventListener('mousemove', (event) => this.onInsertHover(event))
    this.host.dom.addEventListener('mouseleave', () => this.hideInsertGuide())
  }

  private onInsertHover(event: MouseEvent): void {
    if (!this.grid || !this.insertGuide) return
    const target = event.target
    // Moving onto the floating button keeps the guide put so it stays clickable.
    if (target instanceof Element && target.closest('.ss-insert-plus')) return
    // Forgive slight excursions: keep a shown guide while the pointer stays in
    // the corridor around its boundary (e.g. the short trip up to the button).
    if (this.insertGuideTarget && this.pointInInsertCorridor(event.clientX, event.clientY)) return
    if (!(target instanceof Element)) {
      this.hideInsertGuide()
      return
    }
    // The guide lives on the boundary between two chrome cells, so only the
    // lead/trail edge of a header/gutter — not its middle — triggers it.
    const col = target.closest('th.ss-col')
    if (col) {
      const index = Number((col as HTMLElement).dataset.col)
      const rect = col.getBoundingClientRect()
      if (event.clientX - rect.left <= INSERT_EDGE) {
        this.showInsertGuide('col', index, rect.left, rect.top)
        return
      }
      if (rect.right - event.clientX <= INSERT_EDGE) {
        this.showInsertGuide('col', index + 1, rect.right, rect.top)
        return
      }
      this.hideInsertGuide()
      return
    }
    const row = target.closest('th.ss-row')
    if (row) {
      const index = Number((row as HTMLElement).dataset.row)
      const rect = row.getBoundingClientRect()
      if (event.clientY - rect.top <= INSERT_EDGE && index > 0) {
        this.showInsertGuide('row', index, rect.left, rect.top)
        return
      }
      if (rect.bottom - event.clientY <= INSERT_EDGE) {
        this.showInsertGuide('row', index + 1, rect.left, rect.bottom)
        return
      }
      this.hideInsertGuide()
      return
    }
    this.hideInsertGuide()
  }

  /** True while the pointer sits within the forgiving band around the shown
   * guide's boundary, including the space its floating button occupies. */
  private pointInInsertCorridor(clientX: number, clientY: number): boolean {
    const grid = this.grid
    const target = this.insertGuideTarget
    if (!grid || !target) return false
    const base = this.host.dom.getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    const px = clientX - base.left
    const py = clientY - base.top
    const size = this.insertGuidePlus?.offsetWidth || 16
    if (target.axis === 'col') {
      const top = gridRect.top - base.top - size - INSERT_CORRIDOR
      const bottom = gridRect.bottom - base.top
      return Math.abs(px - target.x) <= INSERT_CORRIDOR && py >= top && py <= bottom
    }
    const left = gridRect.left - base.left - size - INSERT_CORRIDOR
    const right = gridRect.right - base.left
    return Math.abs(py - target.y) <= INSERT_CORRIDOR && px >= left && px <= right
  }

  private showInsertGuide(axis: 'col' | 'row', index: number, clientX: number, clientY: number): void {
    const grid = this.grid
    const guide = this.insertGuide
    const line = this.insertGuideLine
    const plus = this.insertGuidePlus
    const rows = this.host.rows()
    const cols = rows[0]?.length ?? 0
    const max = axis === 'col' ? cols : rows.length
    if (!grid || !guide || !line || !plus || !Number.isFinite(index) || index < 0 || index > max) return
    const base = this.host.dom.getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    const tableTop = gridRect.top - base.top
    const tableBottom = gridRect.bottom - base.top
    const tableLeft = gridRect.left - base.left
    const tableRight = gridRect.right - base.left
    const x = clientX - base.left
    const y = clientY - base.top
    const size = plus.offsetWidth || 16
    const atEnd = axis === 'col' ? index >= cols : index >= rows.length
    this.insertGuideTarget = { axis, index, x, y }
    this.host.dom.classList.toggle('ss-inserting-col', axis === 'col')
    this.host.dom.classList.toggle('ss-inserting-row', axis === 'row')
    guide.hidden = false
    if (axis === 'col') {
      plus.style.left = `${x - size / 2}px`
      plus.style.top = `${tableTop - size}px`
      line.style.left = `${x - 1}px`
      line.style.top = `${tableTop}px`
      line.style.width = '2px'
      line.style.height = `${tableBottom - tableTop}px`
    } else {
      plus.style.left = `${tableLeft - size}px`
      plus.style.top = `${y - size / 2}px`
      line.style.left = `${tableLeft}px`
      line.style.top = `${y - 1}px`
      line.style.width = `${tableRight - tableLeft}px`
      line.style.height = '2px'
    }
    plus.title =
      axis === 'col'
        ? atEnd
          ? 'Append column at the end'
          : `Insert column before ${colToLetters(index + 1)}`
        : atEnd
          ? 'Append row at the end'
          : `Insert row above ${index + 1}`
  }

  hideInsertGuide(): void {
    if (!this.insertGuide) return
    this.insertGuide.hidden = true
    this.insertGuideTarget = null
    this.host.dom.classList.remove('ss-inserting-col', 'ss-inserting-row')
  }

  /** Insert at the guide currently shown. Shared by the `+` click and a
   * double-click on the row/column chrome while the guide is open. */
  commitInsertGuide(): void {
    const target = this.insertGuideTarget
    this.hideInsertGuide()
    if (!target) return
    this.host.insertAt(target.axis, target.index)
  }

  /** Fit each column to its content. Widths are never persisted to markdown,
   * so they are recomputed from the cells on every rebuild. */
  private applySizing(cols: number): void {
    for (let c = 0; c < cols; c++) {
      const colEl = this.colEls[c]
      if (!colEl) continue
      colEl.style.width = `${this.measureColDefault(c)}px`
    }
  }

  private measureColDefault(col: number): number {
    let max = 0
    for (let r = 0; r < this.host.rows().length; r++) {
      const inner = this.cells[r]?.[col]?.querySelector<HTMLElement>('.ss-cell-content')
      if (inner) max = Math.max(max, inner.offsetWidth)
    }
    const head = this.headCells[col]?.querySelector<HTMLElement>('.ss-cell-content')
    if (head) max = Math.max(max, head.offsetWidth)
    return Math.max(MIN_COL_WIDTH, Math.ceil(max) + COL_PAD)
  }

  fillCellContents(): void {
    const rows = this.host.rows()
    const solution = solve(rows, formulaEnvFor(this.host.view.state))
    this.renderedSolution = solution
    const active = searchActiveCell(this.host.view, this.host.node(), this.host.position)
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < (rows[0]?.length ?? 0); c++) {
        const td = this.cells[r]?.[c]
        if (!td) continue
        const cellSol = solution.cells[r]?.[c]
        td.classList.remove('ss-formula', 'ss-error')
        td.removeAttribute('title')
        td.textContent = ''
        const inner = document.createElement('span')
        inner.className = 'ss-cell-content'
        if (cellSol && (cellSol.kind === 'formula' || cellSol.kind === 'error')) {
          if (cellSol.styled || cellSol.rendersMarkdown) {
            inner.innerHTML = inlineMarkdownToHtml(cellSol.display, { indexedMasked: true, markMisleading: true })
          } else {
            inner.textContent = cellSol.display
          }
          td.classList.add(cellSol.kind === 'error' ? 'ss-error' : 'ss-formula')
        } else {
          const display = cellSol?.display ?? ''
          if (display) inner.innerHTML = inlineMarkdownToHtml(display, { indexedMasked: true, markMisleading: true })
        }
        td.appendChild(inner)
        if (!cellSol || (cellSol.kind !== 'formula' && cellSol.kind !== 'error')) {
          this.bindMaskedPills(td, r, c)
        }
        highlightTableCell(this.host.view, td, r, c, active)
        const raw = rows[r]?.[c] ?? ''
        if (raw) td.title = cellTitle(raw, cellSol)
      }
    }
  }

  /** Wire ``.masked-field`` pills rendered into a cell to their real token, so
   * they get the show/copy/edit actions of a body masked field. */
  private bindMaskedPills(td: HTMLElement, row: number, col: number): void {
    bindMaskedPillsIn(td, this.host.rows(), row, col, (next, anchor, active) =>
      this.host.commitRows(next, anchor, active),
    )
  }

  renderSelection(): void {
    this.updateNameBox()
    this.updateStatus()
    this.updateFxSync()
    this.host.updatePointCursor()
    if (!this.grid) return
    const selection = this.host.selection()
    const rows = this.host.rows()
    const rowCount = rows.length
    const cols = rows[0]?.length ?? 0
    const selCols = selection.selectedCols(rowCount, cols)
    const selRows = selection.selectedRows(rowCount, cols)

    for (let r = 0; r < rowCount; r++) {
      this.rowGutters[r]?.classList.toggle('ss-selected', selRows.has(r))
      for (let c = 0; c < cols; c++) {
        const td = this.cells[r]?.[c]
        if (!td) continue
        td.classList.toggle('ss-range', selection.contains(r, c))
        td.classList.toggle('ss-selected', selection.extra.has(cellKey(r, c)))
        td.classList.toggle(
          'ss-active',
          selection.active !== null && selection.active.row === r && selection.active.col === c,
        )
        const cut = this.host.cutSource()
        td.classList.toggle(
          'ss-cut',
          cut !== null && r >= cut.r1 && r <= cut.r2 && c >= cut.c1 && c <= cut.c2,
        )
        const point = this.host.pointRange()
        td.classList.toggle(
          'ss-point',
          point !== null && r >= point.r1 && r <= point.r2 && c >= point.c1 && c <= point.c2,
        )
      }
    }
    for (let c = 0; c < cols; c++) {
      this.headCells[c]?.classList.toggle('ss-selected', selCols.has(c))
    }
    this.cornerEl?.classList.toggle('ss-selected', selRows.size === rowCount && selCols.size === cols)
    this.renderFillHandle()
    this.updateAlignButtons()
    this.updateValuesButton()
  }

  /** Columns the align buttons act on: the selected columns, or the active
   * cell's column when nothing is explicitly selected. */
  alignTargetCols(): Set<number> {
    const selection = this.host.selection()
    const rows = this.host.rows()
    const cols = selection.selectedCols(rows.length, rows[0]?.length ?? 0)
    if (cols.size === 0 && selection.active) cols.add(selection.active.col)
    return cols
  }

  updateAlignButtons(): void {
    if (this.alignButtons.length === 0) return
    const align = this.host.align()
    const cols = this.alignTargetCols()
    const alignments = new Set([...cols].map((c) => align[c] ?? 'none'))
    const current = alignments.size === 1 ? [...alignments][0]! : null
    for (const { align: kind, el } of this.alignButtons) {
      el.classList.toggle('ss-tool-active', current === kind)
    }
  }

  /** Draw (or clear) the Excel-style fill handle at the bottom-right corner of
   * the current selection. Hidden while editing, cutting, or during a drag. */
  renderFillHandle(): void {
    const old = this.fillHandleEl
    if (old) {
      old.remove()
      this.fillHandleEl = null
    }
    const selection = this.host.selection()
    if (this.host.editing() || this.host.cutSource() || this.host.fillDrag()) return
    if (!selection.anchor || !selection.active || selection.extra.size > 0) return
    const rows = this.host.rows()
    const rowCount = rows.length
    const cols = rows[0]?.length ?? 0
    if (rowCount === 0 || cols === 0) return
    const corner = this.cells[
      Math.min(Math.max(selection.anchor.row, selection.active.row), rowCount - 1)
    ]?.[Math.min(Math.max(selection.anchor.col, selection.active.col), cols - 1)]
    if (!corner) return
    const handle = document.createElement('div')
    handle.className = 'ss-fill-handle'
    handle.title = 'Drag to fill cells, double-click to autofill'
    handle.addEventListener('mousedown', (event) => this.host.onStartFill(event))
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.host.onAutofill()
    })
    corner.appendChild(handle)
    this.fillHandleEl = handle
  }

  updateFillGhost(): void {
    const drag = this.host.fillDrag()
    if (!drag) return
    const rows = this.host.rows()
    const rowCount = rows.length
    const cols = rows[0]?.length ?? 0
    for (let r = drag.r1; r <= drag.r2; r++) {
      for (let c = drag.c1; c <= drag.c2; c++) {
        if (r < 0 || c < 0 || r >= rowCount || c >= cols) continue
        if (r >= drag.sr1 && r <= drag.sr2 && c >= drag.sc1 && c <= drag.sc2) continue
        this.cells[r]?.[c]?.classList.add('ss-fill-target')
      }
    }
    const text = this.host.fillPreview(drag)
    let tooltip = this.fillTooltipEl
    if (text === '') {
      if (tooltip) {
        tooltip.remove()
        this.fillTooltipEl = null
      }
      return
    }
    if (!tooltip) {
      tooltip = document.createElement('div')
      tooltip.className = 'ss-fill-tooltip'
      this.gridWrap?.appendChild(tooltip)
      this.fillTooltipEl = tooltip
    }
    tooltip.textContent = text
    this.positionFillTooltip()
  }

  private positionFillTooltip(): void {
    const tooltip = this.fillTooltipEl
    const wrap = this.gridWrap
    const drag = this.host.fillDrag()
    if (!tooltip || !wrap || !drag) return
    const corner = this.cells[drag.r2]?.[drag.c2]
    if (!corner) return
    const wrapRect = wrap.getBoundingClientRect()
    const cellRect = corner.getBoundingClientRect()
    tooltip.style.left = `${Math.min(
      wrap.clientWidth - tooltip.offsetWidth - 8,
      cellRect.right - wrapRect.left + 6,
    )}px`
    tooltip.style.top = `${Math.max(2, cellRect.top - wrapRect.top - 26)}px`
  }

  clearFillGhost(): void {
    this.host.dom.classList.remove('ss-filling')
    if (this.fillTooltipEl) {
      this.fillTooltipEl.remove()
      this.fillTooltipEl = null
    }
    for (const row of this.cells) {
      for (const td of row) td?.classList.remove('ss-fill-target')
    }
  }

  private updateNameBox(): void {
    const active = this.host.selection().active
    if (!this.nameBox || !active) return
    this.nameBox.textContent = `${colToLetters(active.col + 1)}${active.row + 1}`
  }

  private updateFxSync(): void {
    const active = this.host.selection().active
    if (!this.fxInput || !active) return
    if (document.activeElement === this.fxInput || document.activeElement === this.host.editOverlay()) return
    this.fxInput.value = this.host.rows()[active.row]?.[active.col] ?? ''
  }

  private updateStatus(): void {
    if (!this.statusEl) return
    const selection = this.host.selection()
    const rows = this.host.rows()
    const cells = selection.collect(rows.length, rows[0]?.length ?? 0)
    let sum = 0
    let count = 0
    const solution = this.renderedSolution ?? solve(rows, formulaEnvFor(this.host.view.state))
    for (const { row, col } of cells) {
      const value = solution.cells[row]?.[col]?.value
      if (typeof value === 'number') {
        sum += value
        count++
      }
    }
    if (count === 0) {
      this.statusEl.textContent = ''
      return
    }
    const avg = sum / count
    const fmt = (v: number): string => String(Math.round(v * 10000) / 10000)
    this.statusEl.textContent = `Σ ${fmt(sum)}  avg ${fmt(avg)}  count ${count}`
  }

  private updateValuesButton(): void {
    if (!this.valuesButton) return
    const selection = this.host.selection()
    const rows = this.host.rows()
    let any = false
    for (const { row, col } of selection.collect(rows.length, rows[0]?.length ?? 0)) {
      if (isFormula(rows[row]?.[col] ?? '')) {
        any = true
        break
      }
    }
    this.valuesButton.disabled = !any
  }
}
