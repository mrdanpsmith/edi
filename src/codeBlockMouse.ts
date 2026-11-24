import { Plugin, Selection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { Node as ProseNode, ResolvedPos } from 'prosemirror-model'
import { codeBlockPosForElement } from './press'

/**
 * **A drag across a highlighted code block treats the block as one thing.**
 *
 * A code block drawn by CodeMirror is a selection unit like a diagram (`isSelectionAtom`):
 * a range that covers it is marked whole (`edi-block-selected`), and what it copies is the
 * block's markdown. Two drags broke that, measured with real pointer input
 * (`tests/browser/edit-blocks.browser.test.ts`):
 *
 * 1. **Dragging from the text into the block stopped at the block.** The browser puts the
 *    drag's focus inside CodeMirror's own contenteditable, and ProseMirror can only map a
 *    point in a node view without a contentDOM to the position *before* the node. With the
 *    pointer over the code, the selection ended on the line above it and the block was not
 *    in it. `createSelectionBetween` moves that head past the block while the pointer is
 *    over it, so the block is in the range the moment the pointer reaches it.
 * 2. **Dragging out of the block stayed inside it.** A press in the code is CodeMirror's,
 *    and so is the drag that follows: its selection stopped at the block's edge however far
 *    the pointer went. When the pointer leaves the block's box, this ends CodeMirror's drag
 *    and carries on as a document selection from the block's far side to the pointer, so
 *    the block and everything the pointer crosses after it are selected.
 *
 * Plain code blocks are text, and a drag through one is the browser's like any paragraph.
 */

interface CodeEditorBlock {
  pos: number
  node: ProseNode
  dom: HTMLElement
}

/** The CodeMirror-drawn code block `el` is inside, in `view`, or null. */
function codeEditorBlockOf(view: EditorView, el: Element | null): CodeEditorBlock | null {
  const dom = el?.closest<HTMLElement>('.runnable-block') ?? null
  if (dom === null || !view.dom.contains(dom) || dom.querySelector('.cm-editor') === null) return null
  const pos = codeBlockPosForElement(view, dom)
  const node = pos === -1 ? null : view.state.doc.nodeAt(pos)
  return node === null ? null : { pos, node, dom }
}

/**
 * The text position just past `block` in direction `dir`: the start of the next textblock
 * going forward, the end of the previous one going back. A `TextSelection` ending there
 * covers the block entirely. The block's own edge when there is no such text.
 */
function pastBlock(doc: ProseNode, block: CodeEditorBlock, dir: 1 | -1): number {
  const edge = dir > 0 ? block.pos + block.node.nodeSize : block.pos
  return Selection.findFrom(doc.resolve(edge), dir, true)?.head ?? edge
}

export function codeBlockMousePlugin(): Plugin {
  // Where the pointer is while a button is held. Per plugin instance, so per editor view.
  let pointer: { x: number; y: number } | null = null

  return new Plugin({
    props: {
      createSelectionBetween(view, $anchor: ResolvedPos, $head: ResolvedPos) {
        if (pointer === null) return null
        const block = codeEditorBlockOf(view, document.elementFromPoint(pointer.x, pointer.y))
        if (block === null) return null
        const end = block.pos + block.node.nodeSize
        if ($anchor.pos > block.pos && $anchor.pos < end) return null
        const forward = $anchor.pos <= block.pos
        const head = pastBlock(view.state.doc, block, forward ? 1 : -1)
        if (head === $head.pos) return null
        return TextSelection.create(view.state.doc, $anchor.pos, head)
      },
    },

    view(view) {
      // A drag that began in a code block's CodeMirror, once it has left the block.
      let fromCode: CodeEditorBlock | null = null
      let escaped: { anchor: number } | null = null

      // A drag ProseMirror itself is running: begun on this editor's text, not in a CodeMirror.
      let fromText = false

      const onDown = (event: MouseEvent): void => {
        if (event.button !== 0) return
        pointer = { x: event.clientX, y: event.clientY }
        escaped = null
        const target = event.target instanceof Element ? event.target : null
        fromCode = target?.closest('.cm-content') ? codeEditorBlockOf(view, target) : null
        // Not the run output either: a drag there is the browser's own selection of
        // its text, and moving the head past the block would replace it with one
        // of the whole block.
        fromText = fromCode === null && target !== null && view.dom.contains(target) &&
          target.closest('.cm-editor, .exec-output') === null
      }

      /**
       * Chromium does not carry a drag's selection from the outer contenteditable into
       * CodeMirror's own, so with the pointer over the code there is no selection change for
       * `createSelectionBetween` to answer: the head sits at the block's edge. The pointer is
       * the only signal, so it moves the head past the block itself. Once the pointer is over
       * text again the browser's own selection takes over, through the same prop.
       */
      const intoBlock = (event: MouseEvent): void => {
        const block = codeEditorBlockOf(view, document.elementFromPoint(event.clientX, event.clientY))
        if (block === null) return
        const { anchor } = view.state.selection
        const end = block.pos + block.node.nodeSize
        if (anchor > block.pos && anchor < end) return
        const head = pastBlock(view.state.doc, block, anchor <= block.pos ? 1 : -1)
        const selection = TextSelection.create(view.state.doc, anchor, head)
        if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection))
      }

      const onMove = (event: MouseEvent): void => {
        if (!event.isTrusted) return
        if ((event.buttons & 1) === 0) {
          pointer = null
          fromCode = null
          fromText = false
          escaped = null
          return
        }
        pointer = { x: event.clientX, y: event.clientY }
        if (fromCode === null) {
          if (fromText) intoBlock(event)
          return
        }

        if (escaped === null) {
          const box = fromCode.dom.getBoundingClientRect()
          const dir = event.clientY > box.bottom ? 1 : event.clientY < box.top ? -1 : 0
          if (dir === 0) return
          // CodeMirror ends its own drag on a move with no button held, without moving
          // its selection; this one never reaches the listener above (`isTrusted`).
          document.dispatchEvent(new MouseEvent('mousemove', {
            buttons: 0, clientX: event.clientX, clientY: event.clientY,
          }))
          escaped = { anchor: pastBlock(view.state.doc, fromCode, dir > 0 ? -1 : 1) }
          view.focus()
        }

        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (hit === null) return
        let head = hit.pos
        // Over another highlighted block, the head goes past it as a drag from text does.
        const over = codeEditorBlockOf(view, document.elementFromPoint(event.clientX, event.clientY))
        if (over !== null) head = pastBlock(view.state.doc, over, escaped.anchor <= over.pos ? 1 : -1)
        else if (head >= fromCode.pos && head <= fromCode.pos + fromCode.node.nodeSize) return
        const doc = view.state.doc
        const selection = TextSelection.between(doc.resolve(escaped.anchor), doc.resolve(head))
        if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection))
        event.preventDefault()
      }

      const onUp = (): void => {
        pointer = null
        fromCode = null
        fromText = false
        escaped = null
      }

      // Capture, so a press CodeMirror handles is seen before anything can stop it.
      document.addEventListener('mousedown', onDown, true)
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp, true)
      return {
        destroy() {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp, true)
        },
      }
    },
  })
}
