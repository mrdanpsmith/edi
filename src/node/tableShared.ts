import { type EditorState } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { blockFormMode, blockModeFor, setBlockForm } from '../block-modes'
import { listMaskedTokens, DELIMITER_CELL } from '../spreadsheet-util'
import { formulaParts, SPREADSHEET_PREFIX, type CellSolution } from '../spreadsheet'
import { getSearchState, searchMatchesInText } from '../search'
import {
  setActiveCellHost,
} from '../inline-format'
import { bindCellMaskedField } from './masked'


export interface CellRef {
  row: number
  col: number
}

export interface FillRect {
  sr1: number
  sc1: number
  sr2: number
  sc2: number
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface PointDrag {
  input: HTMLInputElement
  start: CellRef
  replaceStart: number
  replaceEnd: number
  move: (event: MouseEvent) => void
  up: () => void
}

/** The reference token most recently inserted by a point-mode pick, so a
 * follow-up pick replaces it instead of appending (`=A1` → `=B1`). */
export interface PointInsert {
  input: HTMLInputElement
  start: number
  end: number
  snapshot: string
}

export const cellKey = (row: number, col: number): string => `${row}:${col}`

/** Live spreadsheet node views, keyed by their `.spreadsheet` block element.
 *  The app-level right-click menu reaches the grid's (otherwise private)
 *  editing commands through this, so it needs the node view behind a
 *  right-clicked cell; a weak map keeps it free of teardown bookkeeping. */


export const MIN_COL_WIDTH = 48
export const MAX_COL_WIDTH = 480
export const COL_PAD = 22
export const ROW_GUTTER_WIDTH = 30
export const EDIT_INPUT_PAD = 20
/** How far (px) from a row/column boundary in the spreadsheet chrome the
 * pointer must be for the insert guide to appear. */
export const INSERT_EDGE = 6
/** Half-width (px) of the forgiving corridor that keeps a shown guide alive
 * while the pointer travels from the chrome to its floating button. */
export const INSERT_CORRIDOR = 14

/** Tooltip for a table cell: the raw content, with a formula error's hint
 * appended so hovering an error explains it without leaving the table. A
 * formula's outer format marks (`**=SUM(A1:A3)**`) are dropped from the
 * tooltip — the formula text is what matters. */
export function cellTitle(raw: string, cellSol: CellSolution | undefined): string {
  if (!raw) return ''
  const parts = formulaParts(raw)
  const base = parts ? `${SPREADSHEET_PREFIX}${parts.body}` : raw
  return cellSol?.hint ? `${base} — ${cellSol.hint}` : base
}

/**
 * The form a table at `pos` is drawn in, read from the one record.
 *
 * A form is a **third piece of the record**, beside the representation and the
 * interaction axis, and that is a reversal of §4.3's original reasoning — that a
 * form is per-block and non-exclusive, so no single record could hold it. That
 * described the behaviour at the time rather than a constraint, and the app's
 * rule is now that at most one block in the whole page is in a non-visual state.
 * Keeping the form in the document could not express that: two tables could both
 * be sheets, a sheet could be open while a diagram was being edited, and the
 * switch was a `setNodeMarkup` that dirtied the user's file for what is a view
 * preference.
 *
 * **A table in plain text holds no record at all** — plain text is a table's
 * rendering, not a mode — which is what still lets a document contain any number
 * of tables. Only the sheet takes the record, and only while it is being viewed;
 * a table that entered its source form as a sheet keeps the value there and comes
 * back as a sheet.
 */
export function tableFormOf(state: EditorState, pos: number | undefined): string {
  return tableFormAt(state, pos) ?? 'text'
}

/**
 * The form the table at `pos` is in, or null when there is no table there to ask.
 *
 * The three answers are load-bearing for `update()`. A node view decides whether
 * it has been rebuilt by comparing the form it was built for with the form the
 * block is in now, and reading an unknown position as "text" turns *every* update
 * into a rebuild for a node view built for a sheet — which is a grid that
 * replaces itself under the caret on every keystroke and never keeps focus.
 * Null is the "do not rebuild" answer, and it is only ever null when there is no
 * block there, which is exactly when there is nothing to redraw.
 */
export function tableFormAt(state: EditorState, pos: number | undefined): string | null {
  if (pos === undefined) return null
  const node = state.doc.nodeAt(pos)
  if (node === null || node.type.name !== TABLE_TYPE) return null
  return blockFormMode(state, pos) ?? 'text'
}

/**
 * The block's **Edit** / **Visual** control — the table's edit mode, in the app's
 * own vocabulary (§5.1) — labelled from the descriptor's form list so the cluster
 * and the context menu can never drift into two spellings of the same two words.
 * The button names the step it *goes to*, as every cluster control does.
 */
export function formControl(
  view: EditorView,
  getPos: () => number | undefined,
  node: ProseNode,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'block-control block-control-form'
  const other = (form: string): string =>
    blockModeFor(node).forms?.find((entry) => entry.id !== form)?.label ?? 'Change form'
  const paint = (): void => {
    const at = getPos()
    const current = tableFormOf(view.state, at)
    button.textContent = other(current)
    button.title = current === 'sheet'
      ? 'Draw this table as its markdown again'
      : 'Edit this table in a spreadsheet'
  }
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const at = getPos()
    if (at === undefined) return
    // Read at press time, like every other control: the node captured when the
    // cluster was built is a snapshot, and the form is plugin state.
    setBlockForm(view, at, tableFormOf(view.state, at) === 'sheet' ? 'text' : 'sheet')
  })
  paint()
  return button
}


export function setLink(text: string, url?: string): string {
  if (url) {
    const link = /^\[([^\]]*)\]\([^)]*\)$/.exec(text)
    return link ? `[${link[1]}](${url})` : `[${text}](${url})`
  }
  return text.replace(/^\[(.+)\]\([^)]*\)$/, '$1')
}

/** A cell's live link context captured before the URL dialog steals focus. */
export interface PendingCellLink {
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
export function linkSpans(
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
export function linkHrefIn(value: string, start: number, end: number): string {
  for (const span of linkSpans(value)) {
    if (start >= span.from && end <= span.to) return span.href
  }
  return ''
}

/** The href of a cell that is exactly one link, for prefilling the dialog. */
export function wholeCellLinkHref(value: string): string {
  const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(value.trim())
  return link ? (link[2] ?? '') : ''
}

export const inlineFocusListenersAttached: { value: boolean } = { value: false }

/**
 * One per-document `focusout` watcher keeps the toolbar's active-cell host in
 * sync: it is cleared whenever focus leaves to something that is neither a
 * spreadsheet nor the toolbar, so a click on Bold/Italic/etc. still
 * finds the cell it was aimed at.
 */
export function ensureInlineFocusListeners(): void {
  if (inlineFocusListenersAttached.value) return
  inlineFocusListenersAttached.value = true
  document.addEventListener('focusout', (event) => {
    const next =
      event.relatedTarget instanceof Element
        ? event.relatedTarget
        : (document.activeElement as HTMLElement | null)
    if (next && next.closest('.spreadsheet, .toolbar-btn, .toolbar-menu-host, .toolbar-popover, .toolbar-select')) return
    setActiveCellHost(null)
  })
}

/** Raw `attrs.value`-offset span of each grid cell. Mirrors `tableToPipes`'s
 * normalized layout so a search block match's `from`/`to` (indexed against the
 * value string) maps exactly onto the rendered cell that contains it; blank
 * lines and the GFM delimiter row are skipped, as in `parsePipes`. */
export interface CellSpan {
  row: number
  col: number
  from: number
  to: number
}

export function cellSpansInValue(value: string): CellSpan[] {
  const spans: CellSpan[] = []
  let row = 0
  let offset = 0
  for (const rawLine of value.split('\n')) {
    const lineStart = offset
    offset += rawLine.length + 1
    if (rawLine.trim() === '') continue
    const line = rawLine.startsWith('|') ? rawLine.slice(1) : rawLine.trim()
    const tokens: { text: string; from: number; to: number }[] = []
    let buf = ''
    let bufStart = 0
    let prev = ''
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (ch === '|' && prev !== '\\') {
        tokens.push({ text: buf, from: bufStart, to: i })
        buf = ''
        bufStart = i + 1
      } else {
        buf += ch
      }
      prev = ch
    }
    tokens.push({ text: buf, from: bufStart, to: line.length })
    // parsePipes equivalent: a trailing `|` produces a phantom empty token, so
    // drop it before the delimiter-row check or a GFM `|--- | --- |` row reads
    // as ordinary data (the phantom's empty string fails `DELIMITER_CELL`).
    const cells =
      tokens.length > 0 && tokens[tokens.length - 1]!.from === tokens[tokens.length - 1]!.to
        ? tokens.slice(0, -1)
        : tokens
    if (cells.length > 0 && cells.every((token) => DELIMITER_CELL.test(token.text.trim()))) {
      continue
    }
    cells.forEach((token, col) => {
      if (token.from === token.to) return
      spans.push({ row, col, from: lineStart + 1 + token.from, to: lineStart + 1 + token.to })
    })
    row++
  }
  return spans
}

/** Highlight every occurrence of the active search query inside a rendered
 * table cell by wrapping matched text nodes in `<span>`s carrying the same
 * `edi-search-match` classes the editor uses. `currentText` names the active
 * match's raw value slice: when the run of text it sits in is reproduced in
 * the cell, that segment (else the cell's first) is marked current. */
export function applyCellSearchHighlights(view: EditorView, container: Element, currentText: string | null): void {
  const search = getSearchState(view)
  const query = search?.query ?? ''
  if (query === '') return
  const text = container.textContent ?? ''
  const ranges = searchMatchesInText(query, search.flags, text)
  if (ranges.length === 0) return

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const entries: { node: Text; start: number; end: number }[] = []
  let offset = 0
  let textNode: Text | null
  while ((textNode = walker.nextNode() as Text | null)) {
    const start = offset
    const length = (textNode.nodeValue ?? '').length
    entries.push({ node: textNode, start, end: start + length })
    offset += length
  }

  let rangeIndex = 0
  let cellFirstRange: { from: number; to: number; current: boolean } | null = null
  for (const entry of entries) {
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.to <= entry.start) rangeIndex++
    const local: { from: number; to: number; current: boolean }[] = []
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.from < entry.end) {
      const range = ranges[rangeIndex]!
      const from = Math.max(range.from, entry.start) - entry.start
      const to = Math.min(range.to, entry.end) - entry.start
      if (from < to) {
        const localRange = { from, to, current: false }
        local.push(localRange)
        if (cellFirstRange === null) cellFirstRange = localRange
      }
      rangeIndex++
    }
    if (local.length === 0) continue
    if (currentText !== null) {
      // Find the segment that reproduced the active match's raw slice; the
      // active match only lands in the cell whose text matches it exactly, and
      // consuming the marker here stops a second cell claiming it.
      for (const range of local) {
        const absoluteFrom = entry.start + range.from
        const absoluteTo = entry.start + range.to
        if (text.slice(absoluteFrom, absoluteTo) === currentText) {
          range.current = true
          currentText = null
          break
        }
      }
    }
    wrapTextNodeRanges(entry.node, local)
  }
  // The active match may not survive into the displayed text verbatim (solved
  // formula cells); drop the emphasis on the cell's first match so the cursor
  // still lands on something visible in the right cell.
  if (currentText !== null && cellFirstRange !== null) cellFirstRange.current = true
}

/** Resolve the active search match to the rendered table cell that contains
 * it, if this node view is the table the cursor is sitting on. `span` locates
 * the cell by raw value offsets; `text` is the active match's raw slice.
 * Returns null when the active match is a doc match, another block, or none. */
export function searchActiveCell(
  view: EditorView,
  node: ProseNode,
  getPos: () => number | undefined,
): { span: CellSpan | null; text: string | null } | null {
  const search = getSearchState(view)
  if (!search || search.current < 0) return null
  const match = search.matches[search.current]
  if (!match || match.kind !== 'block') return null
  const pos = getPos()
  if (pos === undefined || match.pos !== pos) return null
  const value = String(node.attrs.value ?? '')
  const span =
    cellSpansInValue(value).find((s) => match.from < s.to && match.to > s.from) ?? null
  return { span, text: value.slice(match.from, match.to) }
}

export function highlightTableCell(
  view: EditorView,
  td: HTMLElement,
  row: number,
  col: number,
  active: ReturnType<typeof searchActiveCell>,
): void {
  const currentText =
    active?.span && active.span.row === row && active.span.col === col ? active.text : null
  applyCellSearchHighlights(view, td, currentText)
}

export function wrapTextNodeRanges(node: Text, ranges: { from: number; to: number; current: boolean }[]): void {
  for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
    if (range.from >= range.to) continue
    const tail = node.splitText(range.to)
    const mid = node.splitText(range.from)
    const span = document.createElement('span')
    span.className = range.current ? 'edi-search-match-current' : 'edi-search-match'
    span.appendChild(mid)
    node.parentNode!.insertBefore(span, tail)
  }
}

// --- Plain (view) rendering ---------------------------------------------------

/**
 * Bind the masked-field pills inside one rendered cell. Shared by the
 * spreadsheet grid and the plain table view so both re-encrypt and commit
 * tokens the same way.
 */
export function bindMaskedPillsIn(
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
 * The class a Visual table puts on the **cells** a document selection covers.
 *
 * **On the cells, not on the block box.** A header row and a cell's padding are chrome,
 * not text, so the fill goes where the words are — the same place a reader expects it,
 * because it is exactly where the browser puts it for prose. An outline-and-tint round
 * the block would be the old look with extra steps, and would say "this table is an
 * object" about a block that is now text in a range.
 */
export const CELL_SELECTED_CLASS = 'ss-cell-in-selection'

/**
 * How far the pointer may travel between press and release and still be a **click**.
 *
 * The same value as the kanban drag's `DRAG_THRESHOLD`, for the same reason: below it the
 * gesture is a click, and above it the reader is dragging something — which for a Visual
 * table means the browser is making a text selection, and answering that would fight it.
 */
export const CLICK_SLOP = 4

/**
 * Every open plain-table view, told when the page's selection moved.
 *
 * `selectionchange` on the document, because **this painter reads the browser's range
 * and not ProseMirror's**. The model cannot express what it is painting: a table node
 * has no content at all — the whole grid lives in `attrs.value` — so a document
 * selection either covers the entire table or none of it, and "the first two rows and
 * not the third" is not a position ProseMirror can hold. The browser *does* hold it:
 * measured, a drag's DOM selection spans the cells it crosses and `toString()` returns
 * their text, even though Chromium refuses to paint any of it. So the range is read from
 * where it really lives.
 *
 * One listener for the page rather than one per view: the event fires for any selection
 * anywhere, and a view that is not in the range simply paints nothing.
 */
export const plainTableViews = new Set<() => void>()
export const selectionChangeWired: { value: boolean } = { value: false }

export function onNativeSelectionChange(listener: () => void): () => void {
  plainTableViews.add(listener)
  if (!selectionChangeWired.value) {
    selectionChangeWired.value = true
    document.addEventListener('selectionchange', () => {
      for (const notify of [...plainTableViews]) notify()
    })
  }
  return () => { plainTableViews.delete(listener) }
}

/**
 * View-mode rendering of a table: a plain markdown table (first row as a
 * header row) with no spreadsheet chrome — no column letters, row numbers,
 * tools row, fx bar, name box, or resize handles. Cell content keeps the
 * spreadsheet rendering (formulas solved, inline markdown, masked-field
 * pills). Enter spreadsheet mode with the ``Spreadsheet`` button or the
 * right-click menu.
 *
 * **It also paints the part of a document selection that falls inside it**, which is
 * a new invariant and the only one here nobody held before: Chromium will not paint a
 * selection inside a `contenteditable=false` host, so a range across this table shows
 * *nothing at all* inside it — measured, with the browser's own highlight suppressed to
 * be sure: the prose beside the table painted `#3367d1` and the cell stayed `#ffffff`,
 * while the DOM selection genuinely spanned the table. So the fill is ours to draw, and
 * it is drawn from `--selection`, the same token prose uses, so a range reading across
 * prose → table → prose reads as one continuous highlight rather than as a hole with a
 * frame round it.
 *
 * It cannot be a ProseMirror decoration. Without a `contentDOM` ProseMirror cannot put
 * anything inside the node view, which is the whole reason the block-level mark existed
 * — it puts a class on the block element and stops there. So this view reads the
 * selection itself and stays in step with it, which is what `onSelectionChange` is for:
 * a node view is only updated when its node or its decorations change, and an atom
 * carrying no decorations is therefore never asked again.
 */

export const TABLE_TYPE = 'table'
