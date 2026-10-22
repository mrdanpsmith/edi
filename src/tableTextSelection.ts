/**
 * What "selected" means inside a **Visual table**, the paint that shows it, and the copy
 * that follows it.
 *
 * **A Visual table is text, and the model cannot hold a selection inside it.** A `table`
 * node is `atom: true` with no content — the whole grid lives in `attrs.value` — so
 * "three characters of that cell" is not a pair of positions that exist. The *browser's*
 * range can hold it, and does. Measured in the real engine, with the app's own fill taken
 * off first so the two mechanisms cannot be confused:
 *
 * | the range… | `Selection.toString()` | `getClientRects()` | painted by Chromium |
 * |---|---|---|---|
 * | inside one cell | that fragment | one rect | **no** |
 * | one cell → the next | the cells | one rect per cell | **no** |
 * | table 1 → table 2, adjacent | **table 1 only** | rects in both | **no** |
 * | prose → prose, bracketing | everything | rects everywhere | prose only |
 *
 * Four facts, and each one decides something here:
 *
 * 1. **The range is complete; the browser's *text* is clipped.** A range from inside one
 *    table to inside the next really does contain both — `cloneContents()` shows every
 *    cell of both and `intersectsNode` answers true for each — but `toString()` stops at
 *    the end of the first. So "copy out of two tables with nothing between them" is not a
 *    selection problem at all: it is a text-extraction one, and the answer is to read the
 *    range ({@link plainTableSelectionText}).
 * 2. **Chromium paints nothing inside the table**, by either mechanism — `::selection`
 *    and a `CSS.highlights` `::highlight()` on the same range were both measured leaving
 *    every cell `#ffffff`. That is §3.1's wall, and it holds in *every* direction, not
 *    only for a range that brackets the table. So the highlight is ours to draw:
 *    {@link paintPlainTableSelection}, an overlay of the range's own client rects.
 * 3. **A range that brackets the table** (`Ctrl+A`, prose → prose across it) is the case
 *    the cell fill already answered, and it keeps answering it: no end inside a cell
 *    means no overlay, so `TablePlainView` fills the cells and the range reads as one
 *    continuous highlight rather than as a hole.
 * 4. **The paint has to be clipped to the grid.** A range walking in from prose passes
 *    over the block's own controls on its way, and `Edit` / `Source` are not what the
 *    reader selected — so the overlay is clipped to the `<table>`, and the copied text
 *    skips the chrome outright.
 *
 * **And ProseMirror takes the selection away again**, which is why this module remembers
 * it rather than reading it on demand. A range that crosses *between two tables* is
 * mapped by ProseMirror to block boundaries — a range in the gap — and written back into
 * the DOM, erasing what the reader dragged; a range inside one table survives, because a
 * node view's `ignoreMutation` covers it. Measured: the cross-table case survives when the
 * editor's own selection is empty and is erased when it is not, so the behaviour depends
 * on what the reader happened to have selected before — five orders measured, in the real
 * engine. Nothing an event listener can do stops it, either: `stopImmediatePropagation` on
 * `selectionchange` does not, because the rewrite is done by a flush **timer** an earlier
 * event scheduled.
 *
 * None of that costs the reader anything, because **nothing paints the browser's
 * selection inside a table anyway** (fact 2) — so the app remembers the selection itself,
 * in a snapshot, and everything above reads that. {@link rememberSelection} is the whole
 * of the mechanism; what ends it is listed there.
 */

/** A Visual table's cells, and nothing else — the sheet is a grid with its own. */
const PLAIN_CELL = '.ss-plain th, .ss-plain td'

/**
 * The chrome every block carries, which a selection sweeping through the table walks
 * over on its way to the cells and which is therefore *not* part of what the reader
 * selected. `Edit` / `Source` are the plain table's own controls.
 */
const CHROME = '.block-controls'

/** The overlay one cell's share of the highlight is drawn into. */
const LAYER_CLASS = 'ss-plain-selection'

export interface PlainTableSelection {
  /** The browser's own range — what the reader dragged. */
  range: Range
  /** The innermost Visual table an end of the range is in. */
  table: Element
}

/**
 * The last selection the reader made inside a Visual table's cells, kept because
 * ProseMirror erases it (the header table above).
 *
 * **The two ends, not a range**: a `Range` holds live DOM node references into the
 * document's own nodes, which is all this needs — the table re-renders its cells and a
 * stored `Range` would then point at detached text, while two `{node, offset}` pairs are
 * checked against the document on every read and dropped when they no longer belong to it.
 */
interface SelectionEnd {
  node: Node
  offset: number
}

const remembered: { value: { anchor: SelectionEnd; focus: SelectionEnd } | null } = { value: null }

/**
 * The selection to answer questions about: the live one when it is inside a table, and
 * otherwise the last one that was.
 *
 * **Why the fallback is not a stale reading of the reader's mind**: it is dropped by the
 * three things that mean the reader has moved on — a pointer press, a key, and any change
 * to the document — none of which ProseMirror's rewrite is. A click elsewhere collapses
 * the DOM selection and this answers "nothing is selected", which is right; the rewrite
 * collapses it too, and this still answers with what was selected, which is also right
 * because the reader did not do anything.
 */
function selected(): PlainTableSelection | null {
  const live = liveSelectionInPlainTable()
  if (live !== null) return live
  if (remembered.value === null) return null
  if (!remembered.value!.anchor.node.isConnected || !remembered.value!.focus.node.isConnected) {
    remembered.value = null
    return null
  }
  const range = document.createRange()
  try {
    range.setStart(remembered.value!.anchor.node, remembered.value!.anchor.offset)
    range.setEnd(remembered.value!.focus.node, remembered.value!.focus.offset)
  } catch {
    remembered.value = null
    return null
  }
  const table = tableOf(remembered.value!.anchor.node) ?? tableOf(remembered.value!.focus.node)
  if (table === null) {
    remembered.value = null
    return null
  }
  return { range, table }
}

/**
 * The live selection, **when one of its ends is inside a Visual table's cells**.
 *
 * "An end" rather than "the anchor", because the browser's own painting is asymmetric
 * (§3.7) and so is the reader's intention: a range dragged out of prose into a table has
 * its anchor in prose and its focus in a cell, and it is the cell end that makes this a
 * table selection at all. A range that *brackets* a table has neither end in one, and is
 * not one — that is the `Ctrl+A` case, where the cell fill is right and the overlay has
 * nothing to draw.
 */
export function liveSelectionInPlainTable(): PlainTableSelection | null {
  const selection = typeof document.getSelection === 'function' ? document.getSelection() : null
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const table = tableOf(selection.anchorNode) ?? tableOf(selection.focusNode)
  if (!table) return null
  return { range: selection.getRangeAt(0), table }
}

/** The innermost Visual table `node` is in a cell of, or null. */
function tableOf(node: Node | null): Element | null {
  if (!node) return null
  const element = node instanceof Element ? node : node.parentElement
  if (!element) return null
  const cell = element.closest(PLAIN_CELL)
  if (!cell) return null
  return cell.closest('.ss-plain')
}

/** Is the reader's selection inside a table right now — the question `editCut` asks. */
export function hasPlainTableSelection(): boolean {
  return selected() !== null
}

/**
 * Does the live selection have **an end inside `table`**, which is what hands this table's
 * paint to the overlay?
 *
 * The *live* selection, deliberately, and not {@link selected}: this is a question about
 * the range the reader is dragging, and a remembered one would keep a table highlighted
 * for a selection that has since been collapsed by the engine rather than by the reader.
 */
export function selectionEndsIn(table: Element): boolean {
  const selection = typeof document.getSelection === 'function' ? document.getSelection() : null
  if (!selection || selection.isCollapsed) return false
  return endsIn(selection.anchorNode, table) || endsIn(selection.focusNode, table)
}

function endsIn(node: Node | null, table: Element): boolean {
  if (!node) return false
  const element = node instanceof Element ? node : node.parentElement
  if (element === null) return false
  return element.closest('.ss-plain') === table &&
    element.closest(PLAIN_CELL) !== null
}

/**
 * The text the live table selection stands for, or `null` when there is none.
 *
 * **Read from the range rather than from `Selection.toString()`, because that is the
 * clipped half of the table at the top of this file**: the browser's own text stops at
 * the end of the first table, so a reader selecting out of one table and into the next
 * would copy the first one twice and never the second. The range is complete — measured
 * — so the copy is taken from it.
 *
 * The shape is the one a normal editor produces, which is also the one the browser would
 * have produced for an *editable* table: **cells tab-separated, rows newline-separated**,
 * and block-level prose separated by a blank line. A selection spanning two tables with
 * nothing between them therefore reads as two grids with one newline between them, which
 * is what pasting it into anything gives back.
 */
export function plainTableSelectionText(): string | null {
  const selection = selected()
  if (selection === null) return null
  const text = rangeText(selection.range.cloneContents())
  return text.length > 0 ? text : null
}

/** Block-level elements a normal editor puts a blank line between. */
const PARAGRAPHISH = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION'])

/** Elements a normal editor puts a single newline between. */
const LINEISH = new Set(['LI', 'DT', 'DD', 'TR'])

/**
 * A range's text, the way a normal editor renders it.
 *
 * **`cloneContents()` and a walk, not `toString()`** — the whole of the copy route is
 * this function, and the reason is the clipping measured above. It is also why the
 * chrome is skipped here rather than at the call site: a range sweeping in from prose
 * crosses the block's own controls before it reaches a cell.
 */
export function rangeText(fragment: Node): string {
  const parts: string[] = []
  walk(fragment, parts)
  return tidy(parts.join(''))
}

function walk(node: Node, parts: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parts.push(node.nodeValue ?? '')
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    for (const child of Array.from(node.childNodes)) walk(child, parts)
    return
  }
  const element = node as Element
  if (element.matches(CHROME)) return
  const tag = element.tagName
  if (tag === 'BR') {
    parts.push('\n')
    return
  }
  if (tag === 'TD' || tag === 'TH') parts.push('\t')
  else if (PARAGRAPHISH.has(tag)) parts.push('\n\n')
  else if (LINEISH.has(tag)) parts.push('\n')
  for (const child of Array.from(element.childNodes)) walk(child, parts)
}

/**
 * Trim the ends, collapse the runs of blank lines the walk's separators make where a
 * range starts or stops mid-block, and **never begin a row with a cell separator**.
 *
 * The last one is what makes a grid come out shaped the way an editable table's own
 * selection text does — `one\ttwo\nthree\tfour`, not `one\ttwo\n\tthree\tfour` — and it
 * is also what lets two grids with nothing between them read as two grids rather than as
 * one ragged one.
 */
function tidy(text: string): string {
  return text
    .replace(/\n\t/g, '\n')
    .replace(/^[ \t\n]+/, '')
    .replace(/[ \t\n]+$/, '')
    .replace(/\n{3,}/g, '\n\n')
}

// ── The paint ────────────────────────────────────────────────────────────────

/**
 * Draw the selection's share of the highlight into every Visual table it runs through,
 * and clear the ones it does not.
 *
 * **One box per cell the range runs through, inside that cell, at the text's own
 * geometry.** Both halves of that are load-bearing:
 *
 * - **Inside the cell**, so the box paints *over the cell's own background and under its
 *   text* (`isolation: isolate` on the cell gives it the stacking context that ordering
 *   needs). A layer behind the whole table does not: a header row's background is opaque,
 *   so a box drawn behind it is invisible — measured, which is how the first version of
 *   this came to draw boxes nobody could see.
 * - **At the text's geometry**, because a cell fill can only say *this cell*, and saying
 *   it for three characters is the complaint this whole thing answers.
 *
 * Boxes are positioned relative to their own cell, so they need no re-placing when the
 * document scrolls or the table scrolls sideways.
 *
 * **Only cells the range actually runs through get one**, and the range is clipped to
 * each of them — which is also what keeps the block's own controls out of it: a range
 * walking in from prose crosses `.block-controls` on its way, and those are not cells.
 */
export function paintPlainTableSelection(): void {
  const selection = selected()
  for (const table of document.querySelectorAll('.ss-plain')) {
    clearCells(table)
    if (selection === null) continue
    for (const cell of table.querySelectorAll('th, td')) {
      if (!selection.range.intersectsNode(cell)) continue
      drawInCell(cell as HTMLElement, selection.range)
    }
  }
}

/** Take down every box this table is showing, before drawing the next set. */
function clearCells(table: Element): void {
  for (const box of table.querySelectorAll(`.${LAYER_CLASS}-rect`)) box.remove()
}

/** The boxes `table` is showing right now — what the paint is, read back for a gate. */
export function boxesIn(table: Element): Element[] {
  return [...table.querySelectorAll(`.${LAYER_CLASS}-rect`)]
}

function drawInCell(cell: HTMLElement, range: Range): void {
  const cellBox = cell.getBoundingClientRect()
  // **No layout, no boxes**: jsdom has no `getClientRects` at all, and the painter runs on
  // every selection change on the page, so it must not be able to throw. The paint itself
  // is gated in the real engine for the same reason the cell painter's is.
  if (typeof range.getClientRects !== 'function') return
  // **The cell's border, because the box is placed against the padding box.** An
  // absolutely positioned child is positioned from the inside of the border, so a box
  // meant to sit on the text lands a border's width out without this — a pixel on every
  // side of every cell, which is exactly the kind of thing a pixel gate catches.
  const style = getComputedStyle(cell)
  const borderLeft = parseFloat(style.borderLeftWidth) || 0
  const borderTop = parseFloat(style.borderTopWidth) || 0
  const rects = range.getClientRects()
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]
    if (!rect) continue
    const left = Math.max(rect.left, cellBox.left)
    const right = Math.min(rect.right, cellBox.right)
    const top = Math.max(rect.top, cellBox.top)
    const bottom = Math.min(rect.bottom, cellBox.bottom)
    if (right - left < 0.5 || bottom - top < 0.5) continue
    const box = document.createElement('div')
    box.className = `${LAYER_CLASS}-rect`
    box.style.left = `${left - cellBox.left - borderLeft}px`
    box.style.top = `${top - cellBox.top - borderTop}px`
    box.style.width = `${right - left}px`
    box.style.height = `${bottom - top}px`
    cell.appendChild(box)
  }
}

// ── Remembering it, because ProseMirror takes it away ───────────────────────

/**
 * Take note of the selection, paint it, and forget it when the reader has moved on.
 *
 * **One listener for the page**, wired at import, because the order of listeners on the
 * document is the only thing that decides whether this sees a selection change before
 * ProseMirror's rewrite of it — and it has to be ahead of it, since ProseMirror is
 * constructed with the first editor and this module is evaluated before that.
 *
 * **What ends a remembered selection**, and each entry is something the reader did:
 *
 * - **a pointer press** (captured, so it is heard before the control under it acts).
 * - **a key, *and then* the selection change that follows it.** The keydown only *marks*
 *   the moment (`readerActed`); forgetting happens on the selection change, which is what
 *   makes `Ctrl+C` work — the clipboard command reads the selection *during* the keydown,
 *   so a listener that forgot on the key itself would have thrown it away first. An arrow
 *   key's caret move arrives as the change, and is a change the reader asked for.
 * - **any change to the document** ({@link forgetPlainTableSelection}, called from the
 *   editor's own `dispatchTransaction`): typing, a paste or an undo moves the text the
 *   selection was over, and a remembered selection over moved text is nobody's.
 *
 * And one thing that is deliberately **not** on that list: a selection change to a
 * *collapsed* caret with no key in front of it. That is ProseMirror's rewrite — it
 * collapses the DOM selection without the reader having touched anything, and it is the
 * one event that must not throw the selection away.
 */
export function rememberSelection(): void {
  const live = liveSelectionInPlainTable()
  const domSelection = typeof document.getSelection === 'function' ? document.getSelection() : null
  if (live !== null && domSelection !== null &&
    domSelection.anchorNode !== null && domSelection.focusNode !== null) {
    remembered.value = {
      anchor: { node: domSelection.anchorNode, offset: domSelection.anchorOffset },
      focus: { node: domSelection.focusNode, offset: domSelection.focusOffset },
    }
  } else if (live === null && (readerActed.value || (domSelection !== null && !domSelection.isCollapsed))) {
    // A range the reader (or a `Ctrl+A`) put on the document, or a caret they moved.
    remembered.value = null
  }
  readerActed.value = false
  paintPlainTableSelection()
}

/** The reader has done something that ends the selection: stop answering with it. */
export function forgetPlainTableSelection(): void {
  remembered.value = null
  readerActed.value = false
}

/**
 * A key has gone down: mark the moment, and let the selection change that follows decide.
 *
 * See {@link rememberSelection} for why this is not `forgetPlainTableSelection` — the
 * copy command reads the selection between the keydown and the change.
 */
function onKeyDown(): void {
  readerActed.value = true
}

const readerActed: { value: boolean } = { value: false }

const wired: { value: boolean } = { value: false }

export function wirePlainTableSelection(): void {
  if (wired.value) return
  wired.value = true
  document.addEventListener('selectionchange', rememberSelection)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('mousedown', forgetPlainTableSelection, true)
}

wirePlainTableSelection()