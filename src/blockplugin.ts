import { Plugin, PluginKey } from 'prosemirror-state'
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

export function enterSourceMode(state: EditorState, blockPos: number): Transaction {
  const tr = state.tr
  tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: blockPos })
  setBlockAttr(tr, blockPos, '_source', true)
  return tr
}

export function exitSourceMode(state: EditorState): Transaction {
  const current = getSourceBlockState(state)
  if (current.sourceBlockPos === null) {
    return state.tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: null })
  }
  const tr = state.tr
  clearBlockAttr(tr, current.sourceBlockPos, '_source')
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
    return tr
  }
  return enterSourceMode(state, blockPos)
}
