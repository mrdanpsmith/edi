import { InputRule, wrappingInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import { canJoin } from 'prosemirror-transform'
import { schema } from './schema'
import { setBlockModeAt } from './block-modes'

const FENCE_RULE = /^```(\S+)?\s$/
const FENCE_MATCH = /^```(\S+)?$/
const BULLET_RULE = /^([-*+])\s([^\s[])$/u
const BULLET_MATCH = /^[-*+]\s?$/
const TASK_RULE = /^-\s\[[ xX]\]\s$/
const TASK_MATCH = /^-\s\[[ xX]\]$/
const ORDERED_RULE = /^(\d+)\.\s$/
const ORDERED_MATCH = /^(\d+)\.\s?$/
const BLOCKQUOTE_MATCH = /^>\s?$/

/**
 * The text still in the block **after** the marker that just fired.
 *
 * A block-start marker is typed at the start of a line, and the reader's cursor is at the
 * end of the marker — so everything the line held beyond it is text the rule has to take
 * with it, not text it may drop. `end` is the end of the match (the position after the
 * character just typed), and the block it fired in is the textblock that position is in.
 */
function textAfterMarker(state: EditorState, end: number): string {
  const $end = state.doc.resolve(end)
  if (!$end.parent.isTextblock) return ''
  return $end.parent.textBetween($end.parentOffset, $end.parent.content.size, ' ')
}

function headingRules(): InputRule[] {
  return Array.from({ length: 6 }, (_, i) => {
    const level = i + 1
    return new InputRule(new RegExp(`^${'#'.repeat(level)}\\s(.*)$`, 'm'), (state, match, start, end) => {
      // **What was on the line, not just what was typed.** `match[1]` is the heading text
      // up to the cursor, and the rest of the line is the heading's text too: typing `## `
      // at the start of a paragraph converts *that paragraph* into an H2 and keeps what it
      // said, which is what every other markdown editor does. It used to rebuild the block
      // from `match[1]` alone, so a marker typed in front of existing text replaced the
      // whole paragraph with a heading holding only the marker's own line — **the reader's
      // text, silently deleted**.
      const text = match[1] + textAfterMarker(state, end)
      const { from, to } = blockRangeOf(state, start)
      const nodeType = state.schema.nodes.heading
      const content = text ? state.schema.text(text) : null
      const tr = state.tr.replaceWith(from, to, nodeType.create({ level }, content))
      tr.setSelection(TextSelection.create(tr.doc, from + 1 + text.length))
      return tr
    })
  })
}

const horizontalRule = (): InputRule =>
  new InputRule(/^---$/, (state, _match, start, end) => {
    // **A rule is a whole line**, so it refuses to fire on a line that has more on it —
    // the same reasoning as the fence below. Replacing a paragraph of text with a
    // horizontal rule because someone typed `---` in front of it is not a conversion.
    if (textAfterMarker(state, end) !== '') return null
    const { from, to } = blockRangeOf(state, start)
    const tr = state.tr.replaceWith(from, to, state.schema.nodes.horizontal_rule.create())
    tr.setSelection(TextSelection.create(tr.doc, from + 1))
    return tr
  })

/**
 * Build the node a fence marker produces. `mermaid` yields an empty atom block
 * whose mode is set by `insertFence` (which owns the transaction, and therefore
 * the record); a `#!` info string becomes the shebang first line of a runnable
 * code block; anything else is a code block with that language.
 */
export function fenceNode(
  state: EditorState,
  info: string,
): { node: import('prosemirror-model').Node } | null {
  if (info === 'mermaid') {
    return { node: state.schema.nodes.mermaid_block.create({ value: '' }) }
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
    // inside) the doc. Recording it as the open source block focuses the editor
    // with the serialized fence, ready for a language + newline — and being the
    // record rather than an attr on the node, it is a mode flip that leaves the
    // document alone.
    let pos = tr.doc.nodeAt(blockFrom)?.type.name === 'mermaid_block' ? blockFrom : -1
    if (pos < 0) {
      tr.doc.forEach((node, offset) => {
        if (pos < 0 && node.type.name === 'mermaid_block') pos = offset
      })
    }
    if (pos >= 0) {
      setBlockModeAt(state, tr, pos, { representation: 'source' })
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
  new InputRule(FENCE_RULE, (state, match, start, end) => {
    // **A fence is a whole line.** An opening fence with prose after it on the same line is
    // not a fence that lost its text — it is prose, and typing ``` ```py ``` in front of a
    // paragraph must not turn that paragraph into an empty code block. So this rule, and the
    // horizontal rule beside it, declines when there is anything left on the line. The list
    // rules below are the opposite case, and say so.
    if (textAfterMarker(state, end) !== '') return null
    const info = match[1] ?? ''
    const { from, to } = blockRangeOf(state, start)
    return insertFence(state, from, to, info)
  })

const bulletRule = (): InputRule => {
  // Defers to content so `- [ ]` / `- [x]` (whose bracket cannot match
  // `[^\s\[]`) always win while the marker is being typed.
  return new InputRule(BULLET_RULE, (state, match, start, end) => {
    // **The line becomes the item's text**, the character the rule captured and the rest of
    // it alike: `- Second para.` makes a bullet item that says "Second para.". The rule used
    // to keep `match[2]` and drop the rest, which deleted the reader's text whenever a
    // marker was typed in front of it.
    const kept = match[2] + textAfterMarker(state, end)
    const { from, to } = blockRangeOf(state, start)
    return wrapIntoList(state, from, to, 'bullet_list', null, null, kept)
  })
}

const taskRule = (): InputRule =>
  new InputRule(TASK_RULE, (state, match, start, end) => {
    const checked = /[xX]/.test(match[0])
    const { from, to } = blockRangeOf(state, start)
    // As the bullet rule above: the text on the line is the item's text, and a task marker
    // has no captured content of its own to add to it.
    return wrapIntoList(state, from, to, 'bullet_list', null, { checked },
      textAfterMarker(state, end))
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

/**
 * Convert the line into `listTypeName`, keeping whatever the reader had already written
 * after the marker — `kept`, which is empty when the marker ended the line (the ordinary
 * case) and is the rest of the line when it did not.
 *
 * A blockquote takes a paragraph rather than a list item, so it is the one shape here that
 * is not `wrapIntoList`'s.
 */
function replaceWithList(
  state: EditorState,
  blockFrom: number,
  blockTo: number,
  listTypeName: string,
  kept: string,
  listAttrs: Record<string, unknown> | null = null,
  itemAttrs: Record<string, unknown> | null = null,
): Transaction {
  const tr = state.tr
  if (listTypeName === 'blockquote') {
    const paragraph = kept
      ? schema.nodes.paragraph.create(null, schema.text(kept))
      : schema.nodes.paragraph.create()
    const node = schema.nodes.blockquote.create(null, [paragraph])
    tr.replaceWith(blockFrom, blockTo, node)
    tr.setSelection(TextSelection.create(tr.doc, inBlockquote(blockFrom, 0) + kept.length))
    return tr
  }
  return wrapIntoList(state, blockFrom, blockTo, listTypeName, listAttrs, itemAttrs, kept)
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
      // **The rest of the line, and the same three cases the input rules make.** A marker
      // need not end the line: pressing Enter after `- Second para.` converts the line to a
      // bullet item that says "Second para.", and a fence on a line with prose after it is
      // not a fence at all, so this declines exactly as the input rule does.
      const kept = textAfterMarker(state, state.selection.from)

      let tr: Transaction | null = null
      if (FENCE_MATCH.test(text)) {
        if (kept !== '') return false
        const info = text.match(FENCE_MATCH)?.[1] ?? ''
        tr = insertFence(state, blockFrom, blockTo, info)
      } else if (TASK_MATCH.test(text)) {
        tr = replaceWithList(state, blockFrom, blockTo, 'bullet_list', kept, null,
          { checked: /[xX]/.test(text) })
      } else if (BULLET_MATCH.test(text)) {
        tr = replaceWithList(state, blockFrom, blockTo, 'bullet_list', kept)
      } else if (ORDERED_MATCH.test(text)) {
        tr = replaceWithList(state, blockFrom, blockTo, 'ordered_list', kept,
          { order: Number(text.match(ORDERED_MATCH)?.[1]) })
      } else if (BLOCKQUOTE_MATCH.test(text)) {
        tr = replaceWithList(state, blockFrom, blockTo, 'blockquote', kept)
      }
      if (!tr) return false
      dispatch(tr)
      return true
    },
  })
}