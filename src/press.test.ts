import { afterEach, describe, expect, it } from 'vitest'
import { EditorState, NodeSelection } from 'prosemirror-state'
import { GapCursor } from 'prosemirror-gapcursor'
import { EditorView } from 'prosemirror-view'
import { schema } from './schema'
import { markdownToProse } from './markdown'
import { blockModePlugin, setBlockModeAt } from './block-modes'
import { pressPlugin, gapTargetAt, pressTarget } from './press'

/** Three tables: no textblock anywhere in the document. */
const TABLE_ONLY = [
  '| A | B |\n| --- | --- |\n| 1 | 2 |',
  '| C | D |\n| --- | --- |\n| 3 | 4 |',
  '| E | F |\n| --- | --- |\n| 5 | 6 |',
].join('\n\n')

const views: EditorView[] = []
const hosts: HTMLElement[] = []


/**
 * An editor in its own scroller, with the page's chrome beside it — which is the app's shape:
 * `#editor-container` is the scroller, and the toolbar and the search bar are its siblings.
 * The listener lives on the scroller, so "a press on the chrome" is a press that cannot reach
 * it at all, and that is what the test for it relies on.
 */
function createEditor(md: string): EditorView {
  const host = document.createElement('div')
  const chrome = document.createElement('button')
  document.body.append(host, chrome)
  hosts.push(host, chrome)
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: markdownToProse(md, schema),
      plugins: [blockModePlugin, pressPlugin()],
    }),
  })
  views.push(view)
  layout(view)
  return view
}

/**
 * Lay the blocks out in a column, because jsdom has no layout and every box would otherwise be
 * at the origin — where "nearest block" and "which side" are both unanswerable. 10px of white
 * space between them, which is what a reader aims at.
 */
function layout(view: EditorView): void {
  let index = 0
  view.state.doc.forEach((_node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement
    const top = index * 60
    index += 1
    dom.getBoundingClientRect = () =>
      ({ left: 0, right: 100, top, bottom: top + 50, width: 100, height: 50, x: 0, y: top,
        toJSON: () => ({}) }) as DOMRect
  })
}

/** The offset of each top-level block, in document order. */
function blockOffsets(view: EditorView): number[] {
  const out: number[] = []
  view.state.doc.forEach((_node, offset) => out.push(offset))
  return out
}

/** A press at the given point, dispatched on `target`. */
function press(target: EventTarget, x: number, y: number, init: MouseEventInit = {}): void {
  ;(target as HTMLElement).dispatchEvent(new MouseEvent('mousedown',
    { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...init }))
}

afterEach(() => {
  while (views.length) views.pop()!.destroy()
  while (hosts.length) hosts.pop()!.remove()
  document.body.innerHTML = ''
})

/**
 * A block that declares a **margin**: an empty strip around its content, which is what a Visual
 * table has (its scroller is as wide as the block and its grid is not) and what a diagram has
 * not.
 *
 * The markers go on real nodes rather than a stand-in, because what is under test is the
 * *question* — content first, then margin — and `TablePlainView` writes exactly these two class
 * names onto exactly these two elements (`tests/test_window.py` pins that wiring end to end).
 *
 * **On a list item, and that is not incidental**: the element has to be able to *contain* another
 * element and still be findable by `posAtDOM`, and a `<table>` or a `<p>` cannot — a child
 * element appended inside one is not where ProseMirror thinks its content is, so the press reads
 * as the *next* block. Which block type owns a margin is the real view's business, not this
 * question's.
 */
function markMargin(view: EditorView, index: number): { margin: HTMLElement; content: HTMLElement } {
  const block = view.nodeDOM(blockOffsets(view)[index]) as HTMLElement
  const margin = document.createElement('div')
  margin.className = 'block-margin'
  const content = document.createElement('div')
  content.className = 'block-content'
  margin.appendChild(content)
  block.appendChild(margin)
  layout(view)
  return { margin, content }
}

/**
 * Three block quotes: top-level blocks whose DOM can hold an element of their own and still be
 * found by `posAtDOM`. A list would have been one block holding three, which is the wrong shape
 * here — the margin belongs to a *block*, so the fixture needs three of them.
 */
const BLOCKS_DOC = ['> one', '> two', '> three'].join('\n\n')

describe('a press, in a document with nowhere to type', () => {
  it('never creates a block — a press never edits the file', () => {
    // **"Clicking around a document shouldn't create blocks."** This module used to make a
    // paragraph here, marked the file dirty and left one `Ctrl+Z` between a stray click and an
    // undo. The argument for it was that Word and Docs do the same; the argument against it is
    // that here a click *edits the reader's file*, which is not a thing to be told about a
    // paragraph at a time.
    const view = createEditor(TABLE_ONLY)
    const before = view.state.doc.childCount

    press(view.dom, -10, 85)
    press(view.dom, 110, 145)
    press(view.dom.parentElement!, 50, 205)

    expect(view.state.doc.childCount).toBe(before)
    // The selection a document of tables can hold at all: a collapsed position between two
    // atoms. What must not happen is a *textblock* appearing, which is the document claim.
    expect(view.state.selection.$from.parent.isTextblock).toBe(false)
  })

  it('answers a press beside a block with a gap cursor, so a selected table can be let go', () => {
    // A document of nothing but atoms has no text to put a caret in, and the press used to do
    // nothing — which left a selected table selected, with no press anywhere that could clear
    // it. The caret such a document does have is a gap cursor on the side that was pressed.
    const view = createEditor(TABLE_ONLY)
    const [, second] = blockOffsets(view)
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, second)))
    const { margin } = markMargin(view, 1)

    press(margin, -10, 85)

    expect(view.state.selection).toBeInstanceOf(GapCursor)
    expect(view.state.selection.from).toBe(second)
  })

  it('still answers a press in a block\'s margin when there is text to aim at', () => {
    // **The one answer this module gives**, and it is the white-space answer: a margin is the
    // space beside a block, and it sits inside the block's DOM where ProseMirror's own mapping
    // cannot go, so the caret goes to the nearest text — on the side that was pressed.
    const view = createEditor('Prose above.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nProse below.\n')
    const table = blockOffsets(view)[1]
    const { margin } = markMargin(view, 1)

    press(margin, -10, 85)

    expect(view.state.doc.childCount).toBe(3)
    expect(view.state.selection.empty).toBe(true)
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(view.state.selection.from).toBeLessThan(table)
  })

  it('does not answer a press in a margin when there is no textblock anywhere', () => {
    // The two halves of the same rule: the answer needs somewhere to put the caret, and a
    // `code_block` is not somewhere — its text is CodeMirror in both of its forms, and a
    // `table` is an atom with no content at all.
    const view = createEditor(['```py', 'print(1)', '```', '', TABLE_ONLY].join('\n'))
    const { margin } = markMargin(view, 2)

    press(margin, -10, 145)

    expect(view.state.doc.childCount).toBe(4)
  })
})

describe('what a press is', () => {
  /** A press whose `target` is `target` — an undispatched event has none. */
  const pressOn = (target: Element, init: MouseEventInit = {}): MouseEvent => {
    const event = new MouseEvent('mousedown',
      { bubbles: true, cancelable: true, button: 0, clientX: -10, clientY: 85, ...init })
    Object.defineProperty(event, 'target', { value: target })
    return event
  }

  it('classifies each region of a block, and each block names a different thing', () => {
    // **The classification, which is the thing this module exists for.** A press in the margin
    // *names* a block by DOM containment and is still white space, and a press in the content is
    // the block's own business — two regions of one block, which is the distinction "a press on a
    // block selects it" could not make and which cost a table its empty space.
    const view = createEditor(BLOCKS_DOC)
    const { margin, content } = markMargin(view, 1)
    const item = blockOffsets(view)[1]

    // The margin: names the block, is not its content, and carries the side pressed.
    expect(pressTarget(view, pressOn(margin))).toEqual({
      kind: 'margin', pos: item, before: true,
    })
    // The content inside that margin: the same block, and its own business.
    expect(pressTarget(view, pressOn(content))).toEqual({
      kind: 'content', pos: item,
    })
    // The editor's own white space: names no block, and carries the nearest one and its side.
    expect(pressTarget(view, pressOn(view.dom))).toEqual({
      kind: 'space', pos: item, before: true,
    })
    // **The vocabulary does not care who asks**: a press with a modifier is the same press.
    expect(pressTarget(view, pressOn(margin, { shiftKey: true })).kind).toBe('margin')
  })
  it('names the nearest block and the side the press was on', () => {
    // **The geometry every answer is read off**, and it is one rule for the whole module: beside
    // a block the side follows x, above or below it the side follows y. Four presses, four answers.
    const view = createEditor(BLOCKS_DOC)
    const [first, middle, last] = blockOffsets(view)
    expect(gapTargetAt(view, -10, 85)).toEqual({ pos: middle, before: true })
    expect(gapTargetAt(view, 110, 85)).toEqual({ pos: middle, before: false })
    expect(gapTargetAt(view, 50, -30)).toEqual({ pos: first, before: true })
    expect(gapTargetAt(view, 50, 200)).toEqual({ pos: last, before: false })
  })

  it('leaves a press in the editor\'s own white space to ProseMirror', () => {
    // **The refusal that keeps precision.** With prose in the document, a press in white space is
    // ProseMirror's own: it maps the press's coordinates onto the text, so a click inside a long
    // paragraph lands between the words the reader aimed at. A nearest-block fold can only offer
    // the block's edge — so this module stands down. jsdom cannot run that mapping (there is no
    // hit test here, and `test-setup` stubs it to `null`, which is ProseMirror's own bail-out),
    // so what this pins is the *refusal*: the document is untouched and so is the caret.
    const view = createEditor('Prose.\n\n' + BLOCKS_DOC.replace(/\n\n/g, '\n\n'))
    const at = view.state.selection.from
    press(view.dom, -10, 85)
    expect(view.state.selection.from).toBe(at)
    expect(view.state.doc.childCount).toBe(4)
  })

  it('is not answered for a press that names a block, one outside the editor, or a modifier', () => {
    const view = createEditor(BLOCKS_DOC)
    const count = view.state.doc.childCount
    // A press on the block itself: ProseMirror's answer (a caret in it) is the right one.
    press(view.nodeDOM(blockOffsets(view)[1]) as HTMLElement, 50, 85)
    // A press outside the editor entirely — the toolbar, a dialog: the listener's own scope.
    press(document.body, 0, 0)
    // And every modifier: `Shift`/`Ctrl` extend a selection and `Alt`+click is the mode gesture.
    for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
      press(view.dom, -10, 85, { [modifier]: true })
    }
    press(view.dom, -10, 85, { button: 2 })
    expect(view.state.doc.childCount).toBe(count)
  })

  it('is answered the same way while a working state is live elsewhere in the document', () => {
    // **What a working state does *not* reach.** A sheet is open in the table; the prose around it
    // is ordinary prose, and a press in the table's own margin is answered exactly as it is with
    // no sheet open. The overlay that used to dim the document and refuse presses in it was
    // withdrawn, and this is the claim that replaced it — *nothing* about a working state takes
    // the rest of the document's presses away.
    const view = createEditor('Prose above.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nProse below.\n')
    const { margin } = markMargin(view, 1)
    const table = blockOffsets(view)[1]
    const tr = view.state.tr
    setBlockModeAt(view.state, tr, table, { form: 'sheet' })
    view.dispatch(tr)

    press(margin, -10, 85)

    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(view.state.selection.from).toBeLessThan(table)
  })
})
