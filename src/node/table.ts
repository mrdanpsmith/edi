import { Plugin, PluginKey, TextSelection, type EditorState, type NodeSelection, type Transaction } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { parsePipes, tableToPipes, parsePipesAlign, inlineMarkdownToHtml, listMaskedTokens, type TableAlign } from '../spreadsheet-util'
import { cellCarriesMark, setCellMark } from '../inline-md'
import { solve, colToLetters, formulaParts, isFormula, SPREADSHEET_PREFIX, type CellSolution } from '../spreadsheet'
import { BUILTIN_FORMULAS, type FormulaFunction } from '../formulas'
import { documentFunctionsFor, formulaEnvFor, subscribeFormulaEnv } from '../formulaDefs'
import { FormulaAutocomplete } from '../formulaAutocomplete'
import { undoNoScroll, redoNoScroll } from 'prosemirror-history'
import { deleteFormulaRefs, fillTextValues, insertFormulaRefs, remapFormulaRefs, shiftFormulaRefs } from '../series'
import { copyText } from '../clipboard'
import { blockNodeView } from '../blockview'
import {
  setActiveCellHost,
  type CellLinkContext,
  type InlineCellHost,
  type InlineCellKind,
} from '../inline-format'
import { bindCellMaskedField, maskedFieldToMarkdown, promptForNewSecret } from './masked'
import { ContextMenu, type ContextMenuEntry } from '../contextmenu'

interface CellRef {
  row: number
  col: number
}

interface FillRect {
  sr1: number
  sc1: number
  sr2: number
  sc2: number
  r1: number
  c1: number
  r2: number
  c2: number
}

interface PointDrag {
  input: HTMLInputElement
  start: CellRef
  replaceStart: number
  replaceEnd: number
  move: (event: MouseEvent) => void
  up: () => void
}

/** The reference token most recently inserted by a point-mode pick, so a
 * follow-up pick replaces it instead of appending (`=A1` → `=B1`). */
interface PointInsert {
  input: HTMLInputElement
  start: number
  end: number
  snapshot: string
}

const cellKey = (row: number, col: number): string => `${row}:${col}`

const MIN_COL_WIDTH = 48
const MAX_COL_WIDTH = 480
const COL_PAD = 22
const ROW_GUTTER_WIDTH = 30
const EDIT_INPUT_PAD = 20
/** How far (px) from a row/column boundary in the spreadsheet chrome the
 * pointer must be for the insert guide to appear. */
const INSERT_EDGE = 6
/** Half-width (px) of the forgiving corridor that keeps a shown guide alive
 * while the pointer travels from the chrome to its floating button. */
const INSERT_CORRIDOR = 14
/** How far (px) past the table's right edge a double-click must land before the
 * empty area beside the table counts as "outside the block" (leaving room to
 * hit the column insert guide, which sits at the grid's trailing edge). */
const EXIT_MARGIN = 32

/** Tooltip for a table cell: the raw content, with a formula error's hint
 * appended so hovering an error explains it without leaving the table. A
 * formula's outer format marks (`**=SUM(A1:A3)**`) are dropped from the
 * tooltip — the formula text is what matters. */
function cellTitle(raw: string, cellSol: CellSolution | undefined): string {
  if (!raw) return ''
  const parts = formulaParts(raw)
  const base = parts ? `${SPREADSHEET_PREFIX}${parts.body}` : raw
  return cellSol?.hint ? `${base} — ${cellSol.hint}` : base
}

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
  private align: TableAlign[] = []
  private grid: HTMLElement | null = null
  private gridWrap: HTMLElement | null = null
  private colEls: HTMLTableColElement[] = []
  private cornerEl: HTMLElement | null = null
  private headCells: HTMLElement[] = []
  private rowGutters: HTMLElement[] = []
  private cells: HTMLElement[][] = []

  private anchor: CellRef | null = null
  private active: CellRef | null = null
  private extra = new Set<string>()
  private editing: { row: number; col: number } | null = null
  private editOverlay: HTMLInputElement | null = null
  private fxInput: HTMLInputElement | null = null
  private nameBox: HTMLElement | null = null
  private statusEl: HTMLElement | null = null
  private resolveInput: HTMLInputElement | null = null
  private dragging = false
  private menu: ContextMenu | null = null
  private cutSource: { r1: number; c1: number; r2: number; c2: number } | null = null
  private fillDrag: FillRect | null = null
  private fillHandleEl: HTMLElement | null = null
  private fillTooltipEl: HTMLElement | null = null
  private alignButtons: Array<{ align: TableAlign; el: HTMLElement }> = []
  private pointDrag: PointDrag | null = null
  private pointInsert: PointInsert | null = null
  private pointRange: { r1: number; c1: number; r2: number; c2: number } | null = null
  private pendingLink: PendingCellLink | null = null
  private insertGuide: HTMLElement | null = null
  private insertGuideLine: HTMLElement | null = null
  private insertGuidePlus: HTMLElement | null = null
  private insertGuideTarget: { axis: 'col' | 'row'; index: number; x: number; y: number } | null = null
  private readonly onFillMove = (event: MouseEvent): void => this.handleFillMove(event)
  private readonly onFillUp = (event: MouseEvent): void => this.handleFillUp(event)
  private readonly onDocCopy = (event: Event): void => this.onClipboardCopy(event as ClipboardEvent)
  private readonly onDocCut = (event: Event): void => this.onClipboardCut(event as ClipboardEvent)
  private readonly onDocPaste = (event: Event): void => this.onClipboardPaste(event as ClipboardEvent)
  private readonly autocomplete = new FormulaAutocomplete(() => this.formulaFunctions())
  private unsubscribeFormulaEnv: (() => void) | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.rows = parsePipes(String(node.attrs.value ?? ''))
    this.align = parsePipesAlign(String(node.attrs.value ?? ''))
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
    this.dom.addEventListener('contextmenu', (event) => this.onGridContextMenu(event))
    this.buildTools()
    this.buildFxBar()
    this.buildGrid()
    this.buildInsertGuide()
    this.anchor = { row: 0, col: 0 }
    this.active = { row: 0, col: 0 }
    this.renderSelection()
    ensureInlineFocusListeners()
    this.unsubscribeFormulaEnv = subscribeFormulaEnv(view, () => this.refreshFormulaValues())

    document.addEventListener('copy', this.onDocCopy)
    document.addEventListener('cut', this.onDocCut)
    document.addEventListener('paste', this.onDocPaste)
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
      // Marker kinds apply uniformly to the whole selection: add unless every
      // selected cell already carries the mark fully (then remove them all).
      // Marks are tracked on the parsed inline runs so effects compose
      // (`**hello**` + italic → `***hello***`, not a mangles literal).
      const on = !cells.every(({ row, col }) => cellCarriesMark(rawOf(row, col), kind))
      for (const { row, col } of cells) {
        const raw = rawOf(row, col)
        const result = setCellMark(raw, kind, on)
        if (result !== raw) changed = true
        next[row]![col] = result
      }
    }
    if (!changed) return false
    // If the fx bar is the live edit source, sync it to the new raw so the
    // blur commit triggered by the `grid.focus()` below is a no-op — otherwise
    // it would write the stale unformatted value back over the cell.
    if (this.active && this.fxInput && document.activeElement === this.fxInput) {
      this.fxInput.value = next[this.active.row]?.[this.active.col] ?? ''
    }
    if (this.editing) this.teardownEdit()
    const anchor = this.anchor ?? cells[0]!
    const active = this.active ?? cells[cells.length - 1]!
    this.commitRows(next, anchor, active)
    this.grid?.focus()
    return true
  }

  /**
   * Capture the live edit's text and selection before the dialog opens. The
   * toolbar calls this on mousedown (ahead of the focus change that blurs and
   * commits the in-cell editor), so a link can be applied to exactly the
   * selected text rather than the whole cell.
   */
  beginCellLink(): CellLinkContext {
    const target = this.linkEditTarget()
    const row = target?.row ?? this.active?.row ?? 0
    const col = target?.col ?? this.active?.col ?? 0
    const value = target ? target.input.value : (this.rows[row]?.[col] ?? '')
    const start = target ? (target.input.selectionStart ?? value.length) : value.length
    const end = target ? (target.input.selectionEnd ?? start) : start
    this.pendingLink = { row, col, value, start, end, editing: target !== null }
    if (target) {
      return {
        text: start === end ? '' : value.slice(start, end),
        url: linkHrefIn(value, start, end),
      }
    }
    return { text: value, url: wholeCellLinkHref(value) }
  }

  /** Apply (or, with an empty URL, remove) a link using the snapshot captured
   * by `beginCellLink`, honoring the dialog's link text when nothing was
   * selected. */
  applyCellLink(text: string, url: string): boolean {
    const pending = this.pendingLink
    this.pendingLink = null
    if (!pending) return false
    const current = this.rows[pending.row]?.[pending.col] ?? ''
    const href = url.trim()
    let raw: string
    if (pending.editing) {
      // A selection or caret inside a link's visible text edits that link.
      const span = linkSpans(pending.value).find(
        (s) => pending.start >= s.from && pending.end <= s.to,
      )
      if (span) {
        const spanText = pending.value.slice(span.from, span.to)
        const linked = href ? `[${spanText}](${href})` : spanText
        raw = pending.value.slice(0, span.rawFrom) + linked + pending.value.slice(span.rawTo)
      } else if (pending.start !== pending.end) {
        const selected = pending.value.slice(pending.start, pending.end)
        const linked = href ? `[${selected}](${href})` : selected
        raw = pending.value.slice(0, pending.start) + linked + pending.value.slice(pending.end)
      } else if (href) {
        const label = text.trim() || href
        raw = pending.value.slice(0, pending.start) + `[${label}](${href})` + pending.value.slice(pending.end)
      } else {
        raw = pending.value
      }
    } else if (href) {
      raw = pending.value.trim() ? setLink(pending.value, href) : `[${text.trim() || href}](${href})`
    } else {
      raw = setLink(pending.value, undefined)
    }
    if (raw === current) return false
    const next = this.rows.map((r) => [...r])
    next[pending.row]![pending.col] = raw
    this.commitRows(
      next,
      { row: pending.row, col: pending.col },
      { row: pending.row, col: pending.col },
    )
    this.grid?.focus()
    return true
  }

  /** The currently focused cell text editor (in-cell overlay or fx bar), if
   * any, with its cell coordinates. */
  private linkEditTarget(): { input: HTMLInputElement; row: number; col: number } | null {
    if (this.editing && this.editOverlay) {
      return { input: this.editOverlay, row: this.editing.row, col: this.editing.col }
    }
    if (this.fxInput && document.activeElement === this.fxInput && this.active) {
      return { input: this.fxInput, row: this.active.row, col: this.active.col }
    }
    return null
  }

  update(node: ProseNode): boolean {
    if (node.attrs._source !== this.node.attrs._source) return false
    if (node.attrs._plain !== this.node.attrs._plain) return false
    this.node = node
    // `_resolved` only changes how the table serializes, so sync the checkbox
    // in place instead of rebuilding — a rebuild would reset the active cell
    // to A1 and drop the in-progress edit.
    if (this.resolveInput) this.resolveInput.checked = Boolean(node.attrs._resolved)
    const value = String(node.attrs.value ?? '')
    const rows = parsePipes(value)
    const align = parsePipesAlign(value)
    if (
      JSON.stringify(rows) !== JSON.stringify(this.rows) ||
      JSON.stringify(align) !== JSON.stringify(this.align)
    ) {
      this.rows = rows
      this.align = align
      // Keep the active cell put (clamped to the new bounds) so an undo/redo or
      // any other external change doesn't jump the selection back to A1.
      this.rebuildForCommit(
        rows.length,
        rows[0]?.length ?? 0,
        this.anchor ?? { row: 0, col: 0 },
        this.active ?? { row: 0, col: 0 },
      )
    }
    return true
  }

  // --- Static chrome ---

  private buildTools(): void {
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
        this.commitFxEdit()
        this.alignColumns(align)
      })
      tools.appendChild(button)
      this.alignButtons.push({ align, el: button })
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
    const resolveLabel = document.createElement('label')
    resolveLabel.className = 'ss-tool ss-tool-check'
    resolveLabel.title =
      'Save this table’s computed values to markdown instead of its formulas (the formulas stay in a comment and are restored when the file is opened)'
    const resolveInput = document.createElement('input')
    resolveInput.type = 'checkbox'
    resolveInput.checked = Boolean(this.node.attrs._resolved)
    resolveInput.addEventListener('change', () => {
      this.commitFxEdit()
      this.setResolved(resolveInput.checked)
    })
    this.resolveInput = resolveInput
    const resolveText = document.createElement('span')
    resolveText.textContent = 'Resolve formulas?'
    resolveLabel.appendChild(resolveInput)
    resolveLabel.appendChild(resolveText)
    tools.appendChild(resolveLabel)
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
    fxInput.addEventListener('blur', () => {
      this.autocomplete.close()
      this.commitFxEdit()
    })
    fxInput.addEventListener('focus', () => {
      setActiveCellHost(this)
      this.updatePointCursor()
    })
    fxInput.addEventListener('input', () => {
      this.updatePointCursor()
      this.autocomplete.refresh(fxInput)
    })
    fxbar.appendChild(fxInput)
    this.fxInput = fxInput

    this.dom.appendChild(fxbar)
  }

  /** Functions offered by formula autocomplete: builtins first, then any
   * functions defined in the current document. */
  private formulaFunctions(): readonly FormulaFunction[] {
    return [...BUILTIN_FORMULAS, ...documentFunctionsFor(this.view.state)]
  }

  // --- Grid ---

  private buildGrid(): void {
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
        td.dataset.align = this.align[c] ?? 'none'
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
    grid.addEventListener('dblclick', (event) => this.onDblClick(event))
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
    this.dom.appendChild(guide)
    this.dom.addEventListener('mousemove', (event) => this.onInsertHover(event))
    this.dom.addEventListener('mouseleave', () => this.hideInsertGuide())
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
    const base = this.dom.getBoundingClientRect()
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
    const cols = this.rows[0]?.length ?? 0
    const max = axis === 'col' ? cols : this.rows.length
    if (!grid || !guide || !line || !plus || !Number.isFinite(index) || index < 0 || index > max) return
    const base = this.dom.getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    const tableTop = gridRect.top - base.top
    const tableBottom = gridRect.bottom - base.top
    const tableLeft = gridRect.left - base.left
    const tableRight = gridRect.right - base.left
    const x = clientX - base.left
    const y = clientY - base.top
    const size = plus.offsetWidth || 16
    const atEnd = axis === 'col' ? index >= cols : index >= this.rows.length
    this.insertGuideTarget = { axis, index, x, y }
    this.dom.classList.toggle('ss-inserting-col', axis === 'col')
    this.dom.classList.toggle('ss-inserting-row', axis === 'row')
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
    // The button can land over the block handle (both sit in the block's left
    // gutter near its vertical middle). Yield the handle then so it cannot
    // steal the insert click; measuring the positioned button forces layout.
    const handle = this.dom.querySelector('.block-handle')
    if (handle) {
      const hr = handle.getBoundingClientRect()
      const pr = plus.getBoundingClientRect()
      const overlaps =
        hr.width > 0 &&
        pr.left < hr.right &&
        pr.right > hr.left &&
        pr.top < hr.bottom &&
        pr.bottom > hr.top
      this.dom.classList.toggle('ss-guide-near-handle', overlaps)
    } else {
      this.dom.classList.remove('ss-guide-near-handle')
    }
  }

  private hideInsertGuide(): void {
    if (!this.insertGuide) return
    this.insertGuide.hidden = true
    this.insertGuideTarget = null
    this.dom.classList.remove('ss-inserting-col', 'ss-inserting-row', 'ss-guide-near-handle')
  }

  /** Insert at the guide currently shown. Shared by the `+` click and a
   * double-click on the row/column chrome while the guide is open. */
  private commitInsertGuide(): void {
    const target = this.insertGuideTarget
    this.hideInsertGuide()
    if (!target) return
    if (target.axis === 'col') this.insertColumnAt(target.index)
    else this.insertRowAt(target.index)
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
    for (let r = 0; r < this.rows.length; r++) {
      const inner = this.cells[r]?.[col]?.querySelector<HTMLElement>('.ss-cell-content')
      if (inner) max = Math.max(max, inner.offsetWidth)
    }
    const head = this.headCells[col]?.querySelector<HTMLElement>('.ss-cell-content')
    if (head) max = Math.max(max, head.offsetWidth)
    return Math.max(MIN_COL_WIDTH, Math.ceil(max) + COL_PAD)
  }

  private fillCellContents(): void {
    const solution = solve(this.rows, formulaEnvFor(this.view.state))
    for (let r = 0; r < this.rows.length; r++) {
      for (let c = 0; c < (this.rows[0]?.length ?? 0); c++) {
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
        const raw = this.rows[r]?.[c] ?? ''
        if (raw) td.title = cellTitle(raw, cellSol)
      }
    }
  }

  /** Recompute cells after an `edi-formula` block changed the available
   * functions. Skipped mid-edit so it never clobbers the open editor. */
  private refreshFormulaValues(): void {
    if (this.editing) return
    this.fillCellContents()
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
    this.updatePointCursor()
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
        const cut = this.cutSource
        td.classList.toggle(
          'ss-cut',
          cut !== null && r >= cut.r1 && r <= cut.r2 && c >= cut.c1 && c <= cut.c2,
        )
        const point = this.pointRange
        td.classList.toggle(
          'ss-point',
          point !== null && r >= point.r1 && r <= point.r2 && c >= point.c1 && c <= point.c2,
        )
      }
    }
    for (let c = 0; c < cols; c++) {
      this.headCells[c]?.classList.toggle('ss-selected', selCols.has(c))
    }
    this.cornerEl?.classList.toggle('ss-selected', selRows.size === rows && selCols.size === cols)
    this.renderFillHandle()
    this.updateAlignButtons()
  }

  /** Columns the align buttons act on: the selected columns, or the active
   * cell's column when nothing is explicitly selected. */
  private alignTargetCols(): Set<number> {
    const cols = this.selectedCols()
    if (cols.size === 0 && this.active) cols.add(this.active.col)
    return cols
  }

  /** Apply a column alignment to the selected columns (active column when
   * nothing is selected), re-emitting the delimiter row with its colons.
   * Clicking the alignment the selection already has clears it back to none. */
  private alignColumns(align: TableAlign): void {
    const cols = this.alignTargetCols()
    if (cols.size === 0) return
    const next: TableAlign = [...cols].every((c) => (this.align[c] ?? 'none') === align)
      ? 'none'
      : align
    let changed = false
    for (const c of cols) {
      while (this.align.length <= c) this.align.push('none')
      if (this.align[c] !== next) {
        this.align[c] = next
        changed = true
      }
    }
    if (!changed) {
      this.updateAlignButtons()
      this.grid?.focus()
      return
    }
    const anchor = this.anchor ?? { row: 0, col: Math.min(...cols) }
    const active = this.active ?? anchor
    this.commitRows(this.rows.map((row) => [...row]), anchor, active)
    this.grid?.focus()
  }

  private updateAlignButtons(): void {
    if (this.alignButtons.length === 0) return
    const cols = this.alignTargetCols()
    const alignments = new Set([...cols].map((c) => this.align[c] ?? 'none'))
    const current = alignments.size === 1 ? [...alignments][0]! : null
    for (const { align, el } of this.alignButtons) {
      el.classList.toggle('ss-tool-active', current === align)
    }
  }

  /** Draw (or clear) the Excel-style fill handle at the bottom-right corner of
   * the current selection. Hidden while editing, cutting, or during a drag. */
  private renderFillHandle(): void {
    const old = this.fillHandleEl
    if (old) {
      old.remove()
      this.fillHandleEl = null
    }
    if (this.editing || this.cutSource || this.fillDrag) return
    if (!this.anchor || !this.active || this.extra.size > 0) return
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    if (rows === 0 || cols === 0) return
    const corner = this.cellEl(
      Math.min(Math.max(this.anchor.row, this.active.row), rows - 1),
      Math.min(Math.max(this.anchor.col, this.active.col), cols - 1),
    )
    if (!corner) return
    const handle = document.createElement('div')
    handle.className = 'ss-fill-handle'
    handle.title = 'Drag to fill cells, double-click to autofill'
    handle.addEventListener('mousedown', (event) => this.startFill(event))
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.autofillFromHandle()
    })
    corner.appendChild(handle)
    this.fillHandleEl = handle
  }

  // --- Excel-style fill handle ---

  private currentRect(): { r1: number; c1: number; r2: number; c2: number } | null {
    if (!this.anchor || !this.active) return null
    return {
      r1: Math.min(this.anchor.row, this.active.row),
      c1: Math.min(this.anchor.col, this.active.col),
      r2: Math.max(this.anchor.row, this.active.row),
      c2: Math.max(this.anchor.col, this.active.col),
    }
  }

  private startFill(event: MouseEvent): void {
    const grid = this.grid
    if (!grid) return
    event.preventDefault()
    event.stopPropagation()
    if (this.editing) this.commitCellEdit()
    else this.commitFxEdit()
    grid.focus()
    setActiveCellHost(this)
    const rect = this.currentRect()
    if (!rect || this.extra.size > 0) return
    this.fillDrag = {
      sr1: rect.r1,
      sc1: rect.c1,
      sr2: rect.r2,
      sc2: rect.c2,
      r1: rect.r1,
      c1: rect.c1,
      r2: rect.r2,
      c2: rect.c2,
    }
    this.dom.classList.add('ss-filling')
    document.addEventListener('mousemove', this.onFillMove)
    document.addEventListener('mouseup', this.onFillUp)
  }

  private handleFillMove(event: MouseEvent): void {
    const drag = this.fillDrag
    if (!drag) return
    const hover = this.resolveTarget(event.target)
    if (!hover || hover.kind !== 'cell') return
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const row = Math.max(0, Math.min(hover.row, rows - 1))
    const col = Math.max(0, Math.min(hover.col, cols - 1))
    drag.r1 = Math.min(drag.sr1, row)
    drag.c1 = Math.min(drag.sc1, col)
    drag.r2 = Math.max(drag.sr2, row)
    drag.c2 = Math.max(drag.sc2, col)
    this.updateFillGhost()
  }

  private updateFillGhost(): void {
    const drag = this.fillDrag
    if (!drag) return
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    for (let r = drag.r1; r <= drag.r2; r++) {
      for (let c = drag.c1; c <= drag.c2; c++) {
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue
        if (r >= drag.sr1 && r <= drag.sr2 && c >= drag.sc1 && c <= drag.sc2) continue
        this.cells[r]?.[c]?.classList.add('ss-fill-target')
      }
    }
    const text = this.fillPreviewText(drag)
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
    const drag = this.fillDrag
    if (!tooltip || !wrap || !drag) return
    const corner = this.cellEl(drag.r2, drag.c2)
    if (!corner) return
    const wrapRect = wrap.getBoundingClientRect()
    const cellRect = corner.getBoundingClientRect()
    tooltip.style.left = `${Math.min(
      wrap.clientWidth - tooltip.offsetWidth - 8,
      cellRect.right - wrapRect.left + 6,
    )}px`
    tooltip.style.top = `${Math.max(2, cellRect.top - wrapRect.top - 26)}px`
  }

  private clearFillGhost(): void {
    this.dom.classList.remove('ss-filling')
    if (this.fillTooltipEl) {
      this.fillTooltipEl.remove()
      this.fillTooltipEl = null
    }
    for (const row of this.cells) {
      for (const td of row) td?.classList.remove('ss-fill-target')
    }
  }

  private handleFillUp(_event: MouseEvent): void {
    const drag = this.fillDrag
    document.removeEventListener('mousemove', this.onFillMove)
    document.removeEventListener('mouseup', this.onFillUp)
    this.fillDrag = null
    this.clearFillGhost()
    if (!drag) return
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const grew =
      drag.r1 < drag.sr1 || drag.r2 > drag.sr2 || drag.c1 < drag.sc1 || drag.c2 > drag.sc2
    if (rows === 0 || cols === 0 || !grew) {
      this.grid?.focus()
      return
    }
    const next = this.rows.map((row) => [...row])
    for (let r = drag.r1; r <= drag.r2; r++) {
      for (let c = drag.c1; c <= drag.c2; c++) {
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue
        if (r >= drag.sr1 && r <= drag.sr2 && c >= drag.sc1 && c <= drag.sc2) continue
        next[r]![c] = this.fillCellValue(drag, r, c)
      }
    }
    this.commitRows(next, { row: drag.sr1, col: drag.sc1 }, { row: drag.r2, col: drag.c2 })
    this.grid?.focus()
  }

  /** Value for one cell inside the target fill rectangle but outside the
   * source rectangle. Vertical strips extend each source column downward (or
   * upward) along a detected series; horizontal strips do the same per row.
   * Formula seeds copy with their references shifted by the drag distance
   * from whichever seed cell produces them. */
  private fillCellValue(
    drag: FillRect,
    r: number,
    c: number,
  ): string {
    const inRows = r >= drag.sr1 && r <= drag.sr2
    const inCols = c >= drag.sc1 && c <= drag.sc2
    if (inCols && !inRows) return this.fillColumnCell(drag, r, c)
    if (inRows && !inCols) return this.fillRowCell(drag, r, c)
    // Corner cells of a two-axis drag: duplicate the nearest source corner.
    const rr = r < drag.sr1 ? drag.sr1 : drag.sr2
    const cc = c < drag.sc1 ? drag.sc1 : drag.sc2
    return this.rows[rr]?.[cc] ?? ''
  }

  private fillColumnCell(
    drag: FillRect,
    r: number,
    c: number,
  ): string {
    const blockH = drag.sr2 - drag.sr1 + 1
    const down = r > drag.sr2
    const producer = down
      ? drag.sr1 + ((r - drag.sr1) % blockH)
      : drag.sr1 + ((drag.sr1 - r - 1) % blockH)
    const seed = this.rows[producer]?.[c] ?? ''
    if (isFormula(seed)) return shiftFormulaRefs(seed, r - producer, 0)
    const seeds: string[] = []
    for (let rr = drag.sr1; rr <= drag.sr2; rr++) seeds.push(this.rows[rr]?.[c] ?? '')
    if (!down) seeds.reverse()
    const count = down ? drag.r2 - drag.sr2 : drag.sr1 - drag.r1
    const values = fillTextValues(seeds, count)
    const index = down ? r - drag.sr2 - 1 : r - drag.r1
    return values[index] ?? ''
  }

  private fillRowCell(
    drag: FillRect,
    r: number,
    c: number,
  ): string {
    const blockW = drag.sc2 - drag.sc1 + 1
    const right = c > drag.sc2
    const producer = right
      ? drag.sc1 + ((c - drag.sc1) % blockW)
      : drag.sc1 + ((drag.sc1 - c - 1) % blockW)
    const seed = this.rows[r]?.[producer] ?? ''
    if (isFormula(seed)) return shiftFormulaRefs(seed, 0, c - producer)
    const seeds: string[] = []
    for (let cc = drag.sc1; cc <= drag.sc2; cc++) seeds.push(this.rows[r]?.[cc] ?? '')
    if (!right) seeds.reverse()
    const count = right ? drag.c2 - drag.sc2 : drag.sc1 - drag.c1
    const values = fillTextValues(seeds, count)
    const index = right ? c - drag.sc2 - 1 : c - drag.c1
    return values[index] ?? ''
  }

  /** One-line preview of what the handle drag would produce, shown in the
   * floating tooltip. Blank or formula seeds yield no preview. */
  private fillPreviewText(drag: FillRect): string {
    const newRows = drag.r2 - drag.sr2 + (drag.sr1 - drag.r1)
    const newCols = drag.c2 - drag.sc2 + (drag.sc1 - drag.c1)
    if (newRows <= 0 && newCols <= 0) return ''
    const seeds: string[] = []
    let reversed = false
    if (newRows >= newCols) {
      for (let rr = drag.sr1; rr <= drag.sr2; rr++) seeds.push(this.rows[rr]?.[drag.sc1] ?? '')
      reversed = drag.sr1 - drag.r1 > 0
    } else {
      for (let cc = drag.sc1; cc <= drag.sc2; cc++) seeds.push(this.rows[drag.sr1]?.[cc] ?? '')
      reversed = drag.sc1 - drag.c1 > 0
    }
    if (reversed) seeds.reverse()
    if (seeds.some((s) => isFormula(s))) return ''
    const values = fillTextValues(seeds, 3).filter((v) => v !== '')
    return values.length === 0 ? '' : values.join(' \u2192 ')
  }

  /** Double-clicking the fill handle fills the selected column(s) down the
   * grid, stopping at the last row where the adjacent column has content. */
  private autofillFromHandle(): void {
    const rect = this.currentRect()
    if (!rect) return
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    if (rows === 0 || cols === 0) return
    const refCol = rect.c1 > 0 ? rect.c1 - 1 : rect.c2 + 1 < cols ? rect.c2 + 1 : -1
    let last = rect.r2
    if (refCol >= 0 && refCol < cols) {
      for (let r = rect.r2 + 1; r < rows; r++) {
        if ((this.rows[r]?.[refCol] ?? '').trim() !== '') last = r
        else break
      }
    } else {
      last = rows - 1
    }
    if (last <= rect.r2) return
    const drag = {
      sr1: rect.r1,
      sc1: rect.c1,
      sr2: rect.r2,
      sc2: rect.c2,
      r1: rect.r1,
      c1: rect.c1,
      r2: last,
      c2: rect.c2,
    }
    const next = this.rows.map((row) => [...row])
    for (let r = rect.r2 + 1; r <= last; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        next[r]![c] = this.fillCellValue(drag, r, c)
      }
    }
    this.commitRows(next, { row: rect.r1, col: rect.c1 }, { row: last, col: rect.c2 })
    this.grid?.focus()
  }

  /** Ctrl/Cmd+D: copy the selection's top row down through the selection
   * (formula references shift per row). */
  private fillSelectionDown(): void {
    const rect = this.currentRect()
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    if (!rect || rect.r2 - rect.r1 < 1 || rows === 0 || cols === 0) return
    const next = this.rows.map((row) => [...row])
    for (let c = rect.c1; c <= rect.c2; c++) {
      for (let r = rect.r1 + 1; r <= rect.r2; r++) {
        const seed = this.rows[rect.r1]?.[c] ?? ''
        next[r]![c] = isFormula(seed) ? shiftFormulaRefs(seed, r - rect.r1, 0) : seed
      }
    }
    this.commitRows(next, { row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 })
    this.grid?.focus()
  }

  /** Ctrl/Cmd+R: copy the selection's left column right across the selection. */
  private fillSelectionRight(): void {
    const rect = this.currentRect()
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    if (!rect || rect.c2 - rect.c1 < 1 || rows === 0 || cols === 0) return
    const next = this.rows.map((row) => [...row])
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1 + 1; c <= rect.c2; c++) {
        const seed = this.rows[r]?.[rect.c1] ?? ''
        next[r]![c] = isFormula(seed) ? shiftFormulaRefs(seed, 0, c - rect.c1) : seed
      }
    }
    this.commitRows(next, { row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 })
    this.grid?.focus()
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
    const solution = solve(this.rows, formulaEnvFor(this.view.state))
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

  private onGridContextMenu(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const col = target.closest<HTMLElement>('.ss-col')
    const gutter = col ? null : target.closest<HTMLElement>('.ss-row')
    if (!col && !gutter) return
    event.preventDefault()
    event.stopPropagation()
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const entries: ContextMenuEntry[] = []
    if (col) {
      const c = Math.max(0, Math.min(Number(col.dataset.col), cols - 1))
      // Make the clicked chrome the selection first so the delete acts on
      // exactly that column (Excel's habit of selecting the whole row/column
      // you right-click).
      this.anchor = { row: 0, col: c }
      this.active = { row: rows - 1, col: c }
      this.extra.clear()
      this.renderSelection()
      entries.push({
        type: 'item',
        label: 'Delete column',
        disabled: cols <= 1,
        onSelect: () => this.removeColumns(),
      })
    } else if (gutter) {
      const r = Math.max(0, Math.min(Number(gutter.dataset.row), rows - 1))
      this.anchor = { row: r, col: 0 }
      this.active = { row: r, col: cols - 1 }
      this.extra.clear()
      this.renderSelection()
      entries.push({
        type: 'item',
        label: 'Delete row',
        disabled: rows <= 1,
        onSelect: () => this.removeRows(),
      })
    }
    this.menu ??= new ContextMenu()
    this.menu.show(entries, event.clientX, event.clientY)
  }

  private onGridMouseDown(event: MouseEvent): void {
    const grid = this.grid
    if (!grid) return
    // Clicking the edit overlay only moves the caret; it must not commit.
    if (event.target instanceof Element && event.target.closest('.ss-edit-input')) return
    const target = this.resolveTarget(event.target)
    if (!target) return

    // Excel-style point mode: while a formula is being entered, clicking a
    // cell inserts its reference instead of switching cells.
    if (target.kind === 'cell') {
      const point = this.formulaPointInput()
      if (point) {
        event.preventDefault()
        event.stopPropagation()
        this.startPointInsert(point.input, target.row, target.col)
        return
      }
    }

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
    if (event.target instanceof Element && event.target.closest('.ss-edit-input')) return
    // While an insert guide is open over the chrome, a double-click commits it
    // (the same gesture as clicking its `+`), so the pointer never has to travel
    // to the button.
    const chrome =
      event.target instanceof Element ? event.target.closest('th.ss-col, th.ss-row') : null
    if (chrome && this.insertGuideTarget) {
      event.preventDefault()
      event.stopPropagation()
      this.commitInsertGuide()
      return
    }
    const target = this.resolveTarget(event.target)
    if (!target || target.kind !== 'cell') return
    event.preventDefault()
    event.stopPropagation()
    // In point mode, double-clicking a cell references it and finishes the
    // formula, then selects that cell (one gesture to pick a value and move on).
    const point = this.formulaPointInput()
    if (point) {
      this.startPointInsert(point.input, target.row, target.col, false)
      this.commitPointEdit()
      this.moveInGrid(target.row, target.col, false)
      return
    }
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

    if (mod && key.toLowerCase() === 'd') {
      event.preventDefault()
      event.stopPropagation()
      this.fillSelectionDown()
      return
    }
    if (mod && key.toLowerCase() === 'r') {
      event.preventDefault()
      event.stopPropagation()
      this.fillSelectionRight()
      return
    }

    // ProseMirror never sees keydowns from inside this node view (`stopEvent`),
    // so its Mod-b/Mod-i formatting keymap can't fire here. Route bold/italic
    // through the same whole-cell toggle the toolbar buttons use. This runs
    // before the editing guard so it also applies to the in-cell edit overlay
    // (its keydown bubbles up to the grid), matching toolbar behavior there.
    if (mod && (key.toLowerCase() === 'b' || key.toLowerCase() === 'i')) {
      event.preventDefault()
      event.stopPropagation()
      this.applyInline(key.toLowerCase() === 'b' ? 'bold' : 'italic')
      return
    }

    if (this.editing) return

    // ProseMirror ignores events from inside a node view (`stopEvent` returns
    // true), so its own Mod-z/Mod-y keymap never fires while the grid has focus.
    // Drive the editor history from here so undo/redo works in spreadsheet mode.
    if (mod && (key.toLowerCase() === 'z' || key.toLowerCase() === 'y')) {
      event.preventDefault()
      event.stopPropagation()
      const fn = key.toLowerCase() === 'y' || event.shiftKey ? redoNoScroll : undoNoScroll
      fn(this.view.state, this.view.dispatch, this.view)
      return
    }

    if (key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (this.cutSource) {
        this.cancelCut()
        return
      }
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

  // --- Point mode (Excel-style reference picking) ---

  /** The input currently holding a formula being edited, if any: the inline
   * edit overlay, or the fx bar input while it is focused. */
  private formulaEditor(): { input: HTMLInputElement } | null {
    if (this.editing && this.editOverlay && isFormula(this.editOverlay.value.trim())) {
      return { input: this.editOverlay }
    }
    if (
      this.fxInput &&
      document.activeElement === this.fxInput &&
      isFormula(this.fxInput.value.trim())
    ) {
      return { input: this.fxInput }
    }
    return null
  }

  /** The formula editor a click should drop a reference into. */
  private formulaPointInput(): { input: HTMLInputElement } | null {
    return this.formulaEditor()
  }

  /** While a formula editor is live, grid cells act as pick targets. */
  private updatePointCursor(): void {
    this.grid?.classList.toggle('ss-pointing', this.formulaPointInput() !== null)
  }

  /** A1-style reference for a 0-based grid cell (grid row 0 is the GFM header,
   * so both row and column are 1-based in the reference). */
  private cellRefAt(row: number, col: number): string {
    return `${colToLetters(col + 1)}${row + 1}`
  }

  private refRange(r1: number, c1: number, r2: number, c2: number): string {
    const start = this.cellRefAt(Math.min(r1, r2), Math.min(c1, c2))
    const end = this.cellRefAt(Math.max(r1, r2), Math.max(c1, c2))
    return start === end ? start : `${start}:${end}`
  }

  /** Insert a clicked cell's reference at the editor caret and, if the pointer
   * is dragged, turn it into a range (`A1:B3`) live. A pick that immediately
   * follows another pick replaces it, so clicking A1 then B1 yields `=B1`. */
  private startPointInsert(input: HTMLInputElement, row: number, col: number, withDrag = true): void {
    const prev = this.pointInsert
    const replace = prev && prev.input === input && prev.snapshot === input.value
    let start: number
    let end: number
    if (replace) {
      start = prev.start
      end = prev.end
    } else {
      const selStart = input.selectionStart ?? input.value.length
      const selEnd = input.selectionEnd ?? selStart
      start = Math.min(selStart, selEnd)
      end = Math.max(selStart, selEnd)
    }
    const ref = this.cellRefAt(row, col)
    input.value = input.value.slice(0, start) + ref + input.value.slice(end)
    const caret = start + ref.length
    input.setSelectionRange(caret, caret)
    this.autocomplete.close()
    if (input === this.editOverlay) this.fitEditColumn(input)
    this.pointInsert = { input, start, end: caret, snapshot: input.value }
    this.mirrorToFx(input)
    if (!withDrag) {
      this.pointRange = { r1: row, c1: col, r2: row, c2: col }
      this.renderSelection()
      return
    }

    const drag: PointDrag = {
      input,
      start: { row, col },
      replaceStart: start,
      replaceEnd: caret,
      move: (moveEvent) => this.updatePointRange(drag, moveEvent),
      up: () => this.endPointDrag(drag),
    }
    this.pointDrag = drag
    this.pointRange = { r1: row, c1: col, r2: row, c2: col }
    this.renderSelection()
    document.addEventListener('mousemove', drag.move)
    document.addEventListener('mouseup', drag.up)
  }

  private updatePointRange(drag: PointDrag, moveEvent: MouseEvent): void {
    if (this.pointDrag !== drag) return
    const hover = this.resolveTarget(moveEvent.target)
    if (!hover || hover.kind !== 'cell') return
    const r1 = Math.min(drag.start.row, hover.row)
    const c1 = Math.min(drag.start.col, hover.col)
    const r2 = Math.max(drag.start.row, hover.row)
    const c2 = Math.max(drag.start.col, hover.col)
    const ref = this.refRange(r1, c1, r2, c2)
    const value = drag.input.value
    drag.input.value = value.slice(0, drag.replaceStart) + ref + value.slice(drag.replaceEnd)
    drag.replaceEnd = drag.replaceStart + ref.length
    drag.input.setSelectionRange(drag.replaceEnd, drag.replaceEnd)
    this.autocomplete.close()
    if (drag.input === this.editOverlay) this.fitEditColumn(drag.input)
    this.pointInsert = {
      input: drag.input,
      start: drag.replaceStart,
      end: drag.replaceEnd,
      snapshot: drag.input.value,
    }
    this.mirrorToFx(drag.input)
    this.pointRange = { r1, c1, r2, c2 }
    this.renderSelection()
  }

  private endPointDrag(drag: PointDrag): void {
    if (this.pointDrag !== drag) return
    document.removeEventListener('mousemove', drag.move)
    document.removeEventListener('mouseup', drag.up)
    this.pointDrag = null
    drag.input.focus()
  }

  /** Commit whichever editor is open (inline overlay or fx bar). */
  private commitPointEdit(): void {
    if (this.editing) this.commitCellEdit()
    else this.commitFxEdit()
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
    input.addEventListener('input', () => {
      this.fitEditColumn(input)
      this.mirrorToFx(input)
      this.updatePointCursor()
      this.autocomplete.refresh(input)
    })
    cell.appendChild(input)
    this.editOverlay = input
    this.pointInsert = null
    this.mirrorToFx(input)
    this.updatePointCursor()
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    this.renderFillHandle()
  }

  /** Mirror the in-cell edit into the fx bar, like Excel's formula bar. */
  private mirrorToFx(input: HTMLInputElement): void {
    if (this.fxInput && input === this.editOverlay) this.fxInput.value = input.value
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
    if (this.autocomplete.handleKeydown(event)) return
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
    } else {
      this.renderSelection()
    }
    this.grid?.focus()
  }

  private cancelCellEdit(): void {
    this.teardownEdit()
    this.renderSelection()
    this.grid?.focus()
  }

  private teardownEdit(): void {
    const overlay = this.editOverlay
    this.editOverlay = null
    this.editing = null
    overlay?.remove()
    this.autocomplete.close()
    this.clearPointRange()
  }

  /** Drop any in-flight reference pick and its `ss-point` highlight. */
  private clearPointRange(): void {
    const drag = this.pointDrag
    if (drag) {
      document.removeEventListener('mousemove', drag.move)
      document.removeEventListener('mouseup', drag.up)
      this.pointDrag = null
    }
    this.pointInsert = null
    this.pointRange = null
  }

  private onFxInputKeydown(event: KeyboardEvent): void {
    if (this.autocomplete.handleKeydown(event)) return
    const mod = event.metaKey || event.ctrlKey
    if (mod && (event.key === 'b' || event.key === 'i')) {
      event.preventDefault()
      event.stopPropagation()
      this.applyInline(event.key === 'b' ? 'bold' : 'italic')
      return
    }
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
      this.clearPointRange()
      this.renderSelection()
      this.grid?.focus()
    }
  }

  private commitFxEdit(): void {
    const input = this.fxInput
    if (!input || !this.active) return
    const { row, col } = this.active
    const raw = input.value
    this.clearPointRange()
    if (raw !== (this.rows[row]?.[col] ?? '')) {
      const next = this.rows.map((r) => [...r])
      next[row]![col] = raw
      this.commitRows(next, { row, col }, { row, col })
    } else {
      this.renderSelection()
    }
  }

  // --- Structural ops ---

  private setResolved(resolved: boolean): void {
    const pos = this.getPos()
    if (pos === undefined) return
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== TABLE_TYPE || node.attrs._resolved === resolved) {
      return
    }
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      _resolved: resolved,
    })
    this.view.dispatch(tr)
  }

  private commitRows(nextRows: string[][], anchor: CellRef, active: CellRef): void {
    const pos = this.getPos()
    if (pos === undefined) return
    const value = tableToPipes(nextRows, this.align)
    if (value === this.node.attrs.value) {
      this.rows = parsePipes(value)
      this.align = parsePipesAlign(value)
      this.rebuildForCommit(this.rows.length, this.rows[0]?.length ?? 0, anchor, active)
      return
    }
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value })
    this.view.dispatch(tr)
    this.rows = parsePipes(value)
    this.align = parsePipesAlign(value)
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

  /** Insert an empty column left of grid column `at`, shifting the columns to
   * its right (and every reference that pointed at them) one place over. */
  private insertColumnAt(at: number): void {
    const cols = this.rows[0]?.length ?? 0
    if (at < 0 || at > cols) return
    this.commitFxEdit()
    if (this.editing) this.teardownEdit()
    const next = this.rows.map((row) => {
      const copy = [...row]
      copy.splice(at, 0, '')
      return copy
    })
    const spreadAt = at + 1
    for (const row of next) {
      for (let c = 0; c < row.length; c++) {
        const raw = row[c] ?? ''
        if (isFormula(raw)) row[c] = insertFormulaRefs(raw, 'col', spreadAt)
      }
    }
    while (this.align.length < cols) this.align.push('none')
    this.align.splice(at, 0, 'none')
    const row = this.active?.row ?? 0
    this.commitRows(next, { row, col: at }, { row, col: at })
  }

  /** Insert an empty row above grid row `at` (data rows only), shifting the
   * rows below it (and every reference that pointed at them) one place down. */
  private insertRowAt(at: number): void {
    const rows = this.rows.length
    if (at < 1 || at > rows) return
    this.commitFxEdit()
    if (this.editing) this.teardownEdit()
    const cols = this.rows[0]?.length ?? 0
    const next = this.rows.map((row) => [...row])
    next.splice(at, 0, Array.from({ length: cols }, () => ''))
    const spreadAt = at + 1
    for (const row of next) {
      for (let c = 0; c < row.length; c++) {
        const raw = row[c] ?? ''
        if (isFormula(raw)) row[c] = insertFormulaRefs(raw, 'row', spreadAt)
      }
    }
    const col = this.active?.col ?? 0
    this.commitRows(next, { row: at, col }, { row: at, col })
  }

  private removeColumns(): void {
    const cols = this.rows[0]?.length ?? 0
    if (cols === 0) return
    const remove = this.selectedCols()
    if (remove.size === 0 || remove.size === cols) return
    const keep = Array.from({ length: cols }, (_, c) => c).filter((c) => !remove.has(c))
    const next = this.rows.map((row) =>
      keep.map((c) => {
        const raw = row[c] ?? ''
        return isFormula(raw) ? deleteFormulaRefs(raw, 'col', remove) : raw
      }),
    )
    this.align = keep.map((c) => this.align[c] ?? 'none')
    const col = Math.min(this.active?.col ?? 0, keep.length - 1)
    const row = this.active?.row ?? 0
    this.commitRows(next, { row, col }, { row, col })
  }

  private removeRows(): void {
    const rows = this.rows.length
    if (rows === 0) return
    const remove = this.selectedRows()
    if (remove.size === 0 || remove.size === rows) return
    const next = this.rows
      .filter((_, r) => !remove.has(r))
      .map((row) => row.map((raw) => (isFormula(raw) ? deleteFormulaRefs(raw, 'row', remove) : raw)))
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

  /** True when the clipboard event belongs to this spreadsheet: the target is
   * the grid/chrome (not an editable host like the fx bar or the edit overlay;
   * the grid itself lives inside ProseMirror's contenteditable, which is NOT a
   * host) or the grid currently has keyboard focus and Chromium dispatched the
   * event to the document. Editing hosts keep their native copy/cut/paste. */
  private isSpreadsheetClipboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      const a = document.activeElement
      return this.grid !== null && (a === this.grid || this.grid.contains(a as Node))
    }
    if (target.closest('input, textarea, .cm-editor') !== null) return false
    if (this.dom.contains(target)) return true
    const a = document.activeElement
    return this.grid !== null && (a === this.grid || this.grid.contains(a as Node))
  }

  private writeClipboardText(event: ClipboardEvent, text: string): void {
    if (event.clipboardData) {
      event.clipboardData.setData('text/plain', text)
    } else {
      void copyText(text)
    }
  }

  private selectionBounds(): { r1: number; c1: number; r2: number; c2: number } {
    const cells = this.collectSelected()
    const r1 = Math.min(...cells.map((c) => c.row))
    const c1 = Math.min(...cells.map((c) => c.col))
    const r2 = Math.max(...cells.map((c) => c.row))
    const c2 = Math.max(...cells.map((c) => c.col))
    return { r1, c1, r2, c2 }
  }

  private cancelCut(): void {
    this.cutSource = null
    this.renderSelection()
  }

  private onClipboardCopy(event: ClipboardEvent): void {
    if (!this.isSpreadsheetClipboardTarget(event.target)) return
    const tsv = this.selectionTsv()
    if (!tsv) return
    event.preventDefault()
    this.cancelCut()
    this.writeClipboardText(event, tsv)
  }

  private onClipboardCut(event: ClipboardEvent): void {
    if (!this.isSpreadsheetClipboardTarget(event.target)) return
    const tsv = this.selectionTsv()
    if (!tsv) return
    event.preventDefault()
    const { r1, c1, r2, c2 } = this.selectionBounds()
    this.cutSource = { r1, c1, r2, c2 }
    this.writeClipboardText(event, tsv)
    this.renderSelection()
  }

  private onClipboardPaste(event: ClipboardEvent): void {
    if (!this.isSpreadsheetClipboardTarget(event.target)) return
    event.preventDefault()
    let text = ''
    if (event.clipboardData) {
      text = event.clipboardData.getData('text/plain')
    }
    if (text) {
      this.pasteTsv(text)
      return
    }
    // Some embedders don't attach clipboardData to the event; fall back to the
    // async clipboard API.
    void navigator.clipboard?.readText().then((t) => {
      if (t) this.pasteTsv(t)
    })
  }

  /**
   * Spreadsheet-style paste: writes the tab-separated grid starting at the
   * top-left cell of the current selection, tiling the pattern to fill the
   * whole selection when it is larger than the pasted data, and growing the
   * grid when the data overflows. A pending cut (from Ctrl+X) also clears the
   * source cells once the cut content has been delivered.
   */
  private pasteTsv(text: string): void {
    if (!this.anchor || !this.active) return
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines.length === 0) return
    const pasted = lines.map((line) => line.split('\t'))
    const dataH = pasted.length
    const dataW = Math.max(...pasted.map((r) => r.length))
    const r1 = Math.min(this.anchor.row, this.active.row)
    const c1 = Math.min(this.anchor.col, this.active.col)
    const selH = Math.abs(this.active.row - this.anchor.row) + 1
    const selW = Math.abs(this.active.col - this.anchor.col) + 1
    const height = Math.max(selH, dataH)
    const width = Math.max(selW, dataW)
    const maxRows = Math.max(this.rows.length, r1 + height)
    const maxCols = Math.max(this.rows[0]?.length ?? 0, c1 + width)
    const next: string[][] = []
    for (let r = 0; r < maxRows; r++) {
      next.push(Array.from({ length: maxCols }, (_, c) => this.rows[r]?.[c] ?? ''))
    }
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        next[r1 + r]![c1 + c] = pasted[r % dataH]?.[c % dataW] ?? ''
      }
    }
    const cut = this.cutSource
    if (cut) {
      for (let r = cut.r1; r <= cut.r2; r++) {
        for (let c = cut.c1; c <= cut.c2; c++) {
          const overwritten = r >= r1 && r < r1 + height && c >= c1 && c < c1 + width
          if (!overwritten) next[r]![c] = ''
        }
      }
      // Repoint formulas at the moved cells, skipping the pasted block itself:
      // its formulas travelled with the data and keep their own references.
      const dr = r1 - cut.r1
      const dc = c1 - cut.c1
      if (dr !== 0 || dc !== 0) {
        const src = { r1: cut.r1 + 1, c1: cut.c1 + 1, r2: cut.r2 + 1, c2: cut.c2 + 1 }
        for (let r = 0; r < maxRows; r++) {
          for (let c = 0; c < maxCols; c++) {
            const inDest = r >= r1 && r < r1 + height && c >= c1 && c < c1 + width
            if (inDest) continue
            const value = next[r]![c]!
            if (isFormula(value)) next[r]![c] = remapFormulaRefs(value, src, dr, dc)
          }
        }
      }
      this.cutSource = null
    }
    this.commitRows(
      next,
      { row: r1, col: c1 },
      { row: Math.min(r1 + height - 1, maxRows - 1), col: Math.min(c1 + width - 1, maxCols - 1) },
    )
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

  // --- Plugin contract ---

  stopEvent(): boolean {
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.dragging = false
    if (this.fillDrag) {
      document.removeEventListener('mousemove', this.onFillMove)
      document.removeEventListener('mouseup', this.onFillUp)
      this.fillDrag = null
    }
    this.clearFillGhost()
    document.removeEventListener('copy', this.onDocCopy)
    document.removeEventListener('cut', this.onDocCut)
    document.removeEventListener('paste', this.onDocPaste)
    this.unsubscribeFormulaEnv?.()
    this.unsubscribeFormulaEnv = null
    this.autocomplete.close()
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

/** A cell's live link context captured before the URL dialog steals focus. */
interface PendingCellLink {
  row: number
  col: number
  value: string
  start: number
  end: number
  editing: boolean
}

/** Every `[text](href)` span in a cell's raw markdown, with the offsets of the
 * visible text (to match a selection against) and the full raw syntax (to
 * rebuild the link in place). */
function linkSpans(
  value: string,
): Array<{ href: string; from: number; to: number; rawFrom: number; rawTo: number }> {
  const out: Array<{
    href: string
    from: number
    to: number
    rawFrom: number
    rawTo: number
  }> = []
  const re = /\[([^\]]*)\]\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value))) {
    const from = match.index + 1
    out.push({
      href: match[2] ?? '',
      from,
      to: from + (match[1]?.length ?? 0),
      rawFrom: match.index,
      rawTo: re.lastIndex,
    })
  }
  return out
}

/** The href to prefill when the selection already sits inside a link's text. */
function linkHrefIn(value: string, start: number, end: number): string {
  for (const span of linkSpans(value)) {
    if (start >= span.from && end <= span.to) return span.href
  }
  return ''
}

/** The href of a cell that is exactly one link, for prefilling the dialog. */
function wholeCellLinkHref(value: string): string {
  const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(value.trim())
  return link ? (link[2] ?? '') : ''
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
  private align: TableAlign[] = []
  private body: HTMLElement | null = null
  private unsubscribeFormulaEnv: (() => void) | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.rows = parsePipes(String(node.attrs.value ?? ''))
    this.align = parsePipesAlign(String(node.attrs.value ?? ''))

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
    this.unsubscribeFormulaEnv = subscribeFormulaEnv(view, () => this.renderBody())
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
    const solution = solve(this.rows, formulaEnvFor(this.view.state))

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th')
      th.dataset.align = this.align[c] ?? 'none'
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
        td.dataset.align = this.align[c] ?? 'none'
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
      if (cellSol.styled || cellSol.rendersMarkdown) {
        td.innerHTML = inlineMarkdownToHtml(cellSol.display, { indexedMasked: true, markMisleading: true })
      } else {
        td.textContent = cellSol.display
      }
      td.classList.add(cellSol.kind === 'error' ? 'ss-error' : 'ss-formula')
    } else {
      const display = cellSol?.display ?? ''
      if (!display) td.textContent = ''
      else td.innerHTML = inlineMarkdownToHtml(display, { indexedMasked: true, markMisleading: true })
      bindMaskedPillsIn(td, this.rows, row, col, (next) => this.commitTable(next))
    }
    const raw = this.rows[row]?.[col] ?? ''
    if (raw) td.title = cellTitle(raw, cellSol)
  }

  private commitTable(nextRows: string[][]): void {
    const pos = this.getPos()
    if (pos === undefined) return
    const value = tableToPipes(nextRows, this.align)
    if (value === this.node.attrs.value) return
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, value })
    this.view.dispatch(tr)
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== TABLE_TYPE) return false
    if (node.attrs._source !== this.node.attrs._source) return false
    if (node.attrs._plain !== this.node.attrs._plain) return false
    this.node = node
    const value = String(node.attrs.value ?? '')
    const rows = parsePipes(value)
    const align = parsePipesAlign(value)
    if (
      JSON.stringify(rows) !== JSON.stringify(this.rows) ||
      JSON.stringify(align) !== JSON.stringify(this.align)
    ) {
      this.rows = rows
      this.align = align
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
    this.unsubscribeFormulaEnv?.()
    this.unsubscribeFormulaEnv = null
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
  // View mode is not content: keep it out of undo so Ctrl+Z in the grid never
  // rewinds (or, by history grouping, collapses with) the switch into the mode.
  tr.setMeta('addToHistory', false)
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

/** True when a double-click lands in the empty space beside a table's grid —
 * inside the scroll wrapper but past the grid's right edge by a small margin —
 * which should leave spreadsheet mode exactly like a double-click outside the
 * block. The grid only spans its content width, so this is the white area to
 * the right of the table. */
function isSpreadsheetEmptyArea(event: MouseEvent): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  const grid = target.closest('.ss-table-scroll')?.querySelector<HTMLElement>('.ss-grid')
  if (!grid || grid.contains(target)) return false
  return event.clientX > grid.getBoundingClientRect().right + EXIT_MARGIN
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
      // A double-click inside the spreadsheet normally stays put, but the empty
      // area beside the grid should behave like the area outside the block.
      if (target.closest?.('.spreadsheet') && !isSpreadsheetEmptyArea(event)) return
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