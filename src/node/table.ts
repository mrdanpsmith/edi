import { Plugin, PluginKey, TextSelection, type EditorState, type NodeSelection, type Transaction } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { parsePipes, tableToPipes, inlineMarkdownToHtml, listMaskedTokens } from '../spreadsheet-util'
import { solve, colToLetters, type CellSolution } from '../spreadsheet'
import { copyText } from '../clipboard'
import { blockNodeView } from '../blockview'
import { setActiveCellHost, type InlineCellHost, type InlineCellKind } from '../inline-format'
import { bindCellMaskedField, maskedFieldToMarkdown, promptForNewSecret } from './masked'

interface CellRef {
  row: number
  col: number
}

const cellKey = (row: number, col: number): string => `${row}:${col}`

const MIN_COL_WIDTH = 48
const MAX_COL_WIDTH = 480
const COL_PAD = 22
const MIN_ROW_HEIGHT = 24
const ROW_GUTTER_WIDTH = 30
const MAX_ROW_HEIGHT = 480
const EDIT_INPUT_PAD = 20

function createHandleDOM(pos: number): HTMLElement {
  const handle = document.createElement('div')
  handle.className = 'block-handle'
  handle.setAttribute('data-block-pos', String(pos))
  handle.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
    <circle cx="3" cy="2" r="1.2"/><circle cx="9" cy="2" r="1.2"/>
    <circle cx="3" cy="6" r="1.2"/><circle cx="9" cy="6" r="1.2"/>
    <circle cx="3" cy="10" r="1.2"/><circle cx="9" cy="10" r="1.2"/>
  </svg>`
  return handle
}

class TableNodeView implements NodeView, InlineCellHost {
  dom: HTMLElement
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined

  private rows: string[][] = []
  private grid: HTMLElement | null = null
  private gridWrap: HTMLElement | null = null
  private colEls: HTMLTableColElement[] = []
  private cornerEl: HTMLElement | null = null
  private headCells: HTMLElement[] = []
  private rowGutters: HTMLElement[] = []
  private cells: HTMLElement[][] = []
  private colWidths: (number | undefined)[] = []
  private rowHeights: (number | undefined)[] = []

  private anchor: CellRef | null = null
  private active: CellRef | null = null
  private extra = new Set<string>()
  private editing: { row: number; col: number } | null = null
  private editOverlay: HTMLInputElement | null = null
  private fxInput: HTMLInputElement | null = null
  private nameBox: HTMLElement | null = null
  private statusEl: HTMLElement | null = null
  private dragging = false

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.rows = parsePipes(String(node.attrs.value ?? ''))
    this.dom = document.createElement('div')
    this.dom.className = 'spreadsheet'

    const pos = getPos()
    if (pos !== undefined) {
      const $pos = view.state.doc.resolve(pos)
      if ($pos.parent.type.name === 'doc') {
        this.dom.appendChild(createHandleDOM(pos))
      }
    }

    this.dom.addEventListener('mousedown', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('.ss-edit-input') || target.closest('.ss-fx-input')) {
        event.stopPropagation()
        return
      }
      event.preventDefault()
      event.stopPropagation()
    })
    this.buildTools()
    this.buildFxBar()
    this.buildGrid()
    this.anchor = { row: 0, col: 0 }
    this.active = { row: 0, col: 0 }
    this.renderSelection()
    ensureInlineFocusListeners()
  }

  /**
   * Apply an inline formatting change to every selected cell (or, with the fx
   * bar / edit overlay active, the active cell), so the toolbar's
   * bold/italic/strike/code/link buttons work across a multi-cell selection.
   * Marker kinds (bold/italic/strike/code) wrap the selection unless every cell
   * is already wrapped (then they unwrap); links are set to the URL on all
   * selected cells.
   */
  applyInline(kind: InlineCellKind, url?: string): boolean {
    if (kind === 'secret') {
      if (this.active === null) return false
      void this.insertSecret()
      return true
    }
    const cells = this.collectSelected()
    if (cells.length === 0) return false
    const rawOf = (row: number, col: number): string => {
      if (this.editing && this.editOverlay && this.editing.row === row && this.editing.col === col) {
        return this.editOverlay.value
      }
      if (
        this.fxInput &&
        document.activeElement === this.fxInput &&
        this.active &&
        this.active.row === row &&
        this.active.col === col
      ) {
        return this.fxInput.value
      }
      return this.rows[row]?.[col] ?? ''
    }
    const next = this.rows.map((r) => [...r])
    let changed = false
    if (kind === 'link') {
      for (const { row, col } of cells) {
        const raw = rawOf(row, col)
        const result = setLink(raw, url)
        if (result !== raw) changed = true
        next[row]![col] = result
      }
    } else {
      // Marker kinds apply uniformly to the whole selection: wrap unless every
      // selected cell is already wrapped (then unwrap them all).
      const wrap = !cells.every(({ row, col }) => isMarked(rawOf(row, col), kind))
      for (const { row, col } of cells) {
        const raw = rawOf(row, col)
        const result = wrap ? wrapMark(raw, kind) : stripMark(raw, kind)
        if (result !== raw) changed = true
        next[row]![col] = result
      }
    }
    if (!changed) return false
    if (this.editing) this.teardownEdit()
    const anchor = this.anchor ?? cells[0]!
    const active = this.active ?? cells[cells.length - 1]!
    this.commitRows(next, anchor, active)
    this.grid?.focus()
    return true
  }

  update(node: ProseNode): boolean {
    if (node.attrs._source !== this.node.attrs._source) return false
    if (node.attrs._plain !== this.node.attrs._plain) return false
    this.node = node
    const rows = parsePipes(String(node.attrs.value ?? ''))
    if (JSON.stringify(rows) !== JSON.stringify(this.rows)) {
      this.rows = rows
      this.anchor = { row: 0, col: 0 }
      this.active = { row: 0, col: 0 }
      this.extra.clear()
      this.teardownEdit()
      this.buildGrid()
      this.renderSelection()
    }
    return true
  }

  // --- Static chrome ---

  private buildTools(): void {
    const tools = document.createElement('div')
    tools.className = 'ss-tools'
    const actions: Array<{ label: string; run: () => void }> = [
      { label: '+Col', run: () => this.addColumn() },
      { label: '+Row', run: () => this.addRow() },
      { label: '−Col', run: () => this.removeColumns() },
      { label: '−Row', run: () => this.removeRows() },
      { label: 'Clear', run: () => this.clearSelected() },
    ]
    for (const action of actions) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ss-tool'
      button.textContent = action.label
      button.title = {
        '+Col': 'Insert column to the right',
        '+Row': 'Insert row below',
        '−Col': 'Delete selected columns',
        '−Row': 'Delete selected rows',
        Clear: 'Clear selected cells',
      }[action.label] ?? action.label
      button.addEventListener('click', () => {
        this.commitFxEdit()
        action.run()
      })
      tools.appendChild(button)
    }
    const status = document.createElement('span')
    status.className = 'ss-status'
    tools.appendChild(status)
    this.statusEl = status
    const viewBtn = document.createElement('button')
    viewBtn.type = 'button'
    viewBtn.className = 'ss-tool ss-tool-view'
    viewBtn.textContent = 'View'
    viewBtn.title = 'View this table as plain text'
    viewBtn.addEventListener('click', () => {
      this.commitFxEdit()
      enterPlainMode(this.view, this.getPos())
    })
    tools.appendChild(viewBtn)
    this.dom.appendChild(tools)
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
    fxInput.addEventListener('keydown', (event) => this.onFxInputKeydown(event))
    fxInput.addEventListener('blur', () => this.commitFxEdit())
    fxInput.addEventListener('focus', () => setActiveCellHost(this))
    fxbar.appendChild(fxInput)
    this.fxInput = fxInput
    this.dom.appendChild(fxbar)
  }

  // --- Grid ---

  private buildGrid(): void {
    const oldWrap = this.gridWrap
    const wrap = document.createElement('div')
    wrap.className = 'ss-table-scroll'
    const grid = document.createElement('table')
    grid.className = 'ss-grid'
    grid.tabIndex = 0
    this.grid = grid
    this.gridWrap = wrap

    const cols = this.rows[0]?.length ?? 0

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
      const resize = document.createElement('div')
      resize.className = 'ss-col-resize'
      resize.dataset.col = String(c)
      resize.title = 'Drag to resize'
      resize.addEventListener('mousedown', (event) => this.startColResize(event, c))
      th.appendChild(resize)
      headRow.appendChild(th)
      this.headCells.push(th)
    }
    head.appendChild(headRow)

    const body = document.createElement('tbody')
    this.rowGutters = []
    this.cells = []
    for (let r = 0; r < this.rows.length; r++) {
      const tr = document.createElement('tr')
      const gutter = document.createElement('th')
      gutter.className = 'ss-row'
      gutter.dataset.row = String(r)
      gutter.textContent = String(r + 1)
      const resize = document.createElement('div')
      resize.className = 'ss-row-resize'
      resize.dataset.row = String(r)
      resize.title = 'Drag to resize'
      resize.addEventListener('mousedown', (event) => this.startRowResize(event, r))
      gutter.appendChild(resize)
      tr.appendChild(gutter)
      this.rowGutters.push(gutter)
      const rowCells: HTMLElement[] = []
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td')
        td.className = 'ss-cell'
        td.dataset.row = String(r)
        td.dataset.col = String(c)
        tr.appendChild(td)
        rowCells.push(td)
      }
      this.cells.push(rowCells)
      body.appendChild(tr)
    }

    grid.appendChild(head)
    grid.appendChild(body)
    wrap.appendChild(grid)

    if (oldWrap && oldWrap.parentNode === this.dom) this.dom.replaceChild(wrap, oldWrap)
    else this.dom.appendChild(wrap)

    // Measure against real layout so defaults follow the cell content
    this.fillCellContents()
    this.applySizing(cols)

    grid.addEventListener('mousedown', (event) => this.onGridMouseDown(event))
    grid.addEventListener('focus', () => setActiveCellHost(this))
    grid.addEventListener('keydown', (event) => this.onGridKeydown(event))
    grid.addEventListener('copy', (event) => this.onCopy(event as ClipboardEvent))
    grid.addEventListener('paste', (event) => this.onPaste(event as ClipboardEvent))
    grid.addEventListener('dblclick', (event) => this.onDblClick(event))
  }

  /**
   * Size columns to `col <col>` elements. User-resized columns/rows keep their
   * size across rebuilds; anything else re-fits to the current content.
   */
  private applySizing(cols: number): void {
    for (let c = 0; c < cols; c++) {
      const colEl = this.colEls[c]
      if (!colEl) continue
      const stored = this.colWidths[c]
      const width = stored === undefined ? this.measureColDefault(c) : stored
      colEl.style.width = `${width}px`
    }
    for (let r = 0; r < this.rows.length; r++) {
      const tr = this.rowGutters[r]?.parentElement
      if (!tr) continue
      const stored = this.rowHeights[r]
      const height = stored === undefined ? this.measureRowDefault(r) : stored
      tr.style.height = `${height}px`
    }
  }

  private measureColDefault(col: number): number {
    let max = 0
    for (let r = 0; r < this.rows.length; r++) {
      const inner = this.cells[r]?.[col]?.querySelector<HTMLElement>('.ss-cell-content')
      if (inner) max = Math.max(max, inner.offsetWidth)
    }
    const head = this.headCells[col]?.querySelector<HTMLElement>('.ss-cell-content')
    if (head) max = Math.max(max, head.offsetWidth)
    return Math.max(MIN_COL_WIDTH, Math.ceil(max) + COL_PAD)
  }

  private measureRowDefault(row: number): number {
    const tr = this.rowGutters[row]?.parentElement
    if (!tr) return MIN_ROW_HEIGHT
    return Math.max(MIN_ROW_HEIGHT, Math.ceil(tr.getBoundingClientRect().height))
  }

  private startColResize(event: MouseEvent, col: number): void {
    const colEl = this.colEls[col]
    if (!colEl) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = Number.parseInt(colEl.style.width, 10) || MIN_COL_WIDTH
    this.dom.classList.add('ss-resizing', 'ss-resizing-col')
    const move = (e: MouseEvent): void => {
      const width = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, startWidth + (e.clientX - startX)))
      colEl.style.width = `${Math.round(width)}px`
      this.colWidths[col] = Math.round(width)
    }
    const up = (): void => {
      this.dom.classList.remove('ss-resizing', 'ss-resizing-col')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  private startRowResize(event: MouseEvent, row: number): void {
    const tr = this.rowGutters[row]?.parentElement
    if (!tr) return
    event.preventDefault()
    event.stopPropagation()
    const startY = event.clientY
    const startHeight = tr.getBoundingClientRect().height || MIN_ROW_HEIGHT
    this.dom.classList.add('ss-resizing', 'ss-resizing-row')
    const move = (e: MouseEvent): void => {
      const height = Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, startHeight + (e.clientY - startY)))
      tr.style.height = `${Math.round(height)}px`
      this.rowHeights[row] = Math.round(height)
    }
    const up = (): void => {
      this.dom.classList.remove('ss-resizing', 'ss-resizing-row')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  private fillCellContents(): void {
    const solution = solve(this.rows)
    for (let r = 0; r < this.rows.length; r++) {
      for (let c = 0; c < (this.rows[0]?.length ?? 0); c++) {
        const td = this.cells[r]?.[c]
        if (!td) continue
        const cellSol = solution.cells[r]?.[c]
        td.classList.remove('ss-formula', 'ss-error')
        td.removeAttribute('title')
        const inner = document.createElement('span')
        inner.className = 'ss-cell-content'
        if (cellSol && (cellSol.kind === 'formula' || cellSol.kind === 'error')) {
          inner.textContent = cellSol.display
          td.classList.add(cellSol.kind === 'error' ? 'ss-error' : 'ss-formula')
        } else {
          const display = cellSol?.display ?? ''
          if (display) inner.innerHTML = inlineMarkdownToHtml(display, { indexedMasked: true })
        }
        td.appendChild(inner)
        if (!cellSol || (cellSol.kind !== 'formula' && cellSol.kind !== 'error')) {
          this.bindMaskedPills(td, r, c)
        }
        const raw = this.rows[r]?.[c] ?? ''
        if (raw) td.title = raw
      }
    }
  }

  /** Wire ``.masked-field`` pills rendered into a cell to their real token, so
   * they get the show/copy/edit actions of a body masked field. */
  private bindMaskedPills(td: HTMLElement, row: number, col: number): void {
    bindMaskedPillsIn(td, this.rows, row, col, (next, anchor, active) =>
      this.commitRows(next, anchor, active),
    )
  }

  private renderSelection(): void {
    this.updateNameBox()
    this.updateStatus()
    this.updateFxSync()
    if (!this.grid) return
    const has = this.selectedHas()
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const selCols = this.selectedCols()
    const selRows = this.selectedRows()

    for (let r = 0; r < rows; r++) {
      this.rowGutters[r]?.classList.toggle('ss-selected', selRows.has(r))
      for (let c = 0; c < cols; c++) {
        const td = this.cells[r]?.[c]
        if (!td) continue
        td.classList.toggle('ss-range', has(r, c))
        td.classList.toggle('ss-selected', this.extra.has(cellKey(r, c)))
        td.classList.toggle(
          'ss-active',
          this.active !== null && this.active.row === r && this.active.col === c,
        )
      }
    }
    for (let c = 0; c < cols; c++) {
      this.headCells[c]?.classList.toggle('ss-selected', selCols.has(c))
    }
    this.cornerEl?.classList.toggle('ss-selected', selRows.size === rows && selCols.size === cols)
  }

  private selectedHas(): (row: number, col: number) => boolean {
    const { anchor, active } = this
    if (!anchor || !active) {
      return (row, col) => this.extra.has(cellKey(row, col))
    }
    const minR = Math.min(anchor.row, active.row)
    const maxR = Math.max(anchor.row, active.row)
    const minC = Math.min(anchor.col, active.col)
    const maxC = Math.max(anchor.col, active.col)
    return (row, col) => {
      if (row >= minR && row <= maxR && col >= minC && col <= maxC) return true
      return this.extra.has(cellKey(row, col))
    }
  }

  private collectSelected(): CellRef[] {
    const has = this.selectedHas()
    const out: CellRef[] = []
    for (let r = 0; r < this.rows.length; r++) {
      for (let c = 0; c < (this.rows[0]?.length ?? 0); c++) {
        if (has(r, c)) out.push({ row: r, col: c })
      }
    }
    return out
  }

  private selectedCols(): Set<number> {
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const has = this.selectedHas()
    const out = new Set<number>()
    for (let c = 0; c < cols; c++) {
      let full = true
      for (let r = 0; r < rows; r++) {
        if (!has(r, c)) {
          full = false
          break
        }
      }
      if (full) out.add(c)
    }
    return out
  }

  private selectedRows(): Set<number> {
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const has = this.selectedHas()
    const out = new Set<number>()
    for (let r = 0; r < rows; r++) {
      let full = true
      for (let c = 0; c < cols; c++) {
        if (!has(r, c)) {
          full = false
          break
        }
      }
      if (full) out.add(r)
    }
    return out
  }

  private updateNameBox(): void {
    if (!this.nameBox || !this.active) return
    this.nameBox.textContent = `${colToLetters(this.active.col + 1)}${this.active.row + 1}`
  }

  private updateFxSync(): void {
    if (!this.fxInput || !this.active) return
    if (document.activeElement === this.fxInput || document.activeElement === this.editOverlay) return
    this.fxInput.value = this.rows[this.active.row]?.[this.active.col] ?? ''
  }

  private updateStatus(): void {
    if (!this.statusEl) return
    const cells = this.collectSelected()
    let sum = 0
    let count = 0
    const solution = solve(this.rows)
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

  // --- Pointer interaction ---

  private resolveTarget(
    target: EventTarget | null,
  ): { kind: 'cell' | 'col' | 'row' | 'corner'; row: number; col: number } | null {
    const el = target instanceof Element ? target : null
    if (!el) return null
    const cell = el.closest<HTMLElement>('.ss-cell')
    if (cell) {
      return { kind: 'cell', row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
    }
    const col = el.closest<HTMLElement>('.ss-col')
    if (col) {
      return { kind: 'col', row: -1, col: Number(col.dataset.col) }
    }
    const gutter = el.closest<HTMLElement>('.ss-row')
    if (gutter) {
      return { kind: 'row', row: Number(gutter.dataset.row), col: -1 }
    }
    if (el.closest<HTMLElement>('.ss-corner')) {
      return { kind: 'corner', row: -1, col: -1 }
    }
    return null
  }

  private onGridMouseDown(event: MouseEvent): void {
    const grid = this.grid
    if (!grid) return
    const target = this.resolveTarget(event.target)
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    grid.focus()
    setActiveCellHost(this)

    if (this.editing) this.commitCellEdit()
    else this.commitFxEdit()

    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    let anchor: CellRef
    let active: CellRef
    let keepExtra = false
    if (target.kind === 'col') {
      const c = Math.max(0, Math.min(target.col, cols - 1))
      if (event.shiftKey && this.anchor) {
        anchor = this.anchor
        active = { row: rows - 1, col: c }
      } else {
        anchor = { row: 0, col: c }
        active = { row: rows - 1, col: c }
      }
    } else if (target.kind === 'row') {
      const r = Math.max(0, Math.min(target.row, rows - 1))
      if (event.shiftKey && this.anchor) {
        anchor = this.anchor
        active = { row: r, col: cols - 1 }
      } else {
        anchor = { row: r, col: 0 }
        active = { row: r, col: cols - 1 }
      }
    } else if (target.kind === 'corner') {
      if (event.shiftKey && this.anchor) {
        anchor = this.anchor
        active = { row: rows - 1, col: cols - 1 }
      } else {
        anchor = { row: 0, col: 0 }
        active = { row: rows - 1, col: cols - 1 }
      }
    } else {
      const r = Math.max(0, Math.min(target.row, rows - 1))
      const c = Math.max(0, Math.min(target.col, cols - 1))
      if (event.metaKey || event.ctrlKey) {
        const key = cellKey(r, c)
        const next = new Set(this.extra)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        anchor = this.anchor ?? { row: r, col: c }
        active = this.active ?? { row: r, col: c }
        this.extra = next
        keepExtra = true
      } else if (event.shiftKey && this.anchor) {
        anchor = this.anchor
        active = { row: r, col: c }
      } else {
        anchor = { row: r, col: c }
        active = { row: r, col: c }
      }
    }
    this.anchor = anchor
    this.active = active
    if (!keepExtra) this.extra.clear()
    this.renderSelection()

    if (target.kind === 'cell') {
      this.dragging = true
      const move = (moveEvent: MouseEvent): void => {
        if (!this.dragging) return
        const hover = this.resolveTarget(moveEvent.target)
        if (hover && hover.kind === 'cell') {
          this.active = {
            row: Math.max(0, Math.min(hover.row, rows - 1)),
            col: Math.max(0, Math.min(hover.col, cols - 1)),
          }
          this.extra.clear()
          this.renderSelection()
        }
      }
      const up = (): void => {
        this.dragging = false
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    }
  }

  private onDblClick(event: MouseEvent): void {
    const target = this.resolveTarget(event.target)
    if (!target || target.kind !== 'cell') return
    event.preventDefault()
    event.stopPropagation()
    this.startCellEdit(target.row, target.col)
  }

  private onGridKeydown(event: KeyboardEvent): void {
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const mod = event.metaKey || event.ctrlKey
    const key = event.key

    if (mod && key.toLowerCase() === 'a') {
      event.preventDefault()
      event.stopPropagation()
      this.anchor = { row: 0, col: 0 }
      this.active = { row: rows - 1, col: cols - 1 }
      this.extra.clear()
      this.renderSelection()
      return
    }

    if (this.editing) return

    if (key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.view.focus()
      return
    }
    if (key === 'Enter' || key === 'F2') {
      event.preventDefault()
      event.stopPropagation()
      if (this.active) this.startCellEdit(this.active.row, this.active.col)
      return
    }
    if (key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      if (!this.active) return
      this.moveInGrid(this.active.row, this.active.col + (event.shiftKey ? -1 : 1), true)
      return
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      this.clearSelected()
      return
    }
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    if (deltas[key]) {
      event.preventDefault()
      event.stopPropagation()
      if (!this.active) return
      const [dr, dc] = deltas[key]!
      const row = Math.max(0, Math.min(rows - 1, this.active.row + dr))
      const col = Math.max(0, Math.min(cols - 1, this.active.col + dc))
      if (event.shiftKey && this.anchor) {
        this.active = { row, col }
      } else {
        this.anchor = this.active = { row, col }
      }
      this.extra.clear()
      this.renderSelection()
      return
    }
    if (key.length === 1 && !mod && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      if (this.active) this.startCellEdit(this.active.row, this.active.col, key)
    }
  }

  // --- Cell editing ---

  private startCellEdit(row: number, col: number, replaceText?: string): void {
    if (this.editOverlay) this.commitCellEdit()
    const cell = this.cellEl(row, col)
    if (!cell) return
    this.editing = { row, col }
    const input = document.createElement('input')
    input.className = 'ss-edit-input'
    input.type = 'text'
    input.spellcheck = false
    input.value =
      replaceText !== undefined ? replaceText : (this.rows[row]?.[col] ?? '')
    input.addEventListener('keydown', (event) => this.onEditKeydown(event))
    input.addEventListener('blur', () => {
      if (this.editOverlay === input) this.commitCellEdit()
    })
    input.addEventListener('input', () => this.fitEditColumn(input))
    cell.appendChild(input)
    this.editOverlay = input
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }

  private cellEl(row: number, col: number): HTMLElement | null {
    return this.cells[row]?.[col] ?? null
  }

  /**
   * As the user types in an empty (or any) cell, widen its column to keep the
   * input usable without a manual resize. Only the live element width changes;
   * the next rebuild re-fits the column to the committed content.
   */
  private fitEditColumn(input: HTMLInputElement): void {
    if (!this.editing) return
    const colEl = this.colEls[this.editing.col]
    if (!colEl) return
    const width = Math.max(
      MIN_COL_WIDTH,
      Math.min(MAX_COL_WIDTH, Math.ceil(this.measureTextWidth(input)) + EDIT_INPUT_PAD),
    )
    colEl.style.width = `${width}px`
  }

  /** Measure the actual text width of the edit input's value at the table
   * font, independent of the input's forced 100% width. */
  private measureTextWidth(input: HTMLInputElement): number {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:0;left:0;font:inherit;'
    probe.textContent = input.value || ' '
    this.dom.appendChild(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    return width
  }

  private onEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      this.commitCellEdit()
      if (this.active) this.moveInGrid(this.active.row + 1, this.active.col, false)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.cancelCellEdit()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      this.commitCellEdit()
      if (this.active) this.moveInGrid(this.active.row, this.active.col + (event.shiftKey ? -1 : 1), true)
    }
  }

  /**
   * Move the active cell like a spreadsheet: out-of-range columns wrap to the
   * other side of the grid (or, past the last row/column, to the first), so Tab
   * keeps cycling through the table instead of stopping at the far edge.
   */
  private moveInGrid(row: number, col: number, wrap: boolean): void {
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    if (wrap && cols > 0) {
      if (col < 0) {
        col = cols - 1
        row -= 1
      } else if (col >= cols) {
        col = 0
        row += 1
      }
      if (row < 0) row = rows - 1
      else if (row >= rows) row = 0
    }
    this.anchor = this.active = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
    this.extra.clear()
    this.renderSelection()
  }

  private commitCellEdit(): void {
    const input = this.editOverlay
    if (!input || !this.editing) return
    const { row, col } = this.editing
    this.teardownEdit()
    const raw = input.value
    if (raw !== (this.rows[row]?.[col] ?? '')) {
      const next = this.rows.map((r) => [...r])
      next[row]![col] = raw
      this.commitRows(next, { row, col }, { row, col })
    }
    this.grid?.focus()
  }

  private cancelCellEdit(): void {
    this.teardownEdit()
    this.grid?.focus()
  }

  private teardownEdit(): void {
    this.editOverlay?.remove()
    this.editOverlay = null
    this.editing = null
  }

  private onFxInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      this.commitFxEdit()
      this.grid?.focus()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      this.commitFxEdit()
      if (this.active) this.moveInGrid(this.active.row, this.active.col + (event.shiftKey ? -1 : 1), true)
      this.grid?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (this.active && this.fxInput) {
        this.fxInput.value = this.rows[this.active.row]?.[this.active.col] ?? ''
      }
      this.grid?.focus()
    }
  }

  private commitFxEdit(): void {
    const input = this.fxInput
    if (!input || !this.active) return
    const { row, col } = this.active
    const raw = input.value
    if (raw !== (this.rows[row]?.[col] ?? '')) {
      const next = this.rows.map((r) => [...r])
      next[row]![col] = raw
      this.commitRows(next, { row, col }, { row, col })
    }
  }

  // --- Structural ops ---

  private commitRows(nextRows: string[][], anchor: CellRef, active: CellRef): void {
    const pos = this.getPos()
    if (pos === undefined) return
    const value = tableToPipes(nextRows)
    if (value === this.node.attrs.value) {
      this.rows = parsePipes(value)
      this.rebuildForCommit(this.rows.length, this.rows[0]?.length ?? 0, anchor, active)
      return
    }
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value })
    this.view.dispatch(tr)
    this.rows = parsePipes(value)
    this.rebuildForCommit(this.rows.length, this.rows[0]?.length ?? 0, anchor, active)
  }

  private rebuildForCommit(rows: number, cols: number, anchor: CellRef, active: CellRef): void {
    this.anchor = { row: Math.min(anchor.row, rows - 1), col: Math.max(0, Math.min(anchor.col, cols - 1)) }
    this.active = { row: Math.min(active.row, rows - 1), col: Math.max(0, Math.min(active.col, cols - 1)) }
    this.extra.clear()
    this.teardownEdit()
    this.buildGrid()
    this.renderSelection()
  }

  private addColumn(): void {
    const cols = this.rows[0]?.length ?? 0
    const next = this.rows.map((row) => [...row, ''])
    this.commitRows(next, { row: 0, col: cols }, { row: 0, col: cols })
  }

  private addRow(): void {
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const next = [...this.rows, Array.from({ length: cols }, () => '')]
    this.commitRows(next, { row: rows, col: 0 }, { row: rows, col: 0 })
  }

  private removeColumns(): void {
    const cols = this.rows[0]?.length ?? 0
    if (cols === 0) return
    const remove = this.selectedCols()
    if (remove.size === 0 || remove.size === cols) return
    const keep = Array.from({ length: cols }, (_, c) => c).filter((c) => !remove.has(c))
    const next = this.rows.map((row) => keep.map((c) => row[c] ?? ''))
    const col = Math.min(this.active?.col ?? 0, keep.length - 1)
    const row = this.active?.row ?? 0
    this.commitRows(next, { row, col }, { row, col })
  }

  private removeRows(): void {
    const rows = this.rows.length
    if (rows === 0) return
    const remove = this.selectedRows()
    if (remove.size === 0 || remove.size === rows) return
    const next = this.rows.filter((_, r) => !remove.has(r))
    const row = Math.min(this.active?.row ?? 0, next.length - 1)
    const col = this.active?.col ?? 0
    this.commitRows(next, { row, col }, { row, col })
  }

  private clearSelected(): void {
    const selected = this.collectSelected()
    if (selected.length === 0) return
    const next = this.rows.map((row) => [...row])
    for (const { row, col } of selected) {
      if (row < next.length) next[row]![Math.min(col, (next[row]?.length ?? 1) - 1)] = ''
    }
    this.commitRows(next, this.anchor ?? { row: 0, col: 0 }, this.active ?? { row: 0, col: 0 })
  }

  /** Put a freshly-created encrypted field into the active cell. */
  private async insertSecret(): Promise<void> {
    const secret = await promptForNewSecret()
    if (!secret) return
    const row = this.active?.row ?? 0
    const col = this.active?.col ?? 0
    const next = this.rows.map((r) => [...r])
    const current = next[row]?.[col] ?? ''
    next[row]![col] = current.trim() ? `${current} ${maskedFieldToMarkdown(secret.envelope, secret.label)}` : maskedFieldToMarkdown(secret.envelope, secret.label)
    this.commitRows(next, { row, col }, { row, col })
  }

  // --- Clipboard ---

  private onCopy(event: ClipboardEvent): void {
    const tsv = this.selectionTsv()
    if (!tsv) return
    event.preventDefault()
    event.stopPropagation()
    if (event.clipboardData) {
      event.clipboardData.setData('text/plain', tsv)
    } else {
      void copyText(tsv)
    }
  }

  private selectionTsv(): string {
    const crefs = this.collectSelected()
    if (crefs.length === 0) return ''
    const minR = Math.min(...crefs.map((c) => c.row))
    const maxR = Math.max(...crefs.map((c) => c.row))
    const minC = Math.min(...crefs.map((c) => c.col))
    const maxC = Math.max(...crefs.map((c) => c.col))
    const has = this.selectedHas()
    const lines: string[] = []
    for (let r = minR; r <= maxR; r++) {
      const row: string[] = []
      for (let c = minC; c <= maxC; c++) {
        row.push(has(r, c) ? (this.rows[r]?.[c] ?? '') : '')
      }
      lines.push(row.join('\t'))
    }
    return lines.join('\r\n')
  }

  private onPaste(event: ClipboardEvent): void {
    event.preventDefault()
    event.stopPropagation()
    let text = ''
    if (event.clipboardData) {
      text = event.clipboardData.getData('text/plain')
    }
    if (!text || !this.active) return
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines.length === 0) return
    const pasted = lines.map((line) => line.split('\t'))
    const startRow = this.active.row
    const startCol = this.active.col
    const pastedCols = Math.max(...pasted.map((r) => r.length))
    const maxRows = Math.max(this.rows.length, startRow + pasted.length)
    const maxCols = Math.max(this.rows[0]?.length ?? 0, startCol + pastedCols)
    const next: string[][] = []
    for (let r = 0; r < maxRows; r++) {
      next.push(Array.from({ length: maxCols }, (_, c) => this.rows[r]?.[c] ?? ''))
    }
    pasted.forEach((prow, pr) => {
      prow.forEach((cell, pc) => {
        next[startRow + pr]![startCol + pc] = cell
      })
    })
    this.commitRows(
      next,
      { row: startRow, col: startCol },
      {
        row: Math.min(startRow + pasted.length - 1, maxRows - 1),
        col: Math.min(startCol + pastedCols - 1, maxCols - 1),
      },
    )
  }

  // --- Plugin contract ---

  stopEvent(): boolean {
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.dragging = false
  }
}

export const TABLE_TYPE = 'table'

/**
 * Link a cell's raw text: ``[text](url)`` (keeping a link's inner text when it
 * is already a link). With no URL, unlink instead.
 */
function setLink(text: string, url?: string): string {
  if (url) {
    const link = /^\[([^\]]*)\]\([^)]*\)$/.exec(text)
    return link ? `[${link[1]}](${url})` : `[${text}](${url})`
  }
  return text.replace(/^\[(.+)\]\([^)]*\)$/, '$1')
}

function markerFor(kind: InlineCellKind): string {
  return kind === 'bold' ? '**' : kind === 'italic' ? '*' : kind === 'strike' ? '~~' : '`'
}

/** True when the cell is fully wrapped in the marker for ``kind``. */
function isMarked(text: string, kind: InlineCellKind): boolean {
  const marker = markerFor(kind)
  return text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2
}

function wrapMark(text: string, kind: InlineCellKind): string {
  if (isMarked(text, kind)) return text
  const marker = markerFor(kind)
  return `${marker}${text}${marker}`
}

function stripMark(text: string, kind: InlineCellKind): string {
  if (!isMarked(text, kind)) return text
  const marker = markerFor(kind)
  return text.slice(marker.length, text.length - marker.length)
}

let inlineFocusListenersAttached = false

/**
 * One per-document `focusout` watcher keeps the toolbar's active-cell host in
 * sync: it is cleared whenever focus leaves to something that is neither a
 * spreadsheet nor the formatting bar, so a click on Bold/Italic/etc. still
 * finds the cell it was aimed at.
 */
function ensureInlineFocusListeners(): void {
  if (inlineFocusListenersAttached) return
  inlineFocusListenersAttached = true
  document.addEventListener('focusout', (event) => {
    const next =
      event.relatedTarget instanceof Element
        ? event.relatedTarget
        : (document.activeElement as HTMLElement | null)
    if (next && next.closest('.spreadsheet, .fmt-btn, .fmt-menu-host, .fmt-popover, .fmt-select')) return
    setActiveCellHost(null)
  })
}

// --- Plain (view) rendering ---------------------------------------------------

/**
 * Bind the masked-field pills inside one rendered cell. Shared by the
 * spreadsheet grid and the plain table view so both re-encrypt and commit
 * tokens the same way.
 */
function bindMaskedPillsIn(
  td: HTMLElement,
  rows: string[][],
  row: number,
  col: number,
  commit: (next: string[][], anchor: CellRef, active: CellRef) => void,
): void {
  const pills = td.querySelectorAll<HTMLElement>('.masked-field')
  if (pills.length === 0) return
  const tokens = listMaskedTokens(rows[row]?.[col] ?? '')
  pills.forEach((pill, index) => {
    const token = tokens[index]
    if (!token) return
    bindCellMaskedField(pill, token, (rawToken) => {
      const next = rows.map((r) => [...r])
      next[row]![col] = (rows[row]?.[col] ?? '').replace(token.raw, rawToken)
      commit(next, { row, col }, { row, col })
    })
  })
}

/**
 * View-mode rendering of a table: a plain markdown table (first row as a
 * header row) with no spreadsheet chrome — no column letters, row numbers,
 * tools row, fx bar, name box, or resize handles. Cell content keeps the
 * spreadsheet rendering (formulas solved, inline markdown, masked-field
 * pills). Enter spreadsheet mode with the ``Spreadsheet`` button or the
 * right-click menu.
 */
class TablePlainView implements NodeView {
  dom: HTMLElement
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined
  private rows: string[][] = []
  private body: HTMLElement | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.rows = parsePipes(String(node.attrs.value ?? ''))

    this.dom = document.createElement('div')
    this.dom.className = 'ss-plain'

    const pos = getPos()
    if (pos !== undefined) {
      const $pos = view.state.doc.resolve(pos)
      if ($pos.parent.type.name === 'doc') {
        this.dom.appendChild(createHandleDOM(pos))
      }
    }

    this.body = document.createElement('div')
    this.body.className = 'ss-plain-body'
    this.dom.appendChild(this.body)
    this.dom.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('.masked-field, .ss-tool, a, button, .block-handle')) return
      event.preventDefault()
      event.stopPropagation()
      enterSpreadsheetMode(this.view, this.getPos())
    })
    this.renderBody()
  }

  private renderBody(): void {
    const body = this.body
    if (!body) return

    const tools = document.createElement('div')
    tools.className = 'ss-plain-tools'
    const spreadsheetBtn = document.createElement('button')
    spreadsheetBtn.type = 'button'
    spreadsheetBtn.className = 'ss-tool'
    spreadsheetBtn.textContent = 'Edit'
    spreadsheetBtn.title = 'Edit this table as a spreadsheet'
    spreadsheetBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      enterSpreadsheetMode(this.view, this.getPos())
    })
    tools.appendChild(spreadsheetBtn)

    const scroll = document.createElement('div')
    scroll.className = 'ss-plain-scroll'
    scroll.appendChild(this.buildTable())

    body.textContent = ''
    body.appendChild(tools)
    body.appendChild(scroll)
  }

  private buildTable(): HTMLTableElement {
    const table = document.createElement('table')
    table.className = 'ss-plain-table'
    const cols = Math.max(...this.rows.map((r) => r.length), 0)
    const solution = solve(this.rows)

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th')
      this.fillCell(th, 0, c, solution.cells[0]?.[c])
      headRow.appendChild(th)
    }
    thead.appendChild(headRow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (let r = 1; r < this.rows.length; r++) {
      const tr = document.createElement('tr')
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td')
        this.fillCell(td, r, c, solution.cells[r]?.[c])
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    return table
  }

  private fillCell(td: HTMLElement, row: number, col: number, cellSol: CellSolution | undefined): void {
    td.classList.remove('ss-formula', 'ss-error')
    td.removeAttribute('title')
    if (cellSol && (cellSol.kind === 'formula' || cellSol.kind === 'error')) {
      td.textContent = cellSol.display
      td.classList.add(cellSol.kind === 'error' ? 'ss-error' : 'ss-formula')
    } else {
      const display = cellSol?.display ?? ''
      if (!display) td.textContent = ''
      else td.innerHTML = inlineMarkdownToHtml(display, { indexedMasked: true })
      bindMaskedPillsIn(td, this.rows, row, col, (next) => this.commitTable(next))
    }
    const raw = this.rows[row]?.[col] ?? ''
    if (raw) td.title = raw
  }

  private commitTable(nextRows: string[][]): void {
    const pos = this.getPos()
    if (pos === undefined) return
    const value = tableToPipes(nextRows)
    if (value === this.node.attrs.value) return
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value })
    this.view.dispatch(tr)
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== TABLE_TYPE) return false
    if (node.attrs._source !== this.node.attrs._source) return false
    if (node.attrs._plain !== this.node.attrs._plain) return false
    this.node = node
    const rows = parsePipes(String(node.attrs.value ?? ''))
    if (JSON.stringify(rows) !== JSON.stringify(this.rows)) {
      this.rows = rows
      this.renderBody()
    }
    return true
  }

  stopEvent(): boolean {
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.body = null
  }
}

export interface TableModeState {
  spreadPos: number | null
}

const TABLE_MODE_KEY = new PluginKey<TableModeState>('EDI_TABLE_NODEVIEW')

function currentSpreadPos(state: EditorState): number | null {
  return TABLE_MODE_KEY.getState(state)?.spreadPos ?? null
}

function setTableModeAttr(tr: Transaction, pos: number, plain: boolean): void {
  const node = tr.doc.nodeAt(pos)
  if (!node || node.type.name !== TABLE_TYPE) return
  if (node.attrs._plain === plain) return
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, _plain: plain })
}

/**
 * Switch a table into spreadsheet mode. Like block source mode, only one
 * spreadsheet is open per document: the previously open one (if any) drops
 * back to the plain view. The table node is also deselected so that typing
 * can never replace the whole table while it is being edited.
 */
function buildEnterSpreadsheetTr(tr: Transaction, state: EditorState, pos: number): void {
  const current = currentSpreadPos(state)
  if (current !== null && current !== pos) {
    setTableModeAttr(tr, tr.mapping.map(current), true)
  }
  setTableModeAttr(tr, pos, false)
  const sel = tr.selection as NodeSelection | null
  if (sel && sel.node && sel.node.type.name === TABLE_TYPE) {
    tr.setSelection(TextSelection.create(tr.doc, pos))
  }
  tr.setMeta(TABLE_MODE_KEY, { spreadPos: pos })
}

function focusSpreadsheetGrid(view: EditorView): void {
  requestAnimationFrame(() => {
    const grid = view.dom.querySelector<HTMLElement>('.ss-grid')
    grid?.focus()
  })
}

export function enterSpreadsheetMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== TABLE_TYPE) return
  const tr = view.state.tr
  buildEnterSpreadsheetTr(tr, view.state, pos)
  view.dispatch(tr)
  focusSpreadsheetGrid(view)
}

export function enterPlainMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== TABLE_TYPE) return
  const tr = view.state.tr
  setTableModeAttr(tr, pos, true)
  tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize))
  const current = currentSpreadPos(view.state)
  tr.setMeta(TABLE_MODE_KEY, { spreadPos: current === pos ? null : current })
  view.dispatch(tr)
}

export const tableNodeViewPlugin = new Plugin<TableModeState>({
  key: TABLE_MODE_KEY,
  state: {
    init: () => ({ spreadPos: null }),
    apply(tr: Transaction, prev: TableModeState): TableModeState {
      const meta = tr.getMeta(TABLE_MODE_KEY)
      if (meta !== undefined) return meta
      if (prev.spreadPos !== null && tr.docChanged) {
        if (prev.spreadPos >= tr.doc.content.size) return { spreadPos: null }
        const node = tr.doc.nodeAt(prev.spreadPos)
        if (!node || node.type.name !== TABLE_TYPE) return { spreadPos: null }
        if (node.attrs._plain !== false) return { spreadPos: null }
      }
      return prev
    },
  },
  view(view: EditorView) {
    const onDblClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (!target || !view.dom.isConnected) return
      if (target.closest?.('.spreadsheet')) return
      const spreadPos = currentSpreadPos(view.state)
      if (spreadPos === null) return
      const tr = view.state.tr
      const node = tr.doc.nodeAt(spreadPos)
      setTableModeAttr(tr, spreadPos, true)
      if (node && node.type.name === TABLE_TYPE) {
        tr.setSelection(TextSelection.create(tr.doc, spreadPos + node.nodeSize))
      }
      tr.setMeta(TABLE_MODE_KEY, { spreadPos: null })
      view.dispatch(tr)
    }
    document.addEventListener('dblclick', onDblClick)
    return { destroy: () => document.removeEventListener('dblclick', onDblClick) }
  },
  props: {
    nodeViews: {
      [TABLE_TYPE]: (node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        if (node.attrs._source) {
          return blockNodeView(node, view, getPos) ?? new TableNodeView(node, view, getPos)
        }
        if (node.attrs._plain) return new TablePlainView(node, view, getPos)
        return new TableNodeView(node, view, getPos)
      },
    },
  },
})

export function insertTable(view: EditorView, cols: number, rows: number): boolean {
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''))
  const node = view.state.schema.nodes.table.create({ value: tableToPipes(grid) })
  const { $from } = view.state.selection
  const tr = view.state.tr
  let tablePos: number
  if ($from.parent.isTextblock && $from.parent.content.size === 0) {
    tablePos = $from.before($from.depth)
    tr.replaceWith($from.before($from.depth), $from.after($from.depth), node)
  } else if ($from.depth > 0) {
    tablePos = $from.after(1)
    tr.insert($from.after(1), node)
  } else {
    tablePos = $from.pos
    tr.insert($from.pos, node)
  }
  buildEnterSpreadsheetTr(tr, view.state, tablePos)
  view.dispatch(tr)
  focusSpreadsheetGrid(view)
  return true
}