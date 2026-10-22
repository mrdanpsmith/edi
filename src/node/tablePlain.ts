import { Selection } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { parsePipes, parsePipesAlign, tableToPipes, inlineMarkdownToHtml, type TableAlign } from '../spreadsheet-util'
import { solve, type CellSolution } from '../spreadsheet'
import { formulaEnvFor } from '../formulaDefs'
import { subscribeSearchChanges } from '../search'
import {
  paintPlainTableSelection,
  selectionEndsIn,
} from '../tableTextSelection'
import { showsSource } from '../blockview'
import {
  BLOCK_CONTENT_CLASS,
  BLOCK_CONTROLS_CLASS,
  BLOCK_MARGIN_CLASS,
  attachBlockControls,
} from '../block-modes'
import { onBlockMargin } from '../press'
import { subscribeFormulaEnv } from '../formulaDefs'
import {
  CELL_SELECTED_CLASS,
  CLICK_SLOP,
  TABLE_TYPE,
  bindMaskedPillsIn,
  cellTitle,
  formControl,
  highlightTableCell,
  onNativeSelectionChange,
  searchActiveCell,
  tableFormAt,
} from './tableShared'

export class TablePlainView implements NodeView {
  dom: HTMLElement
  private node: ProseNode
  private view: EditorView
  private getPos: () => number | undefined
  private rows: string[][] = []
  private align: TableAlign[] = []
  private body: HTMLElement | null = null
  private cells: HTMLElement[][] = []
  private unsubscribeFormulaEnv: (() => void) | null = null
  private unsubscribeSearchChanges: (() => void) | null = null
  private unsubscribeSelection: (() => void) | null = null
  /** Where a press landed, so the release can tell a click from a drag. */
  private pressAt: { x: number; y: number } | null = null

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.rows = parsePipes(String(node.attrs.value ?? ''))
    this.align = parsePipesAlign(String(node.attrs.value ?? ''))

    this.dom = document.createElement('div')
    this.dom.className = 'ss-plain'

    const controls = attachBlockControls(node, view, getPos, [formControl(view, getPos, node)])
    if (controls) this.dom.appendChild(controls.dom)

    this.body = document.createElement('div')
    this.body.className = 'ss-plain-body'
    this.dom.appendChild(this.body)
    this.renderBody()
    this.unsubscribeFormulaEnv = subscribeFormulaEnv(view, () => this.renderBody())
    this.unsubscribeSearchChanges = subscribeSearchChanges(view, () => this.onSearchChange())
    this.unsubscribeSelection = onNativeSelectionChange(() => this.paintSelection())
    this.dom.addEventListener('mousedown', this.onPressStart)
    this.dom.addEventListener('mouseup', this.onPressEnd)
  }

  /**
   * **A press that selected nothing drops the app's selection**, which is the only gesture
   * this surface can answer with "nothing" and the last way out of a selection once
   * `Ctrl+A` has painted every cell in the document.
   *
   * Why it has to be here at all: this view's own selection is the **browser's** (§3.1), and
   * a range inside `contenteditable=false` cells is the browser's to make — but the *fill*
   * over every cell is the app's, and it is driven by ProseMirror's selection, which a
   * press in a cell cannot change (see `stopEvent`). So without this, select-all in a
   * document with tables and the cells stayed lit with no way to clear them: Escape does
   * nothing, an arrow key clears it but leaves the reader somewhere else, and clicking
   * anywhere outside the table cleared it only because that press *reached* ProseMirror.
   *
   * **A click, not a press**: the movement check is what keeps a drag out of it, because a
   * drag is a text selection the reader is making and not a click they want answered.
   * **Not a modifier**: `Shift`/`Ctrl`/`Alt` on a press is a selection the reader is
   * *extending*, and clearing it there would fight them.
   */
  private onPressStart = (event: MouseEvent): void => {
    this.pressAt = { x: event.clientX, y: event.clientY }
  }

  private onPressEnd = (event: MouseEvent): void => {
    const press = this.pressAt
    this.pressAt = null
    if (press === null || event.button !== 0) return
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
    if (Math.abs(event.clientX - press.x) > CLICK_SLOP) return
    if (Math.abs(event.clientY - press.y) > CLICK_SLOP) return

    const pos = this.getPos()
    if (pos === undefined) return
    const { state } = this.view
    if (state.selection.empty) return
    // **Which side, because a `table` is an atom with no content**: the caret cannot go
    // inside it, so it goes to the nearer edge of the block — above the press it lands
    // before the table, below it after. That is where a press on the white space beside
    // the table already put the caret, so a click in a cell and a click beside it agree.
    const box = this.dom.getBoundingClientRect()
    const bias = event.clientY < box.top + box.height / 2 ? -1 : 1
    const $inside = state.doc.resolve(pos + 1)
    this.view.dispatch(state.tr.setSelection(Selection.near($inside, bias)))
    this.paintSelection()
  }

  private renderBody(): void {
    const body = this.body
    if (!body) return

    const scroll = document.createElement('div')
    // **The gutter, declared.** The block hugs its grid now, so this element is the grid's own
    // width in the usual case and there is nothing beside it to press; the declaration is what
    // still says *which part of me is not my content* when the grid is wider than the column and
    // the scroller has to be wider than the grid inside it. A press in that strip is a request
    // for a caret beside the table (`BLOCK_MARGIN_CLASS`, read by `src/press.ts`), not a click
    // on the table.
    scroll.className = `ss-plain-scroll ${BLOCK_MARGIN_CLASS}`
    scroll.appendChild(this.buildTable())

    body.textContent = ''
    body.appendChild(scroll)
    // A rebuild makes fresh cells, so the selection has to be painted onto *these*.
    this.paintSelection()
  }

  /**
   * Paint the cells this selection covers.
   *
   * **Two painters, and which one is in charge is a measurement** — see
   * `src/tableTextSelection.ts`, whose header table is the whole of it. Briefly: the
   * browser paints a selection it can see the ends of (fragment-accurately, in the app's
   * own `--selection`), paints *nothing* for a range that merely brackets the table, and
   * paints only the half of a range that crosses into it from prose. So:
   *
   * - **the browser owns it** when both ends of the range are in *this* table, and this
   *   painter stands down — a cell fill would throw away the only thing that makes a
   *   table read as text, which is that the highlight follows the words;
   * - **this painter owns it** otherwise, which is the §3.1 wall: a bracketing range
   *   (`Ctrl+A`, prose → prose) has nothing else to paint with, and leaving a hole where
   *   the table is is worse than the outline it replaced.
   *
   * Both signals are read, because they answer different questions and the reader is
   * looking at the union: the model says whether the block is inside the app's selection,
   * the DOM says whether the range the reader is dragging runs through this table.
   */
  private paintSelection(): void {
    const pos = this.getPos()
    const sel = this.view.state.selection
    const node = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    const inModel = pos !== undefined && node !== null &&
      sel.from <= pos && pos + node.nodeSize <= sel.to
    // **Either signal will do**, and taking the union is what makes the paint follow a
    // real drag. ProseMirror maps a DOM range onto the document, and a range that runs
    // across an atom can land on either side of it, so the model's answer alone leaves
    // a table unpainted while the reader plainly sees a selection across it. The
    // browser's own range is the other half of the truth — `intersectsNode` works on
    // this subtree where `Selection.containsNode` answers "no" for everything (§3.1's
    // wall again).
    const native = document.getSelection()
    const nativeRange = native !== null && native.rangeCount > 0 && !native.isCollapsed
      ? native.getRangeAt(0)
      : null
    const inDom = nativeRange !== null && nativeRange.intersectsNode(this.dom)
    const inside = inModel || inDom
    // **The one case the cells must not be filled in**: a selection with an end inside
    // this table, which the overlay has drawn to the words instead. Filling them as well
    // is what a reader selecting three characters of one cell used to get — the whole
    // grid lit up for a fragment, which is the "painted block" that made a table worse to
    // select in than it had any right to be.
    this.cells.forEach((row) => row.forEach((cell) => {
      cell.classList.toggle(CELL_SELECTED_CLASS, inside && !selectionEndsIn(this.dom))
    }))
    // A rebuild means fresh cells, and the overlay is drawn onto them — so a repaint is
    // also the moment the fragment highlight has to be redrawn, or it goes with the cells
    // it was drawn onto.
    paintPlainTableSelection()
  }

  private buildTable(): HTMLTableElement {
    const table = document.createElement('table')
    // **Both halves of the gutter, declared.** The strip around this grid is white space; the
    // grid is its content, and the two markers are what tell `onBlockMargin` which side of that
    // element a press fell on — the strip *contains* the grid, so "inside the gutter" alone
    // would answer a click in a cell, which is the browser's text selection.
    table.className = `ss-plain-table ${BLOCK_CONTENT_CLASS}`
    const cols = Math.max(...this.rows.map((r) => r.length), 0)
    const solution = solve(this.rows, formulaEnvFor(this.view.state))
    const active = searchActiveCell(this.view, this.node, this.getPos)
    this.cells = []

    const thead = document.createElement('thead')
    const headRow = document.createElement('tr')
    const headCells: HTMLElement[] = []
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th')
      th.dataset.align = this.align[c] ?? 'none'
      this.fillCell(th, 0, c, solution.cells[0]?.[c], active)
      headRow.appendChild(th)
      headCells.push(th)
    }
    thead.appendChild(headRow)
    table.appendChild(thead)
    this.cells.push(headCells)

    const tbody = document.createElement('tbody')
    for (let r = 1; r < this.rows.length; r++) {
      const tr = document.createElement('tr')
      const rowCells: HTMLElement[] = []
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td')
        td.dataset.align = this.align[c] ?? 'none'
        this.fillCell(td, r, c, solution.cells[r]?.[c], active)
        tr.appendChild(td)
        rowCells.push(td)
      }
      tbody.appendChild(tr)
      this.cells.push(rowCells)
    }
    table.appendChild(tbody)

    return table
  }

  private fillCell(
    td: HTMLElement,
    row: number,
    col: number,
    cellSol: CellSolution | undefined,
    active: ReturnType<typeof searchActiveCell>,
  ): void {
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
    highlightTableCell(this.view, td, row, col, active)
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

  /** The search state moved: repaint + bring the matching cell into view. */
  private onSearchChange(): void {
    this.renderBody()
    this.scrollActiveCellIntoView()
  }

  private scrollActiveCellIntoView(): void {
    const active = searchActiveCell(this.view, this.node, this.getPos)
    if (!active?.span) return
    const td = this.cells[active.span.row]?.[active.span.col]
    if (!td) return
    requestAnimationFrame(() => td.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }))
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== TABLE_TYPE) return false
    if (showsSource(this.view, this.getPos())) return false
    // This view is only ever built for plain text, so the rebuild is the block
    // having stopped being text.
    if (tableFormAt(this.view.state, this.getPos()) === 'sheet') return false
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

  /**
   * **Claim the cells and the block's own controls. Nothing else.**
   *
   * This view used to claim *every* event in the block, and it was the reason a Visual table
   * could not be undone from inside: a `Ctrl+A` paints every cell in the document from
   * ProseMirror's selection, and a press anywhere in this block never reached ProseMirror,
   * so nothing could change that selection and the cells stayed lit — measured: 150 cells,
   * unclickable away, with `Escape` doing nothing.
   *
   * So it now claims only what it actually uses:
   *
   * - **the cells**, because a range inside them is the *browser's* (§3.1) and a press that
   *   ProseMirror answered would fight the selection the reader is making with a mouse drag;
   * - **the control cluster**, whose buttons are the app's own controls;
   * - **the gutter** — the strip of scroller beside a grid too wide for the column, which is
   *   this block's *surface* and not its content, and which is answered by `src/press.ts` as a
   *   press in the white space.
   *
   * The gutter is claimed rather than released **because releasing it is what the report was
   * about**: handed to ProseMirror, a click there *selected the table*, and a selected table
   * paints the whole width of the block, which reads as a selected row with a table in it and
   * leaves no place to click for a caret. A diagram's surface *should* select the diagram, which
   * is why `mermaid.ts` releases it (*"clicking it still selects the block"*); **a table's gutter
   * is not its surface**, it is the space around the table, and that is the distinction being
   * claimed. A block that hugs its grid has no such strip — the white space beside it is the
   * editor's, and `press.ts` answers for that one.
   */
  stopEvent(event: Event): boolean {
    const target = event.target
    if (!(target instanceof Element)) return false
    if (target.closest('.ss-plain-table :is(th, td)') !== null) return true
    // **The margin, not the content inside it**: `onBlockMargin` is the same question
    // `press.ts` asks, so a press on the grid's own padding — which *is* the table — still
    // reaches ProseMirror and still selects it, while the strip beside it does not.
    if (onBlockMargin(target)) return true
    return target.closest(`.${BLOCK_CONTROLS_CLASS}`) !== null
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.dom.removeEventListener('mousedown', this.onPressStart)
    this.dom.removeEventListener('mouseup', this.onPressEnd)
    this.unsubscribeFormulaEnv?.()
    this.unsubscribeFormulaEnv = null
    this.unsubscribeSearchChanges?.()
    this.unsubscribeSearchChanges = null
    this.unsubscribeSelection?.()
    this.unsubscribeSelection = null
    // The highlight boxes live inside this view's cells, so they go with the view.
    for (const box of this.dom.querySelectorAll('.ss-plain-selection-rect')) box.remove()
    this.body = null
  }
}

