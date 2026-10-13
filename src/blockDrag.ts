/**
 * Dragging a **whole block** does nothing, because nothing has defined what it should do.
 *
 * **It is not a Chromium behaviour, and it was not a feature — it was a default.** Chromium
 * only provides the drag mechanism (the ghost image, the `DataTransfer`); what the editor
 * drags is ProseMirror's `dragstart` handler, which serialises the current selection's
 * content into `text/html` and `text/plain`, and a `drop` handler which re-inserts it.
 * Nothing in this app ever described that path, so a block could be picked up and dropped
 * with no gesture of the reader's behind it. It is cancelled here, at the source, which is
 * the only place that closes it: every in-app block drag must begin with a `dragstart` this
 * module hears.
 *
 * **What it did, measured by reading the two handlers:**
 *
 * - **a drop inside one editor** *moves* the block — `view.dragging` is set, and the drop
 *   deletes the source.
 * - **a drop into a different editor *copies* it**, because `view.dragging` is `null`
 *   there and ProseMirror re-parses the `DataTransfer` payload instead. The page has two
 *   editors the moment an encrypted block is unlocked, and an `encrypted_block` round-trips
 *   through its own `parseDOM` rule with its ciphertext intact — so a block dragged into an
 *   open reveal became a **second copy of an encrypted block inside the first**, which
 *   `persist` then encrypted again. That is the bug this closes, and it is not reachable
 *   now: a drag that never starts has no drop.
 *
 * **Refused rather than defined**, because a move and a copy are both defensible and the app
 * has not said which a drag is (a duplicate of the clipboard's own ambiguity, but with a
 * secret block the stakes are not a paragraph's); whether a block may be dropped *into*
 * another block at all, which for an encrypted block means nesting one secret inside
 * another; and what a drop onto a working state should mean. Those are design questions,
 * and a gesture nobody designed should not be one a reader can trigger by accident.
 *
 * **What keeps working**: dragging **text inside a block** — a word, a bold run, a link —
 * which is the browser's own gesture and is what `dragsABlock` distinguishes.
 *
 * A drop that arrives from **outside** the app (another window's text, a file from the
 * desktop) is left alone: it is not an in-app block drag, and refusing it would change
 * behaviour nobody reported. Pasting markdown into an encrypted block is the same question
 * asked with a different gesture, and it is still open.
 */
import { Plugin, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

/**
 * Would this drag carry a **block** rather than text inside one?
 *
 * **Decided from the selection's own positions, not from its slice.** The payload a drag
 * would carry is `state.selection.content()`, and that slice does not answer the question:
 * ProseMirror flattens it when it lies inside one block (a word's slice content is a bare
 * `text` node) but keeps the block node itself when it does not, so "is there a block in
 * here" has to be read out of three different shapes. What is left, once the slice is gone,
 * is the fact the reader would describe it by: **text inside a block** — one textblock, and
 * not all of it.
 *
 * | the selection | dragged | kept |
 * |---|---|---|
 * | a word, anywhere in a paragraph, heading or list item | text | ✅ |
 * | a bold run, a link | text | ✅ |
 * | the **whole** text of one paragraph, selected as text | the paragraph | ❌ |
 * | part of one paragraph through the next | blocks | ❌ |
 * | a diagram, a table, an image, a code fence, an encrypted block | the atom | ❌ |
 * | a `NodeSelection` (a clicked block), `Ctrl+A` | the block(s) | ❌ |
 *
 * A `NodeSelection` and an `AllSelection` are refused outright rather than asked about their
 * content: both are block selections by definition and neither has a text-only reading.
 * Refusing a selection that spans two blocks is the conservative half — a reader dragging a
 * phrase out of the middle of a sentence and into the next paragraph gets nothing — and the
 * alternative is a gesture whose payload carries block boundaries, which is exactly the
 * thing being withdrawn.
 */
export function dragsABlock(view: EditorView): boolean {
  const selection = view.state.selection
  if (!(selection instanceof TextSelection)) return true
  // A collapsed caret is nobody's selection, and a drag from one is either nothing or the
  // browser's own (a link, an image) — never text the reader chose to pick up.
  if (selection.empty) return true
  const $from = selection.$from
  if ($from.parent !== selection.$to.parent) return true
  return selection.from === $from.start() && selection.to === $from.end()
}

/**
 * Cancel the drag, before ProseMirror's own handler can hear about it.
 *
 * **`handleDOMEvents` is the lever, and the ordering is not luck**: the listener
 * `initInput` registers for each internal event *calls* `runCustomHandler` first and only
 * then its own handler, so returning `true` here means `dragstart` never reaches
 * ProseMirror — no `DataTransfer` payload, no `view.dragging` — and `preventDefault` stops
 * the browser from starting a drag at all. Without the `preventDefault` there would be a
 * drag with nothing to receive it.
 */
export const blockDragPlugin = new Plugin({
  props: {
    handleDOMEvents: {
      dragstart(view, event) {
        if (!dragsABlock(view)) return false
        event.preventDefault()
        return true
      },
    },
  },
})