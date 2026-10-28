import type { EditorView } from 'prosemirror-view'
import { cellCarriesMark, setCellMark } from '../inline-md'
import { colToLetters } from '../cellRef'
import { isFormula } from '../spreadsheet'
import type { FormulaFunction } from '../formulas'
import { FormulaAutocomplete } from '../formulaAutocomplete'
import { EmojiAutocomplete } from '../emojiPlugin'
import { emojiTokenAt } from '../emojiToken'
import {
  setActiveCellHost,
  type CellLinkContext,
  type InlineCellHost,
  type InlineCellKind,
} from '../inline-format'
import {
  EDIT_INPUT_PAD,
  MAX_COL_WIDTH,
  MIN_COL_WIDTH,
  linkHrefIn,
  linkSpans,
  setLink,
  wholeCellLinkHref,
  type CellRef,
  type PendingCellLink,
  type PointDrag,
  type PointInsert,
} from './tableShared'
import type { TableSelection } from './tableSelection'

/** Everything the editing controller needs from the node view: the document
 * and its rows, the live DOM the controller edits into, and the coordinator's
 * commit/repaint hooks. The controller owns no document state itself. */
export interface CellEditingHost {
  readonly view: EditorView
  readonly dom: HTMLElement
  rows(): string[][]
  selection(): TableSelection
  grid(): HTMLElement | null
  colEls(): HTMLTableColElement[]
  fxInput(): HTMLInputElement | null
  formulaFunctions(): readonly FormulaFunction[]
  cellEl(row: number, col: number): HTMLElement | null
  resolveTarget(
    target: EventTarget | null,
  ): { kind: 'cell' | 'col' | 'row' | 'corner'; row: number; col: number } | null
  commitRows(nextRows: string[][], anchor: CellRef, active: CellRef): void
  renderSelection(): void
  renderFillHandle(): void
  moveInGrid(row: number, col: number, wrap: boolean): void
  insertSecret(): Promise<void>
}

/**
 * The sheet's cell editor: the in-cell overlay, the fx bar, formula autocomplete
 * and Excel-style point mode. One controller per node view; it reads rows from
 * the host and writes every change back through `commitRows`, so undo, source
 * mode and the plain view all see the same single commit path.
 */
export class CellEditingController implements InlineCellHost {
  editing: { row: number; col: number } | null = null
  editOverlay: HTMLInputElement | null = null
  pointRange: { r1: number; c1: number; r2: number; c2: number } | null = null
  private fxInput: HTMLInputElement | null = null
  private pointDrag: PointDrag | null = null
  private pointInsert: PointInsert | null = null
  private pendingLink: PendingCellLink | null = null
  private readonly autocomplete: FormulaAutocomplete
  private readonly emojiAutocomplete = new EmojiAutocomplete()

  constructor(private readonly host: CellEditingHost) {
    this.autocomplete = new FormulaAutocomplete(() => host.formulaFunctions())
  }

  /** Wire the fx bar input after the coordinator builds it. */
  wireFxInput(input: HTMLInputElement): void {
    this.fxInput = input
    input.addEventListener('keydown', (event) => this.onFxInputKeydown(event))
    input.addEventListener('blur', () => {
      this.autocomplete.close()
      this.emojiAutocomplete.close()
      this.commitFxEdit()
    })
    input.addEventListener('focus', () => {
      setActiveCellHost(this)
      this.updatePointCursor()
    })
    input.addEventListener('input', () => {
      this.updatePointCursor()
      this.refreshAutocomplete(input)
    })
  }

  private selectedCells(): CellRef[] {
    return this.host.selection().collect(this.host.rows().length, this.host.rows()[0]?.length ?? 0)
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
    const active = this.host.selection().active
    if (kind === 'secret') {
      if (active === null) return false
      void this.host.insertSecret()
      return true
    }
    const cells = this.selectedCells()
    if (cells.length === 0) return false
    const rawOf = (row: number, col: number): string => {
      if (this.editing && this.editOverlay && this.editing.row === row && this.editing.col === col) {
        return this.editOverlay.value
      }
      if (
        this.fxInput &&
        document.activeElement === this.fxInput &&
        active &&
        active.row === row &&
        active.col === col
      ) {
        return this.fxInput.value
      }
      return this.host.rows()[row]?.[col] ?? ''
    }
    const next = this.host.rows().map((r) => [...r])
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
    if (active && this.fxInput && document.activeElement === this.fxInput) {
      this.fxInput.value = next[active.row]?.[active.col] ?? ''
    }
    if (this.editing) this.teardownEdit()
    const anchor = this.host.selection().anchor ?? cells[0]!
    const cell = this.host.selection().active ?? cells[cells.length - 1]!
    this.host.commitRows(next, anchor, cell)
    this.host.grid()?.focus()
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
    const active = this.host.selection().active
    const row = target?.row ?? active?.row ?? 0
    const col = target?.col ?? active?.col ?? 0
    const value = target ? target.input.value : (this.host.rows()[row]?.[col] ?? '')
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
    const current = this.host.rows()[pending.row]?.[pending.col] ?? ''
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
    const next = this.host.rows().map((r) => [...r])
    next[pending.row]![pending.col] = raw
    this.host.commitRows(
      next,
      { row: pending.row, col: pending.col },
      { row: pending.row, col: pending.col },
    )
    this.host.grid()?.focus()
    return true
  }

  /** The currently focused cell text editor (in-cell overlay or fx bar), if
   * any, with its cell coordinates. */
  private linkEditTarget(): { input: HTMLInputElement; row: number; col: number } | null {
    if (this.editing && this.editOverlay) {
      return { input: this.editOverlay, row: this.editing.row, col: this.editing.col }
    }
    const active = this.host.selection().active
    if (this.fxInput && document.activeElement === this.fxInput && active) {
      return { input: this.fxInput, row: active.row, col: active.col }
    }
    return null
  }

  /**
   * The fx bar and the in-cell editor share one suggestion slot. A `=` draft is
   * a formula, so the formula list owns it; a `:name` token is emoji, so the
   * emoji card takes over; otherwise both close. `emojiTokenAt` already refuses
   * formula drafts and cell-range references, so the two never both want it.
   */
  private refreshAutocomplete(input: HTMLInputElement): void {
    const caret = input.selectionStart ?? input.value.length
    const token = emojiTokenAt(input.value.slice(0, caret), caret)
    if (token) {
      this.autocomplete.close()
      this.emojiAutocomplete.refresh(input)
    } else {
      this.emojiAutocomplete.close()
      this.autocomplete.refresh(input)
    }
  }

  /** The input currently holding a formula being edited, if any: the inline
   * edit overlay, or the fx bar input while it is focused. */
  formulaPointInput(): { input: HTMLInputElement } | null {
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

  /** While a formula editor is live, grid cells act as pick targets. */
  updatePointCursor(): void {
    this.host.grid()?.classList.toggle('ss-pointing', this.formulaPointInput() !== null)
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
  startPointInsert(input: HTMLInputElement, row: number, col: number, withDrag = true): void {
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
    this.emojiAutocomplete.close()
    if (input === this.editOverlay) this.fitEditColumn(input)
    this.pointInsert = { input, start, end: caret, snapshot: input.value }
    this.mirrorToFx(input)
    if (!withDrag) {
      this.pointRange = { r1: row, c1: col, r2: row, c2: col }
      this.host.renderSelection()
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
    this.host.renderSelection()
    document.addEventListener('mousemove', drag.move)
    document.addEventListener('mouseup', drag.up)
  }

  private updatePointRange(drag: PointDrag, moveEvent: MouseEvent): void {
    if (this.pointDrag !== drag) return
    const hover = this.host.resolveTarget(moveEvent.target)
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
    this.emojiAutocomplete.close()
    if (drag.input === this.editOverlay) this.fitEditColumn(drag.input)
    this.pointInsert = {
      input: drag.input,
      start: drag.replaceStart,
      end: drag.replaceEnd,
      snapshot: drag.input.value,
    }
    this.mirrorToFx(drag.input)
    this.pointRange = { r1, c1, r2, c2 }
    this.host.renderSelection()
  }

  private endPointDrag(drag: PointDrag): void {
    if (this.pointDrag !== drag) return
    document.removeEventListener('mousemove', drag.move)
    document.removeEventListener('mouseup', drag.up)
    this.pointDrag = null
    drag.input.focus()
  }

  /** Commit whichever editor is open (inline overlay or fx bar). */
  commitPointEdit(): void {
    if (this.editing) this.commitCellEdit()
    else this.commitFxEdit()
  }

  private startCellEdit(row: number, col: number, replaceText?: string): void {
    if (this.editOverlay) this.commitCellEdit()
    const cell = this.host.cellEl(row, col)
    if (!cell) return
    this.editing = { row, col }
    const input = document.createElement('input')
    input.className = 'ss-edit-input'
    input.type = 'text'
    input.spellcheck = false
    input.value =
      replaceText !== undefined ? replaceText : (this.host.rows()[row]?.[col] ?? '')
    input.addEventListener('keydown', (event) => this.onEditKeydown(event))
    input.addEventListener('blur', () => {
      if (this.editOverlay === input) this.commitCellEdit()
    })
    input.addEventListener('input', () => {
      this.fitEditColumn(input)
      this.mirrorToFx(input)
      this.updatePointCursor()
      this.refreshAutocomplete(input)
    })
    cell.appendChild(input)
    this.editOverlay = input
    this.pointInsert = null
    this.mirrorToFx(input)
    this.updatePointCursor()
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    this.host.renderFillHandle()
  }

  startEditAt(row: number, col: number, replaceText?: string): void {
    this.startCellEdit(row, col, replaceText)
  }

  /** Mirror the in-cell edit into the fx bar, like Excel's formula bar. */
  private mirrorToFx(input: HTMLInputElement): void {
    if (this.fxInput && input === this.editOverlay) this.fxInput.value = input.value
  }

  /**
   * As the user types in an empty (or any) cell, widen its column to keep the
   * input usable without a manual resize. Only the live element width changes;
   * the next rebuild re-fits the column to the committed content.
   */
  private fitEditColumn(input: HTMLInputElement): void {
    if (!this.editing) return
    const colEl = this.host.colEls()[this.editing.col]
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
    this.host.dom.appendChild(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    return width
  }

  private onEditKeydown(event: KeyboardEvent): void {
    if (this.emojiAutocomplete.handleKeydown(event)) return
    if (this.autocomplete.handleKeydown(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      this.commitCellEdit()
      const active = this.host.selection().active
      if (active) this.host.moveInGrid(active.row + 1, active.col, false)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.cancelCellEdit()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      this.commitCellEdit()
      const active = this.host.selection().active
      if (active) this.host.moveInGrid(active.row, active.col + (event.shiftKey ? -1 : 1), true)
    }
  }

  commitCellEdit(): void {
    const input = this.editOverlay
    if (!input || !this.editing) return
    const { row, col } = this.editing
    this.teardownEdit()
    const raw = input.value
    if (raw !== (this.host.rows()[row]?.[col] ?? '')) {
      const next = this.host.rows().map((r) => [...r])
      next[row]![col] = raw
      this.host.commitRows(next, { row, col }, { row, col })
    } else {
      this.host.renderSelection()
    }
    this.host.grid()?.focus()
  }

  cancelCellEdit(): void {
    this.teardownEdit()
    this.host.renderSelection()
    this.host.grid()?.focus()
  }

  teardownEdit(): void {
    const overlay = this.editOverlay
    this.editOverlay = null
    this.editing = null
    overlay?.remove()
    this.autocomplete.close()
    this.emojiAutocomplete.close()
    this.clearPointRange()
  }

  /** Drop any in-flight reference pick and its `ss-point` highlight. */
  clearPointRange(): void {
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
    if (this.emojiAutocomplete.handleKeydown(event)) return
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
      this.host.grid()?.focus()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      this.commitFxEdit()
      const active = this.host.selection().active
      if (active) this.host.moveInGrid(active.row, active.col + (event.shiftKey ? -1 : 1), true)
      this.host.grid()?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      const active = this.host.selection().active
      if (active && this.fxInput) {
        this.fxInput.value = this.host.rows()[active.row]?.[active.col] ?? ''
      }
      this.clearPointRange()
      this.host.renderSelection()
      this.host.grid()?.focus()
    }
  }

  commitFxEdit(): void {
    const input = this.fxInput
    const active = this.host.selection().active
    if (!input || !active) return
    const { row, col } = active
    const raw = input.value
    this.clearPointRange()
    if (raw !== (this.host.rows()[row]?.[col] ?? '')) {
      const next = this.host.rows().map((r) => [...r])
      next[row]![col] = raw
      this.host.commitRows(next, { row, col }, { row, col })
    } else {
      this.host.renderSelection()
    }
  }

  closeSuggestions(): void {
    this.autocomplete.close()
    this.emojiAutocomplete.close()
  }
}
