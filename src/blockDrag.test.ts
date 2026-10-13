import { describe, expect, it, afterEach } from 'vitest'
import { AllSelection, EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from './schema'
import { markdownToProse } from './markdown'
import { blockDragPlugin, dragsABlock } from './blockDrag'

const DOC = `# A heading

One paragraph of ordinary prose.

- first item
- second item

A second paragraph, so a range can cross a block boundary.

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`mermaid
graph TD
  A[Alpha]
\`\`\`
`

const views: EditorView[] = []

// ProseMirror's own `dragstart` handler needs a document position under the pointer, and
// jsdom has no layout to find one with: it asks `elementFromPoint`, then measures the
// editor's own box, and both come back empty. A null answer is its clean bail-out, so an
// *allowed* drag can be dispatched here without the test failing over something the app
// does not control. What is under test is the decision, and the decision is made first.
if (typeof document.elementFromPoint !== 'function') {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
  })
}

function createEditor(md: string = DOC): EditorView {
  const view = new EditorView(document.body, {
    state: EditorState.create({ doc: markdownToProse(md, schema), plugins: [blockDragPlugin] }),
  })
  views.push(view)
  return view
}

afterEach(() => {
  while (views.length) views.pop()!.destroy()
  document.body.innerHTML = ''
})

/** The offset of the *n*th top-level block. */
function blockAt(view: EditorView, index: number): number {
  const positions: number[] = []
  view.state.doc.forEach((_node, offset) => { positions.push(offset) })
  return positions[index]!
}

/** The offset of the first top-level block of this type, or -1. */
function firstBlockOf(view: EditorView, type: string): number {
  const offsets: number[] = []
  view.state.doc.forEach((node, offset) => {
    if (node.type.name === type) offsets.push(offset)
  })
  return offsets[0] ?? -1
}

/** The position of the first node of this type, at any depth, or -1. */
function firstNodeOf(view: EditorView, type: string): number {
  let found = -1
  view.state.doc.descendants((node, pos) => {
    if (found !== -1) return false
    if (node.type.name === type) found = pos
    return true
  })
  return found
}

/** Select a whole block's text, from inside its first character to inside its last. */
function selectWholeTextOf(view: EditorView, index: number): void {
  const start = blockAt(view, index)
  const $from = view.state.doc.resolve(start)
  selectIn(view, $from.start() + 1, $from.end() - 1)
}

function selectIn(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
}

/** A `DataTransfer`-shaped stub, because jsdom has none and ProseMirror writes into it. */
interface FakeTransfer {
  dropEffect: string
  effectAllowed: string
  types: string[]
  files: unknown[]
  items: unknown[]
  setData(format: string, value: string): void
  getData(format: string): string
  clearData(): void
  setDragImage(): void
}

function fakeDataTransfer(): FakeTransfer {
  const data: Record<string, string> = {}
  return {
    dropEffect: 'move',
    effectAllowed: 'all',
    types: [],
    files: [],
    items: [],
    setData: (format: string, value: string) => { data[format] = value },
    getData: (format: string) => data[format] ?? '',
    clearData: () => { for (const key of Object.keys(data)) delete data[key] },
    setDragImage: () => { /* jsdom has no image to drag */ },
  }
}

/** Drag the current selection, as a reader would, and report what happened. */
function dragFrom(view: EditorView): { refused: boolean; dragging: unknown } {
  const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: fakeDataTransfer() })
  view.dom.dispatchEvent(event)
  return {
    refused: event.defaultPrevented,
    dragging: (view as unknown as { dragging: unknown }).dragging,
  }
}

describe('dragging a whole block does nothing', () => {
  it('refuses a whole paragraph, and no drag begins', () => {
    const view = createEditor()
    selectWholeTextOf(view, 1)

    expect(dragsABlock(view)).toBe(true)
    const drag = dragFrom(view)
    expect(drag.refused).toBe(true)
    // **No drag at all**, which is the point: a drag that never began has no drop, and
    // ProseMirror never wrote a payload nor kept a phantom slice for one.
    expect(drag.dragging).toBeFalsy()
  })

  it('refuses a whole heading, which is a paragraph and so deserves no special case', () => {
    const view = createEditor()
    const $start = view.state.doc.resolve(blockAt(view, 0))
    selectIn(view, $start.start() + 1, $start.end() - 1)

    expect(dragsABlock(view)).toBe(true)
    expect(dragFrom(view).refused).toBe(true)
  })

  it('refuses a range that crosses a block boundary', () => {
    const view = createEditor()
    selectIn(view, blockAt(view, 1) + 5, blockAt(view, 3) + 5)

    expect(dragsABlock(view)).toBe(true)
    expect(dragFrom(view).refused).toBe(true)
  })

  it('refuses a block selected as an object — a table, a diagram', () => {
    const view = createEditor()
    const table = firstBlockOf(view, 'table')
    const diagram = firstBlockOf(view, 'mermaid_block')
    expect(table).toBeGreaterThan(0)
    expect(diagram).toBeGreaterThan(table)

    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, table)))
    expect(dragsABlock(view)).toBe(true)
    expect(dragFrom(view).refused).toBe(true)

    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, diagram)))
    expect(dragsABlock(view)).toBe(true)
    expect(dragFrom(view).refused).toBe(true)
  })

  it('refuses the whole document', () => {
    const view = createEditor()
    // `AllSelection` is what Ctrl+A produces: a block selection with no text-only reading.
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)))

    expect(dragsABlock(view)).toBe(true)
    expect(dragFrom(view).refused).toBe(true)
  })

  it('refuses an empty selection, which has nothing to drag', () => {
    const view = createEditor()
    selectIn(view, blockAt(view, 1) + 5, blockAt(view, 1) + 5)

    expect(dragsABlock(view)).toBe(true)
    expect(dragFrom(view).refused).toBe(true)
  })

  it('keeps dragging text inside a block', () => {
    const view = createEditor()
    selectIn(view, blockAt(view, 1) + 5, blockAt(view, 1) + 8)

    expect(dragsABlock(view)).toBe(false)
    // Not refused: the default stands and the browser's own text drag happens.
    expect(dragFrom(view).refused).toBe(false)
  })

  it('keeps the word that starts a block, where the slice is still the block', () => {
    // **The case a slice-reading rule gets wrong.** A selection from a block's first
    // character to its third carries a slice whose content is the *paragraph* (ProseMirror
    // flattens only a selection with an open end on both sides), so "is there a block in
    // this slice" answers yes — for the first word of every paragraph, and no other.
    const view = createEditor()
    selectIn(view, blockAt(view, 1) + 1, blockAt(view, 1) + 4)

    expect(dragsABlock(view)).toBe(false)
    expect(dragFrom(view).refused).toBe(false)
  })

  it('keeps dragging text inside a list item, and inside a marked run', () => {
    const view = createEditor()
    const item = firstNodeOf(view, 'list_item')
    expect(item).toBeGreaterThan(0)
    // A list item wraps its text in a paragraph, so the text starts two positions in:
    // one past the item, one past the paragraph's own boundary.
    expect(view.state.doc.nodeAt(item)!.firstChild!.isTextblock).toBe(true)
    selectIn(view, item + 2, item + 6)
    expect(dragsABlock(view)).toBe(false)
    expect(dragFrom(view).refused).toBe(false)

    const marked = createEditor('Some **bold** words and *others* here.')
    const start = 1 + 'Some '.length
    selectIn(marked, start, start + 4)
    expect(dragsABlock(marked)).toBe(false)
    expect(dragFrom(marked).refused).toBe(false)
  })

  it('is consulted before ProseMirror writes anything into the transfer', () => {
    const view = createEditor()
    selectWholeTextOf(view, 1)
    const transfer = fakeDataTransfer()
    const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    view.dom.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(transfer.getData('text/html')).toBe('')
    expect(transfer.getData('text/plain')).toBe('')
  })
})