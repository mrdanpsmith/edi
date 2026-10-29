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
import { Plugin, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import { Mark } from 'prosemirror-model'
import type { MarkType, ResolvedPos } from 'prosemirror-model'
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

/** The marks on the `dir` side of the caret: the neighbouring node's, or none at the edge of the block. */
function marksBeyond($pos: ResolvedPos, dir: 1 | -1): readonly Mark[] {
  return (dir > 0 ? $pos.nodeAfter : $pos.nodeBefore)?.marks ?? Mark.none
}

/** The innermost of `marks` that `beyond` does not carry. */
function innermostMissing(marks: readonly Mark[], beyond: readonly Mark[]): Mark | null {
  for (let i = marks.length - 1; i >= 0; i--) if (!marks[i].isInSet(beyond)) return marks[i]
  return null
}

/** The length of the last grapheme of `text`, so a step left never splits one. */
function lastGraphemeLength(text: string): number {
  let last = ''
  for (const { segment } of new Intl.Segmenter().segment(text)) last = segment
  return last.length
}

/**
 * What an arrow key in `dir` does to the caret's marks, or null to leave the
 * key to the browser. A mark boundary is two caret stops in one position —
 * inside the run and outside it — and the arrow walks through both:
 *
 * - **Leaving.** When the next character typed would inherit a mark that the
 *   text on the `dir` side does not have (the end of a code span before plain
 *   text, or the edge of the block), the first press drops the innermost such
 *   mark and the caret stays put. The next press moves.
 * - **Arriving.** `ArrowLeft` onto the end of a run from the text after it
 *   lands outside the run, keeping only the marks of the character it crossed,
 *   because that is the side the caret came from. The browser's own step lands
 *   inside, and typing there extends the span.
 *
 * Neither touches the document; only `storedMarks` changes.
 */
function arrowStep(state: EditorState, dir: 1 | -1): Transaction | null {
  const { $from } = state.selection
  if (!state.selection.empty || !$from.parent.isTextblock) return null

  const marks = inherited(state)
  const leave = innermostMissing(marks, marksBeyond($from, dir))
  if (leave) return state.tr.setStoredMarks(leave.removeFromSet(marks))

  const crossed = $from.nodeBefore
  if (dir > 0 || !crossed) return null
  const target = $from.pos - (crossed.isText ? lastGraphemeLength(crossed.text ?? '') : crossed.nodeSize)
  const arriving = state.doc.resolve(target).marks()
  const kept = arriving.filter(mark => mark.isInSet(crossed.marks))
  if (kept.length === arriving.length) return null
  // `setSelection` clears stored marks, so it has to come first.
  return state.tr.setSelection(TextSelection.create(state.doc, target)).setStoredMarks(kept)
}

/**
 * `ArrowRight` / `ArrowLeft` across a mark boundary (see `arrowStep`), and
 * every other key left to the browser.
 */
export const markExitPlugin = new Plugin({
  props: {
    handleKeyDown(view, event) {
      const dir: 1 | -1 | 0 =
        event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (!dir || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
      const tr = arrowStep(view.state, dir)
      if (!tr) return false
      view.dispatch(tr)
      return true
    },
  },
})