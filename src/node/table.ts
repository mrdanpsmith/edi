import { NodeSelection, Plugin, TextSelection } from 'prosemirror-state'
import type { Node as ProseNode } from 'prosemirror-model'
import type { NodeView, EditorView } from 'prosemirror-view'
import { tableToPipes } from '../spreadsheet-util'
import { blockNodeView, showsSource } from '../blockview'
import {
  BLOCK_MODE_HANDLERS,
  setBlockForm,
  setBlockModeAt,
} from '../block-modes'
import { TABLE_TYPE, tableFormOf } from './tableShared'
export { tableFormOf, TABLE_TYPE } from './tableShared'
import { TablePlainView } from './tablePlain'
import { ContextMenuEntry } from '../contextmenu'
import { TableNodeView, spreadsheetViews } from './tableSheet'


/**
 * Link a cell's raw text: ``[text](url)`` (keeping a link's inner text when it
 * is already a link). With no URL, unlink instead.
 */
function focusSpreadsheetGrid(view: EditorView): void {
  requestAnimationFrame(() => {
    const grid = view.dom.querySelector<HTMLElement>('.ss-grid')
    grid?.focus()
  })
}

/** Open the table at `pos` as a sheet: take the record, deselect, focus the grid. */
export function enterSpreadsheetMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== TABLE_TYPE) return
  const tr = view.state.tr
  setBlockModeAt(view.state, tr, pos, { form: 'sheet' })
  const sel = tr.selection as NodeSelection | null
  if (sel && sel.node && sel.node.type.name === TABLE_TYPE) {
    tr.setSelection(TextSelection.create(tr.doc, pos))
  }
  view.dispatch(tr)
  focusSpreadsheetGrid(view)
}

export function enterPlainMode(view: EditorView, pos: number | undefined): void {
  if (pos === undefined) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== TABLE_TYPE) return
  setBlockForm(view, pos, 'text')
  const tr = view.state.tr
  tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize))
  view.dispatch(tr)
}

/**
 * Right-click menu entries for spreadsheet editing, or null when the target
 * isn't a live spreadsheet block (a plain/read-only table view, a
 * stand-in element, or anything outside a table). The app-level menu keeps
 * ownership of that menu so the block actions stay appendable below these; this
 * only supplies the grid's own editing commands.
 */
export function spreadsheetMenuEntries(target: EventTarget | null): ContextMenuEntry[] | null {
  if (!(target instanceof Element)) return null
  const block = target.closest<HTMLElement>('.spreadsheet')
  const view = block ? spreadsheetViews.get(block) : undefined
  return view ? view.buildCellMenuEntries() : null
}

/**
 * Select every cell of the live sheet containing `target`, keeping the grid's focus.
 * False when `target` is not inside one, so the caller can fall back to the document.
 */
export function selectAllInSpreadsheet(target: Element | null): boolean {
  const block = target?.closest<HTMLElement>('.spreadsheet')
  const view = block ? spreadsheetViews.get(block) : undefined
  if (!view) return false
  view.selectAllCells()
  return true
}

/**
 * A table is the one block whose Alt+click toggles its *form* rather than its
 * interaction axis, because a sheet is live whenever it is open and has no
 * state to finish. Registered rather than imported into `block-modes.ts`, which
 * cannot import this file.
 */
/**
 * A table is the one block whose form is a *live* surface: the grid takes the
 * caret and typing edits cells, so a sheet has to deselect the table and focus
 * the grid. That is what `entered` is for — the record write belongs to
 * `setBlockForm` and must not be repeated here (see `BlockModeHandlers.forms`).
 */
BLOCK_MODE_HANDLERS[TABLE_TYPE] = {
  forms: {
    entered: (view, pos, form) => {
      if (form !== 'sheet') return
      const tr = view.state.tr
      const sel = tr.selection
      if (sel instanceof NodeSelection && sel.node.type.name === TABLE_TYPE) {
        tr.setSelection(TextSelection.create(tr.doc, pos))
        view.dispatch(tr)
      }
      focusSpreadsheetGrid(view)
    },
  },
}

export const tableNodeViewPlugin = new Plugin({
  props: {
    nodeViews: {
      [TABLE_TYPE]: (node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
        // Which form is the record's business, like the representation: a table
        // is either text or a sheet because the one record says so, and a table
        // in plain text says nothing at all because that is its rendering.
        if (showsSource(view, getPos())) return blockNodeView(node, view, getPos) as NodeView
        if (tableFormOf(view.state, getPos()) === 'text') return new TablePlainView(node, view, getPos)
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
  setBlockModeAt(view.state, tr, tablePos, { form: 'sheet' })
  // The grid is live wherever the caret is, so a NodeSelection left on the table
  // would let the next keystroke replace the whole block. Deselect it in the same
  // transaction, so one undo takes the whole insert away and nothing else.
  if (tr.selection instanceof NodeSelection && tr.selection.node.type.name === TABLE_TYPE) {
    tr.setSelection(TextSelection.create(tr.doc, tablePos))
  }
  view.dispatch(tr)
  focusSpreadsheetGrid(view)
  return true
}