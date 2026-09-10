import { InputRule, wrappingInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import { canJoin } from 'prosemirror-transform'
import { schema } from './schema'
import { BLOCK_PLUGIN_KEY } from './blockplugin'

const FENCE_RULE = /^```(\S+)?\s$/
const FENCE_MATCH = /^```(\S+)?$/
const BULLET_RULE = /^([-*+])\s([^\s[])$/u
const BULLET_MATCH = /^[-*+]\s?$/
const TASK_RULE = /^-\s\[[ xX]\]\s$/
const TASK_MATCH = /^-\s\[[ xX]\]$/
const ORDERED_RULE = /^(\d+)\.\s$/
const ORDERED_MATCH = /^(\d+)\.\s?$/
const BLOCKQUOTE_MATCH = /^>\s?$/

function headingRules(): InputRule[] {
  return Array.from({ length: 6 }, (_, i) => {
    const level = i + 1
    return new InputRule(new RegExp(`^${'#'.repeat(level)}\\s(.*)$`, 'm'), (state, match, start) => {
      const text = match[1]
      const { from, to } = blockRangeOf(state, start)
      const nodeType = state.schema.nodes.heading
      const content = text ? state.schema.text(text) : null
      const tr = state.tr.replaceWith(from, to, nodeType.create({ level }, content))
      tr.setSelection(TextSelection.create(tr.doc, from + 1 + (text?.length ?? 0)))
      return tr
    })
  })
}

const horizontalRule = (): InputRule =>
  new InputRule(/^---$/, (state, _match, start) => {
    const { from, to } = blockRangeOf(state, start)
    const tr = state.tr.replaceWith(from, to, state.schema.nodes.horizontal_rule.create())
    tr.setSelection(TextSelection.create(tr.doc, from + 1))
    return tr
  })

/**
 * Build the node a fence marker produces. `mermaid` yields an atom block that
 * opens in source mode; a `#!` info string becomes the shebang first line of a
 * runnable code block; anything else is a code block with that language.
 */
export function fenceNode(
  state: EditorState,
  info: string,
): { node: import('prosemirror-model').Node } | null {
  if (info === 'mermaid') {
    return { node: state.schema.nodes.mermaid_block.create({ value: '', _source: true }) }
  }
  if (info.startsWith('#!')) {
    return { node: state.schema.nodes.code_block.create(null, [state.schema.text(info)]) }
  }
  return { node: state.schema.nodes.code_block.create({ language: info }) }
}

// Newline-input rules target the text inside the marker's textblock. All the
// block-starting markers are the *entire* line when they fire (the regexes
// anchor to `^`), so the replacement span must be the block's range, not the
// inline text range, or the fence node would be nested inside a paragraph.
function blockRangeOf(state: EditorState, inside: number): { from: number; to: number } {
  const $start = state.doc.resolve(inside)
  const range = $start.blockRange()
  if (!range) return { from: inside, to: inside + 1 }
  return { from: range.start, to: range.end }
}

function insertFence(state: EditorState, blockFrom: number, blockTo: number, info: string): Transaction {
  const tr = state.tr
  const built = fenceNode(state, info)
  if (!built) return tr
  tr.replaceWith(blockFrom, blockTo, [built.node])

  if (info === 'mermaid') {
    // The inserted atom sits at (or, if the replace reshaped the doc, somewhere
    // inside) the doc. Marking it as the open source block focuses the editor
    // with the serialized fence, ready for a language + newline.
    let pos = tr.doc.nodeAt(blockFrom)?.type.name === 'mermaid_block' ? blockFrom : -1
    if (pos < 0) {
      tr.doc.forEach((node, offset) => {
        if (pos < 0 && node.type.name === 'mermaid_block') pos = offset
      })
    }
    if (pos >= 0) {
      tr.setMeta(BLOCK_PLUGIN_KEY, { sourceBlockPos: pos })
      tr.setSelection(TextSelection.create(tr.doc, pos + built.node.nodeSize))
    }
    return tr
  }

  // code_block is a textblock: park the caret on its first content position so
  // the next keystroke goes into the block.
  tr.setSelection(TextSelection.create(tr.doc, blockFrom + 1))
  return tr
}

// Caret position inside `list[item[para[...]]]` right after `textLen` chars,
// where the list starts at `from`. A paragraph's content starts at from+3: one
// step past the list, the list item, and the paragraph opening.
function inListItem(from: number, textLen: number): number {
  return from + 3 + textLen
}

// Same for `blockquote[para[...]]`: one step past the blockquote opening.
function inBlockquote(from: number, textLen: number): number {
  return from + 2 + textLen
}

function joinIfList(tr: Transaction, from: number, listType: string): void {
  if (from <= 0) return
  const before = tr.doc.resolve(from - 1).nodeBefore
  if (before && before.type === schema.nodes[listType] && canJoin(tr.doc, from - 1)) {
    tr.join(from - 1)
  }
}

// Wrap the (marker-carrying) textblock in a list whose item already holds
// `kept` as its paragraph text, replacing the textblock entirely.
function wrapIntoList(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
  listType: string,
  listAttrs: Record<string, unknown> | null,
  itemAttrs: Record<string, unknown> | null,
  kept: string,
): Transaction {
  const item = schema.nodes.list_item.create(itemAttrs, [schema.nodes.paragraph.create(null, kept ? [schema.text(kept)] : undefined)])
  const list = schema.nodes[listType].create(listAttrs, item)
  const tr = state.tr.replaceWith(blockFrom, blockTo, list)
  joinIfList(tr, blockFrom, listType)
  tr.setSelection(TextSelection.create(tr.doc, inListItem(blockFrom, kept.length)))
  return tr
}

const fenceRule = (): InputRule =>
  new InputRule(FENCE_RULE, (state, match, start) => {
    const info = match[1] ?? ''
    const { from, to } = blockRangeOf(state, start)
    return insertFence(state, from, to, info)
  })

const bulletRule = (): InputRule => {
  // Defers to content so `- [ ]` / `- [x]` (whose bracket cannot match
  // `[^\s\[]`) always win while the marker is being typed.
  return new InputRule(BULLET_RULE, (state, match, start) => {
    const kept = match[2]
    const { from, to } = blockRangeOf(state, start)
    return wrapIntoList(state, from, to, 'bullet_list', null, null, kept)
  })
}

const taskRule = (): InputRule =>
  new InputRule(TASK_RULE, (state, match, start) => {
    const checked = /[xX]/.test(match[0])
    const { from, to } = blockRangeOf(state, start)
    return wrapIntoList(state, from, to, 'bullet_list', null, { checked }, '')
  })

const orderedRule = (): InputRule =>
  wrappingInputRule(ORDERED_RULE, schema.nodes.ordered_list, (m) => ({ order: Number(m[1]) }))

const blockquoteRule = (): InputRule => wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote)

export function blockStartRules(): InputRule[] {
  return [
    ...headingRules(),
    horizontalRule(),
    fenceRule(),
    // Task list before bullet as defense-in-depth; the bullet regex already
    // excludes `[` so an incrementally typed `- [ ]` is never claimed by it.
    taskRule(),
    bulletRule(),
    orderedRule(),
    blockquoteRule(),
  ]
}

function replaceWithEmptyList(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
  listTypeName: string,
  listAttrs: Record<string, unknown> | null = null,
  itemAttrs: Record<string, unknown> | null = null,
): Transaction {
  const tr = state.tr
  if (listTypeName === 'blockquote') {
    const node = schema.nodes.blockquote.create(null, [schema.nodes.paragraph.create()])
    tr.replaceWith(blockFrom, blockTo, node)
    tr.setSelection(TextSelection.create(tr.doc, inBlockquote(blockFrom, 0)))
    return tr
  }
  return wrapIntoList(state, blockFrom, blockTo, listTypeName, listAttrs, itemAttrs, '')
}

/**
 * Enter after an unterminated marker (````js`, `- `, `1.`, `> `…) converts the
 * line to its block element, mirroring the input rules but for the newline
 * that would otherwise just split the paragraph. The caret ends up inside the
 * new block so subsequent Enter presses behave normally.
 */
export function blockStartKeymap() {
  return keymap({
    Enter(state: EditorState, dispatch?: (tr: Transaction) => void, _view?: unknown) {
      if (!dispatch) return false
      const { $from } = state.selection
      if (!state.selection.empty || !$from.parent.isTextblock || $from.parent.type.spec.code) {
        return false
      }
      const text = $from.parent.textBetween(0, $from.parentOffset, '\n')
      const blockFrom = $from.before($from.depth)
      const blockTo = $from.after($from.depth)

      let tr: Transaction | null = null
      if (FENCE_MATCH.test(text)) {
        const info = text.match(FENCE_MATCH)?.[1] ?? ''
        tr = insertFence(state, blockFrom, blockTo, info)
      } else if (TASK_MATCH.test(text)) {
        tr = replaceWithEmptyList(state, blockFrom, blockTo, 'bullet_list', null, { checked: /[xX]/.test(text) })
      } else if (BULLET_MATCH.test(text)) {
        tr = replaceWithEmptyList(state, blockFrom, blockTo, 'bullet_list')
      } else if (ORDERED_MATCH.test(text)) {
        tr = replaceWithEmptyList(state, blockFrom, blockTo, 'ordered_list', { order: Number(text.match(ORDERED_MATCH)?.[1]) })
      } else if (BLOCKQUOTE_MATCH.test(text)) {
        tr = replaceWithEmptyList(state, blockFrom, blockTo, 'blockquote')
      }
      if (!tr) return false
      dispatch(tr)
      return true
    },
  })
}