/**
 * The two ways out of an inline mark, and both are about the *next* character
 * rather than the text already typed: the delimiter that closes the span, and
 * walking off the end of it with an arrow key. Neither touches the document —
 * `**bold** and more` is a sentence with two bold words in it, not a bold
 * block — and neither is `Ctrl+B` again, because there are only two marks that
 * have one.
 *
 * "Inherits" is ProseMirror's word for the whole mechanism: an empty selection
 * types into whatever the document says at the caret, or into `storedMarks`
 * when a command has set them, and `storedMarks` wins for exactly as long as
 * it stays set. So one write to it is what a closing delimiter means, and it is
 * also the only state an arrow key can use: everything else about the caret is
 * the document's, and the browser rewrites the selection itself.
 */
import { Plugin } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { Mark, MarkType, ResolvedPos } from 'prosemirror-model'
import { InputRule } from 'prosemirror-inputrules'

/** What the next typed character inherits at the caret. */
function inherited(state: EditorState): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks()
}

/**
 * The three fields `stopMarking` re-uses from the rule it wraps. They are
 * marked `@internal` on `InputRule`, so they are missing from the published
 * types — but they are what the constructor stores, and re-wrapping a rule is
 * the only way to keep its pattern and its handler while changing what it does
 * to the transaction they return.
 */
interface RuleParts {
  match: RegExp
  handler: (state: EditorState, match: RegExpMatchArray, start: number, end: number) => Transaction | null
  undoable: boolean
  // Typed `boolean | "only"` on the class, but the constructor only ever
  // stores a boolean (`options.inCodeMark !== false`) and `"only"` means
  // nothing for this flag.
  inCodeMark: boolean
}

/**
 * Wrap a paired-delimiter input rule so the mark it closes stops inheriting.
 * Without this a `strong` span typed as `**bold**` leaves the caret inside the
 * run it just made: `$from.marks()` at the end of a run reports that run's
 * marks, because the position is still its boundary, so the rest of the
 * sentence is typed bold. `stopMarking` is what the code-span rule did alone,
 * generalized to every mark a delimiter can close.
 */
export function stopMarking(rule: InputRule, markType: MarkType): InputRule {
  const { match, handler, undoable, inCodeMark } = rule as unknown as RuleParts
  const mark = markType.create()
  return new InputRule(
    match,
    (state, match, start, end) => {
      const tr = handler(state, match, start, end)
      // The opening delimiter's own marks, less the mark the pair closed: what
      // a character typed after it would have inherited if no rule had fired.
      if (tr?.docChanged) tr.setStoredMarks(mark.removeFromSet(state.doc.resolve(start).marks()))
      return tr
    },
    { undoable, inCode: rule.inCode, inCodeMark },
  )
}

/**
 * True when the document has nothing on the `dir` side of the caret's own
 * block, at every level of nesting: no following paragraph, no next list item.
 * Between those the browser's own arrow moves the caret by itself, so the key
 * only needs handling where there is nowhere left for it to go.
 */
function noNodeBeyond($pos: ResolvedPos, dir: 1 | -1): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    // The node at `depth` is the child at `index(depth - 1)` of the node above.
    const index = $pos.index(depth - 1)
    const last = $pos.node(depth - 1).childCount - 1
    if (dir > 0 ? index < last : index > 0) return false
  }
  return true
}

/**
 * The mark an arrow key in `dir` would leave, or null when there is nothing to
 * leave: not in a textblock, no mark under the caret, or somewhere the caret
 * can still move. That last case is the whole design. A browser arrow that
 * lands one character along, or in the next block, reads its marks from where
 * it landed, and where it landed is outside the run — so those presses already
 * work, and handling them would make Right a key that sometimes does not move
 * the caret.
 */
function arrowMark(state: EditorState, dir: 1 | -1): Mark | null {
  const { $from } = state.selection
  if (!state.selection.empty || !$from.parent.isTextblock) return null
  const atEdge = dir > 0
    ? $from.parentOffset === $from.parent.content.size
    : $from.parentOffset === 0
  if (!atEdge || !noNodeBeyond($from, dir)) return null
  const marks = $from.marks()
  return marks[marks.length - 1] ?? null
}

/**
 * `ArrowRight` / `ArrowLeft`: step out of the innermost mark at the caret, and
 * leave every other key to the browser. Only the stored marks change — the
 * marked text is exactly as it was — and the caret does not move, because
 * there is nowhere on that side for it to move to.
 */
export const markExitPlugin = new Plugin({
  props: {
    handleKeyDown(view, event) {
      const dir: 1 | -1 | 0 =
        event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (!dir || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
      const mark = arrowMark(view.state, dir)
      if (!mark) return false
      view.dispatch(view.state.tr.setStoredMarks(mark.removeFromSet(inherited(view.state))))
      return true
    },
  },
})