import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { parsePipes, tableToPipes, parsePipesAlign, type TableAlign } from '../spreadsheet-util'
import { solve, isFormula, type SpreadsheetSolution } from '../spreadsheet'
import { BUILTIN_FORMULAS, type FormulaFunction } from '../formulas'
import { documentFunctionsFor, formulaEnvFor, subscribeFormulaEnv } from '../formulaDefs'
import { subscribeSearchChanges } from '../search'
import { undoNoScroll, redoNoScroll, undoDepth, redoDepth } from 'prosemirror-history'
import { deleteFormulaRefs, insertFormulaRefs, remapFormulaRefs } from '../series'
import { copyText, readText } from '../clipboard'
import { showsSource } from '../blockview'
import {
  attachBlockControls,
  leaveBlockMode,
} from '../block-modes'
import {
  setActiveCellHost,
  type CellLinkContext,
  type InlineCellHost,
  type InlineCellKind,
} from '../inline-format'
import { maskedFieldToMarkdown, primeMaskedFieldReveal, promptForNewSecret } from './masked'
import { ContextMenu, type ContextMenuEntry } from '../contextmenu'
import { TableSelection } from './tableSelection'
import { CellEditingController, type CellEditingHost } from './tableEditing'
import { TableRenderer, type TableRenderHost } from './tableRender'
export { tableFormOf, TABLE_TYPE } from './tableShared'
import {
  CellRef,
  FillRect,
  autofillLastRow,
  TABLE_TYPE,
  fillCellValue as computeFillCell,
  fillPreviewText as previewFill,
  fillSelectionDown as fillRowsDown,
  fillSelectionRight as fillRowsRight,
  ensureInlineFocusListeners,
  formControl,
  searchActiveCell,
  tableFormAt,
} from './tableShared'

/** Live spreadsheet node views, keyed by their `.spreadsheet` block element.
 *  The app-level right-click menu reaches the grid's (otherwise private)
 *  editing commands through this, so it needs the node view behind a
 *  right-clicked cell; a weak map keeps it free of teardown bookkeeping. */
export const spreadsheetViews = new WeakMap<HTMLElement, TableNodeView>()
export class TableNodeView implements NodeView, InlineCellHost {
  dom: HTMLElement
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined

  private rows: string[][] = []
  private align: TableAlign[] = []

  private readonly selection = new TableSelection()
  private get anchor(): CellRef | null {
    return this.selection.anchor
  }
  private get active(): CellRef | null {
    return this.selection.active
  }
  private readonly editor: CellEditingController
  private readonly renderer: TableRenderer
  private get editing(): { row: number; col: number } | null {
    return this.editor.editing
  }
  private get fxInput(): HTMLInputElement | null {
    return this.renderer.fxInput
  }
  private get resolveInput(): HTMLInputElement | null {
    return this.renderer.resolveInput
  }
  private get grid(): HTMLElement | null {
    return this.renderer.grid
  }
  private get cells(): HTMLElement[][] {
    return this.renderer.cells
  }
  private get colEls(): HTMLTableColElement[] {
    return this.renderer.colEls
  }
  /** The solution backing what's currently rendered. Tools that should freeze
   * what the user sees — `Use values` — read from here instead of re-solving,
   * so a volatile cell's value can't change between the screen and the commit. */
  private get renderedSolution(): SpreadsheetSolution | null {
    return this.renderer.lastSolution
  }
  private dragging = false
  private menu: ContextMenu | null = null
  private cutSource: { r1: number; c1: number; r2: number; c2: number } | null = null
  private fillDrag: FillRect | null = null
  private readonly onFillMove = (event: MouseEvent): void => this.handleFillMove(event)
  private readonly onFillUp = (event: MouseEvent): void => this.handleFillUp(event)
  private readonly onDocCopy = (event: Event): void => this.onClipboardCopy(event as ClipboardEvent)
  private readonly onDocCut = (event: Event): void => this.onClipboardCut(event as ClipboardEvent)
  private readonly onDocPaste = (event: Event): void => this.onClipboardPaste(event as ClipboardEvent)
  private unsubscribeFormulaEnv: (() => void) | null = null
  private unsubscribeSearchChanges: (() => void) | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.rows = parsePipes(String(node.attrs.value ?? ''))
    this.align = parsePipesAlign(String(node.attrs.value ?? ''))
    this.dom = document.createElement('div')
    this.dom.className = 'spreadsheet'
    spreadsheetViews.set(this.dom, this)
    const host: CellEditingHost = {
      view: this.view,
      dom: this.dom,
      rows: () => this.rows,
      selection: () => this.selection,
      grid: () => this.grid,
      colEls: () => this.colEls,
      fxInput: () => this.fxInput,
      formulaFunctions: () => this.formulaFunctions(),
      cellEl: (row, col) => this.cellEl(row, col),
      resolveTarget: (target) => this.resolveTarget(target),
      commitRows: (next, anchor, active) => this.commitRows(next, anchor, active),
      renderSelection: () => this.renderSelection(),
      renderFillHandle: () => this.renderFillHandle(),
      moveInGrid: (row, col, wrap) => this.moveInGrid(row, col, wrap),
      insertSecret: () => this.insertSecret(),
    }
    this.editor = new CellEditingController(host)
    const renderHost: TableRenderHost = {
      dom: this.dom,
      view: this.view,
      rows: () => this.rows,
      align: () => this.align,
      selection: () => this.selection,
      node: () => this.node,
      position: () => this.getPos(),
      editing: () => this.editor.editing,
      editOverlay: () => this.editor.editOverlay,
      pointRange: () => this.editor.pointRange,
      cutSource: () => this.cutSource,
      fillDrag: () => this.fillDrag,
      fillPreview: (drag) => previewFill(this.rows, drag),
      wireFxInput: (input) => this.editor.wireFxInput(input),
      commitFxEdit: () => this.commitFxEdit(),
      commitRows: (next, anchor, active) => this.commitRows(next, anchor, active),
      onGridMouseDown: (event) => this.onGridMouseDown(event),
      onGridKeydown: (event) => this.onGridKeydown(event),
      onDblClick: (event) => this.onDblClick(event),
      onGridFocus: () => setActiveCellHost(this.editor),
      updatePointCursor: () => this.editor.updatePointCursor(),
      onStartFill: (event) => this.startFill(event),
      onAutofill: () => this.autofillFromHandle(),
      alignColumns: (align) => this.alignColumns(align),
      useValues: () => this.useValues(),
      setResolved: (resolved) => this.setResolved(resolved),
      insertAt: (axis, index) => {
        if (axis === 'col') this.insertColumnAt(index)
        else this.insertRowAt(index)
      },
    }
    this.renderer = new TableRenderer(renderHost)

    // One cluster for the block, in the same place every other block's is: its
    // mode buttons, generated from the descriptor, then the block's own actions —
    // here the one control that changes the rendered form.
    const controls = attachBlockControls(node, view, getPos, [formControl(view, getPos, node)])
    if (controls) this.dom.appendChild(controls.dom)

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
    this.renderer.build()
    this.selection.collapse({ row: 0, col: 0 })
    this.renderSelection()
    ensureInlineFocusListeners()
    this.unsubscribeFormulaEnv = subscribeFormulaEnv(view, () => this.refreshFormulaValues())
    this.unsubscribeSearchChanges = subscribeSearchChanges(view, () => this.onSearchChange())

    document.addEventListener('copy', this.onDocCopy)
    document.addEventListener('cut', this.onDocCut)
    document.addEventListener('paste', this.onDocPaste)
  }

  /** Format the selection through the cell-editing controller. */
  applyInline(kind: InlineCellKind, url?: string): boolean {
    return this.editor.applyInline(kind, url)
  }

  /** Snapshot the live link context before the URL dialog opens. */
  beginCellLink(): CellLinkContext {
    return this.editor.beginCellLink()
  }

  /** Apply the link dialog's answer to the snapshot from `beginCellLink`. */
  applyCellLink(text: string, url: string): boolean {
    return this.editor.applyCellLink(text, url)
  }

  update(node: ProseNode): boolean {
    // A block showing its source is a different node view altogether, and this
    // one is only ever built for the sheet — so "in the source form" *is* "the
    // mode changed", and refusing the update is the rebuild. Asked of the record,
    // which is where the representation lives now that no node carries one.
    if (showsSource(this.view, this.getPos())) return false
    // This view is only ever built for a sheet, so the rebuild is the block
    // having stopped being one.
    if (tableFormAt(this.view.state, this.getPos()) === 'text') return false
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

  /**
   * The sheet's own control row, at the **left** of the sheet's chrome and below
   * the grid's own header: the three alignment buttons, **Use values**, the
   * "Resolve formulas?" checkbox, and the status readout on their own.
   *
   * These were briefly moved into the block's cluster, on the argument that §6.3
   * puts a block's actions there. That was the wrong call and it was tried rather
   * than argued: the sheet's row *is* where the alignment controls have always
   * lived, they are column-and-cell controls for a grid that is right there, and
   * putting them in a hover pill at the block's right edge moved three controls a
   * long way from the columns they act on to sit beside a **Source** button that
   * has nothing to do with either. The cluster keeps the mode controls, which are
   * about the block, and nothing else.
   */
  formulaFunctions(): readonly FormulaFunction[] {
    return [...BUILTIN_FORMULAS, ...documentFunctionsFor(this.view.state)]
  }

  // --- Grid ---

  fillCellContents(): void {
    this.renderer.fillCellContents()
  }

  private refreshFormulaValues(): void {
    if (this.editing) return
    this.fillCellContents()
  }

  /** The search state moved (query, flags or active match): repaint the cell
   * highlights, then bring the cell under the active match into view. */
  private onSearchChange(): void {
    this.refreshFormulaValues()
    this.scrollActiveCellIntoView()
  }

  /** Scroll the spreadsheet so the cell carrying the current search match is
   * visible. Deferred a frame so ProseMirror's own block-level scroll for the
   * NodeSelection (which aligns the whole grid, not the cell) applies first. */
  private scrollActiveCellIntoView(): void {
    const active = searchActiveCell(this.view, this.node, this.getPos)
    if (!active?.span) return
    const td = this.cells[active.span.row]?.[active.span.col]
    if (!td) return
    requestAnimationFrame(() => td.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }))
  }

  renderSelection(): void {
    this.renderer.renderSelection()
  }

  private alignColumns(align: TableAlign): void {
    const cols = this.renderer.alignTargetCols()
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
      this.renderer.updateAlignButtons()
      this.grid?.focus()
      return
    }
    const anchor = this.anchor ?? { row: 0, col: Math.min(...cols) }
    const active = this.active ?? anchor
    this.commitRows(this.rows.map((row) => [...row]), anchor, active)
    this.grid?.focus()
  }

  renderFillHandle(): void {
    this.renderer.renderFillHandle()
  }

  private currentRect(): { r1: number; c1: number; r2: number; c2: number } | null {
    return this.selection.rect()
  }

  private startFill(event: MouseEvent): void {
    const grid = this.grid
    if (!grid) return
    event.preventDefault()
    event.stopPropagation()
    if (this.editing) this.commitCellEdit()
    else this.commitFxEdit()
    grid.focus()
    setActiveCellHost(this.editor)
    const rect = this.currentRect()
    if (!rect || this.selection.extra.size > 0) return
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
    this.renderer.updateFillGhost()
  }

  private handleFillUp(_event: MouseEvent): void {
    const drag = this.fillDrag
    document.removeEventListener('mousemove', this.onFillMove)
    document.removeEventListener('mouseup', this.onFillUp)
    this.fillDrag = null
    this.renderer.clearFillGhost()
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
        next[r]![c] = computeFillCell(this.rows, drag, r, c)
      }
    }
    this.commitRows(next, { row: drag.sr1, col: drag.sc1 }, { row: drag.r2, col: drag.c2 })
    this.grid?.focus()
  }

  /** Double-clicking the fill handle fills the selected column(s) down the
   * grid, stopping at the last row where the adjacent column has content. */
  private autofillFromHandle(): void {
    const rect = this.currentRect()
    if (!rect) return
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    if (rows === 0 || cols === 0) return
    const last = autofillLastRow(this.rows, rect)
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
        next[r]![c] = computeFillCell(this.rows, drag, r, c)
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
    this.commitRows(fillRowsDown(this.rows, rect), { row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 })
    this.grid?.focus()
  }

  /** Ctrl/Cmd+R: copy the selection's left column right across the selection. */
  private fillSelectionRight(): void {
    const rect = this.currentRect()
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    if (!rect || rect.c2 - rect.c1 < 1 || rows === 0 || cols === 0) return
    this.commitRows(fillRowsRight(this.rows, rect), { row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 })
    this.grid?.focus()
  }

  private selectedHas(): (row: number, col: number) => boolean {
    return (row, col) => this.selection.contains(row, col)
  }

  private collectSelected(): CellRef[] {
    return this.selection.collect(this.rows.length, this.rows[0]?.length ?? 0)
  }

  private selectedCols(): Set<number> {
    return this.selection.selectedCols(this.rows.length, this.rows[0]?.length ?? 0)
  }

  private selectedRows(): Set<number> {
    return this.selection.selectedRows(this.rows.length, this.rows[0]?.length ?? 0)
  }

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
      this.selection.set({ row: 0, col: c }, { row: rows - 1, col: c })
      this.selection.extra.clear()
      this.renderSelection()
      entries.push({
        type: 'item',
        label: 'Delete column',
        disabled: cols <= 1,
        onSelect: () => this.removeColumns(),
      })
    } else if (gutter) {
      const r = Math.max(0, Math.min(Number(gutter.dataset.row), rows - 1))
      this.selection.set({ row: r, col: 0 }, { row: r, col: cols - 1 })
      this.selection.extra.clear()
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

  /**
   * Editing commands for a right-click inside the grid. They act on the current
   * selection: the right-click's own mousedown has already moved it to the
   * clicked cell (or left a dragged range alone), so nothing here needs to
   * resolve the target again.
   *
   * Clipboard items mirror the grid's own shortcuts — cut leaves the familiar
   * pending-cut marquee (the cells blank out when the paste lands) and paste
   * reads through the app's clipboard bridge — so the menu, the keyboard and
   * the native Edit menu all land on the same state.
   */
  buildCellMenuEntries(): ContextMenuEntry[] {
    const tsv = this.selectionTsv()
    const active = this.active ?? { row: 0, col: 0 }
    return [
      {
        type: 'item',
        label: 'Undo',
        disabled: undoDepth(this.view.state) === 0,
        onSelect: () => undoNoScroll(this.view.state, this.view.dispatch, this.view),
      },
      {
        type: 'item',
        label: 'Redo',
        disabled: redoDepth(this.view.state) === 0,
        onSelect: () => redoNoScroll(this.view.state, this.view.dispatch, this.view),
      },
      { type: 'separator' },
      { type: 'item', label: 'Cut', disabled: !tsv, onSelect: () => this.cutSelection() },
      { type: 'item', label: 'Copy', disabled: !tsv, onSelect: () => this.copySelection() },
      { type: 'item', label: 'Paste', onSelect: () => void this.pasteFromClipboard() },
      { type: 'item', label: 'Select all', onSelect: () => this.selectAllCells() },
      { type: 'separator' },
      { type: 'item', label: 'Clear contents', disabled: !tsv, onSelect: () => this.clearSelected() },
      // Row 0 is the GFM header, which `insertRowAt` refuses to grow above.
      { type: 'item', label: 'Insert row above', disabled: active.row < 1, onSelect: () => this.insertRowAt(active.row) },
      { type: 'item', label: 'Insert column left', onSelect: () => this.insertColumnAt(active.col) },
    ]
  }

  /** Ctrl+X without a clipboard event: same TSV, same pending cut. */
  private cutSelection(): void {
    const tsv = this.selectionTsv()
    if (!tsv) return
    void copyText(tsv)
    this.cutSource = this.selectionBounds()
    this.renderSelection()
  }

  private copySelection(): void {
    const tsv = this.selectionTsv()
    if (tsv) void copyText(tsv)
  }

  private async pasteFromClipboard(): Promise<void> {
    const text = await readText()
    if (text) this.pasteTsv(text)
  }

  selectAllCells(): void {
    this.selection.selectAll(this.rows.length, this.rows[0]?.length ?? 0)
    this.renderSelection()
    this.grid?.focus()
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
    setActiveCellHost(this.editor)

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
        this.selection.toggleExtra({ row: r, col: c })
        anchor = this.anchor ?? { row: r, col: c }
        active = this.active ?? { row: r, col: c }
        keepExtra = true
      } else if (event.button === 2 && this.anchor && this.active && this.selectedHas()(r, c)) {
        // A right-click inside the current selection keeps it, so the
        // context menu's cut/copy/clear act on the whole range — the same
        // courtesy every spreadsheet gives before showing its menu.
        anchor = this.anchor
        active = this.active
        keepExtra = true
      } else if (event.shiftKey && this.anchor) {
        anchor = this.anchor
        active = { row: r, col: c }
      } else {
        anchor = { row: r, col: c }
        active = { row: r, col: c }
      }
    }
    this.selection.set(anchor, active)
    if (!keepExtra) this.selection.extra.clear()
    this.renderSelection()

    if (target.kind === 'cell') {
      this.dragging = true
      const move = (moveEvent: MouseEvent): void => {
        if (!this.dragging) return
        const hover = this.resolveTarget(moveEvent.target)
        if (hover && hover.kind === 'cell') {
          this.selection.extendTo({
            row: Math.max(0, Math.min(hover.row, rows - 1)),
            col: Math.max(0, Math.min(hover.col, cols - 1)),
          })
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
    if (chrome && this.renderer.insertGuideTarget) {
      event.preventDefault()
      event.stopPropagation()
      this.renderer.commitInsertGuide()
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
    this.editor.startEditAt(target.row, target.col)
  }

  private onGridKeydown(event: KeyboardEvent): void {
    const rows = this.rows.length
    const cols = this.rows[0]?.length ?? 0
    const mod = event.metaKey || event.ctrlKey
    const key = event.key

    // `Ctrl+A` never arrives: the window takes it first and routes it, like Edit →
    // Select All, to `selectAllCells` (`editController.ts`).

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

    // **The cells own the clipboard keys, and the document must not take them.**
    // `registerShortcuts` in `main.ts` binds Mod-c/Mod-x/Mod-v (and their
    // *-as-markdown Shift variants) on `window`, precisely because a webview
    // whose selection is managed in JavaScript does not reliably produce a
    // native `copy` event — and it routes them to `editCopy`/`editPaste`, which
    // act on the *ProseMirror selection*. A cell selection is not that: it is
    // `anchor`/`active` plus a CSS class, so the document's selection is
    // normally empty and `Ctrl+C` copied nothing at all, while `Ctrl+V` pasted
    // the clipboard's text into the document as a new paragraph beside the grid.
    // Nothing stopped the event here, so it bubbled to `window` and the page
    // handled it there. The same grid methods back the right-click menu, so
    // `Ctrl+C` is now the same command as that menu's Copy.
    //
    // The Shift variants fold in deliberately: a cell range *is* the cells'
    // raw markdown, and there is no rich-text rendering of a range to carry a
    // second payload for, so `Mod-Shift-C`/`Mod-Shift-V` are these — what must
    // not happen is the window handler copying the document instead.
    // `Ctrl+Alt+Shift+C` (copy file path) is left alone; it is not a clipboard
    // *content* shortcut and `main.ts` claims it.
    if (mod && !event.altKey && ['c', 'x', 'v'].includes(key.toLowerCase())) {
      // An editable host inside the grid — the fx bar, the in-cell editor — keeps
      // its own native copy/cut/paste, which is the only thing that can carry a
      // selection made inside it.
      if (!this.isSpreadsheetClipboardTarget(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      if (key.toLowerCase() === 'x') this.cutSelection()
      else if (key.toLowerCase() === 'c') this.copySelection()
      else void this.pasteFromClipboard()
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

    // **Escape is a ladder here, and this is its last rung.** Everything above it
    // is a *field* claiming the key first — `onEditKeydown` rejects the value being
    // typed in a cell without committing it, the fx bar reverts its own input, the
    // autocomplete closes — so a reader in the middle of an edit presses Escape
    // once to abandon that edit and is still in the sheet, which is what makes a
    // second press meaning "done" rather than "you just lost what I typed".
    //
    // Which is what this rung is for. It used to call `view.focus()` and keep the
    // sheet, which put the caret in the document beside the grid the reader had
    // just finished with, and so looked broken rather than finished. Releasing the
    // form is the same route Alt+click takes, so there is exactly one way out of a
    // sheet and both gestures behave alike.
    if (key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (this.cutSource) {
        this.cancelCut()
        return
      }
      const at = this.getPos()
      if (at === undefined) return
      leaveBlockMode(this.view, at)
      return
    }
    if (key === 'Enter' || key === 'F2') {
      event.preventDefault()
      event.stopPropagation()
      if (this.active) this.editor.startEditAt(this.active.row, this.active.col)
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
      this.selection.moveTo({ row, col }, event.shiftKey)
      this.renderSelection()
      return
    }
    if (key.length === 1 && !mod && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      if (this.active) this.editor.startEditAt(this.active.row, this.active.col, key)
    }
  }

  // --- Point mode (Excel-style reference picking) ---

  formulaPointInput(): { input: HTMLInputElement } | null {
    return this.editor.formulaPointInput()
  }

  updatePointCursor(): void {
    this.editor.updatePointCursor()
  }

  startPointInsert(input: HTMLInputElement, row: number, col: number, withDrag = true): void {
    this.editor.startPointInsert(input, row, col, withDrag)
  }

  /** Commit whichever editor is open (inline overlay or fx bar). */
  commitPointEdit(): void {
    this.editor.commitPointEdit()
  }

  private cellEl(row: number, col: number): HTMLElement | null {
    return this.cells[row]?.[col] ?? null
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
    this.selection.collapse({
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    })
    this.renderSelection()
  }

  commitCellEdit(): void {
    this.editor.commitCellEdit()
  }

  teardownEdit(): void {
    this.editor.teardownEdit()
  }

  commitFxEdit(): void {
    this.editor.commitFxEdit()
  }

  /** The `Use values` tool: replace every formula cell in the selection with
   * its currently *rendered* display, so volatile cells (`UUID`, `RAND`,
   * `NOW`, …) stop recalculating — the spreadsheet equivalent of Excel's copy
   * → paste values. The values come from the last `fillCellContents` solve
   * (what's on screen), never re-solved here, so a volatile cell's cooked
   * value is exactly the one the user is looking at. Non-formula cells are
   * left alone; the whole selection is written in one commit, and the undo is
   * the normal history. */
  private useValues(): void {
    if (!this.active) return
    this.commitFxEdit()
    const solution = this.renderedSolution ?? solve(this.rows, formulaEnvFor(this.view.state))
    const next = this.rows.map((r) => [...r])
    let changed = false
    for (const { row, col } of this.collectSelected()) {
      const raw = next[row]?.[col] ?? ''
      if (!isFormula(raw)) continue
      const cell = solution.cells[row]?.[col]
      if (!cell || (cell.kind !== 'formula' && cell.kind !== 'error')) continue
      const value = cell.display
      if (value === raw) continue
      next[row]![col] = value
      changed = true
    }
    if (!changed) {
      this.grid?.focus()
      return
    }
    const anchor = this.anchor ?? { row: 0, col: 0 }
    this.commitRows(next, anchor, this.active)
    this.grid?.focus()
  }

  /** Enable `Use values` whenever any selected cell holds a formula. */
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
    this.selection.set(anchor, active)
    this.selection.clamp(rows, cols)
    this.teardownEdit()
    this.renderer.buildGrid()
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
    const secret = await promptForNewSecret((this.active && this.rows[this.active.row]?.[this.active.col]) || '')
    if (!secret) return
    const row = this.active?.row ?? 0
    const col = this.active?.col ?? 0
    const next = this.rows.map((r) => [...r])
    const current = next[row]?.[col] ?? ''
    next[row]![col] = current.trim() ? `${current} ${maskedFieldToMarkdown(secret.envelope, secret.label)}` : maskedFieldToMarkdown(secret.envelope, secret.label)
    this.commitRows(next, { row, col }, { row, col })
    if (secret.showValueInitially) primeMaskedFieldReveal(secret.envelope, secret.password, secret.value)
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
    return this.selection.bounds() ?? { r1: 0, c1: 0, r2: 0, c2: 0 }
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
      // Repoint every formula's references to the moved cells — the pasted
      // block's own included: in a cut A2:B2 → A5:B5, B2's `=A2*2` has to become
      // `=A5*2`, or it reads the now-empty A2. References to cells outside the
      // cut stay where they were, as in a spreadsheet.
      const dr = r1 - cut.r1
      const dc = c1 - cut.c1
      if (dr !== 0 || dc !== 0) {
        const src = { r1: cut.r1 + 1, c1: cut.c1 + 1, r2: cut.r2 + 1, c2: cut.c2 + 1 }
        for (let r = 0; r < maxRows; r++) {
          for (let c = 0; c < maxCols; c++) {
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
    spreadsheetViews.delete(this.dom)
    this.dragging = false
    if (this.fillDrag) {
      document.removeEventListener('mousemove', this.onFillMove)
      document.removeEventListener('mouseup', this.onFillUp)
      this.fillDrag = null
    }
    this.renderer.clearFillGhost()
    document.removeEventListener('copy', this.onDocCopy)
    document.removeEventListener('cut', this.onDocCut)
    document.removeEventListener('paste', this.onDocPaste)
    this.unsubscribeFormulaEnv?.()
    this.unsubscribeFormulaEnv = null
    this.unsubscribeSearchChanges?.()
    this.unsubscribeSearchChanges = null
    this.editor.closeSuggestions()
  }
}
