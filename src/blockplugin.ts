import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { DecorationSet } from 'prosemirror-view'
import { DecorationSet as DecoSet } from 'prosemirror-view'

export interface BlockPluginState {
  sourceBlockPos: number | null
}

export const BLOCK_PLUGIN_KEY = new PluginKey<BlockPluginState>('EDI_BLOCK_PLUGIN')

export const blockPlugin = new Plugin<BlockPluginState>({
  key: BLOCK_PLUGIN_KEY,
  state: {
    init(): BlockPluginState {
      return { sourceBlockPos: null }
    },
    apply(tr: Transaction, prev: BlockPluginState): BlockPluginState {
      const meta = tr.getMeta(BLOCK_PLUGIN_KEY)
      if (meta !== undefined) return meta
      if (prev.sourceBlockPos !== null && tr.docChanged) {
        if (prev.sourceBlockPos >= tr.doc.content.size) {
          return { sourceBlockPos: null }
        }
      }
      return prev
    },
  },
  props: {
    decorations(): DecorationSet {
      return DecoSet.empty
    },
  },
})

export function getSourceBlockState(state: EditorState): BlockPluginState {
  return BLOCK_PLUGIN_KEY.getState(state) ?? { sourceBlockPos: null }
}

function findBlockAtPos(doc: import('prosemirror-model').Node, pos: number): { offset: number; node: import('prosemirror-model').Node } | null {
  let result: { offset: number; node: import('prosemirror-model').Node } | null = null
  doc.forEach((node, offset) => {
    if (result) return
    if (pos >= offset && pos < offset + node.nodeSize) {
      result = { offset, node }
    }
  })
  return result
}

function setBlockAttr(tr: Transaction, pos: number, attr: string, value: unknown): void {
  const found = findBlockAtPos(tr.doc, pos)
  if (!found) return
  const attrs: Record<string, unknown> = { ...found.node.attrs, [attr]: value }
  const replacement = found.node.type.create(attrs, found.node.content, found.node.marks)
  tr.replaceWith(found.offset, found.offset + found.node.nodeSize, replacement)
}

function clearBlockAttr(tr: Transaction, pos: number, attr: string): void {
  const found = findBlockAtPos(tr.doc, pos)
  if (!found) return
  if (found.node.attrs[attr] === undefined) return
  const attrs: Record<string, unknown> = { ...found.node.attrs }
  delete attrs[attr]
  const replacement = found.node.type.create(attrs, found.node.content, found.node.marks)
  tr.replaceWith(found.offset, found.offset + found.node.nodeSize, replacement)
}

/**
 * Set a caret (collapsed text selection) near `pos`, preferring `pos` itself.
 * `replaceWith`/`delete` behind the block attrs remap a caret that sat inside
 * the replaced node onto the node's *end*; when that endpoint does not point
 * into inline content, `TextSelection.map` snaps forward via `Selection.near`
 * and lands on the next selectable node — e.g. a table directly below, which
 * then lights up as a bogus NodeSelection. Restoring an explicit caret keeps
 * source-mode enter/exit from hijacking the selection of the following block.
 */
export function placeCaretInText(tr: Transaction, pos: number, fromBound: number, toBound: number): void {
  const size = tr.doc.content.size
  const clamp = (p: number): number => Math.min(Math.max(p, 0), size)
  const tryPos = (p: number): boolean => {
    const $p = tr.doc.resolve(clamp(p))
    if ($p.parent.inlineContent) {
      tr.setSelection(TextSelection.create(tr.doc, clamp(p)))
      return true
    }
    return false
  }
  if (tryPos(pos)) return
  for (let p = Math.min(pos - 1, size); p >= Math.max(fromBound, 1); p--) {
    if (tryPos(p)) return
  }
  for (let p = pos + 1; p <= Math.min(toBound, size); p++) {
    if (tryPos(p)) return
  }
}

function sourceCaret(state: EditorState, tr: Transaction, blockPos: number): number {
  const node = tr.doc.nodeAt(blockPos)
  const end = blockPos + (node?.nodeSize ?? 0)
  const caret = state.selection.from
  return caret > blockPos && caret < end ? caret : blockPos + 1
}

export function enterSourceMode(state: EditorState, blockPos: number): Transaction {
  const tr = state.tr
  tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: blockPos })
  setBlockAttr(tr, blockPos, '_source', true)
  const end = blockPos + (tr.doc.nodeAt(blockPos)?.nodeSize ?? 0)
  placeCaretInText(tr, sourceCaret(state, tr, blockPos), blockPos + 1, end)
  return tr
}

export function exitSourceMode(state: EditorState): Transaction {
  const current = getSourceBlockState(state)
  if (current.sourceBlockPos === null) {
    return state.tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: null })
  }
  const tr = state.tr
  clearBlockAttr(tr, current.sourceBlockPos, '_source')
  const end = current.sourceBlockPos + (tr.doc.nodeAt(current.sourceBlockPos)?.nodeSize ?? 0)
  placeCaretInText(tr, end - 1, current.sourceBlockPos + 1, end)
  tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: null })
  return tr
}

export function toggleSourceMode(state: EditorState, blockPos: number): Transaction {
  const current = getSourceBlockState(state)
  if (current.sourceBlockPos === blockPos) {
    return exitSourceMode(state)
  }
  if (current.sourceBlockPos !== null) {
    const tr = state.tr
    clearBlockAttr(tr, current.sourceBlockPos, '_source')
    setBlockAttr(tr, blockPos, '_source', true)
    tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: blockPos })
    const end = blockPos + (tr.doc.nodeAt(blockPos)?.nodeSize ?? 0)
    placeCaretInText(tr, blockPos + 1, blockPos + 1, end)
    return tr
  }
  return enterSourceMode(state, blockPos)
}
