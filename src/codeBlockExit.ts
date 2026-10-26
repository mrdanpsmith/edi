import { Plugin, Selection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

/**
 * Move the caret out of the code block at `pos` in `dir`, the way an arrow key
 * leaves every other block. Text after/before the block wins; an atom is
 * selected when there is no text to put the caret in. A code block at the end
 * of the document gets the empty paragraph every other block at the end gets.
 */
export function exitCodeBlock(view: EditorView, pos: number, dir: 1 | -1): boolean {
  const { state } = view
  const node = state.doc.nodeAt(pos)
  if (node === null || node.type.name !== 'code_block') return false

  const boundary = dir > 0 ? pos + node.nodeSize : pos
  const $at = state.doc.resolve(boundary)
  const target = Selection.findFrom($at, dir, true) ?? Selection.findFrom($at, dir)
  const tr = state.tr

  if (target) {
    tr.setSelection(target)
  } else {
    if (dir < 0) return false
    tr.insert(boundary, state.schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, boundary + 1))
  }

  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

function isArrow(dir: 1 | -1, event: KeyboardEvent): boolean {
  const key = dir > 0 ? 'ArrowDown' : 'ArrowUp'
  return event.key === key && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

/**
 * Arrow-key exit for a plain fenced code block (the one left as ProseMirror
 * content rather than an embedded CodeMirror). It enforces the same rule as the
 * CodeMirror bindings: the arrow walks to the edge of its own line first, and
 * only the true edge of the block leaves it.
 */
export function handleCodeBlockArrow(view: EditorView, event: KeyboardEvent): boolean {
  const down = isArrow(1, event)
  const up = isArrow(-1, event)
  if (!down && !up) return false

  // A grammar-backed code block is a CodeMirror editor and exits from its own
  // keymap, after committing through its node view. A control is not the code,
  // so an arrow pressed on one is the control's to keep.
  const target = event.target
  if (
    target instanceof Element &&
    target.closest('.cm-editor, button, input, textarea, select')
  ) {
    return false
  }

  const { state } = view
  const { selection } = state
  if (!selection.empty || selection.$from.parent.type.name !== 'code_block') return false

  const $from = selection.$from
  const text = $from.parent.textContent
  const offset = $from.parentOffset
  const dir = down ? 1 : -1

  if (dir > 0) {
    if (offset === text.length) return exitCodeBlock(view, $from.before($from.depth), dir)
    if (text.indexOf('\n', offset) !== -1) return false
    view.dispatch(
      state.tr
        .setSelection(TextSelection.create(state.doc, $from.start() + text.length))
        .scrollIntoView(),
    )
    return true
  }

  if (offset === 0) return exitCodeBlock(view, $from.before($from.depth), dir)
  if (text.lastIndexOf('\n', offset - 1) !== -1) return false
  view.dispatch(
    state.tr.setSelection(TextSelection.create(state.doc, $from.start())).scrollIntoView(),
  )
  return true
}

export const codeBlockExitPlugin = new Plugin({
  props: {
    handleKeyDown: handleCodeBlockArrow,
  },
})
