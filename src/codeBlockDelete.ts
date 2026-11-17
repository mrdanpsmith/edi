import { NodeSelection, Plugin, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import { keymap } from 'prosemirror-keymap'
import { currentBlockMode } from './block-modes'

/**
 * **Code block keys, on Notion's block-editor model.** Two rules, and no key does half of
 * another's job:
 *
 * 1. **Backspace at the start of a block turns it into plain text.** For a code block that
 *    is its lines as paragraphs, the text kept — the same move as deleting its fences in
 *    Source, which was the only way out before. A second Backspace is then any paragraph's.
 * 2. **A whole block is deleted by selecting it, then deleting.** Esc inside a code block
 *    selects it (Notion's gesture), as does a press on its frame (`press.ts`) or a drag
 *    across it (`codeBlockMouse.ts`); Backspace or Delete on the selection removes it
 *    (`deleteSelection`, unchanged). A delete key never selects a block as a side effect
 *    of being pressed *inside* one.
 *
 * Delete at the end of a code block stays put rather than `joinForward`, which pulled the
 * next line into the code. The lines **beside** a code block keep the rule Edi already has
 * beside a diagram or a table: Backspace at the start of the line after one, or Delete at
 * the end of the line before one, selects it (an empty line in between goes first).
 *
 * A CodeMirror-drawn block never lets these keys reach this keymap, so it calls
 * `codeBlockKey` from its own bindings (`createCodeEditor`, `node/execblock.ts`).
 */

type Dispatch = ((tr: Transaction) => void) | undefined

function isCode(node: { type: { name: string } } | null | undefined): boolean {
  return node?.type.name === 'code_block'
}

function selectBlock(state: EditorState, dispatch: Dispatch, pos: number): boolean {
  dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView())
  return true
}

/**
 * Turn the code block at `pos` into one paragraph per line, the caret at the start of the
 * first. An empty block becomes one empty paragraph.
 */
function unwrapCodeBlock(state: EditorState, dispatch: Dispatch, pos: number): boolean {
  const node = state.doc.nodeAt(pos)
  if (!isCode(node)) return false
  if (!dispatch) return true
  const { schema } = state
  const paragraphs = node!.textContent.split('\n').map((line) =>
    schema.nodes.paragraph.create(null, line ? schema.text(line) : null))
  const tr = state.tr.replaceWith(pos, pos + node!.nodeSize, paragraphs)
  dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView())
  return true
}

/**
 * The two block keys from inside the code block at `pos`: Backspace (at its start) makes it
 * text, Escape selects it. What a CodeMirror-drawn block calls, since it owns its keys.
 */
export function codeBlockKey(
  state: EditorState,
  dispatch: Dispatch,
  pos: number,
  key: 'Backspace' | 'Escape',
): boolean {
  if (!isCode(state.doc.nodeAt(pos))) return false
  return key === 'Backspace' ? unwrapCodeBlock(state, dispatch, pos) : selectBlock(state, dispatch, pos)
}

/** The caret, when it is a collapsed one inside a code block: the block's position and where in it. */
function caretInCode(state: EditorState): { pos: number; atStart: boolean; atEnd: boolean } | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return null
  const $cursor = selection.$from
  if (!isCode($cursor.parent)) return null
  return {
    pos: $cursor.before(),
    atStart: $cursor.parentOffset === 0,
    atEnd: $cursor.parentOffset === $cursor.parent.content.size,
  }
}

/**
 * The line beside a code block, deleting towards it (`dir` -1 for Backspace, 1 for
 * Delete): an empty line goes and the block is selected; a line with text keeps it and
 * selects the block. Only for a block that is the line's own sibling, so a list item's
 * first line still lifts out of its list as Backspace always made it.
 */
function towardsCodeBlock(state: EditorState, dispatch: Dispatch, dir: 1 | -1): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const $cursor = selection.$from
  const line = $cursor.parent
  if (!line.isTextblock || line.type.spec.code) return false
  if ($cursor.parentOffset !== (dir < 0 ? 0 : line.content.size)) return false

  const depth = $cursor.depth
  const index = $cursor.index(depth - 1)
  const parent = $cursor.node(depth - 1)
  const neighbourIndex = index + dir
  if (neighbourIndex < 0 || neighbourIndex >= parent.childCount) return false
  const neighbour = parent.child(neighbourIndex)
  if (!isCode(neighbour)) return false

  const linePos = $cursor.before(depth)
  const blockPos = dir < 0 ? linePos - neighbour.nodeSize : linePos + line.nodeSize
  if (line.content.size > 0) return selectBlock(state, dispatch, blockPos)

  if (!dispatch) return true
  const tr = state.tr.delete(linePos, linePos + line.nodeSize)
  const at = dir < 0 ? blockPos : linePos
  dispatch(tr.setSelection(NodeSelection.create(tr.doc, at)).scrollIntoView())
  return true
}

/** Backspace, Delete and Escape for code blocks; placed before `baseKeymap` in `editor.ts`. */
export const codeBlockDeleteKeymap = (): Plugin =>
  keymap({
    Backspace(state, dispatch) {
      const caret = caretInCode(state)
      if (caret?.atStart) return unwrapCodeBlock(state, dispatch, caret.pos)
      return towardsCodeBlock(state, dispatch, -1)
    },
    Delete(state, dispatch) {
      // At the end of the code there is nothing of the block's to delete forward, and the
      // next line is not the code's to take: the key stays put.
      if (caretInCode(state)?.atEnd) return true
      return towardsCodeBlock(state, dispatch, 1)
    },
    Escape(state, dispatch) {
      // A block in a mode is the mode's Escape first (`blockToggleKeymap`): leaving it is
      // what Escape means there, and selecting a block would answer a different question.
      if (currentBlockMode(state) !== null) return false
      // A caret or a selection of text inside one code block, as Notion's Esc takes either.
      const { selection } = state
      if (!(selection instanceof TextSelection)) return false
      const { $from, $to } = selection
      if (!isCode($from.parent) || !$from.sameParent($to)) return false
      return selectBlock(state, dispatch, $from.before())
    },
  })
